#!/usr/bin/env bash
# Build the production API image, prove its workspace runtime imports, migrate a disposable
# PostgreSQL instance, then start the image through its default entrypoint and exercise the real
# HTTP health + authenticated MCP catalog/resource surface. Every Docker object is unique to this
# invocation and removed by the EXIT trap.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SMOKE_ID="${PPID}-$$"
IMAGE="combo-api-project-history-smoke:${SMOKE_ID}"
NETWORK="combo-api-project-history-smoke-${SMOKE_ID}"
POSTGRES="combo-api-project-history-pg-${SMOKE_ID}"
REDIS_QUEUE="combo-api-project-history-queue-${SMOKE_ID}"
REDIS_HOT="combo-api-project-history-hot-${SMOKE_ID}"
API="combo-api-project-history-api-${SMOKE_ID}"
POSTGRES_ADMIN_PASSWORD='smoke-admin-password'
POSTGRES_API_PASSWORD='smoke-api-password'
POSTGRES_WORKER_PASSWORD='smoke-worker-password'
POSTGRES_RUNTIME_PASSWORD='smoke-runtime-password'
SMOKE_TOKEN="mat1.$(printf 'a%.0s' {1..43})"
SOURCE_SHA='1111111111111111111111111111111111111111'
RELEASE_DIGEST="sha256:$(printf '1%.0s' {1..64})"
WEB_DIGEST="sha256:$(printf '2%.0s' {1..64})"
PUBLIC_ORIGIN='https://image-smoke.combo.invalid'

log() { printf '[it:api-image] %s\n' "$*"; }
fail() {
  printf '[it:api-image:fail] %s\n' "$*" >&2
  exit 1
}
cleanup() {
  docker rm -f "$API" "$REDIS_HOT" "$REDIS_QUEUE" "$POSTGRES" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker image rm -f "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail 'docker is required'

log 'building production API image'
docker build --pull=false -f "$ROOT_DIR/infra/Dockerfile.api" -t "$IMAGE" "$ROOT_DIR"

log 'checking runtime workspace imports from the production layer'
docker run --rm --entrypoint node "$IMAGE" --input-type=module -e '
  import { createRequire } from "node:module";
  const { PROJECT_HISTORY_AGENT_ENDPOINTS } = await import(
    "./apps/authoring/dist/modules/project-history-agent/routes.js"
  );
  const actual = PROJECT_HISTORY_AGENT_ENDPOINTS.map(({ method, url }) => `${method} ${url}`);
  const expected = [
    "POST /agent-package-drafts",
    "POST /agent-package-drafts/:draftId/render",
    "POST /agent-package-shares",
    "GET /agent-package-shares/:shareToken",
    "POST /agent-package-runs/prepare",
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected Project-history routes: ${JSON.stringify(actual)}`);
  }
  const requireFromAuthoring = createRequire(
    new URL("./apps/authoring/package.json", import.meta.url)
  );
  const protocolEntry = requireFromAuthoring.resolve(
    "@cb/creator-agent-protocol/agent-package-share"
  );
  await import(new URL(`file://${protocolEntry}`).href);
  process.stdout.write(`api runtime route import ok (${actual.length})\n`);
'

docker network create "$NETWORK" >/dev/null
docker run -d --name "$POSTGRES" --network "$NETWORK" \
  -e POSTGRES_PASSWORD="$POSTGRES_ADMIN_PASSWORD" \
  postgres:16 >/dev/null
docker run -d --name "$REDIS_QUEUE" --network "$NETWORK" redis:7-alpine >/dev/null
docker run -d --name "$REDIS_HOT" --network "$NETWORK" redis:7-alpine >/dev/null

log 'waiting for disposable PostgreSQL and Redis dependencies'
for _attempt in {1..120}; do
  if docker exec -e PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" "$POSTGRES" \
    pg_isready -U postgres -d postgres >/dev/null 2>&1 && \
    docker exec "$REDIS_QUEUE" redis-cli ping 2>/dev/null | grep -qx PONG && \
    docker exec "$REDIS_HOT" redis-cli ping 2>/dev/null | grep -qx PONG; then
    dependencies_ready=1
    break
  fi
  sleep 0.25
done
[ "${dependencies_ready:-0}" = 1 ] || fail 'disposable PostgreSQL/Redis did not become ready'

log 'running migration job from the same production image'
docker run --rm --network "$NETWORK" --entrypoint node \
  -e PGHOST="$POSTGRES" \
  -e PGPORT=5432 \
  -e PGUSER=postgres \
  -e PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" \
  -e PGDATABASE=postgres \
  -e POSTGRES_API_PASSWORD="$POSTGRES_API_PASSWORD" \
  -e POSTGRES_WORKER_PASSWORD="$POSTGRES_WORKER_PASSWORD" \
  -e POSTGRES_RUNTIME_PASSWORD="$POSTGRES_RUNTIME_PASSWORD" \
  -e MIGRATION_RUNS=2 \
  "$IMAGE" --experimental-strip-types db/scripts/migrate.ts \
  --expected-head 0019_pending_usage_recovery.sql

log 'rerunning the same production image migration job against the already-0019 ledger'
docker run --rm --network "$NETWORK" --entrypoint node \
  -e PGHOST="$POSTGRES" \
  -e PGPORT=5432 \
  -e PGUSER=postgres \
  -e PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" \
  -e PGDATABASE=postgres \
  -e POSTGRES_API_PASSWORD="$POSTGRES_API_PASSWORD" \
  -e POSTGRES_WORKER_PASSWORD="$POSTGRES_WORKER_PASSWORD" \
  -e POSTGRES_RUNTIME_PASSWORD="$POSTGRES_RUNTIME_PASSWORD" \
  -e MIGRATION_RUNS=2 \
  "$IMAGE" --experimental-strip-types db/scripts/migrate.ts \
  --expected-head 0019_pending_usage_recovery.sql

log 'installing a disposable legacy-compatible OAuth bearer fixture'
docker exec -i -e PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" "$POSTGRES" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO users (id, account, roles)
VALUES ('00000000-0000-4000-8000-000000000091', 'creator-aaaaaaaz', ARRAY['creator']);
INSERT INTO oauth_clients
  (client_id, registration_digest, client_name, redirect_uris, grant_types,
   response_types, token_endpoint_auth_method)
VALUES (
  'mcp_client_' || repeat('c', 43),
  decode(repeat('0', 64), 'hex'),
  'Production image smoke fixture',
  ARRAY['http://127.0.0.1:49152/callback/codex-id'],
  ARRAY['authorization_code', 'refresh_token'],
  ARRAY['code'],
  'none'
);
INSERT INTO oauth_access_tokens
  (token_digest, client_id, owner_user_id, family_id, scope, resource_uri, expires_at)
VALUES (
  decode('b4c1583a171458f882d697b32086d32ae8750004964417cc3b80ea6d5e5eed8c', 'hex'),
  'mcp_client_' || repeat('c', 43),
  '00000000-0000-4000-8000-000000000091',
  '00000000-0000-4000-8000-000000000092',
  'combo.agent:read combo.agent:write',
  'https://image-smoke.combo.invalid/api/external-mcp/mcp',
  clock_timestamp() + interval '1 day'
);
SQL

log 'starting the production image through its default entrypoint'
docker run -d --name "$API" --network "$NETWORK" \
  -e NODE_ENV=production \
  -e PROCESS=api \
  -e PORT=3000 \
  -e HOST=0.0.0.0 \
  -e COMBO_ENVIRONMENT=test \
  -e COMBO_SOURCE_SHA="$SOURCE_SHA" \
  -e COMBO_RELEASE_ID="release-$SOURCE_SHA" \
  -e COMBO_BUILT_AT=2026-08-29T00:00:00.000Z \
  -e COMBO_RELEASE_MANIFEST_DIGEST="$RELEASE_DIGEST" \
  -e COMBO_WEB_ASSET_MANIFEST="$WEB_DIGEST" \
  -e DATABASE_URL="postgres://combo_api:$POSTGRES_API_PASSWORD@$POSTGRES:5432/postgres" \
  -e REDIS_QUEUE_URL="redis://$REDIS_QUEUE:6379/0" \
  -e REDIS_HOT_URL="redis://$REDIS_HOT:6379/0" \
  -e S3_ENDPOINT=http://object-store.invalid:9000 \
  -e S3_ACCESS_KEY=smoke-access-key \
  -e S3_SECRET_KEY=smoke-secret-key \
  -e S3_REGION=us-east-1 \
  -e PUBLIC_APP_ORIGINS="$PUBLIC_ORIGIN" \
  -e EXTERNAL_MCP_PUBLIC_ORIGIN="$PUBLIC_ORIGIN" \
  -e MCP_RUNTIME_INTERNAL_BASE_URL=http://runtime.invalid:3100 \
  -e SESSION_COOKIE_SECURE=true \
  -e RESEND_API_KEY=smoke-resend-key \
  -e 'RESEND_FROM_EMAIL=Combo <auth@buildwithcombo.com>' \
  -e RESEND_API_BASE_URL=https://api.resend.com \
  -e OTP_HMAC_SECRET=smoke-otp-secret-with-at-least-32-bytes \
  -e OTEL_SDK_DISABLED=true \
  -e SMOKE_TOKEN="$SMOKE_TOKEN" \
  "$IMAGE" >/dev/null

for _attempt in {1..120}; do
  if ! docker inspect -f '{{.State.Running}}' "$API" 2>/dev/null | grep -qx true; then
    docker logs "$API" >&2 || true
    fail 'production API container exited during startup'
  fi
  if docker exec "$API" node -e \
    "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)})" \
    >/dev/null 2>&1; then
    api_ready=1
    break
  fi
  sleep 0.25
done
[ "${api_ready:-0}" = 1 ] || {
  docker logs "$API" >&2 || true
  fail 'production API did not serve /health'
}

log 'verifying real HTTP health/version/OAuth, exact 28 tools, exact 2 resources, and the 174-byte guide'
docker exec "$API" node --input-type=module -e '
  const base = "http://127.0.0.1:3000";
  const endpoint = "http://127.0.0.1:3000/api/external-mcp/mcp";
  const headers = {
    authorization: `Bearer ${process.env.SMOKE_TOKEN}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-03-26",
  };
  const call = async (id, method, params = {}) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      throw new Error(`${method} failed: HTTP ${response.status}`);
    }
    return body.result;
  };
  const health = await fetch(`${base}/health`);
  if (!health.ok || (await health.json()).status !== "ok") throw new Error("health failed");
  const versionResponse = await fetch(`${base}/api/v1/version`);
  const version = await versionResponse.json();
  if (
    !versionResponse.ok ||
    version.environment !== "test" ||
    version.sourceSha !== "1111111111111111111111111111111111111111" ||
    version.releaseId !== "release-1111111111111111111111111111111111111111"
  ) {
    throw new Error("API release version identity failed");
  }
  const protectedPaths = [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/external-mcp/mcp",
  ];
  for (const path of protectedPaths) {
    const response = await fetch(`${base}${path}`);
    const metadata = await response.json();
    if (
      !response.ok ||
      metadata.resource !== "https://image-smoke.combo.invalid/api/external-mcp/mcp"
    ) {
      throw new Error(`OAuth protected-resource metadata failed: ${path}`);
    }
  }
  const authorizationServerResponse = await fetch(
    `${base}/.well-known/oauth-authorization-server`,
  );
  const authorizationServer = await authorizationServerResponse.json();
  if (
    !authorizationServerResponse.ok ||
    authorizationServer.issuer !== "https://image-smoke.combo.invalid"
  ) {
    throw new Error("OAuth authorization-server metadata failed");
  }
  const unauthorized = await fetch(endpoint, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
  });
  if (
    unauthorized.status !== 401 ||
    !unauthorized.headers.get("www-authenticate")?.includes("oauth-protected-resource")
  ) {
    throw new Error("unauthenticated MCP OAuth challenge failed");
  }
  const initialized = await call(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "combo-production-image-smoke", version: "1.0.0" },
  });
  if (initialized.serverInfo?.name !== "combo" || initialized.serverInfo?.version !== "0.8.4") {
    throw new Error("unexpected initialize serverInfo");
  }
  const listed = await call(2, "tools/list");
  const names = listed.tools.map(({ name }) => name);
  const expectedTail = [
    "create_agent_package_draft",
    "render_agent_package_draft",
    "create_agent_package_share",
    "read_agent_package_share",
    "prepare_agent_package_run",
  ];
  if (names.length !== 28 || JSON.stringify(names.slice(-5)) !== JSON.stringify(expectedTail)) {
    throw new Error(`unexpected tool catalog: ${names.length}`);
  }
  const resources = await call(3, "resources/list");
  const uris = resources.resources.map(({ uri }) => uri);
  const expectedUris = [
    "ui://combo/agent-builder/v1.html",
    "ui://combo/project-history-agent-draft/v1.html",
  ];
  if (JSON.stringify(uris) !== JSON.stringify(expectedUris)) {
    throw new Error(`unexpected resource catalog: ${JSON.stringify(uris)}`);
  }
  const draftResource = await call(4, "resources/read", { uri: expectedUris[1] });
  const content = draftResource.contents?.[0];
  if (
    content?.uri !== expectedUris[1] ||
    content?.mimeType !== "text/html;profile=mcp-app" ||
    !content?.text?.includes("AGENT PACKAGE DRAFT")
  ) {
    throw new Error("typed Draft resource is missing from the production runtime");
  }
  const pageResponse = await fetch(`${base}/codex-plugin`);
  const page = await pageResponse.text();
  const installPrompt =
    "阅读 https://test.43-160-242-46.sslip.io/codex-plugin ，帮我安装或升级 Combo 插件；完成后只创建一个安装续接任务，不要直接开始制作 Agent。";
  if (
    !pageResponse.ok ||
    Buffer.byteLength(installPrompt, "utf8") !== 174 ||
    page.split(installPrompt).length - 1 !== 1 ||
    !page.includes("TEST_RUNTIME") ||
    !page.includes(`sourceSha=${version.sourceSha}`) ||
    !page.includes(`releaseId=${version.releaseId}`) ||
    !page.includes("schemaVersion=combo.project-history-bootstrap-controller/1") ||
    !page.includes("/usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u NODE_V8_COVERAGE -u NODE_COMPILE_CACHE -u NODE_REDIRECT_WARNINGS") ||
    !page.includes("5,000 ms") ||
    !page.includes("SIGKILL") ||
    !page.includes("empty environment") ||
    !page.includes("2,000 UTF-8 bytes") ||
    !page.includes("33d94d776e9d4eb0cf2238358857c8e4b33427de655be6a52d33e834d460146d") ||
    !page.includes("14,507 UTF-8 bytes") ||
    !page.includes("0f57fd11fc2a45f4cd23f5718fa676e0b607b5c1a3dd10f3073acd444e2b7ca0") ||
    !page.includes("1,074 UTF-8 bytes") ||
    !page.includes("7df7bced005edd481e8eaa3169a8cac3dfa278d459942a15ef31bf595fd101fc") ||
    !page.includes("PROJECT_HISTORY_BOOTSTRAP_CONTROLLER_EXEC_FAILED") ||
    page.includes("1,935 UTF-8 bytes") ||
    page.includes("54c08151e07d7c43465a918e7cd4c4cc15d3e156d3e73ccc877b6cd379be9a0e") ||
    page.includes("NOT_DEPLOYED") ||
    page.includes("NOT_UAT") ||
    page.includes("CODE_CONTRACT")
  ) {
    throw new Error("Project-history 174-byte live-truth guide failed");
  }
  process.stdout.write(
    `production API runtime ok (${names.length} tools, ${uris.length} resources, 174-byte page)\n`,
  );
'

log 'production image runtime smoke passed'
