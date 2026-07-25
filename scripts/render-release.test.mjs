import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseAllDocuments } from 'yaml';
import {
  releaseIdForSource,
  releaseManifestDigest,
  serializeReleaseManifest,
} from './release-manifest.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SHA = 'd'.repeat(40);
const RELEASE_PREFIX = `release-${SHA.slice(0, 12)}-`;
const digest = (character) => `sha256:${character.repeat(64)}`;
const release = {
  schemaVersion: 1,
  sourceSha: SHA,
  releaseId: releaseIdForSource(SHA),
  images: {
    api: `ghcr.io/dangdang-tech/combo-api@${digest('1')}`,
    runtime: `ghcr.io/dangdang-tech/combo-runtime@${digest('2')}`,
    web: `ghcr.io/dangdang-tech/combo-web@${digest('3')}`,
  },
  migrationHead: '0006_one_running_turn_per_session.sql',
  builtAt: '2026-07-24T08:00:00.000Z',
  webAssetManifest: digest('4'),
};

function render(environment, phase) {
  const directory = mkdtempSync(join(tmpdir(), 'combo-render-test-'));
  const manifest = join(directory, 'release.json');
  const output = join(directory, `${environment}-${phase}.yaml`);
  writeFileSync(manifest, serializeReleaseManifest(release));
  execFileSync(
    process.execPath,
    [
      'scripts/render-release.mjs',
      '--manifest',
      manifest,
      '--manifest-digest',
      releaseManifestDigest(release),
      '--environment',
      environment,
      '--phase',
      phase,
      '--output',
      output,
    ],
    { cwd: ROOT, stdio: 'pipe' },
  );
  return parseAllDocuments(readFileSync(output, 'utf8')).map((document) => document.toJS());
}

function kubectlDryRunList(resources) {
  return {
    apiVersion: 'v1',
    kind: 'List',
    items: resources.map((resource) => ({
      ...structuredClone(resource),
      metadata: {
        ...structuredClone(resource.metadata),
        annotations: {
          ...(resource.metadata.annotations ?? {}),
          'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify(resource),
        },
      },
    })),
  };
}

function verifyRendered(resources, environment, phase) {
  const directory = mkdtempSync(join(tmpdir(), 'combo-verify-render-test-'));
  const manifest = join(directory, 'release.json');
  writeFileSync(manifest, serializeReleaseManifest(release));
  return spawnSync(
    process.execPath,
    [
      'scripts/verify-rendered-release.mjs',
      '--manifest',
      manifest,
      '--manifest-digest',
      releaseManifestDigest(release),
      '--environment',
      environment,
      '--phase',
      phase,
    ],
    {
      cwd: ROOT,
      input: JSON.stringify(kubectlDryRunList(resources)),
      encoding: 'utf8',
    },
  );
}

for (const [environment, namespace, prefix] of [
  ['test', 'combo-preview', ''],
  ['preview', 'combo-review', RELEASE_PREFIX],
  ['production', 'combo', RELEASE_PREFIX],
]) {
  test(`${environment} renders exactly the four release business planes`, () => {
    const resources = render(environment, 'apps');
    const deployments = resources
      .filter((resource) => resource.kind === 'Deployment')
      .map((resource) => resource.metadata.name)
      .sort();
    assert.deepEqual(
      deployments,
      ['api', 'runtime', 'web', 'worker'].map((name) => `${prefix}${name}`).sort(),
    );
    assert.equal(
      resources.every((resource) => resource.metadata.namespace === namespace),
      true,
    );
    assert.equal(
      resources.some((resource) => resource.kind === 'Secret'),
      false,
    );
    assert.equal(
      resources
        .filter((resource) => resource.kind === 'Service')
        .some(
          (resource) =>
            resource.spec.type === 'NodePort' ||
            resource.spec.ports.some((port) => port.nodePort !== undefined),
        ),
      false,
    );
    const serialized = JSON.stringify(resources);
    assert.equal(serialized.includes('consumer'), false);
    assert.equal(serialized.includes('sweeper'), false);
    assert.equal(serialized.includes(':latest'), false);
    for (const deployment of resources.filter((resource) => resource.kind === 'Deployment')) {
      const logicalName = deployment.metadata.name.slice(prefix.length);
      const app = `${prefix}${logicalName}`;
      assert.deepEqual(deployment.spec.selector.matchLabels, {
        app,
        'combo.build/release-track': 'release-v1',
      });
      assert.equal(deployment.spec.template.metadata.labels.app, app);
      const releaseReference = deployment.spec.template.spec.containers[0].envFrom.find(
        (entry) => entry.configMapRef,
      );
      assert.equal(releaseReference.configMapRef.name, `combo-release-meta-${SHA.slice(0, 12)}`);
    }
    for (const service of resources.filter((resource) => resource.kind === 'Service')) {
      const logicalName = service.metadata.name.slice(prefix.length);
      assert.deepEqual(service.spec.selector, {
        app: `${prefix}${logicalName}`,
        'combo.build/release-track': 'release-v1',
      });
    }
    const verification = verifyRendered(resources, environment, 'apps');
    assert.equal(verification.status, 0, verification.stderr);
  });

  test(`${environment} renders migration before apps with the API digest`, () => {
    const resources = render(environment, 'migrate');
    assert.equal(resources.length, 1);
    assert.equal(resources[0].kind, 'Job');
    assert.equal(resources[0].metadata.name, `${prefix}migrate`);
    assert.equal(resources[0].metadata.namespace, namespace);
    assert.equal(resources[0].spec.template.spec.containers[0].image, release.images.api);
    assert.equal(
      resources[0].spec.template.metadata.annotations['combo.build/migration-head'],
      release.migrationHead,
    );
    assert.equal(
      resources[0].spec.template.spec.containers[0].envFrom[0].configMapRef.name,
      `combo-release-meta-${SHA.slice(0, 12)}`,
    );
    const verification = verifyRendered(resources, environment, 'migrate');
    assert.equal(verification.status, 0, verification.stderr);
  });
}

test('Nginx contract rejects missing hashed assets and defines cache policy', () => {
  const nginx = readFileSync(join(ROOT, 'infra/nginx.conf'), 'utf8');
  assert.match(nginx, /location \^~ \/assets\/[\s\S]*?try_files \$uri =404;/);
  assert.match(nginx, /location \^~ \/try\/assets\/[\s\S]*?try_files \$uri =404;/);
  assert.match(nginx, /public, max-age=31536000, immutable/);
  assert.match(nginx, /no-cache, max-age=0, must-revalidate/);
  assert.match(
    nginx,
    /location = \/runtime-config\.json[\s\S]*?alias \/var\/run\/combo-web\/runtime-config\.json;[\s\S]*?no-store/,
  );
  assert.match(
    nginx,
    /location = \/version\.json[\s\S]*?alias \/var\/run\/combo-web\/version\.json;[\s\S]*?no-store/,
  );
  assert.match(
    nginx,
    /location = \/try\/runtime-config\.json[\s\S]*?alias \/var\/run\/combo-web\/try-runtime-config\.json;[\s\S]*?no-store/,
  );
});

test('Preview release carries a SHA-scoped access gate without Secret material', () => {
  const resources = render('preview', 'apps');
  const gateName = `${RELEASE_PREFIX}review-gate`;
  const gate = resources.find(
    (resource) => resource.kind === 'ConfigMap' && resource.metadata.name === gateName,
  );
  assert.equal(gate.immutable, true);
  assert.deepEqual(Object.keys(gate.data).sort(), [
    'bootstrap.html',
    'default.conf.template',
    'enter.html',
  ]);
  assert.match(gate.data['default.conf.template'], /\$\{REVIEW_ACCESS_TOKEN\}/);
  assert.match(
    gate.data['default.conf.template'],
    /location = \/runtime-config\.json[\s\S]*?alias \/var\/run\/combo-web\/runtime-config\.json;[\s\S]*?no-store/,
  );
  assert.match(
    gate.data['default.conf.template'],
    /location = \/version\.json[\s\S]*?alias \/var\/run\/combo-web\/version\.json;[\s\S]*?add_header X-Combo-Review-Gate \$combo_review_gate_header always;[\s\S]*?no-store/,
  );
  assert.match(
    gate.data['default.conf.template'],
    /location = \/try\/runtime-config\.json[\s\S]*?alias \/var\/run\/combo-web\/try-runtime-config\.json;[\s\S]*?add_header X-Combo-Review-Gate \$combo_review_gate_header always;[\s\S]*?no-store/,
  );
  assert.match(
    gate.data['default.conf.template'],
    /location \^~ \/assets\/[\s\S]*?try_files \$uri =404;/,
  );
  assert.match(
    gate.data['default.conf.template'],
    /location \^~ \/try\/assets\/[\s\S]*?alias \/usr\/share\/nginx\/html\/try\/assets\/;[\s\S]*?try_files \$uri =404;/,
  );
  assert.match(
    gate.data['default.conf.template'],
    /location \^~ \/try\/[\s\S]*?alias \/usr\/share\/nginx\/html\/try\/;/,
  );
  assert.match(gate.data['bootstrap.html'], /\/api\/v1\/auth\/dev-login/);

  const web = resources.find(
    (resource) =>
      resource.kind === 'Deployment' && resource.metadata.name === `${RELEASE_PREFIX}web`,
  );
  const container = web.spec.template.spec.containers[0];
  assert.deepEqual(
    container.env.find((entry) => entry.name === 'REVIEW_ACCESS_TOKEN'),
    {
      name: 'REVIEW_ACCESS_TOKEN',
      valueFrom: {
        secretKeyRef: {
          key: 'REVIEW_ACCESS_TOKEN',
          name: 'combo-preview-bootstrap',
        },
      },
    },
  );
  assert.deepEqual(
    web.spec.template.spec.volumes.map((volume) => volume.configMap.name),
    [gateName, gateName, gateName],
  );
  assert.equal(JSON.stringify(resources).includes('kind":"Secret"'), false);
});

test('Production release contains no Preview access gate', () => {
  const resources = render('production', 'apps');
  assert.equal(
    resources.some((resource) => resource.kind === 'ConfigMap'),
    false,
  );
  const web = resources.find(
    (resource) =>
      resource.kind === 'Deployment' && resource.metadata.name === `${RELEASE_PREFIX}web`,
  );
  const container = web.spec.template.spec.containers[0];
  assert.equal(
    (container.env ?? []).some((entry) => entry.name === 'REVIEW_ACCESS_TOKEN'),
    false,
  );
  assert.equal((web.spec.template.spec.volumes ?? []).length, 0);
});

for (const environment of ['preview', 'production']) {
  test(`${environment} foundation uses fresh release names and no legacy NodePort`, () => {
    const foundation = render(environment, 'foundation');
    assert.equal(
      foundation.some(
        (resource) =>
          resource.kind === 'StatefulSet' && resource.metadata.name === 'release-postgres',
      ),
      true,
    );
    assert.equal(
      foundation.some(
        (resource) =>
          resource.kind === 'StatefulSet' && resource.metadata.name === 'release-redis-queue',
      ),
      true,
    );
    assert.equal(
      foundation.some(
        (resource) => resource.kind === 'StatefulSet' && resource.metadata.name === 'release-minio',
      ),
      true,
    );
    assert.equal(
      foundation
        .filter((resource) => resource.kind === 'Service')
        .some(
          (resource) =>
            resource.spec.type === 'NodePort' ||
            resource.spec.ports.some((port) => port.nodePort !== undefined),
        ),
      false,
    );
    const expectedSecret = environment === 'preview' ? 'combo-preview-env' : 'combo-env';
    assert.equal(JSON.stringify(foundation).includes(expectedSecret), true);
    const verification = verifyRendered(foundation, environment, 'foundation');
    assert.equal(verification.status, 0, verification.stderr);
  });

  test(`${environment} bucket initialization targets only the fresh MinIO service`, () => {
    const resources = render(environment, 'init');
    const job = resources.find((resource) => resource.kind === 'Job');
    assert.equal(job.metadata.name, `${RELEASE_PREFIX}minio-init`);
    assert.match(JSON.stringify(job), /http:\/\/release-minio:9000/);
    const expectedSecret = environment === 'preview' ? 'combo-preview-env' : 'combo-env';
    assert.equal(JSON.stringify(job).includes(expectedSecret), true);
    const verification = verifyRendered(resources, environment, 'init');
    assert.equal(verification.status, 0, verification.stderr);
  });
}

test('deployment-side allowlist rejects extra resources and image drift before apply', () => {
  const apps = render('production', 'apps');
  apps.push({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'forbidden', namespace: 'combo' },
    stringData: { password: 'fixture' },
  });
  const extra = verifyRendered(apps, 'production', 'apps');
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /resource set|forbidden/);

  const wrongImage = render('production', 'apps');
  const worker = wrongImage.find(
    (resource) =>
      resource.kind === 'Deployment' && resource.metadata.name === `${RELEASE_PREFIX}worker`,
  );
  worker.spec.template.spec.containers[0].image =
    'ghcr.io/dangdang-tech/combo-api@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const drift = verifyRendered(wrongImage, 'production', 'apps');
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /does not use worker/);

  const migrate = render('production', 'migrate');
  migrate[0].metadata.namespace = 'combo-review';
  const escaped = verifyRendered(migrate, 'production', 'migrate');
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /escaped namespace/);
});

test('deployment-side allowlist rejects mutable foundation commands', () => {
  const foundation = render('preview', 'foundation');
  const redis = foundation.find(
    (resource) => resource.kind === 'Deployment' && resource.metadata.name === 'release-redis-hot',
  );
  redis.spec.template.spec.containers[0].command = ['sh', '-c', 'exit 0'];
  const command = verifyRendered(foundation, 'preview', 'foundation');
  assert.notEqual(command.status, 0);
  assert.match(command.stderr, /unapproved command/);

  const init = render('preview', 'init');
  const script = init.find((resource) => resource.kind === 'ConfigMap');
  script.data['init-buckets.sh'] = '#!/bin/sh\nexit 0\n';
  const changedScript = verifyRendered(init, 'preview', 'init');
  assert.notEqual(changedScript.status, 0);
  assert.match(changedScript.stderr, /script differs/);
});

test('deployment-side allowlist rejects Preview access gate content drift', () => {
  const apps = render('preview', 'apps');
  const gate = apps.find(
    (resource) =>
      resource.kind === 'ConfigMap' && resource.metadata.name === `${RELEASE_PREFIX}review-gate`,
  );
  gate.data['default.conf.template'] += '\n# unapproved drift\n';
  const changedGate = verifyRendered(apps, 'preview', 'apps');
  assert.notEqual(changedGate.status, 0);
  assert.match(changedGate.stderr, /does not preserve the Preview access gate/);
});
