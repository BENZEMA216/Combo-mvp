import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseManifestDigest, serializeReleaseManifest } from './release-manifest.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const script = join(scriptDirectory, 'reset-release-foundation.sh');
const source = readFileSync(script, 'utf8');
const digest = `sha256:${'a'.repeat(64)}`;

function invoke(args) {
  return spawnSync('bash', [script, '--operation', 'reset', ...args], {
    cwd: scriptDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      COMBO_RELEASE_EVIDENCE_ROOT: '/tmp/not-used-by-input-contracts',
      COMBO_MUTATION_LOCK: '/tmp/not-used-by-input-contracts.lock',
    },
  });
}

test('foundation reset has an explicit closed interface and fixed policy', () => {
  for (const option of [
    '--operation',
    '--environment',
    '--manifest',
    '--manifest-digest',
    '--foundation-yaml',
    '--authority-digest',
    '--request-id',
    '--policy',
    '--output',
    '--reset-roll-forward-evidence',
  ]) {
    assert.match(source, new RegExp(option));
  }
  assert.match(source, /readonly POLICY_VALUE='established-clean-slate-v1'/);
  assert.match(source, /preview\)\s+NAMESPACE=combo-review/);
  assert.match(source, /production\)\s+NAMESPACE=combo/);
  assert.match(source, /AUTHORITY_DIGEST" == "\$MANIFEST_DIGEST/);
  assert.match(source, /combo-foundation-reset-v1[\s\S]*expected_request_id/);
  assert.doesNotMatch(source, /--namespace|--claim|--resource-name|--storage-path/);
});

test('foundation reset keeps deletion and fencing targets closed', () => {
  for (const target of [
    'deployment:release-redis-hot',
    'statefulset:release-postgres',
    'statefulset:release-redis-queue',
    'statefulset:release-minio',
    'service:release-postgres',
    'service:release-redis-queue',
    'service:release-redis-hot',
    'service:release-minio',
    'configmap:release-redis-hot-config',
    'configmap:release-redis-queue-config',
    'configmap:release-minio-init-script',
    'data-release-postgres-0',
    'data-release-redis-queue-0',
    'data-release-minio-0',
  ]) {
    assert.ok(source.includes(target), `missing closed target ${target}`);
  }
  assert.match(source, /\^release-\[0-9a-f\]\{12\}-\(api\|runtime\|worker\)\$/);
  assert.match(source, /\^release-\[0-9a-f\]\{12\}-web\$/);
  assert.match(source, /validate_preserved_web/);
  assert.match(source, /validate_preserved_or_candidate_web/);
  assert.doesNotMatch(source, /delete_uid_preconditioned (deployment|service) "\$web_name"/);
  assert.doesNotMatch(source, /kubectl[\s\S]{0,80}(get|delete)[\s\S]{0,30}secret/i);
});

test('artifact verifier consumes a server-side dry-run before mutation', () => {
  const serverDryRun = source.indexOf('apply --dry-run=server');
  const verifier = source.indexOf('verify-rendered-release.mjs', serverDryRun);
  const firstFence = source.indexOf('fence_writers');
  assert.ok(serverDryRun > 0);
  assert.ok(verifier > serverDryRun);
  assert.ok(firstFence > verifier);
  assert.match(source, /--environment "\$ENVIRONMENT"/);
  assert.match(source, /--phase foundation/);
  assert.match(source, /--manifest-digest "\$MANIFEST_DIGEST"/);
});

test('global reset journal admissions run under both locks before cluster reads', () => {
  const mutationLock = source.indexOf('flock -x 9');
  const trafficLock = source.indexOf('flock -x 8');
  const journalAudit = source.indexOf('\naudit_reset_roll_forward_journals\n');
  const localEvidence = source.indexOf('\nvalidate_reset_roll_forward_evidence\n');
  const foundationAudit = source.indexOf('\naudit_foundation_reset_journals\n');
  const serverDryRun = source.indexOf('"${K[@]}" -n "$NAMESPACE" apply --dry-run=server');

  assert.ok(mutationLock >= 0 && trafficLock > mutationLock);
  assert.ok(journalAudit > trafficLock);
  assert.ok(localEvidence > journalAudit);
  assert.ok(foundationAudit > localEvidence);
  assert.ok(serverDryRun > foundationAudit);
  assert.match(source, /foundation-reset-journal\.mjs" audit/);
  assert.match(source, /--mode "\$mode"/);
});

test('all planned deletes and writer fences are compare-and-swap operations', () => {
  assert.match(source, /preconditions: \{uid: \$uid, resourceVersion: \$resourceVersion\}/);
  assert.match(source, /delete --raw="\$api_path" -f "\$options"/);
  assert.match(source, /changed UID after the immutable plan/);
  assert.match(source, /resource_authority_digest/);
  assert.match(source, /changed deletion authority after the immutable plan/);
  assert.match(source, /--arg resourceVersion "\$current_resource_version"/);
  assert.match(source, /for _ in \$\(seq 1 5\)/);
  assert.match(source, /deletionTimestamp \/\/ empty/);
  assert.match(source, /old PV name was reused before exact removal/);
  assert.match(source, /planned PV changed authority before PVC deletion/);
});

test('workload surface closes scheduler and controller ownership escape paths', () => {
  const workloadSurface = source.slice(
    source.indexOf('validate_namespace_workload_surface()'),
    source.indexOf('\ncapture_targets()', source.indexOf('validate_namespace_workload_surface()')),
  );
  for (const resource of ['cronjobs', 'daemonsets', 'replicationcontrollers']) {
    assert.match(workloadSurface, new RegExp(`get ${resource} -o json`));
  }
  for (const resource of [
    'deployments',
    'statefulsets',
    'jobs',
    'replicasets',
    'pods',
    'cronjobs',
    'daemonsets',
    'replicationcontrollers',
  ]) {
    assert.match(workloadSurface, new RegExp(`--slurpfile ${resource}`));
    assert.doesNotMatch(workloadSurface, new RegExp(`--argjson ${resource}`));
  }
  assert.match(workloadSurface, /def exact_list:/);
  assert.match(workloadSurface, /length == 1 and \(\.\[0\] \| exact_list\)/);
  assert.match(workloadSurface, /\(\$cronjobs\[0\]\.items \| length\) == 0/);
  assert.match(workloadSurface, /\(\$daemonsets\[0\]\.items \| length\) == 0/);
  assert.match(workloadSurface, /\(\$replicationcontrollers\[0\]\.items \| length\) == 0/);
  assert.match(workloadSurface, /exact_owner\(\$deploymentItems; "apps\/v1"; "Deployment"\)/);
  assert.match(workloadSurface, /exact_owner\(\$replicasetItems; "apps\/v1"; "ReplicaSet"\)/);
  assert.match(workloadSurface, /exact_owner\(\$statefulsetItems; "apps\/v1"; "StatefulSet"\)/);
  assert.match(workloadSurface, /exact_owner\(\$jobItems; "batch\/v1"; "Job"\)/);
  assert.doesNotMatch(
    workloadSurface,
    /release-\[0-9a-f\]\{12\}-\(api\|runtime\|web\|worker\|review-gate\)/,
  );
});

test('active Web route binds exact Service ports and live forwarder identity', () => {
  assert.match(source, /\.spec\.ports \| type == "array" and length == 1/);
  assert.match(source, /\.spec\.ports\[0\]\.name == "http"/);
  assert.match(source, /\.spec\.ports\[0\]\.port == 80/);
  assert.match(source, /\.spec\.ports\[0\]\.targetPort == 80/);
  assert.match(source, /\.spec\.ports\[0\]\.protocol == "TCP"/);
  assert.match(source, /\.spec\.ports\[0\]\.nodePort == null/);
  assert.match(source, /systemctl is-enabled --quiet "\$WEB_FORWARD_UNIT"/);
  assert.match(source, /systemctl is-active --quiet "\$WEB_FORWARD_UNIT"/);
  assert.match(source, /PUBLIC_ORIGIN=https:\/\/review\.43-160-242-46\.sslip\.io/);
  assert.match(source, /preview_gate_is_closed/);
  assert.match(source, /\[\[ "\$health_status" == 200 \]\]/);
  assert.match(source, /\[\[ "\$version_status" == 401 \]\]/);
  assert.match(source, /\^X-Combo-Review-Gate:\[\[:space:\]\]\*required\[\[:space:\]\]\*\$/);
  assert.match(source, /"http:\/\/127\.0\.0\.1:\$\{WEB_FORWARD_PORT\}" loopback/);
  assert.match(source, /preview_gate_is_closed "\$PUBLIC_ORIGIN" public/);
  assert.match(source, /exec "deployment\/\$name" -c web --/);
  assert.match(source, /Cookie: combo_review_access=\$REVIEW_ACCESS_TOKEN/);
  assert.match(source, /capture_preview_route_version "\$name" "\$route_version"/);
  assert.doesNotMatch(source, /get secret/);
  assert.match(source, /routeVersionDigest/);
  assert.match(source, /\.preservedWeb \| del\(\.resourceVersion, \.serviceResourceVersion\)/);
});

test('durable state machine is bound to an immutable plan and exact storage identities', () => {
  for (const phase of ['planned', 'storage-removed', 'foundation-ready']) {
    assert.ok(source.includes(phase), `missing phase ${phase}`);
  }
  assert.match(source, /foundation-reset-plan\.json/);
  assert.match(source, /foundation-reset-checkpoint\.json/);
  assert.match(source, /foundation-reset-evidence\.json/);
  assert.match(source, /plan_digest=\$\(file_digest "\$plan"\)/);
  assert.match(source, /new PVC reused the old UID/);
  assert.match(source, /new PV reused the old UID/);
  assert.match(source, /new PVC reused the old storage path/);
  assert.match(source, /foundationSnapshotDigest/);
  assert.match(source, /foundation-reset-ready\.json/);
  assert.match(source, /diff -f "\$FOUNDATION_YAML"/);
  assert.match(source, /mv -fT "\$stage" "\$target"/);
});

test('success evidence has the exact public schema and fixed checks', () => {
  for (const key of [
    'schemaVersion',
    'status',
    'policy',
    'requestId',
    'authorityDigest',
    'environment',
    'namespace',
    'sourceSha',
    'releaseId',
    'manifestDigest',
    'planDigest',
    'startedAt',
    'storageClearedAt',
    'foundationReadyAt',
    'oldStorage',
    'newStorage',
    'foundation',
    'preservedWeb',
    'checks',
    'completedAt',
  ]) {
    assert.ok(source.includes(`"${key}"`) || source.includes(`${key}:`), `missing ${key}`);
  }
  assert.match(source, /writersFenced: true/);
  assert.match(source, /oldStorageRemoved: true/);
  assert.match(source, /newStorageIdentity: true/);
  assert.match(source, /activeWebPreserved: true/);
  assert.match(source, /supersededResetContinuity: true/);
  assert.match(source, /authorization[\s\S]*"superseding-reset"/);
  assert.match(source, /PREDECESSOR_RESET_EVIDENCE=\$predecessor_real/);
  assert.match(source, /chmod 0600 "\$OUTPUT"/);
  assert.match(source, /foundation_reset_reused=true evidence_ready=true/);
  assert.match(source, /global foundation reset journal audit failed/);
  assert.match(source, /a pending clean-slate boundary requires controlled roll-forward/);
  assert.match(source, /this candidate entered reset roll-forward and requires its evidence/);
  assert.match(source, /reset roll-forward evidence does not authorize this exact reuse/);
  assert.match(source, /COMBO_RELEASE_WEB_SERVICE/);
  assert.match(source, /active release traffic state/);
  assert.match(source, /COMBO_RELEASE_TRAFFIC_LOCK/);
});

test('CLI fails closed before any cluster access for malformed authority', () => {
  const result = invoke([
    '--environment',
    'preview',
    '--manifest',
    '/does/not/exist',
    '--manifest-digest',
    digest,
    '--foundation-yaml',
    '/does/not/exist',
    '--authority-digest',
    'not-a-digest',
    '--request-id',
    digest,
    '--policy',
    'established-clean-slate-v1',
    '--output',
    '/does/not/exist',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid authority digest/);
  assert.doesNotMatch(result.stderr, /kubectl|Secret/);
});

test('CLI rejects a policy downgrade', () => {
  const result = invoke([
    '--environment',
    'production',
    '--manifest',
    '/does/not/exist',
    '--manifest-digest',
    digest,
    '--foundation-yaml',
    '/does/not/exist',
    '--authority-digest',
    digest,
    '--request-id',
    digest,
    '--policy',
    'best-effort',
    '--output',
    '/does/not/exist',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported foundation reset operation or policy/);
});

test('CLI rejects symbolic-link inputs and output paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'combo-foundation-reset-contract-'));
  try {
    const manifest = join(directory, 'release.json');
    const foundation = join(directory, 'foundation.yaml');
    const linkedManifest = join(directory, 'linked-release.json');
    const linkedOutput = join(directory, 'evidence.json');
    writeFileSync(manifest, '{}\n');
    writeFileSync(foundation, '---\n');
    symlinkSync(manifest, linkedManifest);
    symlinkSync(join(directory, 'missing-output'), linkedOutput);

    const common = [
      '--environment',
      'preview',
      '--manifest-digest',
      digest,
      '--foundation-yaml',
      foundation,
      '--authority-digest',
      digest,
      '--request-id',
      digest,
      '--policy',
      'established-clean-slate-v1',
    ];
    const linkedInputResult = invoke([
      ...common,
      '--manifest',
      linkedManifest,
      '--output',
      join(directory, 'regular-output.json'),
    ]);
    assert.equal(linkedInputResult.status, 1);
    assert.match(linkedInputResult.stderr, /input must be a regular file/);

    const linkedOutputResult = invoke([
      ...common,
      '--manifest',
      manifest,
      '--output',
      linkedOutput,
    ]);
    assert.equal(linkedOutputResult.status, 1);
    assert.match(linkedOutputResult.stderr, /output path must not be a symbolic link/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('behavior: storage-removed resumes and Preview reset supersession stays linear', () => {
  const directory = mkdtempSync(join(tmpdir(), 'combo-foundation-reset-behavior-'));
  try {
    const bin = join(directory, 'bin');
    const storage = join(directory, 'storage');
    const evidenceRoot = join(directory, 'evidence');
    const stateFile = join(directory, 'state.json');
    const failApplyOnce = join(directory, 'fail-apply-once');
    const manifestFile = join(directory, 'release.json');
    const foundationFile = join(directory, 'foundation.yaml');
    const output = join(directory, 'reset-evidence.json');
    const trafficStateRoot = join(directory, 'traffic');
    const forwardEnv = join(directory, 'preview-web-forward.env');
    const nginxConfig = join(directory, 'preview-nginx.conf');
    const routeVersion = join(directory, 'route-version.json');
    const bumpDeleteRvOnce = join(directory, 'bump-delete-rv-once');
    const failOptionalGetOnce = join(directory, 'fail-optional-get-once');
    const kubectlCommandLog = join(directory, 'kubectl-commands.log');
    mkdirSync(bin);
    mkdirSync(storage);
    mkdirSync(join(trafficStateRoot, 'preview'), { recursive: true });
    writeFileSync(failApplyOnce, '1\n');
    writeFileSync(nginxConfig, 'server { listen 443 ssl; }\n');

    const sourceSha = '1'.repeat(40);
    const manifest = {
      schemaVersion: 1,
      sourceSha,
      releaseId: `release-${sourceSha}`,
      images: {
        api: `ghcr.io/dangdang-tech/combo-api@sha256:${'2'.repeat(64)}`,
        runtime: `ghcr.io/dangdang-tech/combo-runtime@sha256:${'3'.repeat(64)}`,
        web: `ghcr.io/dangdang-tech/combo-web@sha256:${'4'.repeat(64)}`,
      },
      migrationHead: '0008_application_database_roles.sql',
      builtAt: '2026-07-29T00:00:00.000Z',
      webAssetManifest: `sha256:${'5'.repeat(64)}`,
    };
    const manifestDigest = releaseManifestDigest(manifest);
    const requestId = `sha256:${createHash('sha256')
      .update(
        [
          'combo-foundation-reset-v1',
          'preview',
          sourceSha,
          manifestDigest,
          'established-clean-slate-v1',
        ].join('\0'),
      )
      .digest('hex')}`;
    writeFileSync(manifestFile, serializeReleaseManifest(manifest));
    writeFileSync(foundationFile, 'apiVersion: v1\nkind: List\nitems: []\n');

    const namespace = 'combo-review';
    const track = 'preview-v1';
    const activeSource = '0'.repeat(40);
    const activeManifestDigest = `sha256:${'6'.repeat(64)}`;
    const activeWebImage = `ghcr.io/dangdang-tech/combo-web@sha256:${'7'.repeat(64)}`;
    const resources = {};
    const resource = (kind, name, uid, extra = {}) => {
      resources[`${kind}/${name}`] = {
        apiVersion: 'v1',
        kind,
        metadata: {
          name,
          namespace,
          uid,
          resourceVersion: '1',
          ...(extra.metadata ?? {}),
        },
        ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'metadata')),
      };
    };
    const activeWeb = 'release-000000000000-web';
    resource('deployment', activeWeb, 'web-uid', {
      metadata: { labels: { 'combo.build/release-track': 'release-v1' } },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: activeWeb,
            'combo.build/release-track': 'release-v1',
          },
        },
        template: {
          metadata: {
            labels: {
              app: activeWeb,
              'combo.build/release-track': 'release-v1',
            },
            annotations: {
              'combo.build/source-sha': activeSource,
              'combo.build/release-id': `release-${activeSource}`,
              'combo.build/release-manifest-digest': activeManifestDigest,
            },
          },
          spec: { containers: [{ name: 'web', image: activeWebImage }] },
        },
      },
      status: { readyReplicas: 1, availableReplicas: 1 },
    });
    resource('service', activeWeb, 'web-service-uid', {
      metadata: { labels: { 'combo.build/release-track': 'release-v1' } },
      spec: {
        type: 'ClusterIP',
        selector: {
          app: activeWeb,
          'combo.build/release-track': 'release-v1',
        },
        ports: [{ name: 'http', port: 80, targetPort: 80, protocol: 'TCP' }],
      },
    });
    for (const name of ['api', 'runtime', 'worker']) {
      const deploymentName = `release-000000000000-${name}`;
      resource('deployment', deploymentName, `${name}-uid`, {
        metadata: { labels: { 'combo.build/release-track': 'release-v1' } },
        spec: {
          replicas: 1,
          selector: {
            matchLabels: {
              app: deploymentName,
              'combo.build/release-track': 'release-v1',
            },
          },
          template: {
            metadata: {
              labels: {
                app: deploymentName,
                'combo.build/release-track': 'release-v1',
              },
              annotations: {
                'combo.build/source-sha': activeSource,
                'combo.build/release-id': `release-${activeSource}`,
                'combo.build/release-manifest-digest': activeManifestDigest,
              },
            },
            spec: {
              containers: [
                {
                  name,
                  image:
                    name === 'runtime'
                      ? `ghcr.io/dangdang-tech/combo-runtime@sha256:${'9'.repeat(64)}`
                      : `ghcr.io/dangdang-tech/combo-api@sha256:${'a'.repeat(64)}`,
                },
              ],
            },
          },
        },
        status: { readyReplicas: 1, availableReplicas: 1 },
      });
    }
    resource('deployment', 'release-redis-hot', 'redis-hot-uid', {
      spec: { replicas: 1 },
      status: { readyReplicas: 1, availableReplicas: 1 },
    });
    for (const name of ['release-postgres', 'release-redis-queue', 'release-minio']) {
      resource('statefulset', name, `${name}-uid`, {
        spec: { replicas: 1 },
        status: { readyReplicas: 1, availableReplicas: 1 },
      });
    }
    for (const name of [
      'release-postgres',
      'release-redis-queue',
      'release-redis-hot',
      'release-minio',
    ]) {
      resource('service', name, `${name}-service-uid`, { spec: {} });
    }
    for (const name of [
      'release-redis-hot-config',
      'release-redis-queue-config',
      'release-minio-init-script',
    ]) {
      resource('configmap', name, `${name}-uid`, { data: {} });
    }
    for (const key of [
      'deployment/release-redis-hot',
      'statefulset/release-postgres',
      'statefulset/release-redis-queue',
      'statefulset/release-minio',
      'service/release-postgres',
      'service/release-redis-queue',
      'service/release-redis-hot',
      'service/release-minio',
      'configmap/release-redis-hot-config',
      'configmap/release-redis-queue-config',
      'configmap/release-minio-init-script',
    ]) {
      resources[key].metadata.labels = {
        'combo.build/environment-foundation': track,
      };
    }
    resource('job', 'release-000000000000-migrate', 'migrate-job-uid', {
      spec: {
        template: {
          metadata: {
            annotations: {
              'combo.build/source-sha': activeSource,
              'combo.build/release-id': `release-${activeSource}`,
              'combo.build/release-manifest-digest': activeManifestDigest,
            },
          },
          spec: { containers: [{ name: 'migrate', image: 'writer-migrate' }] },
        },
      },
      status: {},
    });
    writeFileSync(forwardEnv, `COMBO_RELEASE_WEB_SERVICE=${activeWeb}\n`);
    const nginxDigest = `sha256:${createHash('sha256')
      .update(readFileSync(nginxConfig))
      .digest('hex')}`;
    writeFileSync(
      join(trafficStateRoot, 'preview', 'current.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        environment: 'preview',
        sourceSha: activeSource,
        releaseId: `release-${activeSource}`,
        manifestDigest: activeManifestDigest,
        canaryNginxSha256: nginxDigest,
        formalNginxSha256: null,
        webService: activeWeb,
      })}\n`,
    );
    writeFileSync(
      routeVersion,
      `${JSON.stringify({
        schemaVersion: 1,
        environment: 'preview',
        sourceSha: activeSource,
        releaseId: `release-${activeSource}`,
        builtAt: '2026-07-29T00:00:00.000Z',
        releaseManifestDigest: activeManifestDigest,
        webAssetManifest: `sha256:${'8'.repeat(64)}`,
      })}\n`,
    );

    const claims = [
      'data-release-postgres-0',
      'data-release-redis-queue-0',
      'data-release-minio-0',
    ];
    const pvs = {};
    for (const claim of claims) {
      const claimUid = `old-${claim}-uid`;
      const volume = `pvc-${claimUid}`;
      const path = join(storage, `${volume}_${namespace}_${claim}`);
      mkdirSync(path);
      resource('pvc', claim, claimUid, {
        metadata: {
          labels: {
            'combo.build/data-policy': 'disposable',
            'combo.build/environment-foundation': track,
          },
        },
        spec: {
          storageClassName: 'local-path',
          accessModes: ['ReadWriteOnce'],
          volumeMode: 'Filesystem',
          volumeName: volume,
        },
        status: { phase: 'Bound' },
      });
      pvs[volume] = {
        apiVersion: 'v1',
        kind: 'PersistentVolume',
        metadata: { name: volume, uid: `${volume}-uid`, resourceVersion: '1' },
        spec: {
          storageClassName: 'local-path',
          accessModes: ['ReadWriteOnce'],
          volumeMode: 'Filesystem',
          persistentVolumeReclaimPolicy: 'Delete',
          claimRef: { namespace, name: claim, uid: claimUid },
          local: { path },
        },
        status: { phase: 'Bound' },
      };
    }
    writeFileSync(stateFile, `${JSON.stringify({ resources, pvs, generation: 1 })}\n`);

    const fakeKubectl = join(bin, 'kubectl');
    writeFileSync(
      fakeKubectl,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const stateFile = process.env.FAKE_KUBE_STATE;
const storageRoot = process.env.COMBO_K3S_STORAGE_ROOT;
let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
let args = process.argv.slice(2);
for (let index = 0; index < args.length;) {
  if (args[index] === '--kubeconfig' || args[index] === '-n') args.splice(index, 2);
  else index += 1;
}
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state) + '\\n');
const fail = () => process.exit(1);
const pluralKind = {
  deployments: 'deployment', services: 'service', jobs: 'job',
  statefulsets: 'statefulset', configmaps: 'configmap',
  persistentvolumeclaims: 'pvc', replicasets: 'replicaset',
  cronjobs: 'cronjob', daemonsets: 'daemonset',
  replicationcontrollers: 'replicationcontroller'
};
const command = args.shift();
if (process.env.FAKE_KUBE_COMMAND_LOG) {
  fs.appendFileSync(process.env.FAKE_KUBE_COMMAND_LOG, [command, ...args].join(' ') + '\\n');
}
if (command === 'exec') {
  if (process.env.FAKE_AUTHENTICATED_ROUTE_FAILURE) fail();
  if (!/^deployment\\/release-[0-9a-f]{12}-web$/.test(args[0]) ||
      args[1] !== '-c' || args[2] !== 'web' || args[3] !== '--') fail();
  process.stdout.write(fs.readFileSync(process.env.FAKE_VERSION_JSON));
  process.exit(0);
}
if (command === 'create') {
  process.stdout.write([
    'configmap/release-redis-hot-config',
    'configmap/release-redis-queue-config',
    'deployment.apps/release-redis-hot',
    'service/release-minio',
    'service/release-postgres',
    'service/release-redis-hot',
    'service/release-redis-queue',
    'statefulset.apps/release-minio',
    'statefulset.apps/release-postgres',
    'statefulset.apps/release-redis-queue'
  ].join('\\n') + '\\n');
  process.exit(0);
}
if (command === 'get') {
  const target = args.shift();
  if (process.env.FAKE_FAIL_OPTIONAL_GET_ONCE &&
      fs.existsSync(process.env.FAKE_FAIL_OPTIONAL_GET_ONCE) &&
      args.includes('--ignore-not-found') &&
      target === 'configmap/release-minio-init-script') {
    fs.unlinkSync(process.env.FAKE_FAIL_OPTIONAL_GET_ONCE);
    fail();
  }
  if (target === 'pods') {
    const selector = args.find((value) => value.startsWith('app='));
    if (!selector) {
      const items = Object.entries(state.resources)
        .filter(([key]) => key.startsWith('pod/'))
        .map(([, value]) => value);
      process.stdout.write(JSON.stringify({items}));
      process.exit(0);
    }
    const name = selector?.slice(4);
    const deployment = state.resources['deployment/' + name];
    const items = deployment && deployment.spec.replicas > 0
      ? [{metadata: {name: name + '-pod'}}] : [];
    process.stdout.write(JSON.stringify({items}));
    process.exit(0);
  }
  if (pluralKind[target]) {
    const kind = pluralKind[target];
    const items = Object.entries(state.resources)
      .filter(([key]) => key.startsWith(kind + '/'))
      .map(([, value]) => value);
    fs.writeFileSync(1, JSON.stringify({items}));
    process.exit(0);
  }
  if (target.startsWith('pv/')) {
    const value = state.pvs[target.slice(3)];
    if (!value) fail();
    process.stdout.write(JSON.stringify(value));
    process.exit(0);
  }
  const value = state.resources[target];
  if (!value) {
    if (args.includes('--ignore-not-found')) process.exit(0);
    fail();
  }
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
}
if (command === 'patch') {
  const target = args.shift();
  const value = state.resources[target];
  if (!value) fail();
  const patchArg = args.find((item) => item.startsWith('--patch-file='));
  const patch = JSON.parse(fs.readFileSync(patchArg.slice(13), 'utf8'));
  if (patch[0].value !== value.metadata.uid ||
      patch[1].value !== value.metadata.resourceVersion) fail();
  value.spec.replicas = 0;
  value.status.readyReplicas = 0;
  value.status.availableReplicas = 0;
  value.metadata.resourceVersion = String(Number(value.metadata.resourceVersion) + 1);
  save();
  process.stdout.write('{}');
  process.exit(0);
}
if (command === 'delete') {
  const raw = args.find((value) => value.startsWith('--raw=')).slice(6);
  const optionsArg = args.find((value) => value === '-f');
  const options = JSON.parse(fs.readFileSync(args[args.indexOf(optionsArg) + 1], 'utf8'));
  const segments = raw.split('/');
  const name = segments.at(-1);
  const plural = segments.at(-2);
  const kinds = {
    deployments: 'deployment', statefulsets: 'statefulset', jobs: 'job',
    services: 'service', configmaps: 'configmap',
    persistentvolumeclaims: 'pvc'
  };
  const key = kinds[plural] + '/' + name;
  const value = state.resources[key];
  if (process.env.FAKE_BUMP_DELETE_RV_ONCE &&
      fs.existsSync(process.env.FAKE_BUMP_DELETE_RV_ONCE) &&
      key.endsWith('-api')) {
    fs.unlinkSync(process.env.FAKE_BUMP_DELETE_RV_ONCE);
    value.metadata.resourceVersion =
      String(Number(value.metadata.resourceVersion) + 1);
    save();
    fail();
  }
  if (!value ||
      value.metadata.uid !== options.preconditions.uid ||
      value.metadata.resourceVersion !== options.preconditions.resourceVersion) fail();
  if (kinds[plural] === 'pvc') {
    const volume = value.spec.volumeName;
    const pv = state.pvs[volume];
    if (pv) {
      fs.rmSync(pv.spec.local.path, {recursive: true, force: true});
      delete state.pvs[volume];
    }
  }
  delete state.resources[key];
  save();
  process.stdout.write('{}');
  process.exit(0);
}
if (command === 'apply') {
  if (args.includes('--dry-run=server')) {
    process.stdout.write('{}');
    process.exit(0);
  }
  if (fs.existsSync(process.env.FAKE_FAIL_APPLY_ONCE)) {
    fs.unlinkSync(process.env.FAKE_FAIL_APPLY_ONCE);
    fail();
  }
  const namespace = 'combo-review';
  const track = 'preview-v1';
  const add = (kind, name, extra = {}) => {
    const uid = 'new-' + (++state.generation) + '-' + name + '-uid';
    state.resources[kind + '/' + name] = {
      apiVersion: 'v1', kind,
      metadata: {name, namespace, uid, resourceVersion: '1',
        labels: {'combo.build/environment-foundation': track},
        ...(extra.metadata || {})},
      ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'metadata'))
    };
  };
  add('deployment', 'release-redis-hot', {
    spec: {replicas: 1}, status: {readyReplicas: 1, availableReplicas: 1}
  });
  for (const name of ['release-postgres', 'release-redis-queue', 'release-minio']) {
    add('statefulset', name, {
      spec: {replicas: 1}, status: {readyReplicas: 1, availableReplicas: 1}
    });
  }
  for (const name of [
    'release-postgres', 'release-redis-queue', 'release-redis-hot', 'release-minio'
  ]) add('service', name, {spec: {}});
  for (const name of ['release-redis-hot-config', 'release-redis-queue-config']) {
    add('configmap', name, {data: {}});
  }
  for (const claim of [
    'data-release-postgres-0', 'data-release-redis-queue-0', 'data-release-minio-0'
  ]) {
    const claimUid = 'new-' + (++state.generation) + '-' + claim + '-uid';
    const volume = 'pvc-' + claimUid;
    const storagePath = path.join(storageRoot, volume + '_' + namespace + '_' + claim);
    fs.mkdirSync(storagePath);
    state.resources['pvc/' + claim] = {
      apiVersion: 'v1', kind: 'pvc',
      metadata: {name: claim, namespace, uid: claimUid, resourceVersion: '1',
        labels: {'combo.build/data-policy': 'disposable',
          'combo.build/environment-foundation': track}},
      spec: {storageClassName: 'local-path', accessModes: ['ReadWriteOnce'],
        volumeMode: 'Filesystem', volumeName: volume},
      status: {phase: 'Bound'}
    };
    state.pvs[volume] = {
      apiVersion: 'v1', kind: 'PersistentVolume',
      metadata: {name: volume, uid: volume + '-uid', resourceVersion: '1'},
      spec: {storageClassName: 'local-path', accessModes: ['ReadWriteOnce'],
        volumeMode: 'Filesystem', persistentVolumeReclaimPolicy: 'Delete',
        claimRef: {namespace, name: claim, uid: claimUid}, local: {path: storagePath}},
      status: {phase: 'Bound'}
    };
  }
  save();
  process.stdout.write('{}');
  process.exit(0);
}
if (command === 'rollout' || command === 'wait' || command === 'diff') process.exit(0);
fail();
`,
    );
    chmodSync(fakeKubectl, 0o755);
    const fakeNode = join(bin, 'node');
    writeFileSync(
      fakeNode,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == */verify-rendered-release.mjs ]]; then
  cat >/dev/null
  exit 0
fi
exec ${JSON.stringify(process.execPath)} "$@"
`,
    );
    chmodSync(fakeNode, 0o755);
    const fakeSudo = join(bin, 'sudo');
    writeFileSync(
      fakeSudo,
      '#!/usr/bin/env bash\nset -euo pipefail\n[[ "${1:-}" == -n ]] && shift\nexec "$@"\n',
    );
    chmodSync(fakeSudo, 0o755);
    const fakeSystemctl = join(bin, 'systemctl');
    writeFileSync(
      fakeSystemctl,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${FAKE_INACTIVE_FORWARDER:-}" ]]; then
  exit 1
fi
case "\${1:-}" in
  is-enabled|is-active) exit 0 ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(fakeSystemctl, 0o755);
    const fakeCurl = join(bin, 'curl');
    writeFileSync(
      fakeCurl,
      `#!/usr/bin/env bash
set -euo pipefail
url=\${!#}
if [[ "$url" == */__review/healthz ]]; then
  printf '%s' "\${FAKE_HEALTH_STATUS:-200}"
  exit 0
fi
if [[ "$url" == */version.json ]]; then
  header_file=''
  while (($# > 0)); do
    if [[ "$1" == --dump-header ]]; then
      header_file=$2
      break
    fi
    shift
  done
  if [[ -n "$header_file" ]]; then
    {
      printf 'HTTP/1.1 %s Test\\r\\n' "\${FAKE_GATE_STATUS:-401}"
      if [[ -n "\${FAKE_GATE_HEADER-X-Combo-Review-Gate: required}" ]]; then
        printf '%s\\r\\n' "\${FAKE_GATE_HEADER-X-Combo-Review-Gate: required}"
      fi
      printf '\\r\\n'
    } >"$header_file"
  fi
  printf '%s' "\${FAKE_GATE_STATUS:-401}"
  exit 0
fi
exit 1
`,
    );
    chmodSync(fakeCurl, 0o755);

    const args = [
      '--operation',
      'reset',
      '--environment',
      'preview',
      '--manifest',
      manifestFile,
      '--manifest-digest',
      manifestDigest,
      '--foundation-yaml',
      foundationFile,
      '--authority-digest',
      manifestDigest,
      '--request-id',
      requestId,
      '--policy',
      'established-clean-slate-v1',
      '--output',
      output,
    ];
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_KUBE_STATE: stateFile,
      FAKE_FAIL_APPLY_ONCE: failApplyOnce,
      FAKE_BUMP_DELETE_RV_ONCE: bumpDeleteRvOnce,
      FAKE_FAIL_OPTIONAL_GET_ONCE: failOptionalGetOnce,
      FAKE_VERSION_JSON: routeVersion,
      FAKE_KUBE_COMMAND_LOG: kubectlCommandLog,
      KUBECONFIG: join(directory, 'kubeconfig'),
      COMBO_RELEASE_EVIDENCE_ROOT: evidenceRoot,
      COMBO_MUTATION_LOCK: join(directory, 'mutation.lock'),
      COMBO_RELEASE_TRAFFIC_LOCK: join(directory, 'traffic.lock'),
      COMBO_RELEASE_TRAFFIC_STATE_ROOT: trafficStateRoot,
      COMBO_RELEASE_WEB_FORWARD_ENV: forwardEnv,
      COMBO_RELEASE_NGINX_CONFIG: nginxConfig,
      COMBO_RELEASE_FORMAL_NGINX_CONFIG: '',
      COMBO_K3S_STORAGE_ROOT: storage,
      COMBO_FOUNDATION_RESET_WAIT_SECONDS: '2',
    };
    const pristineState = readFileSync(stateFile, 'utf8');
    const cleanReuseArgs = [...args];
    cleanReuseArgs[cleanReuseArgs.indexOf('--operation') + 1] = 'assert-reuse';
    cleanReuseArgs[cleanReuseArgs.indexOf('--policy') + 1] = 'reuse-existing-v1';
    const cleanReuse = spawnSync('bash', [script, ...cleanReuseArgs], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env,
    });
    assert.equal(cleanReuse.status, 0, cleanReuse.stderr);
    assert.match(cleanReuse.stdout, /foundation_reuse_admission=true/);
    assert.equal(readFileSync(stateFile, 'utf8'), pristineState);
    assert.equal(existsSync(output), false);
    assert.deepEqual(
      readdirSync(join(evidenceRoot, 'foundation-resets', 'preview')),
      [],
      'reuse admission must not create a reset journal',
    );
    assert.doesNotMatch(
      readFileSync(kubectlCommandLog, 'utf8'),
      /^(?:apply|delete)(?: |$)/m,
      'reuse admission must not call kubectl apply or delete',
    );
    writeFileSync(kubectlCommandLog, '');
    const rejectSurface = (mutate, expected, environment = env) => {
      const rejectedState = JSON.parse(pristineState);
      mutate(rejectedState);
      writeFileSync(stateFile, `${JSON.stringify(rejectedState)}\n`);
      const rejected = spawnSync('bash', [script, ...args], {
        cwd: scriptDirectory,
        encoding: 'utf8',
        env: environment,
      });
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, expected);
      assert.doesNotMatch(rejected.stderr, /Argument list too long|E2BIG/);
      writeFileSync(stateFile, pristineState);
    };

    rejectSurface((state) => {
      delete state.resources['deployment/release-000000000000-api'].metadata.labels[
        'combo.build/release-track'
      ];
    }, /unowned or unexpected workload writer surface/);
    rejectSurface(() => {}, /active Preview Web forward gate is not healthy and closed/, {
      ...env,
      FAKE_GATE_STATUS: '200',
    });
    rejectSurface(() => {}, /active Preview Web forward gate is not healthy and closed/, {
      ...env,
      FAKE_HEALTH_STATUS: '503',
    });
    rejectSurface(() => {}, /active Preview Web forward gate is not healthy and closed/, {
      ...env,
      FAKE_GATE_HEADER: '',
    });
    rejectSurface(() => {}, /active authenticated Preview Web route is not readable/, {
      ...env,
      FAKE_AUTHENTICATED_ROUTE_FAILURE: '1',
    });
    const wrongRouteVersion = join(directory, 'wrong-route-version.json');
    writeFileSync(
      wrongRouteVersion,
      `${JSON.stringify({
        ...JSON.parse(readFileSync(routeVersion, 'utf8')),
        sourceSha: 'f'.repeat(40),
      })}\n`,
    );
    rejectSurface(() => {}, /active release Web forward route has the wrong release identity/, {
      ...env,
      FAKE_VERSION_JSON: wrongRouteVersion,
    });
    rejectSurface((state) => {
      state.resources['cronjob/zero-pod-scheduler'] = {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata: {
          name: 'zero-pod-scheduler',
          namespace,
          uid: 'cronjob-uid',
          resourceVersion: '1',
        },
        spec: {},
      };
    }, /unowned or unexpected workload writer surface/);
    rejectSurface((state) => {
      state.resources['replicaset/oversized-surface-owner'] = {
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        metadata: {
          name: 'oversized-surface-owner',
          namespace,
          uid: 'oversized-replicaset-uid',
          resourceVersion: '1',
          annotations: {
            'test.combo.build/argmax-padding': 'x'.repeat(256 * 1024),
          },
          ownerReferences: [
            {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              name: activeWeb,
              uid: 'web-uid',
              controller: true,
            },
          ],
        },
        spec: {},
      };
      state.resources[`service/${activeWeb}`].spec.ports[0].targetPort = 8080;
    }, /active release Web Service is not identity-bound/);
    rejectSurface((state) => {
      state.resources['replicaset/forged-owner'] = {
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        metadata: {
          name: 'forged-owner',
          namespace,
          uid: 'replicaset-uid',
          resourceVersion: '1',
          ownerReferences: [
            {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              name: activeWeb,
              uid: 'wrong-web-uid',
              controller: true,
            },
          ],
        },
        spec: {},
      };
    }, /unowned or unexpected workload writer surface/);
    rejectSurface((state) => {
      state.resources['pod/forged-owner'] = {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: 'forged-owner',
          namespace,
          uid: 'pod-uid',
          resourceVersion: '1',
          ownerReferences: [
            {
              apiVersion: 'batch/v1',
              kind: 'Job',
              name: 'release-000000000000-migrate',
              uid: 'wrong-job-uid',
              controller: true,
            },
          ],
        },
        spec: {},
      };
    }, /unowned or unexpected workload writer surface/);
    rejectSurface((state) => {
      state.resources[`service/${activeWeb}`].spec.ports[0].targetPort = 8080;
    }, /active release Web Service is not identity-bound/);
    rejectSurface(() => {}, /active release Web forward unit is not enabled/, {
      ...env,
      FAKE_INACTIVE_FORWARDER: '1',
    });

    writeFileSync(failOptionalGetOnce, '1\n');
    const rejectedOptionalGet = spawnSync('bash', [script, ...args], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env,
    });
    assert.equal(rejectedOptionalGet.status, 1);
    assert.match(
      rejectedOptionalGet.stderr,
      /failed to inspect optional resource: configmap\/release-minio-init-script/,
    );
    assert.equal(existsSync(failOptionalGetOnce), false);
    assert.notEqual(
      JSON.parse(readFileSync(stateFile, 'utf8')).resources['configmap/release-minio-init-script'],
      undefined,
    );

    writeFileSync(bumpDeleteRvOnce, '1\n');
    const first = spawnSync('bash', [script, ...args], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env,
    });
    assert.equal(first.status, 1);
    assert.match(first.stderr, /rendered foundation apply failed/);
    assert.equal(existsSync(bumpDeleteRvOnce), false);
    const storageRemovedState = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(storageRemovedState.resources['deployment/release-000000000000-api'], undefined);
    assert.equal(storageRemovedState.resources['pvc/data-release-postgres-0'], undefined);
    const checkpoint = join(
      evidenceRoot,
      'foundation-resets',
      'preview',
      `${requestId.slice('sha256:'.length)}.foundation-reset-checkpoint.json`,
    );
    assert.equal(JSON.parse(readFileSync(checkpoint, 'utf8')).phase, 'storage-removed');
    const plan = join(
      evidenceRoot,
      'foundation-resets',
      'preview',
      `${requestId.slice('sha256:'.length)}.foundation-reset-plan.json`,
    );
    const originalPlan = readFileSync(plan, 'utf8');
    const originalCheckpoint = readFileSync(checkpoint, 'utf8');
    const expandedPlan = JSON.parse(originalPlan);
    expandedPlan.targets.push({
      kind: 'service',
      name: 'not-in-the-foundation-allowlist',
      uid: 'foreign-uid',
      resourceVersion: '1',
    });
    const expandedPlanBytes = `${JSON.stringify(expandedPlan)}\n`;
    writeFileSync(plan, expandedPlanBytes);
    const expandedCheckpoint = JSON.parse(originalCheckpoint);
    expandedCheckpoint.planDigest = `sha256:${createHash('sha256')
      .update(expandedPlanBytes)
      .digest('hex')}`;
    writeFileSync(checkpoint, `${JSON.stringify(expandedCheckpoint)}\n`);
    const rejectedExpansion = spawnSync('bash', [script, ...args], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env,
    });
    assert.equal(rejectedExpansion.status, 1);
    assert.match(
      rejectedExpansion.stderr,
      /persistent foundation reset plan does not match this request|foundation reset plan .* targets has an invalid captured foundation target/,
    );
    writeFileSync(plan, originalPlan);
    writeFileSync(checkpoint, originalCheckpoint);

    const second = spawnSync('bash', [script, ...args], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env,
    });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /foundation_reset_completed=true evidence_ready=true/);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(Object.keys(result).sort(), [
      'authorityDigest',
      'checks',
      'completedAt',
      'environment',
      'foundation',
      'foundationReadyAt',
      'foundationSnapshotDigest',
      'manifestDigest',
      'namespace',
      'newStorage',
      'oldStorage',
      'planDigest',
      'policy',
      'preservedWeb',
      'releaseId',
      'requestId',
      'schemaVersion',
      'sourceSha',
      'startedAt',
      'status',
      'storageClearedAt',
    ]);
    assert.deepEqual(result.checks, {
      writersFenced: true,
      oldStorageRemoved: true,
      newStorageIdentity: true,
      activeWebPreserved: true,
    });
    assert.equal(result.foundation.length, 10);
    assert.deepEqual(Object.keys(result.preservedWeb).sort(), ['name', 'uid']);
    assert.equal(result.preservedWeb.uid, 'web-uid');
    assert.equal(statSync(output).mode & 0o777, 0o600);
    for (let index = 0; index < 3; index += 1) {
      assert.notEqual(result.oldStorage[index].claimUid, result.newStorage[index].claimUid);
      assert.notEqual(result.oldStorage[index].volumeUid, result.newStorage[index].volumeUid);
      assert.notEqual(result.oldStorage[index].path, result.newStorage[index].path);
    }

    const reuseArgs = [...args];
    reuseArgs[reuseArgs.indexOf('--operation') + 1] = 'assert-reuse';
    reuseArgs[reuseArgs.indexOf('--policy') + 1] = 'reuse-existing-v1';
    const rejectedReuse = spawnSync('bash', [script, ...reuseArgs], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env,
    });
    assert.equal(rejectedReuse.status, 1);
    assert.match(
      rejectedReuse.stderr,
      /unconsumed completed foundation reset|entered the clean-slate boundary/,
    );

    const resetStateRoot = join(evidenceRoot, 'foundation-resets', 'preview');
    const firstStem = requestId.slice('sha256:'.length);
    const firstReady = join(resetStateRoot, `${firstStem}.foundation-reset-ready.json`);
    const firstEvidence = join(resetStateRoot, `${firstStem}.foundation-reset-evidence.json`);
    const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    const firstFiles = [plan, checkpoint, firstReady, firstEvidence, output].map((path) => {
      const bytes = readFileSync(path);
      return { path, bytes, digest: sha256(bytes) };
    });
    const firstResult = structuredClone(result);
    const stateAfterFirstReset = readFileSync(stateFile, 'utf8');

    const successorSourceSha = 'b'.repeat(40);
    const successorManifest = {
      ...manifest,
      sourceSha: successorSourceSha,
      releaseId: `release-${successorSourceSha}`,
      images: {
        api: `ghcr.io/dangdang-tech/combo-api@sha256:${'c'.repeat(64)}`,
        runtime: `ghcr.io/dangdang-tech/combo-runtime@sha256:${'d'.repeat(64)}`,
        web: `ghcr.io/dangdang-tech/combo-web@sha256:${'e'.repeat(64)}`,
      },
      builtAt: '2026-07-29T01:00:00.000Z',
      webAssetManifest: `sha256:${'f'.repeat(64)}`,
    };
    const successorManifestDigest = releaseManifestDigest(successorManifest);
    const successorRequestId = `sha256:${createHash('sha256')
      .update(
        [
          'combo-foundation-reset-v1',
          'preview',
          successorSourceSha,
          successorManifestDigest,
          'established-clean-slate-v1',
        ].join('\0'),
      )
      .digest('hex')}`;
    const successorManifestFile = join(directory, 'successor-release.json');
    const successorOutput = join(directory, 'successor-reset-evidence.json');
    writeFileSync(successorManifestFile, serializeReleaseManifest(successorManifest));
    const successorArgs = [...args];
    for (const [option, value] of [
      ['--manifest', successorManifestFile],
      ['--manifest-digest', successorManifestDigest],
      ['--authority-digest', successorManifestDigest],
      ['--request-id', successorRequestId],
      ['--output', successorOutput],
    ]) {
      successorArgs[successorArgs.indexOf(option) + 1] = value;
    }
    const successorStem = successorRequestId.slice('sha256:'.length);
    const successorPlan = join(resetStateRoot, `${successorStem}.foundation-reset-plan.json`);
    const successorCheckpoint = join(
      resetStateRoot,
      `${successorStem}.foundation-reset-checkpoint.json`,
    );

    const tamperedFoundation = JSON.parse(stateAfterFirstReset);
    tamperedFoundation.resources['deployment/release-redis-hot'].metadata.uid =
      'tampered-foundation-uid';
    const tamperedState = `${JSON.stringify(tamperedFoundation)}\n`;
    writeFileSync(stateFile, tamperedState);
    const rejectedSuccessor = spawnSync('bash', [script, ...successorArgs], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env,
    });
    assert.equal(rejectedSuccessor.status, 1, rejectedSuccessor.stderr);
    assert.match(
      rejectedSuccessor.stderr,
      /live Preview foundation does not exactly continue the superseded reset|predecessor foundation UIDs/,
    );
    assert.equal(readFileSync(stateFile, 'utf8'), tamperedState);
    assert.equal(existsSync(successorPlan), false);
    assert.equal(existsSync(successorCheckpoint), false);
    assert.equal(existsSync(successorOutput), false);
    writeFileSync(stateFile, stateAfterFirstReset);

    const successorReset = spawnSync('bash', [script, ...successorArgs], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env,
    });
    assert.equal(successorReset.status, 0, successorReset.stderr);
    assert.match(successorReset.stdout, /foundation_reset_completed=true evidence_ready=true/);
    const successorResult = JSON.parse(readFileSync(successorOutput, 'utf8'));
    assert.equal(successorResult.schemaVersion, 2);
    assert.deepEqual(successorResult.supersededReset, {
      environment: 'preview',
      namespace,
      requestId,
      sourceSha,
      releaseId: `release-${sourceSha}`,
      manifestDigest,
      planDigest: sha256(readFileSync(plan)),
      foundationSnapshotDigest: sha256(readFileSync(firstReady)),
      evidenceDigest: sha256(readFileSync(firstEvidence)),
    });
    assert.deepEqual(successorResult.checks, {
      writersFenced: true,
      oldStorageRemoved: true,
      newStorageIdentity: true,
      activeWebPreserved: true,
      supersededResetContinuity: true,
    });
    assert.deepEqual(successorResult.oldStorage, firstResult.newStorage);
    for (let index = 0; index < 3; index += 1) {
      assert.notEqual(
        successorResult.newStorage[index].claimUid,
        successorResult.oldStorage[index].claimUid,
      );
      assert.notEqual(
        successorResult.newStorage[index].volumeUid,
        successorResult.oldStorage[index].volumeUid,
      );
      assert.notEqual(
        successorResult.newStorage[index].path,
        successorResult.oldStorage[index].path,
      );
    }
    for (const firstFile of firstFiles) {
      const current = readFileSync(firstFile.path);
      assert.deepEqual(current, firstFile.bytes);
      assert.equal(sha256(current), firstFile.digest);
    }

    const successorReuseArgs = [...successorArgs];
    successorReuseArgs[successorReuseArgs.indexOf('--operation') + 1] = 'assert-reuse';
    successorReuseArgs[successorReuseArgs.indexOf('--policy') + 1] = 'reuse-existing-v1';
    const rejectedSuccessorReuse = spawnSync('bash', [script, ...successorReuseArgs], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env,
    });
    assert.equal(rejectedSuccessorReuse.status, 1);
    assert.match(
      rejectedSuccessorReuse.stderr,
      /unconsumed foundation reset chain|entered the clean-slate boundary/,
    );

    const activated = JSON.parse(readFileSync(stateFile, 'utf8'));
    delete activated.resources[`deployment/${activeWeb}`];
    delete activated.resources[`service/${activeWeb}`];
    const candidateWeb = `release-${successorSourceSha.slice(0, 12)}-web`;
    activated.resources[`deployment/${candidateWeb}`] = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: candidateWeb,
        namespace,
        uid: 'candidate-web-uid',
        resourceVersion: '1',
        labels: { 'combo.build/release-track': 'release-v1' },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: candidateWeb,
            'combo.build/release-track': 'release-v1',
          },
        },
        template: {
          metadata: {
            labels: {
              app: candidateWeb,
              'combo.build/release-track': 'release-v1',
            },
            annotations: {
              'combo.build/source-sha': successorSourceSha,
              'combo.build/release-id': `release-${successorSourceSha}`,
              'combo.build/release-manifest-digest': successorManifestDigest,
            },
          },
          spec: {
            containers: [{ name: 'web', image: successorManifest.images.web }],
          },
        },
      },
      status: { readyReplicas: 1, availableReplicas: 1 },
    };
    activated.resources[`service/${candidateWeb}`] = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: candidateWeb,
        namespace,
        uid: 'candidate-service-uid',
        resourceVersion: '1',
        labels: { 'combo.build/release-track': 'release-v1' },
      },
      spec: {
        type: 'ClusterIP',
        selector: {
          app: candidateWeb,
          'combo.build/release-track': 'release-v1',
        },
        ports: [{ name: 'http', port: 80, targetPort: 80, protocol: 'TCP' }],
      },
    };
    writeFileSync(stateFile, `${JSON.stringify(activated)}\n`);
    writeFileSync(forwardEnv, `COMBO_RELEASE_WEB_SERVICE=${candidateWeb}\n`);
    writeFileSync(
      join(trafficStateRoot, 'preview', 'current.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        environment: 'preview',
        sourceSha: successorSourceSha,
        releaseId: `release-${successorSourceSha}`,
        manifestDigest: successorManifestDigest,
        canaryNginxSha256: nginxDigest,
        formalNginxSha256: null,
        webService: candidateWeb,
      })}\n`,
    );
    writeFileSync(
      routeVersion,
      `${JSON.stringify({
        schemaVersion: 1,
        environment: 'preview',
        sourceSha: successorSourceSha,
        releaseId: `release-${successorSourceSha}`,
        builtAt: successorManifest.builtAt,
        releaseManifestDigest: successorManifestDigest,
        webAssetManifest: successorManifest.webAssetManifest,
      })}\n`,
    );
    const successorRetry = spawnSync('bash', [script, ...successorArgs], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env,
    });
    assert.equal(successorRetry.status, 0, successorRetry.stderr);
    assert.match(successorRetry.stdout, /foundation_reset_reused=true evidence_ready=true/);
    const live = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(live.resources[`deployment/${candidateWeb}`].metadata.uid, 'candidate-web-uid');
    assert.equal(live.resources[`service/${candidateWeb}`].metadata.uid, 'candidate-service-uid');
    for (const firstFile of firstFiles) {
      const current = readFileSync(firstFile.path);
      assert.deepEqual(current, firstFile.bytes);
      assert.equal(sha256(current), firstFile.digest);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
