import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

const protocolRequire = createRequire(
  new URL('../packages/creator-agent-protocol/package.json', import.meta.url),
);
const YAML = protocolRequire('yaml');
const rootUrl = new URL('../', import.meta.url);
const text = async (path) => readFile(new URL(path, rootUrl), 'utf8');

test('the reusable T0 workflow is a bounded read-only Linux G0 gate', async () => {
  const source = await text('.github/workflows/vnext-t0.yml');
  const workflow = YAML.parse(source);
  assert.equal(workflow.name, 'VNext T0 Linux CI');
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
  assert.deepEqual(Object.keys(workflow.on.workflow_call.outputs), [
    'tested_sha',
    'disposition',
    'conclusion',
    'evidence_digest',
    'artifact_digest',
    'artifact_name',
  ]);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.doesNotMatch(source, /pull_request_target|\bsecrets:|id-token:|packages: write/u);
  assert.doesNotMatch(source, /continue-on-error|\|\| true/u);

  const job = workflow.jobs.g0;
  assert.equal(job.name, 'T0 / G0 Contract Freeze');
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 10);
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.env.EXPECTED_CALLER_WORKFLOW_NAME, '${{ inputs.caller_workflow_name }}');
  assert.equal(job.env.EXPECTED_CALLER_WORKFLOW_PATH, '${{ inputs.caller_workflow_path }}');
  assert.deepEqual(Object.keys(job.outputs), [
    'tested_sha',
    'disposition',
    'conclusion',
    'evidence_digest',
    'artifact_digest',
    'artifact_name',
  ]);
  assert.equal(job.services, undefined);

  const checkout = job.steps.find(({ name }) => name === 'Check out the exact T0 source');
  assert.equal(checkout.uses, 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd');
  assert.equal(checkout.with.ref, '${{ inputs.revision }}');
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);
  const pnpm = job.steps.find(
    ({ uses }) => uses === 'pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093',
  );
  assert.equal(pnpm.with.version, '11.0.9');
  const node = job.steps.find(
    ({ uses }) => uses === 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  );
  assert.equal(node.with['node-version'], 24);
  assert.equal(node.with.cache, 'pnpm');
  assert.equal(node.with['cache-dependency-path'], 'pnpm-lock.yaml');

  const names = job.steps.map(({ name }) => name).filter(Boolean);
  for (const required of [
    'Verify the clean tested identity',
    'Install the frozen dependency graph',
    'Build shared contract dependencies',
    'T0 format check',
    'T0 lint',
    'T0 source typecheck',
    'T0 test typecheck',
    'VNext G0 Linux gate',
    'Validate the canonical T0 evidence bundle',
    'Upload the SHA-bound T0 evidence',
    'Download the immutable uploaded T0 evidence',
    'Publish the redacted T0 evidence identity',
  ]) {
    assert.ok(names.includes(required), required);
  }
  for (const step of job.steps.filter(({ run }) => run !== undefined)) {
    assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./u, step.name);
  }

  const identity = job.steps.find(({ id }) => id === 'identity');
  assert.match(identity.run, /git status --porcelain=v1 --untracked-files=all/u);
  assert.match(identity.run, /git rev-parse HEAD\^1/u);
  assert.match(identity.run, /git rev-parse HEAD\^2/u);
  assert.match(identity.run, /push:FORMAL/u);
  assert.match(identity.run, /pull_request:ADVISORY_ONLY/u);
  assert.match(identity.run, /workflow_dispatch:ADVISORY_ONLY/u);

  const g0 = job.steps.find(({ id }) => id === 'vnext-g0');
  assert.equal((g0.run.match(/pnpm vnext:test:g0/g) ?? []).length, 1);
  assert.match(g0.run, /scripts\/vnext-t0-evidence\.mjs create/u);
  assert.match(g0.run, /scripts\/vnext-t0-evidence\.mjs verify/u);
  assert.equal(g0.env.VNEXT_T0_JOB_CONTEXT_JSON, '${{ toJSON(job) }}');
  assert.match(g0.run, /git diff --cached --quiet/u);
  assert.match(g0.run, /GITHUB_OUTPUT=\/dev\/null[\s\S]*pnpm vnext:test:g0/u);
  assert.match(g0.run, /GITHUB_ENV=\/dev\/null/u);
  assert.match(g0.run, /GITHUB_PATH=\/dev\/null/u);
  assert.match(g0.run, /VNEXT_T0_COMMAND_EXECUTED/u);
  assert.match(g0.run, /exit "\$gate_exit"/u);
  const validation = job.steps.find(({ id }) => id === 'validated-evidence');
  assert.match(validation.if, /steps\.vnext-g0\.outcome != 'skipped'/u);
  assert.match(validation.run, /scripts\/vnext-t0-evidence\.mjs verify/u);
  assert.match(validation.run, /t0-evidence\.json/u);
  const upload = job.steps.find(({ id }) => id === 'evidence-artifact');
  assert.equal(upload.uses, 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
  assert.match(upload.if, /validated-evidence\.outcome == 'success'/u);
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 30);
  assert.equal(upload.with['compression-level'], 0);
  const download = job.steps.find(({ id }) => id === 'downloaded-evidence');
  assert.equal(download.uses, 'actions/download-artifact@70fc10c6e5e1ce46ad2ea6f2b72d43f7d47b13c3');
  assert.match(download.if, /validated-evidence\.outcome == 'success'/u);
  const publish = job.steps.find(
    ({ name }) => name === 'Publish the redacted T0 evidence identity',
  );
  assert.equal(publish.id, 'published-evidence');
  assert.match(publish.run, /UPLOADED_EVIDENCE_DIRECTORY/u);
  assert.match(publish.run, /uploaded_digest/u);
});

test('PR and Release callers share the exact reusable T0 workflow with honest dispositions', async () => {
  const [prSource, releaseSource] = await Promise.all([
    text('.github/workflows/pr-ci.yml'),
    text('.github/workflows/ci.yml'),
  ]);
  const pr = YAML.parse(prSource);
  const release = YAML.parse(releaseSource);
  const prCall = pr.jobs['vnext-t0'];
  const releaseCall = release.jobs['vnext-t0'];

  assert.equal(prCall.uses, './.github/workflows/vnext-t0.yml');
  assert.deepEqual(prCall.permissions, { contents: 'read' });
  assert.equal(prCall.with.revision, '${{ github.sha }}');
  assert.equal(prCall.with.disposition, 'ADVISORY_ONLY');
  assert.equal(prCall.with.event_name, 'pull_request');
  assert.equal(prCall.with.ref_protected, '${{ github.ref_protected }}');
  assert.equal(prCall.with.merge_sha, '${{ github.sha }}');
  assert.equal(prCall.with.base_sha, '${{ github.event.pull_request.base.sha }}');
  assert.equal(prCall.with.head_sha, '${{ github.event.pull_request.head.sha }}');

  assert.equal(releaseCall.uses, './.github/workflows/vnext-t0.yml');
  assert.deepEqual(releaseCall.permissions, { contents: 'read' });
  assert.equal(releaseCall.with.revision, '${{ inputs.revision || github.sha }}');
  assert.match(
    releaseCall.with.disposition,
    /push.*refs\/heads\/main.*ref_protected.*FORMAL.*ADVISORY_ONLY/u,
  );
  assert.equal(releaseCall.with.ref_protected, '${{ github.ref_protected }}');
  assert.equal(release.jobs.gate.needs, 'vnext-t0');
  assert.doesNotMatch(`${prSource}\n${releaseSource}`, /pull_request_target/u);
});

test('PR checks run the isolated R3 PostgreSQL vertical against the exact merge source', async () => {
  const source = await text('.github/workflows/pr-ci.yml');
  const workflow = YAML.parse(source);
  const job = workflow.jobs['vnext-r3-pg'];

  assert.equal(job.name, 'CI / VNext R3 PostgreSQL vertical');
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 30);
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.services, undefined);
  assert.equal(job.env.MERGE_SHA, '${{ github.sha }}');
  assert.equal(job.env.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.equal(job.env.HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
  assert.doesNotMatch(source, /pull_request_target/u);
  assert.doesNotMatch(source, /continue-on-error/u);

  const checkout = job.steps.find(
    ({ name }) => name === 'Check out the exact pull request merge source for R3',
  );
  assert.equal(checkout.uses, 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd');
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);

  const identity = job.steps.find(({ name }) => name === 'Verify the R3 merge identity');
  assert.match(identity.run, /git rev-parse HEAD\^1/u);
  assert.match(identity.run, /git rev-parse HEAD\^2/u);
  assert.match(identity.run, /git diff --cached --quiet/u);

  const postgres = job.steps.find(({ name }) => name === 'Install the isolated PostgreSQL runtime');
  assert.match(postgres.run, /apt-get install -y[\s\S]*postgresql[\s\S]*postgresql-client/u);
  assert.match(postgres.run, /pg_config --bindir/u);
  assert.match(postgres.run, /INITDB_BIN=%s\/initdb/u);
  assert.match(postgres.run, /POSTGRES_BIN=%s\/postgres/u);
  assert.match(postgres.run, /PG_ISREADY_BIN=%s\/pg_isready/u);
  assert.match(postgres.run, /GITHUB_ENV/u);

  const gate = job.steps.find(({ name }) => name === 'R3 isolated PostgreSQL product vertical');
  assert.equal(gate.run, 'pnpm vnext:test:r3:pg');
});

test('the workflow contract entrypoint includes T0 suite and evidence tests', async () => {
  const rootPackage = JSON.parse(await text('package.json'));
  const command = rootPackage.scripts['test:workflow-contracts'];
  assert.match(command, /scripts\/vnext-g0-suite\.test\.mjs/u);
  assert.match(command, /scripts\/vnext-t0-evidence\.test\.mjs/u);
  assert.match(command, /scripts\/vnext-t0-workflow-contract\.test\.mjs/u);
});
