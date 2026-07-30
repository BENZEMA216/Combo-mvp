import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (letter) => `${letter}`.repeat(64);
const POSTGRES_IMAGE =
  'postgres@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7';
const REDIS_IMAGE = 'redis@sha256:bb186d083732f669da90be8b0f975a37812b15e913465bb14d845db72a4e3e08';
const MINIO_IMAGE =
  'minio/minio@sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0';
const MINIO_MC_IMAGE =
  'minio/mc@sha256:fb8f773eac8ef9d6da0486d5dec2f42f219358bcb8de579d1623d518c9ebd4cc';
const containerContractsEnabled = process.env.COMBO_RUN_CONTAINER_CONTRACTS === '1';
const dockerAvailable =
  containerContractsEnabled && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const imageArgs = [
  '--api-image',
  `ghcr.io/dangdang-tech/combo-api@sha256:${digest('a')}`,
  '--runtime-image',
  `ghcr.io/dangdang-tech/combo-runtime@sha256:${digest('b')}`,
  '--web-image',
  `ghcr.io/dangdang-tech/combo-web@sha256:${digest('c')}`,
];
const RELEASE_SHA = 'd'.repeat(40);
const RELEASE_MANIFEST = {
  schemaVersion: 1,
  sourceSha: RELEASE_SHA,
  releaseId: `release-${RELEASE_SHA}`,
  images: {
    api: imageArgs[1],
    runtime: imageArgs[3],
    web: imageArgs[5],
  },
  migrationHead: '0008_application_database_roles.sql',
  builtAt: '2026-07-24T08:00:00.000Z',
  webAssetManifest: `sha256:${digest('e')}`,
};

function text(path) {
  return readFileSync(join(repo, path), 'utf8');
}

function writeReleaseFixture(root, releaseManifest = RELEASE_MANIFEST) {
  const manifest = join(root, 'release.json');
  const digestFile = join(root, 'release-manifest-digest.txt');
  const serialized = `${JSON.stringify(releaseManifest, null, 2)}\n`;
  writeFileSync(manifest, serialized);
  writeFileSync(digestFile, `sha256:${sha(serialized)}\n`);
  return [
    '--revision',
    RELEASE_SHA,
    '--release-manifest',
    manifest,
    '--release-manifest-digest-file',
    digestFile,
  ];
}

function render(root = repo) {
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-render-'));
  const output = join(work, 'rendered.yaml');
  const releaseArgs = writeReleaseFixture(work);
  try {
    execFileSync(
      'bash',
      [
        join(root, 'scripts/combo-dev-deploy.sh'),
        '--render-only',
        '--output',
        output,
        ...imageArgs,
        ...releaseArgs,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'combo-dev-fixture-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'infra/k8s/overlays'), { recursive: true });
  cpSync(join(repo, 'scripts/combo-dev-deploy.sh'), join(root, 'scripts/combo-dev-deploy.sh'));
  cpSync(join(repo, 'infra/k8s/overlays/combo-dev'), join(root, 'infra/k8s/overlays/combo-dev'), {
    recursive: true,
  });
  return root;
}

function runLogsAuditFixture(mode, activityMode = 'product') {
  const root = mkdtempSync(join(tmpdir(), 'combo-dev-logs-fixture-'));
  const bin = join(root, 'bin');
  const audit = join(root, 'combo-dev-logs');
  const marker = join(root, 'marker');
  const state = join(root, 'state');
  const getState = join(root, 'get-state');
  const invocations = join(root, 'invocations');
  const markerValue = 'SYNTHETIC_MARKER_1234567890';
  mkdirSync(bin);
  writeFileSync(marker, `${markerValue}\n`, { mode: 0o600 });
  writeFileSync(state, '0\n', { mode: 0o600 });
  writeFileSync(getState, '0\n', { mode: 0o600 });
  writeFileSync(invocations, '', { mode: 0o600 });
  let source = text('scripts/combo-dev-logs.sh');
  for (const [expected, replacement] of [
    [
      "export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'",
      `export PATH='${bin}:/usr/bin:/bin'`,
    ],
    ['readonly ACTIVITY_ATTEMPTS=15', 'readonly ACTIVITY_ATTEMPTS=3'],
    ['readonly ACTIVITY_RETRY_SECONDS=2', 'readonly ACTIVITY_RETRY_SECONDS=0'],
    ['readonly LOG_CAPTURE_BYTES=8388609', 'readonly LOG_CAPTURE_BYTES=64'],
  ]) {
    assert.ok(source.includes(expected), `fixture replacement missing: ${expected}`);
    source = source.replace(expected, replacement);
  }
  writeFileSync(audit, source, { mode: 0o700 });
  writeFileSync(
    join(bin, 'kubectl'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_INVOCATIONS"
app=''
pod=''
for arg in "$@"; do
  [[ "$arg" == app=* ]] && app=\${arg#app=}
  [[ "$arg" == *-pod ]] && pod=$arg
done
if [[ " $* " == *" get pods "* ]]; then
  case "$app" in
    api|worker|runtime|web) container=$app ;;
    postgres|minio) container=$app ;;
    redis-queue|redis-hot) container=redis ;;
    *) exit 2 ;;
  esac
  restart=0
  [[ "$FAKE_MODE" =~ ^(previous|previous-leak)$ && "$app" == worker ]] && restart=1
  [[ "$FAKE_MODE" == restart-multiple && "$app" == worker ]] && restart=2
  if [[ "$FAKE_MODE" == restart-race && "$app" == worker ]]; then
    count=$(<"$FAKE_GET_STATE")
    count=$((count + 1))
    printf '%s\\n' "$count" >"$FAKE_GET_STATE"
    (( count >= 2 )) && restart=1
  fi
  printf '{"items":[{"metadata":{"name":"%s-pod","uid":"%s-uid"},"status":{"phase":"Running","containerStatuses":[{"name":"%s","ready":true,"restartCount":%s}]}}]}\\n' "$app" "$app" "$container" "$restart"
  exit 0
fi
if [[ " $* " == *" logs "* ]]; then
  previous=0
  [[ " $* " == *" --previous "* ]] && previous=1
  case "$pod" in
    api-pod)
      if [[ "$FAKE_MODE" == truncated ]]; then
        printf '%0100d\\n' 0
      elif [[ "$FAKE_MODE" == leak-then-source-fail ]]; then
        count=$(<"$FAKE_STATE")
        count=$((count + 1))
        printf '%s\\n' "$count" >"$FAKE_STATE"
        if (( count == 1 )); then
          printf '%s\\n' "$FAKE_MARKER"
        else
          printf '%s\\n' '{"msg":"route not found"}'
        fi
      else
        printf '%s\\n' '{"msg":"route not found"}'
      fi
      ;;
    runtime-pod)
      if [[ "$FAKE_MODE" == leak-then-source-fail && $(<"$FAKE_STATE") == 1 ]]; then
        exit 1
      fi
      printf '%s\\n' '{"msg":"route not found"}'
      ;;
    worker-pod)
      if [[ "$FAKE_MODE" =~ ^(previous|previous-leak|restart-race)$ && "$previous" == 1 ]]; then
        if [[ "$FAKE_MODE" == previous-leak ]]; then
          printf '%s\\n' "$FAKE_MARKER"
        else
          printf '%s\\n' '{"msg":"pipeline finished"}'
        fi
      elif [[ "$FAKE_MODE" == delayed ]]; then
        count=$(<"$FAKE_STATE")
        count=$((count + 1))
        printf '%s\\n' "$count" >"$FAKE_STATE"
        if (( count >= 2 )); then
          printf '%s\\n' '{"msg":"pipeline finished"}'
        else
          printf '%s\\n' '{"msg":"worker ready"}'
        fi
      elif [[ "$FAKE_MODE" =~ ^(missing|previous|previous-leak|restart-race)$ ]]; then
        printf '%s\\n' '{"msg":"worker ready"}'
      else
        printf '%s\\n' '{"msg":"pipeline finished"}'
      fi
      ;;
    minio-pod)
      if [[ "$FAKE_MODE" == leak ]]; then
        printf '%s\\n' "$FAKE_MARKER"
      elif [[ "$FAKE_MODE" == credential ]]; then
        printf '%s\\n' 'Authorization: Bearer TEST_SECRET_TOKEN'
      else
        printf '%s\\n' '{"msg":"storage ready"}'
      fi
      ;;
    *) printf '%s\\n' '{"msg":"source ready"}' ;;
  esac
  exit 0
fi
exit 2
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'cat'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$FAKE_MODE" == cat-fail && "$*" == *"/minio.current.log"* ]]; then
  exit 1
fi
exec /usr/bin/cat "$@"
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'grep'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$FAKE_MODE" == grep-fail && "$*" == *"/all.log"* ]]; then
  exit 2
fi
exec /usr/bin/grep "$@"
`,
    { mode: 0o700 },
  );
  try {
    const result = spawnSync(
      'bash',
      [
        audit,
        '--since-time',
        '2026-07-25T14:00:00Z',
        '--marker-file',
        marker,
        '--activity-mode',
        activityMode,
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          FAKE_MODE: mode,
          FAKE_MARKER: markerValue,
          FAKE_STATE: state,
          FAKE_GET_STATE: getState,
          FAKE_INVOCATIONS: invocations,
        },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      invocations: readFileSync(invocations, 'utf8'),
      markerValue,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runSmokeLogProbeFixture(mode) {
  const root = mkdtempSync(join(tmpdir(), 'combo-dev-smoke-probe-'));
  const smoke = text('scripts/combo-dev-smoke.sh');
  const start = smoke.indexOf('check_logs_fail_closed() {');
  const end = smoke.indexOf('\n}\n\nmain() {', start);
  assert.ok(start > 0 && end > start);
  const check = smoke.slice(start, end + 2);
  const harness = [
    'set -Eeuo pipefail',
    'WORK=$1',
    `WEB_ORIGIN='http://127.0.0.1:18080'`,
    `status() { printf '[fixture] %s\\n' "$1"; }`,
    `fail() { printf '[fixture] FAIL: %s\\n' "$1" >&2; exit 1; }`,
    `blocked() { printf '[fixture] BLOCKED: %s\\n' "$1" >&2; exit 2; }`,
    `openssl() { printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }`,
    `curl() {`,
    `  case "$FAKE_CURL_MODE" in`,
    `    transport) return 7 ;;`,
    `    wrong-status) printf '200'; return 0 ;;`,
    `    *) printf '404'; return 0 ;;`,
    `  esac`,
    `}`,
    check,
    `check_logs_fail_closed '2026-07-25T14:00:00Z' baseline`,
  ].join('\n');
  try {
    return spawnSync('bash', ['-c', harness, 'combo-dev-smoke-probe', root], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, FAKE_CURL_MODE: mode },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectRenderFailure(root, marker) {
  const output = join(root, 'out.yaml');
  const releaseArgs = writeReleaseFixture(root);
  const result = spawnSync(
    'bash',
    [
      join(root, 'scripts/combo-dev-deploy.sh'),
      '--render-only',
      '--output',
      output,
      ...imageArgs,
      ...releaseArgs,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, marker);
}

function documents(rendered) {
  return rendered.split(/^---\s*$/m).filter((value) => value.trim());
}

function identity(document) {
  return {
    kind: document.match(/^kind:\s*(\S+)/m)?.[1],
    name: document.match(/^metadata:\n(?:^(?: {2}.*)?\n)*?^ {2}name:\s*(\S+)/m)?.[1],
  };
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const rendered = render();
const renderedDocuments = documents(rendered);

function documentFor(kind, name) {
  const found = renderedDocuments.find((document) => {
    const value = identity(document);
    return value.kind === kind && value.name === name;
  });
  assert.ok(found, `${kind}/${name} must exist`);
  return found;
}

test('stage-only render mounts only the three prebound static claims', () => {
  assert.equal(renderedDocuments.length, 40);
  assert.equal(rendered.includes('hostPath:'), false);
  assert.equal(
    renderedDocuments.some((document) =>
      ['StorageClass', 'PersistentVolume', 'PersistentVolumeClaim'].includes(
        identity(document).kind,
      ),
    ),
    false,
  );
  const claims = {
    postgres: 'data-postgres-0',
    'redis-queue': 'data-redis-queue-0',
    minio: 'data-minio-0',
  };
  for (const [name, claim] of Object.entries(claims)) {
    const document = documentFor('StatefulSet', name);
    assert.match(
      document,
      new RegExp(`^ {6}- name: data\n {8}persistentVolumeClaim:\n {10}claimName: ${claim}$`, 'm'),
    );
    assert.match(
      document,
      /mountPath: \/combo-dev-volume-marker[\s\S]*subPath: \.combo-dev-volume/,
    );
    assert.match(
      document,
      /mountPath: (?:\/data|\/var\/lib\/postgresql\/data)[\s\S]*subPath: data/,
    );
    assert.match(document, new RegExp(`combo-dev-static-volume=${name}:v1`));
    assert.doesNotMatch(document, /volumeClaimTemplates:|persistentVolumeClaimRetentionPolicy:/);
  }

  const root = fixture();
  try {
    const sourcePath = join(root, 'infra/k8s/overlays/combo-dev/foundation/resources.yaml');
    const source = readFileSync(sourcePath, 'utf8');
    writeFileSync(
      sourcePath,
      source.replace('            claimName: data-postgres-0', '            claimName: other'),
    );
    expectRenderFailure(root, /guard:static-pvc-mount/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Test apps share one exact immutable release identity without Secret expansion', () => {
  const metadataName = `combo-release-meta-${RELEASE_SHA.slice(0, 12)}`;
  const metadata = documentFor('ConfigMap', metadataName);
  const expected = {
    COMBO_ENVIRONMENT: 'test',
    COMBO_SOURCE_SHA: RELEASE_SHA,
    COMBO_RELEASE_ID: `release-${RELEASE_SHA}`,
    COMBO_BUILT_AT: RELEASE_MANIFEST.builtAt,
    COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${sha(
      `${JSON.stringify(RELEASE_MANIFEST, null, 2)}\n`,
    )}`,
    COMBO_WEB_ASSET_MANIFEST: RELEASE_MANIFEST.webAssetManifest,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.match(metadata, new RegExp(`^ {2}${key}: ["']?${regexEscape(value)}["']?$`, 'm'));
  }
  assert.equal((metadata.match(/^ {2}COMBO_[A-Z_]+:/gm) ?? []).length, 6);
  assert.equal((metadata.match(/^immutable: true$/gm) ?? []).length, 1);
  assert.doesNotMatch(metadata, /0{40}|sha256:0{64}/);

  for (const name of ['api', 'runtime', 'web', 'worker']) {
    const workload = documentFor('Deployment', name);
    assert.match(
      workload,
      new RegExp(`^ {8}envFrom:\n {8}- configMapRef:\n {12}name: ${metadataName}$`, 'm'),
    );
    assert.equal((workload.match(/envFrom:/g) ?? []).length, 1);
    assert.doesNotMatch(workload, /^\s*-\s*secretRef:/m);
  }

  const web = documentFor('Deployment', 'web');
  const nginx = text('infra/k8s/overlays/combo-dev/apps/nginx-dev.conf');
  const runtimeConfig = text('infra/web-runtime-config.sh');
  assert.match(web, /readOnlyRootFilesystem: true/);
  assert.match(web, /mountPath: \/var\/run[\s\S]*name: nginx-run/);
  assert.doesNotMatch(
    runtimeConfig,
    />"?\/usr\/share\/nginx\/html\/(?:try\/)?(?:runtime-config|version)\.json/,
  );
  for (const [endpoint, file] of [
    ['/runtime-config.json', 'runtime-config.json'],
    ['/version.json', 'version.json'],
    ['/try/runtime-config.json', 'try-runtime-config.json'],
  ]) {
    assert.match(
      nginx,
      new RegExp(
        `location = ${endpoint.replaceAll('/', '\\/')} \\{[\\s\\S]*?alias \\/var\\/run\\/combo-web\\/${file};`,
      ),
    );
  }
  assert.match(nginx, /alias \/usr\/share\/nginx\/html\/try\//);
  assert.doesNotMatch(nginx, /alias \/usr\/share\/nginx\/try\//);
  for (const prefix of ['/assets/', '/try/assets/']) {
    const escaped = prefix.replaceAll('/', '\\/');
    assert.match(
      nginx,
      new RegExp(
        `location \\^~ ${escaped} \\{[\\s\\S]*?try_files \\$uri =404;[\\s\\S]*?Cache-Control "public, max-age=31536000, immutable"`,
      ),
    );
  }

  const root = fixture();
  try {
    const deploy = join(root, 'scripts/combo-dev-deploy.sh');
    const source = readFileSync(deploy, 'utf8');
    assert.equal((source.match(/^immutable: true$/gm) ?? []).length, 1);
    writeFileSync(deploy, source.replace(/^immutable: true$/m, 'immutable: false'));
    expectRenderFailure(root, /guard:release-metadata-immutable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Test migration pins the 0008 ledger and proves a second idempotent pass', () => {
  const migrate = documentFor('Job', 'migrate');
  assert.match(
    migrate,
    /^ {8}- name: EXPECTED_MIGRATION_HEAD\n {10}value: 0008_application_database_roles\.sql$/m,
  );
  assert.match(migrate, /^ {8}- name: MIGRATION_RUNS\n {10}value: "2"$/m);
  assert.match(migrate, /^ {2}ttlSecondsAfterFinished: 7200$/m);
});

test('Test migration evidence uses the exact ordered 0000-0008 source ledger', () => {
  const expected = [
    '0000_baseline_schema.sql',
    '0001_expired_upload_reconciliation.sql',
    '0002_drop_stream_events.sql',
    '0003_turns.sql',
    '0004_studio_sessions.sql',
    '0005_capability_current_ui.sql',
    '0006_one_running_turn_per_session.sql',
    '0007_first_party_email_auth.sql',
    '0008_application_database_roles.sql',
  ];
  const sourceLedger = readdirSync(join(repo, 'db/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.deepEqual(sourceLedger, expected);

  const deploy = text('scripts/combo-dev-deploy.sh');
  const workflow = text('.github/workflows/combo-dev.yml');
  const deployLists = [...deploy.matchAll(/expected_migrations = \[\n(?<body>[\s\S]*?)\n\]/g)].map(
    (match) => [...match.groups.body.matchAll(/'([^']+\.sql)'/g)].map((item) => item[1]),
  );
  assert.equal(deployLists.length, 2);
  for (const list of deployLists) assert.deepEqual(list, expected);

  const workflowList = workflow.match(
    /\.migration\.appliedMigrations == \[\n(?<body>[\s\S]*?)\n {12}\]/,
  );
  assert.ok(workflowList?.groups?.body);
  assert.deepEqual(
    [...workflowList.groups.body.matchAll(/"([^"]+\.sql)"/g)].map((item) => item[1]),
    expected,
  );

  assert.match(deploy, /if lines != expected_lines:\n {4}raise SystemExit\(2\)/);
  assert.match(deploy, /0017_\|0018_/);
  assert.doesNotMatch(`${deploy}\n${workflow}`, /0004_upload_bundle_protocol\.sql/);
  for (const list of [...deployLists, expected]) {
    assert.doesNotMatch(list.join('\n'), /(?:^|\n)001[78]_/);
  }
});

test('Test migration proof accepts containerd config digests but fences the live imageID', () => {
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-migration-proof-'));
  const deploy = text('scripts/combo-dev-deploy.sh');
  const captureStart = deploy.indexOf('capture_migration_proof() {');
  const captureEnd = deploy.indexOf('\nwait_apps() {', captureStart);
  const captureSource = deploy.slice(captureStart, captureEnd);
  const verifier = captureSource.match(/<<'PY'\n(?<source>[\s\S]*?)\nPY\n/)?.groups?.source;
  assert.ok(verifier);
  assert.match(captureSource, /local candidate="\$\{output\}\.next"/);
  assert.match(captureSource, /if python3 - \\/);
  assert.match(captureSource, /\[\[ -f "\$candidate" && ! -L "\$candidate" \]\] \|\| return 1/);
  assert.match(captureSource, /chmod 0600 "\$candidate" \|\| return 1/);
  assert.match(captureSource, /mv -T -- "\$candidate" "\$output" \|\| return 1/);
  assert.match(captureSource, /else\n {4}return 1\n {2}fi/);

  const revision = 'a'.repeat(40);
  const expectedDigest = digest('b');
  const expectedImage = `ghcr.io/dangdang-tech/combo-api@sha256:${expectedDigest}`;
  const reportedImage = `sha256:${digest('c')}`;
  const expectedHead = '0008_application_database_roles.sql';
  const jobUid = '11111111-1111-4111-8111-111111111111';
  const podUid = '22222222-2222-4222-8222-222222222222';
  const job = join(work, 'job.json');
  const pods = join(work, 'pods.json');
  const logs = join(work, 'migration.log');
  const output = join(work, 'proof.json');
  const expectedMigrations = [
    '0000_baseline_schema.sql',
    '0001_expired_upload_reconciliation.sql',
    '0002_drop_stream_events.sql',
    '0003_turns.sql',
    '0004_studio_sessions.sql',
    '0005_capability_current_ui.sql',
    '0006_one_running_turn_per_session.sql',
    '0007_first_party_email_auth.sql',
    '0008_application_database_roles.sql',
  ];
  const jobObject = {
    metadata: {
      name: 'migrate',
      namespace: 'combo-preview',
      uid: jobUid,
      labels: { app: 'migrate' },
      creationTimestamp: '2026-07-25T14:00:00Z',
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 600,
      ttlSecondsAfterFinished: 7200,
      template: {
        spec: {
          containers: [
            {
              name: 'migrate',
              image: expectedImage,
              command: ['node', '--experimental-strip-types', 'db/scripts/migrate.ts'],
              env: [
                { name: 'EXPECTED_MIGRATION_HEAD', value: expectedHead },
                { name: 'MIGRATION_RUNS', value: '2' },
              ],
            },
          ],
        },
      },
    },
    status: {
      startTime: '2026-07-25T14:00:01Z',
      completionTime: '2026-07-25T14:00:04Z',
      succeeded: 1,
      conditions: [{ type: 'Complete', status: 'True' }],
    },
  };
  const podObject = {
    metadata: {
      name: 'migrate-proof1',
      namespace: 'combo-preview',
      uid: podUid,
      labels: { 'job-name': 'migrate' },
      ownerReferences: [
        {
          kind: 'Job',
          name: 'migrate',
          uid: jobUid,
          controller: true,
        },
      ],
    },
    spec: {
      containers: [{ name: 'migrate', image: expectedImage }],
    },
    status: {
      phase: 'Succeeded',
      containerStatuses: [
        {
          name: 'migrate',
          image: reportedImage,
          imageID: expectedImage,
          state: {
            terminated: {
              exitCode: 0,
              reason: 'Completed',
              startedAt: '2026-07-25T14:00:02Z',
              finishedAt: '2026-07-25T14:00:03Z',
            },
          },
        },
      ],
    },
  };
  const logLines = [
    ...expectedMigrations.map((name) => `applying ${name} ...`),
    `migration pass 1/2 up to date at ${expectedHead}.`,
    `migration pass 2/2 up to date at ${expectedHead}.`,
    'application database roles ready.',
  ];

  try {
    writeFileSync(job, JSON.stringify(jobObject));
    writeFileSync(pods, JSON.stringify({ items: [podObject] }));
    writeFileSync(logs, `${logLines.join('\n')}\n`);
    const args = ['-', revision, '123', '1', expectedImage, expectedHead, job, pods, logs, output];
    const accepted = spawnSync('python3', args, {
      input: verifier,
      encoding: 'utf8',
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    const proof = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(proof.pod.image, expectedImage);
    assert.equal(proof.pod.imageID, expectedImage);

    writeFileSync(logs, `${logLines.slice(0, -1).join('\n')}\n`);
    rmSync(output, { force: true });
    const missingRoleProof = spawnSync('python3', args, {
      input: verifier,
      encoding: 'utf8',
    });
    assert.equal(missingRoleProof.status, 2);
    assert.equal(existsSync(output), false);
    writeFileSync(logs, `${logLines.join('\n')}\n`);

    podObject.status.containerStatuses[0].imageID = `ghcr.io/dangdang-tech/combo-api@sha256:${digest('d')}`;
    writeFileSync(pods, JSON.stringify({ items: [podObject] }));
    rmSync(output, { force: true });
    const rejected = spawnSync('python3', args, {
      input: verifier,
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 2);
    assert.equal(existsSync(output), false);

    podObject.status.containerStatuses[0].imageID = expectedImage;
    podObject.spec.containers[0].image = `ghcr.io/dangdang-tech/combo-api@sha256:${digest('e')}`;
    writeFileSync(pods, JSON.stringify({ items: [podObject] }));
    const wrongSpec = spawnSync('python3', args, {
      input: verifier,
      encoding: 'utf8',
    });
    assert.equal(wrongSpec.status, 2);
    assert.equal(existsSync(output), false);

    podObject.spec.containers[0].image = expectedImage;
    podObject.metadata.ownerReferences[0].uid = '33333333-3333-4333-8333-333333333333';
    writeFileSync(pods, JSON.stringify({ items: [podObject] }));
    const wrongOwner = spawnSync('python3', args, {
      input: verifier,
      encoding: 'utf8',
    });
    assert.equal(wrongOwner.status, 2);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Test live image evidence binds PodSpec and imageID without trusting runtime aliases', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const liveStart = deploy.indexOf('expected_images = {');
  const liveEnd = deploy.indexOf('\ninventory_keys = {', liveStart);
  const liveVerifier = deploy.slice(liveStart, liveEnd);
  assert.match(liveVerifier, /containers\[0\]\.get\('image'\) != expected_image/);
  assert.match(
    liveVerifier,
    /not digest_matches\(statuses\[0\]\.get\('imageID'\), expected_image\)/,
  );
  assert.doesNotMatch(liveVerifier, /statuses\[0\]\.get\('image'\)/);
});

test('Test workflow publishes sanitized live release evidence before SSH cleanup', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const storageGuard = text('scripts/combo-dev-storage-guard.sh');
  const storageGuardUnit = text('infra/host/combo-dev/combo-dev-storage-guard.service');
  const evidence = workflow.indexOf('Collect and verify sanitized Test evidence');
  const cleanup = workflow.indexOf('Remove transient runner and upload files');
  assert.ok(evidence > 0 && cleanup > evidence);
  assert.match(
    workflow,
    /main-ci\)[\s\S]*evidence_artifact_name="combo-test-evidence-\$\{REVISION\}-\$\{RUN_ATTEMPT\}"[\s\S]*branch-build\)[\s\S]*evidence_artifact_name="combo-branch-test-evidence-\$\{REVISION\}-\$\{RUN_ATTEMPT\}"/,
  );
  assert.match(workflow, /name: \$\{\{ steps\.evidence\.outputs\.artifact_name \}\}/);
  assert.match(workflow, /--arg sourceBranch "\$SOURCE_BRANCH"/);
  assert.match(workflow, /--arg sourceEvent "\$SOURCE_EVENT"/);
  assert.match(workflow, /--arg sourceWorkflow "\$SOURCE_WORKFLOW"/);
  assert.match(workflow, /sourceWorkflow: \$sourceWorkflow/);
  assert.match(workflow, /sourceEvent: \$sourceEvent/);
  assert.match(workflow, /sourceBranch: \$sourceBranch/);
  assert.match(workflow, /sourceConclusion: \$sourceConclusion/);
  assert.match(workflow, /controllerSha: \$controllerSha/);
  assert.match(workflow, /sourceMode: \$sourceMode/);
  assert.match(
    workflow,
    /main-ci\)[\s\S]*source_conclusion=success[\s\S]*branch-build\)[\s\S]*source_conclusion=release-job-success/,
  );
  assert.match(workflow, /\.sourceConclusion == \$sourceConclusion/);
  assert.match(workflow, /\.controllerSha == \$controllerSha/);
  assert.match(workflow, /\.sourceMode == \$sourceMode/);
  assert.match(
    workflow,
    /--revision "\$revision"[\s\\\n]*--workflow-run-id "\$workflow_run_id"[\s\\\n]*--workflow-run-attempt "\$workflow_run_attempt"/,
  );
  assert.match(workflow, /\.workflowRunId == \$runId/);
  assert.match(workflow, /\.workflowRunAttempt == \$runAttempt/);
  assert.match(workflow, /\.reset\.workflowRunId == \$runId/);
  assert.match(workflow, /\.reset\.workflowRunAttempt == \$runAttempt/);
  assert.match(workflow, /\.migration\.workflowRunId == \$runId/);
  assert.match(workflow, /\.migration\.workflowRunAttempt == \$runAttempt/);
  assert.match(workflow, /migration\.head == "0008_application_database_roles\.sql"/);
  assert.match(workflow, /migration\.job\.ttlSecondsAfterFinished == 7200/);
  assert.match(workflow, /legacyObjectsAbsent == true/);
  assert.doesNotMatch(workflow, /\. \+ \{workflowRunId:/);
  assert.match(deploy, /readonly NAMESPACE='combo-preview'/);
  assert.match(
    deploy,
    /write_test_evidence[\s\\\n]*"\$revision" "\$workflow_run_id" "\$workflow_run_attempt"[\s\\\n]*"\$manifest" "\$digest_file" "\$RESET_PROOF_IN_USE" "\$migration_proof"/,
  );
  assert.match(deploy, /local evidence_dir='\/var\/lib\/combo-dev\/evidence'/);
  assert.match(
    deploy,
    /local output="\$evidence_dir\/\$\{revision\}\.\$\{workflow_run_id\}\.\$\{workflow_run_attempt\}\.json"/,
  );
  for (const control of [bootstrap, deploy, reset, storageGuard]) {
    assert.doesNotMatch(control, /install -d -o root -g root -m 0700 \/var\/lib\/combo-dev/);
    assert.match(control, /install -d -o root -g root -m 0711 \/var\/lib\/combo-dev/);
  }
  assert.match(bootstrap, /install -d -o root -g root -m 0755 \/var\/lib\/combo-dev\/evidence/);
  assert.match(storageGuardUnit, /^StateDirectory=combo-dev$/m);
  assert.match(storageGuardUnit, /^StateDirectoryMode=0711$/m);
  assert.doesNotMatch(storageGuardUnit, /^StateDirectoryMode=0700$/m);
  assert.match(deploy, /install -d -o root -g root -m 0755 "\$evidence_dir"/);
  assert.match(deploy, /install -o root -g root -m 0644 "\$candidate" "\$output"/);
  assert.match(deploy, /mv -T -- "\$RESET_PROOF" "\$CONSUMED_RESET_PROOF"/);
  assert.match(deploy, /RESET_PROOF_MAX_AGE_SECONDS=900/);
  assert.match(
    deploy,
    /RESET_PROOF="\/var\/lib\/combo-dev\/reset-proof\.\$\{revision\}\.\$\{workflow_run_id\}\.\$\{workflow_run_attempt\}\.json"/,
  );
  assert.match(reset, /install -o root -g root -m 0600 "\$candidate" "\$RESET_PROOF"/);
  assert.match(reset, /assert_static_volume_data_empty/);
  assert.match(reset, /capture_rebuilt_foundation/);
  assert.match(reset, /'workflowRunId': workflow_run_id/);
  assert.match(reset, /'workflowRunAttempt': workflow_run_attempt/);
  assert.match(deploy, /'workflowRunAttempt': workflow_run_attempt/);
  assert.match(deploy, /capture_migration_proof/);
  assert.match(deploy, /lines != expected_lines/);
  assert.match(deploy, /'logSha256': f"sha256:/);
  assert.doesNotMatch(deploy, /freshResetRequiredByWorkflow/);
  assert.doesNotMatch(deploy, /'jobSucceeded': True/);
  assert.doesNotMatch(
    deploy.slice(
      deploy.indexOf('write_test_evidence() {'),
      deploy.indexOf('prune_stale_configs() {'),
    ),
    /combo-review|Kubernetes Secrets|PRODUCTION_NAMESPACE|PRODUCTION_KUBECONFIG|productAcceptance/,
  );
});

test('Test host gate remains credential-free and leaves product acceptance to trusted workflow control', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  const workflow = text('.github/workflows/combo-dev.yml');
  const dispatcherStart = workflow.indexOf(
    'Upload the fixed bundle and invoke the root-owned dispatcher',
  );
  const dispatcherEnd = workflow.indexOf('Prove development ports remain private', dispatcherStart);
  const dispatcherStep = workflow.slice(dispatcherStart, dispatcherEnd);

  assert.doesNotMatch(deploy, /ACCEPTANCE_RUNNER|\/opt\/combo-dev\/acceptance\/run/);
  assert.doesNotMatch(deploy, /productAcceptance|acceptance_path|acceptance = load/);
  assert.match(deploy, /combo-dev-smoke"[\s\\\n]*--revision "\$revision" --since-time "\$start"/);
  assert.doesNotMatch(smoke, /validate_external_evidence|--evidence|browser_auth/);
  assert.match(smoke, /check_loopback_only[\s\S]*check_logs_fail_closed "\$since" baseline/);
  assert.match(
    smoke,
    /logs_only == 1[\s\S]*verify_pending_acceptance_identity[\s\S]*check_logs_fail_closed "\$since" product/,
  );
  assert.match(dispatcherStep, /id: deploy_test/);
  assert.match(dispatcherStep, /mutation_started=true/);
  assert.doesNotMatch(dispatcherStep, /ACCEPTANCE_RESEND_API_KEY|resend-sent-email/);
});

test('Test runs and validates the exact release artifact six-area browser acceptance', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const checkout = workflow.indexOf('Check out the trusted main Test controller');
  const setupNode = workflow.indexOf('Use Node 24 for release artifact validation');
  const installDependencies = workflow.indexOf('Install trusted Test control dependencies');
  const download = workflow.indexOf('Download the immutable release artifact');
  const deploy = workflow.indexOf('Upload the fixed bundle and invoke the root-owned dispatcher');
  const live = workflow.indexOf('Run the exact artifact six-area Test browser acceptance');
  const failureUpload = workflow.indexOf('Upload sanitized Test browser failure evidence');
  const failureStop = workflow.indexOf('Fail Test after preserving browser failure evidence');
  const evidence = workflow.indexOf('Collect and verify sanitized Test evidence');
  const upload = workflow.indexOf('Upload sanitized Test evidence');
  const accept = workflow.indexOf('Complete the exact Test acceptance');
  const fence = workflow.indexOf('Fence Test after post-deploy acceptance failure');
  const cleanup = workflow.indexOf('Remove transient runner and upload files');
  assert.ok(
    checkout > 0 &&
      setupNode > checkout &&
      installDependencies > setupNode &&
      download > installDependencies &&
      deploy > download &&
      live > deploy &&
      failureUpload > live &&
      failureStop > failureUpload &&
      evidence > failureStop &&
      upload > evidence &&
      accept > upload &&
      fence > accept &&
      cleanup > fence,
  );
  assert.match(
    workflow,
    /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020[\s\S]*node-version: 24/,
  );
  assert.match(workflow.slice(workflow.indexOf('\n  deploy:'), checkout), /timeout-minutes: 300/);
  const deployJob = workflow.slice(workflow.indexOf('\n  deploy:'));
  assert.match(
    deployJob,
    /Check out the trusted main Test controller[\s\S]*ref: \$\{\{ needs\.authorize\.outputs\.controller_sha \}\}/,
  );
  assert.doesNotMatch(
    deployJob.slice(0, download),
    /ref: \$\{\{ needs\.(?:select|authorize)\.outputs\.revision \}\}/,
  );
  assert.match(deployJob, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(deployJob, /node scripts\/release-manifest\.mjs verify/);
  assert.match(deployJob, /node scripts\/web-asset-manifest\.mjs verify/);

  const liveStep = workflow.slice(live, failureUpload);
  assert.match(liveStep, /runner=scripts\/goal-b-test-acceptance\.mjs/);
  assert.match(liveStep, /resend_reader=scripts\/resend-sent-email\.mjs/);
  assert.match(liveStep, /validator=scripts\/promotion-evidence\.mjs/);
  assert.match(liveStep, /playwright_dir=scripts\/node_modules\/playwright-core/);
  assert.match(liveStep, /trusted_acceptance="\$RUNNER_TEMP\/trusted-test-acceptance"/);
  assert.match(
    liveStep,
    /ACCEPTANCE_RESEND_API_KEY: \$\{\{ secrets\.ACCEPTANCE_RESEND_API_KEY \}\}/,
  );
  assert.match(
    liveStep,
    /install -m 0600[\s\\\n]*"\$runner"[\s\\\n]*"\$trusted_acceptance\/acceptance\/live-browser-acceptance\.mjs"/,
  );
  assert.match(
    liveStep,
    /tar -C "\$trusted_acceptance" -czf "\$archive"[\s\\\n]*acceptance\/live-browser-acceptance\.mjs[\s\\\n]*acceptance\/playwright-core\.tgz[\s\\\n]*acceptance\/resend-sent-email\.mjs/,
  );
  assert.doesNotMatch(liveStep, /\$RELEASE_ROOT\/(?:acceptance|scripts)\//);
  assert.match(liveStep, /--environment test/);
  assert.match(liveStep, /--web-origin http:\/\/127\.0\.0\.1:18080/);
  assert.match(liveStep, /--output "\$output"/);
  assert.match(liveStep, /acceptance\/resend-sent-email\.mjs/);
  assert.match(
    liveStep,
    /printf '%s\\n' "\$ACCEPTANCE_RESEND_API_KEY"[\s\S]*IFS= read -r acceptance_resend_api_key; export ACCEPTANCE_RESEND_API_KEY/,
  );
  assert.match(liveStep, /unset ACCEPTANCE_RESEND_API_KEY/);
  assert.match(liveStep, /nvm_script="\$HOME\/\.nvm\/nvm\.sh"/);
  assert.match(liveStep, /\[\[ -f "\$nvm_script" && ! -L "\$nvm_script" \]\]/);
  assert.match(liveStep, /nvm use --silent 24 >\/dev\/null/);
  assert.match(liveStep, /node_major[\s\S]*\[\[ "\$node_major" == 24 \]\]/);
  assert.match(liveStep, /\[\[ "\$\(stat -c '%a' "\$output"\)" == 600 \]\]/);
  assert.match(liveStep, /runner_rc=\$\?/);
  assert.match(liveStep, /\[\[ "\$runner_rc" == 0 \|\| "\$runner_rc" == 1 \]\]/);
  assert.match(
    liveStep,
    /validate-live-browser-failure[\s\\\n]*--environment test[\s\\\n]*--evidence "\$evidence"[\s\\\n]*--identity "\$identity"/,
  );
  assert.match(liveStep, /printf 'acceptance_status=%s\\n' "\$acceptance_status"/);
  assert.match(
    liveStep,
    /combo-test-failure-evidence-\$\{REVISION\}-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}/,
  );
  assert.match(
    liveStep,
    /validate-live-browser[\s\\\n]*--environment test[\s\\\n]*--evidence "\$evidence"[\s\\\n]*--identity "\$identity"/,
  );
  assert.match(liveStep, /deploymentWorkflow: "\.github\/workflows\/combo-dev\.yml"/);
  assert.match(liveStep, /deploymentRunId: \$deploymentRunId/);
  assert.match(liveStep, /deploymentRunAttempt: \$deploymentRunAttempt/);
  assert.match(liveStep, /sourceCiRunId: \$sourceCiRunId/);
  assert.match(liveStep, /sourceCiRunAttempt: \$sourceCiRunAttempt/);
  assert.match(liveStep, /releaseArtifactId: \$releaseArtifactId/);
  assert.match(liveStep, /releaseArtifactDigest: \$releaseArtifactDigest/);
  assert.match(
    liveStep,
    /ssh -T combo-dev-target[\s\\\n]*'sudo -- \/opt\/combo-dev\/bin\/combo-dev-forwarder-lease'/,
  );
  assert.match(liveStep, /trap release_forwarder_lease EXIT/);
  assert.match(liveStep, /forwarders_are inactive/);
  assert.match(liveStep, /grep -Fq 'PASS lease=active'[\s\S]*forwarders_are active/);
  assert.match(liveStep, /exec 7>&-/);
  assert.match(
    liveStep,
    /for _ in \$\(seq 1 45\); do[\s\S]*forwarders_are inactive[\s\S]*stopped=1/,
  );
  assert.ok(liveStep.indexOf('lease_ready == 1') < liveStep.indexOf('node "$runner"'));
  assert.match(
    liveStep,
    /combo-dev-smoke[\s\\\n]*--logs-only[\s\\\n]*--revision "\$revision"[\s\\\n]*--since-time "\$product_started_at"[\s\\\n]*--workflow-run-id "\$workflow_run_id"[\s\\\n]*--workflow-run-attempt "\$workflow_run_attempt"/,
  );
  assert.match(liveStep, /product_started_at=\$\(ssh combo-dev-target date -u/);
  assert.ok(liveStep.indexOf('product_started_at=') < liveStep.indexOf('node "$runner"'));
  assert.ok(liveStep.indexOf('node "$runner"') < liveStep.indexOf('--logs-only'));
  assert.doesNotMatch(
    liveStep,
    /sudo (?:-- )?systemctl (?:start|stop) combo-dev-(?:web|s3)-forward/,
  );
  assert.doesNotMatch(liveStep, /docker|COMBO_PRODUCTION_ACCEPTANCE|CLOUD_REVIEW_ACCESS_TOKEN/);
  assert.doesNotMatch(
    `${workflow.slice(0, live)}${workflow.slice(evidence)}`,
    /ACCEPTANCE_RESEND_API_KEY/,
  );

  const failureSteps = workflow.slice(failureUpload, evidence);
  assert.match(
    failureSteps,
    /always\(\) && steps\.live_browser\.outputs\.acceptance_status == 'failed'/,
  );
  assert.match(
    failureSteps,
    /name: combo-test-failure-evidence-\$\{\{ needs\.authorize\.outputs\.revision \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(failureSteps, /path: \$\{\{ steps\.live_browser\.outputs\.failure_path \}\}/);
  assert.match(
    failureSteps,
    /always\(\) && steps\.live_browser\.outputs\.acceptance_status == 'failed'/,
  );
  assert.doesNotMatch(failureSteps, /combo-test-evidence-\$\{\{/);
  assert.doesNotMatch(failureSteps, /source-release\.json|ACCEPTANCE_RESEND_API_KEY/);

  const evidenceStep = workflow.slice(evidence, upload);
  assert.match(evidenceStep, /if: steps\.live_browser\.outputs\.acceptance_status == 'passed'/);
  assert.doesNotMatch(evidenceStep, /all\(\.productAcceptance|\.productAcceptance\[\]/);
  assert.doesNotMatch(evidenceStep, /del\(\.productAcceptance\)/);
  assert.match(evidenceStep, /has\("productAcceptance"\) \| not/);
  assert.match(evidenceStep, /test-live-browser-acceptance\.json/);
  assert.match(evidenceStep, /test-promotion-identity\.json/);
  assert.match(evidenceStep, /liveBrowserAcceptanceDigest/);
  assert.match(evidenceStep, /testIdentityDigest/);
  assert.match(evidenceStep, /controllerSha: \$controllerSha/);
  assert.match(evidenceStep, /sourceMode: \$sourceMode/);
  assert.match(evidenceStep, /validate-live-browser/);
  assert.match(evidenceStep, /validate-identity/);
  assert.match(evidenceStep, /\.workflowRunAttempt == \$runAttempt/);
  assert.match(
    evidenceStep,
    /\/var\/lib\/combo-dev\/evidence\/\$\{REVISION\}\.\$\{RUN_ID\}\.\$\{RUN_ATTEMPT\}\.json/,
  );
  assert.match(
    evidenceStep,
    /"combo-test-evidence-\$\{REVISION\}\.json"[\s\\\n]*source-release\.json[\s\\\n]*test-live-browser-acceptance\.json[\s\\\n]*test-promotion-identity\.json/,
  );
  assert.match(evidenceStep, /cmp -s "\$expected_files" "\$actual_files"/);

  const acceptStep = workflow.slice(accept, fence);
  assert.match(acceptStep, /id: accept_test/);
  assert.match(
    acceptStep,
    /combo-dev-storage-guard[\s\\\n]*--complete-acceptance "\$REVISION" "\$RUN_ID" "\$RUN_ATTEMPT"/,
  );

  const fenceStep = workflow.slice(fence, cleanup);
  assert.match(
    fenceStep,
    /always\(\) && steps\.deploy_test\.outputs\.mutation_started == 'true' && steps\.accept_test\.outcome != 'success'/,
  );
  assert.match(fenceStep, /timeout-minutes: 15/);
  assert.match(
    fenceStep,
    /combo-dev-storage-guard[\s\\\n]*--fence-attempt "\$REVISION" "\$RUN_ID" "\$RUN_ATTEMPT"/,
  );
  assert.doesNotMatch(fenceStep, /combo-dev-reset|flock|reset-proof/);
  assert.doesNotMatch(fenceStep, /ACCEPTANCE_RESEND_API_KEY|kubectl|combo-review|namespace\/combo/);

  const cleanupStep = workflow.slice(cleanup);
  assert.match(cleanupStep, /if: always\(\)/);
  assert.match(
    cleanupStep,
    /\/opt\/combo-dev\/incoming\/\$\{REVISION\}\.\$\{RUN_ID\}\.\$\{RUN_ATTEMPT\}\.tar\.gz/,
  );
  assert.match(
    cleanupStep,
    /\/opt\/combo-dev\/incoming\/\$\{REVISION\}\.acceptance\.\$\{RUN_ID\}\.\$\{RUN_ATTEMPT\}\.tar\.gz/,
  );
  assert.match(
    cleanupStep,
    /data\/combo-acceptance\/test\/\$\{REVISION\}\.\$\{RUN_ID\}\.\$\{RUN_ATTEMPT\}\.json/,
  );
  assert.match(cleanupStep, /combo-dev-live-browser-\$\{REVISION\}\.tar\.gz/);
  assert.match(cleanupStep, /combo-test-live-browser-\$\{REVISION\}\.json/);
  assert.match(cleanupStep, /combo-test-identity-\$\{REVISION\}\.json/);
  assert.match(cleanupStep, /"\$RUNNER_TEMP\/combo-release\.zip"/);
  assert.match(cleanupStep, /"\$RUNNER_TEMP\/combo-release"/);
  assert.match(
    cleanupStep,
    /rm -rf --[\s\\\n]*"\$RUNNER_TEMP\/combo-release"[\s\\\n]*"\$RUNNER_TEMP\/combo-test-evidence-\$\{REVISION\}"/,
  );
  assert.match(
    cleanupStep,
    /combo-test-failure-evidence-\$\{REVISION\}-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}/,
  );
  assert.match(cleanupStep, /if ! rm -f --/);
  assert.match(cleanupStep, /if ! rm -rf --/);
  assert.match(cleanupStep, /exit "\$cleanup_rc"/);
});

test('Preview stays paused without Test and waits for the exact automatic main Test evidence when enabled', () => {
  const preview = text('.github/workflows/preview.yml');
  const testWorkflow = text('.github/workflows/combo-dev.yml');
  const policyStart = preview.indexOf('  policy:');
  const deployStart = preview.indexOf('\n  deploy:', policyStart);
  const policy = preview.slice(policyStart, deployStart);
  const modeCheck = policy.indexOf('case "$MODE" in');
  const enabledGate = policy.indexOf('if [[ "$MODE" == enabled ]]');
  const testDiscovery = policy.indexOf(
    'actions/workflows/combo-dev.yml/runs?event=workflow_run&branch=main&head_sha=${REVISION}&per_page=100',
  );
  const outputWrite = policy.indexOf("printf 'mode=%s");
  assert.ok(
    policyStart >= 0 &&
      deployStart > policyStart &&
      modeCheck > 0 &&
      enabledGate > modeCheck &&
      testDiscovery > enabledGate &&
      outputWrite > testDiscovery,
  );
  assert.match(
    policy,
    /paused\)\n\s+echo 'Preview automatic promotion is explicitly paused by repository policy\.'\n\s+;;/,
  );
  assert.match(preview, /if: needs\.policy\.outputs\.mode == 'enabled'/);

  const enabledPolicy = policy.slice(enabledGate, outputWrite);
  assert.match(
    enabledPolicy,
    /expected_test_title="Test deployment for CI \$\{SOURCE_RUN_ID\} attempt \$\{SOURCE_RUN_ATTEMPT\}"/,
  );
  assert.match(enabledPolicy, /main advanced before the exact automatic Test completed/);
  assert.match(enabledPolicy, /for _ in \$\(seq 1 900\); do/);
  assert.match(enabledPolicy, /\.name == "Test deployment"/);
  assert.match(enabledPolicy, /\.display_title == \$title/);
  assert.match(enabledPolicy, /\.path == "\.github\/workflows\/combo-dev\.yml"/);
  assert.match(enabledPolicy, /\.event == "workflow_run"/);
  assert.match(enabledPolicy, /\.head_branch == "main"/);
  assert.match(enabledPolicy, /\.head_sha == \$revision/);
  assert.match(enabledPolicy, /\.status == "completed"/);
  assert.match(enabledPolicy, /\.conclusion == "success"/);
  assert.match(enabledPolicy, /matching_test_count > 1/);
  assert.match(enabledPolicy, /matching_test_count == 0[\s\S]*sleep 20/);
  assert.match(enabledPolicy, /queued \|\| "\$test_status" == in_progress/);
  assert.match(enabledPolicy, /The exact automatic Test concluded \$\{test_conclusion\}/);
  assert.match(enabledPolicy, /\.run_attempt \| type == "number"/);
  assert.match(
    enabledPolicy,
    /actions\/runs\/\$\{test_run_id\}\/artifacts\?per_page=100&name=\$\{test_evidence_artifact_name\}/,
  );
  assert.match(enabledPolicy, /\.total_count == 1/);
  assert.match(enabledPolicy, /\$matches\[0\]\.expired == false/);
  assert.match(enabledPolicy, /\$matches\[0\]\.digest \| test\("\^sha256:/);
  assert.match(enabledPolicy, /\$matches\[0\]\.workflow_run\.id == \$runId/);
  assert.match(enabledPolicy, /\$matches\[0\]\.workflow_run\.head_sha == \$revision/);
  assert.match(
    enabledPolicy,
    /actions\/runs\/\$\{test_run_id\}\/attempts\/\$\{test_run_attempt\}\/jobs/,
  );
  assert.match(enabledPolicy, /\.name == "deploy the trusted release to Test"/);
  assert.match(enabledPolicy, /\$deployJobs\[0\]\.started_at <= \$artifactCreatedAt/);
  assert.match(enabledPolicy, /\$artifactCreatedAt <= \$deployJobs\[0\]\.completed_at/);

  const testAdmissionStart = preview.indexOf(
    '      - name: Download and validate the exact successful Test admission',
  );
  const sshSetup = preview.indexOf(
    '      - name: Configure the existing deployment SSH identity',
    testAdmissionStart,
  );
  assert.ok(testAdmissionStart > deployStart && sshSetup > testAdmissionStart);
  const testAdmission = preview.slice(testAdmissionStart, sshSetup);
  assert.match(testAdmission, /actions\/artifacts\/\$\{TEST_EVIDENCE_ARTIFACT_ID\}\/zip/);
  assert.match(
    testAdmission,
    /\[\[ "\$\(sha256sum "\$archive" \| awk '\{print "sha256:" \$1\}'\)"[\s\\\n]*== "\$TEST_EVIDENCE_ARTIFACT_DIGEST" \]\]/,
  );
  assert.match(
    testAdmission,
    /expected_paths=\([\s\S]*"combo-test-evidence-\$\{REVISION\}\.json"[\s\S]*source-release\.json[\s\S]*test-live-browser-acceptance\.json[\s\S]*test-promotion-identity\.json[\s\S]*\)/,
  );
  assert.match(
    testAdmission,
    /\[\[ "\$\{#archive_paths\[@\]\}" == "\$\{#expected_paths\[@\]\}" \]\]/,
  );
  assert.match(testAdmission, /find "\$TEST_EVIDENCE_ROOT" -type l/);
  assert.match(testAdmission, /validate-identity --identity "\$identity"/);
  assert.match(
    testAdmission,
    /validate-live-browser[\s\\\n]*--environment test[\s\\\n]*--evidence "\$browser"[\s\\\n]*--identity "\$identity"/,
  );
  for (const trustCheck of [
    /\.sourceWorkflow == "\.github\/workflows\/ci\.yml"/,
    /\.sourceEvent == "push"/,
    /\.sourceBranch == "main"/,
    /\.controllerSha == \$controllerSha/,
    /\.sourceMode == "main-ci"/,
    /\.sourceCiRunId == \$sourceRunId/,
    /\.sourceCiRunAttempt == \$sourceRunAttempt/,
    /\.deploymentRunId == \$testRunId/,
    /\.deploymentRunAttempt == \$testRunAttempt/,
    /\.releaseArtifactId == \$sourceArtifactId/,
    /\.releaseArtifactName == \$sourceArtifactName/,
    /\.releaseArtifactDigest == \$sourceArtifactDigest/,
    /\.testIdentityDigest == \$identityDigest/,
    /\.liveBrowserAcceptanceDigest == \$browserDigest/,
  ]) {
    assert.match(testAdmission, trustCheck);
  }
  assert.match(testAdmission, /\(has\("productAcceptance"\) \| not\)/);
  assert.match(testAdmission, /\.workflowRunId == \$testRunId/);

  const preflight = preview.indexOf(
    '      - name: Preflight the tecent2 release host without mutation',
    sshSetup,
  );
  const cas = preview.indexOf(
    '      - name: Revalidate all frozen admissions immediately before the first Preview mutation',
    preflight,
  );
  const firstMutation = preview.indexOf(
    '      - name: Check the existing Preview registry credential',
    cas,
  );
  assert.ok(preflight > sshSetup && cas > preflight && firstMutation > cas);
  assert.equal(preview.indexOf('\n      - name:', cas + 1) + 1, firstMutation);
  const beforeCas = preview.slice(deployStart, cas);
  assert.doesNotMatch(beforeCas, /kubectl[\s\S]{0,120}\brun "\$name"/);
  assert.doesNotMatch(beforeCas, /create secret docker-registry/);
  assert.doesNotMatch(beforeCas, /kubectl[\s\S]{0,120}\bapply -f/);
  assert.doesNotMatch(beforeCas, /scp -q/);
  const casStep = preview.slice(cas, firstMutation);
  assert.match(casStep, /git\/ref\/heads\/main/);
  assert.match(casStep, /POLICY_MODE: \$\{\{ needs\.policy\.outputs\.mode \}\}/);
  assert.match(casStep, /ADMISSION_MODE: \$\{\{ vars\.COMBO_PREVIEW_AUTO_PROMOTION_MODE \}\}/);
  assert.match(casStep, /\[\[ "\$POLICY_MODE" == enabled \]\]/);
  assert.match(casStep, /\[\[ "\$ADMISSION_MODE" == enabled \]\]/);
  assert.match(casStep, /actions\/runs\/\$\{SOURCE_RUN_ID\}/);
  assert.match(casStep, /\.run_attempt == \$runAttempt/);
  assert.match(casStep, /actions\/artifacts\/\$\{SOURCE_ARTIFACT_ID\}/);
  assert.match(casStep, /actions\/runs\/\$\{TEST_RUN_ID\}/);
  assert.match(casStep, /actions\/artifacts\/\$\{TEST_EVIDENCE_ARTIFACT_ID\}/);
  assert.match(casStep, /\.digest == \$digest/);

  const promotionStart = preview.indexOf('      - name: Create Preview promotion evidence');
  const promotionEnd = preview.indexOf(
    '      - name: Upload the Production admission evidence',
    promotionStart,
  );
  const promotion = preview.slice(promotionStart, promotionEnd);
  assert.match(promotion, /schemaVersion: 4/);
  for (const field of [
    'testRunId',
    'testRunAttempt',
    'testEvidenceArtifactId',
    'testEvidenceArtifactName',
    'testEvidenceArtifactDigest',
    'testIdentityDigest',
    'testBrowserAcceptanceDigest',
    'testSourceReleaseDigest',
    'testDeploymentEvidenceDigest',
  ]) {
    assert.ok(promotion.includes(`${field}: $${field}`), field);
  }

  const cleanupStart = preview.indexOf('      - name: Remove transient SSH and bundle files');
  const cleanup = preview.slice(cleanupStart);
  assert.match(cleanup, /if: always\(\)/);
  assert.match(cleanup, /cleanup_probes\(\)/);
  assert.match(cleanup, /preconditions: \{uid: \$uid\}/);
  assert.match(cleanup, /combo-preview-pull-\$\{run_id\}-\$\{run_attempt\}/);
  assert.match(cleanup, /combo-preview-pull-\$\{run_id\}-\$\{run_attempt\}-retry/);
  assert.match(cleanup, /"\$RUNNER_TEMP\/combo-release"/);
  assert.match(cleanup, /"\$RUNNER_TEMP\/test-evidence"/);
  assert.match(cleanup, /"\$RUNNER_TEMP\/preview-remote-evidence"/);
  assert.match(cleanup, /if ! rm -f --/);
  assert.match(cleanup, /if ! rm -rf --/);
  assert.match(cleanup, /exit "\$cleanup_rc"/);
  assert.doesNotMatch(cleanup, /\|\| true/);

  assert.doesNotMatch(
    `${testWorkflow}\n${preview}`,
    /(?:^|\n)\s*docker\s+(?:build|compose|info|inspect|pull|push|run)\b/m,
  );
});

test('Test evidence inventories every relevant namespaced kind without reading Secrets', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const rbac = text('infra/k8s/overlays/combo-dev/platform/rbac.yaml');
  const evidenceWriter = deploy.slice(
    deploy.indexOf('write_test_evidence() {'),
    deploy.indexOf('prune_stale_configs() {'),
  );
  for (const resource of [
    'deployments.apps',
    'statefulsets.apps',
    'daemonsets.apps',
    'jobs.batch',
    'cronjobs.batch',
    'services',
    'pods',
    'configmaps',
    'serviceaccounts',
    'networkpolicies.networking.k8s.io',
    'ingresses.networking.k8s.io',
    'horizontalpodautoscalers.autoscaling',
    'roles.rbac.authorization.k8s.io',
    'rolebindings.rbac.authorization.k8s.io',
    'resourcequotas',
    'limitranges',
    'persistentvolumeclaims',
  ]) {
    assert.ok(evidenceWriter.includes(resource), resource);
  }
  assert.doesNotMatch(evidenceWriter, /\bget\s+[^\n]*\bsecrets?\b/i);
  assert.match(evidenceWriter, /resource_inventory\['excludedKinds'\] = \['Secret'\]/);
  assert.match(evidenceWriter, /'DaemonSet': set\(\)/);
  assert.match(evidenceWriter, /'CronJob': set\(\)/);
  assert.match(evidenceWriter, /'Ingress': set\(\)/);
  assert.match(evidenceWriter, /'HorizontalPodAutoscaler': set\(\)/);

  const secretRules = [
    ...rbac.matchAll(
      /- apiGroups: \[''\]\n {4}resources: \['secrets'\]\n {4}resourceNames: \[([^\]]+)\]\n {4}verbs: \[([^\]]+)\]/g,
    ),
  ];
  assert.equal(secretRules.length, 0);
  for (const rule of [
    "resources: ['serviceaccounts', 'resourcequotas', 'limitranges']\n    verbs: ['get', 'list', 'watch']",
    "resources: ['daemonsets']\n    verbs: ['get', 'list', 'watch']",
    "resources: ['cronjobs']\n    verbs: ['get', 'list', 'watch']",
    "resources: ['ingresses']\n    verbs: ['get', 'list', 'watch']",
    "resources: ['horizontalpodautoscalers']\n    verbs: ['get', 'list', 'watch']",
  ]) {
    assert.ok(rbac.includes(rule), rule);
  }
});

test('control scripts never directly get, list, or delete a Secret', () => {
  for (const path of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-smoke.sh',
    'scripts/combo-dev-logs.sh',
    'scripts/combo-dev-storage-guard.sh',
    'scripts/combo-dev-forwarder-lease.sh',
  ]) {
    const normalized = text(path).replaceAll(/\\\n\s*/g, ' ');
    const commands = [
      ...normalized.matchAll(/(?:"\$\{(?:AK|K|DK|FK|PK)\[@\]\}"|\bkubectl\b)([^\n;|]{0,500})/g),
    ].map((match) => match[0]);
    for (const command of commands) {
      assert.doesNotMatch(
        command,
        /\b(?:get|delete)\b[^\n;|]*\bsecrets?(?:\/|\b)/i,
        `${path}: ${command}`,
      );
    }
  }
});

test('root-side release validation rejects a boolean schema version', () => {
  const root = fixture();
  try {
    const output = join(root, 'out.yaml');
    const invalid = clone(RELEASE_MANIFEST);
    invalid.schemaVersion = true;
    const releaseArgs = writeReleaseFixture(root, invalid);
    const result = spawnSync(
      'bash',
      [
        join(root, 'scripts/combo-dev-deploy.sh'),
        '--render-only',
        '--output',
        output,
        ...imageArgs,
        ...releaseArgs,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /render-only 发布清单校验失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Restricted combo-preview workloads reject every hostPath injection', () => {
  const namespace = text('infra/k8s/overlays/combo-dev/platform/namespace.yaml');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  const jobProbe = deploy.slice(
    deploy.indexOf('server_preflight() {'),
    deploy.indexOf('apply_and_wait_foundation() {'),
  );
  const networkCanary = smoke.slice(
    smoke.indexOf('run_network_canary() {'),
    smoke.indexOf('check_logs_fail_closed() {'),
  );
  assert.match(namespace, /pod-security\.kubernetes\.io\/enforce: restricted/);
  assert.equal(rendered.includes('hostPath:'), false);
  assert.doesNotMatch(jobProbe, /^\s+hostPath:/m);
  assert.doesNotMatch(networkCanary, /^\s+hostPath:/m);

  const root = fixture();
  try {
    const resources = join(root, 'infra/k8s/overlays/combo-dev/apps/resources.yaml');
    const source = readFileSync(resources, 'utf8');
    writeFileSync(
      resources,
      source.replace(
        '      volumes:\n        - configMap:\n            name: combo-dev-nginx',
        '      volumes:\n        - hostPath:\n            path: /tmp\n            type: Directory\n          name: forbidden-host\n        - configMap:\n            name: combo-dev-nginx',
      ),
    );
    expectRenderFailure(root, /guard:(?:forbidden|workload-hostpath)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PostgreSQL migration supports fresh, legacy, repeat, and fail-closed partial starts', () => {
  const postgres = documentFor('StatefulSet', 'postgres');
  const migration = text('infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh');
  assert.match(postgres, /name: PGDATA\n\s+value: \/var\/lib\/postgresql\/data\/pgdata/);
  assert.match(postgres, /\/opt\/combo-dev\/postgres-entrypoint\.sh/);
  assert.match(postgres, /runAsUser: 70/);
  assert.match(postgres, /runAsGroup: 70/);
  assert.match(migration, /\.combo-dev-pgdata-migration/);
  assert.doesNotMatch(migration, /-printf|-print0|read\s+-[^\n]*d/);
  assert.ok(
    migration.indexOf('"$mover" -- "$root/PG_VERSION"') > migration.indexOf('for source in'),
  );
  assert.match(migration, /\[\[ ! -e "\$state" \]\] \|\| block/);

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-postgres-'));
  try {
    const entrypoint = join(work, 'entrypoint');
    const mover = join(work, 'mover');
    const count = join(work, 'move-count');
    writeFileSync(entrypoint, '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(
      mover,
      `#!/usr/bin/env bash
set -eu
n=0
[[ ! -f "$MOVE_COUNT" ]] || n=$(cat "$MOVE_COUNT")
n=$((n+1))
printf '%s\\n' "$n" >"$MOVE_COUNT"
(( n != 2 )) || exit 9
exec mv "$@"
`,
    );
    chmodSync(entrypoint, 0o755);
    chmodSync(mover, 0o755);
    const script = join(repo, 'infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh');
    const run = (root, selectedMover = '/bin/mv', extra = {}) =>
      spawnSync('bash', [script], {
        env: {
          ...process.env,
          COMBO_DEV_POSTGRES_DATA_ROOT: root,
          PGDATA: join(root, 'pgdata'),
          COMBO_DEV_POSTGRES_ENTRYPOINT: entrypoint,
          COMBO_DEV_POSTGRES_MOVER: selectedMover,
          COMBO_DEV_POSTGRES_TEST_MODE: '1',
          ...extra,
        },
        stdio: 'ignore',
      });

    const freshRoot = join(work, 'fresh');
    mkdirSync(freshRoot);
    assert.equal(run(freshRoot).status, 0);
    assert.equal(run(freshRoot).status, 0);

    const legacyRoot = join(work, 'legacy');
    mkdirSync(join(legacyRoot, 'base'), { recursive: true });
    writeFileSync(join(legacyRoot, 'PG_VERSION'), '16\n');
    writeFileSync(join(legacyRoot, 'base', 'record'), 'one');
    writeFileSync(join(legacyRoot, '.hidden'), 'two');
    assert.equal(run(legacyRoot).status, 0);
    assert.equal(readFileSync(join(legacyRoot, 'pgdata', 'PG_VERSION'), 'utf8'), '16\n');
    assert.equal(readFileSync(join(legacyRoot, 'pgdata', 'base', 'record'), 'utf8'), 'one');
    assert.equal(readFileSync(join(legacyRoot, 'pgdata', '.hidden'), 'utf8'), 'two');
    assert.equal(run(legacyRoot).status, 0);

    const failedRoot = join(work, 'failed');
    mkdirSync(failedRoot);
    writeFileSync(join(failedRoot, 'PG_VERSION'), '16\n');
    writeFileSync(join(failedRoot, 'first'), 'one');
    writeFileSync(join(failedRoot, 'second'), 'two');
    const failed = run(failedRoot, mover, { MOVE_COUNT: count });
    assert.notEqual(failed.status, 0);
    assert.equal(readFileSync(count, 'utf8').trim(), '2');
    assert.equal(readFileSync(join(failedRoot, 'PG_VERSION'), 'utf8'), '16\n');
    assert.equal(
      readFileSync(join(failedRoot, '.combo-dev-pgdata-migration'), 'utf8'),
      'state=in-progress\n',
    );
    assert.equal(run(failedRoot, mover, { MOVE_COUNT: count }).status, 2);
    assert.equal(readFileSync(count, 'utf8').trim(), '2');

    const nonemptyRoot = join(work, 'nonempty-child');
    mkdirSync(join(nonemptyRoot, 'pgdata'), { recursive: true });
    writeFileSync(join(nonemptyRoot, 'PG_VERSION'), '16\n');
    writeFileSync(join(nonemptyRoot, 'pgdata', 'partial'), 'partial');
    assert.equal(run(nonemptyRoot).status, 2);
    assert.equal(readFileSync(join(nonemptyRoot, 'PG_VERSION'), 'utf8'), '16\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('static local PV bindings are complete, canonical, and cannot fall back outside the mount', () => {
  const storage = text('infra/k8s/overlays/combo-dev/platform/storage-volumes.yaml');
  const storageClass = text('infra/k8s/overlays/combo-dev/platform/storage-class.yaml');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  const hostReadme = text('infra/host/combo-dev/README.md');

  const validateStorage = (source) => {
    const docs = documents(source);
    const pvs = docs.filter((document) => identity(document).kind === 'PersistentVolume');
    const pvcs = docs.filter((document) => identity(document).kind === 'PersistentVolumeClaim');
    assert.deepEqual(pvs.map((document) => identity(document).name).sort(), [
      'combo-dev-minio',
      'combo-dev-postgres',
      'combo-dev-redis-queue',
    ]);
    assert.deepEqual(pvcs.map((document) => identity(document).name).sort(), [
      'data-minio-0',
      'data-postgres-0',
      'data-redis-queue-0',
    ]);
    const expected = {
      'combo-dev-postgres': ['data-postgres-0', '8Gi', '/home/xingzheng/data/combo-dev/postgres'],
      'combo-dev-redis-queue': [
        'data-redis-queue-0',
        '2Gi',
        '/home/xingzheng/data/combo-dev/redis-queue',
      ],
      'combo-dev-minio': ['data-minio-0', '6Gi', '/home/xingzheng/data/combo-dev/minio'],
    };
    for (const document of pvs) {
      const name = identity(document).name;
      const [claim, size, localPath] = expected[name];
      assert.match(document, new RegExp(`^    storage: ${size}$`, 'm'));
      assert.match(document, /^ {2}persistentVolumeReclaimPolicy: Retain$/m);
      assert.match(document, new RegExp(`^    name: ${claim}$`, 'm'));
      assert.match(document, new RegExp(`^    path: ${localPath.replaceAll('/', '\\/')}$`, 'm'));
      assert.match(
        document,
        /key: kubernetes\.io\/hostname[\s\S]*operator: In[\s\S]*COMBO_DEV_NODE_HOSTNAME/,
      );
      assert.doesNotMatch(document, /hostPath:|DirectoryOrCreate/);
    }
    for (const document of pvcs) {
      const claim = identity(document).name;
      const match = Object.entries(expected).find(([, value]) => value[0] === claim);
      assert.ok(match);
      const [pv, [, size]] = match;
      assert.match(document, new RegExp(`^  volumeName: ${pv}$`, 'm'));
      assert.match(document, new RegExp(`^      storage: ${size}$`, 'm'));
      assert.match(document, /^ {2}storageClassName: combo-dev-bounded$/m);
    }
  };

  validateStorage(storage);
  assert.throws(() =>
    validateStorage(storage.replace('name: combo-dev-minio', 'name: missing-minio')),
  );
  assert.throws(() =>
    validateStorage(
      storage.replace(
        '/home/xingzheng/data/combo-dev/minio',
        '/home/xingzheng/data/combo-dev-fallback/minio',
      ),
    ),
  );
  assert.match(storageClass, /provisioner: kubernetes\.io\/no-provisioner/);
  assert.match(storageClass, /reclaimPolicy: Retain/);
  assert.match(storageClass, /volumeBindingMode: WaitForFirstConsumer/);
  assert.doesNotMatch(storageClass, /combo\.dev\/local-path/);
  assert.equal(storage.match(/COMBO_DEV_NODE_HOSTNAME/g)?.length, 3);
  assert.equal(storage.includes('hostPath:'), false);
  assert.equal(
    existsSync(join(repo, 'infra/k8s/overlays/combo-dev/platform/storage-provisioner.yaml')),
    false,
  );
  assert.equal(
    existsSync(join(repo, 'infra/k8s/overlays/combo-dev/platform/storage-rbac.yaml')),
    false,
  );

  const bootstrapMutations = bootstrap.slice(
    bootstrap.indexOf('bootstrap_mutations() {'),
    bootstrap.lastIndexOf('main() {'),
  );
  const namespaceSanitizer = bootstrap.slice(
    bootstrap.indexOf('sanitize_preview_namespace() {'),
    bootstrap.indexOf('mark_failure_fence() {'),
  );
  assert.doesNotMatch(
    namespaceSanitizer,
    /\b(?:get|delete)\b[^\n]*\bsecrets?\b|\bsecrets?\b[^\n]*\bdelete\b/i,
  );
  assert.ok(
    bootstrapMutations.indexOf('MUTATING=1') <
      bootstrapMutations.indexOf('prepare_static_storage_paths'),
  );
  assert.ok(
    bootstrapMutations.indexOf('prepare_static_storage_paths') <
      bootstrapMutations.indexOf('install_static_storage_bindings_admin'),
  );
  for (const token of [
    '$POSTGRES_STORAGE_PATH 70 70',
    '$REDIS_QUEUE_STORAGE_PATH 999 1000',
    '$MINIO_STORAGE_PATH 1000 1000',
    'chown root:root "$STORAGE_POOL"',
    'findmnt -rn -T "$path" -o TARGET',
    'install -d -o "$uid" -g "$gid" -m 0700 "$path"',
  ]) {
    assert.ok(bootstrap.includes(token));
  }
  assert.match(guard, /findmnt -rn -M "\$STORAGE_POOL" -o TARGET/);
  assert.match(guard, /stat -c '%u:%g:%a' "\$STORAGE_POOL"/);
  assert.match(guard, /"\$source" != "\$parent_source"/);
  assert.match(guard, /"\$target" == "\$STORAGE_POOL"/);
  for (const script of [bootstrap, text('scripts/combo-dev-deploy.sh'), guard]) {
    assert.doesNotMatch(script, /df -P[^\n]*--output/);
  }
  if (process.platform === 'linux') {
    assert.equal(spawnSync('df', ['-B1', '--output=size', '/'], { stdio: 'ignore' }).status, 0);
    assert.equal(spawnSync('df', ['--output=iavail', '/'], { stdio: 'ignore' }).status, 0);
  }

  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-storage-guard.sh',
  ]) {
    assert.match(text(scriptPath), /validate-mount-dependencies/);
  }
  assert.doesNotMatch(bootstrap, /combo\.dev\/local-path|combo-dev-local-path/);
  const mountWork = mkdtempSync(join(tmpdir(), 'combo-dev-mount-contract-'));
  try {
    const input = join(mountWork, 'mounts');
    const check = (value) => {
      writeFileSync(input, value);
      return spawnSync(
        'python3',
        [
          join(repo, 'scripts/combo-dev-production-safety.py'),
          'validate-mount-dependencies',
          '--input',
          input,
          '--data-mount',
          '/home/xingzheng/data',
          '--storage-pool',
          '/home/xingzheng/data/combo-dev',
        ],
        { stdio: 'ignore' },
      ).status;
    };
    assert.equal(check('/home/xingzheng/data /var/lib/rancher/k3s\n'), 0);
    assert.notEqual(check('/home/xingzheng/data/combo-dev\n'), 0);
    assert.notEqual(check('/home/xingzheng/data/combo-dev/postgres\n'), 0);
    assert.notEqual(check('/home/xingzheng/data/combo-dev/../combo-dev/minio\n'), 0);
    assert.notEqual(check('/var/lib/rancher/k3s\n'), 0);
  } finally {
    rmSync(mountWork, { recursive: true, force: true });
  }
  assert.match(hostReadme, /RequiresMountsFor=\/home\/xingzheng\/data/);
  assert.doesNotMatch(hostReadme, /RequiresMountsFor=\/home\/xingzheng\/data\/combo-dev/);
});

test('bootstrap accepts only the exact disposable legacy preview storage and removes it before static binding', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const marker = 'python3 - "$pvc" "$pv" "$K3S_DATA_DIR" "$WORK/legacy-storage.json" <<\'PY\' ||';
  const start = bootstrap.indexOf(marker);
  assert.notEqual(start, -1);
  const bodyStart = bootstrap.indexOf('\n', start) + 1;
  const bodyEnd = bootstrap.indexOf('\nPY\n', bodyStart);
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart);
  const classifier = bootstrap.slice(bodyStart, bodyEnd);
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-legacy-storage-'));
  try {
    mkdirSync(join(work, 'k3s', 'storage'), { recursive: true });
    const dataDir = realpathSync(join(work, 'k3s'));
    const storageDir = join(dataDir, 'storage');
    const definitions = [
      ['combo-preview-postgres-data-postgres-0', '11111111-1111-1111-1111-111111111111'],
      ['combo-preview-redis-queue-data-redis-queue-0', '22222222-2222-2222-2222-222222222222'],
      ['combo-preview-minio-data-minio-0', '33333333-3333-3333-3333-333333333333'],
    ];
    const claims = [];
    const volumes = [];
    for (const [name, uid] of definitions) {
      const volume = `pvc-${uid}`;
      const localPath = join(storageDir, `${volume}_combo-preview_${name}`);
      mkdirSync(localPath);
      claims.push({
        metadata: { name, uid },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: 'local-path',
          volumeMode: 'Filesystem',
          volumeName: volume,
        },
        status: { phase: 'Bound' },
      });
      volumes.push({
        metadata: { name: volume },
        spec: {
          accessModes: ['ReadWriteOnce'],
          capacity: { storage: '1Gi' },
          claimRef: { name, namespace: 'combo-preview', uid },
          local: { path: localPath },
          persistentVolumeReclaimPolicy: 'Delete',
          storageClassName: 'local-path',
          volumeMode: 'Filesystem',
        },
        status: { phase: 'Bound' },
      });
    }
    const pvc = join(work, 'pvc.json');
    const pv = join(work, 'pv.json');
    const output = join(work, 'contract.json');
    const run = (claimItems, volumeItems) => {
      writeFileSync(pvc, JSON.stringify({ items: claimItems }));
      writeFileSync(pv, JSON.stringify({ items: volumeItems }));
      rmSync(output, { force: true });
      return spawnSync('python3', ['-c', classifier, pvc, pv, dataDir, output], {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        stdio: 'ignore',
      }).status;
    };
    assert.equal(run(claims, volumes), 0);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).claims.length, 3);

    const wrongClaim = clone(claims);
    wrongClaim[0].metadata.name = 'unexpected-preview-data';
    assert.notEqual(run(wrongClaim, volumes), 0);
    const wrongPath = clone(volumes);
    wrongPath[0].spec.local.path = join(work, 'outside');
    assert.notEqual(run(claims, wrongPath), 0);
    const wrongReclaim = clone(volumes);
    wrongReclaim[0].spec.persistentVolumeReclaimPolicy = 'Retain';
    assert.notEqual(run(claims, wrongReclaim), 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  assert.match(bootstrap, /bootstrap_boundary legacy-storage-cleanup/);
  assert.match(bootstrap, /wait --for=delete "persistentvolume\/\$volume"/);
  assert.match(bootstrap, /\[\[ ! -e "\$path" && ! -L "\$path" \]\]/);
  const freshHarness = `
source ${JSON.stringify(join(repo, 'scripts/combo-dev-bootstrap.sh'))}
fake_kubectl() { return 0; }
AK=(fake_kubectl)
if namespace_exists_admin; then exit 9; else [[ $? == 1 ]]; fi
fence_all_writers_admin
sanitize_preview_namespace
`;
  assert.equal(spawnSync('bash', ['-c', freshHarness], { stdio: 'ignore' }).status, 0);
});

test('data Pod identities and bootstrap ownership match the pinned image contracts', () => {
  const foundation = text('infra/k8s/overlays/combo-dev/foundation/resources.yaml');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const postgres = documentFor('StatefulSet', 'postgres');
  const redisQueue = documentFor('StatefulSet', 'redis-queue');
  const redisHot = documentFor('Deployment', 'redis-hot');
  const minio = documentFor('StatefulSet', 'minio');
  assert.match(postgres, /runAsGroup: 70[\s\S]*runAsUser: 70/);
  assert.match(redisQueue, /runAsGroup: 1000[\s\S]*runAsUser: 999/);
  assert.match(redisHot, /runAsGroup: 1000[\s\S]*runAsUser: 999/);
  assert.match(minio, /runAsGroup: 1000[\s\S]*runAsUser: 1000/);
  assert.match(bootstrap, /\$POSTGRES_STORAGE_PATH 70 70/);
  assert.match(bootstrap, /\$REDIS_QUEUE_STORAGE_PATH 999 1000/);
  assert.match(bootstrap, /\$MINIO_STORAGE_PATH 1000 1000/);
  assert.match(foundation, new RegExp(POSTGRES_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(foundation, new RegExp(REDIS_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(foundation, new RegExp(MINIO_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test(
  'exact pinned data images expose the required runtime identities',
  { skip: !dockerAvailable },
  () => {
    const probes = [
      [
        POSTGRES_IMAGE,
        ['--entrypoint', '/bin/sh'],
        'test "$(id -u postgres):$(id -g postgres)" = 70:70 && command -v cat >/dev/null && command -v docker-entrypoint.sh >/dev/null',
      ],
      [
        REDIS_IMAGE,
        ['--entrypoint', '/bin/sh'],
        'test "$(id -u redis):$(id -g redis)" = 999:1000 && command -v cat >/dev/null && command -v redis-server >/dev/null',
      ],
      [
        MINIO_IMAGE,
        ['--user', '1000:1000', '--entrypoint', '/bin/sh'],
        'test "$(id -u):$(id -g)" = 1000:1000 && command -v cat >/dev/null && test -x /usr/bin/docker-entrypoint.sh',
      ],
      [
        MINIO_MC_IMAGE,
        ['--entrypoint', '/bin/sh'],
        'command -v mc >/dev/null && command -v sleep >/dev/null',
      ],
    ];
    for (const [image, options, command] of probes) {
      const result = spawnSync('docker', ['run', '--rm', ...options, image, '-ec', command], {
        stdio: 'ignore',
      });
      assert.equal(result.status, 0, `${image} identity probe failed`);
    }
  },
);

test(
  'MinIO initialization runs with the exact pinned mc image toolset',
  { skip: !dockerAvailable },
  () => {
    const resource = text('infra/k8s/overlays/combo-dev/init/resources.yaml');
    const lines = resource.split('\n');
    const start = lines.indexOf('  init-buckets.sh: |') + 1;
    const end = lines.indexOf('kind: ConfigMap');
    assert.ok(start > 0 && end > start);
    const script = lines
      .slice(start, end)
      .map((line) => (line.length === 0 ? '' : line.slice(4)))
      .join('\n');
    const work = mkdtempSync(join(tmpdir(), 'combo-dev-minio-init-'));
    try {
      const scriptPath = join(work, 'init.sh');
      const fakeMc = join(work, 'mc');
      writeFileSync(scriptPath, `${script}\n`);
      writeFileSync(
        fakeMc,
        `#!/bin/sh
case "$*" in
  "admin user list local --json")
    printf '%s\\n' '{"status":"success","accessKey":"appKey1"}'
    [ -f /tmp/fake-mc-removed ] || printf '%s\\n' '{"status":"success","accessKey":"staleKey1"}'
    ;;
  "admin user remove local staleKey1") : >/tmp/fake-mc-removed ;;
  "admin user info local staleKey1") exit 1 ;;
  "alias set revoked "*) exit 1 ;;
  *) exit 0 ;;
esac
`,
      );
      chmodSync(scriptPath, 0o755);
      chmodSync(fakeMc, 0o755);
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/sh',
          '-v',
          `${work}:/probe:ro`,
          '-e',
          'MINIO_ROOT_USER=rootuser',
          '-e',
          'MINIO_ROOT_PASSWORD=rootpass',
          '-e',
          'S3_ACCESS_KEY=appKey1',
          '-e',
          'S3_SECRET_KEY=secretKey1',
          '-e',
          'S3_ENDPOINT=http://minio.invalid',
          '-e',
          'MC_CONFIG_DIR=/tmp/mc-test',
          MINIO_MC_IMAGE,
          '-ec',
          'PATH=/probe:/bin /bin/sh /probe/init.sh',
        ],
        { stdio: 'ignore' },
      );
      assert.equal(result.status, 0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test(
  'fresh static volumes are unwritable before exact ownership and writable afterward',
  { skip: !dockerAvailable },
  () => {
    const token = mkdtempSync(join(tmpdir(), 'combo-dev-volume-token-')).split('/').at(-1);
    const specs = [
      { name: 'postgres', image: POSTGRES_IMAGE, user: '70:70' },
      { name: 'redis', image: REDIS_IMAGE, user: '999:1000' },
      { name: 'minio', image: MINIO_IMAGE, user: '1000:1000' },
    ];
    const volumes = [];
    try {
      for (const spec of specs) {
        const volume = `combo-dev-test-${token}-${spec.name}`.toLowerCase();
        volumes.push(volume);
        execFileSync('docker', ['volume', 'create', volume], { stdio: 'ignore' });
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            'chown 0:0 /volume && chmod 0700 /volume',
          ],
          { stdio: 'ignore' },
        );
        const denied = spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '--user',
            spec.user,
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            'touch /volume/probe',
          ],
          { stdio: 'ignore' },
        );
        assert.notEqual(
          denied.status,
          0,
          `${spec.name} unexpectedly wrote a root-owned fresh volume`,
        );
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            `chown ${spec.user} /volume && chmod 0700 /volume`,
          ],
          { stdio: 'ignore' },
        );
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--user',
            spec.user,
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            'touch /volume/probe && rm /volume/probe',
          ],
          { stdio: 'ignore' },
        );
        if (spec.name === 'postgres') {
          execFileSync(
            'docker',
            [
              'run',
              '--rm',
              '--user',
              spec.user,
              '--entrypoint',
              '/bin/sh',
              '-v',
              `${volume}:/volume`,
              spec.image,
              '-ec',
              'mkdir /volume/pgdata && initdb -D /volume/pgdata --auth-local=trust --auth-host=reject >/dev/null',
            ],
            { stdio: 'ignore' },
          );
        }
      }
    } finally {
      for (const volume of volumes) {
        spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
      }
      rmSync(join(tmpdir(), token), { recursive: true, force: true });
    }
  },
);

test(
  'PostgreSQL migration runs with only commands in the exact pinned Alpine image',
  { skip: !dockerAvailable },
  () => {
    const tokenDirectory = mkdtempSync(join(tmpdir(), 'combo-dev-migration-token-'));
    const token = tokenDirectory.split('/').at(-1);
    const volume = `combo-dev-test-${token}-migration`.toLowerCase();
    const script = join(repo, 'infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh');
    const marker = join(tokenDirectory, 'volume-marker');
    writeFileSync(marker, 'wrong-volume-marker\n');
    try {
      execFileSync('docker', ['volume', 'create', volume], { stdio: 'ignore' });
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/sh',
          '-v',
          `${volume}:/var/lib/postgresql/data`,
          POSTGRES_IMAGE,
          '-ec',
          'mkdir -p /var/lib/postgresql/data/base && printf "16\\n" > /var/lib/postgresql/data/PG_VERSION && printf x > /var/lib/postgresql/data/base/item && chown -R 70:70 /var/lib/postgresql/data && chmod 0700 /var/lib/postgresql/data',
        ],
        { stdio: 'ignore' },
      );
      const args = [
        'run',
        '--rm',
        '--user',
        '70:70',
        '--entrypoint',
        '/bin/bash',
        '-e',
        'COMBO_DEV_POSTGRES_DATA_ROOT=/var/lib/postgresql/data',
        '-e',
        'PGDATA=/var/lib/postgresql/data/pgdata',
        '-e',
        'COMBO_DEV_POSTGRES_ENTRYPOINT=/bin/true',
        '-e',
        'COMBO_DEV_POSTGRES_MOVER=/bin/mv',
        '-e',
        'COMBO_DEV_STORAGE_MARKER=/combo-dev-volume-marker',
        '-e',
        'COMBO_DEV_STORAGE_MARKER_STATE=combo-dev-static-volume=postgres:v1',
        '-v',
        `${volume}:/var/lib/postgresql/data`,
        '-v',
        `${marker}:/combo-dev-volume-marker:ro`,
        '-v',
        `${script}:/opt/combo-dev/postgres-entrypoint.sh:ro`,
        POSTGRES_IMAGE,
        '/opt/combo-dev/postgres-entrypoint.sh',
      ];
      const wrongMarker = spawnSync('docker', args, { stdio: 'ignore' });
      assert.equal(wrongMarker.status, 2);
      writeFileSync(marker, 'combo-dev-static-volume=postgres:v1\n');
      execFileSync('docker', args, { stdio: 'ignore' });
      execFileSync('docker', args, { stdio: 'ignore' });
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/sh',
          '-v',
          `${volume}:/var/lib/postgresql/data`,
          POSTGRES_IMAGE,
          '-ec',
          'test ! -e /var/lib/postgresql/data/PG_VERSION && test -f /var/lib/postgresql/data/pgdata/PG_VERSION && test -f /var/lib/postgresql/data/pgdata/base/item && test ! -e /var/lib/postgresql/data/.combo-dev-pgdata-migration && for command in bash cat mkdir mv chmod rm sync; do command -v "$command" >/dev/null; done && ! find /tmp -maxdepth 0 -printf x >/dev/null 2>&1',
        ],
        { stdio: 'ignore' },
      );
    } finally {
      spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
      rmSync(tokenDirectory, { recursive: true, force: true });
    }
  },
);

test('render security is tied to exact stage bytes and rejects root decoys, unsafe services, commands, and secret references', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  assert.doesNotMatch(deploy, /kubectl kustomize "\$destination\/overlay"/);
  assert.match(deploy, /expected_all='\\n---\\n'\.join/);
  assert.match(
    deploy,
    /sha256sum platform\.yaml foundation\.yaml init\.yaml migrate\.yaml apps\.yaml all\.yaml/,
  );
  assert.match(deploy, /assert_validated_render "\$render"/);
  assert.match(deploy, /seen != allowed_files/);
  assert.doesNotMatch(deploy, /allowed_prefix/);

  for (const [mutation, marker] of [
    [
      (root) => {
        const rootKustomization = join(root, 'infra/k8s/overlays/combo-dev/kustomization.yaml');
        writeFileSync(
          rootKustomization,
          'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - platform\n',
        );
        const apps = join(root, 'infra/k8s/overlays/combo-dev/apps/resources.yaml');
        writeFileSync(
          apps,
          readFileSync(apps, 'utf8').replace('  type: ClusterIP\n', '  type: NodePort\n'),
        );
      },
      /guard:forbidden/,
    ],
    [
      (root) => {
        const foundation = join(root, 'infra/k8s/overlays/combo-dev/foundation/resources.yaml');
        writeFileSync(
          foundation,
          readFileSync(foundation, 'utf8').replace(
            '            - redis-server\n            - /usr/local/etc/redis/redis.conf\n',
            '            - sh\n            - -c\n',
          ),
        );
      },
      /guard:command/,
    ],
    [
      (root) => {
        const migrate = join(root, 'infra/k8s/overlays/combo-dev/migrate/resources.yaml');
        writeFileSync(
          migrate,
          readFileSync(migrate, 'utf8').replace('name: combo-dev-env', 'name: other-config'),
        );
      },
      /guard:secret-reference/,
    ],
  ]) {
    const root = fixture();
    try {
      mutation(root);
      expectRenderFailure(root, marker);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('production fingerprint preserves stable object and Pod identities while ignoring only volatile API metadata', () => {
  const safety = text('scripts/combo-dev-production-safety.py');
  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
  ]) {
    assert.match(
      text(scriptPath),
      /combo-dev-production-safety(?:\.py)?"? canonicalize-production/,
    );
    assert.doesNotMatch(text(scriptPath), /images:\s*\[/);
  }
  for (const field of ['"uid"', '"podIP"', '"podIPs"', '"startTime"']) {
    assert.ok(safety.includes(field));
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-fingerprint-'));
  try {
    const base = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'postgres-0',
        namespace: 'combo',
        uid: 'pod-one',
        labels: { app: 'postgres' },
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'StatefulSet',
            name: 'postgres',
            uid: 'owner-one',
            controller: true,
          },
        ],
        resourceVersion: '1',
        creationTimestamp: '2026-01-01T00:00:00Z',
      },
      spec: {
        nodeName: 'node-one',
        containers: [{ name: 'postgres', image: 'postgres@sha256:x' }],
      },
      status: {
        phase: 'Running',
        podIP: '10.42.0.10',
        podIPs: [{ ip: '10.42.0.10' }],
        startTime: '2026-01-01T00:00:10Z',
        containerStatuses: [
          {
            name: 'postgres',
            ready: true,
            restartCount: 0,
            image: 'postgres@sha256:x',
            imageID: 'postgres@sha256:x',
            state: { running: { startedAt: '2026-01-01T00:00:11Z' } },
          },
        ],
      },
    };
    const canonicalize = (name, object) => {
      const input = join(work, `${name}.input.json`);
      const output = join(work, `${name}.output.json`);
      writeFileSync(input, JSON.stringify({ items: [object] }));
      execFileSync(
        'python3',
        [
          join(repo, 'scripts/combo-dev-production-safety.py'),
          'canonicalize-production',
          '--input',
          input,
          '--output',
          output,
        ],
        { stdio: 'ignore' },
      );
      return readFileSync(output, 'utf8');
    };
    const first = canonicalize('first', base);
    const volatile = clone(base);
    volatile.metadata.resourceVersion = '999';
    volatile.metadata.creationTimestamp = '2026-02-02T00:00:00Z';
    assert.equal(sha(first), sha(canonicalize('volatile', volatile)));

    for (const [name, mutate] of [
      ['pod-uid', (value) => (value.metadata.uid = 'pod-two')],
      ['owner-uid', (value) => (value.metadata.ownerReferences[0].uid = 'owner-two')],
      ['pod-ip', (value) => (value.status.podIP = '10.42.0.11')],
      ['pod-start', (value) => (value.status.startTime = '2026-01-02T00:00:10Z')],
      [
        'container-start',
        (value) =>
          (value.status.containerStatuses[0].state.running.startedAt = '2026-01-02T00:00:11Z'),
      ],
    ]) {
      const replaced = clone(base);
      mutate(replaced);
      assert.notEqual(sha(first), sha(canonicalize(name, replaced)), name);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('production observer gate resolves every binding and exact effective rule instead of sampling one permission', () => {
  const safety = text('scripts/combo-dev-production-safety.py');
  const rbac = text('infra/k8s/overlays/combo-dev/platform/rbac.yaml');
  for (const token of [
    'SelfSubjectRulesReview',
    'rolebindings.rbac.authorization.k8s.io',
    'clusterrolebindings.rbac.authorization.k8s.io',
    'observer RBAC contains a wildcard rule',
    'observer has resource access outside production',
    'observer and auditor do not use the same cluster trust',
    'secrets',
    'deletecollection',
  ]) {
    assert.ok(safety.includes(token));
  }
  assert.match(
    rbac,
    /resources: \['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings'\]/,
  );
  assert.match(rbac, /verbs: \['get', 'list'\]/);
  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
  ]) {
    assert.match(text(scriptPath), /verify-observer/);
    assert.doesNotMatch(text(scriptPath), /can_observer_exact/);
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-observer-unit-'));
  try {
    const unit = join(work, 'observer-unit.py');
    writeFileSync(
      unit,
      `import importlib.util
spec=importlib.util.spec_from_file_location('safety', ${JSON.stringify(join(repo, 'scripts/combo-dev-production-safety.py'))})
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def item(kind,name,rules,namespace=None):
    metadata={'name':name}
    if namespace is not None: metadata['namespace']=namespace
    return {'kind':kind,'metadata':metadata,'rules':rules}
production_rules=[
 {'apiGroups':['apps'],'resources':['deployments','statefulsets'],'verbs':['get','list','watch']},
 {'apiGroups':[''],'resources':['services','persistentvolumeclaims','pods'],'verbs':['get','list','watch']},
]
roles={'items':[item('Role','observer',production_rules,'combo')]}
rolebindings={'items':[{'kind':'RoleBinding','metadata':{'name':'observer','namespace':'combo'},'subjects':[{'kind':'User','name':'observer'}],'roleRef':{'kind':'Role','name':'observer'}}]}
clusterroles={'items':[
 item('ClusterRole','basic',[{'apiGroups':['authorization.k8s.io'],'resources':['selfsubjectaccessreviews','selfsubjectrulesreviews'],'verbs':['create']},{'apiGroups':['authentication.k8s.io'],'resources':['selfsubjectreviews'],'verbs':['create']}]),
 item('ClusterRole','discovery',[{'nonResourceURLs':['/api','/apis','/openapi/*','/version'],'verbs':['get']}]),
]}
clusterbindings={'items':[
 {'kind':'ClusterRoleBinding','metadata':{'name':'basic'},'subjects':[{'kind':'Group','name':'system:authenticated'}],'roleRef':{'kind':'ClusterRole','name':'basic'}},
 {'kind':'ClusterRoleBinding','metadata':{'name':'discovery'},'subjects':[{'kind':'Group','name':'system:authenticated'}],'roleRef':{'kind':'ClusterRole','name':'discovery'}},
]}
module.validate_bindings('observer',{'system:authenticated'},'combo',roles,rolebindings,clusterroles,clusterbindings)
over_roles={'items':roles['items']+[item('Role','extra',[{'apiGroups':[''],'resources':['secrets'],'verbs':['get']}],'default')]}
over_bindings={'items':rolebindings['items']+[{'kind':'RoleBinding','metadata':{'name':'extra','namespace':'default'},'subjects':[{'kind':'User','name':'observer'}],'roleRef':{'kind':'Role','name':'extra'}}]}
try:
    module.validate_bindings('observer',{'system:authenticated'},'combo',over_roles,over_bindings,clusterroles,clusterbindings)
except module.SafetyError:
    pass
else:
    raise SystemExit(2)
`,
    );
    const result = spawnSync('python3', [unit], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: 'ignore',
    });
    assert.equal(result.status, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('bootstrap failure injection at every apply and credential boundary leaves forwarders and writers fenced', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  for (const script of [deploy, reset, bootstrap, guard]) {
    assert.match(script, /\/var\/lib\/combo-dev\/writers-fenced/);
  }
  for (const script of [deploy, reset, guard]) {
    assert.match(script, /redis-hot/);
    assert.match(
      script,
      /minio-init migrate combo-dev-network-canary|JOBS=\(minio-init migrate combo-dev-network-canary\)/,
    );
  }
  const bootstrapFence = bootstrap.slice(
    bootstrap.indexOf('fence_all_writers_admin() {'),
    bootstrap.indexOf('credential_certificate_valid_for() {'),
  );
  assert.match(bootstrapFence, /get deployments\.apps,statefulsets\.apps -o name/);
  assert.match(bootstrapFence, /scale "\$controller" --replicas=0/);
  assert.match(bootstrapFence, /for resource in jobs\.batch cronjobs\.batch daemonsets\.apps/);
  assert.match(bootstrapFence, /delete pods --all/);
  assert.doesNotMatch(bootstrapFence, /APP_NAMES|FOUNDATION_STATEFUL/);

  const boundaries = [
    'sanitize-preview',
    'legacy-storage-cleanup',
    'namespace-apply',
    'static-storage-paths',
    'static-storage-bindings',
    'storage-class-apply',
    'static-volumes-apply',
    'rbac-apply',
    'fencer-credential',
    'dispatcher-credential',
    'approval-files',
    'platform-apply',
    'development-secrets',
    'env-secret-apply',
    'registry-secret-apply',
    'control-files-install',
  ];
  const actualBoundaries = [...bootstrap.matchAll(/bootstrap_boundary ([a-z][a-z0-9-]+)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(actualBoundaries)].sort(), [...boundaries].sort());
  const mainBody = bootstrap.slice(bootstrap.lastIndexOf('\nmain() {'));
  for (const readOnlyStep of [
    'host_preflight',
    'validate_config_names_only',
    'verify_observer_boundary',
    'before=$(production_fingerprint)',
    'prepare_cluster_platform_contract',
    'classify_preview_storage_admin',
  ]) {
    assert.ok(
      mainBody.indexOf(readOnlyStep) < mainBody.indexOf('bootstrap_mutations'),
      readOnlyStep,
    );
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-bootstrap-failure-'));
  try {
    const harness = `
source ${JSON.stringify(join(repo, 'scripts/combo-dev-bootstrap.sh'))}
status() { :; }
record() { printf '%s\\n' "$1" >>"$TEST_LOG"; }
mark_failure_fence() { record marker; }
stop_forwarders() { record forwarders; }
forwarders_stopped() { return 0; }
fence_all_writers_admin() { record writers; }
bootstrap_boundary() {
  local boundary=$1
  shift
  record "boundary:$boundary"
  [[ "$boundary" != "$FAIL_AT" ]] || return 71
  "$@"
}
fake_kubectl() { return 0; }
AK=(fake_kubectl)
sanitize_preview_namespace() { return 0; }
cleanup_legacy_preview_storage_admin() { return 0; }
prepare_static_storage_paths() { return 0; }
check_static_storage_guard() { return 0; }
install_static_storage_bindings_admin() {
  bootstrap_boundary storage-class-apply true || return
  bootstrap_boundary static-volumes-apply true || return
}
provision_fencer_credential() { return 0; }
provision_dispatcher_credential() { return 0; }
write_bootstrap_approvals() { return 0; }
dispatcher_credential_valid() { return 0; }
fencer_credential_valid() { return 0; }
static_storage_is_valid_admin() { return 0; }
verify_cluster_platform_admin() { return 0; }
provision_secrets() {
  bootstrap_boundary env-secret-apply true || return
  bootstrap_boundary registry-secret-apply true || return
  bootstrap_boundary session-credential-file true || return
  bootstrap_boundary session-secret-apply true || return
}
install_control_files() { return 0; }
WORK=''
bootstrap_mutations
`;
    for (const boundary of boundaries) {
      const log = join(work, `${boundary}.log`);
      const result = spawnSync('bash', ['-c', harness], {
        env: { ...process.env, FAIL_AT: boundary, TEST_LOG: log },
        stdio: 'ignore',
      });
      assert.notEqual(result.status, 0, boundary);
      const events = readFileSync(log, 'utf8').trim().split('\n');
      const firstBoundary = events.findIndex((event) => event.startsWith('boundary:'));
      assert.deepEqual(
        events.slice(0, firstBoundary),
        ['marker', 'forwarders', 'writers'],
        boundary,
      );
      assert.ok(events.includes(`boundary:${boundary}`), boundary);
      assert.ok(events.lastIndexOf('marker') > firstBoundary, boundary);
      assert.ok(events.lastIndexOf('forwarders') > firstBoundary, boundary);
      assert.ok(events.lastIndexOf('writers') > firstBoundary, boundary);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  assert.match(deploy, /fence_all_writers_cleanup/);
  assert.match(deploy, /run_pre_app_storage[\s\S]*rm -f -- "\$FAILURE_FENCE_MARKER"/);
  assert.match(
    deploy,
    /flock -w 300 8[\s\S]*verify_writers_restored[\s\S]*rm -f -- "\$FAILURE_FENCE_MARKER"/,
  );
  assert.match(reset, /combo-dev-smoke --storage-only[\s\S]*fence_all_writers \|\| blocked/);
  assert.doesNotMatch(reset, /rm -f -- "\$FAILURE_FENCE_MARKER"/);
  assert.match(guard, /verify_writers_fenced/);
});

test('first bootstrap tolerates absent forwarder units and serializes the persistent storage guard', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const stopBody = bootstrap.slice(
    bootstrap.indexOf('stop_forwarders() {'),
    bootstrap.indexOf('cleanup() {'),
  );
  assert.match(
    stopBody,
    /systemctl stop combo-dev-web-forward\.service combo-dev-s3-forward\.service[^\n]*\|\| true/,
  );
  assert.ok(stopBody.indexOf('systemctl stop') < stopBody.indexOf('forwarders_stopped'));

  const installBody = bootstrap.slice(
    bootstrap.indexOf('install_control_files() {'),
    bootstrap.indexOf('production_fingerprint() {'),
  );
  const timerStop = installBody.indexOf('systemctl disable --now combo-dev-storage-guard.timer');
  const firstCheck = installBody.indexOf('systemctl start combo-dev-storage-guard.service');
  const timerStart = installBody.indexOf('systemctl enable --now combo-dev-storage-guard.timer');
  assert.ok(timerStop >= 0);
  assert.ok(timerStop < firstCheck);
  assert.ok(firstCheck < timerStart);
  assert.match(
    bootstrap,
    /bootstrap_boundary platform-apply "\$\{AK\[@\]\}" apply --server-side[\s\S]*--field-manager=combo-dev-dispatcher --force-conflicts/,
  );
});

test('post-deploy acceptance is TTL-bound and failure fencing cannot mint a replay proof', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');

  assert.match(deploy, /ACCEPTANCE_PENDING_SECONDS=7200/);
  assert.match(
    deploy,
    /consume_reset_proof[\s\S]*clear_stale_acceptance_state "\$revision" "\$workflow_run_id" "\$workflow_run_attempt"/,
  );
  const staleState = deploy.slice(
    deploy.indexOf('clear_stale_acceptance_state() {'),
    deploy.indexOf('apply_foundation_replicas() {'),
  );
  assert.match(staleState, /flock -w 300 8/);
  assert.match(
    staleState,
    /"attempt \$revision \$workflow_run_id \$workflow_run_attempt"[\s\S]*return 2/,
  );
  assert.match(staleState, /\^attempt\\ \[0-9a-f\]\{40\}/);
  assert.match(
    deploy,
    /flock -w 300 8[\s\S]*\[\[ ! -e "\$EXTERNAL_FENCE_MARKER" && ! -L "\$EXTERNAL_FENCE_MARKER" \]\][\s\S]*write_acceptance_pending[\s\S]*rm -f -- "\$FAILURE_FENCE_MARKER"/,
  );
  assert.match(guard, /--fence-attempt\)/);
  assert.match(guard, /fence_now '受控 Test 后置验收未完成' 0 0/);
  assert.match(guard, /mark_failure_fence[\s\S]*mark_external_fence/);
  assert.match(guard, /existing_attempt_fence_identity\(\)[\s\S]*\^attempt\\ \[0-9a-f\]\{40\}/);
  assert.match(
    guard,
    /fence_now\(\)[\s\S]*flock -w 300 8[\s\S]*identity" == preserve-attempt[\s\S]*existing_attempt_fence_identity/,
  );
  assert.match(
    guard,
    /FAILURE_FENCE_MARKER[\s\S]*fence_now '持久失败阻断标记仍然存在' 0 0 preserve-attempt/,
  );
  assert.match(
    guard,
    /ACCEPTANCE_PENDING_MARKER[\s\S]*flock -w 300 8[\s\S]*pending_acceptance_state[\s\S]*fence_now_locked 'Test 后置验收超过固定期限'/,
  );
  assert.match(
    guard,
    /complete_acceptance[\s\S]*marker_run_id[\s\S]*marker_run_attempt[\s\S]*rm -f -- "\$ACCEPTANCE_PENDING_MARKER"/,
  );
  assert.doesNotMatch(guard, /reset-proof|RESET_PROOF|wipe_static_volume_data/);
  assert.doesNotMatch(reset, /EXTERNAL_FENCE_MARKER|ACCEPTANCE_PENDING_MARKER/);
  const failureFence = workflow.slice(
    workflow.indexOf('Fence Test after post-deploy acceptance failure'),
    workflow.indexOf('Remove transient runner and upload files'),
  );
  assert.match(failureFence, /--fence-attempt "\$REVISION" "\$RUN_ID" "\$RUN_ATTEMPT"/);
  assert.doesNotMatch(failureFence, /combo-dev-reset|DESTROY-COMBO-PREVIEW-DATA/);
});

test('the always-on host guard uses an independent minimal fencer for missing, malformed, expiring, or unauthorized dispatcher credentials', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  const unit = text('infra/host/combo-dev/combo-dev-storage-guard.service');
  const rbac = text('infra/k8s/overlays/combo-dev/platform/rbac.yaml');
  const lease = text('scripts/combo-dev-forwarder-lease.sh');
  assert.match(bootstrap, /issue_client_credential combo-dev-dispatcher 90/);
  assert.match(bootstrap, /issue_client_credential combo-dev-fencer 365/);
  assert.match(bootstrap, /provision_fencer_credential[\s\S]*provision_dispatcher_credential/);
  assert.match(deploy, /DISPATCHER_OPERATION_MIN_SECONDS=\$\(\(4 \* 60 \* 60\)\)/);
  for (const script of [deploy, reset, guard]) {
    assert.match(script, /DISPATCHER_FENCE_BEFORE_SECONDS=\$\(\(7 \* 24 \* 60 \* 60\)\)/);
  }
  assert.doesNotMatch(unit, /ConditionPathExists/);
  assert.match(unit, /^ProtectHome=read-only$/m);
  assert.match(
    unit,
    /^ReadWritePaths=\/run \/var\/lib\/combo-dev \/home\/xingzheng\/data\/combo-dev$/m,
  );
  assert.doesNotMatch(unit, /ReadWritePaths=.* \/home\/xingzheng\/data(?:\s|$)/m);
  const fencerRoleStart = rbac.indexOf('kind: Role\nmetadata:\n  name: combo-dev-fencer');
  const fencerRoleEnd = rbac.indexOf('\n---', fencerRoleStart);
  assert.ok(fencerRoleStart >= 0);
  assert.ok(fencerRoleEnd > fencerRoleStart);
  const fencerRole = rbac.slice(fencerRoleStart, fencerRoleEnd);
  assert.match(
    fencerRole,
    /resources: \['deployments'\]\n {4}resourceNames: \['api', 'worker', 'runtime', 'web', 'redis-hot'\]\n {4}verbs: \['get'\]/,
  );
  assert.match(
    fencerRole,
    /resources: \['deployments\/scale'\]\n {4}resourceNames: \['api', 'worker', 'runtime', 'web', 'redis-hot'\]\n {4}verbs: \['patch'\]/,
  );
  assert.match(
    fencerRole,
    /resources: \['statefulsets'\]\n {4}resourceNames: \['postgres', 'redis-queue', 'minio'\]\n {4}verbs: \['get'\]/,
  );
  assert.match(
    fencerRole,
    /resources: \['statefulsets\/scale'\]\n {4}resourceNames: \['postgres', 'redis-queue', 'minio'\]\n {4}verbs: \['patch'\]/,
  );
  assert.equal(fencerRole.match(/\/scale/g)?.length, 2);
  assert.equal(fencerRole.match(/'patch'/g)?.length, 2);
  assert.doesNotMatch(fencerRole, /verbs: \[[^\]]*(?:create|update)[^\]]*\]/);
  assert.doesNotMatch(
    fencerRole,
    /resources: \['(?:deployments|statefulsets)'\]\n {4}resourceNames: [^\n]+\n {4}verbs: \[[^\]\n]*patch[^\]\n]*\]/,
  );
  for (const script of [bootstrap, guard]) {
    const canI = script.slice(
      script.indexOf(script === bootstrap ? 'can_i_with_credential() {' : 'can_i() {'),
      script.indexOf(
        script === bootstrap ? 'trusted_source_tree() {' : 'dispatcher_access_valid() {',
      ),
    );
    assert.match(canI, /--subresource="\$subresource"/);
    const fencerChecks = script.slice(
      script.indexOf(
        script === bootstrap ? 'fencer_credential_valid() {' : 'fencer_access_valid() {',
      ),
      script.indexOf(
        script === bootstrap ? 'issue_client_credential() {' : 'mark_failure_fence() {',
      ),
    );
    assert.match(fencerChecks, /yes patch "deployments\.apps\/\$name" "\$NAMESPACE" scale/);
    assert.match(fencerChecks, /yes patch "statefulsets\.apps\/\$name" "\$NAMESPACE" scale/);
    assert.match(fencerChecks, /no patch deployments\.apps\/api "\$NAMESPACE"/);
    assert.match(fencerChecks, /no update deployments\.apps\/api "\$NAMESPACE" scale/);
    assert.match(fencerChecks, /no patch deployments\.apps\/api "\$PRODUCTION_NAMESPACE" scale/);
  }
  assert.match(lease, /FAILURE_FENCE_MARKER/);

  const fenceBody = guard.slice(
    guard.indexOf('fence_now_locked() {'),
    guard.indexOf('fence_now() {'),
  );
  assert.ok(fenceBody.indexOf('stop_forwarders') < fenceBody.indexOf('mark_failure_fence'));
  assert.ok(
    fenceBody.indexOf('mark_failure_fence') <
      fenceBody.indexOf('credential_certificate_valid_for "$FENCER_KUBECONFIG"'),
  );
  assert.ok(
    fenceBody.indexOf('credential_certificate_valid_for "$FENCER_KUBECONFIG"') <
      fenceBody.indexOf('fence_writers_with_minimal_credential'),
  );
  for (const message of ['调度凭据缺失、损坏或进入预到期窗口', '调度凭据已失效或权限发生漂移']) {
    assert.ok(guard.includes(message));
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-credential-guard-'));
  try {
    const caKey = join(work, 'ca.key');
    const caCert = join(work, 'ca.crt');
    const key = join(work, 'client.key');
    const request = join(work, 'client.csr');
    const expiring = join(work, 'expiring.crt');
    for (const args of [
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=test-ca',
        '-keyout',
        caKey,
        '-out',
        caCert,
      ],
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=combo-dev-dispatcher',
        '-keyout',
        key,
        '-out',
        request,
      ],
      [
        'x509',
        '-req',
        '-in',
        request,
        '-CA',
        caCert,
        '-CAkey',
        caKey,
        '-set_serial',
        '2',
        '-days',
        '1',
        '-out',
        expiring,
      ],
    ]) {
      execFileSync('openssl', args, { stdio: 'ignore' });
    }
    const kubeconfig = (certificate) =>
      `apiVersion: v1\nkind: Config\nclusters:\n- name: k3s\n  cluster:\n    server: https://127.0.0.1:6443\n    certificate-authority-data: ${readFileSync(caCert).toString('base64')}\nusers:\n- name: combo-dev-dispatcher\n  user:\n    client-certificate-data: ${readFileSync(certificate).toString('base64')}\n    client-key-data: ${readFileSync(key).toString('base64')}\ncontexts:\n- name: combo-dev\n  context:\n    cluster: k3s\n    user: combo-dev-dispatcher\ncurrent-context: combo-dev\n`;
    const expiringConfig = join(work, 'expiring.kubeconfig');
    const malformedConfig = join(work, 'malformed.kubeconfig');
    writeFileSync(expiringConfig, kubeconfig(expiring), { mode: 0o600 });
    writeFileSync(malformedConfig, 'not: [valid\n', { mode: 0o600 });
    const guardPath = join(repo, 'scripts/combo-dev-storage-guard.sh');
    const credentialHarness = (path) => `
source ${JSON.stringify(guardPath)}
private_file() { [[ -f "$1" ]]; }
credential_certificate_valid_for ${JSON.stringify(path)} combo-dev-dispatcher $((2 * 24 * 60 * 60))
`;
    for (const path of [join(work, 'missing.kubeconfig'), malformedConfig, expiringConfig]) {
      assert.notEqual(
        spawnSync('bash', ['-c', credentialHarness(path)], { stdio: 'ignore' }).status,
        0,
      );
    }
    const unauthorized = spawnSync(
      'bash',
      ['-c', `source ${JSON.stringify(guardPath)}; can_i() { return 1; }; dispatcher_access_valid`],
      { stdio: 'ignore' },
    );
    assert.notEqual(unauthorized.status, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('log audit retries delayed activity without weakening its fixed evidence set', () => {
  const result = runLogsAuditFixture('delayed');
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.match(result.stdout, /PASS sources=8 activity=3 redaction=PASS/);
  assert.equal((result.invocations.match(/logs worker-pod/g) ?? []).length, 2);
});

test('pre-artifact log baseline accepts an idle Worker while retaining all-source leak scans', () => {
  const result = runLogsAuditFixture('missing', 'baseline');
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.match(result.stdout, /PASS sources=8 activity=baseline redaction=PASS/);
  for (const app of [
    'api',
    'worker',
    'runtime',
    'web',
    'postgres',
    'redis-queue',
    'redis-hot',
    'minio',
  ]) {
    assert.match(result.invocations, new RegExp(`logs ${app}-pod`));
  }
});

test('log audit includes one bounded previous container after dependency recovery', () => {
  const result = runLogsAuditFixture('previous');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.invocations, /logs worker-pod -c worker --previous/);
  assert.match(result.stdout, /PASS sources=8 activity=3 redaction=PASS/);
});

test('log audit retries when container state changes during capture', () => {
  const result = runLogsAuditFixture('restart-race');
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.match(result.invocations, /logs worker-pod -c worker --previous/);
  assert.match(result.stdout, /PASS sources=8 activity=3 redaction=PASS/);
});

test('log audit remains blocked with a safe reason when activity never appears', () => {
  const result = runLogsAuditFixture('missing');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[combo-dev-logs\] BLOCKED: reason=worker-activity-missing\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /worker ready/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(result.markerValue));
});

test('log audit rejects restart history that cannot be covered by current and previous logs', () => {
  const result = runLogsAuditFixture('restart-multiple');
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /^\[combo-dev-logs\] BLOCKED: reason=source-worker-restart-history-out-of-range\n$/,
  );
  assert.doesNotMatch(result.invocations, /logs worker-pod/);
});

test('log audit blocks when its bounded combined corpus cannot be written', () => {
  const result = runLogsAuditFixture('cat-fail');
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /^\[combo-dev-logs\] BLOCKED: reason=source-minio-combined-log-unwritable\n$/,
  );
});

test('log audit blocks when its credential corpus cannot be searched', () => {
  const result = runLogsAuditFixture('grep-fail');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[combo-dev-logs\] BLOCKED: reason=log-corpus-unreadable\n$/);
});

test('log audit has a wall-clock deadline and blocks bounded corpus truncation', () => {
  const logs = text('scripts/combo-dev-logs.sh');
  assert.match(logs, /readonly AUDIT_MAX_SECONDS=90/);
  assert.match(logs, /AUDIT_DEADLINE_EPOCH=\$\(\(now \+ AUDIT_MAX_SECONDS\)\)/);
  assert.match(logs, /readonly LOG_CAPTURE_BYTES=8388609/);
  assert.match(logs, /head -c "\$LOG_CAPTURE_BYTES"/);
  assert.match(logs, /size < LOG_CAPTURE_BYTES/);
  assert.doesNotMatch(logs, /--tail=/);
  assert.doesNotMatch(logs, /--limit-bytes/);
  assert.match(logs, /retryable_reason\(\)/);
  assert.doesNotMatch(
    logs.slice(logs.indexOf('retryable_reason() {'), logs.indexOf('collect_snapshot() {')),
    /restart-history-out-of-range|log-corpus-unreadable|log-truncated/,
  );
});

test('log audit blocks when client-side capture reaches its hard byte boundary', () => {
  const result = runLogsAuditFixture('truncated');
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /^\[combo-dev-logs\] BLOCKED: reason=source-api-current-log-truncated\n$/,
  );
});

test('log audit fails immediately without echoing a detected marker', () => {
  const result = runLogsAuditFixture('leak');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\[combo-dev-logs\] FAIL: reason=synthetic-marker-detected\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(result.markerValue));
});

test('log audit scans previous container logs without echoing a detected marker', () => {
  const result = runLogsAuditFixture('previous-leak');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\[combo-dev-logs\] FAIL: reason=synthetic-marker-detected\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(result.markerValue));
});

test('log audit rejects credential patterns without echoing their payload', () => {
  const result = runLogsAuditFixture('credential');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\[combo-dev-logs\] FAIL: reason=credential-pattern-detected\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /TEST_SECRET_TOKEN/);
});

test('log audit cannot discard an early leak when a later source is unavailable', () => {
  const result = runLogsAuditFixture('leak-then-source-fail');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\[combo-dev-logs\] FAIL: reason=synthetic-marker-detected\n$/);
  assert.doesNotMatch(result.invocations, /logs runtime-pod/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(result.markerValue));
});

test('smoke exposes only allowlisted log-audit reason codes', () => {
  const smoke = text('scripts/combo-dev-smoke.sh');
  const start = smoke.indexOf('check_logs_fail_closed() {');
  const end = smoke.indexOf('\n}\n\nmain() {', start);
  assert.ok(start > 0 && end > start);
  const check = smoke.slice(start, end);
  assert.match(check, /log-audit\.status/);
  assert.match(check, /chmod 600 "\$diagnostic"/);
  assert.match(check, /diagnostic_line" =~ \^\\\[combo-dev-logs\\\]/);
  assert.match(check, /reason=\(\[a-z0-9-\]\{1,80\}\)/);
  assert.match(check, /DETAIL: log-audit=%s/);
  assert.doesNotMatch(check, /combo-dev-logs[\s\S]*>\/dev\/null 2>&1/);
});

test('smoke blocks before log audit when a synthetic activity probe is not delivered', () => {
  const result = runSmokeLogProbeFixture('transport');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[fixture\] BLOCKED: API 合成日志活动探针未送达。\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /aaaaaaaaaaaaaaaa/);
});

test('smoke requires the synthetic activity probe to reach the exact 404 route', () => {
  const result = runSmokeLogProbeFixture('wrong-status');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[fixture\] BLOCKED: API 合成日志活动探针未返回预期终态。\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /aaaaaaaaaaaaaaaa/);
});

test('listener validation rejects every additional IPv4 or IPv6 address and wrong owning process', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  for (const script of [deploy, smoke]) {
    assert.match(script, /ss -H -ltnp/);
    assert.match(script, /systemctl show combo-dev-web-forward\.service -p MainPID/);
    assert.match(script, /validate-listeners/);
  }
  assert.match(
    deploy,
    /wait_loopback_listeners\(\) \{[\s\S]*for \(\(attempt = 1; attempt <= 30; attempt\+\+\)\)/,
  );
  assert.match(
    deploy,
    /systemctl start combo-dev-s3-forward\.service[\s\S]*wait_loopback_listeners/,
  );
  assert.match(deploy, /validate-listeners[\s\S]*\|\| return 1/);
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-listeners-'));
  try {
    const input = join(work, 'listeners');
    const line = (address, port, pid) =>
      `LISTEN 0 4096 ${address}:${port} 0.0.0.0:* users:(("kubectl",pid=${pid},fd=7))`;
    const base = [line('127.0.0.1', 18080, 111), line('127.0.0.1', 19000, 222)];
    const check = (lines) => {
      writeFileSync(input, `${lines.join('\n')}\n`);
      return spawnSync(
        'python3',
        [
          join(repo, 'scripts/combo-dev-production-safety.py'),
          'validate-listeners',
          '--input',
          input,
          '--web-pid',
          '111',
          '--s3-pid',
          '222',
        ],
        { stdio: 'ignore' },
      ).status;
    };
    assert.equal(check(base), 0);
    for (const extra of [
      line('192.0.2.25', 18080, 333),
      line('[2001:db8::25]', 18080, 333),
      line('0.0.0.0', 19000, 333),
      line('[::]', 19000, 333),
      line('[::1]', 19000, 333),
    ]) {
      assert.notEqual(check([...base, extra]), 0, extra);
    }
    assert.notEqual(check([line('127.0.0.1', 18080, 999), base[1]]), 0);
    assert.notEqual(check([base[0]]), 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('network canary uses a pinned deterministic TCP probe and proves its positive control before denied targets', () => {
  const smoke = text('scripts/combo-dev-smoke.sh');
  assert.match(
    smoke,
    /python@sha256:37b14db89f587f9eaa890e4a442a3fe55db452b69cca1403cc730bd0fbdc8aaf/,
  );
  assert.doesNotMatch(smoke, /\bnc\s+-z\b/);
  assert.doesNotMatch(
    smoke.slice(
      smoke.indexOf('run_network_canary() {'),
      smoke.indexOf('check_logs_fail_closed() {'),
    ),
    /hostPath:/,
  );
  const start = smoke.indexOf('              import os');
  const end = smoke.indexOf('              # The Web Service is SHA-scoped.', start);
  assert.ok(start > 0 && end > start);
  assert.match(smoke, /production_service = "release-postgres\.combo\.svc\.cluster\.local"/);
  assert.match(smoke, /\(production_service, 5432\)/);
  assert.doesNotMatch(smoke, /web\.combo\.svc\.cluster\.local/);
  const positiveControl = smoke
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/^ {14}/, ''))
    .join('\n');
  assert.ok(
    positiveControl.indexOf('probe("127.0.0.1", control_port)') <
      positiveControl.indexOf('control.close()'),
  );
  assert.equal(spawnSync('python3', ['-c', positiveControl], { stdio: 'ignore' }).status, 0);
  const brokenProbe = positiveControl.replace(
    'if connection.connect_ex(address) == 0:',
    'if False:',
  );
  assert.equal(spawnSync('python3', ['-c', brokenProbe], { stdio: 'ignore' }).status, 3);
  if (dockerAvailable) {
    assert.equal(
      spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--read-only',
          '--user',
          '65534:65534',
          'python@sha256:37b14db89f587f9eaa890e4a442a3fe55db452b69cca1403cc730bd0fbdc8aaf',
          'python3',
          '-c',
          positiveControl,
        ],
        { stdio: 'ignore' },
      ).status,
      0,
    );
  }
});

test('combo-dev nginx consumes the exact client-events route without proxying or logging its body', () => {
  const nginx = text('infra/k8s/overlays/combo-dev/apps/nginx-dev.conf');
  const match = nginx.match(/location = \/api\/v1\/client-events \{([\s\S]*?)\n {2}\}/);
  assert.ok(match);
  assert.match(match[1], /access_log off;/);
  assert.match(match[1], /return 204;/);
  assert.match(match[1], /Cache-Control "no-store"/);
  assert.doesNotMatch(match[1], /proxy_pass|\$request_body/);
  assert.equal((nginx.match(/\/api\/v1\/client-events/g) ?? []).length, 1);

  const root = fixture();
  try {
    const path = join(root, 'infra/k8s/overlays/combo-dev/apps/nginx-dev.conf');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        '    return 204;',
        '    proxy_pass http://$api_host:3000;',
      ),
    );
    expectRenderFailure(root, /guard:telemetry-boundary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Test prunes only stale Web and release metadata after proving every live reference', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const start = deploy.indexOf('prune_stale_configs() {');
  const end = deploy.indexOf('\ncheck_loopback_listeners_once() {', start);
  assert.ok(start > 0 && end > start);
  const prune = deploy.slice(start, end);
  assert.match(prune, /get deployment "\$\{APP_NAMES\[@\]\}" -o json/);
  assert.match(
    prune,
    /\(\[\.\[\]\.metadata\.name\] \| sort\) != \["api", "runtime", "web", "worker"\]/,
  );
  assert.match(prune, /\(\$release_refs \| unique \| length\) != 1/);
  assert.match(prune, /\^combo-release-meta-\[0-9a-f\]\{12\}\$/);
  assert.match(prune, /\^combo-dev-nginx-\[a-z0-9\]\+\$/);
  assert.match(
    prune,
    /get configmaps -l combo\.dev\/environment=combo-dev -o json[\s\S]*stale_json=/,
  );
  assert.match(prune, /delete "configmap\/\$name" --wait=false/);
  assert.doesNotMatch(prune, /delete "\$item"/);
  assert.ok(prune.indexOf('live_refs=$(') < prune.indexOf('listed=$('));
  assert.ok(prune.indexOf('stale_json=$(') < prune.indexOf('delete "configmap/$name"'));

  const flow = deploy.slice(deploy.indexOf('  MUTATING=1'));
  assert.ok(flow.indexOf('wait_apps ') < flow.indexOf('prune_stale_configs'));
  assert.ok(
    flow.indexOf('prune_stale_configs') <
      flow.indexOf('systemctl start combo-dev-web-forward.service'),
  );
  assert.match(deploy.slice(0, deploy.indexOf('host_preflight() {')), /fence_all_writers_cleanup/);
});

test('Test, Preview, and Production serialize only deploy jobs and preserve promotion trust', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const ci = text('.github/workflows/ci.yml');
  const testDeploy = text('scripts/combo-dev-deploy.sh');
  const preview = text('.github/workflows/preview.yml');
  const production = text('.github/workflows/cd.yml');
  const deployGroup = (value) =>
    value.match(
      /^ {4}concurrency:\n {6}group: ([^\n]+)\n {6}queue: ([^\n]+)\n {6}cancel-in-progress: ([^\n]+)$/m,
    );
  for (const delivery of [workflow, preview, production]) {
    const group = deployGroup(delivery);
    assert.ok(group);
    assert.equal(group[1], 'cd-tecent2');
    assert.equal(group[2], 'max');
    assert.equal(group[3], 'false');
    assert.doesNotMatch(delivery, /^concurrency:/m);
  }

  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  const triggers = workflow.slice(workflow.indexOf('on:\n'), workflow.indexOf('\npermissions:'));
  const productionTriggers = production.slice(
    production.indexOf('on:\n'),
    production.indexOf('\npermissions:'),
  );
  assert.match(triggers, /^ {2}workflow_run:/m);
  assert.match(triggers, /workflows: \[CI\]/);
  assert.match(triggers, /types: \[completed\]/);
  assert.match(triggers, /branches: \[main\]/);
  assert.match(triggers, /^ {2}workflow_dispatch:/m);
  assert.match(productionTriggers, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(productionTriggers, /workflow_run|push:|pull_request:/);
  assert.match(preview, /^ {2}workflow_run:/m);
  assert.match(preview, /branches: \[main\]/);
  assert.match(preview, /COMBO_PREVIEW_AUTO_PROMOTION_MODE/);
  assert.match(
    workflow,
    /source_branch:[\s\S]*required: true[\s\S]*revision:[\s\S]*required: true/,
  );
  assert.match(workflow, /INPUT_SOURCE_BRANCH: \$\{\{ inputs\.source_branch \}\}/);
  assert.match(workflow, /INPUT_REVISION: \$\{\{ inputs\.revision \}\}/);
  assert.match(
    workflow,
    /for candidate in "\$ACTOR" "\$TRIGGERING_ACTOR"; do[\s\S]*collaborators\/\$\{candidate\}\/permission[\s\S]*admin:\*\|write:\*\|\*:maintain/,
  );
  assert.match(workflow, /git check-ref-format "refs\/heads\/\$INPUT_SOURCE_BRANCH"/);
  assert.match(workflow, /\[\[ "\$INPUT_REVISION" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(
    workflow,
    /git\/ref\/heads\/\$\{encoded_branch\}[\s\S]*\[\[ "\$branch_sha" == "\$INPUT_REVISION" \]\]/,
  );
  assert.match(
    workflow,
    /git\/commits\/\$\{INPUT_REVISION\}"[\s\\\n]*--jq '\.sha' \| grep -Fx "\$INPUT_REVISION"/,
  );
  assert.match(production, /REVISION: \$\{\{ inputs\.revision \}\}/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(production, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(production, /compare\/\$\{REVISION\}\.\.\.main/);
  const productionCleanup = production.slice(
    production.indexOf('      - name: Remove transient SSH and bundle files'),
  );
  for (const remotePath of [
    'data/combo-release-incoming/${REVISION}.journal-audit.${RUN_ID}.${RUN_ATTEMPT}.mjs',
    '.${REVISION}.journal-audit.${RUN_ID}.${RUN_ATTEMPT}.upload',
  ]) {
    assert.ok(
      productionCleanup.includes(remotePath),
      `Production always-cleanup must remove ${remotePath}`,
    );
  }
  assert.match(
    workflow,
    /build_branch_release:[\s\S]*if: needs\.select\.outputs\.source_mode == 'branch-build'[\s\S]*packages: write[\s\S]*uses: \.\/\.github\/workflows\/ci\.yml[\s\S]*revision: \$\{\{ needs\.select\.outputs\.revision \}\}[\s\S]*publish_release: true/,
  );
  assert.doesNotMatch(
    workflow.slice(
      workflow.indexOf('\n  build_branch_release:'),
      workflow.indexOf('\n  authorize:'),
    ),
    /secrets:\s*inherit/,
  );
  assert.match(ci, /^ {2}workflow_call:/m);
  assert.match(
    ci,
    /workflow_call:[\s\S]*revision:[\s\S]*required: true[\s\S]*publish_release:[\s\S]*required: true/,
  );
  assert.match(workflow, /\[\[ "\$WORKFLOW_REF" == refs\/heads\/main \]\]/);
  assert.match(workflow, /\[\[ "\$remote_main" == "\$CONTROLLER_SHA" \]\]/);
  assert.match(
    workflow,
    /Check out the trusted main Test controller[\s\S]*ref: \$\{\{ needs\.authorize\.outputs\.controller_sha \}\}/,
  );
  const privilegedDeploy = workflow.slice(workflow.indexOf('\n  deploy:'));
  assert.match(privilegedDeploy, /environment: combo-dev/);
  assert.doesNotMatch(
    privilegedDeploy,
    /ref: \$\{\{ needs\.(?:select|authorize)\.outputs\.revision \}\}/,
  );
  assert.doesNotMatch(privilegedDeploy, /\$RELEASE_ROOT\/(?:scripts|acceptance|infra)\//);
  assert.match(privilegedDeploy, /bash scripts\/combo-dev-deploy\.sh --render-only/);
  assert.match(privilegedDeploy, /runner=scripts\/goal-b-test-acceptance\.mjs/);
  assert.match(privilegedDeploy, /resend_reader=scripts\/resend-sent-email\.mjs/);
  assert.match(privilegedDeploy, /validator=scripts\/promotion-evidence\.mjs/);

  assert.match(workflow, /repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{SOURCE_CI_RUN_ID\}/);
  assert.match(workflow, /\.path == "\.github\/workflows\/ci\.yml"/);
  assert.match(workflow, /\.event == "push"/);
  assert.match(workflow, /\.head_branch == "main"/);
  assert.match(workflow, /\.head_sha == \$revision/);
  assert.match(workflow, /\.status == "completed"/);
  assert.match(workflow, /\.conclusion == "success"/);
  assert.match(workflow, /\.repository\.full_name == \$repository/);
  assert.match(workflow, /\.head_repository\.full_name == \$repository/);
  assert.match(
    workflow,
    /branch-build\)[\s\S]*\[\[ "\$SOURCE_CI_RUN_ID" == "\$GITHUB_RUN_ID" \]\][\s\S]*\[\[ "\$SOURCE_CI_RUN_ATTEMPT" == "\$GITHUB_RUN_ATTEMPT" \]\]/,
  );
  assert.match(
    workflow,
    /artifact_release_job='build the exact branch Test artifact \/ assemble immutable release artifact'/,
  );
  assert.match(workflow, /image_job_prefix='build the exact branch Test artifact \/ '/);
  assert.match(
    workflow,
    /artifacts\?per_page=100&name=\$\{artifact_name\}/,
    'Test must resolve only the named release artifact from the selected producer run',
  );
  assert.match(workflow, /\.total_count == 1/);
  assert.match(workflow, /\$matches\[0\]\.expired == false/);
  assert.match(workflow, /\$matches\[0\]\.digest \| test\("\^sha256:/);
  assert.match(workflow, /\$matches\[0\]\.workflow_run\.id == \$runId/);
  assert.match(workflow, /\$matches\[0\]\.workflow_run\.head_sha == \$headSha/);
  assert.match(
    workflow,
    /actions\/runs\/\$\{SOURCE_CI_RUN_ID\}\/attempts\/\$\{SOURCE_CI_RUN_ATTEMPT\}\/jobs/,
  );
  assert.match(workflow, /\.name == \$releaseJob/);
  assert.match(workflow, /\$releaseJobs\[0\]\.started_at <= \$artifactCreatedAt/);
  assert.match(workflow, /\$artifactCreatedAt <= \$releaseJobs\[0\]\.completed_at/);
  assert.match(workflow, /for key in api runtime web; do/);
  assert.match(
    workflow,
    /image_artifact_name="combo-image-digest-\$\{REVISION\}-\$\{SOURCE_CI_RUN_ATTEMPT\}-\$\{key\}"/,
  );
  assert.match(workflow, /image_job="\$\{image_job_prefix\}image \/ \$\{key\}"/);
  assert.match(workflow, /\(\$imageJobs \| length\) == 1/);
  assert.match(workflow, /actions\/artifacts\/\$\{image_artifact_id\}\/zip/);
  assert.match(workflow, /sha256sum "\$image_archive"[\s\S]*==[\s\\\n]*"\$image_artifact_digest"/);
  assert.match(workflow, /\[\[ "\$\{image_archive_paths\[0\]\}" == "\$\{key\}\.image" \]\]/);
  for (const key of ['api', 'runtime', 'web']) {
    assert.ok(
      workflow.includes(`--arg ${key}Image "$(<"$digest_root/${key}.image")"`),
      `release manifest must bind the exact ${key} digest artifact`,
    );
  }
  assert.match(
    workflow,
    /\.images == \{[\s\S]*api: \$apiImage,[\s\S]*runtime: \$runtimeImage,[\s\S]*web: \$webImage/,
  );
  assert.match(
    workflow,
    /actions\/artifacts\/\$\{RELEASE_ARTIFACT_ID\}\/zip/,
    'Test must download the exact artifact ID selected from the producer run',
  );
  assert.match(
    workflow,
    /\[\[ "\$actual_artifact_digest" == "\$RELEASE_ARTIFACT_DIGEST" \]\]/,
    'Test must fail when the downloaded archive differs from its GitHub artifact digest',
  );
  assert.match(workflow, /needs: authorize/);
  assert.match(workflow, /environment: combo-dev/);
  assert.match(workflow, /sha256sum -c metadata\/artifact-files\.sha256/);
  assert.match(workflow, /cmp -s "\$expected" "\$actual"/);
  assert.match(workflow, /node scripts\/release-manifest\.mjs verify/);
  assert.match(workflow, /node scripts\/web-asset-manifest\.mjs verify/);
  assert.match(workflow, /file_set_digest/);
  assert.match(workflow, /release_artifact_digest/);
  assert.match(workflow, /source-release\.json/);
  assert.match(workflow, /sourceCiRunAttempt/);
  assert.match(workflow, /releaseArtifactId/);
  assert.match(workflow, /releaseArtifactName/);
  assert.match(workflow, /releaseArtifactDigest/);
  assert.match(workflow, /artifactFileSetDigest/);
  assert.match(workflow, /webAssetManifestDigest/);
  assert.doesNotMatch(workflow, /COMBO_PREVIEW_AUTO_PROMOTION_MODE|PREVIEW_MODE/);
  assert.doesNotMatch(workflow, /verify_preview_policy_is_paused/);
  assert.doesNotMatch(workflow, /actions\/workflows\/preview\.yml\/runs/);
  assert.match(
    workflow,
    /main-ci\)[\s\S]*evidence_artifact_name="combo-test-evidence-\$\{REVISION\}-\$\{RUN_ATTEMPT\}"[\s\S]*branch-build\)[\s\S]*evidence_artifact_name="combo-branch-test-evidence-\$\{REVISION\}-\$\{RUN_ATTEMPT\}"/,
  );
  assert.match(workflow, /sourceWorkflow: \$sourceWorkflow/);
  assert.match(workflow, /sourceEvent: \$sourceEvent/);
  assert.match(workflow, /sourceBranch: \$sourceBranch/);
  assert.match(workflow, /controllerSha: \$controllerSha/);
  assert.match(workflow, /sourceMode: \$sourceMode/);
  assert.match(
    workflow,
    /main-ci\)[\s\S]*\[\[ "\$CONTROLLER_SHA" == "\$REVISION" \]\][\s\S]*\[\[ "\$SOURCE_WORKFLOW" == \.github\/workflows\/ci\.yml \]\][\s\S]*branch-build\)[\s\S]*\[\[ "\$SOURCE_WORKFLOW" == \.github\/workflows\/combo-dev\.yml \]\]/,
  );
  assert.match(
    preview,
    /expected_test_title="Test deployment for CI \$\{SOURCE_RUN_ID\} attempt \$\{SOURCE_RUN_ATTEMPT\}"[\s\S]*\.display_title == \$title[\s\S]*\.event == "workflow_run"/,
  );
  assert.match(
    preview,
    /actions\/workflows\/combo-dev\.yml\/runs\?event=workflow_run&branch=main&head_sha=\$\{REVISION\}&per_page=100/,
  );
  assert.doesNotMatch(
    workflow,
    /actions\/variables\/COMBO_PREVIEW_AUTO_PROMOTION_MODE/,
    'The workflow token cannot read the repository Variables REST endpoint',
  );
  assert.doesNotMatch(
    preview,
    /actions\/variables\/COMBO_PREVIEW_AUTO_PROMOTION_MODE/,
    'Preview must use the policy output and protected job-admission vars context',
  );
  assert.match(workflow, /main advanced while (?:branch )?Test waited for its deployment gate/);
  assert.match(
    workflow,
    /git\/ref\/heads\/main"[\s\\\n]*--jq '\.object\.sha'\)" == "\$CONTROLLER_SHA"/,
  );
  const firstMutation = workflow.indexOf("printf 'mutation_started=true");
  const finalControllerCheck = workflow.lastIndexOf('git/ref/heads/main', firstMutation);
  assert.ok(finalControllerCheck > workflow.indexOf('Upload the fixed bundle'));
  assert.match(workflow, /\.run_attempt == \$runAttempt/);
  assert.match(workflow, /\.digest == \$digest/);
  assert.match(
    ci,
    /^ {2}release:\n[\s\S]*?^ {4}if: >-\n\s+\(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\) \|\|\n\s+inputs\.publish_release == true/m,
  );
  assert.match(
    ci,
    /push: >-\n\s+\$\{\{ \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\) \|\|\n\s+inputs\.publish_release == true \}\}/,
  );
  const webContract = ci.slice(
    ci.indexOf('      - name: Verify the hardened Web runtime metadata path'),
    ci.indexOf('      - name: Record the immutable image reference'),
  );
  assert.match(webContract, /IMAGE_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(webContract, /case "\$PUBLISH_RELEASE" in/);
  assert.match(webContract, /\[\[ "\$IMAGE_DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/);
  assert.match(webContract, /IMAGE_REF="\$IMAGE_REPOSITORY@\$IMAGE_DIGEST"/);
  assert.match(webContract, /docker pull "\$IMAGE_REF"/);
  assert.match(
    webContract,
    /false\)[\s\S]*IMAGE_REF="\$IMAGE_TAG"[\s\S]*docker image inspect "\$IMAGE_REF"/,
  );
  assert.match(webContract, /"\$IMAGE_REF" >\/dev\/null/);
  assert.doesNotMatch(webContract, /docker pull "\$IMAGE_TAG"/);
  assert.match(
    webContract,
    /infra\/k8s\/release\/overlays\/preview\/apps\/review-nginx\.conf,dst=\/etc\/nginx\/templates\/default\.conf\.template,readonly/,
  );
  assert.match(
    webContract,
    /preview_token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/,
  );
  assert.match(webContract, /--env REVIEW_ACCESS_TOKEN="\$preview_token"/);
  assert.match(webContract, /docker exec "\$container" nginx -t/);
  assert.match(webContract, /docker run -d --name "\$container"/);
  assert.match(webContract, /http:\/\/127\.0\.0\.1\/try\//);
  assert.match(webContract, /try\/sessions\/combo-runtime-route-contract/);
  assert.match(webContract, /runtime_asset=.*sed -n/s);
  assert.match(webContract, /http:\/\/127\.0\.0\.1\/try\/assets\/combo-missing-deadbeef\.js/);
  assert.match(workflow, /combo-release-mutation\.lock/);
  assert.match(workflow, /flock -n 9/);
  assert.doesNotMatch(workflow, /flock -w [0-9]+ 9/);
  assert.match(
    workflow,
    /revalidate_test_authority[\s\S]*printf 'mutation_started=true[\s\S]*mv -fT -- "\$temporary" "\$remote"[\s\S]*revalidate_test_authority[\s\S]*flock -n 9/,
  );
  assert.match(
    workflow,
    /"\$RELEASE_ROOT\/metadata\/release\.json"[\s\\\n]*"\$RELEASE_ROOT\/metadata\/release-manifest-digest\.txt"[\s\\\n]*"\$root\/metadata\/"/,
  );
  assert.match(testDeploy, /'metadata\/release\.json', 'metadata\/release-manifest-digest\.txt'/);
  assert.match(
    testDeploy,
    /validate_release_manifest[\s\\\n]*"\$manifest" "\$digest_file" "\$revision" "\$api_image" "\$runtime_image" "\$web_image"/,
  );
  assert.match(testDeploy, /combo-release-meta-\$\{revision:0:12\}/);
  assert.match(
    workflow,
    /combo-dev-reset[\s\\\n]*--confirm=DESTROY-COMBO-PREVIEW-DATA[\s\S]*combo-dev-deploy/,
  );
  assert.match(preview, /combo-preview-promotion-\$\{\{/);
  assert.match(preview, /\.sourceWorkflow == "\.github\/workflows\/ci\.yml"/);
  assert.match(preview, /\.sourceEvent == "push"/);
  assert.match(preview, /\.sourceBranch == "main"/);
  assert.match(preview, /\.controllerSha == \$controllerSha/);
  assert.match(preview, /\.sourceMode == "main-ci"/);
  assert.match(production, /environment: production/);
  assert.match(production, /combo-preview-promotion-\$\{REVISION\}-\$\{PREVIEW_RUN_ATTEMPT\}/);
  assert.match(production, /artifactFileSetDigest/);
  const productionPreviewEvidence = production.slice(
    production.indexOf('      - name: Validate Preview evidence and its source main CI run'),
    production.indexOf(
      '      - name:',
      production.indexOf('      - name: Validate Preview evidence and its source main CI run') + 1,
    ),
  );
  assert.match(productionPreviewEvidence, /keys == \(\[[\s\S]*?\] \| sort\)/);
  for (const requiredKey of [
    '"remoteCleanupEvidenceDigest"',
    '"status"',
    '"testEvidenceArtifactId"',
    '"testIdentityDigest"',
    '"testBrowserAcceptanceDigest"',
  ]) {
    assert.ok(
      productionPreviewEvidence.includes(requiredKey),
      `Production Preview evidence schema must include ${requiredKey}`,
    );
  }
  assert.match(productionPreviewEvidence, /and \.schemaVersion == 4/);
  assert.match(workflow, /echo ' {2}ServerAliveInterval 30'/);
  assert.match(workflow, /echo ' {2}ServerAliveCountMax 20'/);
  assert.match(workflow, /echo ' {2}TCPKeepAlive yes'/);
  assert.match(preview, /\[\[ "\$SOURCE_BRANCH" == main \]\]/);
  assert.match(production, /\.path == "\.github\/workflows\/preview\.yml"/);
  const credentialCheck = preview.slice(
    preview.indexOf('      - name: Check the existing Preview registry credential'),
    preview.indexOf('      - name: Upload and deploy the exact Preview bundle'),
  );
  assert.match(credentialCheck, /imagePullSecrets: \[\{name: "combo-preview-ghcr-pull"\}\]/);
  assert.match(credentialCheck, /Configure a long-lived read:packages credential/);
  assert.doesNotMatch(credentialCheck, /GHCR_(?:TOKEN|USER)|docker-registry|create secret/);
  assert.doesNotMatch(preview, /steps\.pull_credential\.outputs\.refresh|GITHUB_OUTPUT.*refresh/);
  assert.doesNotMatch(workflow, /issue\s*#?112/i);
});

test('Preview and Production preserve exact sanitized browser failure evidence', () => {
  const preview = text('.github/workflows/preview.yml');
  const production = text('.github/workflows/cd.yml');

  const previewRun = preview.indexOf('Run the exact-bundle six-area Preview browser acceptance');
  const previewUpload = preview.indexOf(
    'Upload sanitized Preview browser failure evidence',
    previewRun,
  );
  const previewFail = preview.indexOf(
    'Fail Preview after preserving browser failure evidence',
    previewUpload,
  );
  const previewAdmission = preview.indexOf(
    'Prove the current Preview checkpoint and complete resource inventory',
    previewFail,
  );
  assert.ok(
    previewRun > 0 &&
      previewUpload > previewRun &&
      previewFail > previewUpload &&
      previewAdmission > previewFail,
  );
  const previewBrowser = preview.slice(previewRun, previewUpload);
  assert.match(previewBrowser, /id: browser_admission/);
  assert.match(previewBrowser, /runner_rc=\$\?/);
  assert.match(previewBrowser, /validate-live-browser-failure[\s\\\n]*--environment preview/);
  assert.match(
    previewBrowser,
    /combo-preview-failure-evidence-\$\{REVISION\}-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}/,
  );
  const previewFailure = preview.slice(previewUpload, previewAdmission);
  assert.match(
    previewFailure,
    /always\(\) && steps\.browser_admission\.outputs\.acceptance_status == 'failed'/,
  );
  assert.match(
    previewFailure,
    /combo-preview-failure-evidence-\$\{\{ needs\.policy\.outputs\.revision \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.doesNotMatch(previewFailure, /preview-promotion\.json|ACCEPTANCE_RESEND_API_KEY/);

  const productionRun = production.indexOf(
    'Run the exact-bundle Production email OTP and six-area browser acceptance',
  );
  const productionUpload = production.indexOf(
    'Upload sanitized Production browser failure evidence',
    productionRun,
  );
  const productionFail = production.indexOf(
    'Fail Production after preserving browser failure evidence',
    productionUpload,
  );
  const productionAttestation = production.indexOf(
    'Generate and validate the workflow-owned Production acceptance attestation',
    productionFail,
  );
  assert.ok(
    productionRun > 0 &&
      productionUpload > productionRun &&
      productionFail > productionUpload &&
      productionAttestation > productionFail,
  );
  const productionBrowser = production.slice(productionRun, productionUpload);
  assert.match(productionBrowser, /id: production_browser/);
  assert.match(productionBrowser, /runner_rc=\$\?/);
  assert.match(productionBrowser, /validate-live-browser-failure[\s\\\n]*--environment production/);
  assert.match(
    productionBrowser,
    /combo-production-failure-evidence-\$\{REVISION\}-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}/,
  );
  const productionFailure = production.slice(productionUpload, productionAttestation);
  assert.match(
    productionFailure,
    /always\(\) && steps\.production_browser\.outputs\.acceptance_status == 'failed'/,
  );
  assert.match(
    productionFailure,
    /combo-production-failure-evidence-\$\{\{ needs\.resolve\.outputs\.revision \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.doesNotMatch(productionFailure, /production-deployment\.json|ACCEPTANCE_RESEND_API_KEY/);
});

test('every retained cluster-scoped object is compared against one canonical bootstrap contract', () => {
  const safety = join(repo, 'scripts/combo-dev-production-safety.py');
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-platform-contract-'));
  const pv = (name, claim, size, path) => ({
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name, labels: { 'combo.dev/environment': 'combo-dev' } },
    spec: {
      capacity: { storage: size },
      volumeMode: 'Filesystem',
      accessModes: ['ReadWriteOnce'],
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 'combo-dev-bounded',
      claimRef: { namespace: 'combo-preview', name: claim },
      local: { path },
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                { key: 'kubernetes.io/hostname', operator: 'In', values: ['node-one'] },
              ],
            },
          ],
        },
      },
    },
  });
  const objects = [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'combo-preview',
        labels: {
          'combo.dev/environment': 'combo-dev',
          'pod-security.kubernetes.io/enforce': 'restricted',
        },
      },
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: 'combo-dev-control-auditor' },
      rules: [{ apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'list'] }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'combo-dev-control-auditor' },
      subjects: [
        { kind: 'User', apiGroup: 'rbac.authorization.k8s.io', name: 'combo-dev-dispatcher' },
      ],
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: 'combo-dev-control-auditor',
      },
    },
    {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'combo-dev-bounded' },
      provisioner: 'kubernetes.io/no-provisioner',
      reclaimPolicy: 'Retain',
      volumeBindingMode: 'WaitForFirstConsumer',
      allowVolumeExpansion: false,
    },
    pv('combo-dev-postgres', 'data-postgres-0', '8Gi', '/home/xingzheng/data/combo-dev/postgres'),
    pv(
      'combo-dev-redis-queue',
      'data-redis-queue-0',
      '2Gi',
      '/home/xingzheng/data/combo-dev/redis-queue',
    ),
    pv('combo-dev-minio', 'data-minio-0', '6Gi', '/home/xingzheng/data/combo-dev/minio'),
  ];
  try {
    const input = join(work, 'desired.json');
    const expected = join(work, 'expected.json');
    const live = join(work, 'live.json');
    writeFileSync(input, JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }));
    execFileSync(
      'python3',
      [safety, 'canonicalize-platform', '--input', input, '--output', expected],
      { stdio: 'ignore' },
    );
    const compare = (items) => {
      writeFileSync(live, JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));
      return spawnSync(
        'python3',
        [safety, 'compare-platform', '--expected', expected, '--live', live],
        { stdio: 'ignore' },
      ).status;
    };
    const serverDecorated = clone(objects);
    serverDecorated[0].metadata.labels['kubernetes.io/metadata.name'] = 'combo-preview';
    serverDecorated[0].spec = { finalizers: ['kubernetes'] };
    for (const item of serverDecorated.slice(4)) {
      item.metadata.finalizers = ['kubernetes.io/pv-protection'];
      item.spec.claimRef.uid = 'server-generated';
      item.status = { phase: 'Bound' };
    }
    assert.equal(compare(serverDecorated), 0);

    const mutations = [
      [0, (item) => (item.metadata.labels['pod-security.kubernetes.io/enforce'] = 'baseline')],
      [1, (item) => item.rules[0].verbs.push('watch')],
      [2, (item) => (item.subjects[0].name = 'other-user')],
      [
        3,
        (item) =>
          (item.metadata.annotations = { 'storageclass.kubernetes.io/is-default-class': 'true' }),
      ],
      [4, (item) => (item.spec.local.path = '/tmp/postgres')],
      [5, (item) => (item.spec.capacity.storage = '3Gi')],
      [
        6,
        (item) =>
          (item.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values = [
            'other-node',
          ]),
      ],
    ];
    for (const [index, mutate] of mutations) {
      const drifted = clone(serverDecorated);
      mutate(drifted[index]);
      assert.notEqual(
        compare(drifted),
        0,
        `${drifted[index].kind}/${drifted[index].metadata.name}`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  assert.match(bootstrap, /create --dry-run=client --validate=strict/);
  assert.match(bootstrap, /canonicalize-platform/);
  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-smoke.sh',
  ]) {
    assert.match(text(scriptPath), /compare-platform/);
  }
  assert.equal(
    existsSync(join(repo, 'infra/k8s/overlays/combo-dev/platform/storage-provisioner.yaml')),
    false,
  );
  assert.doesNotMatch(
    text('scripts/combo-dev-bootstrap.sh'),
    /combo-dev-local-path|combo\.dev\/local-path/,
  );
});

test('MinIO initialization removes stale application identities and performs a negative post-removal check', () => {
  const init = text('infra/k8s/overlays/combo-dev/init/resources.yaml');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  assert.match(bootstrap, /re\.fullmatch\(r'\[A-Za-z0-9\]/);
  assert.match(init, /mc admin user list local --json/);
  assert.match(init, /mc admin user remove local "\$identity" >\/dev\/null 2>&1/);
  assert.match(init, /if mc admin user info local "\$identity" >\/dev\/null 2>&1; then/);
  assert.match(init, /mc ls revoked\/combo-raw >\/dev\/null 2>&1/);
  assert.match(init, /inventory_users\(\) \{/);
  assert.match(init, /\[ "\$inventory_records" -eq 1 \]/);
  assert.doesNotMatch(init, /^\s+(?:grep|sed|awk|jq)\b/m);
  assert.doesNotMatch(init, /echo .*\$identity/);
});

test('OpenSSH effective configuration retains exactly the two approved local forwards', () => {
  const connect = text('scripts/combo-dev-connect.sh');
  assert.match(connect, /ClearAllForwardings=no/);
  assert.doesNotMatch(connect, /-o ClearAllForwardings=yes/);
  assert.match(connect, /ssh -G "\$\{SSH_ARGS\[@\]\}"/);
  assert.match(connect, /localforward\|remoteforward\|dynamicforward/);
  const args = [
    '-G',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ClearAllForwardings=no',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-L',
    '127.0.0.1:18080:127.0.0.1:18080',
    '-L',
    '127.0.0.1:19000:127.0.0.1:19000',
    'localhost',
  ];
  const result = spawnSync('ssh', args, { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const forwards = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('localforward '))
    .map((line) => line.slice('localforward '.length));
  assert.deepEqual(forwards, [
    '[127.0.0.1]:18080 [127.0.0.1]:18080',
    '[127.0.0.1]:19000 [127.0.0.1]:19000',
  ]);

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-ssh-config-'));
  try {
    mkdirSync(join(work, '.ssh'), { recursive: true });
    writeFileSync(
      join(work, '.ssh/config'),
      'Host combo-dev-extra\n  HostName localhost\n  LocalForward 127.0.0.1:19999 127.0.0.1:19999\n',
    );
    chmodSync(join(work, '.ssh/config'), 0o600);
    const withExtra = spawnSync(
      'ssh',
      ['-G', '-F', join(work, '.ssh/config'), ...args.slice(1, -1), 'combo-dev-extra'],
      { encoding: 'utf8' },
    );
    assert.equal(withExtra.status, 0);
    assert.equal(
      withExtra.stdout
        .split('\n')
        .filter((line) => /^(localforward|remoteforward|dynamicforward) /.test(line)).length,
      3,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('control digest authenticates every consumed kustomization and resource file', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const bootstrapControls = bootstrap.match(/readonly CONTROL_FILES=\((?<body>[\s\S]*?)\n\)/)
    ?.groups?.body;
  const deployControls = deploy.match(/readonly CONTROL_FILES=\((?<body>[\s\S]*?)\n\)/)?.groups
    ?.body;
  assert.ok(bootstrapControls);
  assert.equal(deployControls, bootstrapControls);
  for (const required of [
    'infra/k8s/overlays/combo-dev/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/platform/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/platform/network-policies.yaml',
    'infra/k8s/overlays/combo-dev/platform/rbac.yaml',
    'infra/k8s/overlays/combo-dev/platform/storage-class.yaml',
    'infra/k8s/overlays/combo-dev/platform/storage-volumes.yaml',
    'infra/k8s/overlays/combo-dev/foundation/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh',
    'infra/k8s/overlays/combo-dev/foundation/resources.yaml',
    'infra/k8s/overlays/combo-dev/init/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/init/resources.yaml',
    'infra/k8s/overlays/combo-dev/migrate/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/migrate/resources.yaml',
    'infra/k8s/overlays/combo-dev/apps/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/apps/resources.yaml',
  ]) {
    assert.ok(bootstrapControls.includes(required));
  }
  assert.match(bootstrap, /\/opt\/combo-dev\/bootstrap-overlay/);
  assert.match(deploy, /"\$INSTALL_ROOT\/bootstrap-overlay\/apps\/resources\.yaml"/);
});

test('existing deployment invariants remain fail-closed', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  const rbac = text('infra/k8s/overlays/combo-dev/platform/rbac.yaml');
  const testMinioInit = text('infra/k8s/overlays/combo-dev/init/resources.yaml');
  const releaseMinioInit = text('infra/k8s/job-minio-init.yaml');
  assert.match(
    rbac,
    /resources: \['jobs'\]\n {4}verbs: \['create', 'get', 'list', 'watch', 'patch', 'delete'\]/,
  );
  assert.match(deploy, /name: combo-dev-job-rbac-preflight/);
  assert.match(
    deploy,
    /apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher -f "\$job_probe"/,
  );
  assert.match(
    deploy,
    /\[\[ "\$stage" == foundation \]\][\s\S]*apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher --force-conflicts -f "\$render\/\$stage\.yaml"/,
  );
  assert.match(workflow, /scp -q "\$ARCHIVE" "combo-dev-target:\$temporary"/);
  assert.match(workflow, /ssh combo-dev-target mv -fT -- "\$temporary" "\$remote"/);
  assert.match(deploy, /INCOMING_BUNDLE=\$bundle/);
  assert.doesNotMatch(deploy, /head -c 65537|evidence_bytes/);
  assert.doesNotMatch(deploy, /ulimit -f/);
  assert.match(deploy, /\[\[ -z "\$INCOMING_BUNDLE" \]\] \|\| rm -f -- "\$INCOMING_BUNDLE"/);
  assert.match(reset, /wipe_static_volume_data/);
  assert.doesNotMatch(reset, /delete "persistentvolumeclaim\/\$name"/);
  assert.match(
    reset,
    /apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher --force-conflicts -k "\$FOUNDATION"/,
  );
  assert.doesNotMatch(reset, /combo-dev-session|DEV_SESSION_SECRET/);
  for (const manifest of [testMinioInit, releaseMinioInit]) {
    assert.match(manifest, /name: minio-init/);
    assert.match(manifest, /limits:[\s\S]*?memory: 256Mi/);
  }
  assert.match(
    rbac,
    /resourceNames: \['combo-dev-postgres', 'combo-dev-redis-queue', 'combo-dev-minio'\]/,
  );
  for (const script of [deploy, reset]) {
    assert.match(
      script,
      /apply --server-side --field-manager=combo-dev-replicas --force-conflicts -f -/,
    );
  }
  assert.match(
    smoke,
    /ownership=\$\("\$\{K\[@\]\}" -n "\$NAMESPACE" get "deployment\/\$name" --show-managed-fields=true -o json/,
  );
  assert.match(
    smoke,
    /curl_json\(\) \{[\s\S]*for \(\(attempt = 1; attempt <= 60; attempt\+\+\)\)[\s\S]*mv -fT "\$candidate" "\$output"[\s\S]*恢复窗口内不可读：\$path/,
  );
  assert.ok(
    smoke.includes(
      `tr -d '\\015' <"$headers" | grep -Fxci 'access-control-allow-origin: http://127.0.0.1:18080'`,
    ),
  );
  assert.doesNotMatch(smoke, /access-control-allow-origin:[^\n]*\\r/);
  for (const script of [bootstrap, deploy, reset]) {
    assert.match(script, /exec 9>"\$LOCK_FILE"\n\s+flock -w 300 9/);
  }
  assert.match(bootstrap, /scale "\$controller" --replicas=0/);
  assert.match(guard, /scale "\$kind\/\$name" --replicas=0/);
  assert.doesNotMatch(guard, /--field-manager=combo-dev-dispatcher/);
  for (const path of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-smoke.sh',
    'scripts/combo-dev-logs.sh',
    'scripts/combo-dev-storage-guard.sh',
    'scripts/combo-dev-forwarder-lease.sh',
  ]) {
    assert.match(
      text(path),
      /export PATH='\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin'/,
    );
  }
});
