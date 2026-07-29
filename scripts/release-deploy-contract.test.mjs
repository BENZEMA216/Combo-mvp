import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_FILE = resolve(ROOT, 'scripts/deploy-release.sh');
const DEPLOY = readFileSync(DEPLOY_FILE, 'utf8');
const ROLLBACK = readFileSync(resolve(ROOT, 'scripts/rollback-release-traffic.sh'), 'utf8');

function indexOf(pattern, label = String(pattern)) {
  const match = DEPLOY.match(pattern);
  assert.ok(match, `deploy-release.sh must contain ${label}`);
  return match.index;
}

function textIndexOf(text, pattern, label = String(pattern)) {
  const match = text.match(pattern);
  assert.ok(match, `text must contain ${label}`);
  return match.index;
}

function assertBefore(first, second, message) {
  const firstIndex = typeof first === 'number' ? first : indexOf(first);
  const secondIndex = typeof second === 'number' ? second : indexOf(second);
  assert.ok(firstIndex < secondIndex, message);
}

function functionBody(name) {
  const start = indexOf(new RegExp(`(?:^|\\n)${name}\\(\\)\\s*\\{`), `${name}()`);
  const nextFunction = DEPLOY.slice(start + 1).search(/\n[a-zA-Z_][a-zA-Z0-9_]*\(\)\s*\{/);
  return nextFunction < 0 ? DEPLOY.slice(start) : DEPLOY.slice(start, start + 1 + nextFunction);
}

function cleanupPlanValidator(functionName, inputVariable) {
  const body = functionBody(functionName);
  const startMarker = '--arg init "$INIT_JOB" \'';
  const start = body.lastIndexOf(startMarker);
  assert.ok(start >= 0, `${functionName} must pass the init Job to its jq validator`);
  const programStart = start + startMarker.length;
  const endMarker = `\n    ' "$${inputVariable}" >/dev/null`;
  const end = body.indexOf(endMarker, programStart);
  assert.ok(end > programStart, `${functionName} must execute its embedded jq validator`);
  return body.slice(programStart, end);
}

function runCleanupPlanValidator(filter, plan, identity) {
  return spawnSync(
    'jq',
    [
      '-e',
      '--arg',
      'environment',
      identity.environment,
      '--arg',
      'namespace',
      identity.namespace,
      '--arg',
      'sourceSha',
      identity.sourceSha,
      '--arg',
      'releaseId',
      identity.releaseId,
      '--arg',
      'manifestDigest',
      identity.manifestDigest,
      '--arg',
      'prefix',
      identity.prefix,
      '--arg',
      'metadata',
      identity.metadata,
      '--arg',
      'init',
      identity.init,
      filter,
    ],
    {
      encoding: 'utf8',
      input: JSON.stringify(plan),
    },
  );
}

function environmentArm(name) {
  const environmentCase = DEPLOY.slice(indexOf(/case "\$ENVIRONMENT" in/, 'environment dispatch'));
  const match = environmentCase.match(new RegExp(`${name}\\)([\\s\\S]*?);;`));
  assert.ok(match, `deploy-release.sh must define the ${name} environment`);
  return match[1];
}

function validateCapturedJobOwnership(jobs) {
  const work = mkdtempSync(join(tmpdir(), 'combo-release-job-ownership-'));
  try {
    const emptyInventory = join(work, 'empty.json');
    const jobInventory = join(work, 'jobs.json');
    writeFileSync(emptyInventory, JSON.stringify({ items: [] }));
    writeFileSync(jobInventory, JSON.stringify({ items: jobs }));
    const harness = `
set -euo pipefail
FOUNDATION_TRACK=preview-v1
inventory_deployments=${JSON.stringify(emptyInventory)}
inventory_statefulsets=${JSON.stringify(emptyInventory)}
inventory_jobs=${JSON.stringify(jobInventory)}
inventory_services=${JSON.stringify(emptyInventory)}
inventory_configmaps=${JSON.stringify(emptyInventory)}
fail() { return 1; }
${functionBody('validate_captured_release_ownership')}
validate_captured_release_ownership
`;
    return spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('fresh deploy exposes only the disposable-data interface for Preview and Production', () => {
  for (const option of [
    '--environment',
    '--fresh-reset',
    '--manifest',
    '--manifest-digest',
    '--migrations',
    '--foundation-yaml',
    '--init-yaml',
    '--migrate-yaml',
    '--apps-yaml',
    '--web-assets',
  ]) {
    assert.match(DEPLOY, new RegExp(option.replaceAll('-', '\\-')));
  }

  const preview = environmentArm('preview');
  const production = environmentArm('production');
  assert.match(preview, /NAMESPACE=combo-review/);
  assert.match(production, /NAMESPACE=combo(?:\s|$)/);
  for (const [name, arm] of [
    ['Preview', preview],
    ['Production', production],
  ]) {
    assert.match(arm, /FOUNDATION_YAML/);
    assert.match(arm, /INIT_YAML/);
    assert.match(arm, /requires/i, `${name} must require foundation and init manifests`);
    assert.doesNotMatch(
      arm,
      /\[\[\s+-z\s+"\$(?:FOUNDATION_YAML|INIT_YAML)"/,
      `${name} must not reuse a legacy foundation`,
    );
  }
  assert.match(DEPLOY, /FRESH_RESET[\s\S]*required|requires[\s\S]*--fresh-reset/i);

  const disposableDataPath = [
    functionBody('fresh_reset_release_data'),
    functionBody('apply_foundation'),
    functionBody('run_migration'),
  ].join('\n');
  assert.doesNotMatch(
    disposableDataPath,
    /\bbackup\b|backup[-_]|cosfs|\/lhcos-data|offhost|pg_restore|isolated.{0,20}restore/i,
    'business data remains disposable; host routing rollback files are a separate control-plane concern',
  );
});

test('all local and server-side validation gates precede the first fresh reset mutation', () => {
  const reset = indexOf(
    /\n[ \t]*fresh_reset_release_data(?:\s|$)/,
    'fresh_reset_release_data call',
  );

  for (const [pattern, label] of [
    [/release-manifest\.mjs["']?\s+verify/, 'release manifest digest verification'],
    [/web-asset-manifest\.mjs["']?\s+verify/, 'Web asset manifest digest verification'],
    [/validate_migrations(?:\s|$)/, 'migration list validation'],
    [/secret_has_nonempty_key(?:\s|$)/, 'Secret nonempty key validation'],
    [/validate_rendered_phase\s+foundation/, 'foundation server dry-run verification'],
    [/validate_rendered_phase\s+init/, 'init server dry-run verification'],
    [/validate_rendered_phase\s+migrate/, 'migration server dry-run verification'],
    [/validate_rendered_phase\s+apps/, 'application server dry-run verification'],
  ]) {
    assertBefore(indexOf(pattern, label), reset, `${label} must finish before fresh reset`);
  }

  assert.match(
    DEPLOY,
    /get secret "\$secret"[\s\\\n]*-o "go-template=\{\{if gt \(len \(index \.data/,
    'Secret inspection must emit only a server-side boolean marker',
  );
  assert.doesNotMatch(
    DEPLOY,
    /get secret[^\n]*(?:-o|--output)[ =]?(?:json|yaml|jsonpath)/,
    'Secret values must never be fetched as JSON, YAML, or jsonpath',
  );
});

test('fresh reset is constrained to an exact workload and PVC allowlist', () => {
  const reset = functionBody('fresh_reset_release_data');
  const safeDelete = functionBody('delete_captured_resource');

  for (const workload of [
    'release-postgres',
    'release-redis-queue',
    'release-redis-hot',
    'release-minio',
    'api',
    'worker',
    'runtime',
    'web',
  ]) {
    assert.ok(reset.includes(workload), `fresh reset allowlist must name ${workload}`);
  }
  for (const claim of [
    'data-release-postgres-0',
    'data-release-redis-queue-0',
    'data-release-minio-0',
  ]) {
    assert.ok(reset.includes(claim), `fresh reset PVC allowlist must name ${claim}`);
  }

  assert.match(reset, /delete_captured_resource/);
  assert.match(safeDelete, /preconditions:\s*\{uid: \$uid\}/);
  assert.match(safeDelete, /delete --raw=/);
  assert.doesNotMatch(`${reset}\n${safeDelete}`, /\bdelete\s+(?:namespace|ns)\b/);
  assert.doesNotMatch(`${reset}\n${safeDelete}`, /\bdelete\s+secret\b/);
  assert.doesNotMatch(
    `${reset}\n${safeDelete}`,
    /--all\b|\ball\b.*(?:deployment|statefulset|pvc)/i,
  );
  assert.doesNotMatch(
    reset,
    /\bstatefulset\/(?:postgres|redis-queue|minio)\b|\bpvc\/data-(?:postgres|redis-queue|minio)-0\b/,
    'the legacy plane must remain available until traffic cutover succeeds',
  );
});

test('new release storage is revalidated before initialization and traffic', () => {
  const foundation = functionBody('apply_foundation');
  const inventory = functionBody('capture_inventory');
  const storage = functionBody('validate_live_release_storage');
  const evidence = functionBody('write_release_evidence');
  assertBefore(
    indexOf(/\n[ \t]*validate_live_release_storage(?:\s|$)/, 'live storage validation call'),
    indexOf(/\n[ \t]*run_migration(?:\s|$)/, 'run_migration call'),
    'new PVC/PV identity must be verified before migration',
  );
  assert.match(
    foundation,
    /rollout status[\s\S]*validate_live_release_storage[\s\S]*apply -f "\$INIT_YAML"/,
  );
  for (const claim of [
    'data-release-postgres-0',
    'data-release-redis-queue-0',
    'data-release-minio-0',
  ]) {
    assert.ok(DEPLOY.includes(claim), `release claim allowlist must include ${claim}`);
  }
  for (const contract of [
    'local-path',
    'ReadWriteOnce',
    'Filesystem',
    'Delete',
    'pvc-$claim_uid',
    '.spec.claimRef.uid == $claimUid',
    '$storage_root_real/${volume}_${NAMESPACE}_${claim}',
  ]) {
    assert.ok(storage.includes(contract), `live storage validation must include ${contract}`);
  }
  assert.match(
    inventory,
    /jq -cn[\s\\\n]*--arg claim "\$claim"[\s\S]*>>"\$pvc_inventory"/,
    'captured PVC records must be one complete JSON object per physical line',
  );
  assert.match(evidence, /--slurpfile storage "\$release_storage_evidence"/);
  assert.match(evidence, /storage: \$storage\[0\]/);
  assert.match(evidence, /releaseStorage: true/);
});

test('migration is a hard fence before applications, traffic, and legacy cleanup', () => {
  const activationStart = DEPLOY.lastIndexOf('\nreuse_completed_release\n');
  const activation = DEPLOY.slice(activationStart);
  const reset = textIndexOf(
    activation,
    /\n[ \t]*fresh_reset_release_data(?:\s|$)/,
    'fresh reset call',
  );
  const foundation = textIndexOf(
    activation,
    /\n[ \t]*apply_foundation(?:\s|$)/,
    'apply_foundation call',
  );
  const migration = textIndexOf(activation, /\n[ \t]*run_migration(?:\s|$)/, 'run_migration call');
  const apps = textIndexOf(activation, /\n[ \t]*apply_apps(?:\s|$)/, 'apply_apps call');
  const traffic = textIndexOf(
    activation,
    /\n[ \t]*switch_release_traffic(?:\s|$)/,
    'switch_release_traffic call',
  );
  const deferredExit = activation.indexOf(
    'status "$ENVIRONMENT release $release_id awaits protected acceptance and finalization"',
  );

  assert.ok(reset < foundation, 'fresh data must be cleared before foundation creation');
  assert.ok(foundation < migration, 'foundation and bucket init must finish before migration');
  assert.ok(migration < apps, 'migration must finish before business manifests');
  assert.ok(apps < traffic, 'business verification must finish before traffic cutover');
  assert.ok(deferredExit > 0, 'Production activation must have a deferred-cleanup exit');
  assert.doesNotMatch(
    activation.slice(activation.indexOf('switch_release_traffic'), deferredExit),
    /\n[ \t]*cleanup_legacy(?:\s|$)/,
    'superseded resources must survive the protected acceptance window',
  );

  const migrationBody = functionBody('run_migration');
  assert.match(migrationBody, /if\s+!\s+[\s\S]*\bwait\b|[\s\S]*\bwait\b[\s\S]*\|\|\s+fail/);
  assert.match(migrationBody, /fail ['"][^'"]*migration/i);
  assert.doesNotMatch(migrationBody, /\bapply_apps\b|APPS_YAML/);

  assert.match(
    functionBody('switch_release_traffic'),
    /"\$SCRIPT_DIR\/switch-release-traffic\.sh"/,
  );
});

test('application preflight validates Runtime Web routes and immutable asset behavior', () => {
  const apps = functionBody('apply_apps');
  assert.match(
    apps,
    /select\(\.application == "runtime-web" and \(\.path \| startswith\("assets\/"\)\)\)/,
  );
  assert.match(apps, /web_fetch http:\/\/127\.0\.0\.1\/try\/ >\/dev\/null/);
  assert.match(
    apps,
    /web_fetch http:\/\/127\.0\.0\.1\/try\/sessions\/combo-release-route-contract >\/dev\/null/,
  );
  assert.match(apps, /web_fetch "http:\/\/127\.0\.0\.1\/try\/\$runtime_asset_path"/);
  assert.match(apps, /try\/assets\/combo-missing-deadbeef\.js/);
  assert.match(apps, /a missing hashed Runtime Web asset returned success/);
});

test('traffic cutover uses a recoverable two-phase checkpoint', () => {
  const activationStart = DEPLOY.lastIndexOf('\nreuse_completed_release\n');
  const activation = DEPLOY.slice(activationStart);
  const apps = textIndexOf(activation, /\n[ \t]*apply_apps(?:\s|$)/, 'apply_apps call');
  const armed = textIndexOf(
    activation,
    /\n[ \t]*write_release_checkpoint armed(?:\s|$)/,
    'armed checkpoint call',
  );
  const traffic = textIndexOf(
    activation,
    /\n[ \t]*switch_release_traffic(?:\s|$)/,
    'switch_release_traffic call',
  );
  const finalizationStart = DEPLOY.lastIndexOf('if ((FINALIZE == 1)); then');
  const normalStart = DEPLOY.lastIndexOf('\nreuse_completed_release\n');
  const postCut = DEPLOY.indexOf('\nwrite_release_checkpoint post-cut', normalStart);
  assert.ok(postCut > normalStart, 'post-cut checkpoint call must exist in activation flow');
  const finalizationEnd = DEPLOY.indexOf('\nfi\nreuse_completed_release', finalizationStart);
  const finalization = DEPLOY.slice(finalizationStart, finalizationEnd);

  assert.ok(apps < armed, 'the candidate must pass application checks before arming');
  assert.ok(armed < traffic, 'an atomic checkpoint must exist before traffic changes');
  assert.ok(
    traffic < activation.indexOf('\nwrite_release_checkpoint post-cut'),
    'the checkpoint becomes post-cut only after switching',
  );
  assert.match(
    finalization,
    /load_activation_evidence[\s\S]*validate_live_candidate_for_finalize[\s\S]*cleanup_for_finalize/,
    'cleanup requires protected acceptance and a revalidated live candidate',
  );
  assert.match(
    DEPLOY.slice(postCut),
    /DEFER_CLEANUP == 1[\s\S]*write_activation_evidence[\s\S]*exit 0/,
    'post-cut activation must persist evidence and exit before cleanup',
  );

  const load = functionBody('load_post_cut_checkpoint');
  const write = functionBody('write_release_checkpoint');
  assert.match(load, /\.schemaVersion == 2/);
  assert.match(load, /\.phase == "armed" or \.phase == "post-cut" or \.phase == "finalizing"/);
  assert.match(write, /mv -fT "\$checkpoint_stage" "\$pending_checkpoint"/);
  assert.match(
    functionBody('detect_live_traffic'),
    /CHECKPOINT_PHASE" == armed[\s\S]*CHECKPOINT_PHASE" == post-cut[\s\S]*RESUME_POST_CUT=1/,
  );
});

test('a first release proceeds without a post-cut checkpoint', () => {
  const load = functionBody('load_post_cut_checkpoint');
  assert.match(
    load,
    /\[\[ -e "\$pending_checkpoint" \]\] \|\| return 0/,
    'a normally absent pending checkpoint must not trip set -e',
  );
});

test('a reused foundation accepts a false checkpoint boolean', () => {
  const load = functionBody('load_post_cut_checkpoint');
  assert.match(load, /created=\$\(jq -r '\.foundationCreated' "\$pending_checkpoint"\)/);
  assert.doesNotMatch(
    load,
    /created=\$\(jq -er '\.foundationCreated'/,
    'jq -e treats the valid boolean false as a failing exit status',
  );
});

test('captured migration ownership matches the rendered managed-by labels', () => {
  const sourceSha = 'c455595eb8e655f3d85852a2194d8440db8a90b3';
  const migration = {
    metadata: {
      name: `release-${sourceSha.slice(0, 12)}-migrate`,
      labels: {
        app: 'migrate',
        'combo.build/managed-by': 'release-v1',
      },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'combo.build/source-sha': sourceSha,
            'combo.build/release-id': `release-${sourceSha}`,
          },
          labels: {
            app: 'migrate',
            'combo.build/managed-by': 'release-v1',
          },
        },
      },
    },
  };
  const initialization = {
    metadata: {
      name: `release-${sourceSha.slice(0, 12)}-minio-init`,
      labels: {
        app: 'minio-init',
        'combo.build/environment-foundation': 'preview-v1',
      },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'combo.build/source-sha': sourceSha,
            'combo.build/release-id': `release-${sourceSha}`,
          },
          labels: {
            app: 'minio-init',
            'combo.build/environment-foundation': 'preview-v1',
          },
        },
      },
    },
  };
  const jobs = [migration, initialization];
  assert.equal(validateCapturedJobOwnership(jobs).status, 0);

  const ownershipMutations = [
    (items) => delete items[0].metadata.labels['combo.build/managed-by'],
    (items) => delete items[0].spec.template.metadata.labels['combo.build/managed-by'],
    (items) => delete items[1].metadata.labels['combo.build/environment-foundation'],
    (items) => delete items[1].spec.template.metadata.labels['combo.build/environment-foundation'],
  ];
  for (const mutate of ownershipMutations) {
    const invalidJobs = structuredClone(jobs);
    mutate(invalidJobs);
    assert.notEqual(validateCapturedJobOwnership(invalidJobs).status, 0);
  }
});

test('a completed evidence checkpoint returns before every cluster mutation', () => {
  const evidenceCheck = indexOf(
    /\n[ \t]*(?:verify_completed_release|completed_release_exists|reuse_completed_release)(?:\s|$)/,
    'completed release evidence check',
  );
  const reset = indexOf(/\n[ \t]*fresh_reset_release_data(?:\s|$)/, 'fresh reset call');
  const between = DEPLOY.slice(evidenceCheck, reset);

  assert.match(between, /\bexit 0\b|\breturn 0\b/);
  assert.doesNotMatch(between, /\b(?:apply|delete|patch|replace|scale)\b/);
});

test('evidence commit and same-release reuse finish any interrupted checkpoint', () => {
  const evidence = functionBody('write_release_evidence');
  const finalize = functionBody('finalize_release_commit');
  const reuse = DEPLOY.slice(
    indexOf(/\nreuse_completed_release\n/, 'completed release reuse call'),
    indexOf(/\n\[\[ ! -e "\$release_directory"/, 'incomplete evidence rejection'),
  );

  assert.match(evidence, /FOUNDATION_CREATED_THIS_RELEASE == 1/);
  assert.match(evidence, /mv "\$stage" "\$release_directory"/);
  assert.match(evidence, /finalize_release_commit 1/);
  assert.match(finalize, /load_post_cut_checkpoint/);
  assert.match(finalize, /write_current_checkpoint/);
  assert.match(finalize, /rm -f -- "\$pending_checkpoint"/);
  assert.match(reuse, /finalize_release_commit 0[\s\S]*exit 0/);
});

test('Production finalization retries reuse persisted irreversible evidence', () => {
  const cleanup = functionBody('cleanup_for_finalize');
  const seal = functionBody('seal_release_traffic');
  const finalizationStart = DEPLOY.lastIndexOf('if ((FINALIZE == 1)); then');
  const finalizationEnd = DEPLOY.indexOf('\nfi\nreuse_completed_release', finalizationStart);
  const finalization = DEPLOY.slice(finalizationStart, finalizationEnd);

  assert.match(cleanup, /activation_directory\/cleanup-evidence\.json/);
  assert.match(cleanup, /install -m 0600 "\$persisted_cleanup" "\$cleanup_evidence"/);
  assert.match(seal, /activation_directory\/traffic-seal-evidence\.json/);
  assert.match(seal, /--phase seal/);
  assert.match(seal, /cmp -s "\$traffic_seal_evidence" "\$persisted_seal"/);
  assert.match(seal, /mv -fT "\$persisted_stage" "\$persisted_seal"/);
  assert.match(
    finalization,
    /validate_live_candidate_for_finalize[\s\S]*prepare_cleanup_plan[\s\S]*write_release_checkpoint finalizing[\s\S]*prepare_release_traffic_finalization[\s\S]*cleanup_for_finalize/,
    'both release and host checkpoints must become rollback-disabled before cleanup',
  );
  assert.match(
    finalization,
    /if \[\[ -e "\$release_directory" \]\]; then[\s\S]*reuse_completed_release[\s\S]*finalize_release_commit 0[\s\S]*exit 0/,
  );
});

test('failure fencing reports partial failures and waits for candidate Pods to disappear', () => {
  const fence = functionBody('fence_writers');
  const wait = functionBody('wait_candidate_writers_fenced');
  const exitTrap = functionBody('on_exit');
  assert.doesNotMatch(fence, /\|\| true/);
  assert.match(fence, /delete_candidate_job[\s\S]*\|\| failed=1/);
  assert.match(fence, /scale_candidate_deployment[\s\S]*\|\| failed=1/);
  assert.match(fence, /wait_candidate_writers_fenced \|\| failed=1/);
  assert.match(wait, /get pods/);
  assert.match(wait, /job-name=\$name/);
  assert.match(wait, /\(\(pods != 0\)\) \|\| return 0/);
  assert.match(exitTrap, /elif ! fence_writers; then/);
  assert.match(exitTrap, /manual recovery is required/);
});

test('legacy cleanup runs only after traffic evidence and names only legacy resources', () => {
  const cleanup = functionBody('cleanup_legacy');
  const preview = environmentArm('preview');
  const production = environmentArm('production');
  const allowlists = `${preview}\n${production}`;

  for (const workload of [
    'postgres',
    'redis-queue',
    'redis-hot',
    'minio',
    'api',
    'consumer',
    'runtime',
    'sweeper',
    'web',
    'worker',
  ]) {
    assert.ok(allowlists.includes(workload), `legacy cleanup allowlist must name ${workload}`);
  }
  for (const claim of ['data-postgres-0', 'data-redis-queue-0', 'data-minio-0']) {
    assert.ok(allowlists.includes(claim), `legacy cleanup PVC allowlist must name ${claim}`);
  }

  assert.match(cleanup, /delete_captured_resource/);
  assert.match(cleanup, /\^release-\[0-9a-f\]\{12\}-/);
  assert.match(cleanup, /\$\{PREFIX\}/);
  assert.doesNotMatch(cleanup, /\bdelete\s+(?:namespace|ns|secret)\b/);
  assert.doesNotMatch(cleanup, /--all\b/);
  assert.match(DEPLOY, /traffic_cut_succeeded=1[\s\S]*cleanup_legacy/);
  assert.match(
    DEPLOY,
    /traffic_cut_succeeded == 0[\s\S]*fence_writers/,
    'a post-cut evidence or cleanup failure must not fence the active candidate',
  );
});

test('Production activation, finalization, and rollback are disjoint closed states', () => {
  assert.match(
    DEPLOY,
    /Production requires an explicit activation, finalization, or rollback phase/,
  );
  const rollbackStart = DEPLOY.lastIndexOf('if ((ROLLBACK == 1)); then');
  const rollbackEnd = DEPLOY.indexOf('\nfi\nif ((FINALIZE == 1)); then', rollbackStart);
  const rollback = DEPLOY.slice(rollbackStart, rollbackEnd);
  assert.match(
    rollback,
    /load_post_cut_checkpoint[\s\S]*load_host_rollback_status[\s\S]*capture_inventory[\s\S]*HOST_ROLLBACK_STATUS" == armed[\s\S]*switch_release_traffic[\s\S]*rollback_host_traffic[\s\S]*HOST_ROLLBACK_STATUS" == rolled-back[\s\S]*validate_completed_host_rollback[\s\S]*armed Production candidate never became active/,
    'rollback must prove the exact candidate is live before recovering either checkpoint phase',
  );
  assert.match(
    rollback,
    /cleanup_pending_candidate_after_rollback[\s\S]*deployment_succeeded=1[\s\S]*exit 0/,
  );
  assert.doesNotMatch(
    rollback,
    /fresh_reset_release_data|apply_foundation|run_migration|apply_apps/,
  );

  const finalizationStart = DEPLOY.lastIndexOf('if ((FINALIZE == 1)); then');
  const finalizationEnd = DEPLOY.indexOf('\nfi\nreuse_completed_release', finalizationStart);
  const finalization = DEPLOY.slice(finalizationStart, finalizationEnd);
  assert.match(
    finalization,
    /load_activation_evidence[\s\S]*validate_live_candidate_for_finalize[\s\S]*prepare_release_traffic_finalization[\s\S]*cleanup_for_finalize[\s\S]*seal_release_traffic[\s\S]*write_release_evidence/,
  );
  assert.match(DEPLOY, /combo-six-area-live-attestation/);
  assert.match(DEPLOY, /finalizing/);
  assert.match(DEPLOY, /rollback-release-traffic\.sh/);
  assert.match(DEPLOY, /seal-release-traffic\.sh/);
});

test('Production rollback is crash-resumable and Preview cannot enter rollback mode', () => {
  const rollbackHost = functionBody('rollback_host_traffic');
  const validateCompleted = functionBody('validate_completed_host_rollback');
  const cleanup = functionBody('cleanup_pending_candidate_after_rollback');
  const rollbackStart = DEPLOY.lastIndexOf('if ((ROLLBACK == 1)); then');
  const rollbackEnd = DEPLOY.indexOf('\nfi\nif ((FINALIZE == 1)); then', rollbackStart);
  const rollback = DEPLOY.slice(rollbackStart, rollbackEnd);
  const preMutationAuthorization = textIndexOf(
    rollback,
    /mutated Production rollback lacks its pre-mutation cleanup authorization/,
    'pre-mutation rollback cleanup authorization',
  );
  const inventoryCapture = textIndexOf(
    rollback,
    /\n[ \t]*capture_inventory(?:\s|$)/,
    'rollback inventory capture',
  );
  assert.ok(
    preMutationAuthorization < inventoryCapture,
    'a journal or committed host rollback must require its durable plan before live inventory can rebuild one',
  );

  assert.match(
    DEPLOY,
    /rollback_pending_evidence="\$EVIDENCE_ROOT\/\$ENVIRONMENT\/\$\{release_id\}\.rollback\.pending\.json"/,
  );
  assert.match(
    rollbackHost,
    /--evidence-output "\$rollback_evidence"/,
    'the host transaction must commit its evidence directly to the durable pending path',
  );
  assert.doesNotMatch(
    rollbackHost,
    /work\/rollback-evidence/,
    'there must be no crash window between host rollback and durable evidence',
  );
  assert.match(
    validateCompleted,
    /\.status == "activated" or \.status == "rolled-back"/,
    'split recovery must accept the state before or after the host checkpoint commit',
  );
  assert.match(
    validateCompleted,
    /\.status == "activated" and \.rolledBackAt == null[\s\S]*\.status == "rolled-back"[\s\S]*\.rolledBackAt \| type == "string" and length > 0/,
    'each accepted checkpoint status must have its exact timestamp shape',
  );
  assert.match(
    validateCompleted,
    /if \[\[ "\$checkpoint_status" == activated \]\]; then\s+rolled_back_at=\$\(date[\s\S]*\.status = "rolled-back"[\s\S]*checkpoint_status=rolled-back[\s\S]*else[\s\S]*rolled_back_at=\$\(jq -er '\.rolledBackAt' "\$checkpoint"\)/,
    'an activated checkpoint must advance once while a rolled-back retry reuses its timestamp',
  );
  assert.match(
    validateCompleted,
    /checkpoint_status" == activated[\s\S]*activation_directory\/traffic-evidence\.json[\s\S]*sha256sum --quiet -c SHA256SUMS[\s\S]*\.rollback\.checkpointDigest == \$checkpointDigest/,
    'an activated split recovery must be bound to durable activation evidence',
  );
  assert.match(
    validateCompleted,
    /\.sourceSha == \$checkpoint\[0\]\.previous\.sourceSha[\s\S]*or[\s\S]*\.sourceSha == \$checkpoint\[0\]\.sourceSha/,
    'the split window may contain only the predecessor or candidate current state',
  );
  assert.match(validateCompleted, /rolled-back Production forward unit state changed/);
  assert.match(validateCompleted, /rolled-back previous Production release is no longer live/);
  assert.match(validateCompleted, /rolled-back Production S3 is no longer ready/);
  assert.match(validateCompleted, /mv -fT "\$evidence_stage" "\$rollback_pending_evidence"/);
  assert.match(
    validateCompleted,
    /validation_mode" == read-only[\s\S]*completed Production rollback is missing predecessor traffic state/,
    'completed rollback reuse must reject a missing predecessor traffic CAS',
  );
  assert.match(
    functionBody('reuse_completed_rollback'),
    /validate_completed_host_rollback read-only "\$host_evidence"/,
    'completed rollback reuse must validate the committed host state without mutating it',
  );

  const unknownCurrent = textIndexOf(
    validateCompleted,
    /fail 'rolled-back Production traffic state is neither candidate nor predecessor'/,
    'unknown current-state rejection',
  );
  const unknownLegacyCurrent = textIndexOf(
    validateCompleted,
    /fail 'rolled-back legacy Production traffic state is not the candidate'/,
    'unknown legacy current-state rejection',
  );
  const livePredecessor = textIndexOf(
    validateCompleted,
    /fail 'rolled-back previous Production release is no longer live'/,
    'live predecessor proof',
  );
  const liveS3 = textIndexOf(
    validateCompleted,
    /fail 'rolled-back Production S3 is no longer ready'/,
    'live S3 proof',
  );
  const checkpointTransition = textIndexOf(
    validateCompleted,
    /if \[\[ "\$checkpoint_status" == activated \]\]; then\s+rolled_back_at=\$\(date/,
    'rollback checkpoint transition',
  );
  const checkpointConfirmed = textIndexOf(
    validateCompleted,
    /fail 'rolled-back Production checkpoint commit could not be confirmed'/,
    'rollback checkpoint confirmation',
  );
  const currentConfirmed = textIndexOf(
    validateCompleted,
    /fail 'rolled-back Production traffic state commit could not be confirmed'/,
    'predecessor current-state confirmation',
  );
  const evidenceConvergence = textIndexOf(
    validateCompleted,
    /if \[\[ -e "\$rollback_pending_evidence" \]\]; then/,
    'rollback evidence convergence',
  );

  assert.ok(
    unknownCurrent < checkpointTransition && unknownLegacyCurrent < checkpointTransition,
    'an unknown current state must fail closed before checkpoint, current, or evidence mutation',
  );
  assert.ok(
    livePredecessor < liveS3 &&
      liveS3 < checkpointTransition &&
      checkpointTransition < checkpointConfirmed &&
      checkpointConfirmed < currentConfirmed &&
      currentConfirmed < evidenceConvergence,
    'a live predecessor must converge checkpoint, current state, and evidence in that order',
  );
  assert.match(
    validateCompleted.slice(checkpointConfirmed, evidenceConvergence),
    /mv -fT "\$current_stage" "\$current_state"/,
    'the predecessor current state must be atomically committed after the checkpoint',
  );
  assert.match(
    validateCompleted.slice(evidenceConvergence),
    /--arg checkpointDigest "\$checkpoint_digest"[\s\S]*mv -fT "\$evidence_stage" "\$rollback_pending_evidence"/,
    'rollback evidence must be digest-bound to the converged checkpoint and committed last',
  );
  assert.match(
    rollback,
    /CHECKPOINT_PHASE" == post-cut[\s\S]*validate_completed_host_rollback[\s\S]*cleanup_pending_candidate_after_rollback/,
    'a committed host rollback must resume only candidate cleanup',
  );
  assert.doesNotMatch(
    rollback,
    /traffic_cut_succeeded=1/,
    'failed post-rollback cleanup must retain the failure fence for the inactive candidate',
  );
  assert.match(cleanup, /rollback-final[\s\S]*mv -fT "\$evidence_stage" "\$final_evidence"/);
  const rootCommit = textIndexOf(
    ROLLBACK,
    /atomic_root_install "\$checkpoint_stage" "\$checkpoint_host" 0600/,
    'root rolled-back checkpoint commit',
  );
  const rootCommitMarker = textIndexOf(
    ROLLBACK,
    /rollback_checkpoint_committed=1/,
    'root rollback commit marker',
  );
  const currentCommit = textIndexOf(
    ROLLBACK,
    /atomic_user_install "\$current_stage" "\$current_state" 0600/,
    'predecessor traffic state commit',
  );
  const evidenceCommit = textIndexOf(
    ROLLBACK,
    /mv -fT "\$evidence_stage" "\$EVIDENCE_OUTPUT"/,
    'rollback evidence commit',
  );
  const transactionCommit = textIndexOf(
    ROLLBACK,
    /transaction_committed=1/,
    'rollback transaction commit marker',
  );
  const journalRemoval = textIndexOf(
    ROLLBACK,
    /sudo -n rm -f -- "\$rollback_journal"/,
    'rollback journal removal',
  );
  assert.ok(
    rootCommit < rootCommitMarker &&
      rootCommitMarker < currentCommit &&
      currentCommit < evidenceCommit &&
      evidenceCommit < transactionCommit &&
      transactionCommit < journalRemoval,
    'host rollback must commit root state, current identity, evidence, and journal retirement in recoverable order',
  );
  assert.match(
    DEPLOY,
    /else[\s\S]*DEFER_CLEANUP == 0 && FINALIZE == 0 && ROLLBACK == 0[\s\S]*Preview remains an atomic single-phase deployment/,
  );
  assert.match(rollback, /ENVIRONMENT" == production/);
});

test('Production finalization rejects sidecars and init or ephemeral containers', () => {
  const live = functionBody('validate_live_candidate_for_finalize');
  assert.match(live, /\.spec\.template\.spec\.containers \| length\) == 1/);
  assert.match(live, /\.spec\.template\.spec\.initContainers \/\/ \[\]/);
  assert.match(live, /\.spec\.template\.spec\.ephemeralContainers \/\/ \[\]/);
  assert.match(live, /\.spec\.containers \| length\) == 1/);
  assert.match(live, /\.spec\.initContainers \/\/ \[\]/);
  assert.match(live, /\.spec\.ephemeralContainers \/\/ \[\]/);
  assert.match(live, /\.status\.containerStatuses \| length\) == 1/);
});

test('Production validates every rollback checkpoint backup before irreversible cleanup', () => {
  const rollbackGate = functionBody('validate_persisted_rollback_checkpoint_for_finalize');
  const live = functionBody('validate_live_candidate_for_finalize');
  const finalizationStart = DEPLOY.lastIndexOf('if ((FINALIZE == 1)); then');
  const finalizationEnd = DEPLOY.indexOf('\nfi\nreuse_completed_release', finalizationStart);
  const finalization = DEPLOY.slice(finalizationStart, finalizationEnd);

  assert.match(rollbackGate, /\.rollback\.checkpointDigest/);
  assert.match(rollbackGate, /checkpoint_digest" == "\$expected_digest/);
  for (const backup of [
    'nginx-canary.before',
    'nginx-formal.before',
    'web-env.before',
    'unit-$index.before',
  ]) {
    assert.ok(rollbackGate.includes(backup), `rollback gate must verify ${backup}`);
  }
  assert.match(rollbackGate, /sudo -n test -f/);
  assert.match(rollbackGate, /sudo -n test ! -L/);
  assert.match(rollbackGate, /sudo -n sha256sum/);
  assert.match(rollbackGate, /previous Production release is not rollback-ready/);
  assert.match(live, /validate_persisted_rollback_checkpoint_for_finalize/);
  assert.match(
    finalization,
    /validate_live_candidate_for_finalize[\s\S]*prepare_cleanup_plan[\s\S]*cleanup_for_finalize/,
    'rollback material must be proven before superseded workloads or PVCs are removed',
  );
});

test('cleanup plan jq validators compile and bind every PVC UID to captured storage', () => {
  const sourceSha = 'a'.repeat(40);
  const identity = {
    environment: 'preview',
    namespace: 'combo-review',
    sourceSha,
    releaseId: `release-${sourceSha}`,
    manifestDigest: `sha256:${'b'.repeat(64)}`,
    prefix: `release-${sourceSha.slice(0, 12)}-`,
    metadata: `combo-release-meta-${sourceSha.slice(0, 12)}`,
    init: 'release-minio-init',
  };
  const plans = [
    {
      functionName: 'validate_cleanup_plan',
      inputVariable: 'cleanup_plan',
      plan: {
        schemaVersion: 1,
        purpose: 'superseded-release-cleanup',
        environment: identity.environment,
        namespace: identity.namespace,
        sourceSha: identity.sourceSha,
        releaseId: identity.releaseId,
        manifestDigest: identity.manifestDigest,
        targets: [{ kind: 'pvc', name: 'data-postgres-0', uid: 'claim-uid' }],
        targetCount: 1,
        capturedStorage: [
          {
            claim: 'data-postgres-0',
            claimUid: 'claim-uid',
            path: '/var/lib/rancher/k3s/storage/pvc-test',
            volume: 'pv-test',
            volumeUid: 'volume-uid',
          },
        ],
        plannedAt: '2026-07-28T00:00:00.000Z',
      },
    },
    {
      functionName: 'validate_rollback_cleanup_plan',
      inputVariable: 'rollback_cleanup_plan',
      plan: {
        schemaVersion: 1,
        purpose: 'candidate-rollback-cleanup',
        environment: 'production',
        namespace: 'combo',
        sourceSha: identity.sourceSha,
        releaseId: identity.releaseId,
        manifestDigest: identity.manifestDigest,
        foundationCreated: true,
        targets: [{ kind: 'pvc', name: 'data-release-postgres-0', uid: 'claim-uid' }],
        targetCount: 1,
        capturedStorage: [
          {
            claim: 'data-release-postgres-0',
            claimUid: 'claim-uid',
            path: '/var/lib/rancher/k3s/storage/pvc-test',
            volume: 'pv-test',
            volumeUid: 'volume-uid',
          },
        ],
        plannedAt: '2026-07-28T00:00:00.000Z',
      },
    },
  ];

  for (const { functionName, inputVariable, plan } of plans) {
    const filter = cleanupPlanValidator(functionName, inputVariable);
    const accepted = runCleanupPlanValidator(filter, plan, identity);
    assert.equal(
      accepted.status,
      0,
      `${functionName} must compile and accept its exact PVC mapping:\n${accepted.stderr}`,
    );

    const mismatched = {
      ...plan,
      capturedStorage: plan.capturedStorage.map((storage) => ({
        ...storage,
        claimUid: 'different-uid',
      })),
    };
    const rejected = runCleanupPlanValidator(filter, mismatched, identity);
    assert.equal(rejected.status, 1, `${functionName} must reject a mismatched PVC UID`);
  }
});

test('Production finalization persists an exact cleanup plan and resumes partial deletion', () => {
  const load = functionBody('load_post_cut_checkpoint');
  const write = functionBody('write_release_checkpoint');
  const prepare = functionBody('prepare_cleanup_plan');
  const build = functionBody('build_cleanup_plan');
  const validate = functionBody('validate_cleanup_plan');
  const materialize = functionBody('materialize_cleanup_plan');
  const rollbackGate = functionBody('validate_persisted_rollback_checkpoint_for_finalize');
  const cleanup = functionBody('cleanup_for_finalize');
  const finalizationStart = DEPLOY.lastIndexOf('if ((FINALIZE == 1)); then');
  const finalizationEnd = DEPLOY.indexOf('\nfi\nreuse_completed_release', finalizationStart);
  const finalization = DEPLOY.slice(finalizationStart, finalizationEnd);

  assert.match(load, /cleanupPlanDigest/);
  assert.match(load, /\.phase == "finalizing"[\s\S]*cleanupPlanDigest/);
  assert.match(write, /Production finalization requires a durable cleanup plan/);
  assert.match(write, /cleanupPlanDigest/);
  assert.match(build, /append_cleanup_plan_target/);
  assert.match(build, /mv -fT "\$stage" "\$cleanup_plan"/);
  assert.match(validate, /cleanup_plan_digest/);
  assert.match(validate, /release cleanup plan changed after it was bound/);
  assert.match(validate, /unique/);
  assert.match(validate, /all\(\.targets/);
  assert.match(materialize, /cleanup-plan-deployments\.json/);
  assert.match(materialize, /cleanup-plan-storage\.jsonl/);
  assert.match(prepare, /post-cut[\s\S]*build_cleanup_plan[\s\S]*finalizing/);
  assert.match(
    rollbackGate,
    /CHECKPOINT_PHASE" == finalizing[\s\S]*return[\s\S]*previous_source=/,
    'a roll-forward retry must not require a superseded target that cleanup may already have removed',
  );
  assert.match(
    finalization,
    /prepare_cleanup_plan[\s\S]*write_release_checkpoint finalizing[\s\S]*prepare_release_traffic_finalization[\s\S]*cleanup_for_finalize/,
    'the exact plan must be bound by both local and host checkpoints before deletion starts',
  );
  assert.match(cleanup, /cleanup-evidence[\s\S]*mv -fT "\$stage" "\$persisted_cleanup"/);
});

test('Production finalization resumes after the host checkpoint was sealed', () => {
  const rollbackGate = functionBody('validate_persisted_rollback_checkpoint_for_finalize');
  const seal = functionBody('seal_release_traffic');
  const completed = functionBody('validate_completed_production_traffic_seal');
  assert.match(rollbackGate, /checkpoint_status=\$\(jq -er '\.status'/);
  assert.match(rollbackGate, /checkpoint_status" == sealed[\s\S]*CHECKPOINT_PHASE" == finalizing/);
  assert.match(
    rollbackGate,
    /sealed Production traffic checkpoint lacks a finalizing release checkpoint/,
  );
  assert.match(rollbackGate, /cleanupEvidenceDigest == \$cleanupDigest/);
  assert.match(rollbackGate, /finalizingCheckpointDigest/);
  assert.match(
    rollbackGate,
    /sealed Production traffic checkpoint does not match cleanup evidence[\s\S]*return/,
    'a sealed checkpoint must bypass the obsolete activated digest only after exact cleanup proof',
  );
  assert.match(seal, /persisted_seal/);
  assert.match(seal, /traffic-seal-evidence\.json/);
  assert.match(
    completed,
    /test ! -e "\$journal"[\s\S]*test ! -e "\$\{journal\}\.staging"[\s\S]*test ! -e "\$\{checkpoint_host\}\.staging"/,
    'completed reuse must reject every unfinished host transaction marker',
  );
  assert.match(
    completed,
    /--arg checkpointDigest "\$checkpoint_digest"[\s\S]*\.checkpointDigest == \$checkpointDigest/,
    'completed reuse must bind the seal to the exact root checkpoint bytes',
  );
  assert.match(
    completed,
    /--arg finalizingCheckpointDigest[\s\S]*\.finalizingCheckpointDigest == \$finalizingCheckpointDigest/,
    'completed reuse must bind the finalizing and sealed checkpoint digests',
  );
});
