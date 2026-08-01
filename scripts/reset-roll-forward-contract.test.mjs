import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseManifestDigest, serializeReleaseManifest } from './release-manifest.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const script = join(scriptDirectory, 'prepare-reset-roll-forward.sh');
const source = readFileSync(script, 'utf8');
const digest = `sha256:${'a'.repeat(64)}`;

function invoke(args) {
  return spawnSync('bash', [script, ...args], {
    cwd: scriptDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      COMBO_RELEASE_EVIDENCE_ROOT: '/tmp/not-used-by-roll-forward-input-contracts',
      COMBO_RELEASE_TRAFFIC_STATE_ROOT: '/tmp/not-used-by-roll-forward-input-contracts-traffic',
      COMBO_MUTATION_LOCK: '/tmp/not-used-by-roll-forward-input-contracts.lock',
      COMBO_RELEASE_TRAFFIC_LOCK: '/tmp/not-used-by-roll-forward-input-contracts-traffic.lock',
    },
  });
}

function position(fragment, label = fragment) {
  const result = source.indexOf(fragment);
  assert.ok(result >= 0, `missing ${label}`);
  return result;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function manifest(sourceSha, digestCharacter) {
  return {
    schemaVersion: 1,
    sourceSha,
    releaseId: `release-${sourceSha}`,
    images: {
      api: `ghcr.io/dangdang-tech/combo-api@sha256:${digestCharacter.repeat(64)}`,
      runtime: `ghcr.io/dangdang-tech/combo-runtime@sha256:${digestCharacter.repeat(64)}`,
      web: `ghcr.io/dangdang-tech/combo-web@sha256:${digestCharacter.repeat(64)}`,
    },
    migrationHead: '0009_billing.sql',
    builtAt: '2026-07-29T00:00:00.000Z',
    webAssetManifest: `sha256:${digestCharacter.repeat(64)}`,
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function deployment({ sourceSha, manifestDigest, role, uid, ready = false, image }) {
  const name = `release-${sourceSha.slice(0, 12)}-${role}`;
  const replicas = ready ? 1 : undefined;
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      namespace: 'combo',
      name,
      uid,
      resourceVersion: `rv-${uid}`,
      labels: { 'combo.build/release-track': 'release-v1' },
    },
    spec: {
      ...(ready ? { replicas } : {}),
      selector: {
        matchLabels: {
          app: name,
          'combo.build/release-track': 'release-v1',
        },
      },
      template: {
        metadata: {
          labels: {
            app: name,
            'combo.build/release-track': 'release-v1',
          },
          annotations: {
            'combo.build/source-sha': sourceSha,
            'combo.build/release-id': `release-${sourceSha}`,
            'combo.build/release-manifest-digest': manifestDigest,
          },
        },
        spec: {
          containers: [{ name: role, ...(image ? { image } : {}) }],
        },
      },
    },
    ...(ready
      ? {
          status: {
            readyReplicas: replicas,
            availableReplicas: replicas,
          },
        }
      : {}),
  };
}

function job({ sourceSha, manifestDigest, role, uid }) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      namespace: 'combo',
      name: `release-${sourceSha.slice(0, 12)}-${role}`,
      uid,
      resourceVersion: `rv-${uid}`,
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'combo.build/source-sha': sourceSha,
            'combo.build/release-id': `release-${sourceSha}`,
            'combo.build/release-manifest-digest': manifestDigest,
          },
        },
      },
    },
  };
}

test('reset roll-forward exposes a closed Production-only interface', () => {
  for (const option of ['--environment', '--manifest', '--manifest-digest', '--output']) {
    assert.match(source, new RegExp(option));
  }
  assert.match(
    source,
    /\[\[ "\$ENVIRONMENT" == production \]\] \|\|\s+fail 'reset roll-forward is restricted to Production'/,
  );
  assert.match(source, /readonly NAMESPACE=combo/);
  assert.doesNotMatch(source, /--namespace|--pending|--resource|--target|--force|--skip/);
  assert.equal(statSync(script).mode & 0o777, 0o755);
});

test('both host locks are acquired before durable planning or mutation', () => {
  const mutationLock = position('flock -x 9', 'mutation lock');
  const trafficLock = position('flock -x 8', 'traffic lock');
  const stateDirectory = position('mkdir -p "$state_root"', 'state directory creation');
  const planInstall = position(
    'immutable_install "$work/plan.json" "$plan"',
    'immutable plan installation',
  );
  const firstDelete = position('delete_cas \\', 'first planned CAS deletion');

  assert.ok(mutationLock < trafficLock);
  assert.ok(trafficLock < stateDirectory);
  assert.ok(stateDirectory < planInstall);
  assert.ok(planInstall < firstDelete);
  assert.match(source, /lock path is unsafe/);
  assert.match(source, /chmod 0600 "\$MUTATION_LOCK"/);
  assert.match(source, /chmod 0600 "\$TRAFFIC_LOCK"/);
});

test('the immutable plan binds every old and new release authority', () => {
  for (const binding of [
    'oldPendingDigest',
    'sha256SumsDigest',
    'activationEvidenceDigest',
    'resetEvidenceDigest',
    'schemaStructureProofDigest',
    'trafficStateDigest',
    'forwardEnvDigest',
    'canaryNginxSha256',
    'formalNginxSha256',
    'newManifestDigest',
  ]) {
    assert.ok(source.includes(binding), `missing immutable binding ${binding}`);
  }
  assert.match(source, /release-manifest\.mjs" verify[\s\S]*--digest "\$old_manifest"/);
  assert.match(source, /tr -d '\\n' <"\$directory\/release\.sha256"[\s\S]*== "\$old_manifest"/);
  assert.match(source, /\.phase == "post-cut"[\s\S]*\.phase == "finalizing"/);
  assert.match(source, /validate_finalizing_cleanup_plan/);
  assert.match(source, /finalizing predecessor cleanup plan changed after it was bound/);
  assert.match(source, /\.foundationCreated \| type == "boolean"/);
  assert.match(source, /foundationCreated: \$oldFoundationCreated/);
  assert.match(source, /oldPending\.foundationCreated \| type == "boolean"/);
  assert.match(source, /\.foundationResetEvidenceDigest \| test\("\^sha256:\[0-9a-f\]\{64\}\$"\)/);
  assert.match(source, /host checkpoint is not the untouched activated state/);
  assert.match(source, /cleanup or host sealing already started/);
  assert.match(source, /cleanup already removed a target/);
  assert.match(source, /oldPending\.digest/);
  assert.match(source, /plan_digest=\$\(file_digest "\$plan"\)/);
});

test('the deletion allowlist is exact and every delete is UID/RV CAS Foreground', () => {
  assert.match(source, /for role in api runtime worker/);
  assert.match(source, /for role in migrate minio-init/);
  assert.match(source, /\.targets \| length == 5/);
  for (const target of ['-api', '-runtime', '-worker', '-migrate', '-minio-init']) {
    assert.ok(source.includes(target), `missing deletion target ${target}`);
  }
  assert.match(source, /preconditions: \{uid: \$uid, resourceVersion: \$resourceVersion\}/);
  assert.match(source, /propagationPolicy: "Foreground"/);
  assert.match(source, /delete --raw="\$api_path" -f "\$options"/);
  assert.match(source, /changed UID after roll-forward planning/);
  assert.match(source, /resource_authority_digest/);
  assert.match(source, /changed deletion authority after roll-forward planning/);
  assert.match(source, /--arg resourceVersion "\$current_resource_version"/);
  assert.match(source, /state: "already-absent"/);
  assert.match(source, /if \.state == "present" then/);
  assert.match(source, /deletionTimestamp \/\/ empty/);
  assert.match(source, /--ignore-not-found -o json/);
  assert.doesNotMatch(
    source,
    /if ! current=\$\(get_resource[\s\S]{0,80}return 0/,
    'an API error must not be treated as successful absence',
  );
});

test('active Web, Service, forwarder, traffic state, and Nginx stay fenced', () => {
  for (const contract of [
    'COMBO_RELEASE_WEB_SERVICE',
    'canaryNginxSha256',
    'formalNginxSha256',
    'trafficStateDigest',
    'forwardEnvDigest',
    'active Production Web deployment is not identity-bound and ready',
    'active Production Web Service is not identity-bound',
    'active Web or host traffic changed during reset roll-forward',
  ]) {
    assert.ok(source.includes(contract), `missing active route contract ${contract}`);
  }
  assert.match(
    source,
    /\.status\.readyReplicas == \.spec\.replicas[\s\S]*\.status\.availableReplicas == \.spec\.replicas/,
  );
  assert.match(source, /\.spec\.ports\[0\]\.name == "http"/);
  assert.match(source, /\.spec\.ports\[0\]\.targetPort == 80/);
  assert.match(source, /systemctl is-enabled --quiet "\$WEB_FORWARD_UNIT"/);
  assert.match(source, /systemctl is-active --quiet "\$WEB_FORWARD_UNIT"/);
  assert.match(source, /serviceUid/);
  assert.doesNotMatch(source, /delete_cas[\s\S]{0,120}web/);
  assert.doesNotMatch(source, /delete_cas[\s\S]{0,120}service/);
});

test('handoff state is resumable and archives before retiring pending', () => {
  for (const phase of ['planned', 'writers-removed', 'handoff-sealed', 'completed']) {
    assert.ok(source.includes(phase), `missing durable phase ${phase}`);
  }
  const archive = position('immutable_install "$pending" "$pending_archive"', 'pending archive');
  const seal = position(
    'immutable_install "$work/handoff-seal.json" "$handoff_seal"',
    'handoff seal',
  );
  const pendingRemoval = source.lastIndexOf('rm -f -- "$pending"');
  assert.ok(pendingRemoval >= 0, 'missing handoff pending retirement');
  const completionEvidence = position(
    'immutable_install "$work/evidence.json" "$evidence"',
    'completion evidence',
  );

  assert.ok(archive < seal);
  assert.ok(seal < pendingRemoval);
  assert.ok(pendingRemoval < completionEvidence);
  assert.match(source, /mv -fT "\$stage" "\$target"/);
  assert.match(source, /--arg sealedAt "\$writers_at"/);
  assert.match(source, /--arg completedAt "\$sealed_at"/);
  assert.match(source, /completed reset roll-forward pending archive digest changed/);
  assert.match(source, /reset_roll_forward_reused=true handoff_ready=true/);
});

test('global journal admission runs under both host locks before Kubernetes access', () => {
  const mutationLock = position('flock -x 9', 'mutation lock');
  const trafficLock = position('flock -x 8', 'traffic lock');
  const journalAudit = position(
    'node "$SCRIPT_DIR/reset-roll-forward-journal.mjs" audit',
    'global journal audit',
  );
  const kubernetesClient = position('K=(kubectl --kubeconfig "$KUBECONFIG_PATH")');

  assert.ok(mutationLock < trafficLock);
  assert.ok(trafficLock < journalAudit);
  assert.ok(journalAudit < kubernetesClient);
});

test('handoff and completion evidence are exact, identity-bound, and sanitized', () => {
  for (const field of [
    'pendingArchiveDigest',
    'handoffSealDigest',
    'oldSourceSha',
    'oldReleaseId',
    'oldManifestDigest',
    'resetEvidenceDigest',
    'newSourceSha',
    'newReleaseId',
    'newManifestDigest',
    'preservedWeb',
    'removedTargets',
  ]) {
    assert.ok(source.includes(field), `missing evidence field ${field}`);
  }
  assert.match(source, /\.preservedWeb \| \{name, uid, serviceName, serviceUid\}/);
  assert.match(source, /\.targets\[\] \| \{kind, name, state, uid\}/);
  assert.match(source, /secretMaterialAccessed: false/);
  assert.match(source, /chmod 0600 "\$OUTPUT"/);
  assert.doesNotMatch(source, /password|credential|private[-_]?key/i);
  assert.doesNotMatch(
    source,
    /(?:kubectl|\$\{K\[@\]\})[^\n]*(?:get|delete|patch|apply)[^\n]*secret/i,
  );
  assert.doesNotMatch(source, /\bget_resource(?:_optional)?\s+secret\b/i);
});

test('CLI fails closed before cluster access for invalid authority', () => {
  const invalidEnvironment = invoke([
    '--environment',
    'preview',
    '--manifest',
    '/does/not/exist',
    '--manifest-digest',
    digest,
    '--output',
    '/does/not/exist',
  ]);
  assert.equal(invalidEnvironment.status, 1);
  assert.match(invalidEnvironment.stderr, /restricted to Production/);
  assert.doesNotMatch(invalidEnvironment.stderr, /kubectl|Secret/);

  const invalidDigest = invoke([
    '--environment',
    'production',
    '--manifest',
    '/does/not/exist',
    '--manifest-digest',
    'not-a-digest',
    '--output',
    '/does/not/exist',
  ]);
  assert.equal(invalidDigest.status, 1);
  assert.match(invalidDigest.stderr, /invalid manifest digest/);
  assert.doesNotMatch(invalidDigest.stderr, /kubectl|Secret/);
});

test('CLI rejects symbolic-link manifest and output paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'combo-reset-roll-forward-contract-'));
  try {
    const manifest = join(directory, 'release.json');
    const linkedManifest = join(directory, 'linked-release.json');
    const linkedOutput = join(directory, 'evidence.json');
    writeFileSync(manifest, '{}\n');
    symlinkSync(manifest, linkedManifest);
    symlinkSync(join(directory, 'missing-output'), linkedOutput);

    const linkedInput = invoke([
      '--environment',
      'production',
      '--manifest',
      linkedManifest,
      '--manifest-digest',
      digest,
      '--output',
      join(directory, 'regular-output.json'),
    ]);
    assert.equal(linkedInput.status, 1);
    assert.match(linkedInput.stderr, /manifest must be a regular file/);

    const linkedOutputResult = invoke([
      '--environment',
      'production',
      '--manifest',
      manifest,
      '--manifest-digest',
      digest,
      '--output',
      linkedOutput,
    ]);
    assert.equal(linkedOutputResult.status, 1);
    assert.match(linkedOutputResult.stderr, /output path is missing or unsafe/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runFullHandoff(predecessorPhase) {
  const directory = mkdtempSync(join(tmpdir(), 'combo-reset-roll-forward-state-'));
  try {
    const bin = join(directory, 'bin');
    const cluster = join(directory, 'cluster');
    const home = join(directory, 'home');
    const evidenceRoot = join(directory, 'evidence');
    const productionEvidence = join(evidenceRoot, 'production');
    const trafficRoot = join(directory, 'traffic');
    const productionTraffic = join(trafficRoot, 'production');
    const host = join(directory, 'host');
    const outputDirectory = join(directory, 'output');
    for (const path of [
      bin,
      cluster,
      home,
      productionEvidence,
      productionTraffic,
      host,
      outputDirectory,
    ]) {
      mkdirSync(path, { recursive: true });
    }

    const fakeKubectl = join(bin, 'kubectl');
    writeFileSync(
      fakeKubectl,
      `#!/usr/bin/env bash
set -euo pipefail
cluster=$COMBO_FAKE_CLUSTER
if [[ "$1" == --kubeconfig ]]; then
  shift 2
fi
if [[ "$1" == -n ]]; then
  shift 2
fi
verb=$1
shift
if [[ "$verb" == get ]]; then
  target=$1
  kind=\${target%%/*}
  name=\${target#*/}
  file="$cluster/\${kind}--\${name}.json"
  if [[ -f "$file" ]]; then
    if [[ -n "\${COMBO_FAKE_BUMP_DELETE_RV_ONCE:-}" &&
      -e "$COMBO_FAKE_BUMP_DELETE_RV_ONCE" &&
      "$name" == *-api ]] &&
      compgen -G \
        "$COMBO_RELEASE_EVIDENCE_ROOT/reset-roll-forwards/production/*.plan.json" \
        >/dev/null; then
      updated="$file.updated"
      jq '.metadata.resourceVersion += "-status"' "$file" >"$updated"
      mv -f -- "$updated" "$file"
      rm -f -- "$COMBO_FAKE_BUMP_DELETE_RV_ONCE"
    fi
    cat "$file"
    exit 0
  fi
  for argument in "$@"; do
    [[ "$argument" != --ignore-not-found ]] || exit 0
  done
  exit 1
fi
if [[ "$verb" == delete ]]; then
  raw=''
  options=''
  while (($# > 0)); do
    case "$1" in
      --raw=*) raw=\${1#--raw=} ;;
      -f) options=$2; shift ;;
    esac
    shift
  done
  name=\${raw##*/}
  if [[ "$raw" == *"/deployments/"* ]]; then
    kind=deployment
  elif [[ "$raw" == *"/jobs/"* ]]; then
    kind=job
  else
    exit 2
  fi
  file="$cluster/\${kind}--\${name}.json"
  [[ -f "$file" && -f "$options" ]]
  jq -e --slurpfile options "$options" '
    .metadata.uid == $options[0].preconditions.uid
    and .metadata.resourceVersion == $options[0].preconditions.resourceVersion
    and $options[0].propagationPolicy == "Foreground"
  ' "$file" >/dev/null
  rm -f -- "$file"
  if [[ -n "\${COMBO_FAKE_FAIL_AFTER_DELETE_MARKER:-}" &&
    ! -e "$COMBO_FAKE_FAIL_AFTER_DELETE_MARKER" ]]; then
    : >"$COMBO_FAKE_FAIL_AFTER_DELETE_MARKER"
    exit 42
  fi
  printf '{}\\n'
  exit 0
fi
exit 2
`,
    );
    chmodSync(fakeKubectl, 0o755);

    const fakeSudo = join(bin, 'sudo');
    writeFileSync(
      fakeSudo,
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" != -n ]] || shift
exec "$@"
`,
    );
    chmodSync(fakeSudo, 0o755);
    const fakeSystemctl = join(bin, 'systemctl');
    writeFileSync(
      fakeSystemctl,
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == is-enabled || "$1" == is-active ]]
[[ "$2" == --quiet ]]
[[ "$3" == combo-release-production-web-forward.service ]]
`,
    );
    chmodSync(fakeSystemctl, 0o755);

    const oldSourceSha = '1'.repeat(40);
    const newSourceSha = '2'.repeat(40);
    const oldManifest = manifest(oldSourceSha, '3');
    const newManifest = manifest(newSourceSha, '4');
    const oldManifestDigest = releaseManifestDigest(oldManifest);
    const newManifestDigest = releaseManifestDigest(newManifest);
    const newManifestPath = join(directory, 'new-release.json');
    writeFileSync(newManifestPath, serializeReleaseManifest(newManifest));

    const resetEvidence = join(directory, 'foundation-reset-evidence.json');
    writeJson(resetEvidence, {
      schemaVersion: 1,
      status: 'passed',
      requestId: `sha256:${'5'.repeat(64)}`,
    });
    const resetEvidenceDigest = sha256(readFileSync(resetEvidence));
    const schemaDigest = `sha256:${'6'.repeat(64)}`;
    const oldReleaseId = `release-${oldSourceSha}`;
    const activationDirectory = join(productionEvidence, `${oldReleaseId}.activation`);
    mkdirSync(activationDirectory);
    writeFileSync(join(activationDirectory, 'release.json'), serializeReleaseManifest(oldManifest));
    writeFileSync(join(activationDirectory, 'release.sha256'), `${oldManifestDigest}\n`);
    writeFileSync(
      join(activationDirectory, 'foundation-reset-evidence.json'),
      readFileSync(resetEvidence),
    );
    writeJson(join(activationDirectory, 'activation-evidence.json'), {
      schemaVersion: 1,
      status: 'awaiting-acceptance',
      environment: 'production',
      namespace: 'combo',
      sourceSha: oldSourceSha,
      releaseId: oldReleaseId,
      manifestDigest: oldManifestDigest,
      foundationResetEvidenceDigest: resetEvidenceDigest,
      schemaStructureProofDigest: schemaDigest,
      rollbackCheckpointId: oldReleaseId,
      rollbackCheckpointDigest: `sha256:${'7'.repeat(64)}`,
      checks: {
        candidateReady: true,
        trafficActivated: true,
        formalDomainVerified: true,
        supersededReleaseRetained: true,
      },
      activatedAt: '2026-07-29T00:01:00.000Z',
    });
    const activationFiles = [
      'release.json',
      'release.sha256',
      'foundation-reset-evidence.json',
      'activation-evidence.json',
    ];
    writeFileSync(
      join(activationDirectory, 'SHA256SUMS'),
      `${activationFiles
        .map((name) => {
          const value = readFileSync(join(activationDirectory, name));
          return `${sha256(value).slice('sha256:'.length)}  ${name}`;
        })
        .join('\n')}\n`,
    );
    const cleanupPlanPath = join(activationDirectory, 'cleanup-plan.json');
    const supersededSourceSha = '0'.repeat(40);
    const supersededService = `release-${supersededSourceSha.slice(0, 12)}-api`;
    const cleanupTargets = [
      { kind: 'pvc', name: 'data-postgres-0', uid: 'uid-legacy-postgres-pvc' },
      { kind: 'service', name: supersededService, uid: 'uid-superseded-api-service' },
    ];
    const validCleanupPlan = {
      schemaVersion: 1,
      purpose: 'superseded-release-cleanup',
      environment: 'production',
      namespace: 'combo',
      sourceSha: oldSourceSha,
      releaseId: oldReleaseId,
      manifestDigest: oldManifestDigest,
      targets: cleanupTargets,
      targetCount: cleanupTargets.length,
      capturedStorage: [
        {
          claim: 'data-postgres-0',
          claimUid: 'uid-legacy-postgres-pvc',
          path: '/srv/combo/legacy-postgres',
          volume: 'pv-legacy-postgres',
          volumeUid: 'uid-legacy-postgres-volume',
        },
      ],
      plannedAt: '2026-07-29T00:01:30.000Z',
    };
    writeJson(cleanupPlanPath, validCleanupPlan);
    const cleanupPlanDigest = sha256(readFileSync(cleanupPlanPath));

    const webName = `release-${oldSourceSha.slice(0, 12)}-web`;
    const pendingPath = join(productionEvidence, 'pending.json');
    writeJson(pendingPath, {
      schemaVersion: 3,
      environment: 'production',
      namespace: 'combo',
      sourceSha: oldSourceSha,
      releaseId: oldReleaseId,
      manifestDigest: oldManifestDigest,
      foundationResetEvidenceDigest: resetEvidenceDigest,
      schemaStructureProofDigest: schemaDigest,
      webService: webName,
      foundationCreated: predecessorPhase === 'post-cut',
      phase: predecessorPhase,
      trafficCutAt: '2026-07-29T00:02:00.000Z',
      cleanupPlanDigest: predecessorPhase === 'finalizing' ? cleanupPlanDigest : null,
    });
    const originalPending = readFileSync(pendingPath);

    const canaryNginx = join(host, 'canary.conf');
    const formalNginx = join(host, 'formal.conf');
    const forwardEnvironment = join(host, 'production-web-forward.env');
    writeFileSync(canaryNginx, 'canary route fixture\n');
    writeFileSync(formalNginx, 'formal route fixture\n');
    writeFileSync(forwardEnvironment, `COMBO_RELEASE_WEB_SERVICE=${webName}\n`);
    writeJson(join(productionTraffic, 'current.json'), {
      schemaVersion: 1,
      environment: 'production',
      sourceSha: oldSourceSha,
      releaseId: oldReleaseId,
      manifestDigest: oldManifestDigest,
      canaryNginxSha256: sha256(readFileSync(canaryNginx)),
      formalNginxSha256: sha256(readFileSync(formalNginx)),
      webService: webName,
    });
    const trafficCheckpointRoot = join(host, 'traffic-checkpoints');
    const hostCheckpointDirectory = join(trafficCheckpointRoot, 'production', oldReleaseId);
    mkdirSync(hostCheckpointDirectory, { recursive: true });
    const hostCheckpointPath = join(hostCheckpointDirectory, 'checkpoint.json');
    const activatedHostCheckpoint = {
      schemaVersion: 1,
      status: 'activated',
      environment: 'production',
      sourceSha: oldSourceSha,
      releaseId: oldReleaseId,
      manifestDigest: oldManifestDigest,
      candidate: {
        webService: webName,
        canaryNginxSha256: sha256(readFileSync(canaryNginx)),
        formalNginxSha256: sha256(readFileSync(formalNginx)),
      },
      previous: {},
      initialFormalAllowlist: false,
      armedAt: '2026-07-29T00:00:30.000Z',
      activatedAt: '2026-07-29T00:01:00.000Z',
    };
    const activationEvidencePath = join(activationDirectory, 'activation-evidence.json');
    const activationEvidence = JSON.parse(readFileSync(activationEvidencePath, 'utf8'));
    const bindHostCheckpoint = (checkpoint) => {
      writeJson(hostCheckpointPath, checkpoint);
      activationEvidence.rollbackCheckpointId = oldReleaseId;
      activationEvidence.rollbackCheckpointDigest = sha256(readFileSync(hostCheckpointPath));
      writeJson(activationEvidencePath, activationEvidence);
      writeFileSync(
        join(activationDirectory, 'SHA256SUMS'),
        `${activationFiles
          .map((name) => {
            const value = readFileSync(join(activationDirectory, name));
            return `${sha256(value).slice('sha256:'.length)}  ${name}`;
          })
          .join('\n')}\n`,
      );
    };
    bindHostCheckpoint(activatedHostCheckpoint);

    const resourcePath = (kind, name) => join(cluster, `${kind}--${name}.json`);
    writeJson(
      resourcePath('deployment', webName),
      deployment({
        sourceSha: oldSourceSha,
        manifestDigest: oldManifestDigest,
        role: 'web',
        uid: 'uid-web',
        ready: true,
        image: oldManifest.images.web,
      }),
    );
    writeJson(resourcePath('service', webName), {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        namespace: 'combo',
        name: webName,
        uid: 'uid-web-service',
        resourceVersion: 'rv-web-service',
        labels: { 'combo.build/release-track': 'release-v1' },
      },
      spec: {
        type: 'ClusterIP',
        selector: {
          app: webName,
          'combo.build/release-track': 'release-v1',
        },
        ports: [{ name: 'http', port: 80, targetPort: 80, protocol: 'TCP' }],
      },
    });
    writeJson(resourcePath('service', supersededService), {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        namespace: 'combo',
        name: supersededService,
        uid: 'uid-superseded-api-service',
        resourceVersion: 'rv-superseded-api-service',
      },
      spec: { type: 'ClusterIP' },
    });
    writeJson(resourcePath('pvc', 'data-postgres-0'), {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        namespace: 'combo',
        name: 'data-postgres-0',
        uid: 'uid-legacy-postgres-pvc',
        resourceVersion: 'rv-legacy-postgres-pvc',
      },
      spec: {},
    });
    for (const role of ['api', 'runtime', 'worker']) {
      const name = `release-${oldSourceSha.slice(0, 12)}-${role}`;
      writeJson(
        resourcePath('deployment', name),
        deployment({
          sourceSha: oldSourceSha,
          manifestDigest: oldManifestDigest,
          role,
          uid: `uid-${role}`,
        }),
      );
    }
    for (const role of ['migrate', 'minio-init']) {
      const name = `release-${oldSourceSha.slice(0, 12)}-${role}`;
      writeJson(
        resourcePath('job', name),
        job({
          sourceSha: oldSourceSha,
          manifestDigest: oldManifestDigest,
          role,
          uid: `uid-${role}`,
        }),
      );
    }

    const output = join(outputDirectory, 'handoff-evidence.json');
    const args = [
      '--environment',
      'production',
      '--manifest',
      newManifestPath,
      '--manifest-digest',
      newManifestDigest,
      '--output',
      output,
    ];
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      KUBECONFIG: join(directory, 'kubeconfig'),
      COMBO_FAKE_CLUSTER: cluster,
      COMBO_RELEASE_EVIDENCE_ROOT: evidenceRoot,
      COMBO_RELEASE_TRAFFIC_STATE_ROOT: trafficRoot,
      COMBO_RELEASE_TRAFFIC_CHECKPOINT_ROOT: trafficCheckpointRoot,
      COMBO_MUTATION_LOCK: join(directory, 'mutation.lock'),
      COMBO_RELEASE_TRAFFIC_LOCK: join(directory, 'traffic.lock'),
      COMBO_RELEASE_WEB_FORWARD_ENV: forwardEnvironment,
      COMBO_RELEASE_NGINX_CONFIG: canaryNginx,
      COMBO_RELEASE_FORMAL_NGINX_CONFIG: formalNginx,
      COMBO_RESET_ROLL_FORWARD_WAIT_SECONDS: '2',
      COMBO_FAKE_FAIL_AFTER_DELETE_MARKER: join(directory, 'fail-after-delete.marker'),
      COMBO_FAKE_BUMP_DELETE_RV_ONCE: join(directory, 'bump-delete-rv-once'),
    };

    const finalizedDirectory = join(productionEvidence, oldReleaseId);
    const currentCheckpoint = join(productionEvidence, 'current.json');
    mkdirSync(finalizedDirectory);
    for (const name of ['release.json', 'release.sha256', 'foundation-reset-evidence.json']) {
      writeFileSync(join(finalizedDirectory, name), readFileSync(join(activationDirectory, name)));
    }
    writeJson(join(finalizedDirectory, 'deploy-evidence.json'), {
      schemaVersion: 1,
      status: 'passed',
      environment: 'production',
      namespace: 'combo',
      sourceSha: oldSourceSha,
      releaseId: oldReleaseId,
      manifestDigest: oldManifestDigest,
      foundationMode: 'reset',
      foundationResetEvidenceDigest: resetEvidenceDigest,
      foundationReset: { status: 'passed' },
      schemaStructureDigest: schemaDigest,
      checks: { protectedAcceptance: true, publicTraffic: true },
      traffic: {
        formalOrigin: 'https://buildwithcombo.com',
        formalAliasOrigin: 'https://www.buildwithcombo.com',
      },
    });
    const finalizedFiles = [
      'release.json',
      'release.sha256',
      'foundation-reset-evidence.json',
      'deploy-evidence.json',
    ];
    writeFileSync(
      join(finalizedDirectory, 'SHA256SUMS'),
      `${finalizedFiles
        .map((name) => {
          const value = readFileSync(join(finalizedDirectory, name));
          return `${sha256(value).slice('sha256:'.length)}  ${name}`;
        })
        .join('\n')}\n`,
    );
    writeJson(currentCheckpoint, {
      schemaVersion: 1,
      status: 'passed',
      environment: 'production',
      namespace: 'combo',
      sourceSha: oldSourceSha,
      releaseId: oldReleaseId,
      manifestDigest: oldManifestDigest,
      evidencePath: finalizedDirectory,
    });
    const protectedTargets = [
      ...['api', 'runtime', 'worker'].map((role) =>
        resourcePath('deployment', `release-${oldSourceSha.slice(0, 12)}-${role}`),
      ),
      ...['migrate', 'minio-init'].map((role) =>
        resourcePath('job', `release-${oldSourceSha.slice(0, 12)}-${role}`),
      ),
    ];
    const protectedBytes = new Map(
      protectedTargets.map((path) => [path, readFileSync(path, 'utf8')]),
    );
    const metadataOnly = spawnSync('bash', [script, ...args], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(metadataOnly.status, 0, `${metadataOnly.stdout}\n${metadataOnly.stderr}`);
    assert.match(metadataOnly.stdout, /roll_forward_required=false/);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(pendingPath), false);
    for (const [path, bytes] of protectedBytes) {
      assert.equal(readFileSync(path, 'utf8'), bytes);
    }
    writeFileSync(pendingPath, originalPending);
    rmSync(finalizedDirectory, { recursive: true });
    rmSync(currentCheckpoint);
    rmSync(resourcePath('job', `release-${oldSourceSha.slice(0, 12)}-migrate`));

    if (predecessorPhase === 'finalizing') {
      const runRejectedCleanupPlan = (candidate) => {
        writeJson(cleanupPlanPath, candidate);
        const candidatePending = JSON.parse(originalPending.toString('utf8'));
        candidatePending.cleanupPlanDigest = sha256(readFileSync(cleanupPlanPath));
        writeJson(pendingPath, candidatePending);
        const result = spawnSync('bash', [script, ...args], {
          cwd: scriptDirectory,
          encoding: 'utf8',
          env: environment,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /finalizing predecessor cleanup plan identity is invalid/);
      };
      const malformedCleanupPlans = [
        { ...validCleanupPlan, extra: true },
        { ...validCleanupPlan, targetCount: validCleanupPlan.targetCount + 1 },
        { ...validCleanupPlan, targets: null, targetCount: 0, capturedStorage: null },
        { ...validCleanupPlan, targets: {}, targetCount: 0, capturedStorage: {} },
        {
          ...validCleanupPlan,
          targets: [cleanupTargets[0], cleanupTargets[0]],
          targetCount: 2,
        },
        {
          ...validCleanupPlan,
          targets: [
            ...cleanupTargets,
            {
              kind: 'deployment',
              name: `release-${oldSourceSha.slice(0, 12)}-api`,
              uid: 'uid-predecessor-api',
            },
          ],
          targetCount: cleanupTargets.length + 1,
        },
        {
          ...validCleanupPlan,
          targets: [{ ...cleanupTargets[0], uid: 'unsafe uid' }, cleanupTargets[1]],
        },
        {
          ...validCleanupPlan,
          capturedStorage: [{ ...validCleanupPlan.capturedStorage[0], path: 'relative/path' }],
        },
      ];
      for (const malformedCleanupPlan of malformedCleanupPlans) {
        runRejectedCleanupPlan(malformedCleanupPlan);
      }
      writeJson(cleanupPlanPath, validCleanupPlan);
      writeFileSync(pendingPath, originalPending);

      bindHostCheckpoint({
        ...activatedHostCheckpoint,
        status: 'finalizing',
        cleanupPlanDigest,
        finalizingAt: '2026-07-29T00:02:30.000Z',
      });
      const rejectedHostFinalizing = spawnSync('bash', [script, ...args], {
        cwd: scriptDirectory,
        encoding: 'utf8',
        env: environment,
      });
      assert.equal(rejectedHostFinalizing.status, 1);
      assert.match(
        rejectedHostFinalizing.stderr,
        /host checkpoint is not the untouched activated state/,
      );
      bindHostCheckpoint(activatedHostCheckpoint);

      const cleanupEvidencePath = join(activationDirectory, 'cleanup-evidence.json');
      writeJson(cleanupEvidencePath, { status: 'partial' });
      const rejectedCleanupEvidence = spawnSync('bash', [script, ...args], {
        cwd: scriptDirectory,
        encoding: 'utf8',
        env: environment,
      });
      assert.equal(rejectedCleanupEvidence.status, 1);
      assert.match(rejectedCleanupEvidence.stderr, /cleanup or host sealing already started/);
      rmSync(cleanupEvidencePath);

      const rollbackJournalPath = join(hostCheckpointDirectory, 'rollback-in-progress.json');
      writeJson(rollbackJournalPath, { status: 'in-progress' });
      const rejectedRollbackJournal = spawnSync('bash', [script, ...args], {
        cwd: scriptDirectory,
        encoding: 'utf8',
        env: environment,
      });
      assert.equal(rejectedRollbackJournal.status, 1);
      assert.match(rejectedRollbackJournal.stderr, /in-progress host transaction/);
      rmSync(rollbackJournalPath);

      const cleanupTargetPath = resourcePath('service', supersededService);
      const originalCleanupTarget = readFileSync(cleanupTargetPath);
      writeJson(cleanupTargetPath, {
        ...JSON.parse(originalCleanupTarget.toString('utf8')),
        metadata: {
          ...JSON.parse(originalCleanupTarget.toString('utf8')).metadata,
          uid: 'uid-replaced-service',
        },
      });
      const rejectedCleanupTargetDrift = spawnSync('bash', [script, ...args], {
        cwd: scriptDirectory,
        encoding: 'utf8',
        env: environment,
      });
      assert.equal(rejectedCleanupTargetDrift.status, 1);
      assert.match(rejectedCleanupTargetDrift.stderr, /cleanup target changed/);
      writeFileSync(cleanupTargetPath, originalCleanupTarget);
    }

    writeFileSync(environment.COMBO_FAKE_BUMP_DELETE_RV_ONCE, '1\n');
    const interrupted = spawnSync('bash', [script, ...args], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(interrupted.status, 1);
    assert.match(interrupted.stderr, /UID\/resourceVersion delete failed/);
    assert.equal(existsSync(environment.COMBO_FAKE_BUMP_DELETE_RV_ONCE), false);
    assert.equal(existsSync(pendingPath), true);
    assert.equal(existsSync(resourcePath('deployment', webName)), true);
    assert.equal(existsSync(resourcePath('service', webName)), true);

    if (predecessorPhase === 'finalizing') {
      const originalCleanupPlan = readFileSync(cleanupPlanPath);
      writeJson(cleanupPlanPath, {
        ...JSON.parse(originalCleanupPlan),
        plannedAt: '2026-07-29T00:01:31.000Z',
      });
      const rejectedCleanupPlanDrift = spawnSync('bash', [script, ...args], {
        cwd: scriptDirectory,
        encoding: 'utf8',
        env: environment,
      });
      assert.equal(rejectedCleanupPlanDrift.status, 1);
      assert.match(
        rejectedCleanupPlanDrift.stderr,
        /finalizing predecessor cleanup plan changed after it was bound/,
      );
      writeFileSync(cleanupPlanPath, originalCleanupPlan);
    }

    const runtimePath = resourcePath('deployment', `release-${oldSourceSha.slice(0, 12)}-runtime`);
    const originalRuntime = readFileSync(runtimePath, 'utf8');
    const changedRuntime = JSON.parse(originalRuntime);
    changedRuntime.spec.template.metadata.annotations['combo.build/release-id'] =
      `release-${'f'.repeat(40)}`;
    writeJson(runtimePath, changedRuntime);
    const rejectedAuthorityDrift = spawnSync('bash', [script, ...args], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(rejectedAuthorityDrift.status, 1);
    assert.match(
      rejectedAuthorityDrift.stderr,
      /changed deletion authority after roll-forward planning/,
    );
    writeFileSync(runtimePath, originalRuntime);

    const first = spawnSync('bash', [script, ...args], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /reset_roll_forward_completed=true/);
    assert.equal(existsSync(pendingPath), false);
    assert.equal(existsSync(resourcePath('deployment', webName)), true);
    assert.equal(existsSync(resourcePath('service', webName)), true);
    for (const role of ['api', 'runtime', 'worker']) {
      assert.equal(
        existsSync(resourcePath('deployment', `release-${oldSourceSha.slice(0, 12)}-${role}`)),
        false,
      );
    }
    for (const role of ['migrate', 'minio-init']) {
      assert.equal(
        existsSync(resourcePath('job', `release-${oldSourceSha.slice(0, 12)}-${role}`)),
        false,
      );
    }

    const publicEvidence = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(publicEvidence.status, 'passed');
    assert.equal(publicEvidence.oldSourceSha, oldSourceSha);
    assert.equal(publicEvidence.newSourceSha, newSourceSha);
    assert.equal(publicEvidence.removedTargets.length, 5);
    assert.deepEqual(
      publicEvidence.removedTargets.find((target) => target.name.endsWith('-migrate')),
      {
        kind: 'job',
        name: `release-${oldSourceSha.slice(0, 12)}-migrate`,
        state: 'already-absent',
        uid: null,
      },
    );
    assert.equal(publicEvidence.checks.secretMaterialAccessed, false);
    assert.doesNotMatch(JSON.stringify(publicEvidence), /resourceVersion|password|token/i);

    const stateDirectory = join(evidenceRoot, 'reset-roll-forwards', 'production');
    const files = readdirSync(stateDirectory);
    const archiveName = files.find((name) => name.endsWith('.old-pending.json'));
    const checkpointName = files.find((name) => name.endsWith('.checkpoint.json'));
    assert.ok(archiveName);
    assert.ok(checkpointName);
    assert.deepEqual(readFileSync(join(stateDirectory, archiveName)), originalPending);
    assert.equal(
      JSON.parse(readFileSync(join(stateDirectory, checkpointName), 'utf8')).phase,
      'completed',
    );

    const second = spawnSync('bash', [script, ...args], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /reset_roll_forward_reused=true/);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), publicEvidence);

    writeJson(pendingPath, {
      schemaVersion: 3,
      environment: 'production',
      namespace: 'combo',
      sourceSha: newSourceSha,
      releaseId: `release-${newSourceSha}`,
      manifestDigest: newManifestDigest,
      foundationResetEvidenceDigest: null,
      phase: 'post-cut',
    });
    const afterNewCandidateArmed = spawnSync('bash', [script, ...args], {
      cwd: scriptDirectory,
      encoding: 'utf8',
      env: environment,
    });
    assert.equal(
      afterNewCandidateArmed.status,
      0,
      `${afterNewCandidateArmed.stdout}\n${afterNewCandidateArmed.stderr}`,
    );
    assert.match(afterNewCandidateArmed.stdout, /reset_roll_forward_reused=true/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const predecessorPhase of ['post-cut', 'finalizing']) {
  test(`full ${predecessorPhase} handoff removes only the five CAS targets and is idempotent`, () =>
    runFullHandoff(predecessorPhase));
}
