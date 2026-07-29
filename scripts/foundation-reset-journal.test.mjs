import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditFoundationResetJournals } from './foundation-reset-journal.mjs';

const POLICY = 'established-clean-slate-v1';
const CLAIMS = ['data-release-minio-0', 'data-release-postgres-0', 'data-release-redis-queue-0'];
const FOUNDATION = [
  ['configmap', 'release-redis-hot-config'],
  ['configmap', 'release-redis-queue-config'],
  ['deployment', 'release-redis-hot'],
  ['service', 'release-minio'],
  ['service', 'release-postgres'],
  ['service', 'release-redis-hot'],
  ['service', 'release-redis-queue'],
  ['statefulset', 'release-minio'],
  ['statefulset', 'release-postgres'],
  ['statefulset', 'release-redis-queue'],
];
const ENVIRONMENTS = {
  preview: {
    namespace: 'combo-review',
    forwardUnit: 'combo-release-preview-web-forward.service',
    forwardPort: 18081,
  },
  production: {
    namespace: 'combo',
    forwardUnit: 'combo-release-production-web-forward.service',
    forwardPort: 18082,
  },
};

function sha256Buffer(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

function requestIdFor(environment, sourceSha, manifestDigest) {
  return sha256Buffer(
    Buffer.concat([
      Buffer.from('combo-foundation-reset-v1'),
      Buffer.from([0]),
      Buffer.from(environment),
      Buffer.from([0]),
      Buffer.from(sourceSha),
      Buffer.from([0]),
      Buffer.from(manifestDigest),
      Buffer.from([0]),
      Buffer.from(POLICY),
    ]),
  );
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function uuid(number) {
  const value = number.toString(16).padStart(32, '0').slice(-32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(
    16,
    20,
  )}-${value.slice(20)}`;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function storageRows(environment, base, internal = true) {
  const namespace = ENVIRONMENTS[environment].namespace;
  return CLAIMS.map((claim, index) => {
    const claimUid = uuid(base + index * 4);
    const volume = `pvc-${claimUid}`;
    const row = {
      claim,
      claimUid,
      claimResourceVersion: `${base + index + 1}`,
      path: `/srv/k3s/storage/${volume}_${namespace}_${claim}`,
      volume,
      volumeUid: uuid(base + index * 4 + 1),
      volumeResourceVersion: `${base + index + 2}`,
    };
    if (internal) {
      row.claimAuthorityDigest = digest(((base + index + 2) % 10).toString());
      row.volumeAuthorityDigest = digest(((base + index + 3) % 10).toString());
    }
    return row;
  });
}

function internalStorage(publicRows, authoritySeed) {
  return publicRows.map((row, index) => ({
    ...row,
    claimAuthorityDigest: digest(((authoritySeed + index) % 10).toString()),
    volumeAuthorityDigest: digest(((authoritySeed + index + 3) % 10).toString()),
  }));
}

function publicStorage(rows) {
  return rows.map(
    ({
      claim,
      claimUid,
      claimResourceVersion,
      path,
      volume,
      volumeUid,
      volumeResourceVersion,
    }) => ({
      claim,
      claimUid,
      claimResourceVersion,
      path,
      volume,
      volumeUid,
      volumeResourceVersion,
    }),
  );
}

function preservedWeb(environment, sourceSha = 'f'.repeat(40), seed = 900) {
  const contract = ENVIRONMENTS[environment];
  return {
    name: `release-${sourceSha.slice(0, 12)}-web`,
    uid: uuid(seed),
    resourceVersion: '90',
    serviceName: `release-${sourceSha.slice(0, 12)}-web`,
    serviceUid: uuid(seed + 1),
    serviceResourceVersion: '91',
    sourceSha,
    releaseId: `release-${sourceSha}`,
    manifestDigest: digest('e'),
    webImage: `ghcr.io/dangdang-tech/combo-web@${digest('d')}`,
    trafficStateDigest: digest('c'),
    forwardEnvDigest: digest('b'),
    forwardUnit: contract.forwardUnit,
    forwardPort: contract.forwardPort,
    routeVersionDigest: digest('a'),
    canaryNginxSha256: digest('9'),
    formalNginxSha256: environment === 'production' ? digest('8') : null,
  };
}

function captured(kind, name, seed) {
  return {
    authorityDigest: digest(((seed + 2) % 10).toString()),
    kind,
    name,
    resourceVersion: `${seed + 10}`,
    uid: uuid(seed),
  };
}

function descriptorFor(node) {
  return {
    environment: node.plan.environment,
    namespace: node.plan.namespace,
    requestId: node.plan.requestId,
    sourceSha: node.plan.sourceSha,
    releaseId: node.plan.releaseId,
    manifestDigest: node.plan.manifestDigest,
    planDigest: node.planDigest,
    foundationSnapshotDigest: node.evidence.foundationSnapshotDigest,
    evidenceDigest: node.evidenceDigest,
  };
}

function createRoot(environment = 'preview') {
  const root = mkdtempSync(join(tmpdir(), 'foundation-reset-journal-'));
  mkdirSync(join(root, 'foundation-resets', environment), { recursive: true });
  mkdirSync(join(root, environment), { recursive: true });
  return root;
}

function createJournal(
  root,
  {
    environment = 'preview',
    sourceCharacter = '1',
    manifestCharacter = '2',
    storageSeed = 100,
    foundationSeed = 200,
    timeMinute = 1,
    predecessor = null,
    completed = true,
    phase = completed ? 'foundation-ready' : 'planned',
    mutatePlan = () => {},
    mutateReady = () => {},
    mutateEvidence = () => {},
    requestIdOverride,
  } = {},
) {
  const contract = ENVIRONMENTS[environment];
  const sourceSha = sourceCharacter.repeat(40);
  const manifestDigest = digest(manifestCharacter);
  const requestId = requestIdOverride ?? requestIdFor(environment, sourceSha, manifestDigest);
  const stem = requestId.slice('sha256:'.length);
  const directory = join(root, 'foundation-resets', environment);
  mkdirSync(directory, { recursive: true });
  const planPath = join(directory, `${stem}.foundation-reset-plan.json`);
  const checkpointPath = join(directory, `${stem}.foundation-reset-checkpoint.json`);
  const readyPath = join(directory, `${stem}.foundation-reset-ready.json`);
  const evidencePath = join(directory, `${stem}.foundation-reset-evidence.json`);
  const supersededReset = predecessor ? descriptorFor(predecessor) : null;
  const web = predecessor
    ? structuredClone(predecessor.plan.preservedWeb)
    : preservedWeb(environment);
  const oldStorage = predecessor
    ? internalStorage(predecessor.evidence.newStorage, storageSeed + 30)
    : storageRows(environment, storageSeed, true);
  const targets = predecessor
    ? predecessor.evidence.foundation.map((row, index) =>
        captured(row.kind, row.name, index + foundationSeed),
      )
    : FOUNDATION.map(([kind, name], index) => captured(kind, name, index + foundationSeed));
  if (predecessor) {
    for (let index = 0; index < targets.length; index += 1) {
      targets[index].uid = predecessor.evidence.foundation[index].uid;
    }
  }
  const writerPrefix = `release-${web.sourceSha.slice(0, 12)}-`;
  const plan = {
    schemaVersion: predecessor ? 2 : 1,
    policy: POLICY,
    requestId,
    authorityDigest: manifestDigest,
    environment,
    namespace: contract.namespace,
    sourceSha,
    releaseId: `release-${sourceSha}`,
    manifestDigest,
    foundationYamlDigest: digest('7'),
    createdAt: `2026-07-29T00:${String(timeMinute).padStart(2, '0')}:00Z`,
    preservedWeb: web,
    writerDeployments: predecessor
      ? []
      : ['api', 'runtime', 'worker'].map((role, index) =>
          captured('deployment', `${writerPrefix}${role}`, 400 + index),
        ),
    jobs: [],
    targets,
    oldStorage,
  };
  if (predecessor) plan.supersededReset = supersededReset;
  mutatePlan(plan);
  writeJson(planPath, plan);
  const planDigest = sha256File(planPath);

  const newStorage = storageRows(environment, storageSeed + 500, true);
  const foundation = FOUNDATION.map(([kind, name], index) => ({
    kind,
    name,
    uid: uuid(foundationSeed + 500 + index),
  }));
  const ready = {
    schemaVersion: 1,
    requestId,
    planDigest,
    newStorage,
    foundation,
  };
  mutateReady(ready);
  if (phase !== 'planned') writeJson(readyPath, ready);
  const readyDigest = phase !== 'planned' ? sha256File(readyPath) : null;

  const startedAt = plan.createdAt;
  const storageClearedAt =
    phase === 'planned' ? null : `2026-07-29T00:${String(timeMinute + 1).padStart(2, '0')}:00Z`;
  const foundationReadyAt =
    phase === 'foundation-ready'
      ? `2026-07-29T00:${String(timeMinute + 2).padStart(2, '0')}:00Z`
      : null;
  const checkpoint = {
    schemaVersion: 1,
    requestId,
    planDigest,
    phase,
    startedAt,
    storageClearedAt,
    foundationReadyAt,
    foundationSnapshotDigest: phase === 'foundation-ready' ? readyDigest : null,
    updatedAt: `2026-07-29T00:${String(timeMinute + 3).padStart(2, '0')}:00Z`,
  };
  writeJson(checkpointPath, checkpoint);

  let evidence = null;
  let evidenceDigest = null;
  if (completed) {
    evidence = {
      schemaVersion: plan.schemaVersion,
      status: 'passed',
      policy: POLICY,
      requestId,
      authorityDigest: manifestDigest,
      environment,
      namespace: contract.namespace,
      sourceSha,
      releaseId: `release-${sourceSha}`,
      manifestDigest,
      planDigest,
      startedAt,
      storageClearedAt,
      foundationReadyAt,
      foundationSnapshotDigest: readyDigest,
      oldStorage: publicStorage(plan.oldStorage),
      newStorage: publicStorage(ready.newStorage),
      foundation: ready.foundation,
      preservedWeb: { name: web.name, uid: web.uid },
      checks: {
        writersFenced: true,
        oldStorageRemoved: true,
        newStorageIdentity: true,
        activeWebPreserved: true,
        ...(predecessor ? { supersededResetContinuity: true } : {}),
      },
      completedAt: `2026-07-29T00:${String(timeMinute + 4).padStart(2, '0')}:00Z`,
    };
    if (predecessor) evidence.supersededReset = structuredClone(plan.supersededReset);
    mutateEvidence(evidence);
    writeJson(evidencePath, evidence);
    evidenceDigest = sha256File(evidencePath);
  }
  return {
    root,
    stem,
    planPath,
    checkpointPath,
    readyPath,
    evidencePath,
    plan,
    planDigest,
    checkpoint,
    ready,
    readyDigest,
    evidence,
    evidenceDigest,
  };
}

function audit(root, options = {}) {
  const environment = options.environment ?? 'preview';
  return auditFoundationResetJournals({
    evidenceRoot: root,
    environment,
    sourceSha: options.sourceSha ?? 'a'.repeat(40),
    manifestDigest: options.manifestDigest ?? digest('6'),
    mode: options.mode ?? 'reuse',
    evidence: options.evidence,
  });
}

function checksumLine(path, name) {
  return `${sha256File(path).slice('sha256:'.length)}  ${name}\n`;
}

function finalizeJournal(root, node) {
  const directory = join(root, node.plan.environment, node.plan.releaseId);
  mkdirSync(directory);
  const resetName = 'foundation-reset-evidence.json';
  const proofName = 'deploy-evidence.json';
  copyFileSync(node.evidencePath, join(directory, resetName));
  writeJson(join(directory, proofName), {
    schemaVersion: 1,
    status: 'passed',
    environment: node.plan.environment,
    namespace: node.plan.namespace,
    sourceSha: node.plan.sourceSha,
    releaseId: node.plan.releaseId,
    manifestDigest: node.plan.manifestDigest,
    foundationMode: 'reset',
    foundationResetEvidenceDigest: node.evidenceDigest,
    foundationReset: node.evidence,
  });
  writeFileSync(
    join(directory, 'SHA256SUMS'),
    checksumLine(join(directory, resetName), resetName) +
      checksumLine(join(directory, proofName), proofName),
  );
  return directory;
}

function writePending(root, node) {
  writeJson(join(root, node.plan.environment, 'pending.json'), {
    cleanupPlanDigest: null,
    environment: node.plan.environment,
    foundationCreated: true,
    foundationResetEvidenceDigest: node.evidenceDigest,
    manifestDigest: node.plan.manifestDigest,
    namespace: node.plan.namespace,
    phase: 'armed',
    releaseId: node.plan.releaseId,
    schemaVersion: 3,
    schemaStructureProofDigest: digest('5'),
    sourceSha: node.plan.sourceSha,
    trafficCutAt: null,
    webService: `release-${node.plan.sourceSha.slice(0, 12)}-web`,
  });
}

function activateProductionJournal(root, node) {
  const directory = join(root, 'production', `${node.plan.releaseId}.activation`);
  mkdirSync(directory);
  copyFileSync(node.evidencePath, join(directory, 'foundation-reset-evidence.json'));
  writeJson(join(directory, 'activation-evidence.json'), {
    schemaVersion: 1,
    status: 'awaiting-acceptance',
    environment: 'production',
    namespace: 'combo',
    sourceSha: node.plan.sourceSha,
    releaseId: node.plan.releaseId,
    manifestDigest: node.plan.manifestDigest,
    foundationResetEvidenceDigest: node.evidenceDigest,
  });
  writeFileSync(
    join(directory, 'SHA256SUMS'),
    checksumLine(
      join(directory, 'foundation-reset-evidence.json'),
      'foundation-reset-evidence.json',
    ) + checksumLine(join(directory, 'activation-evidence.json'), 'activation-evidence.json'),
  );
}

test('empty journal permits normal reset and reuse', () => {
  const root = createRoot();
  try {
    const reset = audit(root, { mode: 'reset' });
    assert.equal(reset.authorization, 'normal-reset');
    assert.equal(reset.currentRetry, false);
    assert.equal(reset.chainHeadRequestId, null);
    assert.equal(reset.chainConsumed, true);
    assert.equal(reset.predecessorEvidencePath, null);

    const reuse = audit(root, { mode: 'reuse' });
    assert.equal(reuse.authorization, 'reuse');
    assert.equal(reuse.chainConsumed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Preview reset selects the unique completed unconsumed head as predecessor', () => {
  const root = createRoot();
  try {
    const first = createJournal(root);
    const result = audit(root, { mode: 'reset' });
    assert.equal(result.authorization, 'superseding-reset');
    assert.equal(result.chainConsumed, false);
    assert.equal(result.chainHeadRequestId, first.plan.requestId);
    assert.equal(result.predecessorEvidencePath, first.evidencePath);
    assert.deepEqual(result.supersededReset, descriptorFor(first));
    assert.equal(result.currentRetry, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Production never admits a superseding reset chain', () => {
  const root = createRoot('production');
  try {
    createJournal(root, { environment: 'production' });
    assert.throws(
      () => audit(root, { environment: 'production', mode: 'reset' }),
      /unconsumed completed foundation reset blocks Production reset/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('completed Preview successor is exact deploy authority and final proof consumes the chain', () => {
  const root = createRoot();
  try {
    const first = createJournal(root, { timeMinute: 1 });
    const second = createJournal(root, {
      sourceCharacter: '3',
      manifestCharacter: '4',
      storageSeed: 1000,
      foundationSeed: 1200,
      timeMinute: 10,
      predecessor: first,
    });

    const retry = audit(root, {
      mode: 'reset',
      sourceSha: second.plan.sourceSha,
      manifestDigest: second.plan.manifestDigest,
    });
    assert.equal(retry.authorization, 'exact-reset-retry');
    assert.equal(retry.currentRetry, true);
    assert.equal(retry.chainHeadRequestId, second.plan.requestId);
    assert.deepEqual(retry.supersededReset, descriptorFor(first));

    const deploy = audit(root, {
      mode: 'deploy-reset',
      sourceSha: second.plan.sourceSha,
      manifestDigest: second.plan.manifestDigest,
      evidence: second.evidencePath,
    });
    assert.equal(deploy.authorization, 'exact-reset-deploy');
    assert.equal(deploy.chainConsumed, false);

    assert.throws(() => audit(root, { mode: 'reuse' }), /unconsumed foundation reset chain/);
    finalizeJournal(root, second);
    const reuse = audit(root, { mode: 'reuse' });
    assert.equal(reuse.authorization, 'reuse');
    assert.equal(reuse.chainConsumed, true);
    assert.equal(reuse.completedJournalCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pending proof is consumption but blocks a different candidate reset or reuse', () => {
  const root = createRoot();
  try {
    const first = createJournal(root);
    writePending(root, first);
    const retry = audit(root, {
      mode: 'deploy-reset',
      sourceSha: first.plan.sourceSha,
      manifestDigest: first.plan.manifestDigest,
      evidence: first.evidencePath,
    });
    assert.equal(retry.authorization, 'exact-reset-deploy');
    assert.equal(retry.chainConsumed, true);
    assert.throws(() => audit(root, { mode: 'reuse' }), /pending clean-slate boundary/);
    assert.throws(() => audit(root, { mode: 'reset' }), /pending clean-slate boundary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Production activation is an exact terminal consumption proof', () => {
  const root = createRoot('production');
  try {
    const first = createJournal(root, { environment: 'production' });
    activateProductionJournal(root, first);
    const result = audit(root, { environment: 'production', mode: 'reuse' });
    assert.equal(result.chainConsumed, true);
    assert.equal(result.authorization, 'reuse');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exact unfinished current reset can retry but cannot deploy or reuse', () => {
  const root = createRoot();
  try {
    const current = createJournal(root, {
      sourceCharacter: '7',
      manifestCharacter: '8',
      completed: false,
      phase: 'planned',
    });
    const retry = audit(root, {
      mode: 'reset',
      sourceSha: current.plan.sourceSha,
      manifestDigest: current.plan.manifestDigest,
    });
    assert.equal(retry.authorization, 'exact-reset-retry');
    assert.equal(retry.currentRetry, true);
    assert.throws(
      () =>
        audit(root, {
          mode: 'deploy-reset',
          sourceSha: current.plan.sourceSha,
          manifestDigest: current.plan.manifestDigest,
          evidence: current.evidencePath,
        }),
      /completed current reset journal/,
    );
    assert.throws(() => audit(root, { mode: 'reuse' }), /unfinished foundation reset journal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('forked successor plans are rejected', () => {
  const root = createRoot();
  try {
    const first = createJournal(root, { timeMinute: 1 });
    createJournal(root, {
      sourceCharacter: '3',
      manifestCharacter: '4',
      storageSeed: 1000,
      foundationSeed: 1200,
      timeMinute: 10,
      predecessor: first,
    });
    createJournal(root, {
      sourceCharacter: '5',
      manifestCharacter: '6',
      storageSeed: 2000,
      foundationSeed: 2200,
      timeMinute: 20,
      predecessor: first,
    });
    assert.throws(() => audit(root, { mode: 'reset' }), /forked successor chain/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('forged cycle and missing predecessor cannot become reset authority', () => {
  const root = createRoot();
  try {
    const first = createJournal(root, { completed: false, phase: 'planned' });
    const plan = JSON.parse(readFileSync(first.planPath, 'utf8'));
    plan.schemaVersion = 2;
    plan.supersededReset = {
      environment: 'preview',
      namespace: 'combo-review',
      requestId: plan.requestId,
      sourceSha: plan.sourceSha,
      releaseId: plan.releaseId,
      manifestDigest: plan.manifestDigest,
      planDigest: digest('1'),
      foundationSnapshotDigest: digest('2'),
      evidenceDigest: digest('3'),
    };
    writeJson(first.planPath, plan);
    assert.throws(
      () =>
        audit(root, {
          mode: 'reset',
          sourceSha: first.plan.sourceSha,
          manifestDigest: first.plan.manifestDigest,
        }),
      /does not identify an older reset|missing completed predecessor/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-deterministic request identity and orphan paths fail closed', () => {
  const root = createRoot();
  try {
    createJournal(root, {
      requestIdOverride: `sha256:${'9'.repeat(64)}`,
    });
    assert.throws(() => audit(root), /non-deterministic request ID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const orphanRoot = createRoot();
  try {
    const orphan = join(
      orphanRoot,
      'foundation-resets',
      'preview',
      `${'a'.repeat(64)}.foundation-reset-ready.json`,
    );
    writeJson(orphan, {});
    assert.throws(() => audit(orphanRoot), /orphan file/);
  } finally {
    rmSync(orphanRoot, { recursive: true, force: true });
  }
});

test('storage identities are unique across claims and disjoint across reset generations', () => {
  const duplicateRoot = createRoot();
  try {
    createJournal(duplicateRoot, {
      mutatePlan(plan) {
        const reused = plan.oldStorage[0];
        const target = plan.oldStorage[1];
        target.claimUid = reused.claimUid;
        target.volume = reused.volume;
        target.volumeUid = reused.volumeUid;
        target.path = `/srv/k3s/storage/${target.volume}_${plan.namespace}_${target.claim}`;
      },
    });
    assert.throws(() => audit(duplicateRoot), /reuses (?:claimUid|volume|volumeUid) across claims/);
  } finally {
    rmSync(duplicateRoot, { recursive: true, force: true });
  }

  const crossGenerationRoot = createRoot();
  try {
    const oldStorage = storageRows('preview', 100);
    createJournal(crossGenerationRoot, {
      mutateReady(ready) {
        ready.newStorage[0].volumeUid = oldStorage[1].volumeUid;
      },
    });
    assert.throws(() => audit(crossGenerationRoot), /reused an old storage identity/);
  } finally {
    rmSync(crossGenerationRoot, { recursive: true, force: true });
  }
});

test('schema v1 permits only the exact active writer and job identity', () => {
  for (const [mutatePlan, expected] of [
    [
      (plan) => {
        plan.writerDeployments.push(captured('deployment', `release-${'e'.repeat(12)}-api`, 5000));
      },
      /active writers differs from the exact contract/,
    ],
    [
      (plan) => {
        plan.jobs.push(captured('job', `release-${'e'.repeat(12)}-migrate`, 5001));
      },
      /contains a non-active job/,
    ],
  ]) {
    const root = createRoot();
    try {
      createJournal(root, { mutatePlan });
      assert.throws(() => audit(root), expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('successor must capture predecessor storage, foundation, and full traffic identity', () => {
  for (const [label, mutatePlan, expected] of [
    [
      'storage',
      (plan) => {
        plan.oldStorage[0].claimResourceVersion = '99999';
      },
      /capture predecessor storage exactly/,
    ],
    [
      'foundation',
      (plan) => {
        plan.targets[0].uid = uuid(9999);
      },
      /capture predecessor foundation UIDs/,
    ],
    [
      'traffic',
      (plan) => {
        plan.preservedWeb.routeVersionDigest = digest('0');
      },
      /changed preserved Web or traffic identity/,
    ],
  ]) {
    const root = createRoot();
    try {
      const first = createJournal(root, { timeMinute: 1 });
      createJournal(root, {
        sourceCharacter: '3',
        manifestCharacter: '4',
        storageSeed: 1000,
        foundationSeed: 1200,
        timeMinute: 10,
        predecessor: first,
        mutatePlan,
      });
      assert.throws(() => audit(root, { mode: 'reset' }), expected, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('successor permits only volatile preserved Web resourceVersion drift', () => {
  const root = createRoot();
  try {
    const first = createJournal(root, { timeMinute: 1 });
    const second = createJournal(root, {
      sourceCharacter: '3',
      manifestCharacter: '4',
      storageSeed: 1000,
      foundationSeed: 1200,
      timeMinute: 10,
      predecessor: first,
      mutatePlan(plan) {
        plan.preservedWeb.resourceVersion = '999';
        plan.preservedWeb.serviceResourceVersion = '1000';
      },
    });
    const result = audit(root, {
      mode: 'reset',
      sourceSha: second.plan.sourceSha,
      manifestDigest: second.plan.manifestDigest,
    });
    assert.equal(result.authorization, 'exact-reset-retry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('successor permits the fixed foundation initialization Job but rejects missing continuity', () => {
  const root = createRoot();
  try {
    const first = createJournal(root, { timeMinute: 1 });
    const second = createJournal(root, {
      sourceCharacter: '3',
      manifestCharacter: '4',
      storageSeed: 1000,
      foundationSeed: 1200,
      timeMinute: 10,
      predecessor: first,
      mutatePlan(plan) {
        plan.jobs.push(captured('job', 'release-minio-init', 777));
      },
    });
    const result = audit(root, {
      mode: 'reset',
      sourceSha: second.plan.sourceSha,
      manifestDigest: second.plan.manifestDigest,
    });
    assert.equal(result.authorization, 'exact-reset-retry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const missingContinuityRoot = createRoot();
  try {
    const first = createJournal(missingContinuityRoot, { timeMinute: 1 });
    createJournal(missingContinuityRoot, {
      sourceCharacter: '3',
      manifestCharacter: '4',
      storageSeed: 1000,
      foundationSeed: 1200,
      timeMinute: 10,
      predecessor: first,
      mutateEvidence(evidence) {
        delete evidence.checks.supersededResetContinuity;
      },
    });
    assert.throws(() => audit(missingContinuityRoot, { mode: 'reset' }), /invalid chain/);
  } finally {
    rmSync(missingContinuityRoot, { recursive: true, force: true });
  }
});

test('schema v2 is rejected for Production even when its predecessor exists', () => {
  const root = createRoot('production');
  try {
    const first = createJournal(root, { environment: 'production', timeMinute: 1 });
    createJournal(root, {
      environment: 'production',
      sourceCharacter: '3',
      manifestCharacter: '4',
      storageSeed: 1000,
      foundationSeed: 1200,
      timeMinute: 10,
      predecessor: first,
    });
    assert.throws(
      () => audit(root, { environment: 'production', mode: 'reset' }),
      /schema v2 is Preview-only/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deploy-reset requires byte-identical durable evidence', () => {
  const root = createRoot();
  try {
    const first = createJournal(root);
    const changed = join(root, 'changed-evidence.json');
    writeJson(changed, { ...first.evidence, completedAt: '2026-07-29T23:59:59Z' });
    assert.throws(
      () =>
        audit(root, {
          mode: 'deploy-reset',
          sourceSha: first.plan.sourceSha,
          manifestDigest: first.plan.manifestDigest,
          evidence: changed,
        }),
      /differs from the durable current journal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tampered final checksum proof and unsafe journal path fail closed', () => {
  const root = createRoot();
  try {
    const first = createJournal(root);
    const directory = finalizeJournal(root, first);
    writeFileSync(join(directory, 'deploy-evidence.json'), '{}\n');
    assert.throws(() => audit(root), /checksummed release file deploy-evidence\.json changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const linkedRoot = createRoot();
  try {
    const target = join(linkedRoot, 'target.json');
    writeJson(target, {});
    symlinkSync(
      target,
      join(
        linkedRoot,
        'foundation-resets',
        'preview',
        `${'a'.repeat(64)}.foundation-reset-plan.json`,
      ),
    );
    assert.throws(() => audit(linkedRoot), /missing or unsafe/);
  } finally {
    rmSync(linkedRoot, { recursive: true, force: true });
  }

  const linkedParentRoot = createRoot();
  const linkedParentTarget = mkdtempSync(join(tmpdir(), 'foundation-reset-journal-parent-'));
  try {
    rmSync(join(linkedParentRoot, 'foundation-resets'), { recursive: true, force: true });
    symlinkSync(linkedParentTarget, join(linkedParentRoot, 'foundation-resets'), 'dir');
    assert.throws(() => audit(linkedParentRoot), /foundation reset root is missing or unsafe/);
  } finally {
    rmSync(linkedParentRoot, { recursive: true, force: true });
    rmSync(linkedParentTarget, { recursive: true, force: true });
  }
});

test('a checksummed but shallow final proof cannot consume reset evidence', () => {
  const root = createRoot();
  try {
    const first = createJournal(root);
    const directory = finalizeJournal(root, first);
    const proofPath = join(directory, 'deploy-evidence.json');
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    proof.foundationReset = { status: 'passed' };
    writeJson(proofPath, proof);
    writeFileSync(
      join(directory, 'SHA256SUMS'),
      checksumLine(
        join(directory, 'foundation-reset-evidence.json'),
        'foundation-reset-evidence.json',
      ) + checksumLine(proofPath, 'deploy-evidence.json'),
    );
    assert.throws(() => audit(root), /final release evidence does not consume reset/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
