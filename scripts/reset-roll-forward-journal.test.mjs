import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { auditResetRollForwardJournals } from './reset-roll-forward-journal.mjs';

const OLD_SOURCE = '1'.repeat(40);
const SOURCE_A = '2'.repeat(40);
const SOURCE_B = '3'.repeat(40);
const OLD_MANIFEST = `sha256:${'a'.repeat(64)}`;
const MANIFEST_A = `sha256:${'b'.repeat(64)}`;
const MANIFEST_B = `sha256:${'c'.repeat(64)}`;
const RESET_DIGEST = `sha256:${'d'.repeat(64)}`;
const SCHEMA_DIGEST = `sha256:${'e'.repeat(64)}`;
const FIXED_TIME = '2026-07-29T00:00:00Z';

function digest(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function requestId(sourceSha, manifestDigest) {
  return digest(
    Buffer.concat([
      Buffer.from('combo-reset-roll-forward-v1'),
      Buffer.from([0]),
      Buffer.from('production'),
      Buffer.from([0]),
      Buffer.from(sourceSha),
      Buffer.from([0]),
      Buffer.from(manifestDigest),
    ]),
  );
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function writeJson(path, value) {
  const content = jsonBuffer(value);
  writeFileSync(path, content, { mode: 0o600 });
  return content;
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'combo-roll-forward-journal-'));
  mkdirSync(join(root, 'reset-roll-forwards', 'production'), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(join(root, 'production'), { mode: 0o700 });
  return root;
}

function oldPending() {
  return {
    cleanupPlanDigest: null,
    environment: 'production',
    foundationCreated: true,
    foundationResetEvidenceDigest: RESET_DIGEST,
    manifestDigest: OLD_MANIFEST,
    namespace: 'combo',
    phase: 'post-cut',
    releaseId: `release-${OLD_SOURCE}`,
    schemaVersion: 3,
    schemaStructureProofDigest: SCHEMA_DIGEST,
    sourceSha: OLD_SOURCE,
    trafficCutAt: FIXED_TIME,
    webService: `release-${OLD_SOURCE.slice(0, 12)}-web`,
  };
}

function buildJournal(
  root,
  {
    sourceSha = SOURCE_A,
    manifestDigest = MANIFEST_A,
    phase = 'completed',
    absentJobs = false,
  } = {},
) {
  const id = requestId(sourceSha, manifestDigest);
  const stem = id.slice('sha256:'.length);
  const stateRoot = join(root, 'reset-roll-forwards', 'production');
  const prefix = join(stateRoot, stem);
  const archiveValue = oldPending();
  const archiveBuffer = jsonBuffer(archiveValue);
  const plan = {
    schemaVersion: 1,
    operation: 'production-reset-roll-forward',
    environment: 'production',
    namespace: 'combo',
    requestId: id,
    createdAt: FIXED_TIME,
    newSourceSha: sourceSha,
    newReleaseId: `release-${sourceSha}`,
    newManifestDigest: manifestDigest,
    oldPending: {
      sourceSha: OLD_SOURCE,
      releaseId: `release-${OLD_SOURCE}`,
      manifestDigest: OLD_MANIFEST,
      phase: 'post-cut',
      foundationResetEvidenceDigest: RESET_DIGEST,
      schemaStructureProofDigest: SCHEMA_DIGEST,
      digest: digest(archiveBuffer),
    },
    activation: {
      sha256SumsDigest: `sha256:${'4'.repeat(64)}`,
      activationEvidenceDigest: `sha256:${'5'.repeat(64)}`,
      resetEvidenceDigest: RESET_DIGEST,
      schemaStructureProofDigest: SCHEMA_DIGEST,
    },
    preservedWeb: {
      name: `release-${OLD_SOURCE.slice(0, 12)}-web`,
      uid: 'old-web-uid',
      resourceVersion: '10',
      serviceName: `release-${OLD_SOURCE.slice(0, 12)}-web`,
      serviceUid: 'old-web-service-uid',
      serviceResourceVersion: '11',
      sourceSha: OLD_SOURCE,
      releaseId: `release-${OLD_SOURCE}`,
      manifestDigest: OLD_MANIFEST,
      webImage: `ghcr.io/dangdang-tech/combo-web@sha256:${'6'.repeat(64)}`,
      trafficStateDigest: `sha256:${'7'.repeat(64)}`,
      forwardEnvDigest: `sha256:${'8'.repeat(64)}`,
      canaryNginxSha256: `sha256:${'9'.repeat(64)}`,
      formalNginxSha256: `sha256:${'0'.repeat(64)}`,
    },
    targets: [
      ['deployment', 'api'],
      ['deployment', 'runtime'],
      ['deployment', 'worker'],
      ['job', 'migrate'],
      ['job', 'minio-init'],
    ].map(([kind, role], index) => {
      const alreadyAbsent = absentJobs && kind === 'job';
      return {
        authorityDigest: alreadyAbsent ? null : `sha256:${String(index + 1).repeat(64)}`,
        kind,
        name: `release-${OLD_SOURCE.slice(0, 12)}-${role}`,
        resourceVersion: alreadyAbsent ? null : String(20 + index),
        state: alreadyAbsent ? 'already-absent' : 'present',
        uid: alreadyAbsent ? null : `${role}-uid`,
      };
    }),
  };
  const planPath = `${prefix}.plan.json`;
  const planBuffer = writeJson(planPath, plan);
  const planDigest = digest(planBuffer);
  const archivePath = `${prefix}.old-pending.json`;
  const sealPath = `${prefix}.handoff-seal.json`;
  const evidencePath = `${prefix}.evidence.json`;
  const cancellationPath = `${prefix}.cancellation.json`;

  const preservedWeb = {
    name: plan.preservedWeb.name,
    uid: plan.preservedWeb.uid,
    serviceName: plan.preservedWeb.serviceName,
    serviceUid: plan.preservedWeb.serviceUid,
  };
  const removedTargets = plan.targets.map(({ kind, name, state, uid }) => ({
    kind,
    name,
    state,
    uid,
  }));
  const seal = {
    schemaVersion: 1,
    status: 'sealed',
    operation: 'production-reset-roll-forward',
    environment: 'production',
    namespace: 'combo',
    requestId: id,
    planDigest,
    pendingArchiveDigest: digest(archiveBuffer),
    oldSourceSha: OLD_SOURCE,
    oldReleaseId: `release-${OLD_SOURCE}`,
    oldManifestDigest: OLD_MANIFEST,
    resetEvidenceDigest: RESET_DIGEST,
    newSourceSha: sourceSha,
    newReleaseId: `release-${sourceSha}`,
    newManifestDigest: manifestDigest,
    preservedWeb,
    removedTargets,
    checks: {
      activeWebPreserved: true,
      oldCandidateWritersRemoved: true,
      pendingArchivePrepared: true,
      resetBoundaryRetained: true,
      secretMaterialAccessed: false,
    },
    sealedAt: FIXED_TIME,
  };
  const sealBuffer = jsonBuffer(seal);
  const evidence = {
    schemaVersion: 1,
    status: 'passed',
    operation: 'production-reset-roll-forward',
    environment: 'production',
    namespace: 'combo',
    requestId: id,
    planDigest,
    pendingArchiveDigest: digest(archiveBuffer),
    handoffSealDigest: digest(sealBuffer),
    oldSourceSha: OLD_SOURCE,
    oldReleaseId: `release-${OLD_SOURCE}`,
    oldManifestDigest: OLD_MANIFEST,
    resetEvidenceDigest: RESET_DIGEST,
    newSourceSha: sourceSha,
    newReleaseId: `release-${sourceSha}`,
    newManifestDigest: manifestDigest,
    preservedWeb,
    removedTargets,
    checks: {
      activeWebPreserved: true,
      oldCandidateWritersRemoved: true,
      pendingArchived: true,
      pendingRemoved: true,
      resetBoundaryRetained: true,
      rollForwardOnly: true,
      secretMaterialAccessed: false,
    },
    completedAt: FIXED_TIME,
  };
  const evidenceBuffer = jsonBuffer(evidence);

  if (['writers-removed', 'handoff-sealed', 'completed', 'cancelled-finalized'].includes(phase)) {
    writeFileSync(archivePath, archiveBuffer, { mode: 0o600 });
  }
  if (['handoff-sealed', 'completed'].includes(phase)) {
    writeFileSync(sealPath, sealBuffer, { mode: 0o600 });
  }
  if (phase === 'completed') {
    writeFileSync(evidencePath, evidenceBuffer, { mode: 0o600 });
  }
  const checkpoint = {
    schemaVersion: 1,
    requestId: id,
    planDigest,
    phase,
    startedAt: FIXED_TIME,
    writersRemovedAt: phase === 'planned' || phase === 'cancelled-finalized' ? null : FIXED_TIME,
    handoffSealedAt: phase === 'handoff-sealed' || phase === 'completed' ? FIXED_TIME : null,
    completedAt: phase === 'completed' || phase === 'cancelled-finalized' ? FIXED_TIME : null,
    archiveDigest:
      phase === 'handoff-sealed' || phase === 'completed' || phase === 'cancelled-finalized'
        ? digest(archiveBuffer)
        : null,
    sealDigest: phase === 'handoff-sealed' || phase === 'completed' ? digest(sealBuffer) : null,
    evidenceDigest: phase === 'completed' ? digest(evidenceBuffer) : null,
    updatedAt: FIXED_TIME,
  };
  writeJson(`${prefix}.checkpoint.json`, checkpoint);
  if (phase === 'cancelled-finalized') {
    const cancellationBuffer = writeJson(cancellationPath, {
      schemaVersion: 1,
      status: 'cancelled',
      operation: 'production-reset-roll-forward',
      environment: 'production',
      namespace: 'combo',
      requestId: id,
      planDigest,
      pendingArchiveDigest: digest(archiveBuffer),
      oldSourceSha: OLD_SOURCE,
      oldReleaseId: `release-${OLD_SOURCE}`,
      oldManifestDigest: OLD_MANIFEST,
      newSourceSha: sourceSha,
      newReleaseId: `release-${sourceSha}`,
      newManifestDigest: manifestDigest,
      checks: {
        predecessorFinalized: true,
        currentCheckpointMatched: true,
        writersRemoved: false,
        pendingArchived: true,
        rollForwardRequired: false,
        secretMaterialAccessed: false,
      },
      reason: 'predecessor-already-finalized',
      completedAt: FIXED_TIME,
    });
    checkpoint.evidenceDigest = digest(cancellationBuffer);
    writeJson(`${prefix}.checkpoint.json`, checkpoint);
  }
  return {
    stem,
    plan,
    planPath,
    checkpointPath: `${prefix}.checkpoint.json`,
    archivePath,
    sealPath,
    evidencePath,
    cancellationPath,
    evidenceBuffer,
  };
}

function writeConsumption(root, journal, kind = 'final') {
  const releaseDirectory = join(
    root,
    'production',
    `release-${journal.plan.newSourceSha}${kind === 'activation' ? '.activation' : ''}`,
  );
  mkdirSync(releaseDirectory, { mode: 0o700 });
  const files = new Map();
  files.set(
    'release.json',
    jsonBuffer({
      sourceSha: journal.plan.newSourceSha,
      releaseId: journal.plan.newReleaseId,
    }),
  );
  files.set('release.sha256', Buffer.from(`${journal.plan.newManifestDigest}\n`));
  files.set('reset-roll-forward-evidence.json', journal.evidenceBuffer);
  if (kind === 'final') {
    files.set(
      'deploy-evidence.json',
      jsonBuffer({
        schemaVersion: 1,
        status: 'passed',
        environment: 'production',
        namespace: 'combo',
        sourceSha: journal.plan.newSourceSha,
        releaseId: journal.plan.newReleaseId,
        manifestDigest: journal.plan.newManifestDigest,
        foundationMode: 'reused',
        foundationResetEvidenceDigest: null,
        checks: {
          protectedAcceptance: true,
          publicTraffic: true,
        },
      }),
    );
  } else {
    files.set(
      'activation-evidence.json',
      jsonBuffer({
        schemaVersion: 1,
        status: 'awaiting-acceptance',
        environment: 'production',
        namespace: 'combo',
        sourceSha: journal.plan.newSourceSha,
        releaseId: journal.plan.newReleaseId,
        manifestDigest: journal.plan.newManifestDigest,
        foundationResetEvidenceDigest: null,
        checks: {
          candidateReady: true,
          trafficActivated: true,
        },
      }),
    );
  }
  for (const [name, content] of files) {
    writeFileSync(join(releaseDirectory, name), content, { mode: 0o600 });
  }
  writeFileSync(
    join(releaseDirectory, 'SHA256SUMS'),
    [...files].map(([name, content]) => `${digest(content).slice(7)}  ${name}\n`).join(''),
    { mode: 0o600 },
  );
  return releaseDirectory;
}

function audit(root, sourceSha, manifestDigest, options = {}) {
  return auditResetRollForwardJournals({
    evidenceRoot: root,
    sourceSha,
    manifestDigest,
    mode: options.mode ?? 'consumer',
    evidencePath: options.evidencePath ?? null,
  });
}

function rewindCancellationCheckpoint(journal) {
  const checkpoint = JSON.parse(readFileSync(journal.checkpointPath, 'utf8'));
  checkpoint.phase = 'planned';
  checkpoint.writersRemovedAt = null;
  checkpoint.handoffSealedAt = null;
  checkpoint.completedAt = null;
  checkpoint.archiveDigest = null;
  checkpoint.sealDigest = null;
  checkpoint.evidenceDigest = null;
  writeJson(journal.checkpointPath, checkpoint);
}

test('an empty journal root admits a consumer without supplied evidence', () => {
  const root = makeRoot();
  try {
    const result = audit(root, SOURCE_A, MANIFEST_A);
    assert.equal(result.currentState, 'absent');
    assert.deepEqual(result.consumedForeignJournals, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the current prepare operation may resume an unfinished journal', () => {
  const root = makeRoot();
  try {
    buildJournal(root, { phase: 'writers-removed' });
    const result = audit(root, SOURCE_A, MANIFEST_A, { mode: 'prepare' });
    assert.equal(result.currentState, 'incomplete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a completed journal preserves old TTL Jobs that were already absent', () => {
  const root = makeRoot();
  try {
    const journal = buildJournal(root, { phase: 'completed', absentJobs: true });
    const result = audit(root, SOURCE_A, MANIFEST_A, { mode: 'prepare' });
    assert.equal(result.currentState, 'completed');
    const evidence = JSON.parse(readFileSync(journal.evidencePath, 'utf8'));
    assert.deepEqual(
      evidence.removedTargets.filter(({ kind }) => kind === 'job'),
      [
        {
          kind: 'job',
          name: `release-${OLD_SOURCE.slice(0, 12)}-migrate`,
          state: 'already-absent',
          uid: null,
        },
        {
          kind: 'job',
          name: `release-${OLD_SOURCE.slice(0, 12)}-minio-init`,
          state: 'already-absent',
          uid: null,
        },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('foreign unfinished journals block every candidate', () => {
  const root = makeRoot();
  try {
    buildJournal(root, { phase: 'planned' });
    assert.throws(
      () => audit(root, SOURCE_B, MANIFEST_B, { mode: 'prepare' }),
      /foreign unfinished reset roll-forward journal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a predecessor-finalized cancellation is terminal and consumed', () => {
  const root = makeRoot();
  try {
    const journal = buildJournal(root, { phase: 'cancelled-finalized' });
    const result = audit(root, SOURCE_B, MANIFEST_B);
    assert.deepEqual(result.consumedForeignJournals, [
      { requestId: `sha256:${journal.stem}`, by: 'cancellation' },
    ]);
    const current = audit(root, SOURCE_A, MANIFEST_A);
    assert.equal(current.currentState, 'cancelled-finalized');
    assert.throws(
      () =>
        audit(root, SOURCE_A, MANIFEST_A, {
          evidencePath: journal.cancellationPath,
        }),
      /has no current completed journal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crash after cancellation archive creation is resumable only by the current prepare', () => {
  const root = makeRoot();
  try {
    const journal = buildJournal(root, { phase: 'cancelled-finalized' });
    rmSync(journal.cancellationPath);
    rewindCancellationCheckpoint(journal);
    const result = audit(root, SOURCE_A, MANIFEST_A, { mode: 'prepare' });
    assert.equal(result.currentState, 'cancelling-finalized');
    assert.throws(
      () => audit(root, SOURCE_A, MANIFEST_A),
      /current unfinished reset roll-forward journal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crash after cancellation proof creation is resumable only by the current prepare', () => {
  const root = makeRoot();
  try {
    const journal = buildJournal(root, { phase: 'cancelled-finalized' });
    rewindCancellationCheckpoint(journal);
    const result = audit(root, SOURCE_A, MANIFEST_A, { mode: 'prepare' });
    assert.equal(result.currentState, 'cancelling-finalized');
    assert.throws(
      () => audit(root, SOURCE_B, MANIFEST_B, { mode: 'prepare' }),
      /foreign unfinished reset roll-forward journal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cancelled-finalized checkpoint requires only its exact cancellation proof', async (t) => {
  await t.test('missing proof', () => {
    const root = makeRoot();
    try {
      const journal = buildJournal(root, { phase: 'cancelled-finalized' });
      rmSync(journal.cancellationPath);
      assert.throws(() => audit(root, SOURCE_A, MANIFEST_A), /lacks its cancellation proof/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await t.test('wrong reason', () => {
    const root = makeRoot();
    try {
      const journal = buildJournal(root, { phase: 'cancelled-finalized' });
      const cancellation = JSON.parse(readFileSync(journal.cancellationPath, 'utf8'));
      cancellation.reason = 'operator-cancelled';
      writeJson(journal.cancellationPath, cancellation);
      assert.throws(() => audit(root, SOURCE_A, MANIFEST_A), /cancellation .* invalid contract/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await t.test('completion evidence is forbidden', () => {
    const root = makeRoot();
    try {
      const journal = buildJournal(root, { phase: 'cancelled-finalized' });
      writeFileSync(journal.evidencePath, journal.evidenceBuffer);
      assert.throws(() => audit(root, SOURCE_A, MANIFEST_A), /lacks its cancellation proof/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('unsafe names, symbolic links, and orphan files fail closed', async (t) => {
  await t.test('unsafe name', () => {
    const root = makeRoot();
    try {
      writeFileSync(join(root, 'reset-roll-forwards', 'production', 'unexpected.json'), '{}');
      assert.throws(() => audit(root, SOURCE_A, MANIFEST_A), /unsafe name/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await t.test('symbolic link', () => {
    const root = makeRoot();
    try {
      const stem = requestId(SOURCE_A, MANIFEST_A).slice(7);
      const target = join(root, 'target.json');
      writeFileSync(target, '{}');
      symlinkSync(target, join(root, 'reset-roll-forwards', 'production', `${stem}.plan.json`));
      assert.throws(() => audit(root, SOURCE_A, MANIFEST_A), /missing or unsafe/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await t.test('orphan checkpoint', () => {
    const root = makeRoot();
    try {
      const stem = requestId(SOURCE_A, MANIFEST_A).slice(7);
      writeJson(join(root, 'reset-roll-forwards', 'production', `${stem}.checkpoint.json`), {});
      assert.throws(() => audit(root, SOURCE_A, MANIFEST_A), /lacks its plan/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('a current completed consumer requires the exact durable evidence', () => {
  const root = makeRoot();
  try {
    const journal = buildJournal(root);
    assert.throws(() => audit(root, SOURCE_A, MANIFEST_A), /requires supplied evidence/);
    const wrong = join(root, 'wrong.json');
    writeFileSync(wrong, '{}\n');
    assert.throws(
      () =>
        audit(root, SOURCE_A, MANIFEST_A, {
          evidencePath: wrong,
        }),
      /differs from durable evidence/,
    );
    const result = audit(root, SOURCE_A, MANIFEST_A, {
      evidencePath: journal.evidencePath,
    });
    assert.equal(result.currentState, 'completed');
    assert.equal(result.suppliedEvidenceValidated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a current completed prepare operation may publish its durable evidence', () => {
  const root = makeRoot();
  try {
    buildJournal(root);
    const result = audit(root, SOURCE_A, MANIFEST_A, { mode: 'prepare' });
    assert.equal(result.currentState, 'completed');
    assert.equal(result.suppliedEvidenceValidated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pending metadata never consumes a foreign completed journal', () => {
  const root = makeRoot();
  try {
    const journal = buildJournal(root);
    writeJson(join(root, 'production', 'pending.json'), {
      schemaVersion: 3,
      sourceSha: journal.plan.newSourceSha,
      releaseId: journal.plan.newReleaseId,
      manifestDigest: journal.plan.newManifestDigest,
    });
    assert.throws(
      () => audit(root, SOURCE_B, MANIFEST_B),
      /foreign completed reset roll-forward journal .* is unconsumed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an exact activation copy consumes a foreign completed journal', () => {
  const root = makeRoot();
  try {
    const journal = buildJournal(root);
    writeConsumption(root, journal, 'activation');
    const result = audit(root, SOURCE_B, MANIFEST_B);
    assert.deepEqual(result.consumedForeignJournals, [
      { requestId: `sha256:${journal.stem}`, by: 'activation' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('valid final evidence wins before unsafe activation residue', () => {
  const root = makeRoot();
  try {
    const journal = buildJournal(root);
    writeConsumption(root, journal, 'final');
    const activation = join(root, 'production', `${journal.plan.newReleaseId}.activation`);
    symlinkSync(join(root, 'missing-activation'), activation);
    const result = audit(root, SOURCE_B, MANIFEST_B);
    assert.equal(result.consumedForeignJournals[0].by, 'final');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid existing final proof cannot fall back to activation', () => {
  const root = makeRoot();
  try {
    const journal = buildJournal(root);
    writeConsumption(root, journal, 'activation');
    const finalized = writeConsumption(root, journal, 'final');
    writeFileSync(join(finalized, 'reset-roll-forward-evidence.json'), '{}\n');
    assert.throws(
      () => audit(root, SOURCE_B, MANIFEST_B),
      /checksum mismatch|differs from its journal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a symbolic-link Production evidence root is rejected before consumption', () => {
  const root = makeRoot();
  try {
    const journal = buildJournal(root);
    const environmentRoot = join(root, 'production');
    const escapedRoot = join(root, 'escaped-production');
    rmSync(environmentRoot, { recursive: true });
    mkdirSync(escapedRoot, { mode: 0o700 });
    symlinkSync(escapedRoot, environmentRoot);
    writeConsumption(root, journal, 'final');
    assert.throws(
      () => audit(root, SOURCE_B, MANIFEST_B),
      /Production release evidence directory is missing or unsafe/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deterministic IDs, checkpoint digests, and phase chains are enforced', async (t) => {
  await t.test('request ID', () => {
    const root = makeRoot();
    try {
      const journal = buildJournal(root);
      const plan = JSON.parse(readFileSync(journal.planPath, 'utf8'));
      plan.requestId = `sha256:${'f'.repeat(64)}`;
      writeJson(journal.planPath, plan);
      assert.throws(() => audit(root, SOURCE_A, MANIFEST_A), /request ID/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await t.test('checkpoint digest', () => {
    const root = makeRoot();
    try {
      const journal = buildJournal(root);
      const checkpoint = JSON.parse(readFileSync(journal.checkpointPath, 'utf8'));
      checkpoint.planDigest = `sha256:${'f'.repeat(64)}`;
      writeJson(journal.checkpointPath, checkpoint);
      assert.throws(() => audit(root, SOURCE_A, MANIFEST_A), /checkpoint .* invalid contract/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await t.test('completed chain', () => {
    const root = makeRoot();
    try {
      const journal = buildJournal(root);
      rmSync(journal.sealPath);
      assert.throws(() => audit(root, SOURCE_A, MANIFEST_A), /lacks its completion chain/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
