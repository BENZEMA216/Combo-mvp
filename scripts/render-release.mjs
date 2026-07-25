#!/usr/bin/env node
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
const ENVIRONMENTS = Object.freeze({
  test: {
    namespace: 'combo-preview',
    environmentCredentialName: 'combo-dev-env',
    pullCredentialName: 'combo-dev-registry',
    postgresHost: 'postgres',
    redisQueueHost: 'redis-queue',
    redisHotHost: 'redis-hot',
    minioHost: 'minio',
  },
  preview: {
    namespace: 'combo-review',
    environmentCredentialName: 'combo-preview-env',
    pullCredentialName: 'combo-preview-ghcr-pull',
    postgresHost: 'release-postgres',
    redisQueueHost: 'release-redis-queue',
    redisHotHost: 'release-redis-hot',
    minioHost: 'release-minio',
  },
  production: {
    namespace: 'combo',
    environmentCredentialName: 'combo-env',
    pullCredentialName: 'ghcr-pull',
    postgresHost: 'release-postgres',
    redisQueueHost: 'release-redis-queue',
    redisHotHost: 'release-redis-hot',
    minioHost: 'release-minio',
  },
});
const FIXTURE_DIGESTS = Object.freeze({
  api: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  runtime: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  web: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
});

function fail(message) {
  throw new Error(`Release render failed: ${message}`);
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
  for (const name of allowed) {
    if (!options[name]) fail(`missing --${name}`);
  }
  if (!Object.hasOwn(ENVIRONMENTS, options.environment)) fail('unknown environment');
  if (!['apps', 'migrate', 'foundation', 'init'].includes(options.phase)) {
    fail('phase must be apps, migrate, foundation, or init');
  }
  if (['foundation', 'init'].includes(options.phase) && options.environment === 'test') {
    fail(`${options.phase} is only defined for Preview and Production`);
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

function releaseMetadataName(manifest) {
  return `combo-release-meta-${manifest.sourceSha.slice(0, 12)}`;
}

function applicationPrefix(environment, manifest) {
  return environment === 'test' ? '' : `release-${manifest.sourceSha.slice(0, 12)}-`;
}

function replaceEnvironmentScalar(value, environment, manifest) {
  if (typeof value !== 'string') return value;
  const config = ENVIRONMENTS[environment];
  const prefix = applicationPrefix(environment, manifest);
  const apiHost = `${prefix}api.${config.namespace}.svc.cluster.local`;
  const runtimeHost = `${prefix}runtime.${config.namespace}.svc.cluster.local`;
  if (value === 'combo-env') return config.environmentCredentialName;
  if (value === 'ghcr-pull') return config.pullCredentialName;
  if (value === 'combo-release') return releaseMetadataName(manifest);
  if (environment !== 'test') {
    if (value === 'release-minio-init') return `${prefix}minio-init`;
    for (const name of ['api', 'runtime', 'web', 'worker']) {
      if (value === `release-${name}`) return `${prefix}${name}`;
    }
  }
  return value
    .replaceAll('api.combo.svc.cluster.local', apiHost)
    .replaceAll('runtime.combo.svc.cluster.local', runtimeHost)
    .replaceAll('postgres:5432', `${config.postgresHost}:5432`)
    .replaceAll('redis-queue:6379', `${config.redisQueueHost}:6379`)
    .replaceAll('redis-hot:6379', `${config.redisHotHost}:6379`)
    .replaceAll('minio:9000', `${config.minioHost}:9000`);
}

function mapScalars(value, environment, manifest) {
  if (Array.isArray(value)) {
    return value.map((item) => mapScalars(item, environment, manifest));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, mapScalars(child, environment, manifest)]),
    );
  }
  return replaceEnvironmentScalar(value, environment, manifest);
}

function podTemplate(resource) {
  return resource.spec?.template;
}

function expectedName(environment, name, manifest, phase) {
  if (phase === 'foundation' || (phase === 'init' && name === 'minio-init-script')) {
    return `release-${name}`;
  }
  if (phase === 'init') return `${applicationPrefix(environment, manifest)}${name}`;
  return `${applicationPrefix(environment, manifest)}${name}`;
}

function expectedPodApp(environment, name, manifest) {
  return `${applicationPrefix(environment, manifest)}${name}`;
}

function annotateWorkload(resource, manifest, manifestDigest) {
  const template = podTemplate(resource);
  if (!template) fail(`${resource.kind}/${resource.metadata?.name} has no Pod template`);
  template.metadata ??= {};
  template.metadata.annotations ??= {};
  Object.assign(template.metadata.annotations, {
    'combo.build/source-sha': manifest.sourceSha,
    'combo.build/release-id': manifest.releaseId,
    'combo.build/release-manifest-digest': manifestDigest,
    'combo.build/web-asset-manifest': manifest.webAssetManifest,
    'combo.build/migration-head': manifest.migrationHead,
  });
}

function containerImage(resource, name) {
  const container = podTemplate(resource)?.spec?.containers?.find((item) => item.name === name);
  if (!container) fail(`${resource.kind}/${resource.metadata?.name} lacks container ${name}`);
  return container.image;
}

function validateResources(resources, options, manifest, manifestDigest) {
  const config = ENVIRONMENTS[options.environment];
  for (const resource of resources) {
    if (!resource || typeof resource !== 'object') fail('rendered an empty resource');
    if (resource.metadata?.namespace !== config.namespace) {
      fail(`${resource.kind}/${resource.metadata?.name} escaped ${config.namespace}`);
    }
    if (resource.kind === 'Secret') fail('release render must never contain Secret resources');
  }

  if (options.phase === 'apps') {
    const deployments = resources.filter((resource) => resource.kind === 'Deployment');
    const services = resources.filter((resource) => resource.kind === 'Service');
    const configMaps = resources.filter((resource) => resource.kind === 'ConfigMap');
    const expectedDeployments = ['api', 'runtime', 'web', 'worker']
      .map((name) => expectedName(options.environment, name, manifest, options.phase))
      .sort();
    const expectedServices = ['api', 'runtime', 'web']
      .map((name) => expectedName(options.environment, name, manifest, options.phase))
      .sort();
    const expectedConfigMaps =
      options.environment === 'preview'
        ? [expectedName(options.environment, 'review-gate', manifest, options.phase)]
        : [];
    assertNames(deployments, expectedDeployments, 'Deployment');
    assertNames(services, expectedServices, 'Service');
    assertNames(configMaps, expectedConfigMaps, 'ConfigMap');
    if (resources.length !== deployments.length + services.length + configMaps.length) {
      fail('apps phase may contain only Service, Deployment, and approved ConfigMap resources');
    }
    const deployment = (name) =>
      deployments.find(
        (resource) =>
          resource.metadata.name ===
          expectedName(options.environment, name, manifest, options.phase),
      );
    if (containerImage(deployment('api'), 'api') !== manifest.images.api)
      fail('API image mismatch');
    if (containerImage(deployment('worker'), 'worker') !== manifest.images.api) {
      fail('Worker must use the API image');
    }
    if (containerImage(deployment('runtime'), 'runtime') !== manifest.images.runtime) {
      fail('Runtime image mismatch');
    }
    if (containerImage(deployment('web'), 'web') !== manifest.images.web) {
      fail('Web image mismatch');
    }
    for (const service of services) {
      if (service.spec?.type && service.spec.type !== 'ClusterIP') {
        fail('release Services must be ClusterIP');
      }
      if (service.spec?.ports?.some((port) => port.nodePort !== undefined)) {
        fail('release Services must not contain nodePort');
      }
      const prefix = applicationPrefix(options.environment, manifest);
      const name = service.metadata.name.slice(prefix.length);
      const expectedSelector = {
        app: expectedPodApp(options.environment, name, manifest),
        'combo.build/release-track': 'release-v1',
      };
      if (JSON.stringify(service.spec?.selector) !== JSON.stringify(expectedSelector)) {
        fail(`${service.metadata.name} does not have an isolated release selector`);
      }
    }
    for (const name of ['api', 'runtime', 'web', 'worker']) {
      const item = deployment(name);
      const expectedSelector = {
        app: expectedPodApp(options.environment, name, manifest),
        'combo.build/release-track': 'release-v1',
      };
      if (
        JSON.stringify(item.spec?.selector?.matchLabels) !== JSON.stringify(expectedSelector) ||
        Object.entries(expectedSelector).some(
          ([key, value]) => item.spec?.template?.metadata?.labels?.[key] !== value,
        )
      ) {
        fail(`${item.metadata.name} does not have an isolated release Pod selector`);
      }
    }
    for (const item of deployments) annotateWorkload(item, manifest, manifestDigest);
  } else if (options.phase === 'migrate') {
    const expected = expectedName(options.environment, 'migrate', manifest, options.phase);
    if (
      resources.length !== 1 ||
      resources[0].kind !== 'Job' ||
      resources[0].metadata?.name !== expected
    ) {
      fail(`migrate phase must contain only Job/${expected}`);
    }
    if (containerImage(resources[0], 'migrate') !== manifest.images.api) {
      fail('migration must use the API image');
    }
    annotateWorkload(resources[0], manifest, manifestDigest);
  } else if (options.phase === 'foundation') {
    const expected = [
      ['ConfigMap', 'redis-hot-config'],
      ['ConfigMap', 'redis-queue-config'],
      ['Deployment', 'redis-hot'],
      ['Service', 'minio'],
      ['Service', 'postgres'],
      ['Service', 'redis-hot'],
      ['Service', 'redis-queue'],
      ['StatefulSet', 'minio'],
      ['StatefulSet', 'postgres'],
      ['StatefulSet', 'redis-queue'],
    ]
      .map(
        ([kind, name]) =>
          `${kind}/${expectedName(options.environment, name, manifest, options.phase)}`,
      )
      .sort();
    const actual = resources
      .map((resource) => `${resource.kind}/${resource.metadata?.name}`)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`foundation set mismatch: ${actual.join(', ')}`);
    }
    for (const service of resources.filter((resource) => resource.kind === 'Service')) {
      if (service.spec?.type && service.spec.type !== 'ClusterIP') {
        fail('release foundation Services must be ClusterIP');
      }
      if (service.spec?.ports?.some((port) => port.nodePort !== undefined)) {
        fail('release foundation must not contain nodePort');
      }
    }
  } else {
    const expected = [
      `ConfigMap/${expectedName(
        options.environment,
        'minio-init-script',
        manifest,
        options.phase,
      )}`,
      `Job/${expectedName(options.environment, 'minio-init', manifest, options.phase)}`,
    ].sort();
    const actual = resources
      .map((resource) => `${resource.kind}/${resource.metadata?.name}`)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`init set mismatch: ${actual.join(', ')}`);
    }
    const job = resources.find((resource) => resource.kind === 'Job');
    annotateWorkload(job, manifest, manifestDigest);
  }
}

function assertNames(resources, expected, kind) {
  const actual = resources.map((resource) => resource.metadata?.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${kind} set mismatch: ${actual.join(', ')}`);
  }
}

function run(argv) {
  const options = parseOptions(argv);
  const manifest = readReleaseManifest(options.manifest);
  const actualDigest = releaseManifestDigest(manifest);
  if (actualDigest !== options['manifest-digest']) fail('manifest digest mismatch');

  const temporary = mkdtempSync(join(tmpdir(), 'combo-release-render-'));
  try {
    const copiedK8sRoot = join(temporary, 'k8s');
    cpSync(K8S_ROOT, copiedK8sRoot, { recursive: true, dereference: false });
    const copiedRoot = join(copiedK8sRoot, 'release');
    replaceFixtureDigests(copiedRoot, manifest);
    const overlay = ['foundation', 'init'].includes(options.phase)
      ? join(copiedK8sRoot, 'environments', options.environment, options.phase)
      : join(copiedRoot, 'overlays', options.environment, options.phase);
    if (options.environment !== 'test' && ['apps', 'migrate'].includes(options.phase)) {
      const kustomization = join(overlay, 'kustomization.yaml');
      const source = readFileSync(kustomization, 'utf8');
      if ((source.match(/^namePrefix: release-$/gm) ?? []).length !== 1) {
        fail('release overlay does not have the expected namePrefix contract');
      }
      writeFileSync(
        kustomization,
        source.replace(
          /^namePrefix: release-$/m,
          `namePrefix: ${applicationPrefix(options.environment, manifest)}`,
        ),
      );
    }
    const result = spawnSync(
      'kubectl',
      ['kustomize', '--load-restrictor=LoadRestrictionsNone', overlay],
      { encoding: 'utf8' },
    );
    if (result.error) fail(`cannot execute kubectl: ${result.error.message}`);
    if (result.status !== 0) fail(`kustomize failed: ${result.stderr.trim()}`);

    const documents = parseAllDocuments(result.stdout);
    const resources = documents.map((document) => {
      if (document.errors.length > 0) fail(`invalid rendered YAML: ${document.errors[0].message}`);
      return mapScalars(document.toJS(), options.environment, manifest);
    });
    validateResources(resources, options, manifest, actualDigest);
    const output = resources.map((resource) => stringify(resource)).join('---\n');
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
