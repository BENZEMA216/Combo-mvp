#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readReleaseManifest, releaseManifestDigest } from './release-manifest.mjs';

const ENVIRONMENTS = Object.freeze({
  test: {
    namespace: 'combo-preview',
    environmentCredentialName: 'combo-dev-env',
    additionalCredentialNames: ['combo-dev-session'],
    pullCredentialName: 'combo-dev-registry',
  },
  preview: {
    namespace: 'combo-review',
    environmentCredentialName: 'combo-preview-env',
    additionalCredentialNames: ['combo-preview-bootstrap'],
    pullCredentialName: 'combo-preview-ghcr-pull',
    foundationTrack: 'preview-v1',
  },
  production: {
    namespace: 'combo',
    environmentCredentialName: 'combo-env',
    additionalCredentialNames: [],
    pullCredentialName: 'ghcr-pull',
    foundationTrack: 'production-v1',
  },
});

const FOUNDATION_IMAGES = Object.freeze({
  'Deployment/release-redis-hot':
    'redis@sha256:bb186d083732f669da90be8b0f975a37812b15e913465bb14d845db72a4e3e08',
  'StatefulSet/release-minio':
    'minio/minio@sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0',
  'StatefulSet/release-postgres':
    'postgres@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7',
  'StatefulSet/release-redis-queue':
    'redis@sha256:bb186d083732f669da90be8b0f975a37812b15e913465bb14d845db72a4e3e08',
});
const INIT_IMAGE =
  'minio/mc@sha256:fb8f773eac8ef9d6da0486d5dec2f42f219358bcb8de579d1623d518c9ebd4cc';
const CONFIG_MAP_DATA_DIGESTS = Object.freeze({
  'release-redis-hot-config': '3483cc8fa9365597041b3e814c450caeadaed2dda48df5ead2fdb218ecb65357',
  'release-redis-queue-config': '8d2af3979e00c83bf940f53cc61c4d281bade324f8b7cae46c6575f07f31cd0f',
  'release-minio-init-script': 'd0a07211a19b1e6e09eedf28e6e24487f58c3da74bfbe1520aad6f79f288f5c6',
});
const REVIEW_GATE_DATA_DIGEST = '5a14d790beca2c4f0c0153caf4aba7b0fa148406d2c26ddee0ec590ea858b745';
const REVIEW_GATE_COMMAND = Object.freeze(['/bin/sh', '-euc']);
const REVIEW_GATE_SCRIPT =
  'case "$REVIEW_ACCESS_TOKEN" in\n' +
  "  (*[!0-9a-f]*|'') exit 1 ;;\n" +
  'esac\n' +
  '[ "${#REVIEW_ACCESS_TOKEN}" -eq 64 ] || exit 1\n' +
  "exec /docker-entrypoint.sh nginx -g 'daemon off;'\n";

function fail(message) {
  throw new Error(`Rendered release verification failed: ${message}`);
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
  const allowed = ['manifest', 'manifest-digest', 'environment', 'phase'];
  const unknown = Object.keys(options).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) fail(`unknown option(s): ${unknown.join(', ')}`);
  for (const name of allowed) {
    if (!options[name]) fail(`missing --${name}`);
  }
  if (!Object.hasOwn(ENVIRONMENTS, options.environment)) fail('unknown environment');
  if (!['apps', 'migrate', 'foundation', 'init'].includes(options.phase)) {
    fail('unknown phase');
  }
  if (['foundation', 'init'].includes(options.phase) && options.environment === 'test') {
    fail(`${options.phase} is only valid for Preview and Production`);
  }
  return options;
}

function workloadTemplate(resource) {
  if (resource.kind === 'Job') return resource.spec?.template;
  if (resource.kind === 'Deployment' || resource.kind === 'StatefulSet') {
    return resource.spec?.template;
  }
  return undefined;
}

function resourceIdentity(resource) {
  return `${resource.kind}/${resource.metadata?.name}`;
}

function applicationPrefix(environment, manifest) {
  return environment === 'test' ? '' : `release-${manifest.sourceSha.slice(0, 12)}-`;
}

function exactIdentities(resources, expected, phase) {
  const actual = resources.map(resourceIdentity).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((identity, index) => identity !== wanted[index])
  ) {
    fail(`${phase} resource set is ${actual.join(', ')}`);
  }
}

function containers(resource) {
  const template = workloadTemplate(resource);
  if (!template) return [];
  const regular = template.spec?.containers;
  const init = template.spec?.initContainers ?? [];
  if (!Array.isArray(regular) || regular.length === 0 || !Array.isArray(init)) {
    fail(`${resourceIdentity(resource)} has an invalid container set`);
  }
  return [...regular, ...init];
}

function assertOneContainer(resource, expectedName, expectedImage) {
  const items = containers(resource);
  if (items.length !== 1 || items[0].name !== expectedName || items[0].image !== expectedImage) {
    fail(`${resourceIdentity(resource)} does not use ${expectedName}=${expectedImage}`);
  }
  if (!items[0].image.includes('@sha256:')) {
    fail(`${resourceIdentity(resource)} image is not digest-pinned`);
  }
}

function assertCommand(container, command, args = undefined) {
  if (
    JSON.stringify(container.command) !== JSON.stringify(command) ||
    JSON.stringify(container.args) !== JSON.stringify(args)
  ) {
    fail(`container ${container.name} has an unapproved command`);
  }
}

function visit(value, callback) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!value || typeof value !== 'object') return;
  callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}

function validateCredentialReferences(resources, config) {
  const approvedCredentials = new Set([
    config.environmentCredentialName,
    ...config.additionalCredentialNames,
  ]);
  for (const resource of resources) {
    visit(resource, (value) => {
      if (Object.hasOwn(value, 'secretRef')) {
        if (!approvedCredentials.has(value.secretRef?.name)) {
          fail(`${resourceIdentity(resource)} references an unapproved Secret`);
        }
      }
      if (Object.hasOwn(value, 'secretKeyRef')) {
        if (!approvedCredentials.has(value.secretKeyRef?.name)) {
          fail(`${resourceIdentity(resource)} references an unapproved Secret key`);
        }
      }
      if (Object.hasOwn(value, 'imagePullSecrets')) {
        if (
          !Array.isArray(value.imagePullSecrets) ||
          value.imagePullSecrets.length !== 1 ||
          value.imagePullSecrets[0]?.name !== config.pullCredentialName
        ) {
          fail(`${resourceIdentity(resource)} references an unapproved pull credential`);
        }
      }
      if (
        typeof value.name === 'string' &&
        /(PASSWORD|SECRET|API_KEY|ACCESS_KEY|TOKEN)$/.test(value.name) &&
        typeof value.value === 'string'
      ) {
        fail(`${resourceIdentity(resource)} contains an inline sensitive value`);
      }
    });
  }
}

function validateCommon(resources, options) {
  const config = ENVIRONMENTS[options.environment];
  for (const resource of resources) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
      fail('render contains a non-object resource');
    }
    if (resource.metadata?.namespace !== config.namespace) {
      fail(`${resourceIdentity(resource)} escaped namespace ${config.namespace}`);
    }
    if (['Secret', 'PersistentVolume', 'PersistentVolumeClaim'].includes(resource.kind)) {
      fail(`${resourceIdentity(resource)} is forbidden`);
    }
    if (resource.kind === 'Service') {
      if (resource.spec?.type !== undefined && resource.spec.type !== 'ClusterIP') {
        fail(`${resourceIdentity(resource)} is not ClusterIP`);
      }
      if (resource.spec?.ports?.some((port) => port.nodePort !== undefined)) {
        fail(`${resourceIdentity(resource)} contains a NodePort`);
      }
    }
  }
  validateCredentialReferences(resources, config);
}

function expectedWorkloadAnnotations(manifest, manifestDigest) {
  return {
    'combo.build/source-sha': manifest.sourceSha,
    'combo.build/release-id': manifest.releaseId,
    'combo.build/release-manifest-digest': manifestDigest,
    'combo.build/web-asset-manifest': manifest.webAssetManifest,
    'combo.build/migration-head': manifest.migrationHead,
  };
}

function validateReleaseWorkload(resource, manifest, manifestDigest) {
  const annotations = workloadTemplate(resource)?.metadata?.annotations ?? {};
  for (const [name, value] of Object.entries(
    expectedWorkloadAnnotations(manifest, manifestDigest),
  )) {
    if (annotations[name] !== value) {
      fail(`${resourceIdentity(resource)} has incorrect ${name}`);
    }
  }
  const metadataName = `combo-release-meta-${manifest.sourceSha.slice(0, 12)}`;
  const references = containers(resource).flatMap((container) =>
    (container.envFrom ?? [])
      .filter((entry) => entry.configMapRef)
      .map((entry) => entry.configMapRef.name),
  );
  if (references.length !== 1 || references[0] !== metadataName) {
    fail(`${resourceIdentity(resource)} does not reference immutable release metadata`);
  }
}

function validateApps(resources, options, manifest, manifestDigest) {
  const prefix = applicationPrefix(options.environment, manifest);
  const expectedIdentities = [
    'Service/api',
    'Service/runtime',
    'Service/web',
    'Deployment/api',
    'Deployment/runtime',
    'Deployment/web',
    'Deployment/worker',
  ].map((identity) => {
    const [kind, name] = identity.split('/');
    return `${kind}/${prefix}${name}`;
  });
  if (options.environment === 'preview') {
    expectedIdentities.push(`ConfigMap/${prefix}review-gate`);
  }
  exactIdentities(resources, expectedIdentities, 'apps');
  const byIdentity = new Map(resources.map((resource) => [resourceIdentity(resource), resource]));
  const deployment = (name) => byIdentity.get(`Deployment/${prefix}${name}`);
  assertOneContainer(deployment('api'), 'api', manifest.images.api);
  assertOneContainer(deployment('worker'), 'worker', manifest.images.api);
  assertOneContainer(deployment('runtime'), 'runtime', manifest.images.runtime);
  assertOneContainer(deployment('web'), 'web', manifest.images.web);
  for (const name of ['api', 'worker', 'runtime', 'web']) {
    const resource = deployment(name);
    if (options.environment === 'preview' && name === 'web') {
      assertCommand(containers(resource)[0], REVIEW_GATE_COMMAND, [REVIEW_GATE_SCRIPT]);
    } else {
      assertCommand(containers(resource)[0], undefined);
    }
    validateReleaseWorkload(resource, manifest, manifestDigest);
    const labels = workloadTemplate(resource)?.metadata?.labels ?? {};
    const expectedSelector = {
      app: `${prefix}${name}`,
      'combo.build/release-track': 'release-v1',
    };
    if (
      JSON.stringify(resource.spec?.selector?.matchLabels) !== JSON.stringify(expectedSelector) ||
      Object.entries(expectedSelector).some(([key, value]) => labels[key] !== value)
    ) {
      fail(`${resourceIdentity(resource)} has unsafe Pod selectors`);
    }
  }
  for (const name of ['api', 'runtime', 'web']) {
    const service = byIdentity.get(`Service/${prefix}${name}`);
    const expectedSelector = {
      app: `${prefix}${name}`,
      'combo.build/release-track': 'release-v1',
    };
    if (JSON.stringify(service.spec?.selector) !== JSON.stringify(expectedSelector)) {
      fail(`${resourceIdentity(service)} can select legacy Pods`);
    }
  }
  const web = deployment('web');
  const webContainer = containers(web)[0];
  const reviewToken = (webContainer.env ?? []).filter(
    (entry) => entry.name === 'REVIEW_ACCESS_TOKEN',
  );
  const reviewConfigMaps = (web.spec?.template?.spec?.volumes ?? [])
    .map((volume) => volume.configMap?.name)
    .filter(Boolean);
  const reviewMounts = webContainer.volumeMounts ?? [];
  if (options.environment === 'preview') {
    const gateName = `${prefix}review-gate`;
    const gate = byIdentity.get(`ConfigMap/${gateName}`);
    const gateKeys = Object.keys(gate?.data ?? {}).sort();
    const gateDigest = createHash('sha256').update(JSON.stringify(gate?.data)).digest('hex');
    const expectedMounts = [
      {
        mountPath: '/etc/nginx/templates/default.conf.template',
        name: 'review-nginx',
        readOnly: true,
        subPath: 'default.conf.template',
      },
      {
        mountPath: '/usr/share/nginx/html/__review/bootstrap.html',
        name: 'review-bootstrap-page',
        readOnly: true,
        subPath: 'bootstrap.html',
      },
      {
        mountPath: '/usr/share/nginx/html/__review/enter.html',
        name: 'review-access-page',
        readOnly: true,
        subPath: 'enter.html',
      },
    ];
    if (
      reviewToken.length !== 1 ||
      reviewToken[0].valueFrom?.secretKeyRef?.name !== 'combo-preview-bootstrap' ||
      reviewToken[0].valueFrom?.secretKeyRef?.key !== 'REVIEW_ACCESS_TOKEN' ||
      webContainer.readinessProbe?.httpGet?.path !== '/__review/healthz' ||
      reviewConfigMaps.length !== 3 ||
      !reviewConfigMaps.every((name) => name === gateName) ||
      JSON.stringify(reviewMounts) !== JSON.stringify(expectedMounts) ||
      gate?.immutable !== true ||
      JSON.stringify(gateKeys) !==
        JSON.stringify(['bootstrap.html', 'default.conf.template', 'enter.html']) ||
      gateDigest !== REVIEW_GATE_DATA_DIGEST
    ) {
      fail(`${resourceIdentity(web)} does not preserve the Preview access gate`);
    }
  } else if (
    reviewToken.length !== 0 ||
    reviewConfigMaps.length !== 0 ||
    reviewMounts.some((mount) => mount.name?.startsWith('review-'))
  ) {
    fail(`${resourceIdentity(web)} unexpectedly contains the Preview access gate`);
  }
}

function validateMigrate(resources, options, manifest, manifestDigest) {
  const name = `${applicationPrefix(options.environment, manifest)}migrate`;
  exactIdentities(resources, [`Job/${name}`], 'migrate');
  assertOneContainer(resources[0], 'migrate', manifest.images.api);
  assertCommand(containers(resources[0])[0], [
    'node',
    '--experimental-strip-types',
    'db/scripts/migrate.ts',
  ]);
  validateReleaseWorkload(resources[0], manifest, manifestDigest);
}

function validateFoundation(resources, options) {
  exactIdentities(
    resources,
    [
      'ConfigMap/release-redis-hot-config',
      'ConfigMap/release-redis-queue-config',
      'Deployment/release-redis-hot',
      'Service/release-minio',
      'Service/release-postgres',
      'Service/release-redis-hot',
      'Service/release-redis-queue',
      'StatefulSet/release-minio',
      'StatefulSet/release-postgres',
      'StatefulSet/release-redis-queue',
    ],
    'foundation',
  );
  for (const [identity, image] of Object.entries(FOUNDATION_IMAGES)) {
    const resource = resources.find((candidate) => resourceIdentity(candidate) === identity);
    const containerName = identity.includes('postgres')
      ? 'postgres'
      : identity.includes('minio')
        ? 'minio'
        : 'redis';
    assertOneContainer(resource, containerName, image);
    const container = containers(resource)[0];
    if (identity.includes('redis')) {
      assertCommand(container, ['redis-server', '/usr/local/etc/redis/redis.conf']);
    } else if (identity.includes('minio')) {
      assertCommand(container, undefined, ['server', '/data', '--console-address', ':9001']);
    } else {
      assertCommand(container, undefined);
    }
  }
  for (const [name, digest] of Object.entries(CONFIG_MAP_DATA_DIGESTS)) {
    if (name === 'release-minio-init-script') continue;
    const configMap = resources.find(
      (resource) => resource.kind === 'ConfigMap' && resource.metadata.name === name,
    );
    const actual = createHash('sha256').update(JSON.stringify(configMap?.data)).digest('hex');
    if (actual !== digest) fail(`ConfigMap/${name} content differs from the foundation contract`);
  }
  const config = ENVIRONMENTS[options.environment];
  const expectedClaims = new Map([
    ['StatefulSet/release-postgres', '5Gi'],
    ['StatefulSet/release-redis-queue', '1Gi'],
    ['StatefulSet/release-minio', '10Gi'],
  ]);
  for (const resource of resources.filter((item) => item.kind === 'StatefulSet')) {
    const identity = resourceIdentity(resource);
    const expectedSelector = {
      app: resource.metadata.name,
      'combo.build/environment-foundation': config.foundationTrack,
    };
    if (
      JSON.stringify(resource.spec?.selector?.matchLabels) !== JSON.stringify(expectedSelector) ||
      Object.entries(expectedSelector).some(
        ([key, value]) => resource.spec?.template?.metadata?.labels?.[key] !== value,
      )
    ) {
      fail(`${identity} does not have an isolated foundation selector`);
    }
    const claim = resource.spec?.volumeClaimTemplates?.[0];
    if (
      !Array.isArray(resource.spec?.volumeClaimTemplates) ||
      resource.spec.volumeClaimTemplates.length !== 1 ||
      claim?.metadata?.name !== 'data' ||
      claim?.metadata?.labels?.['combo.build/data-policy'] !== 'disposable' ||
      claim?.spec?.storageClassName !== 'local-path' ||
      JSON.stringify(claim?.spec?.accessModes) !== JSON.stringify(['ReadWriteOnce']) ||
      claim?.spec?.resources?.requests?.storage !== expectedClaims.get(identity)
    ) {
      fail(`${identity} lacks its exact disposable data claim template`);
    }
    if (
      (resource.spec?.template?.spec?.volumes ?? []).some(
        (volume) => volume.hostPath || volume.persistentVolumeClaim,
      )
    ) {
      fail(`${identity} contains an unapproved direct storage volume`);
    }
  }
  for (const resource of resources.filter((item) => item.kind === 'Deployment')) {
    const expectedSelector = {
      app: resource.metadata.name,
      'combo.build/environment-foundation': config.foundationTrack,
    };
    if (
      JSON.stringify(resource.spec?.selector?.matchLabels) !== JSON.stringify(expectedSelector) ||
      Object.entries(expectedSelector).some(
        ([key, value]) => resource.spec?.template?.metadata?.labels?.[key] !== value,
      )
    ) {
      fail(`${resourceIdentity(resource)} does not have an isolated foundation selector`);
    }
  }
  for (const resource of resources.filter((item) => item.kind === 'Service')) {
    const expectedSelector = {
      app: resource.metadata.name,
      'combo.build/environment-foundation': config.foundationTrack,
    };
    if (JSON.stringify(resource.spec?.selector) !== JSON.stringify(expectedSelector)) {
      fail(`${resourceIdentity(resource)} can select a legacy foundation Pod`);
    }
  }
}

function validateInit(resources, options, manifest, manifestDigest) {
  const prefix = applicationPrefix(options.environment, manifest);
  exactIdentities(
    resources,
    ['ConfigMap/release-minio-init-script', `Job/${prefix}minio-init`],
    'init',
  );
  const job = resources.find((resource) => resource.kind === 'Job');
  assertOneContainer(job, 'minio-init', INIT_IMAGE);
  assertCommand(containers(job)[0], ['/bin/sh', '/scripts/init-buckets.sh']);
  const script = resources.find((resource) => resource.kind === 'ConfigMap');
  const scriptDigest = createHash('sha256').update(JSON.stringify(script?.data)).digest('hex');
  if (scriptDigest !== CONFIG_MAP_DATA_DIGESTS['release-minio-init-script']) {
    fail('bucket initialization script differs from the contract');
  }
  const annotations = workloadTemplate(job)?.metadata?.annotations ?? {};
  for (const [name, value] of Object.entries(
    expectedWorkloadAnnotations(manifest, manifestDigest),
  )) {
    if (annotations[name] !== value) {
      fail(`Job/${prefix}minio-init has incorrect ${name}`);
    }
  }
}

function readInput() {
  const source = readFileSync(0, 'utf8');
  if (source.length === 0 || source.length > 16 * 1024 * 1024) {
    fail('kubectl JSON input is empty or too large');
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail('kubectl output is not one JSON document');
  }
  const items =
    parsed?.kind === 'List' && Array.isArray(parsed.items)
      ? parsed.items
      : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? [parsed]
        : undefined;
  if (!items) fail('kubectl output is not an object or List');
  return items.map((item) => {
    const source =
      item?.metadata?.annotations?.['kubectl.kubernetes.io/last-applied-configuration'];
    if (typeof source !== 'string') fail('kubectl omitted the source manifest annotation');
    let original;
    try {
      original = JSON.parse(source);
    } catch {
      fail('kubectl source manifest annotation is invalid');
    }
    if (
      original.kind !== item.kind ||
      original.metadata?.name !== item.metadata?.name ||
      original.metadata?.namespace !== item.metadata?.namespace
    ) {
      fail('kubectl source manifest identity changed during validation');
    }
    return original;
  });
}

function run(argv) {
  const options = parseOptions(argv);
  const manifest = readReleaseManifest(options.manifest);
  const digest = releaseManifestDigest(manifest);
  if (digest !== options['manifest-digest']) fail('manifest digest mismatch');
  const resources = readInput();
  validateCommon(resources, options);
  if (options.phase === 'apps') validateApps(resources, options, manifest, digest);
  else if (options.phase === 'migrate') validateMigrate(resources, options, manifest, digest);
  else if (options.phase === 'foundation') validateFoundation(resources, options);
  else validateInit(resources, options, manifest, digest);
  process.stdout.write(`verified ${options.environment}/${options.phase}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
