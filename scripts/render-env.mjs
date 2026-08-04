#!/usr/bin/env node
// render-env.mjs — 按环境渲染 k8s 清单（apps / migrate / foundation）。
// 三环境共用同一套应用 overlay（in-place 命名，无 SHA 前缀），Preview/Production 应用
// 通过跨 namespace 主机名连接共享 foundation（combo-foundation），Test 连接自己的 foundation。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAllDocuments, stringify } from 'yaml';
import { readReleaseManifest, releaseManifestDigest } from './release-manifest.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');
const K8S_ROOT = join(REPOSITORY_ROOT, 'infra', 'k8s');

// 每个环境：应用 namespace、所属 foundation overlay、跨 namespace 主机、公开入口。
const ENVIRONMENTS = Object.freeze({
  test: {
    namespace: 'combo-test',
    foundationOverlay: 'test-foundation',
    foundationLock: 'test',
    postgresHost: 'postgres',
    redisQueueHost: 'redis-queue',
    redisHotHost: 'redis-hot',
    minioHost: 'minio',
    publicAppOrigin: 'https://test.43-160-242-46.sslip.io',
    sessionCookieSecure: 'true',
  },
  preview: {
    namespace: 'combo-preview',
    foundationOverlay: 'shared-foundation',
    foundationLock: 'shared',
    postgresHost: 'postgres.combo-foundation.svc.cluster.local',
    redisQueueHost: 'redis-queue.combo-foundation.svc.cluster.local',
    redisHotHost: 'redis-hot.combo-foundation.svc.cluster.local',
    minioHost: 'minio.combo-foundation.svc.cluster.local',
    publicAppOrigin: 'https://review.43-160-242-46.sslip.io',
    sessionCookieSecure: 'true',
  },
  production: {
    namespace: 'combo-prod',
    foundationOverlay: 'shared-foundation',
    foundationLock: 'shared',
    postgresHost: 'postgres.combo-foundation.svc.cluster.local',
    redisQueueHost: 'redis-queue.combo-foundation.svc.cluster.local',
    redisHotHost: 'redis-hot.combo-foundation.svc.cluster.local',
    minioHost: 'minio.combo-foundation.svc.cluster.local',
    publicAppOrigin:
      'https://agora.43-160-242-46.sslip.io,https://buildwithcombo.com,https://www.buildwithcombo.com',
    sessionCookieSecure: 'true',
  },
});

// foundation overlay 到它所在 namespace 的映射。
const FOUNDATION_NAMESPACES = Object.freeze({
  'test-foundation': 'combo-test',
  'shared-foundation': 'combo-foundation',
});

const FIXTURE_DIGESTS = Object.freeze({
  api: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  runtime: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  web: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
});

function fail(message) {
  throw new Error(`Render failed: ${message}`);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail('options must use --name value');
    const name = key.slice(2);
    if (Object.hasOwn(options, name)) fail(`duplicate --${name}`);
    options[name] = value;
  }
  const allowed = ['manifest', 'manifest-digest', 'environment', 'phase', 'output'];
  const unknown = Object.keys(options).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) fail(`unknown option(s): ${unknown.join(', ')}`);
  for (const name of ['environment', 'phase', 'output']) {
    if (!options[name]) fail(`missing --${name}`);
  }
  if (!Object.hasOwn(ENVIRONMENTS, options.environment)) fail('unknown environment');
  if (!['apps', 'migrate', 'foundation'].includes(options.phase)) {
    fail('phase must be apps, migrate, or foundation');
  }
  if (options.phase !== 'foundation') {
    if (!options.manifest) fail('missing --manifest');
    if (!options['manifest-digest']) fail('missing --manifest-digest');
  }
  return options;
}

function imageDigest(reference) {
  const marker = reference.lastIndexOf('@');
  if (marker < 0) fail(`image is not immutable: ${reference}`);
  return reference.slice(marker + 1);
}

function replaceFixtureDigests(root, manifest) {
  const files = [
    join(root, 'base', 'apps', 'kustomization.yaml'),
    join(root, 'base', 'migrate', 'kustomization.yaml'),
  ];
  for (const file of files) {
    let source = readFileSync(file, 'utf8');
    const replacements = {
      [FIXTURE_DIGESTS.api]: imageDigest(manifest.images.api),
      [FIXTURE_DIGESTS.runtime]: imageDigest(manifest.images.runtime),
      [FIXTURE_DIGESTS.web]: imageDigest(manifest.images.web),
    };
    for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to);
    if (Object.keys(replacements).some((fixture) => source.includes(fixture))) {
      fail(`fixture image digest remains in ${file}`);
    }
    writeFileSync(file, source);
  }
}

function replaceScalars(value, environment) {
  if (typeof value !== 'string') return value;
  const config = ENVIRONMENTS[environment];
  if (value === 'combo-env') return 'combo-env';
  if (value === 'ghcr-pull') return 'ghcr-pull';
  if (value === 'combo-postgres-host') return config.postgresHost;
  if (value === 'combo-public-app-origin') return config.publicAppOrigin;
  if (value === 'combo-session-cookie-secure') return config.sessionCookieSecure;
  return value
    .replaceAll('api.combo.svc.cluster.local', `api.${config.namespace}.svc.cluster.local`)
    .replaceAll('runtime.combo.svc.cluster.local', `runtime.${config.namespace}.svc.cluster.local`)
    .replaceAll('postgres:5432', `${config.postgresHost}:5432`)
    .replaceAll('redis-queue:6379', `${config.redisQueueHost}:6379`)
    .replaceAll('redis-hot:6379', `${config.redisHotHost}:6379`)
    .replaceAll('minio:9000', `${config.minioHost}:9000`);
}

function mapScalars(value, environment) {
  if (Array.isArray(value)) {
    return value.map((item) => mapScalars(item, environment));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, mapScalars(child, environment)]),
    );
  }
  return replaceScalars(value, environment);
}

function podTemplate(resource) {
  return resource.spec?.template;
}

function containerImage(resource, name) {
  const container = podTemplate(resource)?.spec?.containers?.find((item) => item.name === name);
  if (!container) fail(`${resource.kind}/${resource.metadata?.name} lacks container ${name}`);
  return container.image;
}

function assertNames(resources, expected, kind) {
  const actual = resources.map((resource) => resource.metadata?.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${kind} set mismatch: ${actual.join(', ')}`);
  }
}

function releaseConfigMap(environment, manifest, manifestDigest) {
  const config = ENVIRONMENTS[environment];
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'combo-release', namespace: config.namespace },
    data: {
      COMBO_ENVIRONMENT: environment,
      COMBO_SOURCE_SHA: manifest.sourceSha,
      COMBO_RELEASE_ID: manifest.releaseId,
      COMBO_BUILT_AT: manifest.builtAt,
      COMBO_RELEASE_MANIFEST_DIGEST: manifestDigest,
      COMBO_WEB_ASSET_MANIFEST: manifest.webAssetManifest,
    },
  };
}

function validateServices(resources) {
  for (const resource of resources) {
    if (resource.kind !== 'Service') continue;
    if (resource.spec?.type && resource.spec.type !== 'ClusterIP') {
      fail('rendered Services must be ClusterIP');
    }
    if (resource.spec?.ports?.some((port) => port.nodePort !== undefined)) {
      fail('rendered Services must not contain nodePort');
    }
  }
}

function validateCommon(resources, namespace) {
  for (const resource of resources) {
    if (!resource || typeof resource !== 'object') fail('rendered an empty resource');
    if (resource.metadata?.namespace !== namespace) {
      fail(`${resource.kind}/${resource.metadata?.name} escaped ${namespace}`);
    }
    if (resource.kind === 'Secret') fail('render must never contain Secret resources');
  }
}

function validateApps(resources, environment, manifest) {
  const config = ENVIRONMENTS[environment];
  validateCommon(resources, config.namespace);
  const deployments = resources.filter((resource) => resource.kind === 'Deployment');
  const services = resources.filter((resource) => resource.kind === 'Service');
  const configMaps = resources.filter((resource) => resource.kind === 'ConfigMap');
  const expectedDeployments = ['api', 'runtime', 'web', 'worker'].sort();
  const expectedServices = ['api', 'runtime', 'web'].sort();
  const expectedConfigMaps = [];
  assertNames(deployments, expectedDeployments, 'Deployment');
  assertNames(services, expectedServices, 'Service');
  assertNames(configMaps, expectedConfigMaps, 'ConfigMap');
  if (resources.length !== deployments.length + services.length + configMaps.length) {
    fail('apps phase may contain only Service, Deployment');
  }
  const deployment = (name) => deployments.find((item) => item.metadata?.name === name);
  if (containerImage(deployment('api'), 'api') !== manifest.images.api) fail('API image mismatch');
  if (containerImage(deployment('worker'), 'worker') !== manifest.images.api) {
    fail('Worker must use the API image');
  }
  if (containerImage(deployment('runtime'), 'runtime') !== manifest.images.runtime) {
    fail('Runtime image mismatch');
  }
  if (containerImage(deployment('web'), 'web') !== manifest.images.web) fail('Web image mismatch');
  validateServices(services);
}

function validateMigrate(resources, environment, manifest) {
  const config = ENVIRONMENTS[environment];
  validateCommon(resources, config.namespace);
  if (
    resources.length !== 1 ||
    resources[0].kind !== 'Job' ||
    resources[0].metadata?.name !== 'migrate'
  ) {
    fail('migrate phase must contain only Job/migrate');
  }
  if (containerImage(resources[0], 'migrate') !== manifest.images.api) {
    fail('migration must use the API image');
  }
}

function validateFoundation(resources, namespace) {
  validateCommon(resources, namespace);
  const expected = [
    ['ConfigMap', 'minio-init-script'],
    ['ConfigMap', 'redis-hot-config'],
    ['ConfigMap', 'redis-queue-config'],
    ['Deployment', 'redis-hot'],
    ['Job', 'minio-init'],
    ['Service', 'minio'],
    ['Service', 'postgres'],
    ['Service', 'redis-hot'],
    ['Service', 'redis-queue'],
    ['StatefulSet', 'minio'],
    ['StatefulSet', 'postgres'],
    ['StatefulSet', 'redis-queue'],
  ]
    .map(([kind, name]) => `${kind}/${name}`)
    .sort();
  const actual = resources.map((resource) => `${resource.kind}/${resource.metadata?.name}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`foundation set mismatch: ${actual.join(', ')}`);
  }
  validateServices(resources);
}

function kubectl(args) {
  const result = spawnSync('kubectl', args, { encoding: 'utf8' });
  if (result.error) fail(`cannot execute kubectl: ${result.error.message}`);
  if (result.status !== 0) fail(`kubectl failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function kustomize(overlay) {
  return kubectl(['kustomize', '--load-restrictor=LoadRestrictionsNone', overlay]);
}

function run(argv) {
  const options = parseOptions(argv);
  const config = ENVIRONMENTS[options.environment];
  const temporary = mkdtempSync(join(tmpdir(), 'combo-render-'));
  try {
    const copiedRoot = join(temporary, 'k8s');
    cpSync(K8S_ROOT, copiedRoot, { recursive: true, dereference: false });
    const rendered = [];
    if (options.phase === 'foundation') {
      const foundationNamespace = FOUNDATION_NAMESPACES[config.foundationOverlay];
      if (!foundationNamespace) fail('unknown foundation overlay');
      const overlay = join(copiedRoot, 'environments', config.foundationOverlay);
      const raw = kustomize(overlay);
      for (const doc of parseAllDocuments(raw)) {
        if (doc.errors.length > 0) fail(`invalid rendered YAML: ${doc.errors[0].message}`);
        rendered.push(doc.toJS());
      }
      validateFoundation(rendered, foundationNamespace);
    } else {
      const manifest = readReleaseManifest(options.manifest);
      if (releaseManifestDigest(manifest) !== options['manifest-digest']) {
        fail('manifest digest mismatch');
      }
      replaceFixtureDigests(join(copiedRoot, 'release'), manifest);
      const overlay = join(copiedRoot, 'release', 'overlays', options.environment, options.phase);
      const raw = kustomize(overlay);
      for (const doc of parseAllDocuments(raw)) {
        if (doc.errors.length > 0) fail(`invalid rendered YAML: ${doc.errors[0].message}`);
        rendered.push(mapScalars(doc.toJS(), options.environment));
      }
      if (options.phase === 'apps') {
        validateApps(rendered, options.environment, manifest);
        rendered.push(
          releaseConfigMap(options.environment, manifest, releaseManifestDigest(manifest)),
        );
      } else {
        validateMigrate(rendered, options.environment, manifest);
      }
    }
    const output = rendered.map((resource) => stringify(resource)).join('---\n');
    writeFileSync(options.output, output, { encoding: 'utf8', flag: 'wx' });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
