#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const POSITIVE_INTEGER_STRING_PATTERN = /^[1-9][0-9]*$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_PATTERNS = Object.freeze({
  api: /^ghcr\.io\/dangdang-tech\/combo-api@sha256:[0-9a-f]{64}$/,
  runtime: /^ghcr\.io\/dangdang-tech\/combo-runtime@sha256:[0-9a-f]{64}$/,
  web: /^ghcr\.io\/dangdang-tech\/combo-web@sha256:[0-9a-f]{64}$/,
});
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|credential|pairing|password|private|secret|token)/i;
const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  /(?:bearer|basic)\s+[a-z0-9._~+/=-]+/i,
  /cb_(?:session|refresh)=/i,
  /set-cookie/i,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/i,
  /gh[pousr]_[A-Za-z0-9]{20,255}/,
  /github_pat_[A-Za-z0-9_]{20,255}/,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
]);
const FORBIDDEN_RESOURCE_PATTERN =
  /(?:^|[-_.])(consumer|sweeper|outbox)(?:$|[-_.])|cloud-review|rt_chat|rt_studio/i;
const EXPECTED_MIGRATIONS = Object.freeze([
  '0000_baseline_schema.sql',
  '0001_expired_upload_reconciliation.sql',
  '0002_drop_stream_events.sql',
  '0003_turns.sql',
  '0004_studio_sessions.sql',
  '0005_capability_current_ui.sql',
  '0006_one_running_turn_per_session.sql',
  '0007_first_party_email_auth.sql',
  '0008_application_database_roles.sql',
]);
const EXPECTED_DATABASE_TABLES = Object.freeze([
  'artifacts',
  'audit_llm_calls',
  'auth_audit_events',
  'auth_identities',
  'auth_otp_challenges',
  'auth_sessions',
  'capabilities',
  'messages',
  'schema_migrations',
  'sessions',
  'tasks',
  'turns',
  'uploads',
  'users',
]);

export const PROMOTION_ENVIRONMENTS = Object.freeze({
  test: Object.freeze({
    namespace: 'combo-preview',
    deploymentWorkflow: '.github/workflows/combo-dev.yml',
  }),
  preview: Object.freeze({
    namespace: 'combo-review',
    deploymentWorkflow: '.github/workflows/preview.yml',
  }),
  production: Object.freeze({
    namespace: 'combo',
    deploymentWorkflow: '.github/workflows/cd.yml',
  }),
});

export const SIX_AREA_CHECKS = Object.freeze({
  creationJourney: Object.freeze([
    'task_create',
    'connect_and_upload',
    'sync_async_progress',
    'reload_and_interruption_recovery',
    'failure_and_retry',
    'capability_selection_and_publish',
    'trial_return_to_task',
  ]),
  studio: Object.freeze([
    'multi_turn_editing',
    'accepted_input_clear',
    'failed_input_retained',
    'duplicate_submit_fence',
    'element_selection',
    'real_generation_state',
    'completed_revision_history',
    'active_turn_reload',
    'failed_artifact_excluded',
    'current_ui_consume_session',
    'studio_trial_return',
  ]),
  authoring: Object.freeze([
    'prepare_and_upload',
    'terminal_upload_progress',
    'resumable_upload_reload',
    'email_challenge',
    'email_verification',
    'session_persistence',
    'logout_revokes_session',
    'safe_auth_return',
    'owner_isolation',
  ]),
  runtime: Object.freeze([
    'session_turn_message_artifact',
    'artifact_source_turn',
    'active_turn_recovery',
    'completed_artifact_history',
    'current_ui_selection',
    'redis_event_replay',
    'turn_fencing_and_owner_isolation',
  ]),
  accessAndIdentity: Object.freeze([
    'environment_access_boundary',
    'email_auth_session_logout',
    'cookie_cleanup',
    'safe_return_to',
    'runtime_release_identity',
    'hashed_asset_cache_and_404',
  ]),
  operationsAndRelease: Object.freeze([
    'four_planes_ready',
    'immutable_image_match',
    'migration_head_0008',
    'release_manifest_match',
    'web_asset_manifest_match',
    'version_json_match',
    'resource_inventory',
    'legacy_objects_absent',
  ]),
});

export const LIVE_BROWSER_CHECKS = Object.freeze([
  'release_identity',
  'hashed_asset_404',
  'email_otp_login',
  'preview_identity_badge_and_copy',
  'creation_idempotency',
  'authoring_prepare',
  'authoring_resume_after_reload',
  'authoring_upload_terminal',
  'creation_capability_selection',
  'creation_publish_and_retry_fence',
  'studio_entry',
  'studio_failed_send_retains_draft',
  'studio_single_accept_and_clear',
  'studio_active_turn_reload',
  'studio_first_revision',
  'studio_element_selection',
  'runtime_sse_replay_and_terminal',
  'studio_second_revision',
  'studio_interrupted_artifact_excluded',
  'runtime_current_ui_consume',
  'studio_trial_return',
  'task_trial_return',
  'preview_gate_login_and_return_to',
  'owner_isolation',
  'session_persistence',
  'logout_revokes_session',
]);
export const PREVIEW_BROWSER_CHECKS = LIVE_BROWSER_CHECKS;

const LIVE_BROWSER_ORIGINS = Object.freeze({
  test: 'http://127.0.0.1:18080',
  preview: 'https://review.43-160-242-46.sslip.io',
  production: 'https://buildwithcombo.com',
});
const LIVE_BROWSER_FAILURE_REASONS = Object.freeze([
  'assertion',
  'browser',
  'http_status',
  'invalid_response',
  'timeout',
  'unsafe_input',
]);
const LIVE_BROWSER_FAILURE_SENSITIVE_KEY_PATTERN = /(?:body|cookie|email|key|otp|resend|token)/i;
const LIVE_BROWSER_FAILURE_SENSITIVE_VALUE_PATTERNS = Object.freeze([
  /[^\s@]+@[^\s@]+/i,
  /@resend\.dev/i,
  /\b[0-9]{6}\b/,
  /(?:__Host-)?cb_session/i,
  /s1\.[A-Za-z0-9_-]{43}/,
  /\bre_[A-Za-z0-9_-]{16,}\b/,
]);

export const PREVIEW_SIX_AREA_COVERAGE = Object.freeze({
  creationJourney: Object.freeze([
    'creation_idempotency',
    'creation_capability_selection',
    'creation_publish_and_retry_fence',
    'task_trial_return',
  ]),
  studio: Object.freeze([
    'studio_entry',
    'studio_failed_send_retains_draft',
    'studio_single_accept_and_clear',
    'studio_active_turn_reload',
    'studio_first_revision',
    'studio_element_selection',
    'studio_second_revision',
    'studio_interrupted_artifact_excluded',
    'studio_trial_return',
  ]),
  authoring: Object.freeze([
    'authoring_prepare',
    'authoring_resume_after_reload',
    'authoring_upload_terminal',
    'owner_isolation',
  ]),
  runtime: Object.freeze([
    'studio_active_turn_reload',
    'studio_first_revision',
    'studio_second_revision',
    'studio_interrupted_artifact_excluded',
    'runtime_sse_replay_and_terminal',
    'runtime_current_ui_consume',
    'owner_isolation',
  ]),
  accessAndIdentity: Object.freeze([
    'release_identity',
    'hashed_asset_404',
    'email_otp_login',
    'preview_identity_badge_and_copy',
    'preview_gate_login_and_return_to',
    'session_persistence',
    'logout_revokes_session',
  ]),
  operationsAndRelease: Object.freeze(['release_identity', 'hashed_asset_404']),
});

const IDENTITY_KEYS = Object.freeze([
  'artifactFileSetDigest',
  'deploymentRunAttempt',
  'deploymentRunId',
  'deploymentWorkflow',
  'environment',
  'images',
  'namespace',
  'releaseArtifactDigest',
  'releaseArtifactId',
  'releaseArtifactName',
  'releaseId',
  'releaseManifestDigest',
  'schemaVersion',
  'sourceCiRunAttempt',
  'sourceCiRunId',
  'sourceSha',
  'webAssetManifestDigest',
]);
const EVIDENCE_KEYS = Object.freeze([
  'areas',
  'completedAt',
  'identity',
  'origin',
  'schemaVersion',
  'startedAt',
  'status',
  'suite',
]);
const ATTESTATION_KEYS = Object.freeze([
  'acceptanceEvidenceDigest',
  'acceptanceWorkflowRunAttempt',
  'acceptanceWorkflowRunId',
  'acceptedAt',
  'acceptedBy',
  'environment',
  'identityDigest',
  'namespace',
  'repository',
  'schemaVersion',
  'sourceSha',
  'status',
  'suite',
]);
const INVENTORY_KEYS = Object.freeze([
  'collectedAt',
  'databaseTables',
  'environment',
  'excludedKinds',
  'legacyFindings',
  'livePods',
  'migration',
  'namespace',
  'nodePorts',
  'resources',
  'schemaVersion',
  'sourceSha',
]);
const LIVE_RUNTIME_KEYS = Object.freeze([
  'collectedAt',
  'deployments',
  'environment',
  'migration',
  'namespace',
  'schemaVersion',
  'sourceSha',
]);
const TEST_DEPLOYMENT_EVIDENCE_KEYS = Object.freeze([
  'createdAt',
  'images',
  'legacyFindings',
  'legacyObjectsAbsent',
  'livePlanes',
  'migration',
  'missingHashedAssets',
  'releaseId',
  'releaseManifestDigest',
  'releaseMetadata',
  'reset',
  'resourceInventory',
  'schemaVersion',
  'sourceSha',
  'webAssetManifest',
  'workflowRunAttempt',
  'workflowRunId',
]);
const TEST_RESET_KEYS = Object.freeze([
  'completedAt',
  'foundation',
  'namespace',
  'productionFingerprintUnchanged',
  'schemaVersion',
  'sourceSha',
  'startedAt',
  'storage',
  'storageClearedAt',
  'storageSmokePassed',
  'workflowRunAttempt',
  'workflowRunId',
  'writersFenced',
]);
const TEST_MIGRATION_KEYS = Object.freeze([
  'appliedMigrations',
  'capturedAt',
  'head',
  'job',
  'logSha256',
  'namespace',
  'passes',
  'pod',
  'runs',
  'schemaVersion',
  'sourceSha',
  'workflowRunAttempt',
  'workflowRunId',
]);
const TEST_RELEASE_METADATA_KEYS = Object.freeze([
  'builtAt',
  'environment',
  'releaseId',
  'releaseManifestDigest',
  'schemaVersion',
  'sourceSha',
  'webAssetManifest',
]);
const TEST_RESOURCE_INVENTORY_KEYS = Object.freeze([
  'configMaps',
  'cronJobs',
  'daemonSets',
  'deployments',
  'excludedKinds',
  'horizontalPodAutoscalers',
  'ingresses',
  'jobs',
  'limitRanges',
  'networkPolicies',
  'persistentVolumeClaims',
  'pods',
  'resourceQuotas',
  'roleBindings',
  'roles',
  'serviceAccounts',
  'services',
  'statefulSets',
]);
const INVENTORY_RESOURCE_KEYS = Object.freeze([
  'clusterRoleBindings',
  'configMaps',
  'cronJobs',
  'daemonSets',
  'deployments',
  'ingresses',
  'jobs',
  'networkPolicies',
  'persistentVolumeClaims',
  'persistentVolumes',
  'pods',
  'replicaSets',
  'roleBindings',
  'roles',
  'serviceAccounts',
  'services',
  'statefulSets',
]);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys must be exactly: ${wanted.join(', ')}`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer`);
}

function positiveIntegerString(value, label) {
  if (typeof value !== 'string' || !POSITIVE_INTEGER_STRING_PATTERN.test(value)) {
    fail(`${label} must be a positive integer string`);
  }
}

function digest(value, label) {
  if (!DIGEST_PATTERN.test(value ?? '') || value === `sha256:${'0'.repeat(64)}`) {
    fail(`${label} must be a non-zero sha256 digest`);
  }
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value)) {
    fail(`${label} must be an exact UTC RFC3339 timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    fail(`${label} must be an exact UTC RFC3339 timestamp`);
  }
  return parsed.getTime();
}

function sortedUniqueStrings(values, label) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== 'string' || value.length === 0) ||
    values.some((value, index) => index > 0 && values[index - 1].localeCompare(value) >= 0)
  ) {
    fail(`${label} must be a sorted unique string array`);
  }
}

function assertSafeEvidence(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeEvidence(item, `${path}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) fail(`unsafe evidence key at ${path}.${key}`);
      assertSafeEvidence(nested, `${path}.${key}`);
    }
    return;
  }
  if (
    typeof value === 'string' &&
    SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    fail(`unsafe evidence value at ${path}`);
  }
}

function assertSafeLiveBrowserFailureEvidence(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeLiveBrowserFailureEvidence(item, `${path}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (LIVE_BROWSER_FAILURE_SENSITIVE_KEY_PATTERN.test(key)) {
        fail(`unsafe live browser failure key at ${path}.${key}`);
      }
      assertSafeLiveBrowserFailureEvidence(nested, `${path}.${key}`);
    }
    return;
  }
  if (
    typeof value === 'string' &&
    LIVE_BROWSER_FAILURE_SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    fail(`unsafe live browser failure value at ${path}`);
  }
}

function evidenceTimestamp(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(`${label} must be an exact UTC timestamp`);
  }
  return Date.parse(value);
}

function workflowIdentity(value, expected, label) {
  positiveIntegerString(value.workflowRunId, `${label} workflow run id`);
  positiveIntegerString(value.workflowRunAttempt, `${label} workflow run attempt`);
  if (
    value.sourceSha !== expected.sourceSha ||
    value.workflowRunId !== expected.workflowRunId ||
    value.workflowRunAttempt !== expected.workflowRunAttempt
  ) {
    fail(`${label} does not match the Test workflow identity`);
  }
}

function imageIdMatches(imageId, image) {
  return (
    typeof imageId === 'string' &&
    typeof image === 'string' &&
    image.includes('@sha256:') &&
    imageId.endsWith(image.split('@', 2)[1])
  );
}

function exactStringArray(value, expected, label) {
  sortedUniqueStrings(value, label);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    fail(`${label} does not match the exact Test inventory`);
  }
}

function validateTestDeploymentEvidence(value) {
  assertSafeEvidence(value);
  exactKeys(value, TEST_DEPLOYMENT_EVIDENCE_KEYS, 'Test deployment evidence');
  if (value.schemaVersion !== 1) fail('Test deployment evidence schemaVersion must be 1');
  if (!SHA_PATTERN.test(value.sourceSha ?? '') || value.sourceSha === '0'.repeat(40)) {
    fail('Test deployment evidence sourceSha must be a non-zero full lowercase SHA');
  }
  positiveIntegerString(value.workflowRunId, 'Test workflow run id');
  positiveIntegerString(value.workflowRunAttempt, 'Test workflow run attempt');
  const workflow = {
    sourceSha: value.sourceSha,
    workflowRunId: value.workflowRunId,
    workflowRunAttempt: value.workflowRunAttempt,
  };
  evidenceTimestamp(value.createdAt, 'Test deployment evidence createdAt');
  if (value.releaseId !== `release-${value.sourceSha}`) {
    fail('Test deployment evidence releaseId does not match sourceSha');
  }
  digest(value.releaseManifestDigest, 'Test deployment evidence release manifest digest');
  digest(value.webAssetManifest, 'Test deployment evidence Web asset manifest digest');

  exactKeys(value.images, ['api', 'runtime', 'web'], 'Test deployment evidence images');
  for (const [name, pattern] of Object.entries(IMAGE_PATTERNS)) {
    if (!pattern.test(value.images[name] ?? '')) {
      fail(`Test deployment evidence ${name} image is not immutable`);
    }
  }

  exactKeys(value.reset, TEST_RESET_KEYS, 'Test deployment evidence reset');
  workflowIdentity(value.reset, workflow, 'Test reset evidence');
  if (
    value.reset.schemaVersion !== 1 ||
    value.reset.namespace !== 'combo-preview' ||
    value.reset.storageSmokePassed !== true ||
    value.reset.writersFenced !== true ||
    value.reset.productionFingerprintUnchanged !== true
  ) {
    fail('Test reset evidence does not prove the exact reset contract');
  }
  const resetStarted = evidenceTimestamp(value.reset.startedAt, 'Test reset startedAt');
  const storageCleared = evidenceTimestamp(
    value.reset.storageClearedAt,
    'Test reset storageClearedAt',
  );
  const resetCompleted = evidenceTimestamp(value.reset.completedAt, 'Test reset completedAt');
  if (!(resetStarted <= storageCleared && storageCleared <= resetCompleted)) {
    fail('Test reset timestamps are out of order');
  }
  exactKeys(value.reset.storage, ['minio', 'postgres', 'redisQueue'], 'Test reset storage');
  for (const [name, storage] of Object.entries(value.reset.storage)) {
    exactKeys(storage, ['clearedBeforeRebuild'], `Test reset storage.${name}`);
    if (storage.clearedBeforeRebuild !== true) {
      fail(`Test reset storage.${name} was not cleared before rebuild`);
    }
  }
  if (!Array.isArray(value.reset.foundation) || value.reset.foundation.length !== 4) {
    fail('Test reset foundation must contain exactly four planes');
  }
  const foundationPlanes = [];
  for (const [index, plane] of value.reset.foundation.entries()) {
    exactKeys(
      plane,
      ['createdAt', 'plane', 'podUid', 'ready', 'startedAt'],
      `Test reset foundation[${index}]`,
    );
    if (
      typeof plane.plane !== 'string' ||
      !UUID_PATTERN.test(plane.podUid ?? '') ||
      plane.ready !== true
    ) {
      fail(`Test reset foundation[${index}] is malformed`);
    }
    const createdAt = evidenceTimestamp(
      plane.createdAt,
      `Test reset foundation[${index}].createdAt`,
    );
    const startedAt = evidenceTimestamp(
      plane.startedAt,
      `Test reset foundation[${index}].startedAt`,
    );
    if (!(resetStarted <= createdAt && createdAt <= startedAt && startedAt <= resetCompleted)) {
      fail(`Test reset foundation[${index}] timestamps are out of order`);
    }
    foundationPlanes.push(plane.plane);
  }
  if (
    JSON.stringify(foundationPlanes) !==
    JSON.stringify(['minio', 'postgres', 'redis-hot', 'redis-queue'])
  ) {
    fail('Test reset foundation planes are not exact');
  }

  exactKeys(value.migration, TEST_MIGRATION_KEYS, 'Test deployment evidence migration');
  workflowIdentity(value.migration, workflow, 'Test migration evidence');
  if (
    value.migration.schemaVersion !== 1 ||
    value.migration.namespace !== 'combo-preview' ||
    value.migration.head !== EXPECTED_MIGRATIONS.at(-1) ||
    value.migration.runs !== 2
  ) {
    fail('Test migration evidence does not prove the exact migration contract');
  }
  evidenceTimestamp(value.migration.capturedAt, 'Test migration capturedAt');
  if (JSON.stringify(value.migration.appliedMigrations) !== JSON.stringify(EXPECTED_MIGRATIONS)) {
    fail('Test migration applied ledger is not exact');
  }
  if (!Array.isArray(value.migration.passes) || value.migration.passes.length !== 2) {
    fail('Test migration passes must contain exactly two entries');
  }
  value.migration.passes.forEach((pass, index) => {
    exactKeys(pass, ['head', 'run'], `Test migration passes[${index}]`);
    if (pass.run !== index + 1 || pass.head !== EXPECTED_MIGRATIONS.at(-1)) {
      fail(`Test migration passes[${index}] is not exact`);
    }
  });
  exactKeys(
    value.migration.job,
    [
      'completedAt',
      'createdAt',
      'name',
      'startedAt',
      'succeeded',
      'ttlSecondsAfterFinished',
      'uid',
    ],
    'Test migration job',
  );
  if (
    value.migration.job.name !== 'migrate' ||
    !UUID_PATTERN.test(value.migration.job.uid ?? '') ||
    value.migration.job.succeeded !== 1 ||
    value.migration.job.ttlSecondsAfterFinished !== 7200
  ) {
    fail('Test migration job is not the exact successful Job');
  }
  const jobCreated = evidenceTimestamp(
    value.migration.job.createdAt,
    'Test migration job createdAt',
  );
  const jobStarted = evidenceTimestamp(
    value.migration.job.startedAt,
    'Test migration job startedAt',
  );
  const jobCompleted = evidenceTimestamp(
    value.migration.job.completedAt,
    'Test migration job completedAt',
  );
  if (!(jobCreated <= jobStarted && jobStarted <= jobCompleted)) {
    fail('Test migration job timestamps are out of order');
  }
  exactKeys(
    value.migration.pod,
    ['exitCode', 'finishedAt', 'image', 'imageID', 'name', 'startedAt', 'uid'],
    'Test migration pod',
  );
  if (
    typeof value.migration.pod.name !== 'string' ||
    !/^migrate-[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value.migration.pod.name) ||
    !UUID_PATTERN.test(value.migration.pod.uid ?? '') ||
    value.migration.pod.image !== value.images.api ||
    !imageIdMatches(value.migration.pod.imageID, value.images.api) ||
    value.migration.pod.exitCode !== 0
  ) {
    fail('Test migration pod is not the exact successful Pod');
  }
  const podStarted = evidenceTimestamp(
    value.migration.pod.startedAt,
    'Test migration pod startedAt',
  );
  const podFinished = evidenceTimestamp(
    value.migration.pod.finishedAt,
    'Test migration pod finishedAt',
  );
  if (!(jobStarted <= podStarted && podStarted <= podFinished && podFinished <= jobCompleted)) {
    fail('Test migration pod timestamps are out of order');
  }
  digest(value.migration.logSha256, 'Test migration log digest');

  exactKeys(
    value.releaseMetadata,
    ['runtimeConfig', 'tryRuntimeConfig', 'version'],
    'Test release metadata',
  );
  for (const [name, metadata] of Object.entries(value.releaseMetadata)) {
    exactKeys(metadata, TEST_RELEASE_METADATA_KEYS, `Test release metadata.${name}`);
    if (
      metadata.schemaVersion !== 1 ||
      metadata.environment !== 'test' ||
      metadata.sourceSha !== value.sourceSha ||
      metadata.releaseId !== value.releaseId ||
      metadata.releaseManifestDigest !== value.releaseManifestDigest ||
      metadata.webAssetManifest !== value.webAssetManifest
    ) {
      fail(`Test release metadata.${name} does not match the candidate`);
    }
    evidenceTimestamp(metadata.builtAt, `Test release metadata.${name}.builtAt`);
  }

  exactKeys(value.missingHashedAssets, ['runtimeWeb', 'web'], 'Test missing hashed assets');
  if (value.missingHashedAssets.web !== 404 || value.missingHashedAssets.runtimeWeb !== 404) {
    fail('Test missing hashed assets did not both return 404');
  }

  exactKeys(value.resourceInventory, TEST_RESOURCE_INVENTORY_KEYS, 'Test resource inventory');
  const expectedInventory = {
    deployments: ['api', 'redis-hot', 'runtime', 'web', 'worker'],
    statefulSets: ['minio', 'postgres', 'redis-queue'],
    daemonSets: [],
    jobs: ['migrate'],
    cronJobs: [],
    services: ['api', 'minio', 'postgres', 'redis-hot', 'redis-queue', 'runtime', 'web'],
    ingresses: [],
    horizontalPodAutoscalers: [],
    networkPolicies: [
      'allow-dns',
      'app-ingress-from-web',
      'approved-public-https',
      'authoring-internal-egress',
      'default-deny',
      'migrate-egress',
      'minio-ingress',
      'minio-init-egress',
      'network-canary-dns-only',
      'postgres-ingress',
      'redis-hot-ingress',
      'redis-queue-ingress',
      'runtime-internal-egress',
      'web-to-apps',
    ],
    roles: ['combo-dev-dispatcher', 'combo-dev-fencer'],
    roleBindings: ['combo-dev-dispatcher', 'combo-dev-fencer'],
    resourceQuotas: ['combo-dev-ceiling'],
    limitRanges: ['combo-dev-defaults'],
    persistentVolumeClaims: ['data-minio-0', 'data-postgres-0', 'data-redis-queue-0'],
    serviceAccounts: ['default'],
  };
  for (const [name, expected] of Object.entries(expectedInventory)) {
    exactStringArray(value.resourceInventory[name], expected, `Test resource inventory.${name}`);
  }
  if (
    !Array.isArray(value.resourceInventory.configMaps) ||
    value.resourceInventory.configMaps.length !== 8
  ) {
    fail('Test resource inventory.configMaps does not have the exact cardinality');
  }
  sortedUniqueStrings(value.resourceInventory.configMaps, 'Test resource inventory.configMaps');
  const requiredConfigMaps = [
    'combo-dev-minio-config',
    'combo-dev-postgres-entrypoint',
    `combo-release-meta-${value.sourceSha.slice(0, 12)}`,
    'kube-root-ca.crt',
    'minio-init-script',
    'redis-hot-config',
    'redis-queue-config',
  ];
  if (
    !requiredConfigMaps.every((name) => value.resourceInventory.configMaps.includes(name)) ||
    value.resourceInventory.configMaps.filter((name) => /^combo-dev-nginx-[a-z0-9]+$/.test(name))
      .length !== 1
  ) {
    fail('Test resource inventory.configMaps is not exact');
  }
  exactStringArray(
    value.resourceInventory.excludedKinds,
    ['Secret'],
    'Test resource inventory.excludedKinds',
  );
  if (!Array.isArray(value.resourceInventory.pods) || value.resourceInventory.pods.length !== 9) {
    fail('Test resource inventory.pods must contain exactly nine Pods');
  }
  const expectedPodPlanes = [
    'api',
    'migrate',
    'minio',
    'postgres',
    'redis-hot',
    'redis-queue',
    'runtime',
    'web',
    'worker',
  ];
  value.resourceInventory.pods.forEach((pod, index) => {
    exactKeys(
      pod,
      ['healthy', 'name', 'phase', 'plane', 'podUid'],
      `Test resource inventory.pods[${index}]`,
    );
    if (
      pod.plane !== expectedPodPlanes[index] ||
      typeof pod.name !== 'string' ||
      pod.name.length === 0 ||
      !UUID_PATTERN.test(pod.podUid ?? '') ||
      pod.healthy !== true ||
      pod.phase !== (pod.plane === 'migrate' ? 'Succeeded' : 'Running')
    ) {
      fail(`Test resource inventory.pods[${index}] is malformed`);
    }
  });

  if (!Array.isArray(value.livePlanes) || value.livePlanes.length !== 4) {
    fail('Test live planes must contain exactly four business planes');
  }
  const expectedLiveImages = {
    api: value.images.api,
    runtime: value.images.runtime,
    web: value.images.web,
    worker: value.images.api,
  };
  value.livePlanes.forEach((plane, index) => {
    exactKeys(
      plane,
      ['image', 'imageID', 'plane', 'podUid', 'ready'],
      `Test live planes[${index}]`,
    );
    const expectedPlane = Object.keys(expectedLiveImages).sort()[index];
    if (
      plane.plane !== expectedPlane ||
      plane.image !== expectedLiveImages[expectedPlane] ||
      !imageIdMatches(plane.imageID, plane.image) ||
      !UUID_PATTERN.test(plane.podUid ?? '') ||
      plane.ready !== true
    ) {
      fail(`Test live planes[${index}] is not immutable and ready`);
    }
  });

  if (
    !Array.isArray(value.legacyFindings) ||
    value.legacyFindings.length !== 0 ||
    value.legacyObjectsAbsent !== true
  ) {
    fail('Test evidence contains legacy findings');
  }
  return value;
}

export function validateSanitizedJson(value) {
  return validateTestDeploymentEvidence(value);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]),
  );
}

function canonicalJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function readJson(path, label) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) fail(`${label} does not exist`);
  const raw = readFileSync(absolute, 'utf8');
  if (Buffer.byteLength(raw) === 0 || Buffer.byteLength(raw) > 1024 * 1024) {
    fail(`${label} must contain between 1 byte and 1 MiB`);
  }
  try {
    return { value: JSON.parse(raw), raw };
  } catch {
    fail(`${label} is not JSON`);
  }
}

function secureWrite(path, value) {
  const absolute = resolve(path);
  if (existsSync(absolute)) fail('output already exists');
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, canonicalJson(value), 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, absolute);
    unlinkSync(temporary);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function validOrigin(value, environment) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('origin must be an absolute URL');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    fail('origin must contain only scheme, host, and optional port');
  }
  if (environment === 'test') {
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '18080') {
      fail('Test origin must be exactly http://127.0.0.1:18080');
    }
  } else if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.port) {
    fail('Preview and Production origins must use HTTPS without an explicit port');
  }
}

export function validatePromotionIdentity(value) {
  exactKeys(value, IDENTITY_KEYS, 'identity');
  if (value.schemaVersion !== 1) fail('identity schemaVersion must be 1');
  const config = PROMOTION_ENVIRONMENTS[value.environment];
  if (!config) fail('identity environment must be test, preview, or production');
  if (value.namespace !== config.namespace) fail('identity namespace does not match environment');
  if (value.deploymentWorkflow !== config.deploymentWorkflow) {
    fail('identity deployment workflow does not match environment');
  }
  if (!SHA_PATTERN.test(value.sourceSha ?? '') || value.sourceSha === '0'.repeat(40)) {
    fail('identity sourceSha must be a non-zero full lowercase SHA');
  }
  for (const [field, label] of [
    ['sourceCiRunId', 'source CI run id'],
    ['sourceCiRunAttempt', 'source CI run attempt'],
    ['deploymentRunId', 'deployment run id'],
    ['deploymentRunAttempt', 'deployment run attempt'],
    ['releaseArtifactId', 'release artifact id'],
  ]) {
    positiveInteger(value[field], label);
  }
  if (value.releaseArtifactName !== `combo-release-${value.sourceSha}`) {
    fail('identity release artifact name does not match sourceSha');
  }
  if (value.releaseId !== `release-${value.sourceSha}`) {
    fail('identity releaseId does not match sourceSha');
  }
  for (const field of [
    'releaseArtifactDigest',
    'releaseManifestDigest',
    'artifactFileSetDigest',
    'webAssetManifestDigest',
  ]) {
    digest(value[field], `identity ${field}`);
  }
  exactKeys(value.images, ['api', 'runtime', 'web'], 'identity images');
  for (const [name, pattern] of Object.entries(IMAGE_PATTERNS)) {
    if (!pattern.test(value.images[name] ?? '')) fail(`identity ${name} image is not immutable`);
  }
  assertSafeEvidence(value);
  return value;
}

function validateAreas(value) {
  exactKeys(value, Object.keys(SIX_AREA_CHECKS), 'areas');
  for (const [area, expectedChecks] of Object.entries(SIX_AREA_CHECKS)) {
    exactKeys(value[area], ['checks', 'status'], `areas.${area}`);
    if (value[area].status !== 'passed') fail(`areas.${area} must be passed`);
    if (!Array.isArray(value[area].checks) || value[area].checks.length !== expectedChecks.length) {
      fail(`areas.${area}.checks has the wrong length`);
    }
    value[area].checks.forEach((check, index) => {
      exactKeys(check, ['durationMs', 'id', 'status'], `areas.${area}.checks[${index}]`);
      if (check.id !== expectedChecks[index] || check.status !== 'passed') {
        fail(`areas.${area}.checks[${index}] is not the required passed check`);
      }
      if (!Number.isInteger(check.durationMs) || check.durationMs < 0) {
        fail(`areas.${area}.checks[${index}].durationMs must be a non-negative integer`);
      }
    });
  }
}

export function validateSixAreaEvidence(value, expectedIdentity) {
  const identity = validatePromotionIdentity(expectedIdentity);
  exactKeys(value, EVIDENCE_KEYS, 'six-area evidence');
  if (
    value.schemaVersion !== 1 ||
    value.suite !== 'combo-six-area-live' ||
    value.status !== 'passed'
  ) {
    fail('six-area evidence must be a passed schema v1 combo-six-area-live result');
  }
  validatePromotionIdentity(value.identity);
  if (canonicalJson(value.identity) !== canonicalJson(identity)) {
    fail('six-area evidence identity does not match the locked deployment');
  }
  validOrigin(value.origin, identity.environment);
  const started = timestamp(value.startedAt, 'startedAt');
  const completed = timestamp(value.completedAt, 'completedAt');
  if (completed < started) fail('completedAt must not precede startedAt');
  validateAreas(value.areas);
  assertSafeEvidence(value);
  return value;
}

export function validateLiveBrowserEvidence(value, expectedIdentity, expectedEnvironment) {
  const identity = validatePromotionIdentity(expectedIdentity);
  if (
    expectedEnvironment !== undefined &&
    !Object.hasOwn(LIVE_BROWSER_ORIGINS, expectedEnvironment)
  ) {
    fail('live browser environment must be test, preview, or production');
  }
  if (expectedEnvironment !== undefined && identity.environment !== expectedEnvironment) {
    fail('live browser identity does not match the requested environment');
  }
  const environment = identity.environment;
  exactKeys(
    value,
    [
      'checks',
      'completedAt',
      'environment',
      'metrics',
      'release',
      'resources',
      'revision',
      'schemaVersion',
      'startedAt',
      'status',
      'suite',
      'webOrigin',
    ],
    'live browser evidence',
  );
  if (
    value.schemaVersion !== 1 ||
    value.suite !== `goal-b-${environment}-browser` ||
    value.status !== 'passed' ||
    value.environment !== environment ||
    value.revision !== identity.sourceSha ||
    value.webOrigin !== LIVE_BROWSER_ORIGINS[environment]
  ) {
    fail('live browser evidence does not match the locked deployment');
  }
  const started = timestamp(value.startedAt, 'live browser startedAt');
  const completed = timestamp(value.completedAt, 'live browser completedAt');
  if (completed < started) fail('live browser completedAt must not precede startedAt');
  if (!Array.isArray(value.checks) || value.checks.length !== LIVE_BROWSER_CHECKS.length) {
    fail('live browser evidence has the wrong check count');
  }
  value.checks.forEach((check, index) => {
    exactKeys(check, ['durationMs', 'id', 'status'], `live browser checks[${index}]`);
    if (
      check.id !== LIVE_BROWSER_CHECKS[index] ||
      check.status !== 'passed' ||
      !Number.isInteger(check.durationMs) ||
      check.durationMs < 0
    ) {
      fail(`live browser checks[${index}] is not the exact passed live check`);
    }
  });
  exactKeys(
    value.release,
    [
      'builtAt',
      'environment',
      'releaseId',
      'releaseManifestDigest',
      'sourceSha',
      'webAssetManifest',
    ],
    'live browser release',
  );
  if (
    value.release.environment !== environment ||
    value.release.sourceSha !== identity.sourceSha ||
    value.release.releaseId !== identity.releaseId ||
    value.release.releaseManifestDigest !== identity.releaseManifestDigest ||
    value.release.webAssetManifest !== identity.webAssetManifestDigest
  ) {
    fail('live browser release identity does not match the immutable artifact');
  }
  timestamp(value.release.builtAt, 'live browser release builtAt');
  exactKeys(
    value.resources,
    ['capabilityId', 'consumeSessionId', 'studioSessionId', 'taskId'],
    'live browser resources',
  );
  for (const resource of Object.values(value.resources)) {
    if (
      typeof resource !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resource)
    ) {
      fail('live browser resource id is malformed');
    }
  }
  exactKeys(value.metrics, ['completedStudioRevisions', 'uploadParts'], 'live browser metrics');
  if (
    value.metrics.uploadParts !== 2 ||
    !Number.isInteger(value.metrics.completedStudioRevisions) ||
    value.metrics.completedStudioRevisions < 2
  ) {
    fail('live browser flow metrics are incomplete');
  }
  const passed = new Set(value.checks.map((check) => check.id));
  for (const [area, required] of Object.entries(PREVIEW_SIX_AREA_COVERAGE)) {
    if (!required.every((check) => passed.has(check))) {
      fail(`live browser evidence does not cover ${area}`);
    }
  }
  assertSafeEvidence(value);
  return value;
}

export function validatePreviewBrowserEvidence(value, expectedIdentity) {
  return validateLiveBrowserEvidence(value, expectedIdentity, 'preview');
}

export function validateLiveBrowserFailureEvidence(value, expectedIdentity) {
  const identity = validatePromotionIdentity(expectedIdentity);
  if (identity.environment !== 'test') {
    fail('live browser failure identity must select Test');
  }
  for (const field of [
    'sourceCiRunId',
    'sourceCiRunAttempt',
    'deploymentRunId',
    'deploymentRunAttempt',
    'releaseArtifactId',
  ]) {
    if (!Number.isSafeInteger(identity[field])) {
      fail(`live browser failure identity ${field} must be an exact safe integer`);
    }
  }

  assertSafeLiveBrowserFailureEvidence(value);
  assertSafeEvidence(value);
  if (!isObject(value)) fail('live browser failure evidence must be an object');
  const requiredKeys = [
    'checks',
    'completedAt',
    'environment',
    'failure',
    'metrics',
    'resources',
    'revision',
    'schemaVersion',
    'startedAt',
    'status',
    'suite',
    'webOrigin',
  ];
  const allowedKeys = new Set([...requiredKeys, 'release']);
  const actualKeys = Object.keys(value);
  if (
    requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    actualKeys.some((key) => !allowedKeys.has(key))
  ) {
    fail(
      'live browser failure evidence keys must be the required failure keys and optional release',
    );
  }
  if (
    value.schemaVersion !== 1 ||
    value.suite !== 'goal-b-test-browser' ||
    value.environment !== 'test' ||
    value.revision !== identity.sourceSha ||
    value.webOrigin !== LIVE_BROWSER_ORIGINS.test ||
    value.status !== 'failed'
  ) {
    fail('live browser failure evidence does not match the locked Test deployment');
  }

  const started = timestamp(value.startedAt, 'live browser failure startedAt');
  const completed = timestamp(value.completedAt, 'live browser failure completedAt');
  if (completed < started) {
    fail('live browser failure completedAt must not precede startedAt');
  }

  if (!Array.isArray(value.checks) || value.checks.length > LIVE_BROWSER_CHECKS.length) {
    fail('live browser failure checks must be a passed prefix');
  }
  value.checks.forEach((check, index) => {
    exactKeys(check, ['durationMs', 'id', 'status'], `live browser failure checks[${index}]`);
    if (
      check.id !== LIVE_BROWSER_CHECKS[index] ||
      check.status !== 'passed' ||
      !Number.isSafeInteger(check.durationMs) ||
      check.durationMs < 0
    ) {
      fail(`live browser failure checks[${index}] is not the exact passed prefix`);
    }
  });

  if (!isObject(value.failure)) fail('live browser failure must be an object');
  const failureKeys = Object.keys(value.failure).sort();
  if (
    JSON.stringify(failureKeys) !== JSON.stringify(['check', 'reason']) &&
    JSON.stringify(failureKeys) !== JSON.stringify(['check', 'reason', 'statusCode'])
  ) {
    fail('live browser failure keys must be check, reason, and optional statusCode');
  }
  const nextCheck = LIVE_BROWSER_CHECKS[value.checks.length];
  if (value.failure.check !== nextCheck && value.failure.check !== 'acceptance_runtime') {
    fail('live browser failure check must be the next ordered check or acceptance_runtime');
  }
  if (!LIVE_BROWSER_FAILURE_REASONS.includes(value.failure.reason)) {
    fail('live browser failure reason is not allowed');
  }
  if (
    Object.hasOwn(value.failure, 'statusCode') &&
    (!Number.isInteger(value.failure.statusCode) ||
      value.failure.statusCode < 100 ||
      value.failure.statusCode > 599 ||
      value.failure.reason !== 'http_status')
  ) {
    fail('live browser failure statusCode must be a reasonable HTTP status');
  }

  if (!isObject(value.resources)) fail('live browser failure resources must be an object');
  const allowedResourceKeys = new Set([
    'capabilityId',
    'consumeSessionId',
    'studioSessionId',
    'taskId',
  ]);
  for (const [key, resource] of Object.entries(value.resources)) {
    if (!allowedResourceKeys.has(key)) {
      fail('live browser failure resources contain an unknown key');
    }
    if (
      typeof resource !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resource)
    ) {
      fail(`live browser failure resources.${key} must be a UUID`);
    }
  }

  exactKeys(
    value.metrics,
    ['completedStudioRevisions', 'uploadParts'],
    'live browser failure metrics',
  );
  if (
    !Number.isSafeInteger(value.metrics.uploadParts) ||
    value.metrics.uploadParts < 0 ||
    value.metrics.uploadParts > 2 ||
    !Number.isSafeInteger(value.metrics.completedStudioRevisions) ||
    value.metrics.completedStudioRevisions < 0 ||
    value.metrics.completedStudioRevisions > 2
  ) {
    fail('live browser failure metrics are outside the acceptance bounds');
  }

  const releaseIdentityPassed = value.checks.length > 0;
  if (releaseIdentityPassed !== Object.hasOwn(value, 'release')) {
    fail('live browser failure release must exist exactly after release identity passed');
  }
  if (releaseIdentityPassed) {
    exactKeys(
      value.release,
      [
        'builtAt',
        'environment',
        'releaseId',
        'releaseManifestDigest',
        'sourceSha',
        'webAssetManifest',
      ],
      'live browser failure release',
    );
    if (
      value.release.environment !== 'test' ||
      value.release.sourceSha !== identity.sourceSha ||
      value.release.releaseId !== identity.releaseId ||
      value.release.releaseManifestDigest !== identity.releaseManifestDigest ||
      value.release.webAssetManifest !== identity.webAssetManifestDigest
    ) {
      fail('live browser failure release does not match the immutable Test identity');
    }
    timestamp(value.release.builtAt, 'live browser failure release builtAt');
  }
  return value;
}

function expectedInventoryNames(identity) {
  const prefix = `release-${identity.sourceSha.slice(0, 12)}-`;
  const values = {
    deployments: [
      `${prefix}api`,
      `${prefix}runtime`,
      `${prefix}web`,
      `${prefix}worker`,
      'release-redis-hot',
    ],
    statefulSets: ['release-minio', 'release-postgres', 'release-redis-queue'],
    jobs: [`${prefix}migrate`, `${prefix}minio-init`],
    services: [
      `${prefix}api`,
      `${prefix}runtime`,
      `${prefix}web`,
      'release-minio',
      'release-postgres',
      'release-redis-hot',
      'release-redis-queue',
    ],
    ingresses: [],
    persistentVolumeClaims: [
      'data-release-minio-0',
      'data-release-postgres-0',
      'data-release-redis-queue-0',
    ],
    cronJobs: [],
    daemonSets: [],
    networkPolicies: [],
    roles: [],
    roleBindings: [],
    clusterRoleBindings: [],
    serviceAccounts: ['default'],
    configMaps: [
      `combo-release-meta-${identity.sourceSha.slice(0, 12)}`,
      'kube-root-ca.crt',
      'release-minio-init-script',
      'release-redis-hot-config',
      'release-redis-queue-config',
      ...(identity.environment === 'preview' ? [`${prefix}review-gate`] : []),
    ],
  };
  return Object.fromEntries(
    Object.entries(values).map(([key, names]) => [
      key,
      [...names].sort((a, b) => a.localeCompare(b)),
    ]),
  );
}

export function validateReleaseInventory(value, expectedIdentity) {
  const identity = validatePromotionIdentity(expectedIdentity);
  if (!['preview', 'production'].includes(identity.environment)) {
    fail('release inventory is defined only for Preview and Production');
  }
  exactKeys(value, INVENTORY_KEYS, 'release inventory');
  if (
    value.schemaVersion !== 2 ||
    value.environment !== identity.environment ||
    value.namespace !== identity.namespace ||
    value.sourceSha !== identity.sourceSha
  ) {
    fail('release inventory identity does not match the locked deployment');
  }
  timestamp(value.collectedAt, 'release inventory collectedAt');
  if (JSON.stringify(value.excludedKinds) !== '["Secret"]') {
    fail('release inventory must explicitly exclude only Secret values');
  }
  if (!Array.isArray(value.legacyFindings) || value.legacyFindings.length !== 0) {
    fail('release inventory contains a forbidden legacy finding');
  }
  if (!Array.isArray(value.nodePorts) || value.nodePorts.length !== 0) {
    fail('release inventory contains a NodePort');
  }
  sortedUniqueStrings(value.databaseTables, 'release inventory databaseTables');
  if (JSON.stringify(value.databaseTables) !== JSON.stringify(EXPECTED_DATABASE_TABLES)) {
    fail('release inventory database tables do not match the exact current schema');
  }
  if (!Array.isArray(value.livePods) || value.livePods.length < 4) {
    fail('release inventory lacks live release Pods');
  }
  const prefix = `release-${identity.sourceSha.slice(0, 12)}-`;
  const expectedImages = {
    [`${prefix}api`]: identity.images.api,
    [`${prefix}worker`]: identity.images.api,
    [`${prefix}runtime`]: identity.images.runtime,
    [`${prefix}web`]: identity.images.web,
  };
  const podApps = new Set();
  for (const [index, pod] of value.livePods.entries()) {
    exactKeys(
      pod,
      ['app', 'image', 'imageID', 'name', 'ready', 'sourceSha'],
      `release inventory livePods[${index}]`,
    );
    const expectedImage = expectedImages[pod.app];
    if (
      !expectedImage ||
      pod.sourceSha !== identity.sourceSha ||
      pod.image !== expectedImage ||
      pod.imageID !== expectedImage ||
      pod.ready !== true ||
      typeof pod.name !== 'string' ||
      pod.name.length === 0
    ) {
      fail(`release inventory livePods[${index}] does not prove a ready immutable image`);
    }
    podApps.add(pod.app);
  }
  if (JSON.stringify([...podApps].sort()) !== JSON.stringify(Object.keys(expectedImages).sort())) {
    fail('release inventory does not cover all four business planes');
  }
  exactKeys(
    value.migration,
    ['head', 'jobCompletionTime', 'jobImage', 'ledger'],
    'release inventory migration',
  );
  if (
    value.migration.head !== EXPECTED_MIGRATIONS.at(-1) ||
    value.migration.jobImage !== identity.images.api ||
    JSON.stringify(value.migration.ledger) !== JSON.stringify(EXPECTED_MIGRATIONS)
  ) {
    fail('release inventory migration evidence is not exactly 0000 through 0008');
  }
  timestamp(value.migration.jobCompletionTime, 'release inventory migration completion');
  exactKeys(value.resources, INVENTORY_RESOURCE_KEYS, 'release inventory resources');
  const expected = expectedInventoryNames(identity);
  for (const key of Object.keys(expected)) {
    sortedUniqueStrings(value.resources[key], `release inventory resources.${key}`);
    if (JSON.stringify(value.resources[key]) !== JSON.stringify(expected[key])) {
      fail(`release inventory resources.${key} does not match the exact release set`);
    }
  }
  sortedUniqueStrings(value.resources.replicaSets, 'release inventory resources.replicaSets');
  const replicaSetPrefixes = [
    `${prefix}api-`,
    `${prefix}runtime-`,
    `${prefix}web-`,
    `${prefix}worker-`,
    'release-redis-hot-',
  ];
  for (const replicaSetPrefix of replicaSetPrefixes) {
    const matches = value.resources.replicaSets.filter((name) => name.startsWith(replicaSetPrefix));
    if (
      matches.length !== 1 ||
      !/^[a-z0-9]{8,10}$/.test(matches[0].slice(replicaSetPrefix.length))
    ) {
      fail('release inventory ReplicaSets do not match the exact five deployments');
    }
  }
  if (value.resources.replicaSets.length !== replicaSetPrefixes.length) {
    fail('release inventory contains an extra ReplicaSet');
  }
  sortedUniqueStrings(value.resources.pods, 'release inventory resources.pods');
  const expectedFixedPods = ['release-minio-0', 'release-postgres-0', 'release-redis-queue-0'];
  for (const fixedPod of expectedFixedPods) {
    if (!value.resources.pods.includes(fixedPod)) {
      fail('release inventory lacks an exact foundation Pod');
    }
  }
  for (const replicaSet of value.resources.replicaSets) {
    const matches = value.resources.pods.filter(
      (name) =>
        name.startsWith(`${replicaSet}-`) &&
        /^[a-z0-9]{5}$/.test(name.slice(replicaSet.length + 1)),
    );
    if (matches.length !== 1) {
      fail('release inventory Pods do not match the exact ReplicaSet owners');
    }
  }
  for (const job of [`${prefix}migrate-`, `${prefix}minio-init-`]) {
    const matches = value.resources.pods.filter(
      (name) => name.startsWith(job) && /^[a-z0-9]{5}$/.test(name.slice(job.length)),
    );
    if (matches.length !== 1) {
      fail('release inventory Pods do not match the exact release Jobs');
    }
  }
  if (
    value.resources.pods.length !==
    expectedFixedPods.length + value.resources.replicaSets.length + 2
  ) {
    fail('release inventory contains an extra Pod');
  }
  if (
    !Array.isArray(value.resources.persistentVolumes) ||
    value.resources.persistentVolumes.length !== 3
  ) {
    fail('release inventory must contain exactly three bound persistent volumes');
  }
  const claims = [];
  const volumeNames = [];
  for (const [index, volume] of value.resources.persistentVolumes.entries()) {
    exactKeys(volume, ['claim', 'name'], `release inventory persistentVolumes[${index}]`);
    if (
      typeof volume.name !== 'string' ||
      !/^pvc-[0-9a-f-]{36}$/i.test(volume.name) ||
      typeof volume.claim !== 'string'
    ) {
      fail(`release inventory persistentVolumes[${index}] is malformed`);
    }
    claims.push(volume.claim);
    volumeNames.push(volume.name);
  }
  sortedUniqueStrings(volumeNames, 'release inventory persistent volume names');
  claims.sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(claims) !== JSON.stringify(expected.persistentVolumeClaims)) {
    fail('release inventory persistent volumes do not bind the exact release claims');
  }
  for (const names of Object.values(value.resources)) {
    const flat = Array.isArray(names)
      ? names.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
      : [];
    if (flat.some((name) => FORBIDDEN_RESOURCE_PATTERN.test(name))) {
      fail('release inventory contains a forbidden legacy resource name');
    }
  }
  assertSafeEvidence(value);
  return value;
}

export function validateLiveRuntimeEvidence(value, expectedIdentity) {
  const identity = validatePromotionIdentity(expectedIdentity);
  if (!['preview', 'production'].includes(identity.environment)) {
    fail('live runtime evidence is defined only for Preview and Production');
  }
  exactKeys(value, LIVE_RUNTIME_KEYS, 'live runtime evidence');
  if (
    value.schemaVersion !== 1 ||
    value.environment !== identity.environment ||
    value.namespace !== identity.namespace ||
    value.sourceSha !== identity.sourceSha
  ) {
    fail('live runtime evidence identity does not match the locked deployment');
  }
  timestamp(value.collectedAt, 'live runtime collectedAt');
  const prefix = `release-${identity.sourceSha.slice(0, 12)}-`;
  const expectedImages = {
    [`${prefix}api`]: identity.images.api,
    [`${prefix}runtime`]: identity.images.runtime,
    [`${prefix}web`]: identity.images.web,
    [`${prefix}worker`]: identity.images.api,
  };
  if (!Array.isArray(value.deployments) || value.deployments.length !== 4) {
    fail('live runtime evidence must contain exactly four business deployments');
  }
  const deploymentNames = [];
  for (const [index, deployment] of value.deployments.entries()) {
    exactKeys(
      deployment,
      [
        'generation',
        'image',
        'name',
        'observedGeneration',
        'pods',
        'readyReplicas',
        'replicas',
        'sourceSha',
      ],
      `live runtime deployments[${index}]`,
    );
    const expectedImage = expectedImages[deployment.name];
    if (
      !expectedImage ||
      deployment.sourceSha !== identity.sourceSha ||
      deployment.image !== expectedImage ||
      !Number.isInteger(deployment.generation) ||
      deployment.generation < 1 ||
      deployment.observedGeneration !== deployment.generation ||
      !Number.isInteger(deployment.replicas) ||
      deployment.replicas < 1 ||
      deployment.readyReplicas !== deployment.replicas ||
      !Array.isArray(deployment.pods) ||
      deployment.pods.length !== deployment.replicas
    ) {
      fail(`live runtime deployments[${index}] is not fully ready`);
    }
    deploymentNames.push(deployment.name);
    for (const [podIndex, pod] of deployment.pods.entries()) {
      exactKeys(
        pod,
        ['image', 'imageID', 'name', 'ready', 'uid'],
        `live runtime deployments[${index}].pods[${podIndex}]`,
      );
      if (
        typeof pod.name !== 'string' ||
        pod.name.length === 0 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          pod.uid ?? '',
        ) ||
        pod.image !== expectedImage ||
        pod.imageID !== expectedImage ||
        pod.ready !== true
      ) {
        fail(`live runtime deployments[${index}].pods[${podIndex}] is not immutable and ready`);
      }
    }
  }
  if (
    JSON.stringify(deploymentNames.sort()) !== JSON.stringify(Object.keys(expectedImages).sort())
  ) {
    fail('live runtime deployment names do not match the candidate');
  }
  exactKeys(
    value.migration,
    ['head', 'job', 'ledger', 'ledgerDigest', 'pod'],
    'live runtime migration',
  );
  exactKeys(
    value.migration.job,
    ['completionTime', 'image', 'name', 'sourceSha', 'succeeded', 'uid'],
    'live runtime migration job',
  );
  exactKeys(
    value.migration.pod,
    ['exitCode', 'image', 'imageID', 'name', 'phase', 'uid'],
    'live runtime migration pod',
  );
  const expectedMigrationName = `${prefix}migrate`;
  const expectedLedgerDigest = sha256(`${EXPECTED_MIGRATIONS.join('\n')}\n`);
  if (
    value.migration.head !== EXPECTED_MIGRATIONS.at(-1) ||
    JSON.stringify(value.migration.ledger) !== JSON.stringify(EXPECTED_MIGRATIONS) ||
    value.migration.ledgerDigest !== expectedLedgerDigest ||
    value.migration.job.name !== expectedMigrationName ||
    value.migration.job.sourceSha !== identity.sourceSha ||
    value.migration.job.image !== identity.images.api ||
    value.migration.job.succeeded !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.migration.job.uid ?? '',
    ) ||
    value.migration.pod.image !== identity.images.api ||
    value.migration.pod.imageID !== identity.images.api ||
    value.migration.pod.phase !== 'Succeeded' ||
    value.migration.pod.exitCode !== 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.migration.pod.uid ?? '',
    )
  ) {
    fail('live runtime migration does not prove the exact immutable 0000 through 0008 run');
  }
  timestamp(value.migration.job.completionTime, 'live runtime migration completion');
  assertSafeEvidence(value);
  return value;
}

export function createAcceptanceAttestation(evidence, identity, context) {
  const validated = validateSixAreaEvidence(evidence, identity);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository ?? '')) {
    fail('repository is malformed');
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(context.actor ?? '')) fail('actor is malformed');
  positiveInteger(context.workflowRunId, 'acceptance workflow run id');
  positiveInteger(context.workflowRunAttempt, 'acceptance workflow run attempt');
  timestamp(context.acceptedAt, 'acceptedAt');
  const attestation = {
    schemaVersion: 1,
    suite: 'combo-six-area-live-attestation',
    status: 'passed',
    repository: context.repository,
    environment: identity.environment,
    namespace: identity.namespace,
    sourceSha: identity.sourceSha,
    acceptanceWorkflowRunId: context.workflowRunId,
    acceptanceWorkflowRunAttempt: context.workflowRunAttempt,
    acceptedBy: context.actor,
    acceptedAt: context.acceptedAt,
    identityDigest: sha256(canonicalJson(identity)),
    acceptanceEvidenceDigest: sha256(canonicalJson(validated)),
  };
  assertSafeEvidence(attestation);
  return attestation;
}

export function createLiveBrowserAcceptanceAttestation(evidence, identity, context) {
  const validatedIdentity = validatePromotionIdentity(identity);
  if (validatedIdentity.environment !== 'production') {
    fail('Production live-browser attestation requires a Production identity');
  }
  const validated = validateLiveBrowserEvidence(evidence, validatedIdentity, 'production');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository ?? '')) {
    fail('repository is malformed');
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(context.actor ?? '')) fail('actor is malformed');
  positiveInteger(context.workflowRunId, 'acceptance workflow run id');
  positiveInteger(context.workflowRunAttempt, 'acceptance workflow run attempt');
  timestamp(context.acceptedAt, 'acceptedAt');
  const attestation = {
    schemaVersion: 1,
    suite: 'combo-six-area-live-attestation',
    status: 'passed',
    repository: context.repository,
    environment: validatedIdentity.environment,
    namespace: validatedIdentity.namespace,
    sourceSha: validatedIdentity.sourceSha,
    acceptanceWorkflowRunId: context.workflowRunId,
    acceptanceWorkflowRunAttempt: context.workflowRunAttempt,
    acceptedBy: context.actor,
    acceptedAt: context.acceptedAt,
    identityDigest: sha256(canonicalJson(validatedIdentity)),
    acceptanceEvidenceDigest: sha256(canonicalJson(validated)),
  };
  assertSafeEvidence(attestation);
  return attestation;
}

export function validateAcceptanceAttestation(attestation, evidence, identity, expected) {
  const validatedIdentity = validatePromotionIdentity(identity);
  const validatedEvidence = validateSixAreaEvidence(evidence, validatedIdentity);
  exactKeys(attestation, ATTESTATION_KEYS, 'acceptance attestation');
  if (
    attestation.schemaVersion !== 1 ||
    attestation.suite !== 'combo-six-area-live-attestation' ||
    attestation.status !== 'passed' ||
    attestation.repository !== expected.repository ||
    attestation.environment !== validatedIdentity.environment ||
    attestation.namespace !== validatedIdentity.namespace ||
    attestation.sourceSha !== validatedIdentity.sourceSha
  ) {
    fail('acceptance attestation identity is invalid');
  }
  positiveInteger(expected.workflowRunId, 'expected acceptance workflow run id');
  positiveInteger(expected.workflowRunAttempt, 'expected acceptance workflow run attempt');
  if (
    attestation.acceptanceWorkflowRunId !== expected.workflowRunId ||
    attestation.acceptanceWorkflowRunAttempt !== expected.workflowRunAttempt
  ) {
    fail('acceptance attestation does not match the selected workflow attempt');
  }
  timestamp(attestation.acceptedAt, 'acceptance attestation acceptedAt');
  if (attestation.identityDigest !== sha256(canonicalJson(validatedIdentity))) {
    fail('acceptance attestation identity digest is invalid');
  }
  if (attestation.acceptanceEvidenceDigest !== sha256(canonicalJson(validatedEvidence))) {
    fail('acceptance attestation evidence digest is invalid');
  }
  assertSafeEvidence(attestation);
  return attestation;
}

export function validateLiveBrowserAcceptanceAttestation(
  attestation,
  evidence,
  identity,
  expected,
) {
  const validatedIdentity = validatePromotionIdentity(identity);
  if (validatedIdentity.environment !== 'production') {
    fail('Production live-browser attestation requires a Production identity');
  }
  const validatedEvidence = validateLiveBrowserEvidence(evidence, validatedIdentity, 'production');
  exactKeys(attestation, ATTESTATION_KEYS, 'acceptance attestation');
  if (
    attestation.schemaVersion !== 1 ||
    attestation.suite !== 'combo-six-area-live-attestation' ||
    attestation.status !== 'passed' ||
    attestation.repository !== expected.repository ||
    attestation.environment !== 'production' ||
    attestation.namespace !== validatedIdentity.namespace ||
    attestation.sourceSha !== validatedIdentity.sourceSha
  ) {
    fail('acceptance attestation identity is invalid');
  }
  positiveInteger(expected.workflowRunId, 'expected acceptance workflow run id');
  positiveInteger(expected.workflowRunAttempt, 'expected acceptance workflow run attempt');
  if (
    attestation.acceptanceWorkflowRunId !== expected.workflowRunId ||
    attestation.acceptanceWorkflowRunAttempt !== expected.workflowRunAttempt
  ) {
    fail('acceptance attestation does not match the selected workflow attempt');
  }
  timestamp(attestation.acceptedAt, 'acceptance attestation acceptedAt');
  if (attestation.identityDigest !== sha256(canonicalJson(validatedIdentity))) {
    fail('acceptance attestation identity digest is invalid');
  }
  if (attestation.acceptanceEvidenceDigest !== sha256(canonicalJson(validatedEvidence))) {
    fail('acceptance attestation evidence digest is invalid');
  }
  assertSafeEvidence(attestation);
  return attestation;
}

function parseCli(argv) {
  if (argv.length < 1) fail('missing command');
  const command = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) {
      fail('malformed or duplicate command argument');
    }
    values.set(key, value);
  }
  const take = (key) => {
    const value = values.get(key);
    if (!value) fail(`missing ${key}`);
    values.delete(key);
    return value;
  };
  return { command, values, take };
}

function integerArgument(value, label) {
  if (!/^[1-9][0-9]*$/.test(value)) fail(`${label} must be a positive integer`);
  const parsed = Number(value);
  positiveInteger(parsed, label);
  return parsed;
}

function runCli(argv) {
  const { command, values, take } = parseCli(argv);
  if (command === 'validate-identity') {
    const identity = readJson(take('--identity'), 'promotion identity').value;
    if (values.size !== 0) fail('unknown command argument');
    process.stdout.write(`${sha256(canonicalJson(validatePromotionIdentity(identity)))}\n`);
    return;
  }
  if (command === 'validate-sanitized-json') {
    const evidence = readJson(take('--evidence'), 'sanitized evidence').value;
    if (values.size !== 0) fail('unknown command argument');
    process.stdout.write(`${sha256(canonicalJson(validateSanitizedJson(evidence)))}\n`);
    return;
  }
  if (command === 'validate-six-area') {
    const evidence = readJson(take('--evidence'), 'six-area evidence').value;
    const identity = readJson(take('--identity'), 'promotion identity').value;
    if (values.size !== 0) fail('unknown command argument');
    process.stdout.write(`${sha256(canonicalJson(validateSixAreaEvidence(evidence, identity)))}\n`);
    return;
  }
  if (command === 'validate-inventory') {
    const inventory = readJson(take('--inventory'), 'release inventory').value;
    const identity = readJson(take('--identity'), 'promotion identity').value;
    if (values.size !== 0) fail('unknown command argument');
    process.stdout.write(
      `${sha256(canonicalJson(validateReleaseInventory(inventory, identity)))}\n`,
    );
    return;
  }
  if (command === 'validate-live-runtime') {
    const evidence = readJson(take('--evidence'), 'live runtime evidence').value;
    const identity = readJson(take('--identity'), 'promotion identity').value;
    if (values.size !== 0) fail('unknown command argument');
    process.stdout.write(
      `${sha256(canonicalJson(validateLiveRuntimeEvidence(evidence, identity)))}\n`,
    );
    return;
  }
  if (command === 'validate-preview-browser') {
    const evidence = readJson(take('--evidence'), 'Preview browser evidence').value;
    const identity = readJson(take('--identity'), 'promotion identity').value;
    if (values.size !== 0) fail('unknown command argument');
    process.stdout.write(
      `${sha256(canonicalJson(validatePreviewBrowserEvidence(evidence, identity)))}\n`,
    );
    return;
  }
  if (command === 'validate-live-browser') {
    const evidence = readJson(take('--evidence'), 'live browser evidence').value;
    const identity = readJson(take('--identity'), 'promotion identity').value;
    const environment = take('--environment');
    if (!Object.hasOwn(LIVE_BROWSER_ORIGINS, environment)) {
      fail('--environment must be test, preview, or production');
    }
    if (values.size !== 0) fail('unknown command argument');
    process.stdout.write(
      `${sha256(canonicalJson(validateLiveBrowserEvidence(evidence, identity, environment)))}\n`,
    );
    return;
  }
  if (command === 'validate-live-browser-failure') {
    const evidence = readJson(take('--evidence'), 'live browser failure evidence').value;
    const identity = readJson(take('--identity'), 'promotion identity').value;
    const environment = take('--environment');
    if (environment !== 'test') {
      fail('--environment must be test for live browser failure evidence');
    }
    if (values.size !== 0) fail('unknown command argument');
    const validatedIdentity = validatePromotionIdentity(identity);
    const validatedEvidence = validateLiveBrowserFailureEvidence(evidence, validatedIdentity);
    process.stdout.write(
      `${sha256(canonicalJson({ evidence: validatedEvidence, identity: validatedIdentity }))}\n`,
    );
    return;
  }
  if (command === 'attest-six-area') {
    const evidence = readJson(take('--evidence'), 'six-area evidence').value;
    const identity = readJson(take('--identity'), 'promotion identity').value;
    const output = take('--output');
    const repository = take('--repository');
    const actor = take('--actor');
    const workflowRunId = integerArgument(take('--workflow-run-id'), 'workflow run id');
    const workflowRunAttempt = integerArgument(
      take('--workflow-run-attempt'),
      'workflow run attempt',
    );
    const acceptedAt = take('--accepted-at');
    if (values.size !== 0) fail('unknown command argument');
    secureWrite(
      output,
      createAcceptanceAttestation(evidence, identity, {
        repository,
        actor,
        workflowRunId,
        workflowRunAttempt,
        acceptedAt,
      }),
    );
    return;
  }
  if (command === 'validate-attestation') {
    const evidence = readJson(take('--evidence'), 'six-area evidence').value;
    const identity = readJson(take('--identity'), 'promotion identity').value;
    const attestation = readJson(take('--attestation'), 'acceptance attestation').value;
    const repository = take('--repository');
    const workflowRunId = integerArgument(take('--workflow-run-id'), 'workflow run id');
    const workflowRunAttempt = integerArgument(
      take('--workflow-run-attempt'),
      'workflow run attempt',
    );
    if (values.size !== 0) fail('unknown command argument');
    validateAcceptanceAttestation(attestation, evidence, identity, {
      repository,
      workflowRunId,
      workflowRunAttempt,
    });
    return;
  }
  if (command === 'attest-live-browser') {
    const evidence = readJson(take('--evidence'), 'live browser evidence').value;
    const identity = readJson(take('--identity'), 'promotion identity').value;
    const output = take('--output');
    const repository = take('--repository');
    const actor = take('--actor');
    const workflowRunId = integerArgument(take('--workflow-run-id'), 'workflow run id');
    const workflowRunAttempt = integerArgument(
      take('--workflow-run-attempt'),
      'workflow run attempt',
    );
    const acceptedAt = take('--accepted-at');
    if (values.size !== 0) fail('unknown command argument');
    secureWrite(
      output,
      createLiveBrowserAcceptanceAttestation(evidence, identity, {
        repository,
        actor,
        workflowRunId,
        workflowRunAttempt,
        acceptedAt,
      }),
    );
    return;
  }
  if (command === 'validate-live-attestation') {
    const evidence = readJson(take('--evidence'), 'live browser evidence').value;
    const identity = readJson(take('--identity'), 'promotion identity').value;
    const attestation = readJson(take('--attestation'), 'acceptance attestation').value;
    const repository = take('--repository');
    const workflowRunId = integerArgument(take('--workflow-run-id'), 'workflow run id');
    const workflowRunAttempt = integerArgument(
      take('--workflow-run-attempt'),
      'workflow run attempt',
    );
    if (values.size !== 0) fail('unknown command argument');
    validateLiveBrowserAcceptanceAttestation(attestation, evidence, identity, {
      repository,
      workflowRunId,
      workflowRunAttempt,
    });
    return;
  }
  fail('unknown command');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `promotion-evidence: ${error instanceof Error ? error.message : 'failed'}\n`,
    );
    process.exitCode = 1;
  }
}
