import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL } from 'node:url';
import { parseAllDocuments } from 'yaml';
// V2 渲染是既有 CI 入口；凭据合同也必须随每次部署变更执行。
import './configure-v2-payment-secrets.test.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(repo, 'infra', 'k8s', 'v2');
const renderScript = join(repo, 'scripts', 'render-v2.mjs');

test('payment manifests use scoped identity, TEST channel and isolated durable Agent state', () => {
  const source = (name) => readFileSync(join(sourceDirectory, name + '.yaml'), 'utf8');
  const deployment = (name) =>
    parseAllDocuments(source(name))
      .map((doc) => doc.toJSON())
      .find((doc) => doc.kind === 'Deployment');
  const agent = deployment('restart-life');
  assert.equal(agent.spec.strategy.type, 'Recreate');
  assert.equal(agent.spec.replicas, 1);
  assert.equal(agent.spec.template.spec.containers.length, 2);
  const coordinator = agent.spec.template.spec.containers[1];
  assert.deepEqual(coordinator.args, [
    'redis-server',
    '--bind',
    '127.0.0.1',
    '--appendonly',
    'yes',
    '--appendfsync',
    'always',
    '--save',
    '',
  ]);
  assert.equal(coordinator.volumeMounts[0].mountPath, '/data');
  const agentEnv = agent.spec.template.spec.containers[0].env;
  assert.equal(
    agentEnv.find((e) => e.name === 'COMBO_AGENT_CREDENTIAL_SECRET').valueFrom.secretKeyRef.name,
    'restart-life-credentials',
  );
  assert.doesNotMatch(
    source('restart-life'),
    /COMBO_PLATFORM_INTERNAL_TOKEN|PROVIDER_API_KEY|BILLING_INTERNAL_TOKEN|COMBO_BILLING_URL/,
  );
  assert.doesNotMatch(source('llm-gateway'), /LLM_GATEWAY_INTERNAL_TOKEN/);
  assert.match(source('llm-gateway'), /LLM_GATEWAY_PAYMENT_ADMISSION\s+value: 'true'/);
  assert.match(source('billing'), /BILLING_LESHOUYING_ENVIRONMENT\s+value: TEST/);
  assert.match(source('job-migrate'), /0017_v2_payment_channel.sql/);
  for (const entry of agentEnv.filter((e) =>
    ['COMBO_AUTHZ_URL', 'COMBO_LLM_GATEWAY_URL', 'COMBO_JWKS_URL'].includes(e.name),
  ))
    assert.equal(new URL(entry.value).protocol, 'https:');
});

test('public proxy strips Host cookies and credentials before forwarding to the Agent', () => {
  const nginx = readFileSync(join(repo, 'infra/host/combo-v2-test.conf'), 'utf8');
  const agentLocation = nginx.slice(nginx.indexOf('    proxy_pass http://127.0.0.1:18092;'));
  assert.match(agentLocation, /proxy_set_header Cookie '';/);
  assert.match(agentLocation, /proxy_set_header Authorization '';/);
  assert.match(agentLocation, /proxy_set_header x-combo-assertion \$combo_assertion;/);
  assert.match(nginx, /location \/billing\/ \{ return 404; \}/);
  assert.match(nginx, /location = \/billing\/leshouying\/payment-notify/);
  for (const [service, port] of [
    ['billing', 18093],
    ['llm-gateway', 18094],
  ]) {
    const unit = readFileSync(
      join(repo, `infra/host/release/combo-v2-${service}-forward.service`),
      'utf8',
    );
    assert.ok(
      unit.includes(
        `--namespace=combo-v2 port-forward --address=127.0.0.1 service/${service} ${port}:80`,
      ),
    );
  }
});

test('every V2 namespaced resource is explicitly pinned to combo-v2', () => {
  for (const file of readdirSync(sourceDirectory).filter((name) => name.endsWith('.yaml'))) {
    const source = readFileSync(join(sourceDirectory, file), 'utf8');
    for (const document of parseAllDocuments(source)) {
      const value = document.toJSON();
      if (!value) continue;
      if (value.kind === 'Namespace') {
        assert.equal(value.metadata?.name, 'combo-v2', file);
      } else {
        assert.equal(value.metadata?.namespace, 'combo-v2', `${file}:${value.kind}`);
      }
    }
  }
  assert.doesNotMatch(
    readFileSync(join(sourceDirectory, 'authz.yaml'), 'utf8'),
    /AUTHZ_DEV_OTP_CODE/,
  );
});

test('every V2 PostgreSQL client is pinned to the isolated combo_v2 database', () => {
  for (const file of ['authz.yaml', 'billing.yaml', 'job-migrate.yaml']) {
    const resources = parseAllDocuments(readFileSync(join(sourceDirectory, file), 'utf8'))
      .map((document) => document.toJSON())
      .filter(Boolean);
    const podSpec =
      resources[0]?.spec?.template?.spec ??
      resources.find((resource) => resource.spec?.template)?.spec?.template?.spec;
    const database = podSpec?.containers?.[0]?.env?.find((entry) => entry.name === 'PGDATABASE');
    assert.deepEqual(database, { name: 'PGDATABASE', value: 'combo_v2' }, file);
  }
});

test('V2 rendering resolves every digest and rejects a reused output directory', () => {
  const output = mkdtempSync(join(tmpdir(), 'combo-v2-render-'));
  try {
    execFileSync(
      process.execPath,
      [
        renderScript,
        '--platform',
        `sha256:${'a'.repeat(64)}`,
        '--restart-life',
        `sha256:${'b'.repeat(64)}`,
        '--state-redis',
        `sha256:${'c'.repeat(64)}`,
        '--out',
        output,
      ],
      { cwd: repo, stdio: 'pipe' },
    );
    const files = readdirSync(output).filter((name) => name.endsWith('.yaml'));
    assert.deepEqual(
      files,
      readdirSync(sourceDirectory).filter((name) => name.endsWith('.yaml')),
    );
    for (const file of files) {
      assert.doesNotMatch(readFileSync(join(output, file), 'utf8'), /COMBO_V2_[A-Z_]+_DIGEST/);
    }

    writeFileSync(join(output, 'stale.yaml'), 'stale\n');
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            renderScript,
            '--platform',
            `sha256:${'a'.repeat(64)}`,
            '--restart-life',
            `sha256:${'b'.repeat(64)}`,
            '--state-redis',
            `sha256:${'c'.repeat(64)}`,
            '--out',
            output,
          ],
          { cwd: repo, stdio: 'pipe' },
        ),
      /Command failed/,
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
