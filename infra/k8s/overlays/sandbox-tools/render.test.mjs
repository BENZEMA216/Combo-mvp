import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments, parseDocument } from 'yaml';

const overlayDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(overlayDirectory, '../../../..');
const rendered = execFileSync('kubectl', ['kustomize', overlayDirectory], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
});
const parsedDocuments = parseAllDocuments(rendered);
for (const document of parsedDocuments) {
  assert.equal(document.errors.length, 0, document.errors.map((error) => error.message).join('\n'));
}
const resources = parsedDocuments.map((document) => document.toJS());

function resource(kind, name, namespace) {
  const matches = resources.filter(
    (candidate) =>
      candidate?.kind === kind &&
      candidate?.metadata?.name === name &&
      (namespace === undefined || candidate?.metadata?.namespace === namespace),
  );
  assert.equal(matches.length, 1, `expected one ${kind}/${name}, got ${matches.length}`);
  return matches[0];
}

function envByName(deployment) {
  const container = deployment.spec.template.spec.containers.find(({ name }) => name === 'runtime');
  assert.ok(container, 'runtime container is missing');
  return Object.fromEntries(container.env.map((entry) => [entry.name, entry]));
}

function resourcesFromFile(path) {
  const documents = parseAllDocuments(readFileSync(path, 'utf8'));
  for (const document of documents) {
    assert.equal(
      document.errors.length,
      0,
      document.errors.map((error) => error.message).join('\n'),
    );
  }
  return documents.map((document) => document.toJS());
}

function resourcesFromKustomization(path) {
  const output = execFileSync('kubectl', ['kustomize', path], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseAllDocuments(output).map((document) => {
    assert.equal(
      document.errors.length,
      0,
      document.errors.map((error) => error.message).join('\n'),
    );
    return document.toJS();
  });
}

function resourceFrom(source, kind, name, namespace) {
  const matches = source.filter(
    (candidate) =>
      candidate?.kind === kind &&
      candidate?.metadata?.name === name &&
      (namespace === undefined || candidate?.metadata?.namespace === namespace),
  );
  assert.equal(matches.length, 1, `expected one ${kind}/${name}, got ${matches.length}`);
  return matches[0];
}

test('the sandbox overlay remains opt-in and keeps RuntimeClass installation separate', () => {
  const rootKustomization = readFileSync(
    resolve(repositoryRoot, 'infra/k8s/kustomization.yaml'),
    'utf8',
  );
  const overlayKustomization = readFileSync(
    resolve(overlayDirectory, 'kustomization.yaml'),
    'utf8',
  );
  const productionDeploy = readFileSync(resolve(repositoryRoot, 'scripts/deploy-k8s.sh'), 'utf8');
  const continuousDeployment = readFileSync(
    resolve(repositoryRoot, '.github/workflows/cd.yml'),
    'utf8',
  );
  const continuousIntegration = readFileSync(
    resolve(repositoryRoot, '.github/workflows/ci.yml'),
    'utf8',
  );

  assert.doesNotMatch(rootKustomization, /overlays\/sandbox-tools|runtimeclass-gvisor/i);
  assert.doesNotMatch(productionDeploy, /overlays\/sandbox-tools|runtimeclass-gvisor/i);
  assert.doesNotMatch(continuousDeployment, /\brsync\b|sandbox-tools|Dockerfile\.sandboxd/);
  assert.match(continuousDeployment, /combo-release-\$\{\{/);
  assert.match(continuousDeployment, /scripts\/deploy-release\.sh/);
  assert.match(continuousIntegration, /"\$bundle\/rendered\/production"/);
  assert.match(continuousIntegration, /"\$bundle\/infra\/host\/release"/);
  assert.doesNotMatch(
    continuousIntegration.slice(
      continuousIntegration.indexOf('Create and verify the release bundle'),
    ),
    /\$bundle\/.*(?:sandbox-tools|Dockerfile\.sandboxd)/,
  );
  assert.doesNotMatch(overlayKustomization, /maintenance|runtimeclass-gvisor/i);
  assert.equal(
    resources.some(({ kind }) => kind === 'RuntimeClass'),
    false,
  );
  assert.equal(
    resources.some(({ kind }) => kind === 'Pod'),
    false,
    'sandbox Pods must stay lazy',
  );
  assert.equal(
    resources.some(({ kind, metadata }) => kind === 'Deployment' && metadata?.name === 'sandboxd'),
    false,
    'sandboxd must not become a warm Deployment',
  );

  const runtimeClassText = readFileSync(
    resolve(overlayDirectory, 'maintenance/runtimeclass-gvisor.yaml'),
    'utf8',
  );
  const runtimeClassDocument = parseDocument(runtimeClassText);
  assert.equal(runtimeClassDocument.errors.length, 0);
  assert.deepEqual(runtimeClassDocument.toJS(), {
    apiVersion: 'node.k8s.io/v1',
    kind: 'RuntimeClass',
    metadata: { name: 'gvisor' },
    handler: 'runsc',
  });
});

test('the opt-in Runtime snapshot stays identical to production except for explicit namespace', () => {
  const productionRuntime = resourcesFromFile(resolve(repositoryRoot, 'infra/k8s/runtime.yaml'));
  const overlayRuntime = resourcesFromFile(resolve(overlayDirectory, 'runtime-base.yaml'));
  const namespacedProduction = productionRuntime.map((item) => ({
    ...item,
    metadata: { ...item.metadata, namespace: 'combo' },
  }));
  assert.deepEqual(overlayRuntime, namespacedProduction);
});

test('the rendered namespace, quota and Runtime RBAC gate exactly four slots', () => {
  const namespace = resource('Namespace', 'combo-sandbox');
  assert.equal(namespace.metadata.labels['kubernetes.io/metadata.name'], 'combo-sandbox');
  assert.equal(namespace.metadata.labels['pod-security.kubernetes.io/enforce'], 'restricted');
  assert.equal(namespace.metadata.labels['pod-security.kubernetes.io/audit'], 'restricted');
  assert.equal(namespace.metadata.labels['pod-security.kubernetes.io/warn'], 'restricted');

  const quota = resource('ResourceQuota', 'sandbox-capacity', 'combo-sandbox');
  assert.deepEqual(quota.spec.hard, {
    'count/pods': '4',
    'count/persistentvolumeclaims': '4',
    'requests.storage': '4Gi',
    'requests.cpu': '400m',
    'requests.memory': '1536Mi',
    'requests.ephemeral-storage': '512Mi',
    'limits.cpu': '2',
    'limits.memory': '1536Mi',
    'limits.ephemeral-storage': '512Mi',
  });

  const range = resource('LimitRange', 'sandbox-container-bounds', 'combo-sandbox');
  assert.deepEqual(range.spec.limits, [
    {
      type: 'Container',
      max: { cpu: '500m', memory: '384Mi', 'ephemeral-storage': '128Mi' },
      defaultRequest: { cpu: '100m', memory: '384Mi', 'ephemeral-storage': '128Mi' },
      default: { cpu: '500m', memory: '384Mi', 'ephemeral-storage': '128Mi' },
    },
  ]);

  resource('ServiceAccount', 'runtime-sandbox-manager', 'combo');
  const role = resource('Role', 'sandbox-pod-manager', 'combo-sandbox');
  assert.deepEqual(role.rules, [
    {
      apiGroups: [''],
      resources: ['pods'],
      verbs: ['get', 'list', 'create', 'delete', 'patch'],
    },
    {
      apiGroups: [''],
      resources: ['persistentvolumeclaims'],
      resourceNames: [
        'combo-sandbox-workspace-slot-0',
        'combo-sandbox-workspace-slot-1',
        'combo-sandbox-workspace-slot-2',
        'combo-sandbox-workspace-slot-3',
        'combo-sandbox-workspace-slot-4',
      ],
      verbs: ['get', 'patch'],
    },
  ]);
  const binding = resource('RoleBinding', 'runtime-sandbox-manager', 'combo-sandbox');
  assert.deepEqual(binding.subjects, [
    { kind: 'ServiceAccount', name: 'runtime-sandbox-manager', namespace: 'combo' },
  ]);
  assert.deepEqual(binding.roleRef, {
    apiGroup: 'rbac.authorization.k8s.io',
    kind: 'Role',
    name: 'sandbox-pod-manager',
  });
});

test('the four normal workspaces are fixed one-GiB Local PV/PVC slots on an unconfigured node', () => {
  const storageClass = resource('StorageClass', 'combo-sandbox-loopback');
  assert.deepEqual(storageClass, {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: 'combo-sandbox-loopback' },
    provisioner: 'kubernetes.io/no-provisioner',
    volumeBindingMode: 'WaitForFirstConsumer',
    reclaimPolicy: 'Retain',
    allowVolumeExpansion: false,
  });

  for (let slot = 0; slot < 4; slot += 1) {
    const name = `combo-sandbox-workspace-slot-${slot}`;
    const volume = resource('PersistentVolume', name);
    assert.deepEqual(volume.spec, {
      capacity: { storage: '1Gi' },
      volumeMode: 'Filesystem',
      accessModes: ['ReadWriteOnce'],
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 'combo-sandbox-loopback',
      claimRef: { namespace: 'combo-sandbox', name },
      local: { path: `/var/lib/combo-sandbox-slots/slot-${slot}` },
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                {
                  key: 'kubernetes.io/hostname',
                  operator: 'In',
                  values: ['sandbox-node.invalid'],
                },
              ],
            },
          ],
        },
      },
      mountOptions: ['nodev', 'nosuid'],
    });
    const claim = resource('PersistentVolumeClaim', name, 'combo-sandbox');
    assert.equal(claim.metadata.annotations?.['sandbox.combo.dev/slot-state'], undefined);
    assert.deepEqual(claim.spec, {
      accessModes: ['ReadWriteOnce'],
      volumeMode: 'Filesystem',
      storageClassName: 'combo-sandbox-loopback',
      volumeName: name,
      resources: { requests: { storage: '1Gi' } },
    });
  }
  assert.equal(
    resources.some(
      ({ kind, metadata }) =>
        ['PersistentVolume', 'PersistentVolumeClaim'].includes(kind) &&
        metadata?.name === 'combo-sandbox-workspace-slot-4',
    ),
    false,
  );
});

test('the rendered policies deny both directions and permit only Runtime ingress to sandboxd', () => {
  const deny = resource('NetworkPolicy', 'sandbox-default-deny', 'combo-sandbox');
  assert.deepEqual(deny.spec, {
    podSelector: {},
    policyTypes: ['Ingress', 'Egress'],
  });

  const allow = resource('NetworkPolicy', 'sandbox-ingress-from-runtime', 'combo-sandbox');
  assert.deepEqual(allow.spec, {
    podSelector: {
      matchLabels: {
        'app.kubernetes.io/name': 'sandboxd',
        'app.kubernetes.io/component': 'model-sandbox',
        'app.kubernetes.io/managed-by': 'combo-runtime',
      },
    },
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'combo' },
            },
            podSelector: { matchLabels: { app: 'runtime' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ],
  });
  assert.equal(allow.spec.egress, undefined);
});

test('the Runtime patch enables the fixed backend and references gVisor without rendering it', () => {
  const deployment = resource('Deployment', 'runtime', 'combo');
  assert.equal(deployment.spec.replicas, 2);
  assert.equal(deployment.spec.template.spec.serviceAccountName, 'runtime-sandbox-manager');
  const environment = envByName(deployment);
  assert.equal(environment.SANDBOX_TOOLS_ENABLED.value, 'true');
  assert.equal(environment.SANDBOX_NAMESPACE.value, 'combo-sandbox');
  assert.equal(environment.SANDBOX_CONFIGURATION_REVISION.value, '3');
  assert.equal(environment.SANDBOX_CAPACITY.value, '4');
  assert.equal(environment.SANDBOX_FIFTH_SLOT_VALIDATED.value, 'false');
  assert.equal(environment.SANDBOX_RUNTIME_CLASS.value, 'gvisor');
  assert.equal(environment.SANDBOX_ABSOLUTE_TTL_MS.value, '1800000');
  assert.match(
    environment.SANDBOX_IMAGE.value,
    /^ghcr\.io\/dangdang-tech\/combo-sandboxd@sha256:[a-f0-9]{64}$/,
  );
  assert.deepEqual(environment.SANDBOX_CAPABILITY_PRIVATE_KEY.valueFrom, {
    secretKeyRef: {
      name: 'combo-sandbox-signing',
      key: 'private-key-pkcs8-base64',
    },
  });
});

test('the fifth slot exists only in a separately gated maintenance overlay', () => {
  const fifthDirectory = resolve(overlayDirectory, '../sandbox-tools-fifth-slot');
  const fifthResources = resourcesFromKustomization(fifthDirectory);
  const fifthVolume = resourceFrom(
    fifthResources,
    'PersistentVolume',
    'combo-sandbox-workspace-slot-4',
  );
  assert.equal(fifthVolume.spec.capacity.storage, '1Gi');
  const fifthClaim = resourceFrom(
    fifthResources,
    'PersistentVolumeClaim',
    'combo-sandbox-workspace-slot-4',
    'combo-sandbox',
  );
  assert.equal(fifthClaim.spec.resources.requests.storage, '1Gi');
  assert.equal(fifthClaim.metadata.annotations?.['sandbox.combo.dev/slot-state'], undefined);
  const quota = resourceFrom(fifthResources, 'ResourceQuota', 'sandbox-capacity', 'combo-sandbox');
  assert.equal(quota.spec.hard['count/pods'], '5');
  assert.equal(quota.spec.hard['count/persistentvolumeclaims'], '5');
  assert.equal(quota.spec.hard['requests.storage'], '5Gi');
  const deployment = resourceFrom(fifthResources, 'Deployment', 'runtime', 'combo');
  const environment = envByName(deployment);
  assert.equal(environment.SANDBOX_CONFIGURATION_REVISION.value, '4');
  assert.equal(environment.SANDBOX_CAPACITY.value, '5');
  assert.equal(environment.SANDBOX_FIFTH_SLOT_VALIDATED.value, 'true');
});

test('the loopback preparation helper is explicit, data-disk-only and never changes Kubernetes', () => {
  const script = readFileSync(
    resolve(overlayDirectory, 'maintenance/prepare-loopback-slots.sh'),
    'utf8',
  );
  assert.match(script, /expected_bytes=1073741824/);
  assert.match(script, /\[ -z "\$data_mount" \] \|\| \[ "\$data_mount" = '\/' \]/);
  assert.match(script, /mkfs\.ext4/);
  assert.match(script, /Options=loop,nodev,nosuid,noatime/);
  assert.match(script, /blockdev --getsize64/);
  assert.match(script, /rm -rf -- "\$mount_dir\/lost\+found"/);
  assert.match(script, /SANDBOX_FIFTH_SLOT_LIVE_VALIDATED/);
  assert.doesNotMatch(
    script,
    /^\s*(?:kubectl\b|k3s\s+(?:restart|stop|start)\b|systemctl\s+restart\s+k3s\b)/m,
  );
});
