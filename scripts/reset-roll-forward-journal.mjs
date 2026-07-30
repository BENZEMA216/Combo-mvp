#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const STEM_RE =
  /^([0-9a-f]{64})\.(plan|checkpoint|old-pending|handoff-seal|evidence|cancellation)\.json$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const FILE_KINDS = [
  'plan',
  'checkpoint',
  'old-pending',
  'handoff-seal',
  'evidence',
  'cancellation',
];

class JournalError extends Error {}

function fail(message) {
  throw new JournalError(message);
}

function sha256Buffer(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha256File(path) {
  return sha256Buffer(readRegularFile(path));
}

function requestIdFor(sourceSha, manifestDigest) {
  return sha256Buffer(
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

function pathState(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail(`cannot inspect path: ${path}`);
  }
}

function requireDirectory(path, context, { allowMissing = false } = {}) {
  const state = pathState(path);
  if (state === null && allowMissing) return false;
  if (state === null || state.isSymbolicLink() || !state.isDirectory()) {
    fail(`${context} is missing or unsafe`);
  }
  return true;
}

function requireRegularFile(path, context) {
  const state = pathState(path);
  if (state === null || state.isSymbolicLink() || !state.isFile() || state.size > MAX_FILE_BYTES) {
    fail(`${context} is missing or unsafe`);
  }
  return state;
}

function readRegularFile(path, context = `file ${path}`) {
  requireRegularFile(path, context);
  return readFileSync(path);
}

function readJson(path, context) {
  const input = readRegularFile(path, context);
  try {
    return JSON.parse(input.toString('utf8'));
  } catch {
    fail(`${context} is not valid JSON`);
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value, expected) {
  return (
    isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function hasTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && value.endsWith('Z');
}

function hasNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function sameJson(left, right) {
  return isDeepStrictEqual(left, right);
}

function validatePlan(path, stem) {
  const plan = readJson(path, 'roll-forward plan');
  const planKeys = [
    'schemaVersion',
    'operation',
    'environment',
    'namespace',
    'requestId',
    'createdAt',
    'newSourceSha',
    'newReleaseId',
    'newManifestDigest',
    'oldPending',
    'activation',
    'preservedWeb',
    'targets',
  ];
  if (
    !hasExactKeys(plan, planKeys) ||
    plan.schemaVersion !== 1 ||
    plan.operation !== 'production-reset-roll-forward' ||
    plan.environment !== 'production' ||
    plan.namespace !== 'combo' ||
    !hasTimestamp(plan.createdAt) ||
    !SHA_RE.test(plan.newSourceSha) ||
    plan.newReleaseId !== `release-${plan.newSourceSha}` ||
    !DIGEST_RE.test(plan.newManifestDigest)
  ) {
    fail(`roll-forward plan ${stem} has an invalid top-level contract`);
  }
  const expectedRequestId = requestIdFor(plan.newSourceSha, plan.newManifestDigest);
  if (plan.requestId !== expectedRequestId || plan.requestId !== `sha256:${stem}`) {
    fail(`roll-forward plan ${stem} has a non-deterministic request ID`);
  }

  const oldPendingKeys = [
    'sourceSha',
    'releaseId',
    'manifestDigest',
    'phase',
    'foundationCreated',
    'foundationResetEvidenceDigest',
    'schemaStructureProofDigest',
    'digest',
  ];
  const old = plan.oldPending;
  if (
    !hasExactKeys(old, oldPendingKeys) ||
    !SHA_RE.test(old.sourceSha) ||
    old.releaseId !== `release-${old.sourceSha}` ||
    old.sourceSha === plan.newSourceSha ||
    !DIGEST_RE.test(old.manifestDigest) ||
    !['post-cut', 'finalizing'].includes(old.phase) ||
    typeof old.foundationCreated !== 'boolean' ||
    !DIGEST_RE.test(old.foundationResetEvidenceDigest) ||
    !DIGEST_RE.test(old.schemaStructureProofDigest) ||
    !DIGEST_RE.test(old.digest)
  ) {
    fail(`roll-forward plan ${stem} has an invalid old pending identity`);
  }

  const activation = plan.activation;
  if (
    !hasExactKeys(activation, [
      'sha256SumsDigest',
      'activationEvidenceDigest',
      'resetEvidenceDigest',
      'schemaStructureProofDigest',
    ]) ||
    !DIGEST_RE.test(activation.sha256SumsDigest) ||
    !DIGEST_RE.test(activation.activationEvidenceDigest) ||
    activation.resetEvidenceDigest !== old.foundationResetEvidenceDigest ||
    activation.schemaStructureProofDigest !== old.schemaStructureProofDigest
  ) {
    fail(`roll-forward plan ${stem} has an invalid activation authority`);
  }

  const preserved = plan.preservedWeb;
  if (
    !hasExactKeys(preserved, [
      'name',
      'uid',
      'resourceVersion',
      'serviceName',
      'serviceUid',
      'serviceResourceVersion',
      'sourceSha',
      'releaseId',
      'manifestDigest',
      'webImage',
      'trafficStateDigest',
      'forwardEnvDigest',
      'canaryNginxSha256',
      'formalNginxSha256',
    ]) ||
    preserved.name !== `release-${old.sourceSha.slice(0, 12)}-web` ||
    preserved.serviceName !== preserved.name ||
    preserved.sourceSha !== old.sourceSha ||
    preserved.releaseId !== old.releaseId ||
    preserved.manifestDigest !== old.manifestDigest ||
    !hasNonemptyString(preserved.uid) ||
    !hasNonemptyString(preserved.resourceVersion) ||
    !hasNonemptyString(preserved.serviceUid) ||
    !hasNonemptyString(preserved.serviceResourceVersion) ||
    !/^ghcr\.io\/dangdang-tech\/combo-web@sha256:[0-9a-f]{64}$/.test(preserved.webImage) ||
    !DIGEST_RE.test(preserved.trafficStateDigest) ||
    !DIGEST_RE.test(preserved.forwardEnvDigest) ||
    !DIGEST_RE.test(preserved.canaryNginxSha256) ||
    !DIGEST_RE.test(preserved.formalNginxSha256)
  ) {
    fail(`roll-forward plan ${stem} has an invalid preserved Web identity`);
  }

  const expectedTargets = [
    `deployment/release-${old.sourceSha.slice(0, 12)}-api`,
    `deployment/release-${old.sourceSha.slice(0, 12)}-runtime`,
    `deployment/release-${old.sourceSha.slice(0, 12)}-worker`,
    `job/release-${old.sourceSha.slice(0, 12)}-migrate`,
    `job/release-${old.sourceSha.slice(0, 12)}-minio-init`,
  ].sort();
  if (
    !Array.isArray(plan.targets) ||
    plan.targets.length !== expectedTargets.length ||
    JSON.stringify(plan.targets.map((target) => `${target.kind}/${target.name}`).sort()) !==
      JSON.stringify(expectedTargets) ||
    !plan.targets.every(
      (target) =>
        hasExactKeys(target, [
          'authorityDigest',
          'kind',
          'name',
          'resourceVersion',
          'state',
          'uid',
        ]) &&
        ['deployment', 'job'].includes(target.kind) &&
        ((target.state === 'present' &&
          hasNonemptyString(target.uid) &&
          hasNonemptyString(target.resourceVersion) &&
          DIGEST_RE.test(target.authorityDigest)) ||
          (target.state === 'already-absent' &&
            target.kind === 'job' &&
            target.uid === null &&
            target.resourceVersion === null &&
            target.authorityDigest === null)),
    )
  ) {
    fail(`roll-forward plan ${stem} has an invalid deletion authority`);
  }
  return plan;
}

function validateCheckpoint(path, stem, planDigest) {
  const checkpoint = readJson(path, 'roll-forward checkpoint');
  if (
    !hasExactKeys(checkpoint, [
      'schemaVersion',
      'requestId',
      'planDigest',
      'phase',
      'startedAt',
      'writersRemovedAt',
      'handoffSealedAt',
      'completedAt',
      'archiveDigest',
      'sealDigest',
      'evidenceDigest',
      'updatedAt',
    ]) ||
    checkpoint.schemaVersion !== 1 ||
    checkpoint.requestId !== `sha256:${stem}` ||
    checkpoint.planDigest !== planDigest ||
    !['planned', 'writers-removed', 'handoff-sealed', 'completed', 'cancelled-finalized'].includes(
      checkpoint.phase,
    ) ||
    !hasTimestamp(checkpoint.startedAt) ||
    !hasTimestamp(checkpoint.updatedAt)
  ) {
    fail(`roll-forward checkpoint ${stem} has an invalid contract`);
  }
  const phase = checkpoint.phase;
  const emptyAfterPlan =
    checkpoint.writersRemovedAt === null &&
    checkpoint.handoffSealedAt === null &&
    checkpoint.completedAt === null &&
    checkpoint.archiveDigest === null &&
    checkpoint.sealDigest === null &&
    checkpoint.evidenceDigest === null;
  const writersRemoved =
    hasTimestamp(checkpoint.writersRemovedAt) &&
    checkpoint.handoffSealedAt === null &&
    checkpoint.completedAt === null &&
    checkpoint.archiveDigest === null &&
    checkpoint.sealDigest === null &&
    checkpoint.evidenceDigest === null;
  const handoffSealed =
    hasTimestamp(checkpoint.writersRemovedAt) &&
    hasTimestamp(checkpoint.handoffSealedAt) &&
    checkpoint.completedAt === null &&
    DIGEST_RE.test(checkpoint.archiveDigest) &&
    DIGEST_RE.test(checkpoint.sealDigest) &&
    checkpoint.evidenceDigest === null;
  const completed =
    hasTimestamp(checkpoint.writersRemovedAt) &&
    hasTimestamp(checkpoint.handoffSealedAt) &&
    hasTimestamp(checkpoint.completedAt) &&
    DIGEST_RE.test(checkpoint.archiveDigest) &&
    DIGEST_RE.test(checkpoint.sealDigest) &&
    DIGEST_RE.test(checkpoint.evidenceDigest);
  const cancelledFinalized =
    checkpoint.writersRemovedAt === null &&
    checkpoint.handoffSealedAt === null &&
    hasTimestamp(checkpoint.completedAt) &&
    DIGEST_RE.test(checkpoint.archiveDigest) &&
    checkpoint.sealDigest === null &&
    DIGEST_RE.test(checkpoint.evidenceDigest);
  if (
    (phase === 'planned' && !emptyAfterPlan) ||
    (phase === 'writers-removed' && !writersRemoved) ||
    (phase === 'handoff-sealed' && !handoffSealed) ||
    (phase === 'completed' && !completed) ||
    (phase === 'cancelled-finalized' && !cancelledFinalized)
  ) {
    fail(`roll-forward checkpoint ${stem} has invalid phase fields`);
  }
  return checkpoint;
}

function validateCancellation(
  path,
  stem,
  plan,
  planDigest,
  archiveDigest,
  checkpointCompletedAt = null,
) {
  const cancellation = readJson(path, 'roll-forward cancellation');
  if (
    !hasExactKeys(cancellation, [
      'schemaVersion',
      'status',
      'operation',
      'environment',
      'namespace',
      'requestId',
      'planDigest',
      'pendingArchiveDigest',
      'oldSourceSha',
      'oldReleaseId',
      'oldManifestDigest',
      'newSourceSha',
      'newReleaseId',
      'newManifestDigest',
      'checks',
      'reason',
      'completedAt',
    ]) ||
    cancellation.schemaVersion !== 1 ||
    cancellation.status !== 'cancelled' ||
    cancellation.operation !== 'production-reset-roll-forward' ||
    cancellation.environment !== 'production' ||
    cancellation.namespace !== 'combo' ||
    cancellation.requestId !== `sha256:${stem}` ||
    cancellation.planDigest !== planDigest ||
    cancellation.pendingArchiveDigest !== archiveDigest ||
    cancellation.oldSourceSha !== plan.oldPending.sourceSha ||
    cancellation.oldReleaseId !== plan.oldPending.releaseId ||
    cancellation.oldManifestDigest !== plan.oldPending.manifestDigest ||
    cancellation.newSourceSha !== plan.newSourceSha ||
    cancellation.newReleaseId !== plan.newReleaseId ||
    cancellation.newManifestDigest !== plan.newManifestDigest ||
    !sameJson(cancellation.checks, {
      predecessorFinalized: true,
      currentCheckpointMatched: true,
      writersRemoved: false,
      pendingArchived: true,
      rollForwardRequired: false,
      secretMaterialAccessed: false,
    }) ||
    cancellation.reason !== 'predecessor-already-finalized' ||
    (checkpointCompletedAt === null
      ? !hasTimestamp(cancellation.completedAt)
      : cancellation.completedAt !== checkpointCompletedAt)
  ) {
    fail(`roll-forward cancellation ${stem} has an invalid contract`);
  }
  return cancellation;
}

function validatePendingArchive(path, plan, stem) {
  if (sha256File(path) !== plan.oldPending.digest) {
    fail(`roll-forward pending archive ${stem} changed`);
  }
  const pending = readJson(path, 'roll-forward pending archive');
  if (
    !hasExactKeys(pending, [
      'cleanupPlanDigest',
      'environment',
      'foundationCreated',
      'foundationResetEvidenceDigest',
      'manifestDigest',
      'namespace',
      'phase',
      'releaseId',
      'schemaVersion',
      'schemaStructureProofDigest',
      'sourceSha',
      'trafficCutAt',
      'webService',
    ]) ||
    pending.schemaVersion !== 3 ||
    pending.environment !== 'production' ||
    pending.namespace !== 'combo' ||
    pending.sourceSha !== plan.oldPending.sourceSha ||
    pending.releaseId !== plan.oldPending.releaseId ||
    pending.manifestDigest !== plan.oldPending.manifestDigest ||
    pending.phase !== plan.oldPending.phase ||
    pending.foundationCreated !== plan.oldPending.foundationCreated ||
    pending.foundationResetEvidenceDigest !== plan.oldPending.foundationResetEvidenceDigest ||
    pending.schemaStructureProofDigest !== plan.oldPending.schemaStructureProofDigest ||
    pending.webService !== `release-${plan.oldPending.sourceSha.slice(0, 12)}-web` ||
    typeof pending.foundationCreated !== 'boolean' ||
    !(
      (pending.phase === 'post-cut' &&
        (pending.cleanupPlanDigest === null || DIGEST_RE.test(pending.cleanupPlanDigest))) ||
      (pending.phase === 'finalizing' && DIGEST_RE.test(pending.cleanupPlanDigest))
    ) ||
    !hasTimestamp(pending.trafficCutAt)
  ) {
    fail(`roll-forward pending archive ${stem} has an invalid contract`);
  }
  return pending;
}

function evidencePreservedWeb(plan) {
  return {
    name: plan.preservedWeb.name,
    uid: plan.preservedWeb.uid,
    serviceName: plan.preservedWeb.serviceName,
    serviceUid: plan.preservedWeb.serviceUid,
  };
}

function evidenceRemovedTargets(plan) {
  return plan.targets.map(({ kind, name, state, uid }) => ({ kind, name, state, uid }));
}

function validateSeal(path, plan, stem, planDigest, archiveDigest) {
  const seal = readJson(path, 'roll-forward handoff seal');
  if (
    !hasExactKeys(seal, [
      'schemaVersion',
      'status',
      'operation',
      'environment',
      'namespace',
      'requestId',
      'planDigest',
      'pendingArchiveDigest',
      'oldSourceSha',
      'oldReleaseId',
      'oldManifestDigest',
      'resetEvidenceDigest',
      'newSourceSha',
      'newReleaseId',
      'newManifestDigest',
      'preservedWeb',
      'removedTargets',
      'checks',
      'sealedAt',
    ]) ||
    seal.schemaVersion !== 1 ||
    seal.status !== 'sealed' ||
    seal.operation !== 'production-reset-roll-forward' ||
    seal.environment !== 'production' ||
    seal.namespace !== 'combo' ||
    seal.requestId !== `sha256:${stem}` ||
    seal.planDigest !== planDigest ||
    seal.pendingArchiveDigest !== archiveDigest ||
    seal.oldSourceSha !== plan.oldPending.sourceSha ||
    seal.oldReleaseId !== plan.oldPending.releaseId ||
    seal.oldManifestDigest !== plan.oldPending.manifestDigest ||
    seal.resetEvidenceDigest !== plan.oldPending.foundationResetEvidenceDigest ||
    seal.newSourceSha !== plan.newSourceSha ||
    seal.newReleaseId !== plan.newReleaseId ||
    seal.newManifestDigest !== plan.newManifestDigest ||
    !sameJson(seal.preservedWeb, evidencePreservedWeb(plan)) ||
    !sameJson(seal.removedTargets, evidenceRemovedTargets(plan)) ||
    !sameJson(seal.checks, {
      activeWebPreserved: true,
      oldCandidateWritersRemoved: true,
      pendingArchivePrepared: true,
      resetBoundaryRetained: true,
      secretMaterialAccessed: false,
    }) ||
    !hasTimestamp(seal.sealedAt)
  ) {
    fail(`roll-forward handoff seal ${stem} has an invalid contract`);
  }
  return seal;
}

function validateEvidence(path, plan, stem, planDigest, archiveDigest, sealDigest) {
  const evidence = readJson(path, 'roll-forward completion evidence');
  if (
    !hasExactKeys(evidence, [
      'schemaVersion',
      'status',
      'operation',
      'environment',
      'namespace',
      'requestId',
      'planDigest',
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
      'checks',
      'completedAt',
    ]) ||
    evidence.schemaVersion !== 1 ||
    evidence.status !== 'passed' ||
    evidence.operation !== 'production-reset-roll-forward' ||
    evidence.environment !== 'production' ||
    evidence.namespace !== 'combo' ||
    evidence.requestId !== `sha256:${stem}` ||
    evidence.planDigest !== planDigest ||
    evidence.pendingArchiveDigest !== archiveDigest ||
    evidence.handoffSealDigest !== sealDigest ||
    evidence.oldSourceSha !== plan.oldPending.sourceSha ||
    evidence.oldReleaseId !== plan.oldPending.releaseId ||
    evidence.oldManifestDigest !== plan.oldPending.manifestDigest ||
    evidence.resetEvidenceDigest !== plan.oldPending.foundationResetEvidenceDigest ||
    evidence.newSourceSha !== plan.newSourceSha ||
    evidence.newReleaseId !== plan.newReleaseId ||
    evidence.newManifestDigest !== plan.newManifestDigest ||
    !sameJson(evidence.preservedWeb, evidencePreservedWeb(plan)) ||
    !sameJson(evidence.removedTargets, evidenceRemovedTargets(plan)) ||
    !sameJson(evidence.checks, {
      activeWebPreserved: true,
      oldCandidateWritersRemoved: true,
      pendingArchived: true,
      pendingRemoved: true,
      resetBoundaryRetained: true,
      rollForwardOnly: true,
      secretMaterialAccessed: false,
    }) ||
    !hasTimestamp(evidence.completedAt)
  ) {
    fail(`roll-forward completion evidence ${stem} has an invalid contract`);
  }
  return evidence;
}

function enumerateJournalFiles(stateRoot) {
  const journals = new Map();
  if (!requireDirectory(stateRoot, 'roll-forward state directory', { allowMissing: true })) {
    return journals;
  }
  for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
    const match = STEM_RE.exec(entry.name);
    if (!match) {
      fail(`roll-forward state contains an unsafe name: ${entry.name}`);
    }
    const [, stem, kind] = match;
    const path = join(stateRoot, entry.name);
    requireRegularFile(path, `roll-forward ${kind} journal`);
    const journal = journals.get(stem) ?? {};
    if (journal[kind] !== undefined) {
      fail(`roll-forward journal ${stem} contains a duplicate ${kind}`);
    }
    journal[kind] = path;
    journals.set(stem, journal);
  }
  return journals;
}

function parseChecksumSet(directory) {
  const checksumPath = join(directory, 'SHA256SUMS');
  const input = readRegularFile(checksumPath, 'release checksum set').toString('utf8');
  const entries = new Map();
  for (const line of input.split('\n')) {
    if (line === '') continue;
    const match = /^([0-9a-f]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) fail('release checksum set has an unsafe entry');
    const [, digest, name] = match;
    if (entries.has(name)) {
      fail(`release checksum set lists ${name} more than once`);
    }
    entries.set(name, `sha256:${digest}`);
  }
  if (entries.size === 0) fail('release checksum set is empty');
  for (const [name, digest] of entries) {
    const path = join(directory, name);
    if (sha256File(path) !== digest) {
      fail(`release checksum mismatch: ${name}`);
    }
  }
  return entries;
}

function validateConsumptionDirectory(directory, proofName, journalEvidence, plan) {
  requireDirectory(directory, 'roll-forward consumption directory');
  const checksums = parseChecksumSet(directory);
  for (const name of [
    proofName,
    'reset-roll-forward-evidence.json',
    'release.json',
    'release.sha256',
  ]) {
    if (!checksums.has(name)) {
      fail(`roll-forward consumption checksum set lacks ${name}`);
    }
  }
  const copiedEvidence = readRegularFile(
    join(directory, 'reset-roll-forward-evidence.json'),
    'copied reset roll-forward evidence',
  );
  if (!copiedEvidence.equals(journalEvidence)) {
    fail('copied reset roll-forward evidence differs from its journal');
  }
  const release = readJson(join(directory, 'release.json'), 'consuming release manifest');
  if (release.sourceSha !== plan.newSourceSha || release.releaseId !== plan.newReleaseId) {
    fail('consuming release manifest has another release identity');
  }
  const releaseDigest = readRegularFile(
    join(directory, 'release.sha256'),
    'consuming release digest',
  ).toString('utf8');
  if (releaseDigest.replace(/\n$/, '') !== plan.newManifestDigest) {
    fail('consuming release manifest digest changed');
  }
  const proof = readJson(join(directory, proofName), 'roll-forward consumption proof');
  const common =
    proof.schemaVersion === 1 &&
    proof.environment === 'production' &&
    proof.namespace === 'combo' &&
    proof.sourceSha === plan.newSourceSha &&
    proof.releaseId === plan.newReleaseId &&
    proof.manifestDigest === plan.newManifestDigest &&
    proof.foundationResetEvidenceDigest === null;
  if (proofName === 'deploy-evidence.json') {
    if (
      !common ||
      proof.status !== 'passed' ||
      proof.foundationMode !== 'reused' ||
      proof.checks?.protectedAcceptance !== true ||
      proof.checks?.publicTraffic !== true
    ) {
      fail('final release does not consume the reset roll-forward journal');
    }
  } else if (
    !common ||
    proofName !== 'activation-evidence.json' ||
    proof.status !== 'awaiting-acceptance' ||
    proof.checks?.candidateReady !== true ||
    proof.checks?.trafficActivated !== true
  ) {
    fail('activation does not consume the reset roll-forward journal');
  }
}

function completedJournalIsConsumed(evidencePath, plan, environmentRoot) {
  const journalEvidence = readRegularFile(evidencePath, 'roll-forward completion evidence');
  const finalized = join(environmentRoot, plan.newReleaseId);
  if (pathState(finalized) !== null) {
    validateConsumptionDirectory(finalized, 'deploy-evidence.json', journalEvidence, plan);
    return 'final';
  }
  const activation = `${finalized}.activation`;
  if (pathState(activation) !== null) {
    validateConsumptionDirectory(activation, 'activation-evidence.json', journalEvidence, plan);
    return 'activation';
  }
  return null;
}

function validateJournalChain(journal, stem) {
  if (journal.plan === undefined) {
    fail(`orphan roll-forward journal ${stem} lacks its plan`);
  }
  const plan = validatePlan(journal.plan, stem);
  const planDigest = sha256File(journal.plan);
  if (journal.checkpoint === undefined) {
    for (const kind of FILE_KINDS.slice(2)) {
      if (journal[kind] !== undefined) {
        fail(`roll-forward journal ${stem} has ${kind} without a checkpoint`);
      }
    }
    return { plan, phase: 'plan-only', evidencePath: null };
  }

  const checkpoint = validateCheckpoint(journal.checkpoint, stem, planDigest);
  const archivePresent = journal['old-pending'] !== undefined;
  const sealPresent = journal['handoff-seal'] !== undefined;
  const evidencePresent = journal.evidence !== undefined;
  const cancellationPresent = journal.cancellation !== undefined;
  const partialCancellation =
    checkpoint.phase === 'planned' && archivePresent && !sealPresent && !evidencePresent;
  if (
    checkpoint.phase === 'planned' &&
    !partialCancellation &&
    (archivePresent || sealPresent || evidencePresent || cancellationPresent)
  ) {
    fail(`planned roll-forward journal ${stem} has later-phase files`);
  }
  if (
    checkpoint.phase === 'writers-removed' &&
    ((!archivePresent && sealPresent) || evidencePresent || cancellationPresent)
  ) {
    fail(`writers-removed roll-forward journal ${stem} has an invalid partial chain`);
  }
  if (
    checkpoint.phase === 'handoff-sealed' &&
    (!archivePresent || !sealPresent || cancellationPresent)
  ) {
    fail(`handoff-sealed roll-forward journal ${stem} lacks its sealed chain`);
  }
  if (
    checkpoint.phase === 'completed' &&
    (!archivePresent || !sealPresent || !evidencePresent || cancellationPresent)
  ) {
    fail(`completed roll-forward journal ${stem} lacks its completion chain`);
  }
  if (
    checkpoint.phase === 'cancelled-finalized' &&
    (!archivePresent || sealPresent || evidencePresent || !cancellationPresent)
  ) {
    fail(`cancelled-finalized roll-forward journal ${stem} lacks its cancellation proof`);
  }

  let archiveDigest = null;
  if (archivePresent) {
    validatePendingArchive(journal['old-pending'], plan, stem);
    archiveDigest = sha256File(journal['old-pending']);
  }
  if (cancellationPresent) {
    validateCancellation(
      journal.cancellation,
      stem,
      plan,
      planDigest,
      archiveDigest,
      checkpoint.phase === 'cancelled-finalized' ? checkpoint.completedAt : null,
    );
    if (
      checkpoint.phase === 'cancelled-finalized' &&
      (checkpoint.archiveDigest !== archiveDigest ||
        checkpoint.evidenceDigest !== sha256File(journal.cancellation))
    ) {
      fail(`roll-forward checkpoint ${stem} does not bind its cancellation`);
    }
  }
  let sealDigest = null;
  if (sealPresent) {
    validateSeal(journal['handoff-seal'], plan, stem, planDigest, archiveDigest);
    sealDigest = sha256File(journal['handoff-seal']);
  }
  if (
    ['handoff-sealed', 'completed'].includes(checkpoint.phase) &&
    (checkpoint.archiveDigest !== archiveDigest || checkpoint.sealDigest !== sealDigest)
  ) {
    fail(`roll-forward checkpoint ${stem} does not bind its sealed chain`);
  }
  if (evidencePresent) {
    validateEvidence(journal.evidence, plan, stem, planDigest, archiveDigest, sealDigest);
    if (
      checkpoint.phase === 'completed' &&
      checkpoint.evidenceDigest !== sha256File(journal.evidence)
    ) {
      fail(`roll-forward checkpoint ${stem} does not bind completion evidence`);
    }
  }
  return {
    plan,
    phase: partialCancellation ? 'cancelling-finalized' : checkpoint.phase,
    evidencePath: journal.evidence ?? null,
  };
}

export function auditResetRollForwardJournals({
  evidenceRoot,
  sourceSha,
  manifestDigest,
  mode,
  evidencePath = null,
}) {
  if (
    !hasNonemptyString(evidenceRoot) ||
    !SHA_RE.test(sourceSha) ||
    !DIGEST_RE.test(manifestDigest) ||
    !['prepare', 'consumer'].includes(mode)
  ) {
    fail('invalid reset roll-forward journal audit authority');
  }
  if (mode === 'prepare' && evidencePath !== null) {
    fail('prepare audit does not accept supplied completion evidence');
  }
  requireDirectory(evidenceRoot, 'release evidence root');
  const rollForwardRoot = join(evidenceRoot, 'reset-roll-forwards');
  const stateRoot = join(rollForwardRoot, 'production');
  if (pathState(rollForwardRoot) !== null) {
    requireDirectory(rollForwardRoot, 'roll-forward journal root');
  }
  const journals = enumerateJournalFiles(stateRoot);
  const currentRequestId = requestIdFor(sourceSha, manifestDigest);
  const currentStem = currentRequestId.slice('sha256:'.length);
  const environmentRoot = join(evidenceRoot, 'production');
  requireDirectory(environmentRoot, 'Production release evidence directory', {
    allowMissing: true,
  });
  let currentState = 'absent';
  let suppliedEvidenceValidated = false;
  const consumed = [];

  for (const [stem, journal] of [...journals.entries()].sort()) {
    const chain = validateJournalChain(journal, stem);
    const isCurrent = stem === currentStem;
    if (chain.phase === 'cancelled-finalized') {
      if (isCurrent) {
        currentState = 'cancelled-finalized';
      } else {
        consumed.push({ requestId: `sha256:${stem}`, by: 'cancellation' });
      }
      continue;
    }
    const complete = chain.phase === 'completed';
    if (!complete) {
      if (!isCurrent || mode !== 'prepare') {
        fail(
          `${
            isCurrent ? 'current' : 'foreign'
          } unfinished reset roll-forward journal ${stem} blocks this operation`,
        );
      }
      currentState = chain.phase === 'cancelling-finalized' ? chain.phase : 'incomplete';
      continue;
    }
    if (isCurrent) {
      currentState = 'completed';
      if (mode === 'consumer') {
        if (evidencePath === null) {
          fail('current completed reset roll-forward requires supplied evidence');
        }
        const supplied = readRegularFile(evidencePath, 'supplied reset roll-forward evidence');
        const durable = readRegularFile(chain.evidencePath, 'durable reset roll-forward evidence');
        if (!supplied.equals(durable)) {
          fail('supplied reset roll-forward evidence differs from durable evidence');
        }
        suppliedEvidenceValidated = true;
      }
      continue;
    }
    const consumption = completedJournalIsConsumed(chain.evidencePath, chain.plan, environmentRoot);
    if (consumption === null) {
      fail(`foreign completed reset roll-forward journal ${stem} is unconsumed`);
    }
    consumed.push({ requestId: `sha256:${stem}`, by: consumption });
  }

  if (evidencePath !== null && currentState !== 'completed') {
    fail('supplied reset roll-forward evidence has no current completed journal');
  }
  return {
    schemaVersion: 1,
    status: 'passed',
    environment: 'production',
    sourceSha,
    releaseId: `release-${sourceSha}`,
    manifestDigest,
    currentRequestId,
    currentState,
    suppliedEvidenceValidated,
    consumedForeignJournals: consumed,
  };
}

function parseCli(argv) {
  if (argv[0] !== 'audit') fail('expected the audit command');
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      ![
        '--evidence-root',
        '--environment',
        '--source-sha',
        '--manifest-digest',
        '--mode',
        '--evidence',
      ].includes(flag) ||
      value === undefined ||
      values.has(flag)
    ) {
      fail('invalid reset roll-forward journal arguments');
    }
    values.set(flag, value);
  }
  if (
    values.get('--environment') !== 'production' ||
    !values.has('--evidence-root') ||
    !values.has('--source-sha') ||
    !values.has('--manifest-digest') ||
    !values.has('--mode')
  ) {
    fail('incomplete reset roll-forward journal arguments');
  }
  return {
    evidenceRoot: values.get('--evidence-root'),
    sourceSha: values.get('--source-sha'),
    manifestDigest: values.get('--manifest-digest'),
    mode: values.get('--mode'),
    evidencePath: values.get('--evidence') ?? null,
  };
}

function main() {
  try {
    const result = auditResetRollForwardJournals(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof JournalError ? error.message : 'unexpected verifier failure';
    process.stderr.write(`[reset-roll-forward-journal] FAIL: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
