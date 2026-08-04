import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import {
  PREVIEW_BROWSER_CHECKS,
  SIX_AREA_CHECKS,
  createAcceptanceAttestation,
  createLiveBrowserAcceptanceAttestation,
  validateAcceptanceAttestation,
  validateLiveBrowserAcceptanceAttestation,
  validateLiveBrowserEvidence,
  validateLiveBrowserFailureEvidence,
  validateLiveRuntimeEvidence,
  validatePromotionIdentity,
  validateReleaseInventory,
  validatePreviewBrowserEvidence,
  validateSanitizedJson,
  validateSixAreaEvidence,
} from './promotion-evidence.mjs';
import { GOAL_B_ACCEPTANCE_CHECKS } from './goal-b-test-acceptance.mjs';

const REVISION = 'a'.repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;
const migrations = [
  '0000_baseline_schema.sql',
  '0001_expired_upload_reconciliation.sql',
  '0002_drop_stream_events.sql',
  '0003_turns.sql',
  '0004_studio_sessions.sql',
  '0005_capability_current_ui.sql',
  '0006_one_running_turn_per_session.sql',
  '0007_first_party_email_auth.sql',
  '0008_application_database_roles.sql',
  '0009_billing.sql',
];
const identity = {
  schemaVersion: 1,
  environment: 'preview',
  namespace: 'combo-review',
  sourceSha: REVISION,
  sourceCiRunId: 101,
  sourceCiRunAttempt: 2,
  deploymentWorkflow: '.github/workflows/preview.yml',
  deploymentRunId: 202,
  deploymentRunAttempt: 3,
  releaseArtifactId: 303,
  releaseArtifactName: `combo-release-${REVISION}-2`,
  releaseArtifactDigest: digest('1'),
  releaseId: `release-${REVISION}`,
  releaseManifestDigest: digest('2'),
  artifactFileSetDigest: digest('3'),
  webAssetManifestDigest: digest('4'),
  images: {
    api: `ghcr.io/dangdang-tech/combo-api@${digest('5')}`,
    runtime: `ghcr.io/dangdang-tech/combo-runtime@${digest('6')}`,
    web: `ghcr.io/dangdang-tech/combo-web@${digest('7')}`,
  },
};

const evidence = {
  schemaVersion: 1,
  suite: 'combo-six-area-live',
  status: 'passed',
  identity,
  origin: 'https://review.example.com',
  startedAt: '2026-07-25T00:00:00.000Z',
  completedAt: '2026-07-25T00:10:00.000Z',
  areas: Object.fromEntries(
    Object.entries(SIX_AREA_CHECKS).map(([area, checks]) => [
      area,
      {
        status: 'passed',
        checks: checks.map((id) => ({ id, status: 'passed', durationMs: 1 })),
      },
    ]),
  ),
};

test('six-area contract names only first-party auth and the current migration head', () => {
  const serialized = JSON.stringify(SIX_AREA_CHECKS);
  for (const required of [
    'email_challenge',
    'email_verification',
    'session_persistence',
    'logout_revokes_session',
    'owner_isolation',
    'migration_head_0009',
  ]) {
    assert.match(serialized, new RegExp(required));
  }
  assert.doesNotMatch(serialized, /oidc|logto|migration_head_0006/i);
});

const productionIdentity = {
  ...identity,
  environment: 'production',
  namespace: 'combo',
  deploymentWorkflow: '.github/workflows/cd.yml',
  deploymentRunId: 505,
  deploymentRunAttempt: 1,
};

const testIdentity = {
  ...identity,
  environment: 'test',
  namespace: 'combo-preview',
  deploymentWorkflow: '.github/workflows/combo-dev.yml',
  deploymentRunId: 404,
  deploymentRunAttempt: 2,
};

function testDeploymentEvidence() {
  const images = {
    api: `ghcr.io/dangdang-tech/combo-api@${digest('5')}`,
    runtime: `ghcr.io/dangdang-tech/combo-runtime@${digest('6')}`,
    web: `ghcr.io/dangdang-tech/combo-web@${digest('7')}`,
  };
  const metadata = {
    schemaVersion: 1,
    environment: 'test',
    sourceSha: REVISION,
    releaseId: `release-${REVISION}`,
    builtAt: '2026-07-24T23:59:00.000Z',
    releaseManifestDigest: digest('2'),
    webAssetManifest: digest('4'),
  };
  const podUid = (index) => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;
  return {
    schemaVersion: 1,
    createdAt: '2026-07-25T00:12:00Z',
    workflowRunId: '404',
    workflowRunAttempt: '2',
    sourceSha: REVISION,
    releaseId: `release-${REVISION}`,
    releaseManifestDigest: digest('2'),
    reset: {
      schemaVersion: 1,
      namespace: 'combo-preview',
      sourceSha: REVISION,
      workflowRunId: '404',
      workflowRunAttempt: '2',
      startedAt: '2026-07-25T00:00:00Z',
      storageClearedAt: '2026-07-25T00:01:00Z',
      completedAt: '2026-07-25T00:04:00Z',
      storage: {
        minio: { clearedBeforeRebuild: true },
        postgres: { clearedBeforeRebuild: true },
        redisQueue: { clearedBeforeRebuild: true },
      },
      foundation: ['minio', 'postgres', 'redis-hot', 'redis-queue'].map((plane, index) => ({
        plane,
        podUid: podUid(index + 1),
        createdAt: '2026-07-25T00:02:00Z',
        startedAt: '2026-07-25T00:03:00Z',
        ready: true,
      })),
      storageSmokePassed: true,
      writersFenced: true,
      productionFingerprintUnchanged: true,
    },
    migration: {
      schemaVersion: 1,
      namespace: 'combo-preview',
      sourceSha: REVISION,
      workflowRunId: '404',
      workflowRunAttempt: '2',
      capturedAt: '2026-07-25T00:09:00Z',
      head: migrations.at(-1),
      runs: 2,
      appliedMigrations: migrations,
      passes: [
        { run: 1, head: migrations.at(-1) },
        { run: 2, head: migrations.at(-1) },
      ],
      job: {
        name: 'migrate',
        uid: podUid(10),
        createdAt: '2026-07-25T00:05:00Z',
        startedAt: '2026-07-25T00:06:00Z',
        completedAt: '2026-07-25T00:08:00Z',
        succeeded: 1,
        ttlSecondsAfterFinished: 7200,
      },
      pod: {
        name: 'migrate-abc12',
        uid: podUid(11),
        startedAt: '2026-07-25T00:06:30Z',
        finishedAt: '2026-07-25T00:07:30Z',
        image: images.api,
        imageID: `containerd://${digest('5')}`,
        exitCode: 0,
      },
      logSha256: digest('8'),
    },
    webAssetManifest: digest('4'),
    images,
    livePlanes: [
      ['api', images.api],
      ['runtime', images.runtime],
      ['web', images.web],
      ['worker', images.api],
    ].map(([plane, image], index) => ({
      plane,
      image,
      imageID: `containerd://${image.split('@')[1]}`,
      podUid: podUid(index + 20),
      ready: true,
    })),
    releaseMetadata: {
      runtimeConfig: { ...metadata },
      tryRuntimeConfig: { ...metadata },
      version: { ...metadata },
    },
    missingHashedAssets: { runtimeWeb: 404, web: 404 },
    resourceInventory: {
      configMaps: [
        'combo-dev-minio-config',
        'combo-dev-nginx-a1b2c3',
        'combo-dev-postgres-entrypoint',
        `combo-release-meta-${REVISION.slice(0, 12)}`,
        'kube-root-ca.crt',
        'minio-init-script',
        'redis-hot-config',
        'redis-queue-config',
      ],
      cronJobs: [],
      daemonSets: [],
      deployments: ['api', 'redis-hot', 'runtime', 'web', 'worker'],
      excludedKinds: ['Secret'],
      horizontalPodAutoscalers: [],
      ingresses: [],
      jobs: ['migrate'],
      limitRanges: ['combo-dev-defaults'],
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
      persistentVolumeClaims: ['data-minio-0', 'data-postgres-0', 'data-redis-queue-0'],
      pods: [
        ['api', 'Running'],
        ['migrate', 'Succeeded'],
        ['minio', 'Running'],
        ['postgres', 'Running'],
        ['redis-hot', 'Running'],
        ['redis-queue', 'Running'],
        ['runtime', 'Running'],
        ['web', 'Running'],
        ['worker', 'Running'],
      ].map(([plane, phase], index) => ({
        name: `${plane}-${index}`,
        plane,
        podUid: podUid(index + 30),
        phase,
        healthy: true,
      })),
      resourceQuotas: ['combo-dev-ceiling'],
      roleBindings: ['combo-dev-dispatcher', 'combo-dev-fencer'],
      roles: ['combo-dev-dispatcher', 'combo-dev-fencer'],
      serviceAccounts: ['default'],
      services: ['api', 'minio', 'postgres', 'redis-hot', 'redis-queue', 'runtime', 'web'],
      statefulSets: ['minio', 'postgres', 'redis-queue'],
    },
    legacyFindings: [],
    legacyObjectsAbsent: true,
  };
}

function browserEvidence(environment = 'preview') {
  const expectedIdentity = environment === 'production' ? productionIdentity : identity;
  return {
    schemaVersion: 1,
    suite: `goal-b-${environment}-browser`,
    environment,
    revision: REVISION,
    workflowRunId: expectedIdentity.deploymentRunId,
    workflowRunAttempt: expectedIdentity.deploymentRunAttempt,
    webOrigin:
      environment === 'production'
        ? 'https://buildwithcombo.com'
        : environment === 'test'
          ? 'https://test.43-160-242-46.sslip.io'
          : 'https://review.43-160-242-46.sslip.io',
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:10:00.000Z',
    status: 'passed',
    checks: PREVIEW_BROWSER_CHECKS.map((id) => ({ id, status: 'passed', durationMs: 1 })),
    resources: {
      taskId: '11111111-1111-4111-8111-111111111111',
      capabilityId: '22222222-2222-4222-8222-222222222222',
      studioSessionId: '33333333-3333-4333-8333-333333333333',
      consumeSessionId: '44444444-4444-4444-8444-444444444444',
    },
    metrics: { uploadParts: 2, completedStudioRevisions: 2 },
    release: {
      environment,
      sourceSha: REVISION,
      releaseId: `release-${REVISION}`,
      builtAt: '2026-07-24T00:00:00.000Z',
      releaseManifestDigest: expectedIdentity.releaseManifestDigest,
      webAssetManifest: expectedIdentity.webAssetManifestDigest,
    },
  };
}

function browserFailureEvidence(prefixLength = 2, failure = undefined, environment = 'test') {
  const expectedIdentity =
    environment === 'test'
      ? testIdentity
      : environment === 'preview'
        ? identity
        : productionIdentity;
  const webOrigin =
    environment === 'test'
      ? 'https://test.43-160-242-46.sslip.io'
      : environment === 'preview'
        ? 'https://review.43-160-242-46.sslip.io'
        : 'https://buildwithcombo.com';
  const value = {
    schemaVersion: 1,
    suite: `goal-b-${environment}-browser`,
    environment,
    revision: REVISION,
    workflowRunId: expectedIdentity.deploymentRunId,
    workflowRunAttempt: expectedIdentity.deploymentRunAttempt,
    webOrigin,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:00:03.000Z',
    status: 'failed',
    checks: PREVIEW_BROWSER_CHECKS.slice(0, prefixLength).map((id) => ({
      id,
      status: 'passed',
      durationMs: 1,
    })),
    resources: {},
    metrics: { uploadParts: 0, completedStudioRevisions: 0 },
    failure: failure ?? {
      check: PREVIEW_BROWSER_CHECKS[prefixLength],
      reason: 'http_status',
      statusCode: 202,
    },
  };
  if (prefixLength > 0) {
    value.release = {
      environment,
      sourceSha: REVISION,
      releaseId: `release-${REVISION}`,
      builtAt: '2026-07-24T00:00:00.000Z',
      releaseManifestDigest: expectedIdentity.releaseManifestDigest,
      webAssetManifest: expectedIdentity.webAssetManifestDigest,
    };
  }
  return value;
}

function inventory(expectedIdentity = identity) {
  const prefix = `release-${REVISION.slice(0, 12)}-`;
  const replicaSetSpecs = [
    [`${prefix}api-1111111111`, 2],
    [`${prefix}runtime-2222222222`, 2],
    [`${prefix}web-3333333333`, 1],
    [`${prefix}worker-4444444444`, 1],
    ['release-redis-hot-5555555555', 1],
  ];
  const replicaSets = replicaSetSpecs.map(([name]) => name).sort();
  const replicaSetPods = replicaSetSpecs.map(([name, replicas], groupIndex) =>
    Array.from(
      { length: replicas },
      (_, replicaIndex) => `${name}-${groupIndex}${replicaIndex}abc`,
    ),
  );
  const livePods = [
    ['api', expectedIdentity.images.api, 0],
    ['runtime', expectedIdentity.images.runtime, 1],
    ['web', expectedIdentity.images.web, 2],
    ['worker', expectedIdentity.images.api, 3],
  ].flatMap(([component, image, replicaSetIndex]) =>
    replicaSetPods[replicaSetIndex].map((name) => ({
      app: `${prefix}${component}`,
      image,
      imageID: image,
      name,
      ready: true,
      sourceSha: REVISION,
    })),
  );
  return {
    schemaVersion: 2,
    environment: expectedIdentity.environment,
    namespace: expectedIdentity.namespace,
    sourceSha: REVISION,
    collectedAt: '2026-07-25T00:11:00.000Z',
    excludedKinds: ['Secret'],
    databaseTables: [
      'artifacts',
      'audit_llm_calls',
      'auth_audit_events',
      'auth_identities',
      'auth_otp_challenges',
      'auth_sessions',
      'billing_accounts',
      'billing_free_allowances',
      'capabilities',
      'messages',
      'payment_attempts',
      'payment_callback_events',
      'recharge_orders',
      'schema_migrations',
      'sessions',
      'tasks',
      'turns',
      'uploads',
      'usage_charges',
      'users',
      'wallet_ledger',
    ],
    legacyFindings: [],
    livePods,
    migration: {
      head: migrations.at(-1),
      jobCompletionTime: '2026-07-25T00:10:00Z',
      jobImage: expectedIdentity.images.api,
      ledger: migrations,
    },
    nodePorts: [],
    resources: {
      deployments: [
        `${prefix}api`,
        `${prefix}runtime`,
        `${prefix}web`,
        `${prefix}worker`,
        'release-redis-hot',
      ].sort(),
      statefulSets: ['release-minio', 'release-postgres', 'release-redis-queue'],
      jobs: [`${prefix}migrate`, `${prefix}minio-init`].sort(),
      services: [
        `${prefix}api`,
        `${prefix}runtime`,
        `${prefix}web`,
        'release-minio',
        'release-postgres',
        'release-redis-hot',
        'release-redis-queue',
      ].sort(),
      ingresses: [],
      persistentVolumeClaims: [
        'data-release-minio-0',
        'data-release-postgres-0',
        'data-release-redis-queue-0',
      ],
      persistentVolumes: [
        { claim: 'data-release-minio-0', name: 'pvc-11111111-1111-4111-8111-111111111111' },
        { claim: 'data-release-postgres-0', name: 'pvc-22222222-2222-4222-8222-222222222222' },
        {
          claim: 'data-release-redis-queue-0',
          name: 'pvc-33333333-3333-4333-8333-333333333333',
        },
      ],
      pods: [
        ...replicaSetPods.flat(),
        `${prefix}migrate-def34`,
        `${prefix}minio-init-ghi56`,
        'release-minio-0',
        'release-postgres-0',
        'release-redis-queue-0',
      ].sort(),
      replicaSets,
      cronJobs: [],
      daemonSets: [],
      networkPolicies: [],
      roles: expectedIdentity.environment === 'production' ? ['combo-dev-production-observer'] : [],
      roleBindings:
        expectedIdentity.environment === 'production' ? ['combo-dev-production-observer'] : [],
      clusterRoleBindings: [],
      serviceAccounts:
        expectedIdentity.environment === 'preview'
          ? ['default', 'runtime-sandbox-manager']
          : ['default'],
      configMaps: [
        `combo-release-meta-${REVISION.slice(0, 12)}`,
        'kube-root-ca.crt',
        'release-minio-init-script',
        'release-redis-hot-config',
        'release-redis-queue-config',
        ...(expectedIdentity.environment === 'preview' ? [`${prefix}preview-routing`] : []),
      ].sort(),
    },
  };
}

function liveRuntime(expectedIdentity = identity) {
  const prefix = `release-${REVISION.slice(0, 12)}-`;
  const components = [
    ['api', expectedIdentity.images.api],
    ['runtime', expectedIdentity.images.runtime],
    ['web', expectedIdentity.images.web],
    ['worker', expectedIdentity.images.api],
  ];
  return {
    schemaVersion: 1,
    environment: expectedIdentity.environment,
    namespace: expectedIdentity.namespace,
    sourceSha: REVISION,
    collectedAt: '2026-07-25T00:12:00.000Z',
    deployments: components.map(([component, image], index) => ({
      name: `${prefix}${component}`,
      generation: 2,
      observedGeneration: 2,
      replicas: 1,
      readyReplicas: 1,
      image,
      sourceSha: REVISION,
      pods: [
        {
          name: `${prefix}${component}-${index}`,
          uid: `${index + 1}1111111-1111-4111-8111-111111111111`,
          image,
          imageID: image,
          ready: true,
        },
      ],
    })),
    migration: {
      job: {
        name: `${prefix}migrate`,
        uid: '51111111-1111-4111-8111-111111111111',
        image: expectedIdentity.images.api,
        succeeded: 1,
        completionTime: '2026-07-25T00:09:00Z',
        sourceSha: REVISION,
      },
      pod: {
        name: `${prefix}migrate-0`,
        uid: '61111111-1111-4111-8111-111111111111',
        image: expectedIdentity.images.api,
        imageID: expectedIdentity.images.api,
        phase: 'Succeeded',
        exitCode: 0,
      },
      ledger: migrations,
      head: migrations.at(-1),
      ledgerDigest: `sha256:${createHash('sha256')
        .update(`${migrations.join('\n')}\n`)
        .digest('hex')}`,
    },
  };
}

test('locks a six-area result to one exact immutable deployment identity', () => {
  assert.deepEqual(validatePromotionIdentity(identity), identity);
  assert.deepEqual(validateSixAreaEvidence(evidence, identity), evidence);
  for (const changed of [
    { ...identity, sourceCiRunAttempt: 4 },
    { ...identity, deploymentRunId: 999 },
    { ...identity, releaseArtifactId: 999 },
    { ...identity, artifactFileSetDigest: digest('8') },
    { ...identity, images: { ...identity.images, web: identity.images.runtime } },
  ]) {
    assert.throws(() => validateSixAreaEvidence(evidence, changed));
  }
});

test('requires every ordered check in all six areas', () => {
  const missing = structuredClone(evidence);
  missing.areas.studio.checks.pop();
  assert.throws(() => validateSixAreaEvidence(missing, identity), /wrong length/);

  const reordered = structuredClone(evidence);
  reordered.areas.runtime.checks.reverse();
  assert.throws(() => validateSixAreaEvidence(reordered, identity), /required passed check/);

  const failed = structuredClone(evidence);
  failed.areas.creationJourney.status = 'failed';
  assert.throws(() => validateSixAreaEvidence(failed, identity), /must be passed/);
});

test('rejects credentials and non-environment origins from sanitized evidence', () => {
  assert.throws(
    () => validateSixAreaEvidence({ ...evidence, cookie: 'cb_session=private' }, identity),
    /keys must be exactly/,
  );
  const unsafe = structuredClone(evidence);
  unsafe.areas.studio.checks[0].id = 'Bearer private';
  assert.throws(() => validateSixAreaEvidence(unsafe, identity));
  assert.throws(
    () => validateSixAreaEvidence({ ...evidence, origin: 'http://review.example.com' }, identity),
    /HTTPS/,
  );
});

test('sanitized Test deployment evidence binds the exact workflow attempt and nested schemas', () => {
  const deployment = testDeploymentEvidence();
  assert.deepEqual(validateSanitizedJson(deployment), deployment);

  for (const mutate of [
    (value) => {
      value.reset.workflowRunAttempt = '3';
    },
    (value) => {
      value.migration.workflowRunAttempt = '3';
    },
    (value) => {
      value.workflowRunAttempt = 2;
    },
    (value) => {
      value.images.extra = value.images.api;
    },
    (value) => {
      value.reset.storage.postgres.extra = true;
    },
    (value) => {
      value.reset.foundation[0].extra = true;
    },
    (value) => {
      value.migration.passes[0].extra = true;
    },
    (value) => {
      value.migration.job.extra = true;
    },
    (value) => {
      value.migration.pod.extra = true;
    },
    (value) => {
      value.releaseMetadata.version.extra = true;
    },
    (value) => {
      value.missingHashedAssets.extra = 404;
    },
    (value) => {
      value.resourceInventory.extra = [];
    },
    (value) => {
      value.resourceInventory.pods[0].extra = true;
    },
    (value) => {
      value.livePlanes[0].extra = true;
    },
  ]) {
    const changed = structuredClone(deployment);
    mutate(changed);
    assert.throws(() => validateSanitizedJson(changed));
  }
});

test('sanitized Test deployment evidence rejects bare GitHub and AWS credential values', () => {
  const credentials = [
    `ghp_${'A'.repeat(36)}`,
    `gho_${'B'.repeat(36)}`,
    `ghu_${'C'.repeat(36)}`,
    `ghs_${'D'.repeat(36)}`,
    `ghr_${'E'.repeat(36)}`,
    `github_pat_${'F'.repeat(32)}`,
    `AKIA${'G'.repeat(16)}`,
    `ASIA${'H'.repeat(16)}`,
  ];
  for (const credential of credentials) {
    const changed = testDeploymentEvidence();
    changed.resourceInventory.pods[0].name = credential;
    assert.throws(() => validateSanitizedJson(changed), /unsafe evidence value/);
  }
});

test('attestation pins the exact acceptance workflow attempt and evidence digest', () => {
  const context = {
    repository: 'dangdang-tech/Combo',
    actor: 'release-operator',
    workflowRunId: 404,
    workflowRunAttempt: 2,
    acceptedAt: '2026-07-25T00:12:00.000Z',
  };
  const attestation = createAcceptanceAttestation(evidence, identity, context);
  assert.deepEqual(
    validateAcceptanceAttestation(attestation, evidence, identity, {
      repository: context.repository,
      workflowRunId: context.workflowRunId,
      workflowRunAttempt: context.workflowRunAttempt,
    }),
    attestation,
  );
  assert.throws(() =>
    validateAcceptanceAttestation(attestation, evidence, identity, {
      repository: context.repository,
      workflowRunId: context.workflowRunId,
      workflowRunAttempt: 3,
    }),
  );
  const tampered = structuredClone(evidence);
  tampered.areas.studio.checks[0].durationMs += 1;
  assert.throws(() =>
    validateAcceptanceAttestation(attestation, tampered, identity, {
      repository: context.repository,
      workflowRunId: context.workflowRunId,
      workflowRunAttempt: context.workflowRunAttempt,
    }),
  );
});

test('resource inventory is exact and rejects legacy names, NodePorts, and omitted kinds', () => {
  assert.deepEqual(validateReleaseInventory(inventory(), identity), inventory());
  assert.deepEqual(
    validateReleaseInventory(inventory(productionIdentity), productionIdentity),
    inventory(productionIdentity),
  );

  const previewWithoutSandboxManager = inventory();
  previewWithoutSandboxManager.resources.serviceAccounts = ['default'];
  assert.deepEqual(
    validateReleaseInventory(previewWithoutSandboxManager, identity),
    previewWithoutSandboxManager,
  );

  const unexpectedPreviewServiceAccount = inventory();
  unexpectedPreviewServiceAccount.resources.serviceAccounts.push('unexpected-manager');
  unexpectedPreviewServiceAccount.resources.serviceAccounts.sort();
  assert.throws(() => validateReleaseInventory(unexpectedPreviewServiceAccount, identity));

  const oldPlane = inventory();
  oldPlane.resources.deployments.push('consumer');
  oldPlane.resources.deployments.sort();
  assert.throws(() => validateReleaseInventory(oldPlane, identity));

  const nodePort = inventory();
  nodePort.nodePorts.push({ name: 'web', port: 30080 });
  assert.throws(() => validateReleaseInventory(nodePort, identity), /NodePort/);

  const omitted = inventory();
  delete omitted.resources.networkPolicies;
  assert.throws(() => validateReleaseInventory(omitted, identity), /keys must be exactly/);

  const oldCloudReview = inventory();
  oldCloudReview.resources.ingresses.push('cloud-review');
  assert.throws(() => validateReleaseInventory(oldCloudReview, identity));

  const unexpectedProductionSandboxManager = inventory(productionIdentity);
  unexpectedProductionSandboxManager.resources.serviceAccounts.push('runtime-sandbox-manager');
  assert.throws(() =>
    validateReleaseInventory(unexpectedProductionSandboxManager, productionIdentity),
  );

  const missingProductionObserver = inventory(productionIdentity);
  missingProductionObserver.resources.roles = [];
  assert.throws(() => validateReleaseInventory(missingProductionObserver, productionIdentity));

  const missingProductionObserverBinding = inventory(productionIdentity);
  missingProductionObserverBinding.resources.roleBindings = [];
  assert.throws(() =>
    validateReleaseInventory(missingProductionObserverBinding, productionIdentity),
  );

  const missingApiReplica = inventory();
  missingApiReplica.livePods.splice(0, 1);
  assert.throws(() => validateReleaseInventory(missingApiReplica, identity), /replica/);

  const duplicateLivePod = inventory();
  duplicateLivePod.livePods[1] = structuredClone(duplicateLivePod.livePods[0]);
  assert.throws(() => validateReleaseInventory(duplicateLivePod, identity), /names must be unique/);

  const wrongLiveReplicaDistribution = inventory();
  wrongLiveReplicaDistribution.livePods[1] = {
    ...wrongLiveReplicaDistribution.livePods[1],
    app: `release-${REVISION.slice(0, 12)}-web`,
    image: identity.images.web,
    imageID: identity.images.web,
  };
  assert.throws(
    () => validateReleaseInventory(wrongLiveReplicaDistribution, identity),
    /business-plane replica counts/,
  );

  const unmatchedLivePod = inventory();
  unmatchedLivePod.livePods[0].name = `release-${REVISION.slice(0, 12)}-api-1111111111-zzzzz`;
  assert.throws(
    () => validateReleaseInventory(unmatchedLivePod, identity),
    /exact business ReplicaSet Pods/,
  );

  const missingApiReplicaPod = inventory();
  const apiReplicaSet = missingApiReplicaPod.resources.replicaSets.find((name) =>
    name.startsWith(`release-${REVISION.slice(0, 12)}-api-`),
  );
  assert.ok(apiReplicaSet);
  const apiReplicaPod = missingApiReplicaPod.resources.pods.find((name) =>
    name.startsWith(`${apiReplicaSet}-`),
  );
  assert.ok(apiReplicaPod);
  missingApiReplicaPod.resources.pods = missingApiReplicaPod.resources.pods.filter(
    (name) => name !== apiReplicaPod,
  );
  assert.throws(() => validateReleaseInventory(missingApiReplicaPod, identity), /ReplicaSet/);

  const missingAuthTable = inventory();
  missingAuthTable.databaseTables = missingAuthTable.databaseTables.filter(
    (table) => table !== 'auth_sessions',
  );
  assert.throws(
    () => validateReleaseInventory(missingAuthTable, identity),
    /database tables do not match/,
  );
});

test('live runtime evidence proves four live imageIDs and the exact migration ledger', () => {
  const preview = liveRuntime();
  assert.deepEqual(validateLiveRuntimeEvidence(preview, identity), preview);
  const production = liveRuntime(productionIdentity);
  assert.deepEqual(validateLiveRuntimeEvidence(production, productionIdentity), production);

  const imageDrift = structuredClone(preview);
  imageDrift.deployments[0].pods[0].imageID = identity.images.runtime;
  assert.throws(() => validateLiveRuntimeEvidence(imageDrift, identity), /immutable and ready/);

  const ledgerGap = structuredClone(preview);
  ledgerGap.migration.ledger.splice(3, 1);
  assert.throws(() => validateLiveRuntimeEvidence(ledgerGap, identity), /migration/);
});

test('Preview browser admission requires all live checks and exact release identity', () => {
  assert.deepEqual(PREVIEW_BROWSER_CHECKS, GOAL_B_ACCEPTANCE_CHECKS);
  const browser = browserEvidence();
  assert.deepEqual(validatePreviewBrowserEvidence(browser, identity), browser);

  const missing = structuredClone(browser);
  missing.checks.pop();
  assert.throws(() => validatePreviewBrowserEvidence(missing, identity), /wrong check count/);

  const wrongRelease = structuredClone(browser);
  wrongRelease.release.releaseManifestDigest = digest('f');
  assert.throws(() => validatePreviewBrowserEvidence(wrongRelease, identity), /does not match/);

  const wrongAttempt = structuredClone(browser);
  wrongAttempt.workflowRunAttempt += 1;
  assert.throws(() => validatePreviewBrowserEvidence(wrongAttempt, identity), /does not match/);
});

test('Test live-browser failure admission accepts only the next check after a passed prefix', () => {
  const failed = browserFailureEvidence();
  assert.equal(failed.failure.check, 'email_otp_login');
  assert.deepEqual(validateLiveBrowserFailureEvidence(failed, testIdentity), failed);

  const runtimeFailure = browserFailureEvidence(2, {
    check: 'acceptance_runtime',
    reason: 'browser',
  });
  assert.deepEqual(
    validateLiveBrowserFailureEvidence(runtimeFailure, testIdentity),
    runtimeFailure,
  );

  const beforeReleaseIdentity = browserFailureEvidence(0, {
    check: 'release_identity',
    reason: 'timeout',
  });
  assert.equal(Object.hasOwn(beforeReleaseIdentity, 'release'), false);
  assert.deepEqual(
    validateLiveBrowserFailureEvidence(beforeReleaseIdentity, testIdentity),
    beforeReleaseIdentity,
  );

  const skipped = browserFailureEvidence();
  skipped.checks[1].id = 'email_otp_login';
  assert.throws(
    () => validateLiveBrowserFailureEvidence(skipped, testIdentity),
    /exact passed prefix/,
  );

  const wrongFailureCheck = browserFailureEvidence();
  wrongFailureCheck.failure.check = 'authoring_prepare';
  assert.throws(
    () => validateLiveBrowserFailureEvidence(wrongFailureCheck, testIdentity),
    /next ordered check/,
  );

  const complete = browserFailureEvidence(PREVIEW_BROWSER_CHECKS.length, {
    check: 'acceptance_runtime',
    reason: 'browser',
  });
  assert.deepEqual(validateLiveBrowserFailureEvidence(complete, testIdentity), complete);

  const completeWithRepeatedCheck = structuredClone(complete);
  completeWithRepeatedCheck.failure.check = PREVIEW_BROWSER_CHECKS.at(-1);
  assert.throws(
    () => validateLiveBrowserFailureEvidence(completeWithRepeatedCheck, testIdentity),
    /next ordered check/,
  );
});

test('Test live-browser failure admission locks Test origin, release, SHA, and exact run integers', () => {
  const failed = browserFailureEvidence();

  const wrongOrigin = structuredClone(failed);
  wrongOrigin.webOrigin = 'https://review.43-160-242-46.sslip.io';
  assert.throws(
    () => validateLiveBrowserFailureEvidence(wrongOrigin, testIdentity),
    /locked deployment/,
  );

  const wrongAttempt = structuredClone(failed);
  wrongAttempt.workflowRunAttempt += 1;
  assert.throws(
    () => validateLiveBrowserFailureEvidence(wrongAttempt, testIdentity),
    /locked deployment/,
  );

  const wrongRelease = structuredClone(failed);
  wrongRelease.release.releaseManifestDigest = digest('f');
  assert.throws(
    () => validateLiveBrowserFailureEvidence(wrongRelease, testIdentity),
    /immutable identity/,
  );

  const missingRelease = structuredClone(failed);
  delete missingRelease.release;
  assert.throws(
    () => validateLiveBrowserFailureEvidence(missingRelease, testIdentity),
    /release must exist exactly/,
  );

  const prematureRelease = browserFailureEvidence(0, {
    check: 'release_identity',
    reason: 'assertion',
  });
  prematureRelease.release = structuredClone(failed.release);
  assert.throws(
    () => validateLiveBrowserFailureEvidence(prematureRelease, testIdentity),
    /release must exist exactly/,
  );

  assert.throws(
    () => validateLiveBrowserFailureEvidence(failed, identity, 'test'),
    /does not match the requested environment/,
  );
  assert.throws(
    () =>
      validateLiveBrowserFailureEvidence(failed, {
        ...testIdentity,
        sourceSha: 'b'.repeat(40),
        releaseArtifactName: `combo-release-${'b'.repeat(40)}-2`,
        releaseId: `release-${'b'.repeat(40)}`,
      }),
    /locked deployment/,
  );
  assert.throws(
    () =>
      validateLiveBrowserFailureEvidence(failed, {
        ...testIdentity,
        deploymentRunId: Number.MAX_SAFE_INTEGER + 1,
      }),
    /exact safe integer/,
  );
  assert.throws(
    () =>
      validateLiveBrowserFailureEvidence(failed, {
        ...testIdentity,
        deploymentRunAttempt: Number.MAX_SAFE_INTEGER + 1,
      }),
    /exact safe integer/,
  );
  assert.throws(
    () =>
      validateLiveBrowserFailureEvidence(failed, {
        ...testIdentity,
        releaseArtifactId: Number.MAX_SAFE_INTEGER + 1,
      }),
    /exact safe integer/,
  );
});

test('Preview and Production live-browser failure admission bind their exact environment', () => {
  const preview = browserFailureEvidence(3, undefined, 'preview');
  assert.deepEqual(validateLiveBrowserFailureEvidence(preview, identity, 'preview'), preview);
  assert.throws(
    () => validateLiveBrowserFailureEvidence(preview, identity, 'production'),
    /does not match the requested environment/,
  );

  const production = browserFailureEvidence(3, undefined, 'production');
  assert.deepEqual(
    validateLiveBrowserFailureEvidence(production, productionIdentity, 'production'),
    production,
  );
  assert.throws(
    () => validateLiveBrowserFailureEvidence(production, identity, 'preview'),
    /locked deployment/,
  );
});

test('Test live-browser failure admission strictly allows failure, resource, metric, and release fields', () => {
  const invalidReason = browserFailureEvidence();
  invalidReason.failure.reason = 'provider_error';
  assert.throws(
    () => validateLiveBrowserFailureEvidence(invalidReason, testIdentity),
    /reason is not allowed/,
  );

  const lowStatus = browserFailureEvidence();
  lowStatus.failure.statusCode = 99;
  assert.throws(
    () => validateLiveBrowserFailureEvidence(lowStatus, testIdentity),
    /reasonable HTTP status/,
  );

  const highStatus = browserFailureEvidence();
  highStatus.failure.statusCode = 600;
  assert.throws(
    () => validateLiveBrowserFailureEvidence(highStatus, testIdentity),
    /reasonable HTTP status/,
  );

  const misplacedStatus = browserFailureEvidence(2, {
    check: 'email_otp_login',
    reason: 'assertion',
    statusCode: 400,
  });
  assert.throws(
    () => validateLiveBrowserFailureEvidence(misplacedStatus, testIdentity),
    /reasonable HTTP status/,
  );

  const terminalTurn = browserFailureEvidence(14, {
    check: 'studio_first_revision',
    reason: 'invalid_response',
    diagnosticCode: 'TURN_IDLE_TIMEOUT',
  });
  assert.deepEqual(validateLiveBrowserFailureEvidence(terminalTurn, testIdentity), terminalTurn);
  const reloadTerminalTurn = browserFailureEvidence(13, {
    check: 'studio_active_turn_reload',
    reason: 'invalid_response',
    diagnosticCode: 'TURN_PROMPT_FAILED',
  });
  assert.deepEqual(
    validateLiveBrowserFailureEvidence(reloadTerminalTurn, testIdentity),
    reloadTerminalTurn,
  );
  const sseTerminalTurn = browserFailureEvidence(16, {
    check: 'runtime_sse_replay_and_terminal',
    reason: 'invalid_response',
    diagnosticCode: 'TURN_RUNTIME_ERROR',
  });
  assert.deepEqual(
    validateLiveBrowserFailureEvidence(sseTerminalTurn, testIdentity),
    sseTerminalTurn,
  );
  const timedOutSubmit = browserFailureEvidence(12, {
    check: 'studio_single_accept_and_clear',
    reason: 'timeout',
    diagnosticCode: 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_TIMEOUT',
    requestCount: 1,
  });
  assert.deepEqual(
    validateLiveBrowserFailureEvidence(timedOutSubmit, testIdentity),
    timedOutSubmit,
  );
  const rejectedSubmit = browserFailureEvidence(12, {
    check: 'studio_single_accept_and_clear',
    reason: 'http_status',
    statusCode: 503,
    diagnosticCode: 'MESSAGE_RESPONSE_STATUS_UNEXPECTED',
    requestCount: 1,
  });
  assert.deepEqual(
    validateLiveBrowserFailureEvidence(rejectedSubmit, testIdentity),
    rejectedSubmit,
  );
  const duplicateSubmit = browserFailureEvidence(12, {
    check: 'studio_single_accept_and_clear',
    reason: 'invalid_response',
    diagnosticCode: 'MESSAGE_REQUEST_COUNT_UNEXPECTED',
    requestCount: 2,
  });
  assert.deepEqual(
    validateLiveBrowserFailureEvidence(duplicateSubmit, testIdentity),
    duplicateSubmit,
  );

  for (const changed of [
    browserFailureEvidence(14, {
      check: 'studio_first_revision',
      reason: 'invalid_response',
      diagnosticCode: 'provider returned raw error',
    }),
    browserFailureEvidence(14, {
      check: 'studio_first_revision',
      reason: 'timeout',
      diagnosticCode: 'TURN_IDLE_TIMEOUT',
    }),
    browserFailureEvidence(2, {
      check: 'email_otp_login',
      reason: 'invalid_response',
      diagnosticCode: 'TURN_IDLE_TIMEOUT',
    }),
    browserFailureEvidence(12, {
      check: 'studio_single_accept_and_clear',
      reason: 'invalid_response',
      diagnosticCode: 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_TIMEOUT',
      requestCount: 1,
    }),
    browserFailureEvidence(12, {
      check: 'studio_single_accept_and_clear',
      reason: 'timeout',
      diagnosticCode: 'raw socket failure',
      requestCount: 1,
    }),
  ]) {
    assert.throws(
      () => validateLiveBrowserFailureEvidence(changed, testIdentity),
      /allowed browser diagnostic code/,
    );
  }

  for (const requestCount of [-1, 101, 1.5]) {
    const invalidRequestCount = browserFailureEvidence(12, {
      check: 'studio_single_accept_and_clear',
      reason: 'timeout',
      diagnosticCode: 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_TIMEOUT',
      requestCount,
    });
    assert.throws(
      () => validateLiveBrowserFailureEvidence(invalidRequestCount, testIdentity),
      /bounded message diagnostic count/,
    );
  }
  for (const failure of [
    {
      check: 'studio_single_accept_and_clear',
      reason: 'timeout',
      diagnosticCode: 'MESSAGE_RESPONSE_TIMEOUT_DETAIL_TIMEOUT',
    },
    {
      check: 'studio_single_accept_and_clear',
      reason: 'timeout',
      diagnosticCode: 'MESSAGE_REQUEST_NOT_OBSERVED',
      requestCount: 1,
    },
    {
      check: 'studio_single_accept_and_clear',
      reason: 'invalid_response',
      diagnosticCode: 'MESSAGE_REQUEST_COUNT_UNEXPECTED',
      requestCount: 1,
    },
  ]) {
    const invalidRequestCount = browserFailureEvidence(12, failure);
    assert.throws(
      () => validateLiveBrowserFailureEvidence(invalidRequestCount, testIdentity),
      /requestCount/,
    );
  }

  for (const mutate of [
    (value) => {
      value.failure.detail = 'no';
    },
    (value) => {
      value.resources.artifactId = '11111111-1111-4111-8111-111111111111';
    },
    (value) => {
      value.metrics.extra = 0;
    },
    (value) => {
      value.metrics.uploadParts = 3;
    },
    (value) => {
      value.metrics.completedStudioRevisions = 3;
    },
    (value) => {
      value.release.extra = true;
    },
  ]) {
    const changed = browserFailureEvidence();
    mutate(changed);
    assert.throws(() => validateLiveBrowserFailureEvidence(changed, testIdentity));
  }
});

test('Test live-browser failure admission recursively rejects auth and email material', () => {
  for (const mutate of [
    (value) => {
      value.failure.responseBody = 'redacted';
    },
    (value) => {
      value.failure.email = 'redacted';
    },
    (value) => {
      value.failure.otp = 'redacted';
    },
    (value) => {
      value.failure.resend = 'redacted';
    },
    (value) => {
      value.failure.cookie = 'redacted';
    },
    (value) => {
      value.failure.token = 'redacted';
    },
    (value) => {
      value.failure.key = 'redacted';
    },
    (value) => {
      value.resources.taskId = 'acceptance@resend.dev';
    },
    (value) => {
      value.resources.taskId = 'acceptance@example.com';
    },
    (value) => {
      value.resources.taskId = 'verification code 123456';
    },
    (value) => {
      value.resources.taskId = `s1.${'A'.repeat(43)}`;
    },
    (value) => {
      value.resources.taskId = `re_${'A'.repeat(32)}`;
    },
  ]) {
    const changed = browserFailureEvidence();
    mutate(changed);
    assert.throws(
      () => validateLiveBrowserFailureEvidence(changed, testIdentity),
      /unsafe live browser failure/,
    );
  }
});

test('live-browser failure CLI rejects a mismatched workflow attempt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'combo-live-browser-failure-'));
  const evidencePath = join(directory, 'evidence.json');
  const identityPath = join(directory, 'identity.json');
  const changedIdentityPath = join(directory, 'changed-identity.json');
  const validator = fileURLToPath(new URL('./promotion-evidence.mjs', import.meta.url));
  try {
    writeFileSync(evidencePath, `${JSON.stringify(browserFailureEvidence())}\n`, {
      mode: 0o600,
    });
    writeFileSync(identityPath, `${JSON.stringify(testIdentity)}\n`, { mode: 0o600 });
    writeFileSync(
      changedIdentityPath,
      `${JSON.stringify({ ...testIdentity, deploymentRunAttempt: 3 })}\n`,
      { mode: 0o600 },
    );
    const validate = (selectedIdentity) =>
      execFileSync(
        process.execPath,
        [
          validator,
          'validate-live-browser-failure',
          '--environment',
          'test',
          '--evidence',
          evidencePath,
          '--identity',
          selectedIdentity,
        ],
        { encoding: 'utf8' },
      ).trim();
    const exactAttemptDigest = validate(identityPath);
    assert.match(exactAttemptDigest, /^sha256:[0-9a-f]{64}$/);
    assert.throws(() => validate(changedIdentityPath), /locked deployment/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Production live-browser admission and workflow attestation bind exact run and evidence', () => {
  const browser = browserEvidence('production');
  assert.deepEqual(validateLiveBrowserEvidence(browser, productionIdentity, 'production'), browser);
  assert.throws(() => validateLiveBrowserEvidence(browser, productionIdentity, 'preview'));
  const context = {
    repository: 'dangdang-tech/Combo',
    actor: 'release-operator',
    workflowRunId: 606,
    workflowRunAttempt: 2,
    acceptedAt: '2026-07-25T00:12:00.000Z',
  };
  const attestation = createLiveBrowserAcceptanceAttestation(browser, productionIdentity, context);
  assert.deepEqual(
    validateLiveBrowserAcceptanceAttestation(attestation, browser, productionIdentity, {
      repository: context.repository,
      workflowRunId: context.workflowRunId,
      workflowRunAttempt: context.workflowRunAttempt,
    }),
    attestation,
  );
  const tampered = structuredClone(browser);
  tampered.checks[0].durationMs += 1;
  assert.throws(() =>
    validateLiveBrowserAcceptanceAttestation(attestation, tampered, productionIdentity, {
      repository: context.repository,
      workflowRunId: context.workflowRunId,
      workflowRunAttempt: context.workflowRunAttempt,
    }),
  );
});

test('release workflows bundle and consume only the controlled admission implementation', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const preview = readFileSync(
    new URL('../.github/workflows/preview.yml', import.meta.url),
    'utf8',
  );
  const production = readFileSync(new URL('../.github/workflows/cd.yml', import.meta.url), 'utf8');
  const testDeployment = readFileSync(
    new URL('../.github/workflows/combo-dev.yml', import.meta.url),
    'utf8',
  );
  const collector = readFileSync(
    new URL('./collect-release-inventory.sh', import.meta.url),
    'utf8',
  );

  for (const path of [
    'scripts/collect-release-inventory.sh',
    'scripts/collect-live-runtime-evidence.sh',
    'scripts/foundation-reset-journal.mjs',
    'scripts/promotion-evidence.mjs',
    'scripts/prepare-reset-roll-forward.sh',
    'scripts/recover-preview-post-cut.sh',
    'scripts/reset-roll-forward-journal.mjs',
    'scripts/release-nginx-route.mjs',
    'scripts/reset-release-foundation.sh',
    'scripts/rollback-release-traffic.sh',
    'scripts/verify-release-schema.mjs',
    'acceptance/live-browser-acceptance.mjs',
    'acceptance/resend-sent-email.mjs',
    'acceptance/playwright-core.tgz',
  ]) {
    assert.match(ci, new RegExp(path.replaceAll('.', '\\.').replaceAll('/', '\\/')));
  }
  assert.match(ci, /sha256sum -c metadata\/artifact-files\.sha256/);
  const recoveryJobStart = preview.indexOf('\n  recover_preview:');
  const recoveryStepStart = preview.indexOf('- name: Recover the exact foreign Preview checkpoint');
  const deployJobStart = preview.indexOf('\n  deploy:');
  const candidateGateStart = preview.indexOf(
    '- name: Revalidate all frozen admissions immediately before the first Preview mutation',
  );
  const candidateDeployStart = preview.indexOf(
    '- name: Upload and deploy the exact Preview bundle',
  );
  const remoteEvidenceStart = preview.indexOf(
    '- name: Fetch and validate the tecent2 Preview evidence',
  );
  assert.ok(recoveryJobStart > 0);
  assert.ok(recoveryStepStart > recoveryJobStart);
  assert.ok(deployJobStart > recoveryStepStart);
  assert.ok(candidateGateStart > deployJobStart);
  assert.ok(candidateDeployStart > candidateGateStart);
  assert.ok(remoteEvidenceStart > candidateDeployStart);
  assert.match(
    preview.slice(deployJobStart, candidateGateStart),
    /needs: \[policy, recover_preview\]/,
  );

  const recoveryStep = preview.slice(recoveryStepStart, deployJobStart);
  const candidateGate = preview.slice(candidateGateStart, candidateDeployStart);
  const candidateDeploy = preview.slice(candidateDeployStart, remoteEvidenceStart);
  const recoveryHelper = 'bash "$work/scripts/recover-preview-post-cut.sh"';
  assert.equal(recoveryStep.split(recoveryHelper).length - 1, 1);
  assert.match(recoveryStep, /sha256sum -c metadata\/artifact-files\.sha256/);
  assert.match(recoveryStep, /--candidate-source-sha "\$revision"/);
  assert.doesNotMatch(recoveryStep, /bash "\$work\/scripts\/reset-release-foundation\.sh"/);
  assert.doesNotMatch(recoveryStep, /bash "\$work\/scripts\/deploy-release\.sh"/);
  assert.doesNotMatch(candidateDeploy, /recover-preview-post-cut/);
  assert.doesNotMatch(preview, /actions\/variables\/COMBO_PREVIEW_AUTO_PROMOTION_MODE/);

  for (const admission of [recoveryStep, candidateGate, candidateDeploy]) {
    assert.match(admission, /ADMISSION_MODE: \$\{\{ vars\.COMBO_PREVIEW_AUTO_PROMOTION_MODE \}\}/);
    assert.match(admission, /\[\[ "\$ADMISSION_MODE" == enabled \]\]/);
    assert.match(admission, /git\/ref\/heads\/main/);
    assert.match(admission, /actions\/runs\/\$\{SOURCE_RUN_ID\}/);
    assert.match(admission, /actions\/artifacts\/\$\{SOURCE_ARTIFACT_ID\}/);
    assert.match(admission, /\.run_attempt == \$runAttempt/);
    assert.match(admission, /\.name == "Main CD"/);
    assert.match(admission, /\.path == "\.github\/workflows\/ci\.yml"/);
    assert.match(admission, /\.event == "push"/);
    assert.match(admission, /\.head_branch == "main"/);
    assert.match(admission, /\.head_sha == \$revision/);
    assert.match(admission, /\.conclusion == "success"/);
    assert.match(admission, /\.repository\.full_name == \$repository/);
    assert.match(admission, /\.head_repository\.full_name == \$repository/);
    assert.match(admission, /\.id == \$artifactId/);
    assert.match(admission, /\.digest == \$digest/);
    assert.match(admission, /\.expired == false/);
    assert.match(
      admission,
      /"combo-release-" \+ \$revision \+ "-" \+ \(\$runAttempt \| tostring\)/,
    );
  }
  for (const admission of [candidateGate, candidateDeploy]) {
    assert.match(admission, /FOUNDATION_RESET_SHA/);
    assert.match(admission, /"\$FOUNDATION_RESET_SHA" == "\$REVISION"/);
  }
  for (const admission of [recoveryStep, candidateDeploy]) {
    const sourceRun = admission.indexOf(
      '"repos/${GITHUB_REPOSITORY}/actions/runs/${SOURCE_RUN_ID}"',
    );
    const sourceArtifact = admission.indexOf(
      '"repos/${GITHUB_REPOSITORY}/actions/artifacts/${SOURCE_ARTIFACT_ID}"',
    );
    const liveMain = admission.indexOf('"repos/${GITHUB_REPOSITORY}/git/ref/heads/main"');
    assert.ok(sourceRun > 0 && sourceArtifact > sourceRun && liveMain > sourceArtifact);
  }
  const recoveryUpload = recoveryStep.indexOf(
    'ssh release-target mv -fT -- "$temporary" "$remote"',
  );
  const recoveryFinalAuthority = recoveryStep.indexOf(
    'revalidate_recovery_authority',
    recoveryUpload,
  );
  const recoverySsh = recoveryStep.indexOf('ssh release-target bash -s --', recoveryFinalAuthority);
  assert.ok(
    recoveryUpload > 0 &&
      recoveryFinalAuthority > recoveryUpload &&
      recoverySsh > recoveryFinalAuthority,
  );
  assert.doesNotMatch(recoveryStep.slice(recoverySsh), /GH_TOKEN/);

  const remoteUpload = candidateDeploy.indexOf(
    'ssh release-target mv -fT -- "$temporary" "$remote"',
  );
  const finalAuthority = candidateDeploy.indexOf('revalidate_deployment_authority', remoteUpload);
  const candidateSsh = candidateDeploy.indexOf('ssh release-target bash -s --', finalAuthority);
  assert.ok(remoteUpload > 0 && finalAuthority > remoteUpload && candidateSsh > finalAuthority);
  const candidateRemote = candidateDeploy.slice(candidateSsh);
  const checksum = candidateRemote.indexOf('sha256sum -c metadata/artifact-files.sha256');
  const previewReset = candidateRemote.indexOf('bash "$work/scripts/reset-release-foundation.sh"');
  const previewDeploy = candidateRemote.indexOf('bash "$work/scripts/deploy-release.sh"');
  assert.ok(checksum > 0 && previewReset > checksum && previewDeploy > previewReset);
  assert.equal(
    [...candidateRemote.matchAll(/bash "\$work\/scripts\/reset-release-foundation\.sh"/g)].length,
    2,
  );
  assert.equal(
    [...candidateRemote.matchAll(/bash "\$work\/scripts\/deploy-release\.sh"/g)].length,
    1,
  );
  assert.doesNotMatch(candidateRemote, /GH_TOKEN/);
  assert.doesNotMatch(production, /recover-preview-post-cut/);
  assert.match(
    production,
    /\[\[ "\$foundation_reset" == false \]\][\s\S]*\[\[ "\$foundation_policy" == reuse-existing-v1 \]\][\s\S]*pending_phase=\$\(jq -er '\.phase' "\$pending_checkpoint"\)[\s\S]*\[\[ "\$pending_phase" == post-cut \|\| "\$pending_phase" == finalizing \]\][\s\S]*\[\[ "\$pending_reset_digest" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\][\s\S]*\[\[ -z "\$existing_bundle" \]\][\s\S]*\[\[ ! -e "\$reset_output" && ! -L "\$reset_output" \]\][\s\S]*prepare-reset-roll-forward\.sh/,
    'a foreign clean-slate boundary must retain every reuse-only guard before the controlled roll-forward journal',
  );
  assert.match(
    ci,
    /combo-image-digest-\$\{\{ env\.SOURCE_SHA \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.key \}\}/,
  );
  assert.match(
    ci,
    /pattern: combo-image-digest-\$\{\{ env\.SOURCE_SHA \}\}-\$\{\{ github\.run_attempt \}\}-\*/,
  );
  assert.match(ci, /name=combo-release-%s-%s[\s\S]*"\$SOURCE_SHA" "\$GITHUB_RUN_ATTEMPT"/);
  assert.match(
    testDeployment,
    /^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}pull_request_number:/m,
  );
  assert.doesNotMatch(testDeployment, /^ {2}workflow_run:/m);
  assert.match(
    testDeployment,
    /Test PR #\$\{\{ inputs\.pull_request_number \}\} deployment request/,
  );
  assert.match(
    testDeployment,
    /INPUT_PULL_REQUEST_NUMBER: \$\{\{ inputs\.pull_request_number \}\}/,
  );
  assert.match(
    testDeployment,
    /\.state == "open"[\s\S]*\.base\.ref == "main"[\s\S]*\.base\.sha == \$controller[\s\S]*\.head\.repo\.id == \$repositoryId[\s\S]*\.head\.sha == \$revision/,
  );
  assert.match(
    testDeployment,
    /\.merge_base_commit\.sha == \$controller[\s\S]*\.status == "ahead" or \.status == "identical"/,
  );
  assert.match(
    testDeployment,
    /artifact_name="combo-release-\$\{REVISION\}-\$\{SOURCE_CI_RUN_ATTEMPT\}"/,
  );
  assert.match(
    testDeployment,
    /evidence_artifact_name="combo-branch-test-evidence-\$\{REVISION\}-\$\{RUN_ATTEMPT\}"/,
  );
  assert.match(testDeployment, /name: \$\{\{ steps\.evidence\.outputs\.artifact_name \}\}/);
  assert.match(testDeployment, /sourceWorkflow: \$sourceWorkflow/);
  assert.match(testDeployment, /sourceEvent: \$sourceEvent/);
  assert.match(testDeployment, /sourceBranch: \$sourceBranch/);
  assert.match(testDeployment, /sourceConclusion: \$sourceConclusion/);
  assert.match(testDeployment, /controllerSha: \$controllerSha/);
  assert.match(testDeployment, /sourceMode: \$sourceMode/);
  assert.match(testDeployment, /source_conclusion=release-job-success/);
  assert.match(testDeployment, /\.sourceConclusion == \$sourceConclusion/);
  assert.match(testDeployment, /\.controllerSha == \$controllerSha/);
  assert.match(testDeployment, /\.sourceMode == \$sourceMode/);
  assert.match(
    testDeployment,
    /\[\[ "\$SOURCE_EVENT" == workflow_dispatch \]\][\s\S]*\[\[ "\$SOURCE_MODE" == branch-build \]\][\s\S]*\[\[ "\$SOURCE_WORKFLOW" == \.github\/workflows\/combo-dev\.yml \]\]/,
  );
  assert.doesNotMatch(testDeployment, /main-ci/);
  assert.match(
    testDeployment,
    /git\/ref\/heads\/main"[\s\\\n]*--jq '\.object\.sha'\)" == "\$CONTROLLER_SHA"/,
  );
  assert.match(
    testDeployment,
    /build_branch_release:[\s\S]*uses: \.\/\.github\/workflows\/ci\.yml[\s\S]*publish_release: true/,
  );
  assert.match(
    testDeployment,
    /Check out the trusted main Test controller[\s\S]*ref: \$\{\{ needs\.authorize\.outputs\.controller_sha \}\}/,
  );
  const testPrivilegedDeploy = testDeployment.slice(testDeployment.indexOf('\n  deploy:'));
  assert.doesNotMatch(testPrivilegedDeploy, /\$RELEASE_ROOT\/(?:scripts|acceptance|infra)\//);
  assert.match(testPrivilegedDeploy, /runner=scripts\/goal-b-test-acceptance\.mjs/);
  assert.match(testPrivilegedDeploy, /validator=scripts\/promotion-evidence\.mjs/);
  assert.match(production, /source_artifact_name=%s[\s\S]*\.sourceArtifactName/);
  assert.match(production, /"combo-release-\$\{REVISION\}-\$\{SOURCE_CI_RUN_ATTEMPT\}"/);
  assert.match(production, /--arg name "\$SOURCE_ARTIFACT_NAME"/);

  for (const contract of [
    'validate-live-browser',
    'validate-live-runtime',
    'validate-inventory',
    'source_run_attempt',
    'browserAcceptanceDigest',
    'resourceInventoryDigest',
    'preview-current-checkpoint.json',
    'actions/artifacts/${SOURCE_ARTIFACT_ID}/zip',
  ]) {
    assert.match(preview, new RegExp(contract.replaceAll('$', '\\$')));
  }
  assert.doesNotMatch(
    preview,
    /CLOUD_REVIEW_ACCESS_TOKEN|COMBO_REVIEW_ACCESS_TOKEN|REVIEW_ACCESS_TOKEN/,
  );
  assert.doesNotMatch(preview, /actions\/download-artifact/);
  assert.match(preview, /sha256sum "\$archive"/);
  assert.match(
    preview,
    /actions\/runs\/\$\{SOURCE_RUN_ID\}\/attempts\/\$\{SOURCE_RUN_ATTEMPT\}\/jobs\?per_page=100/,
  );
  assert.match(preview, /\.name == "assemble immutable release artifact"/);
  assert.match(preview, /\$releaseJobs\[0\]\.started_at <= \$artifactCreatedAt/);
  assert.match(preview, /\$artifactCreatedAt <= \$releaseJobs\[0\]\.completed_at/);
  assert.match(
    preview,
    /^ {2}workflow_run:\n {4}workflows: \[Main CD\]\n {4}types: \[completed\]\n {4}branches: \[main\]/m,
  );
  assert.match(preview, /if: github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(preview, /artifact_name="combo-release-\$\{REVISION\}-\$\{SOURCE_RUN_ATTEMPT\}"/);
  assert.match(
    preview,
    /Download the exact release artifact and verify its GitHub digest[\s\S]*actions\/artifacts\/\$\{SOURCE_ARTIFACT_ID\}\/zip[\s\S]*== "\$SOURCE_ARTIFACT_DIGEST"/,
  );
  assert.match(
    preview,
    /\.name == "Main CD"[\s\S]*\.event == "push"[\s\S]*\.head_branch == "main"/,
  );
  assert.doesNotMatch(
    preview,
    /combo-dev\.yml|test_admission|combo-test-evidence|\bTEST_(?:RUN|EVIDENCE|IDENTITY|BROWSER|SOURCE|DEPLOYMENT)|\btest(?:Run|Evidence|Identity|Browser|Source|Deployment)/,
  );
  const previewEvidenceRecordStart = preview.indexOf('- name: Create Preview promotion evidence');
  const previewEvidenceRecordEnd = preview.indexOf(
    '\n      - name:',
    previewEvidenceRecordStart + 1,
  );
  const previewEvidenceRecord = preview.slice(previewEvidenceRecordStart, previewEvidenceRecordEnd);
  assert.ok(
    previewEvidenceRecordStart >= 0 && previewEvidenceRecordEnd > previewEvidenceRecordStart,
  );
  assert.match(previewEvidenceRecord, /schemaVersion: 5/);
  assert.match(previewEvidenceRecord, /sourceArtifactDigest: \$sourceArtifactDigest/);
  assert.doesNotMatch(previewEvidenceRecord, /\btest[A-Z][A-Za-z0-9_]*/);
  const previewCompletedReleaseCheck = preview.indexOf(
    'release_directory="$HOME/data/combo-releases/goal-a/preview/release-${revision}"',
  );
  const previewFoundationReset = preview.indexOf(
    'bash "$work/scripts/reset-release-foundation.sh"',
  );
  assert.ok(
    previewCompletedReleaseCheck >= 0 && previewFoundationReset > previewCompletedReleaseCheck,
    'Preview must bind completed evidence before invoking the destructive reset helper',
  );
  assert.match(
    preview.slice(previewCompletedReleaseCheck, previewFoundationReset),
    /pending_checkpoint="\$HOME\/data\/combo-releases\/goal-a\/preview\/pending\.json"[\s\S]*sha256sum --quiet -c SHA256SUMS[\s\S]*foundation-reset-evidence\.json[\s\S]*foundationResetEvidenceDigest[\s\S]*\.schemaVersion == 3[\s\S]*pending_reset_digest/,
  );
  assert.match(
    preview,
    /ssh release-target bash -s -- "\$REVISION" "\$FOUNDATION_RESET"[\s\S]*files\+=\(foundation-reset-evidence\.json\)/,
  );
  assert.match(
    preview,
    /reset_digest=\$\(sha256sum "\$evidence_dir\/foundation-reset-evidence\.json"[\s\S]*\.foundationResetEvidenceDigest/,
  );

  for (const contract of [
    'preview_run_attempt:',
    'preview_evidence_artifact_id:',
    'validate-preview-browser',
    'validate-inventory',
    'validate-identity',
    'validate-live-runtime',
    'production-resource-inventory.json',
    'production-live-runtime.json',
    'actions/artifacts/${ARTIFACT_ID}/zip',
    'actions/artifacts/${SOURCE_ARTIFACT_ID}/zip',
    'https://buildwithcombo.com',
    'attest-live-browser',
    'validate-live-attestation',
    '--defer-cleanup',
    '--finalize',
    '--rollback',
  ]) {
    assert.match(production, new RegExp(contract.replaceAll('$', '\\$')));
  }
  assert.doesNotMatch(production, /actions\/download-artifact/);
  assert.match(production, /preview_run\.run_attempt|\.run_attempt == \$runAttempt/);
  assert.match(
    production,
    /--arg name "combo-preview-promotion-\$\{REVISION\}-\$\{PREVIEW_RUN_ATTEMPT\}"/,
  );
  assert.match(
    preview,
    /name: combo-preview-promotion-\$\{\{ needs\.policy\.outputs\.revision \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(
    production,
    /name: combo-production-deployment-\$\{\{ needs\.resolve\.outputs\.revision \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(production, /sha256sum "\$archive"/);
  assert.match(
    production,
    /actions\/runs\/\$\{PREVIEW_RUN_ID\}\/attempts\/\$\{PREVIEW_RUN_ATTEMPT\}\/jobs\?per_page=100/,
  );
  assert.match(production, /\.name == "deploy the main release artifact to Preview"/);
  assert.match(production, /\$uploadJobs\[0\]\.started_at <= \$artifactCreatedAt/);
  assert.match(production, /\$artifactCreatedAt <= \$uploadJobs\[0\]\.completed_at/);
  const productionReleaseDownloadStart = production.indexOf(
    '- name: Download the exact release artifact that passed Preview',
  );
  const productionReleaseProofStart = production.indexOf(
    '- name: Prove artifact and digest equality with Preview',
  );
  const productionReleaseProofEnd = production.indexOf(
    '\n      - name:',
    productionReleaseProofStart + 1,
  );
  assert.ok(
    productionReleaseDownloadStart >= 0 &&
      productionReleaseProofStart > productionReleaseDownloadStart &&
      productionReleaseProofEnd > productionReleaseProofStart,
  );
  const productionReleaseDownload = production.slice(
    productionReleaseDownloadStart,
    productionReleaseProofStart,
  );
  const productionReleaseProof = production.slice(
    productionReleaseProofStart,
    productionReleaseProofEnd,
  );
  assert.match(
    production,
    /printf 'source_artifact_digest=%s\\n'[\s\S]*jq -er '\.sourceArtifactDigest' "\$EVIDENCE"/,
  );
  assert.match(
    productionReleaseDownload,
    /SOURCE_ARTIFACT_DIGEST: \$\{\{ steps\.evidence\.outputs\.source_artifact_digest \}\}/,
  );
  assert.match(productionReleaseDownload, /\.digest == \$digest/);
  assert.match(
    productionReleaseDownload,
    /sha256sum "\$archive"[\s\S]*== "\$SOURCE_ARTIFACT_DIGEST"/,
  );
  assert.match(productionReleaseProof, /\.releaseManifestDigest[\s\S]*\.artifactFileSetDigest/);
  assert.match(production, /\.schemaVersion == 5/);
  assert.match(production, /schemaVersion: 5/);
  assert.doesNotMatch(
    production,
    /\bTEST_(?:RUN|EVIDENCE|IDENTITY|BROWSER|SOURCE|DEPLOYMENT)|\btest(?:Run|Evidence|Identity|Browser|Source|Deployment)/,
  );
  const productionCompletedReleaseCheck = production.indexOf(
    'release_directory="$HOME/data/combo-releases/goal-a/production/release-${revision}"',
  );
  const productionFoundationReset = production.indexOf(
    'bash "$work/scripts/reset-release-foundation.sh"',
  );
  assert.ok(
    productionCompletedReleaseCheck >= 0 &&
      productionFoundationReset > productionCompletedReleaseCheck,
    'Production must bind completed or activation evidence before invoking reset',
  );
  assert.match(
    production.slice(productionCompletedReleaseCheck, productionFoundationReset),
    /activation_directory="\$\{release_directory\}\.activation"[\s\S]*pending_checkpoint="\$HOME\/data\/combo-releases\/goal-a\/production\/pending\.json"[\s\S]*\.schemaVersion == 3[\s\S]*pending_reset_digest[\s\S]*sha256sum --quiet -c SHA256SUMS[\s\S]*foundation-reset-evidence\.json/,
  );
  assert.match(
    production,
    /if \[\[ -e "\$foundation_reset_evidence" \|\|[\s\S]*foundation-reset-journal\.mjs" audit[\s\S]*--mode deploy-reset[\s\S]*--evidence "\$foundation_reset_evidence"[\s\S]*else[\s\S]*bash "\$work\/scripts\/reset-release-foundation\.sh"/,
  );
  assert.match(
    production,
    /if \[\[ -e "\$reset_output" \|\| -L "\$reset_output" \]\]; then[\s\S]*cmp -s "\$reset_output" "\$foundation_reset_evidence"/,
  );
  const previewEvidenceStart = production.indexOf(
    'Validate Preview evidence and its source main CI run',
  );
  const previewEvidenceEnd = production.indexOf('\n      - name:', previewEvidenceStart + 1);
  const previewEvidenceValidation = production.slice(previewEvidenceStart, previewEvidenceEnd);
  assert.match(previewEvidenceValidation, /if \.foundationMode == "reset" then/);
  assert.match(previewEvidenceValidation, /\.foundationReset\.authorityDigest == \.manifestDigest/);
  assert.doesNotMatch(previewEvidenceValidation, /--argjson foundationReset/);
  const credentialValidation = production.indexOf(
    'Validate the protected Production Resend reader before mutation',
  );
  const sshConfiguration = production.indexOf('Configure the existing deployment SSH identity');
  assert.ok(
    credentialValidation >= 0 &&
      sshConfiguration > credentialValidation &&
      sshConfiguration < production.indexOf('Upload and activate the exact Production bundle'),
  );
  assert.match(
    production.slice(credentialValidation, sshConfiguration),
    /resend-sent-email\.mjs[\s\S]*--validate-key/,
  );
  const previewLiveRecheck = production.indexOf(
    'Recollect and validate current Preview live runtime before mutation',
  );
  const productionActivation = production.indexOf(
    'Upload and activate the exact Production bundle with rollback retained',
  );
  assert.ok(previewLiveRecheck >= 0 && previewLiveRecheck < productionActivation);
  assert.match(
    production.slice(previewLiveRecheck, productionActivation),
    /collect-live-runtime-evidence\.sh[\s\S]*--environment preview[\s\S]*validate-live-runtime/,
  );
  assert.match(production, /previewLiveRuntimeRecheckDigest/);
  assert.match(
    production,
    /if: \$\{\{ \(failure\(\) \|\| cancelled\(\)\) && steps\.activation\.outputs\.attempted == 'true' && steps\.activation_evidence\.outputs\.finalized != 'true' && steps\.finalize\.outcome != 'success' && needs\.resolve\.outputs\.foundation_reset != 'true' \}\}/,
  );
  assert.match(
    production,
    /if: \$\{\{ \(failure\(\) \|\| cancelled\(\)\) && steps\.activation\.outputs\.attempted == 'true' && steps\.activation_evidence\.outputs\.finalized != 'true' && steps\.finalize\.outcome != 'success' && \(needs\.resolve\.outputs\.foundation_reset == 'true' \|\| steps\.recovery\.outputs\.roll_forward_only == 'true'\) \}\}/,
  );
  assert.match(production, /prepare-reset-roll-forward\.sh[\s\S]*--reset-roll-forward-evidence/);
  assert.match(production, /reset-roll-forward-evidence\.json[\s\S]*roll_forward_only=true/);
  assert.match(
    production,
    /Fetch and validate pending or finalized Production evidence[\s\S]*finalized="\$HOME\/data\/combo-releases\/goal-a\/production\/release-\$\{revision\}"[\s\S]*if \[\[ -d "\$finalized" && ! -L "\$finalized" \]\]/,
  );
  assert.match(
    production,
    /Run the exact-bundle Production email OTP and six-area browser acceptance[\s\S]*if: steps\.activation_evidence\.outputs\.finalized != 'true'/,
  );
  assert.match(
    production,
    /Generate and validate the workflow-owned Production acceptance attestation[\s\S]*if: steps\.activation_evidence\.outputs\.finalized != 'true'/,
  );
  assert.match(
    production,
    /Revalidate candidate and finalize the accepted Production release[\s\S]*if: steps\.activation_evidence\.outputs\.finalized != 'true'/,
  );
  assert.match(
    production,
    /Select and revalidate the immutable Production acceptance[\s\S]*FINALIZED_BROWSER_DIGEST:[\s\S]*FINALIZED_ATTESTATION_DIGEST:/,
  );
  assert.match(
    production,
    /production-recovery\.\$\{RUN_ID\}\.\$\{RUN_ATTEMPT\}\.acceptance\.json[\s\S]*--acceptance-evidence "\$acceptance"/,
  );
  assert.match(
    production,
    /production-recovery\.\$\{RUN_ID\}\.\$\{RUN_ATTEMPT\}\.identity\.json[\s\S]*--promotion-identity "\$identity"/,
  );
  assert.match(
    production,
    /has_acceptance_bundle=0[\s\S]*"\$ATTESTATION_DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$[\s\S]*has_acceptance_bundle=1/,
  );
  assert.match(production, /clean-slate schema boundary[\s\S]*roll-forward/);
  assert.match(production, /production-rollback\.\$\{RUN_ID\}\.\$\{RUN_ATTEMPT\}[\s\S]*--rollback/);
  for (const evidence of [
    'activationEvidenceDigest',
    'productionBrowserAcceptanceDigest',
    'acceptanceAttestationDigest',
    'production-browser-acceptance.json',
    'production-acceptance-attestation.json',
    'acceptance-evidence.json',
    'promotion-identity.json',
    'foundation-reset-evidence.json',
    'traffic-seal-evidence.json',
  ]) {
    assert.match(production, new RegExp(evidence.replaceAll('.', '\\.')));
  }
  for (const workflow of [preview, production]) {
    assert.doesNotMatch(workflow, /\[\[ -s "\$HOME\/\.nvm\/nvm\.sh" \]\]/);
    assert.match(
      workflow,
      /\[\[ -f "\$HOME\/\.nvm\/nvm\.sh" && ! -L "\$HOME\/\.nvm\/nvm\.sh" &&\s+-s "\$HOME\/\.nvm\/nvm\.sh" \]\]/,
    );
  }

  for (const resource of [
    'deployments.apps',
    'statefulsets.apps',
    'jobs.batch',
    'services',
    'ingresses.networking.k8s.io',
    'persistentvolumeclaims',
    'persistentvolumes',
    'cronjobs.batch',
    'daemonsets.apps',
    'networkpolicies.networking.k8s.io',
    'roles.rbac.authorization.k8s.io',
    'rolebindings.rbac.authorization.k8s.io',
    'clusterrolebindings.rbac.authorization.k8s.io',
    'serviceaccounts',
  ]) {
    assert.match(collector, new RegExp(resource.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(collector, /get ["']?secrets?(?:["'\s]|$)/i);
  assert.match(collector, /\^\(api\|runtime\|web\|worker\)-/);
  assert.match(
    collector,
    /\.metadata\.annotations\["combo\.build\/source-sha"\]\s+\/\/ \.spec\.template\.metadata\.annotations\["combo\.build\/source-sha"\]/,
  );
  assert.equal(
    existsSync(new URL('../.github/workflows/environment-acceptance.yml', import.meta.url)),
    false,
  );
  assert.doesNotMatch(`${preview}\n${production}`, /evidence_json/);
});

test('completed Production reset evidence is audited and never invokes reset again', () => {
  const production = readFileSync(new URL('../.github/workflows/cd.yml', import.meta.url), 'utf8');
  const startMarker =
    '          if [[ "$foundation_reset" == true ]]; then\n' +
    '            if [[ -e "$foundation_reset_evidence" ||';
  const start = production.indexOf(startMarker);
  const end = production.indexOf('          else\n            reuse_admission_args=()', start);
  assert.ok(start >= 0 && end > start);
  const decision = `${production.slice(start, end)}          fi\n`;

  const directory = mkdtempSync(join(tmpdir(), 'production-reset-workflow-decision-'));
  try {
    const harness = join(directory, 'harness.sh');
    const evidence = join(directory, 'foundation-reset-evidence.json');
    const resetOutput = evidence;
    const log = join(directory, 'commands.log');
    const work = join(directory, 'work');
    const sourceSha = 'a'.repeat(40);
    const manifestDigest = digest('b');
    writeFileSync(
      harness,
      `#!/usr/bin/env bash
set -euo pipefail
foundation_reset=true
foundation_reset_evidence=${JSON.stringify(evidence)}
reset_output=${JSON.stringify(resetOutput)}
work=${JSON.stringify(work)}
revision=${JSON.stringify(sourceSha)}
manifest_digest=${JSON.stringify(manifestDigest)}
authority_digest=${JSON.stringify(manifestDigest)}
reset_request_id=${JSON.stringify(digest('c'))}
command_log=${JSON.stringify(log)}
node() {
  printf 'node %s\\n' "$*" >>"$command_log"
}
bash() {
  printf 'bash %s\\n' "$*" >>"$command_log"
  printf '{"status":"passed"}\\n' >"$reset_output"
}
${decision}
`,
    );

    writeFileSync(evidence, '{"status":"passed"}\n');
    const retry = spawnSync('bash', [harness], { encoding: 'utf8' });
    assert.equal(retry.status, 0, retry.stderr);
    const retryLog = readFileSync(log, 'utf8');
    assert.match(retryLog, /foundation-reset-journal\.mjs audit/);
    assert.match(retryLog, /--mode deploy-reset/);
    assert.match(retryLog, new RegExp(`--source-sha ${sourceSha}`));
    assert.match(retryLog, new RegExp(`--manifest-digest ${manifestDigest}`));
    assert.doesNotMatch(retryLog, /reset-release-foundation\.sh/);

    rmSync(evidence);
    rmSync(log);
    const first = spawnSync('bash', [harness], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(readFileSync(log, 'utf8'), /reset-release-foundation\.sh/);
    assert.equal(readFileSync(resetOutput, 'utf8'), '{"status":"passed"}\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
