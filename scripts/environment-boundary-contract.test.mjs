import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function text(path) {
  return readFileSync(join(repo, path), 'utf8');
}

function capture(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `missing ${label}`);
  return match[1];
}

function deployContract(source, environment) {
  const match = source.match(
    new RegExp(
      `\\n\\s*${environment}\\) NAMESPACE=([^;]+); FOUNDATION_SET='([^']+)'; FOUNDATION_NS=([^ ;]+) ;;`,
    ),
  );
  assert.ok(match, `missing ${environment} deploy contract`);
  return {
    namespace: match[1].trim(),
    foundationSet: match[2],
    foundationNamespace: match[3].trim(),
  };
}

function serviceContract(name) {
  const source = text(`infra/host/release/${name}`);
  const namespace = capture(source, /--namespace=([^ ]+)/, `${name} namespace`);
  const port = capture(
    source,
    /--address=127\.0\.0\.1 service\/[^ ]+ ([1-9][0-9]{3,4}):[1-9][0-9]{1,4}/,
    `${name} listener`,
  );
  return { name, namespace, port };
}

function assertDisjoint(left, right, label) {
  for (const value of left) {
    assert.equal(right.has(value), false, `${label} must not share ${value}`);
  }
}

test('Deploy grants its reusable Main CI caller the complete permission ceiling', () => {
  const deployWorkflow = text('.github/workflows/deploy.yml');
  const mainWorkflow = text('.github/workflows/ci.yml');
  const buildBranch = capture(
    deployWorkflow,
    /\n {2}build_branch:\n([\s\S]*?)\n {2}deploy:\n/,
    'Deploy branch-build job',
  );
  const releaseJob = capture(mainWorkflow, /\n {2}release:\n([\s\S]*)$/, 'Main CI release job');

  assert.match(releaseJob, /\n {4}permissions:\n(?: {6}[^\n]+\n)* {6}actions: read\n/);
  assert.match(buildBranch, /\n {4}permissions:\n(?: {6}[^\n]+\n)* {6}actions: read\n/);
  assert.match(buildBranch, /\n {6}contents: read\n/);
  assert.match(buildBranch, /\n {6}packages: write\n/);
  assert.match(buildBranch, /\n {4}uses: \.\/\.github\/workflows\/ci\.yml\n/);
});

test('Preview deployment fails closed around its isolated foundation and public forwarders', () => {
  const workflow = text('.github/workflows/deploy.yml');
  const deploy = text('scripts/deploy-env.sh');
  const bootstrap = text('scripts/bootstrap-preview-foundation.sh');
  const boundaryProbe = text('scripts/verify-preview-boundary.sh');
  const authSecrets = text('scripts/configure-first-party-auth-secrets.sh');

  assert.ok(workflow.includes('kubectl get namespace combo-preview-foundation'));
  assert.ok(workflow.includes('kubectl -n combo-preview-foundation get secret combo-env'));
  assert.ok(workflow.includes('kubectl -n combo-preview get secret ghcr-pull'));
  assert.ok(workflow.includes('available_kib >= 40 * 1024 * 1024'));
  assert.ok(workflow.includes('combo-foundation.svc.cluster.local'));
  assert.ok(workflow.includes('entering fail-closed cutover'));
  assert.ok(workflow.includes('for deployment in api worker runtime web'));
  assert.ok(workflow.includes('systemctl cat combo-preview-minio-forward.service'));
  assert.ok(workflow.includes('sudo systemctl stop "$unit"'));
  assert.ok(workflow.includes('Preview fail-closed cutover could not close port $port'));
  assert.ok(!workflow.includes('combo-preview-minio-forward.service || true'));
  assert.ok(
    workflow.includes('bash "$HOME/combo-deploy/bin/bootstrap-preview-foundation.sh" --bootstrap'),
  );
  assert.ok(
    workflow.includes('bash "$HOME/combo-deploy/bin/bootstrap-preview-foundation.sh" --verify'),
  );
  assert.ok(
    workflow.indexOf('bootstrap-preview-foundation.sh" --bootstrap') <
      workflow.indexOf('bootstrap-preview-foundation.sh" --verify'),
  );
  assert.ok(workflow.indexOf('deploy boundary') < workflow.indexOf('deploy foundation'));
  assert.ok(workflow.indexOf('deploy foundation') < workflow.indexOf('deploy migrate'));
  assert.ok(workflow.indexOf('deploy migrate') < workflow.indexOf('deploy apps'));
  assert.ok(workflow.includes('release-target:combo-deploy/bin/'));
  assert.ok(!workflow.includes('release-target:$HOME/combo-deploy/bin'));
  assert.ok(workflow.includes('sudo -n true'));
  assert.ok(workflow.includes('systemd-analyze verify'));
  assert.ok(workflow.includes('Preview port $port is owned outside $unit'));
  assert.ok(workflow.includes('changed_units=()'));
  assert.ok(workflow.includes('http://127.0.0.1:19001/minio/health/ready'));
  assert.ok(workflow.includes('Preview MinIO forwarder did not become ready'));
  assert.ok(
    workflow.includes(
      'bash "$HOME/combo-deploy/bin/verify-preview-boundary.sh" --negative-production',
    ),
  );
  assert.ok(
    workflow.includes(
      'bash "$HOME/combo-deploy/bin/verify-preview-boundary.sh" --positive-preview',
    ),
  );
  assert.ok(
    workflow.indexOf('verify-preview-boundary.sh" --negative-production') <
      workflow.indexOf('deploy foundation'),
  );
  assert.ok(
    workflow.indexOf('deploy foundation') <
      workflow.indexOf('verify-preview-boundary.sh" --positive-preview'),
  );
  assert.ok(
    workflow.indexOf('verify-preview-boundary.sh" --positive-preview') <
      workflow.indexOf('deploy migrate'),
  );
  assert.ok(workflow.includes('systemctl enable --now'));
  assert.ok(workflow.includes('combo-preview-web-forward.service'));
  assert.ok(workflow.includes('combo-preview-minio-forward.service'));
  assert.ok(deploy.includes('require_secret "$NAMESPACE" ghcr-pull'));
  assert.ok(deploy.includes('require_preview_boundary'));
  assert.ok(deploy.includes('Preview egress boundary is missing'));
  assert.ok(deploy.includes('Preview foundation ingress boundary is missing'));
  assert.ok(bootstrap.includes('production_keys_distinct=true'));
  assert.ok(bootstrap.includes('Preview and Production foundation share'));
  assert.ok(bootstrap.includes('Preview and Production app share'));
  assert.ok(bootstrap.includes('https://review-s3.43-160-242-46.sslip.io'));
  assert.ok(bootstrap.includes('production_s3_denied=true'));
  assert.ok(bootstrap.includes('Preview foundation has persistent resources but no combo-env'));
  assert.doesNotMatch(bootstrap, /--from-literal/);
  assert.match(boundaryProbe, /busybox@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(boundaryProbe, /--image=busybox:/);
  assert.ok(boundaryProbe.includes('spec["automountServiceAccountToken"] = False'));
  assert.ok(boundaryProbe.includes('"runAsNonRoot": True'));
  assert.ok(boundaryProbe.includes('"readOnlyRootFilesystem": True'));
  assert.ok(boundaryProbe.includes('"allowPrivilegeEscalation": False'));
  assert.ok(boundaryProbe.includes('"seccompProfile": {"type": "RuntimeDefault"}'));
  assert.ok(boundaryProbe.includes('"capabilities": {"drop": ["ALL"]}'));
  assert.match(authSecrets, /test\)\n\s+printf '%s %s\\n' combo-test combo-env/);
  assert.match(authSecrets, /preview\)\n\s+printf '%s %s\\n' combo-preview combo-env/);
  assert.match(authSecrets, /production\)\n\s+printf '%s %s\\n' combo-prod combo-env/);
  assert.doesNotMatch(
    text('infra/host/release/combo-preview-minio-forward.service'),
    /--namespace=combo-foundation(?: |$)/,
  );
});

test('three environments keep explicit app, foundation, listener, and public-domain ownership', () => {
  const deploy = text('scripts/deploy-env.sh');
  const workflow = text('.github/workflows/deploy.yml');

  const environments = {
    test: deployContract(deploy, 'test'),
    preview: deployContract(deploy, 'preview'),
    production: deployContract(deploy, 'production'),
  };
  assert.deepEqual(environments, {
    test: {
      namespace: 'combo-test',
      foundationSet: 'test',
      foundationNamespace: 'combo-test',
    },
    preview: {
      namespace: 'combo-preview',
      foundationSet: 'preview',
      foundationNamespace: 'combo-preview-foundation',
    },
    production: {
      namespace: 'combo-prod',
      foundationSet: 'shared',
      foundationNamespace: 'combo-foundation',
    },
  });

  const appNamespaces = new Set(Object.values(environments).map(({ namespace }) => namespace));
  assert.equal(appNamespaces.size, 3, 'application namespaces must be environment-owned');
  const foundationNamespaces = new Set(
    Object.values(environments).map(({ foundationNamespace }) => foundationNamespace),
  );
  assert.equal(foundationNamespaces.size, 3, 'foundation namespaces must be environment-owned');

  const services = {
    test: [
      serviceContract('combo-test-web-forward.service'),
      serviceContract('combo-test-s3-forward.service'),
    ],
    preview: [
      serviceContract('combo-preview-web-forward.service'),
      serviceContract('combo-preview-minio-forward.service'),
    ],
    production: [
      serviceContract('combo-prod-web-forward.service'),
      serviceContract('combo-prod-minio-forward.service'),
    ],
  };
  assert.deepEqual(services, {
    test: [
      { name: 'combo-test-web-forward.service', namespace: 'combo-test', port: '18083' },
      { name: 'combo-test-s3-forward.service', namespace: 'combo-test', port: '19003' },
    ],
    preview: [
      {
        name: 'combo-preview-web-forward.service',
        namespace: 'combo-preview',
        port: '18081',
      },
      {
        name: 'combo-preview-minio-forward.service',
        namespace: 'combo-preview-foundation',
        port: '19001',
      },
    ],
    production: [
      { name: 'combo-prod-web-forward.service', namespace: 'combo-prod', port: '18082' },
      {
        name: 'combo-prod-minio-forward.service',
        namespace: 'combo-foundation',
        port: '19002',
      },
    ],
  });

  const ports = Object.fromEntries(
    Object.entries(services).map(([environment, contracts]) => [
      environment,
      new Set(contracts.map(({ port }) => port)),
    ]),
  );
  assertDisjoint(ports.test, ports.preview, 'Test and Preview listeners');
  assertDisjoint(ports.test, ports.production, 'Test and Production listeners');
  assertDisjoint(ports.preview, ports.production, 'Preview and Production listeners');

  const domains = {
    test: capture(workflow, /\n\s*test\) origin=https:\/\/([^ ]+) ;;/, 'Test public domain'),
    preview: capture(
      workflow,
      /\n\s*preview\) origin=https:\/\/([^ ]+) ;;/,
      'Preview public domain',
    ),
    production: capture(
      workflow,
      /\n\s*production\) origin=https:\/\/([^ ]+) ;;/,
      'Production public domain',
    ),
  };
  assert.deepEqual(domains, {
    test: 'test.43-160-242-46.sslip.io',
    preview: 'review.43-160-242-46.sslip.io',
    production: 'agora.43-160-242-46.sslip.io',
  });
  assert.equal(new Set(Object.values(domains)).size, 3, 'public domains must be environment-owned');
});
