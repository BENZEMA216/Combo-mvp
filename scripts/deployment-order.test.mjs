import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const start = readFileSync(new URL('./start.sh', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('./deploy-k8s.sh', import.meta.url), 'utf8');
const infraPackage = JSON.parse(
  readFileSync(new URL('../infra/package.json', import.meta.url), 'utf8'),
);
const migrationJob = readFileSync(
  new URL('../infra/k8s/job-migrate.yaml', import.meta.url),
  'utf8',
);
const compose = readFileSync(new URL('../infra/docker-compose.yml', import.meta.url), 'utf8');
const composeDevTest = readFileSync(
  new URL('../infra/docker-compose.dev-test.yml', import.meta.url),
  'utf8',
);
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const cd = readFileSync(new URL('../.github/workflows/cd.yml', import.meta.url), 'utf8');
const authE2e = readFileSync(new URL('./integration/resend-auth-e2e.sh', import.meta.url), 'utf8');
const acceptanceSmoke = readFileSync(new URL('./acceptance-smoke.sh', import.meta.url), 'utf8');
const apiDockerfile = readFileSync(new URL('../infra/Dockerfile.api', import.meta.url), 'utf8');

const oldDeployments = {
  api: { replicas: 2, revision: '7', container: 'api', image: 'registry.invalid/combo-api:old' },
  worker: {
    replicas: 1,
    revision: '7',
    container: 'worker',
    image: 'registry.invalid/combo-api:old',
  },
  runtime: {
    replicas: 2,
    revision: '7',
    container: 'runtime',
    image: 'registry.invalid/combo-runtime:old',
  },
  web: { replicas: 1, revision: '7', container: 'web', image: 'registry.invalid/combo-web:old' },
};

const fakeKubectl = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const statePath = process.env.FAKE_KUBE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
state.operations.push(args.join(' '));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const done = (code = 0, output = '') => { save(); if (output) process.stdout.write(output); process.exit(code); };
const stripped = args[0] === '-n' ? args.slice(2) : args;
const command = stripped[0];

if (command === 'exec') done(0, 't\n');
if (command === 'get') {
  const resource = stripped[1] ?? '';
  if (resource.startsWith('deployment/')) {
    const name = resource.split('/')[1];
    const item = state.deployments[name];
    if (!item) done(1);
    const format = stripped[stripped.indexOf('-o') + 1] ?? '';
    if (format.includes('.spec.replicas')) done(0, String(item.replicas));
    if (format.includes('metadata.annotations')) done(0, item.revision);
    if (format.includes('range .spec.template.spec.containers')) {
      done(0, item.container + '=' + item.image + '\n');
    }
    done(0);
  }
  if (resource === 'job/migrate') done(state.jobExists ? 0 : 1);
  if (resource === 'pods') done(0, state.jobRunning ? 'pod/migrate-test\n' : '');
  done(0);
}
if (command === 'scale') {
  const name = stripped[1].split('/')[1];
  const replicaArg = stripped.find((arg) => arg.startsWith('--replicas='));
  state.deployments[name].replicas = Number(replicaArg.split('=')[1]);
  done();
}
if (command === 'delete') {
  if (stripped[1] === 'job' && stripped[2] === 'migrate') {
    state.jobExists = false;
    state.jobRunning = false;
    done();
  }
  if ((stripped[1] ?? '').startsWith('deployment/')) {
    delete state.deployments[stripped[1].split('/')[1]];
    done();
  }
  done();
}
if (command === 'apply') {
  const file = stripped[stripped.indexOf('-f') + 1];
  if (file.includes('job-migrate')) {
    state.jobExists = true;
    state.jobRunning = true;
    done();
  }
  const name = path.basename(file).split('.')[0];
  const item = state.deployments[name];
  state.businessApplyCount += 1;
  const target = name === 'runtime'
    ? 'ghcr.io/dangdang-tech/combo-runtime:' + process.env.TEST_SHA
    : name === 'web'
      ? 'ghcr.io/dangdang-tech/combo-web:' + process.env.TEST_SHA
      : 'ghcr.io/dangdang-tech/combo-api:' + process.env.TEST_SHA;
  item.image = target;
  item.revision = String(Number(item.revision) + 1);
  item.replicas = name === 'worker' || name === 'web' ? 1 : 2;
  if (process.env.FAKE_FAIL_KIND === 'apply' && state.businessApplyCount === Number(process.env.FAKE_FAIL_AT)) {
    done(1);
  }
  done();
}
if (command === 'wait') {
  if (process.env.FAKE_FAIL_KIND === 'migration_wait') done(1);
  state.jobRunning = false;
  done();
}
if (command === 'rollout') {
  const action = stripped[1];
  const name = stripped[2].split('/')[1];
  if (action === 'status') {
    const item = state.deployments[name];
    if (item.image.includes(process.env.TEST_SHA)) {
      state.businessRolloutCount += 1;
      if (process.env.FAKE_FAIL_KIND === 'rollout' && state.businessRolloutCount === Number(process.env.FAKE_FAIL_AT)) {
        done(1);
      }
    }
    done();
  }
  if (action === 'undo') {
    const old = state.oldDeployments[name];
    state.deployments[name] = { ...state.deployments[name], image: old.image, container: old.container };
    state.deployments[name].revision = String(Number(state.deployments[name].revision) + 1);
    done();
  }
}
done();
`;

const fakeRsync = [
  '#!/bin/bash',
  'set -euo pipefail',
  'src="${@: -2:1}"',
  'dest="${@: -1}"',
  'rm -rf "$dest"',
  'mkdir -p "$dest"',
  'cp -R "${src%/}/." "$dest/"',
  '',
].join('\n');

function cloneOldDeployments() {
  return JSON.parse(JSON.stringify(oldDeployments));
}

function runFakeDeployment(failKind, failAt = 1) {
  const temp = mkdtempSync(join(tmpdir(), 'agora-deploy-order-'));
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  const kubectlPath = join(bin, 'kubectl');
  const rsyncPath = join(bin, 'rsync');
  writeFileSync(kubectlPath, fakeKubectl);
  writeFileSync(rsyncPath, fakeRsync);
  chmodSync(kubectlPath, 0o755);
  chmodSync(rsyncPath, 0o755);
  const statePath = join(temp, 'state.json');
  const state = {
    deployments: cloneOldDeployments(),
    oldDeployments: cloneOldDeployments(),
    operations: [],
    jobExists: false,
    jobRunning: false,
    businessApplyCount: 0,
    businessRolloutCount: 0,
  };
  writeFileSync(statePath, JSON.stringify(state));
  const sha = 'a'.repeat(40);
  const result = spawnSync('bash', [join(repositoryRoot, 'scripts/deploy-k8s.sh')], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: temp,
      SHA: sha,
      TEST_SHA: sha,
      K8S_SOURCE_DIR: join(repositoryRoot, 'infra/k8s'),
      K8S_WORK_DIR: join(temp, 'work'),
      FAKE_KUBE_STATE: statePath,
      FAKE_FAIL_KIND: failKind,
      FAKE_FAIL_AT: String(failAt),
    },
  });
  const finalState = JSON.parse(readFileSync(statePath, 'utf8'));
  return {
    temp,
    result,
    state: finalState,
    cleanup: () => rmSync(temp, { recursive: true, force: true }),
  };
}

function assertOldWorkloadsRestored(state) {
  for (const [name, old] of Object.entries(oldDeployments)) {
    assert.equal(state.deployments[name].image, old.image, `${name} image was not restored`);
    assert.equal(
      state.deployments[name].replicas,
      old.replicas,
      `${name} replicas were not restored`,
    );
  }
}

test('Compose upgrade removes only project-local obsolete Logto containers before migration', () => {
  const removeAt = start.indexOf('remove_obsolete_project_containers');
  const stopAt = start.indexOf('stop --timeout 60 api worker runtime web');
  const migrateAt = start.indexOf('--exit-code-from migrate migrate');
  const startBusinessAt = start.indexOf('up -d --wait api worker runtime web');
  assert.ok(removeAt >= 0);
  assert.ok(stopAt > removeAt);
  assert.ok(migrateAt > stopAt);
  assert.ok(startBusinessAt > migrateAt);
  assert.match(start, /label=com\.docker\.compose\.project=\$\{COMPOSE_PROJECT\}/);
  for (const service of ['logto', 'logto_db_seed', 'logto_alteration']) {
    assert.match(start, new RegExp(`OBSOLETE_SERVICES=.*${service}`));
  }
  assert.match(start, /docker rm -f "\$\{obsolete_ids\[@\]\}"/);
  assert.match(start, /废弃 \$\{service\} 容器仍存在/);
  assert.match(start, /ps --status running -q api worker runtime web/);
});

test('authenticated acceptance writes use WEB_BASE Origin and reject a wrong Origin first', () => {
  const wrongOriginAt = acceptanceSmoke.indexOf('wrong_origin_status=');
  const firstWriteAt = acceptanceSmoke.indexOf('first_status=');
  assert.ok(wrongOriginAt >= 0);
  assert.ok(firstWriteAt > wrongOriginAt);
  assert.match(acceptanceSmoke, /wrong_origin_status[\s\S]*== '403'/);
  const guardedWrites = acceptanceSmoke.slice(firstWriteAt);
  assert.equal((guardedWrites.match(/-H "Origin: \$\{WEB_BASE\}"/g) ?? []).length, 2);
  assert.equal((guardedWrites.match(/Sec-Fetch-Site: same-origin/g) ?? []).length, 2);
});

test('infra package scripts bind the root env file and quiet configuration output', () => {
  assert.equal(
    infraPackage.scripts['compose:config'],
    'docker compose --env-file ../.env -f docker-compose.yml config --quiet',
  );
  assert.match(infraPackage.scripts['compose:up'], /--env-file \.\.\/\.env/);
  assert.match(infraPackage.scripts['compose:down'], /--env-file \.\.\/\.env/);
});

test('isolated auth E2E binds every published service to its run-scoped loopback port', () => {
  for (const [service, variable, containerPort] of [
    ['postgres', 'POSTGRES_PORT', '5432'],
    ['redis_queue', 'REDIS_QUEUE_PORT', '6379'],
    ['redis_hot', 'REDIS_HOT_PORT', '6379'],
    ['minio', 'MINIO_API_PORT', '9000'],
    ['minio', 'MINIO_CONSOLE_PORT', '9001'],
    ['resend-mock', 'RESEND_MOCK_PORT', '4010'],
    ['api', 'API_PORT', '3000'],
    ['web', 'WEB_PORT', '80'],
  ]) {
    assert.match(
      composeDevTest,
      new RegExp(
        `(?:^|\\n)  ${service}:[\\s\\S]*?127\\.0\\.0\\.1:\\$\\{${variable}:-[0-9]+\\}:${containerPort}(?:'|\\n)`,
      ),
      `${service} does not consume ${variable}`,
    );
  }
  assert.equal((composeDevTest.match(/ports: !override/g) ?? []).length, 7);
});

test('isolated auth E2E serves non-placeholder Test release metadata from the built Web image', () => {
  const webOverride = composeDevTest.slice(composeDevTest.indexOf('  web:'));
  assert.match(webOverride, /COMBO_ENVIRONMENT: test/);
  for (const variable of [
    'COMBO_SOURCE_SHA',
    'COMBO_RELEASE_ID',
    'COMBO_BUILT_AT',
    'COMBO_RELEASE_MANIFEST_DIGEST',
    'COMBO_WEB_ASSET_MANIFEST',
  ]) {
    assert.match(webOverride, new RegExp(`${variable}: \\$\\{${variable}:\\?`));
  }
  assert.match(authE2e, /docker run --rm --entrypoint sha256sum[\s\S]*web-asset-manifest\.json/);
  const buildAt = authE2e.indexOf('"${COMPOSE[@]}" build');
  const derivedDigestAt = authE2e.lastIndexOf('COMBO_WEB_ASSET_MANIFEST="sha256:$(');
  const assetReadAt = authE2e.indexOf('docker run --rm --entrypoint sha256sum', derivedDigestAt);
  const validatedConfigAt = authE2e.indexOf('"${COMPOSE[@]}" config -q', assetReadAt);
  const upAt = authE2e.indexOf('"${COMPOSE[@]}" up -d --wait', validatedConfigAt);
  assert.ok(buildAt >= 0);
  assert.ok(derivedDigestAt > buildAt);
  assert.ok(assetReadAt > derivedDigestAt);
  assert.ok(validatedConfigAt > assetReadAt);
  assert.ok(upAt > validatedConfigAt);
});

test('migration manifests pass owner credentials as discrete PG fields instead of an unescaped URI', () => {
  assert.doesNotMatch(migrationJob, /DATABASE_URL|postgres:\/\/\$\(POSTGRES_USER\)/);
  assert.match(migrationJob, /name: PGPASSWORD/);
  assert.match(migrationJob, /name: PGHOST\s+value: postgres/);
  assert.doesNotMatch(migrationJob, /combo-postgres-host/);
  const migrateBlock = compose.slice(compose.indexOf('  migrate:'), compose.indexOf('  api:'));
  assert.doesNotMatch(migrateBlock, /DATABASE_URL:/);
  assert.match(migrateBlock, /PGPASSWORD:/);
  assert.match(authE2e, /process\.stdout\.write\("owner\/"[\s\S]*"#\?"\)/);
});

test('Kubernetes cutover arms rollback, quiesces a failed migration Job, then applies business manifests', () => {
  const preflightAt = deploy.indexOf('users_empty="$(pg_scalar \'SELECT NOT EXISTS');
  const armAt = deploy.indexOf('ROLLBACK_ARMED=1');
  const scaleAt = deploy.indexOf("log '停止当前命名空间的旧业务工作负载。'");
  const migrationAt = deploy.indexOf('kubectl -n combo apply -f "$MIGRATION_MANIFEST"');
  const waitAt = deploy.indexOf('condition=complete job/migrate');
  const businessAt = deploy.indexOf('for index in "${!DEPLOYMENTS[@]}";', waitAt);
  assert.ok(preflightAt >= 0);
  assert.ok(armAt > preflightAt);
  assert.ok(scaleAt > armAt);
  assert.ok(migrationAt > scaleAt);
  assert.ok(waitAt > migrationAt);
  assert.ok(businessAt > waitAt);
  assert.match(deploy, /terminate_migration_job/);
  assert.match(deploy, /--cascade=foreground --wait=true/);
  assert.match(deploy, /rollout undo/);
  assert.match(deploy, /PREVIOUS_REVISIONS/);
  assert.match(deploy, /PREVIOUS_IMAGES/);
});

for (const [failureKind, failureAt] of [
  ['apply', 2],
  ['rollout', 2],
]) {
  test(`Kubernetes ${failureKind} failure at business deployment ${failureAt} restores every old image`, () => {
    const run = runFakeDeployment(failureKind, failureAt);
    try {
      assert.notEqual(run.result.status, 0, run.result.stdout + run.result.stderr);
      assertOldWorkloadsRestored(run.state);
      assert.ok(
        run.state.operations.some((operation) => operation.includes('rollout undo deployment/api')),
        JSON.stringify({
          operations: run.state.operations,
          stdout: run.result.stdout,
          stderr: run.result.stderr,
        }),
      );
      assert.ok(
        run.state.operations.some((operation) =>
          operation.includes('rollout undo deployment/worker'),
        ),
      );
    } finally {
      run.cleanup();
    }
  });
}

test('migration wait failure deletes and confirms the Job before schema inspection or replica restore', () => {
  const run = runFakeDeployment('migration_wait');
  try {
    assert.notEqual(run.result.status, 0, run.result.stdout + run.result.stderr);
    assertOldWorkloadsRestored(run.state);
    const operations = run.state.operations;
    const failedWait = operations.findIndex((operation) =>
      operation.includes('condition=complete'),
    );
    const cleanupDelete = operations.findIndex(
      (operation, index) => index > failedWait && operation.includes('delete job migrate'),
    );
    const schemaInspection = operations.findIndex(
      (operation, index) =>
        index > cleanupDelete && operation.includes('exec statefulset/postgres'),
    );
    const replicaRestore = operations.findIndex(
      (operation, index) =>
        index > cleanupDelete && operation.includes('scale deployment/api --replicas=2'),
    );
    assert.ok(
      failedWait >= 0,
      JSON.stringify({ operations, stdout: run.result.stdout, stderr: run.result.stderr }),
    );
    assert.ok(cleanupDelete > failedWait);
    assert.ok(schemaInspection > cleanupDelete);
    assert.ok(replicaRestore > schemaInspection);
    assert.equal(run.state.jobExists, false);
    assert.equal(run.state.jobRunning, false);
  } finally {
    run.cleanup();
  }
});

test('isolated auth E2E enables cleanup before build and audits every project-local resource type', () => {
  assert.ok(
    authE2e.indexOf('CLEANUP_REQUIRED=1') < authE2e.indexOf('build migrate api runtime web'),
  );
  assert.doesNotMatch(authE2e, /down --volumes --remove-orphans --rmi local[^\n]*\|\| true/);
  assert.doesNotMatch(authE2e, /\bmapfile\b/);
  for (const command of [
    'docker ps -aq',
    'docker volume ls -q',
    'docker network ls -q',
    'docker image ls -q',
  ]) {
    assert.match(authE2e, new RegExp(command.replaceAll(' ', '\\s+')));
  }
});

test('CI installs the pinned Playwright browser before the first-party auth E2E', () => {
  const browserInstallAt = ci.indexOf('pnpm exec playwright install --with-deps chromium');
  const authE2eAt = ci.indexOf('bash scripts/integration/resend-auth-e2e.sh');
  assert.ok(browserInstallAt >= 0);
  assert.ok(authE2eAt > browserInstallAt);
  assert.match(
    authE2e,
    /playwright test --config playwright\.config\.ts --tsconfig tsconfig\.e2e\.json/,
  );
});

test('migration image includes only the ledger runner and its role provisioner', () => {
  assert.deepEqual(apiDockerfile.match(/^COPY --from=build \/app\/db\/.*$/gm), [
    'COPY --from=build /app/db/package.json ./db/package.json',
    'COPY --from=build /app/db/migrations ./db/migrations',
    'COPY --from=build /app/db/scripts/migrate.ts ./db/scripts/migrate.ts',
    'COPY --from=build /app/db/scripts/provision-app-roles.ts ./db/scripts/provision-app-roles.ts',
  ]);
  assert.match(
    readFileSync(new URL('../db/scripts/migrate.ts', import.meta.url), 'utf8'),
    /from '\.\/provision-app-roles\.ts'/,
  );
});

test('image publication and manual CD are gated by full same-SHA verification and auth compatibility', () => {
  assert.match(ci, /image:[\s\S]*needs: \[integration, sandbox-integration\]/);
  assert.match(cd, /validate-preview-browser/);
  assert.match(deploy, /0007_first_party_email_auth\.sql/);
  assert.match(ci, /0009_billing\.sql/);
  assert.match(cd, /\.head_sha == \$revision/);
});
