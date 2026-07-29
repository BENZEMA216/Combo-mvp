#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REQUEST_RE = /^sha256:([0-9a-f]{64})$/;
const JOURNAL_RE = /^([0-9a-f]{64})\.foundation-reset-(plan|checkpoint|ready|evidence)\.json$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const POLICY = 'established-clean-slate-v1';
const REQUIRED_CLAIMS = [
  'data-release-minio-0',
  'data-release-postgres-0',
  'data-release-redis-queue-0',
];
const REQUIRED_FOUNDATION = [
  'configmap/release-redis-hot-config',
  'configmap/release-redis-queue-config',
  'deployment/release-redis-hot',
  'service/release-minio',
  'service/release-postgres',
  'service/release-redis-hot',
  'service/release-redis-queue',
  'statefulset/release-minio',
  'statefulset/release-postgres',
  'statefulset/release-redis-queue',
];
const OPTIONAL_FOUNDATION = 'configmap/release-minio-init-script';
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

class JournalError extends Error {}

function fail(message) {
  throw new JournalError(message);
}

function sha256Buffer(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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

function sha256File(path) {
  return sha256Buffer(readRegularFile(path));
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
  return isPlainObject(value) && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function hasNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function hasSafeIdentity(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);
}

function hasTimestamp(value) {
  return typeof value === 'string' && value.length > 1 && value.endsWith('Z');
}

function sorted(values) {
  return [...values].sort();
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

function namespaceFor(environment) {
  const contract = ENVIRONMENTS[environment];
  if (!contract) fail('environment must be exactly preview or production');
  return contract.namespace;
}

function assertExactUnique(values, expected, context) {
  if (
    !Array.isArray(values) ||
    values.length !== new Set(values).size ||
    !isDeepStrictEqual(sorted(values), sorted(expected))
  ) {
    fail(`${context} differs from the exact contract`);
  }
}

const STORAGE_PUBLIC_KEYS = [
  'claim',
  'claimUid',
  'claimResourceVersion',
  'path',
  'volume',
  'volumeUid',
  'volumeResourceVersion',
];
const STORAGE_INTERNAL_KEYS = [
  ...STORAGE_PUBLIC_KEYS,
  'claimAuthorityDigest',
  'volumeAuthorityDigest',
];

function validateStorageRows(rows, { context, internal, namespace }) {
  if (!Array.isArray(rows) || rows.length !== REQUIRED_CLAIMS.length) {
    fail(`${context} must contain exactly three storage identities`);
  }
  assertExactUnique(
    rows.map((row) => row?.claim),
    REQUIRED_CLAIMS,
    `${context} claims`,
  );
  for (const row of rows) {
    if (
      !hasExactKeys(row, internal ? STORAGE_INTERNAL_KEYS : STORAGE_PUBLIC_KEYS) ||
      !hasSafeIdentity(row.claimUid) ||
      !hasSafeIdentity(row.claimResourceVersion) ||
      row.volume !== `pvc-${row.claimUid}` ||
      !hasSafeIdentity(row.volumeUid) ||
      !hasSafeIdentity(row.volumeResourceVersion) ||
      typeof row.path !== 'string' ||
      !row.path.startsWith('/') ||
      !row.path.endsWith(`/${row.volume}_${namespace}_${row.claim}`) ||
      (internal &&
        (!DIGEST_RE.test(row.claimAuthorityDigest) || !DIGEST_RE.test(row.volumeAuthorityDigest)))
    ) {
      fail(`${context} has an invalid storage identity`);
    }
  }
  for (const field of ['claimUid', 'volume', 'volumeUid', 'path']) {
    if (new Set(rows.map((row) => row[field])).size !== rows.length) {
      fail(`${context} reuses ${field} across claims`);
    }
  }
}

function publicStorage(rows) {
  return rows
    .map((row) => Object.fromEntries(STORAGE_PUBLIC_KEYS.map((key) => [key, row[key]])))
    .sort((left, right) => left.claim.localeCompare(right.claim));
}

function validateNewStorageIdentity(oldStorage, newStorage, context) {
  for (const field of ['claimUid', 'volume', 'volumeUid', 'path']) {
    const oldValues = new Set(oldStorage.map((row) => row[field]));
    for (const current of newStorage) {
      if (oldValues.has(current[field])) {
        fail(`${context} reused an old storage identity`);
      }
    }
  }
}

function foundationIdentity(rows, context) {
  if (!Array.isArray(rows)) fail(`${context} must be an array`);
  const identities = rows.map((row) => {
    if (
      !hasExactKeys(row, ['kind', 'name', 'uid']) ||
      !hasNonemptyString(row.kind) ||
      !hasNonemptyString(row.name) ||
      !hasSafeIdentity(row.uid)
    ) {
      fail(`${context} has an invalid foundation identity`);
    }
    return `${row.kind}/${row.name}`;
  });
  assertExactUnique(identities, REQUIRED_FOUNDATION, context);
  return rows
    .map((row) => ({ kind: row.kind, name: row.name, uid: row.uid }))
    .sort((left, right) =>
      `${left.kind}/${left.name}`.localeCompare(`${right.kind}/${right.name}`),
    );
}

function validatePreservedWeb(value, environment, context) {
  const contract = ENVIRONMENTS[environment];
  const keys = [
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
    'forwardUnit',
    'forwardPort',
    'routeVersionDigest',
    'canaryNginxSha256',
    'formalNginxSha256',
  ];
  if (
    !hasExactKeys(value, keys) ||
    !SHA_RE.test(value.sourceSha) ||
    value.releaseId !== `release-${value.sourceSha}` ||
    value.name !== `release-${value.sourceSha.slice(0, 12)}-web` ||
    value.serviceName !== value.name ||
    !hasSafeIdentity(value.uid) ||
    !hasSafeIdentity(value.resourceVersion) ||
    !hasSafeIdentity(value.serviceUid) ||
    !hasSafeIdentity(value.serviceResourceVersion) ||
    !DIGEST_RE.test(value.manifestDigest) ||
    !/^ghcr\.io\/dangdang-tech\/combo-web@sha256:[0-9a-f]{64}$/.test(value.webImage) ||
    !DIGEST_RE.test(value.trafficStateDigest) ||
    !DIGEST_RE.test(value.forwardEnvDigest) ||
    value.forwardUnit !== contract.forwardUnit ||
    value.forwardPort !== contract.forwardPort ||
    !DIGEST_RE.test(value.routeVersionDigest) ||
    !DIGEST_RE.test(value.canaryNginxSha256) ||
    (environment === 'preview'
      ? value.formalNginxSha256 !== null
      : !DIGEST_RE.test(value.formalNginxSha256))
  ) {
    fail(`${context} has an invalid preserved Web and traffic identity`);
  }
}

function validateCapturedResources(rows, kind, pattern, context) {
  if (!Array.isArray(rows)) fail(`${context} must be an array`);
  const names = [];
  for (const row of rows) {
    if (
      !hasExactKeys(row, ['authorityDigest', 'kind', 'name', 'resourceVersion', 'uid']) ||
      row.kind !== kind ||
      !pattern.test(row.name) ||
      !hasSafeIdentity(row.uid) ||
      !hasSafeIdentity(row.resourceVersion) ||
      !DIGEST_RE.test(row.authorityDigest)
    ) {
      fail(`${context} has an invalid captured resource`);
    }
    names.push(row.name);
  }
  if (names.length !== new Set(names).size) fail(`${context} contains duplicate resources`);
}

function validateFoundationTargets(rows, context) {
  if (!Array.isArray(rows)) fail(`${context} must be an array`);
  const identities = [];
  for (const row of rows) {
    if (
      !hasExactKeys(row, ['authorityDigest', 'kind', 'name', 'resourceVersion', 'uid']) ||
      !['deployment', 'statefulset', 'service', 'configmap'].includes(row.kind) ||
      !hasNonemptyString(row.name) ||
      !hasSafeIdentity(row.uid) ||
      !hasSafeIdentity(row.resourceVersion) ||
      !DIGEST_RE.test(row.authorityDigest)
    ) {
      fail(`${context} has an invalid captured foundation target`);
    }
    identities.push(`${row.kind}/${row.name}`);
  }
  if (identities.length !== new Set(identities).size) {
    fail(`${context} contains duplicate foundation targets`);
  }
  const requiredOnly = identities.filter((identity) => identity !== OPTIONAL_FOUNDATION);
  assertExactUnique(requiredOnly, REQUIRED_FOUNDATION, context);
  if (
    identities.length !== REQUIRED_FOUNDATION.length &&
    !identities.includes(OPTIONAL_FOUNDATION)
  ) {
    fail(`${context} has an unexpected optional target set`);
  }
  if (identities.length > REQUIRED_FOUNDATION.length + 1) {
    fail(`${context} has too many foundation targets`);
  }
}

const SUPERSEDED_RESET_KEYS = [
  'environment',
  'namespace',
  'requestId',
  'sourceSha',
  'releaseId',
  'manifestDigest',
  'planDigest',
  'foundationSnapshotDigest',
  'evidenceDigest',
];

function validateSupersededResetDescriptor(value, environment, context) {
  if (
    !hasExactKeys(value, SUPERSEDED_RESET_KEYS) ||
    value.environment !== environment ||
    value.namespace !== namespaceFor(environment) ||
    !REQUEST_RE.test(value.requestId) ||
    !SHA_RE.test(value.sourceSha) ||
    value.releaseId !== `release-${value.sourceSha}` ||
    !DIGEST_RE.test(value.manifestDigest) ||
    !DIGEST_RE.test(value.planDigest) ||
    !DIGEST_RE.test(value.foundationSnapshotDigest) ||
    !DIGEST_RE.test(value.evidenceDigest)
  ) {
    fail(`${context} has an invalid superseded reset descriptor`);
  }
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

function stablePreservedWeb(value) {
  const stable = structuredClone(value);
  delete stable.resourceVersion;
  delete stable.serviceResourceVersion;
  return stable;
}

function validatePlan(path, stem, environment) {
  const plan = readJson(path, `foundation reset plan ${stem}`);
  const commonKeys = [
    'schemaVersion',
    'policy',
    'requestId',
    'authorityDigest',
    'environment',
    'namespace',
    'sourceSha',
    'releaseId',
    'manifestDigest',
    'foundationYamlDigest',
    'createdAt',
    'preservedWeb',
    'writerDeployments',
    'jobs',
    'targets',
    'oldStorage',
  ];
  const keys = plan.schemaVersion === 2 ? [...commonKeys, 'supersededReset'] : commonKeys;
  if (
    !hasExactKeys(plan, keys) ||
    ![1, 2].includes(plan.schemaVersion) ||
    plan.policy !== POLICY ||
    plan.environment !== environment ||
    plan.namespace !== namespaceFor(environment) ||
    !SHA_RE.test(plan.sourceSha) ||
    plan.releaseId !== `release-${plan.sourceSha}` ||
    !DIGEST_RE.test(plan.manifestDigest) ||
    plan.authorityDigest !== plan.manifestDigest ||
    !DIGEST_RE.test(plan.foundationYamlDigest) ||
    !hasTimestamp(plan.createdAt)
  ) {
    fail(`foundation reset plan ${stem} has an invalid top-level contract`);
  }
  const expectedRequestId = requestIdFor(environment, plan.sourceSha, plan.manifestDigest);
  if (plan.requestId !== expectedRequestId || plan.requestId !== `sha256:${stem}`) {
    fail(`foundation reset plan ${stem} has a non-deterministic request ID`);
  }
  if (plan.schemaVersion === 2) {
    if (environment !== 'preview') fail('foundation reset schema v2 is Preview-only');
    validateSupersededResetDescriptor(
      plan.supersededReset,
      environment,
      `foundation reset plan ${stem}`,
    );
    if (
      plan.supersededReset.requestId === plan.requestId ||
      plan.supersededReset.sourceSha === plan.sourceSha ||
      plan.supersededReset.manifestDigest === plan.manifestDigest
    ) {
      fail(`foundation reset plan ${stem} does not identify an older reset`);
    }
  }
  validatePreservedWeb(plan.preservedWeb, environment, `foundation reset plan ${stem}`);
  validateCapturedResources(
    plan.writerDeployments,
    'deployment',
    /^release-[0-9a-f]{12}-(api|runtime|worker)$/,
    `foundation reset plan ${stem} writers`,
  );
  validateCapturedResources(
    plan.jobs,
    'job',
    /^(?:release-minio-init|release-[0-9a-f]{12}-(?:migrate|minio-init))$/,
    `foundation reset plan ${stem} jobs`,
  );
  validateFoundationTargets(plan.targets, `foundation reset plan ${stem} targets`);
  validateStorageRows(plan.oldStorage, {
    context: `foundation reset plan ${stem} old storage`,
    internal: true,
    namespace: plan.namespace,
  });
  if (plan.schemaVersion === 1) {
    const activePrefix = `release-${plan.preservedWeb.sourceSha.slice(0, 12)}-`;
    assertExactUnique(
      plan.writerDeployments.map((row) => row.name),
      [`${activePrefix}api`, `${activePrefix}runtime`, `${activePrefix}worker`],
      `foundation reset plan ${stem} active writers`,
    );
    for (const row of plan.jobs) {
      if (row.name !== 'release-minio-init' && !row.name.startsWith(activePrefix)) {
        fail(`foundation reset plan ${stem} contains a non-active job`);
      }
    }
  } else {
    const predecessorPrefix = `release-${plan.supersededReset.sourceSha.slice(0, 12)}-`;
    for (const row of plan.writerDeployments) {
      if (!row.name.startsWith(predecessorPrefix)) {
        fail(`foundation reset plan ${stem} contains a non-predecessor writer`);
      }
    }
    for (const row of plan.jobs) {
      if (row.name !== 'release-minio-init' && !row.name.startsWith(predecessorPrefix)) {
        fail(`foundation reset plan ${stem} contains a non-predecessor job`);
      }
    }
  }
  return plan;
}

function validateCheckpoint(path, stem, planDigest) {
  const checkpoint = readJson(path, `foundation reset checkpoint ${stem}`);
  if (
    !hasExactKeys(checkpoint, [
      'schemaVersion',
      'requestId',
      'planDigest',
      'phase',
      'startedAt',
      'storageClearedAt',
      'foundationReadyAt',
      'foundationSnapshotDigest',
      'updatedAt',
    ]) ||
    checkpoint.schemaVersion !== 1 ||
    checkpoint.requestId !== `sha256:${stem}` ||
    checkpoint.planDigest !== planDigest ||
    !['planned', 'storage-removed', 'foundation-ready'].includes(checkpoint.phase) ||
    !hasTimestamp(checkpoint.startedAt) ||
    !hasTimestamp(checkpoint.updatedAt) ||
    (checkpoint.phase === 'planned' &&
      (checkpoint.storageClearedAt !== null ||
        checkpoint.foundationReadyAt !== null ||
        checkpoint.foundationSnapshotDigest !== null)) ||
    (checkpoint.phase === 'storage-removed' &&
      (!hasTimestamp(checkpoint.storageClearedAt) ||
        checkpoint.foundationReadyAt !== null ||
        checkpoint.foundationSnapshotDigest !== null)) ||
    (checkpoint.phase === 'foundation-ready' &&
      (!hasTimestamp(checkpoint.storageClearedAt) ||
        !hasTimestamp(checkpoint.foundationReadyAt) ||
        !DIGEST_RE.test(checkpoint.foundationSnapshotDigest)))
  ) {
    fail(`foundation reset checkpoint ${stem} is invalid`);
  }
  return checkpoint;
}

function validateReady(path, stem, plan, planDigest) {
  const ready = readJson(path, `foundation reset ready snapshot ${stem}`);
  if (
    !hasExactKeys(ready, [
      'schemaVersion',
      'requestId',
      'planDigest',
      'newStorage',
      'foundation',
    ]) ||
    ready.schemaVersion !== 1 ||
    ready.requestId !== plan.requestId ||
    ready.planDigest !== planDigest
  ) {
    fail(`foundation reset ready snapshot ${stem} is invalid`);
  }
  validateStorageRows(ready.newStorage, {
    context: `foundation reset ready snapshot ${stem} storage`,
    internal: true,
    namespace: plan.namespace,
  });
  validateNewStorageIdentity(plan.oldStorage, ready.newStorage, `foundation reset ${stem}`);
  foundationIdentity(ready.foundation, `foundation reset ready snapshot ${stem}`);
  return ready;
}

function validateEvidence(path, stem, plan, planDigest, checkpoint, ready, readyDigest) {
  const evidence = readJson(path, `foundation reset evidence ${stem}`);
  const commonKeys = [
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
    'foundationSnapshotDigest',
    'oldStorage',
    'newStorage',
    'foundation',
    'preservedWeb',
    'checks',
    'completedAt',
  ];
  const keys = evidence.schemaVersion === 2 ? [...commonKeys, 'supersededReset'] : commonKeys;
  if (
    !hasExactKeys(evidence, keys) ||
    evidence.schemaVersion !== plan.schemaVersion ||
    evidence.status !== 'passed' ||
    evidence.policy !== POLICY ||
    evidence.requestId !== plan.requestId ||
    evidence.authorityDigest !== plan.authorityDigest ||
    evidence.environment !== plan.environment ||
    evidence.namespace !== plan.namespace ||
    evidence.sourceSha !== plan.sourceSha ||
    evidence.releaseId !== plan.releaseId ||
    evidence.manifestDigest !== plan.manifestDigest ||
    evidence.planDigest !== planDigest ||
    evidence.startedAt !== checkpoint.startedAt ||
    evidence.storageClearedAt !== checkpoint.storageClearedAt ||
    evidence.foundationReadyAt !== checkpoint.foundationReadyAt ||
    evidence.foundationSnapshotDigest !== readyDigest ||
    checkpoint.foundationSnapshotDigest !== readyDigest ||
    !hasTimestamp(evidence.completedAt) ||
    evidence.completedAt < evidence.foundationReadyAt ||
    !isDeepStrictEqual(evidence.preservedWeb, {
      name: plan.preservedWeb.name,
      uid: plan.preservedWeb.uid,
    }) ||
    !isDeepStrictEqual(
      evidence.checks,
      plan.schemaVersion === 2
        ? {
            writersFenced: true,
            oldStorageRemoved: true,
            newStorageIdentity: true,
            activeWebPreserved: true,
            supersededResetContinuity: true,
          }
        : {
            writersFenced: true,
            oldStorageRemoved: true,
            newStorageIdentity: true,
            activeWebPreserved: true,
          },
    )
  ) {
    fail(`foundation reset evidence ${stem} has an invalid chain`);
  }
  validateStorageRows(evidence.oldStorage, {
    context: `foundation reset evidence ${stem} old storage`,
    internal: false,
    namespace: plan.namespace,
  });
  validateStorageRows(evidence.newStorage, {
    context: `foundation reset evidence ${stem} new storage`,
    internal: false,
    namespace: plan.namespace,
  });
  validateNewStorageIdentity(
    evidence.oldStorage,
    evidence.newStorage,
    `foundation reset evidence ${stem}`,
  );
  if (
    !isDeepStrictEqual(evidence.oldStorage, publicStorage(plan.oldStorage)) ||
    !isDeepStrictEqual(evidence.newStorage, publicStorage(ready.newStorage)) ||
    !isDeepStrictEqual(
      foundationIdentity(evidence.foundation, `foundation reset evidence ${stem}`),
      foundationIdentity(ready.foundation, `foundation reset ready snapshot ${stem}`),
    )
  ) {
    fail(`foundation reset evidence ${stem} differs from its plan or ready snapshot`);
  }
  if (
    plan.schemaVersion === 2 &&
    !isDeepStrictEqual(evidence.supersededReset, plan.supersededReset)
  ) {
    fail(`foundation reset evidence ${stem} changed its supersession authority`);
  }
  return evidence;
}

function readJournalNodes(stateRoot, environment) {
  if (!requireDirectory(stateRoot, 'foundation reset journal directory', { allowMissing: true })) {
    return new Map();
  }
  const groups = new Map();
  for (const entry of readdirSync(stateRoot)) {
    const match = JOURNAL_RE.exec(entry);
    if (!match) fail(`foundation reset journal directory has an unexpected entry: ${entry}`);
    const [, stem, kind] = match;
    const path = join(stateRoot, entry);
    requireRegularFile(path, `foundation reset journal ${entry}`);
    const group = groups.get(stem) ?? {};
    if (group[kind]) fail(`foundation reset journal ${stem} has a duplicate ${kind}`);
    group[kind] = path;
    groups.set(stem, group);
  }

  const nodes = new Map();
  for (const [stem, files] of groups) {
    if (!files.plan || !files.checkpoint) {
      fail(`foundation reset journal ${stem} has an orphan file`);
    }
    const plan = validatePlan(files.plan, stem, environment);
    const planDigest = sha256File(files.plan);
    const checkpoint = validateCheckpoint(files.checkpoint, stem, planDigest);
    if (files.evidence && !files.ready) {
      fail(`foundation reset journal ${stem} has evidence without a ready snapshot`);
    }
    if (files.evidence && checkpoint.phase !== 'foundation-ready') {
      fail(`foundation reset journal ${stem} has evidence before foundation-ready`);
    }
    if (checkpoint.phase === 'foundation-ready' && !files.ready) {
      fail(`foundation reset journal ${stem} lacks its ready snapshot`);
    }
    let ready = null;
    let readyDigest = null;
    if (files.ready) {
      ready = validateReady(files.ready, stem, plan, planDigest);
      readyDigest = sha256File(files.ready);
      if (
        checkpoint.phase === 'foundation-ready' &&
        checkpoint.foundationSnapshotDigest !== readyDigest
      ) {
        fail(`foundation reset journal ${stem} ready digest changed`);
      }
    }
    let evidence = null;
    let evidenceDigest = null;
    if (files.evidence) {
      evidence = validateEvidence(
        files.evidence,
        stem,
        plan,
        planDigest,
        checkpoint,
        ready,
        readyDigest,
      );
      evidenceDigest = sha256File(files.evidence);
    }
    nodes.set(plan.requestId, {
      stem,
      files,
      plan,
      planDigest,
      checkpoint,
      ready,
      readyDigest,
      evidence,
      evidenceDigest,
      predecessorRequestId: plan.schemaVersion === 2 ? plan.supersededReset.requestId : null,
      successorRequestId: null,
      directConsumption: null,
    });
  }
  return nodes;
}

function validateSupersessionLinks(nodes) {
  for (const node of nodes.values()) {
    if (node.plan.schemaVersion !== 2) continue;
    const predecessor = nodes.get(node.predecessorRequestId);
    if (!predecessor?.evidence) {
      fail(`foundation reset ${node.plan.requestId} references a missing completed predecessor`);
    }
    if (
      predecessor.successorRequestId !== null &&
      predecessor.successorRequestId !== node.plan.requestId
    ) {
      fail(`foundation reset ${predecessor.plan.requestId} has a forked successor chain`);
    }
    predecessor.successorRequestId = node.plan.requestId;
    if (!isDeepStrictEqual(node.plan.supersededReset, descriptorFor(predecessor))) {
      fail(`foundation reset ${node.plan.requestId} changed its predecessor digest or identity`);
    }
    if (!isDeepStrictEqual(publicStorage(node.plan.oldStorage), predecessor.evidence.newStorage)) {
      fail(`foundation reset ${node.plan.requestId} did not capture predecessor storage exactly`);
    }
    const targets = node.plan.targets
      .filter((row) => `${row.kind}/${row.name}` !== OPTIONAL_FOUNDATION)
      .map((row) => ({ kind: row.kind, name: row.name, uid: row.uid }))
      .sort((left, right) =>
        `${left.kind}/${left.name}`.localeCompare(`${right.kind}/${right.name}`),
      );
    const predecessorFoundation = foundationIdentity(
      predecessor.evidence.foundation,
      `foundation reset evidence ${predecessor.stem}`,
    );
    if (!isDeepStrictEqual(targets, predecessorFoundation)) {
      fail(`foundation reset ${node.plan.requestId} did not capture predecessor foundation UIDs`);
    }
    if (
      !isDeepStrictEqual(
        stablePreservedWeb(node.plan.preservedWeb),
        stablePreservedWeb(predecessor.plan.preservedWeb),
      )
    ) {
      fail(`foundation reset ${node.plan.requestId} changed preserved Web or traffic identity`);
    }
    if (node.plan.createdAt < predecessor.evidence.completedAt) {
      fail(`foundation reset ${node.plan.requestId} predates its predecessor`);
    }
  }

  for (const start of nodes.values()) {
    const seen = new Set();
    let current = start;
    while (current) {
      if (seen.has(current.plan.requestId)) {
        fail('foundation reset journal contains a supersession cycle');
      }
      seen.add(current.plan.requestId);
      current = current.successorRequestId ? nodes.get(current.successorRequestId) : null;
    }
  }
}

function parseChecksumSet(directory) {
  const checksumPath = join(directory, 'SHA256SUMS');
  const input = readRegularFile(checksumPath, `release checksum set ${directory}`).toString('utf8');
  const entries = new Map();
  for (const line of input.split('\n')) {
    if (line === '') continue;
    const match = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line);
    if (!match) fail(`release checksum set ${directory} is malformed`);
    const [, digest, name] = match;
    if (basename(name) !== name || entries.has(name)) {
      fail(`release checksum set ${directory} has an unsafe or duplicate name`);
    }
    const path = join(directory, name);
    requireRegularFile(path, `checksummed release file ${name}`);
    if (sha256File(path) !== `sha256:${digest}`) {
      fail(`checksummed release file ${name} changed`);
    }
    entries.set(name, `sha256:${digest}`);
  }
  return entries;
}

function validateConsumptionDirectory(node, directory, proofName, environment) {
  if (
    !requireDirectory(directory, `reset consumption directory ${directory}`, {
      allowMissing: true,
    })
  ) {
    return null;
  }
  const checksums = parseChecksumSet(directory);
  if (!checksums.has(proofName) || !checksums.has('foundation-reset-evidence.json')) {
    fail(`reset consumption directory ${directory} lacks sealed reset proof files`);
  }
  const copiedEvidence = join(directory, 'foundation-reset-evidence.json');
  if (!readRegularFile(copiedEvidence).equals(readRegularFile(node.files.evidence))) {
    fail(`reset consumption directory ${directory} changed foundation reset evidence`);
  }
  const proof = readJson(join(directory, proofName), `reset consumption proof ${proofName}`);
  if (proofName === 'deploy-evidence.json') {
    if (
      proof.schemaVersion !== 1 ||
      proof.status !== 'passed' ||
      proof.environment !== environment ||
      proof.namespace !== namespaceFor(environment) ||
      proof.sourceSha !== node.plan.sourceSha ||
      proof.releaseId !== node.plan.releaseId ||
      proof.manifestDigest !== node.plan.manifestDigest ||
      proof.foundationMode !== 'reset' ||
      proof.foundationResetEvidenceDigest !== node.evidenceDigest ||
      !isDeepStrictEqual(proof.foundationReset, node.evidence)
    ) {
      fail(`final release evidence does not consume reset ${node.plan.requestId}`);
    }
    return 'final';
  }
  if (
    proofName !== 'activation-evidence.json' ||
    environment !== 'production' ||
    proof.schemaVersion !== 1 ||
    proof.status !== 'awaiting-acceptance' ||
    proof.environment !== 'production' ||
    proof.namespace !== 'combo' ||
    proof.sourceSha !== node.plan.sourceSha ||
    proof.releaseId !== node.plan.releaseId ||
    proof.manifestDigest !== node.plan.manifestDigest ||
    proof.foundationResetEvidenceDigest !== node.evidenceDigest
  ) {
    fail(`activation evidence does not consume reset ${node.plan.requestId}`);
  }
  return 'activation';
}

function readPending(environmentRoot, environment) {
  const path = join(environmentRoot, 'pending.json');
  const state = pathState(path);
  if (state === null) return null;
  const pending = readJson(path, 'release pending checkpoint');
  const keys = [
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
  ];
  if (
    !hasExactKeys(pending, keys) ||
    pending.schemaVersion !== 3 ||
    pending.environment !== environment ||
    pending.namespace !== namespaceFor(environment) ||
    !SHA_RE.test(pending.sourceSha) ||
    pending.releaseId !== `release-${pending.sourceSha}` ||
    !DIGEST_RE.test(pending.manifestDigest) ||
    !['armed', 'post-cut', 'finalizing'].includes(pending.phase) ||
    !DIGEST_RE.test(pending.schemaStructureProofDigest) ||
    typeof pending.foundationCreated !== 'boolean' ||
    !hasNonemptyString(pending.webService) ||
    !(
      pending.foundationResetEvidenceDigest === null ||
      DIGEST_RE.test(pending.foundationResetEvidenceDigest)
    )
  ) {
    fail('release pending checkpoint is invalid');
  }
  return { path, value: pending };
}

function applyDirectConsumption(nodes, evidenceRoot, environment, pending) {
  const environmentRoot = join(evidenceRoot, environment);
  for (const node of nodes.values()) {
    if (!node.evidence) continue;
    const finalized = validateConsumptionDirectory(
      node,
      join(environmentRoot, node.plan.releaseId),
      'deploy-evidence.json',
      environment,
    );
    if (finalized) {
      node.directConsumption = finalized;
      continue;
    }
    if (
      pending &&
      pending.value.sourceSha === node.plan.sourceSha &&
      pending.value.releaseId === node.plan.releaseId &&
      pending.value.manifestDigest === node.plan.manifestDigest &&
      pending.value.foundationResetEvidenceDigest === node.evidenceDigest
    ) {
      node.directConsumption = 'pending';
      continue;
    }
    const activationPath = join(environmentRoot, `${node.plan.releaseId}.activation`);
    const activationState = pathState(activationPath);
    if (activationState !== null) {
      if (environment !== 'production') {
        fail(`Preview reset ${node.plan.requestId} has an unexpected activation directory`);
      }
      node.directConsumption = validateConsumptionDirectory(
        node,
        activationPath,
        'activation-evidence.json',
        environment,
      );
    }
  }
  for (const node of nodes.values()) {
    if (node.successorRequestId && node.directConsumption) {
      fail(`consumed reset ${node.plan.requestId} unexpectedly has a successor`);
    }
  }
}

function auditOptions(options) {
  const { evidenceRoot, environment, sourceSha, manifestDigest, mode, evidence } = options;
  if (!hasNonemptyString(evidenceRoot)) fail('evidence root is required');
  namespaceFor(environment);
  if (!SHA_RE.test(sourceSha)) fail('source SHA is invalid');
  if (!DIGEST_RE.test(manifestDigest)) fail('manifest digest is invalid');
  if (!['reset', 'deploy-reset', 'reuse'].includes(mode)) fail('audit mode is invalid');
  if ((mode === 'deploy-reset') !== hasNonemptyString(evidence)) {
    fail('deploy-reset requires exactly one supplied evidence file');
  }

  const resolvedRoot = resolve(evidenceRoot);
  requireDirectory(resolvedRoot, 'release evidence root');
  if (realpathSync(resolvedRoot) !== resolvedRoot) {
    fail('release evidence root contains a symbolic-link path');
  }
  const foundationRoot = join(resolvedRoot, 'foundation-resets');
  requireDirectory(foundationRoot, 'foundation reset root', { allowMissing: true });
  const stateRoot = join(foundationRoot, environment);
  const environmentRoot = join(resolvedRoot, environment);
  requireDirectory(environmentRoot, 'environment release evidence directory', {
    allowMissing: true,
  });
  const nodes = readJournalNodes(stateRoot, environment);
  validateSupersessionLinks(nodes);
  const pending = readPending(environmentRoot, environment);
  applyDirectConsumption(nodes, resolvedRoot, environment, pending);

  const currentRequestId = requestIdFor(environment, sourceSha, manifestDigest);
  const current = nodes.get(currentRequestId) ?? null;
  const terminals = [...nodes.values()].filter((node) => node.successorRequestId === null);
  const outstanding = terminals.filter((node) => !node.directConsumption);
  const incomplete = [...nodes.values()].filter((node) => !node.evidence);
  const pendingReset = pending?.value.foundationResetEvidenceDigest ? pending.value : null;

  if (
    pendingReset &&
    (pendingReset.sourceSha !== sourceSha ||
      pendingReset.releaseId !== `release-${sourceSha}` ||
      pendingReset.manifestDigest !== manifestDigest)
  ) {
    fail('a pending clean-slate boundary requires controlled roll-forward');
  }

  let authorization;
  let predecessor = null;
  let currentRetry = current !== null;

  if (mode === 'reuse') {
    if (current) fail('this candidate entered the clean-slate boundary and cannot use reuse');
    if (pendingReset) fail('a pending clean-slate boundary requires controlled roll-forward');
    if (incomplete.length > 0) fail('an unfinished foundation reset journal blocks reuse');
    if (outstanding.length > 0) {
      fail('an unconsumed foundation reset chain blocks reuse');
    }
    authorization = 'reuse';
  } else if (mode === 'deploy-reset') {
    if (!current?.evidence) fail('deploy-reset lacks the exact completed current reset journal');
    const supplied = resolve(evidence);
    if (
      !readRegularFile(supplied, 'supplied foundation reset evidence').equals(
        readRegularFile(current.files.evidence),
      )
    ) {
      fail('supplied foundation reset evidence differs from the durable current journal');
    }
    if (
      outstanding.length > 1 ||
      (outstanding.length === 1 && outstanding[0].plan.requestId !== currentRequestId)
    ) {
      fail('deploy-reset is not the unique current reset chain head');
    }
    if (incomplete.length > 0) fail('deploy-reset is blocked by an unfinished reset journal');
    authorization = 'exact-reset-deploy';
  } else if (current) {
    if (
      outstanding.length > 1 ||
      (outstanding.length === 1 && outstanding[0].plan.requestId !== currentRequestId)
    ) {
      fail('the current reset is not the unique recoverable chain head');
    }
    if (incomplete.some((node) => node.plan.requestId !== currentRequestId)) {
      fail('another unfinished foundation reset journal blocks this reset');
    }
    authorization = 'exact-reset-retry';
    if (current.plan.schemaVersion === 2) {
      predecessor = current.plan.supersededReset;
    }
  } else if (outstanding.length === 0) {
    if (incomplete.length > 0) fail('an unfinished foundation reset journal blocks this reset');
    authorization = 'normal-reset';
  } else {
    if (environment !== 'preview') {
      fail('an unconsumed completed foundation reset blocks Production reset');
    }
    if (outstanding.length !== 1 || incomplete.length > 0 || !outstanding[0].evidence) {
      fail('Preview reset requires one completed unconsumed chain head');
    }
    authorization = 'superseding-reset';
    predecessor = descriptorFor(outstanding[0]);
  }

  const outstandingHead = outstanding.length === 1 ? outstanding[0] : null;
  const result = {
    schemaVersion: 1,
    status: 'passed',
    environment,
    mode,
    currentRequestId,
    authorization,
    predecessorEvidencePath: predecessor
      ? (nodes.get(predecessor.requestId)?.files.evidence ?? null)
      : null,
    supersededReset: predecessor,
    currentRetry,
    chainHeadRequestId: outstandingHead?.plan.requestId ?? null,
    chainConsumed: outstanding.length === 0,
    journalCount: nodes.size,
    completedJournalCount: [...nodes.values()].filter((node) => node.evidence).length,
  };

  if (predecessor && result.predecessorEvidencePath === null) {
    fail('supersession predecessor evidence path is missing');
  }
  return result;
}

export function auditFoundationResetJournals(options) {
  return auditOptions(options);
}

function usage() {
  process.stderr.write(
    'Usage: foundation-reset-journal.mjs audit ' +
      '--evidence-root ROOT --environment preview|production ' +
      '--source-sha SHA --manifest-digest sha256:... ' +
      '--mode reset|deploy-reset|reuse [--evidence FILE]\n',
  );
  process.exitCode = 2;
}

function parseArgs(argv) {
  if (argv[0] !== 'audit') {
    usage();
    return null;
  }
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    if (index + 1 >= argv.length) {
      usage();
      return null;
    }
    const option = argv[index];
    const value = argv[index + 1];
    const key = {
      '--evidence-root': 'evidenceRoot',
      '--environment': 'environment',
      '--source-sha': 'sourceSha',
      '--manifest-digest': 'manifestDigest',
      '--mode': 'mode',
      '--evidence': 'evidence',
    }[option];
    if (!key || Object.hasOwn(values, key)) {
      usage();
      return null;
    }
    values[key] = value;
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  if (options) {
    try {
      process.stdout.write(`${JSON.stringify(auditFoundationResetJournals(options))}\n`);
    } catch (error) {
      if (error instanceof JournalError) {
        process.stderr.write(`[foundation-reset-journal] FAIL: ${error.message}\n`);
        process.exitCode = 1;
      } else {
        throw error;
      }
    }
  }
}
