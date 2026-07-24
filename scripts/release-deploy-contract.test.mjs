import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_FILE = resolve(ROOT, 'scripts/deploy-release.sh');
const DEPLOY = readFileSync(DEPLOY_FILE, 'utf8');

function indexOf(pattern, label = String(pattern)) {
  const match = DEPLOY.match(pattern);
  assert.ok(match, `deploy-release.sh must contain ${label}`);
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

function environmentArm(name) {
  const environmentCase = DEPLOY.slice(indexOf(/case "\$ENVIRONMENT" in/, 'environment dispatch'));
  const match = environmentCase.match(new RegExp(`${name}\\)([\\s\\S]*?);;`));
  assert.ok(match, `deploy-release.sh must define the ${name} environment`);
  return match[1];
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

  assert.doesNotMatch(
    DEPLOY,
    /\bbackup\b|backup[-_]|cosfs|\/lhcos-data|offhost|pg_restore|isolated.{0,20}restore/i,
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
  const reset = indexOf(/\n[ \t]*fresh_reset_release_data(?:\s|$)/, 'fresh reset call');
  const foundation = indexOf(/\n[ \t]*apply_foundation(?:\s|$)/, 'apply_foundation call');
  const migration = indexOf(/\n[ \t]*run_migration(?:\s|$)/, 'run_migration call');
  const apps = indexOf(/\n[ \t]*apply_apps(?:\s|$)/, 'apply_apps call');
  const traffic = indexOf(/\n[ \t]*switch_release_traffic(?:\s|$)/, 'switch_release_traffic call');
  const cleanup = indexOf(/\n[ \t]*cleanup_legacy(?:\s|$)/, 'cleanup_legacy call');

  assert.ok(reset < foundation, 'fresh data must be cleared before foundation creation');
  assert.ok(foundation < migration, 'foundation and bucket init must finish before migration');
  assert.ok(migration < apps, 'migration must finish before business manifests');
  assert.ok(apps < traffic, 'business verification must finish before traffic cutover');
  assert.ok(traffic < cleanup, 'legacy resources must survive until traffic cutover succeeds');

  const migrationBody = functionBody('run_migration');
  assert.match(migrationBody, /if\s+!\s+[\s\S]*\bwait\b|[\s\S]*\bwait\b[\s\S]*\|\|\s+fail/);
  assert.match(migrationBody, /fail ['"][^'"]*migration/i);
  assert.doesNotMatch(migrationBody, /\bapply_apps\b|APPS_YAML/);

  assert.match(
    functionBody('switch_release_traffic'),
    /"\$SCRIPT_DIR\/switch-release-traffic\.sh"/,
  );
});

test('traffic cutover uses a recoverable two-phase checkpoint', () => {
  const apps = indexOf(/\n[ \t]*apply_apps(?:\s|$)/, 'apply_apps call');
  const armed = indexOf(/\n[ \t]*write_release_checkpoint armed(?:\s|$)/, 'armed checkpoint call');
  const traffic = indexOf(/\n[ \t]*switch_release_traffic(?:\s|$)/, 'switch_release_traffic call');
  const postCut = indexOf(
    /\n[ \t]*write_release_checkpoint post-cut(?:\s|$)/,
    'post-cut checkpoint call',
  );
  const cleanup = indexOf(/\n[ \t]*cleanup_legacy(?:\s|$)/, 'cleanup_legacy call');

  assert.ok(apps < armed, 'the candidate must pass application checks before arming');
  assert.ok(armed < traffic, 'an atomic checkpoint must exist before traffic changes');
  assert.ok(traffic < postCut, 'the checkpoint becomes post-cut only after switching');
  assert.ok(postCut < cleanup, 'cleanup requires a durable post-cut checkpoint');

  const load = functionBody('load_post_cut_checkpoint');
  const write = functionBody('write_release_checkpoint');
  assert.match(load, /\.schemaVersion == 2/);
  assert.match(load, /\.phase == "armed" or \.phase == "post-cut"/);
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
