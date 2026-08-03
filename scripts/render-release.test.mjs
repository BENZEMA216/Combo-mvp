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
  migrationHead: '0009_billing.sql',
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
    const expectedOrigins = {
      test: 'http://127.0.0.1:18080',
      preview: 'https://review.43-160-242-46.sslip.io',
      production:
        'https://agora.43-160-242-46.sslip.io,https://buildwithcombo.com,https://www.buildwithcombo.com',
    }[environment];
    const expectedPostgresHost = environment === 'test' ? 'postgres' : 'release-postgres';
    for (const logicalName of ['api', 'worker', 'runtime']) {
      const deployment = resources.find(
        (resource) =>
          resource.kind === 'Deployment' && resource.metadata.name === `${prefix}${logicalName}`,
      );
      const environmentEntries = deployment.spec.template.spec.containers[0].env;
      assert.equal(
        environmentEntries.find((entry) => entry.name === 'PGHOST').value,
        expectedPostgresHost,
      );
      assert.equal(environmentEntries.find((entry) => entry.name === 'PGPORT').value, '5432');
    }
    for (const logicalName of ['api', 'runtime']) {
      const deployment = resources.find(
        (resource) =>
          resource.kind === 'Deployment' && resource.metadata.name === `${prefix}${logicalName}`,
      );
      const environmentEntries = deployment.spec.template.spec.containers[0].env;
      assert.equal(
        environmentEntries.find((entry) => entry.name === 'PUBLIC_APP_ORIGINS').value,
        expectedOrigins,
      );
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
    const migrationEnvironment = new Map(
      resources[0].spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
    );
    assert.equal(
      migrationEnvironment.get('PGHOST').value,
      environment === 'test' ? 'postgres' : 'release-postgres',
    );
    assert.equal(migrationEnvironment.get('PGPORT').value, '5432');
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

test('Preview release uses first-party email auth with isolated routing', () => {
  const resources = render('preview', 'apps');
  const routingName = `${RELEASE_PREFIX}preview-routing`;
  const routing = resources.find(
    (resource) => resource.kind === 'ConfigMap' && resource.metadata.name === routingName,
  );
  assert.equal(routing.immutable, true);
  assert.deepEqual(Object.keys(routing.data).sort(), [
    'default.conf.template',
    'entry-redirect.html',
  ]);
  const nginx = routing.data['default.conf.template'];
  const redirect = routing.data['entry-redirect.html'];

  assert.doesNotMatch(
    nginx,
    /REVIEW_ACCESS_TOKEN|combo_review_access|X-Combo-Review-Gate|\/__review\/access/,
  );
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
  assert.match(nginx, /location \^~ \/assets\/[\s\S]*?try_files \$uri =404;/);
  assert.match(nginx, /location \^~ \/try\/assets\/[\s\S]*?try_files \$uri =404;/);
  assert.match(
    nginx,
    /location ~ \^\/__review\/\(\?:enter\|bootstrap\)\$[\s\S]*?Cache-Control "no-store, private" always;[\s\S]*?X-Frame-Options "DENY" always;[\s\S]*?entry-redirect\.html/,
  );
  assert.match(nginx, /location = \/try\/index\.html[\s\S]*?try_files \$uri =404;/);
  assert.match(nginx, /location \^~ \/try\/[\s\S]*?try_files \$uri \$uri\/ \/try\/index\.html;/);
  assert.doesNotMatch(
    nginx,
    /alias \/usr\/share\/nginx\/html\/try(?:\/assets\/|\/index\.html|\/);/,
  );
  assert.match(
    redirect,
    /location\.replace\(`\/login\?returnTo=\$\{encodeURIComponent\(returnTo\)\}`\)/,
  );
  assert.doesNotMatch(redirect, /\/api\/v1\/auth\/dev-login|access-form|访问码/);
  assert.match(redirect, /decodeURIComponent\(decoded\)/);
  assert.match(redirect, /decoded\.startsWith\('\/\/'\)/);
  assert.match(redirect, /decoded\.includes\('\\\\'\)/);
  assert.doesNotMatch(redirect, /target\.hash/);
  assert.doesNotMatch(nginx, /rt_uid/);
  assert.equal(
    nginx
      .split('\n')
      .find((line) => line.includes('__Host-cb_session=(?<combo_review_session_token>')),
    '  "~(?:^|;\\s*)__Host-cb_session=(?<combo_review_session_token>s1\\.[A-Za-z0-9_-]{43})(?:;|$)" "__Host-cb_session=$combo_review_session_token";',
  );
  assert.match(
    nginx,
    /map \$http_cookie \$combo_review_upstream_cookie \{[\s\S]*?default "";[\s\S]*?__Host-cb_session=\(\?<combo_review_session_token>s1\\\.\[A-Za-z0-9_-\]\{43\}\)[\s\S]*?"__Host-cb_session=\$combo_review_session_token";/,
  );
  assert.doesNotMatch(nginx, /\/api\/v1\/import\/connect/);

  const web = resources.find(
    (resource) =>
      resource.kind === 'Deployment' && resource.metadata.name === `${RELEASE_PREFIX}web`,
  );
  const container = web.spec.template.spec.containers[0];
  assert.equal(
    (container.env ?? []).some((entry) => entry.name === 'REVIEW_ACCESS_TOKEN'),
    false,
  );
  assert.deepEqual(
    web.spec.template.spec.volumes.map((volume) => volume.configMap.name),
    [routingName, routingName],
  );
  assert.equal(JSON.stringify(resources).includes('kind":"Secret"'), false);
});

test('Production release contains no Preview-only routing', () => {
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

  const wrongMigrationHost = render('preview', 'migrate');
  const postgresHost = wrongMigrationHost[0].spec.template.spec.containers[0].env.find(
    (entry) => entry.name === 'PGHOST',
  );
  postgresHost.value = 'postgres';
  const wrongEndpoint = verifyRendered(wrongMigrationHost, 'preview', 'migrate');
  assert.notEqual(wrongEndpoint.status, 0);
  assert.match(wrongEndpoint.stderr, /incorrect PostgreSQL endpoint/);

  const wrongTestMigrationHost = render('test', 'migrate');
  wrongTestMigrationHost[0].spec.template.spec.containers[0].env.find(
    (entry) => entry.name === 'PGHOST',
  ).value = 'release-postgres';
  const wrongTestEndpoint = verifyRendered(wrongTestMigrationHost, 'test', 'migrate');
  assert.notEqual(wrongTestEndpoint.status, 0);
  assert.match(wrongTestEndpoint.stderr, /incorrect PostgreSQL endpoint/);

  const migrationDatabaseUrl = render('preview', 'migrate');
  migrationDatabaseUrl[0].spec.template.spec.containers[0].env.push({
    name: 'DATABASE_URL',
    value: 'postgres://override.invalid/database',
  });
  const bypassedEndpoint = verifyRendered(migrationDatabaseUrl, 'preview', 'migrate');
  assert.notEqual(bypassedEndpoint.status, 0);
  assert.match(bypassedEndpoint.stderr, /incorrect PostgreSQL endpoint/);

  const wrongAppHost = render('preview', 'apps');
  const api = wrongAppHost.find(
    (resource) =>
      resource.kind === 'Deployment' && resource.metadata.name === `${RELEASE_PREFIX}api`,
  );
  api.spec.template.spec.containers[0].env.find((entry) => entry.name === 'PGHOST').value =
    'postgres';
  const wrongAppEndpoint = verifyRendered(wrongAppHost, 'preview', 'apps');
  assert.notEqual(wrongAppEndpoint.status, 0);
  assert.match(wrongAppEndpoint.stderr, /fixed database role/);
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

test('deployment-side allowlist rejects Preview routing content drift', () => {
  const apps = render('preview', 'apps');
  const routing = apps.find(
    (resource) =>
      resource.kind === 'ConfigMap' &&
      resource.metadata.name === `${RELEASE_PREFIX}preview-routing`,
  );
  routing.data['default.conf.template'] += '\n# unapproved drift\n';
  const changedRouting = verifyRendered(apps, 'preview', 'apps');
  assert.notEqual(changedRouting.status, 0);
  assert.match(changedRouting.stderr, /does not preserve the Preview routing contract/);
});
