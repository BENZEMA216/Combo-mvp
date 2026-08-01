import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseManifestDigest, serializeReleaseManifest } from './release-manifest.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(scriptDirectory, 'recover-preview-post-cut.sh'), 'utf8');
const sourceA = 'a'.repeat(40);
const sourceB = 'b'.repeat(40);
const sourceC = 'c'.repeat(40);
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createManifest(sourceSha) {
  return {
    schemaVersion: 1,
    sourceSha,
    releaseId: `release-${sourceSha}`,
    images: {
      api: `ghcr.io/dangdang-tech/combo-api@sha256:${'1'.repeat(64)}`,
      runtime: `ghcr.io/dangdang-tech/combo-runtime@sha256:${'2'.repeat(64)}`,
      web: `ghcr.io/dangdang-tech/combo-web@sha256:${'3'.repeat(64)}`,
    },
    migrationHead: '0009_billing.sql',
    builtAt: '2026-07-29T00:00:00.000Z',
    webAssetManifest: `sha256:${'4'.repeat(64)}`,
  };
}

function writeChecksums(releaseDirectory, names) {
  const lines = [...names].sort().map((name) => {
    const bytes = readFileSync(join(releaseDirectory, name));
    return `${createHash('sha256').update(bytes).digest('hex')}  ${name}`;
  });
  writeFileSync(join(releaseDirectory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function createFixture({ withReset = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'combo-preview-post-cut-'));
  const controllerDirectory = join(root, 'controller');
  const evidenceRoot = join(root, 'evidence');
  const previewRoot = join(evidenceRoot, 'preview');
  const trafficRoot = join(root, 'traffic');
  const trafficPreviewRoot = join(trafficRoot, 'preview');
  const invocation = join(root, 'invocation.txt');
  const helper = join(controllerDirectory, 'recover-preview-post-cut.sh');
  const releaseId = `release-${sourceA}`;
  const releaseDirectory = join(previewRoot, releaseId);
  const pending = join(previewRoot, 'pending.json');
  const trafficCurrent = join(trafficPreviewRoot, 'current.json');
  const trafficPending = join(previewRoot, `${releaseId}.traffic.pending.json`);
  const cleanupPlanPending = join(previewRoot, `${releaseId}.cleanup-plan.pending.json`);

  mkdirSync(controllerDirectory);
  mkdirSync(releaseDirectory, { recursive: true });
  mkdirSync(trafficPreviewRoot, { recursive: true });
  copyFileSync(join(scriptDirectory, 'recover-preview-post-cut.sh'), helper);
  copyFileSync(
    join(scriptDirectory, 'release-manifest.mjs'),
    join(controllerDirectory, 'release-manifest.mjs'),
  );
  chmodSync(helper, 0o755);

  const fakeDeploy = join(controllerDirectory, 'deploy-release.sh');
  writeFileSync(
    fakeDeploy,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >"$COMBO_TEST_INVOCATION"
environment=
manifest=
manifest_digest=
recover=0
while (($# > 0)); do
  case "$1" in
    --fresh-reset) shift ;;
    --recover-existing-post-cut) recover=1; shift ;;
    --environment) environment=$2; shift 2 ;;
    --manifest) manifest=$2; shift 2 ;;
    --manifest-digest) manifest_digest=$2; shift 2 ;;
    *) shift 2 ;;
  esac
done
[[ "$environment" == preview && "$recover" == 1 ]]
[[ -f "$COMBO_RELEASE_EVIDENCE_ROOT/preview/pending.json" ]]
source_sha=$(jq -er '.sourceSha' "$manifest")
release_id=$(jq -er '.releaseId' "$manifest")
[[ "$release_id" == "release-$source_sha" ]]
directory="$COMBO_RELEASE_EVIDENCE_ROOT/preview/$release_id"
stage=$(mktemp "$COMBO_RELEASE_EVIDENCE_ROOT/preview/.current.XXXXXX")
jq -n \\
  --arg sourceSha "$source_sha" \\
  --arg releaseId "$release_id" \\
  --arg manifestDigest "$manifest_digest" \\
  --arg evidencePath "$directory" '{
    schemaVersion: 1,
    status: "passed",
    environment: "preview",
    namespace: "combo-review",
    sourceSha: $sourceSha,
    releaseId: $releaseId,
    manifestDigest: $manifestDigest,
    evidencePath: $evidencePath
  }' >"$stage"
mv -fT "$stage" "$COMBO_RELEASE_EVIDENCE_ROOT/preview/current.json"
rm -f -- \\
  "$COMBO_RELEASE_EVIDENCE_ROOT/preview/pending.json" \\
  "$COMBO_RELEASE_EVIDENCE_ROOT/preview/$release_id.traffic.pending.json" \\
  "$COMBO_RELEASE_EVIDENCE_ROOT/preview/$release_id.cleanup-plan.pending.json"
`,
  );
  chmodSync(fakeDeploy, 0o755);

  const manifest = createManifest(sourceA);
  const manifestSource = serializeReleaseManifest(manifest);
  const manifestDigest = releaseManifestDigest(manifest);
  writeFileSync(join(releaseDirectory, 'release.json'), manifestSource);
  writeFileSync(join(releaseDirectory, 'release.sha256'), `${manifestDigest}\n`);
  writeFileSync(
    join(releaseDirectory, 'migration-files.txt'),
    '0007_first_party_email_auth.sql\n0008_application_database_roles.sql\n0009_billing.sql\n',
  );
  writeJson(join(releaseDirectory, 'web-asset-manifest.json'), {
    schemaVersion: 1,
    digest: manifest.webAssetManifest,
  });
  for (const name of ['foundation.yaml', 'init.yaml', 'migrate.yaml', 'apps.yaml']) {
    writeFileSync(join(releaseDirectory, name), `# ${name}\n`);
  }
  writeJson(join(releaseDirectory, 'traffic-evidence.json'), {
    sourceSha: sourceA,
    releaseId,
    manifestDigest,
  });
  const cleanupPlan = `${JSON.stringify(
    {
      sourceSha: sourceA,
      releaseId,
      manifestDigest,
      targets: [],
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(releaseDirectory, 'cleanup-plan.json'), cleanupPlan);
  copyFileSync(join(releaseDirectory, 'traffic-evidence.json'), trafficPending);
  copyFileSync(join(releaseDirectory, 'cleanup-plan.json'), cleanupPlanPending);
  writeJson(join(releaseDirectory, 'cleanup-evidence.json'), {
    sourceSha: sourceA,
    releaseId,
    manifestDigest,
    verifiedAbsent: true,
  });
  const resetEvidence = `${JSON.stringify(
    {
      sourceSha: sourceA,
      releaseId,
      manifestDigest,
      status: 'passed',
    },
    null,
    2,
  )}\n`;
  const foundationResetDigest = withReset ? digest(resetEvidence) : '';
  if (withReset) {
    writeFileSync(join(releaseDirectory, 'foundation-reset-evidence.json'), resetEvidence);
  }
  const schemaStructureDigest = `sha256:${'5'.repeat(64)}`;
  writeJson(join(releaseDirectory, 'deploy-evidence.json'), {
    schemaVersion: 1,
    status: 'passed',
    environment: 'preview',
    namespace: 'combo-review',
    sourceSha: sourceA,
    releaseId,
    manifestDigest,
    foundationResetEvidenceDigest: foundationResetDigest || null,
    schemaStructureDigest,
    cleanup: {
      sourceSha: sourceA,
      verifiedAbsent: true,
    },
  });

  const checksumNames = [
    'release.json',
    'release.sha256',
    'migration-files.txt',
    'web-asset-manifest.json',
    'foundation.yaml',
    'init.yaml',
    'migrate.yaml',
    'apps.yaml',
    'traffic-evidence.json',
    'cleanup-plan.json',
    'cleanup-evidence.json',
    'deploy-evidence.json',
    ...(withReset ? ['foundation-reset-evidence.json'] : []),
  ];
  writeChecksums(releaseDirectory, checksumNames);

  writeJson(pending, {
    schemaVersion: 3,
    environment: 'preview',
    namespace: 'combo-review',
    sourceSha: sourceA,
    releaseId,
    manifestDigest,
    foundationCreated: false,
    foundationResetEvidenceDigest: foundationResetDigest || null,
    schemaStructureProofDigest: schemaStructureDigest,
    webService: `release-${sourceA.slice(0, 12)}-web`,
    phase: 'post-cut',
    trafficCutAt: '2026-07-29T00:05:00.000Z',
    cleanupPlanDigest: digest(cleanupPlan),
  });
  writeJson(join(previewRoot, 'current.json'), {
    schemaVersion: 1,
    status: 'passed',
    environment: 'preview',
    namespace: 'combo-review',
    sourceSha: sourceC,
    releaseId: `release-${sourceC}`,
    manifestDigest: `sha256:${'7'.repeat(64)}`,
    evidencePath: join(previewRoot, `release-${sourceC}`),
  });
  writeJson(trafficCurrent, {
    schemaVersion: 1,
    environment: 'preview',
    sourceSha: sourceA,
    releaseId,
    manifestDigest,
    canaryNginxSha256: `sha256:${'6'.repeat(64)}`,
    formalNginxSha256: null,
    webService: `release-${sourceA.slice(0, 12)}-web`,
  });

  return {
    root,
    helper,
    evidenceRoot,
    previewRoot,
    trafficRoot,
    trafficPreviewRoot,
    invocation,
    releaseId,
    releaseDirectory,
    pending,
    trafficCurrent,
    trafficPending,
    cleanupPlanPending,
    manifestDigest,
    checksumNames,
  };
}

function writeCandidateCurrent(fixture) {
  writeJson(join(fixture.previewRoot, 'current.json'), {
    schemaVersion: 1,
    status: 'passed',
    environment: 'preview',
    namespace: 'combo-review',
    sourceSha: sourceA,
    releaseId: fixture.releaseId,
    manifestDigest: fixture.manifestDigest,
    evidencePath: fixture.releaseDirectory,
  });
}

function invoke(fixture, candidate = sourceB) {
  return spawnSync('bash', [fixture.helper, '--candidate-source-sha', candidate], {
    encoding: 'utf8',
    env: {
      ...process.env,
      COMBO_RELEASE_EVIDENCE_ROOT: fixture.evidenceRoot,
      COMBO_RELEASE_TRAFFIC_STATE_ROOT: fixture.trafficRoot,
      COMBO_TEST_INVOCATION: fixture.invocation,
    },
  });
}

function withFixture(callback, options) {
  const fixture = createFixture(options);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('foreign completed Preview post-cut recovery delegates exact inputs to the bundled controller', () => {
  withFixture((fixture) => {
    const trafficBefore = readFileSync(fixture.trafficCurrent, 'utf8');
    const result = invoke(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /recovered completed foreign Preview release/);
    assert.equal(existsSync(fixture.pending), false);
    assert.equal(readFileSync(fixture.trafficCurrent, 'utf8'), trafficBefore);

    const current = JSON.parse(readFileSync(join(fixture.previewRoot, 'current.json'), 'utf8'));
    assert.equal(current.sourceSha, sourceA);
    assert.equal(current.releaseId, fixture.releaseId);
    assert.equal(current.manifestDigest, fixture.manifestDigest);
    assert.equal(current.evidencePath, fixture.releaseDirectory);

    const args = readFileSync(fixture.invocation, 'utf8').trim().split('\n');
    assert.ok(args.includes('--recover-existing-post-cut'));
    assert.ok(args.includes(join(fixture.releaseDirectory, 'release.json')));
    assert.ok(args.includes(join(fixture.releaseDirectory, 'foundation-reset-evidence.json')));
    assert.equal(args.includes(sourceB), false);

    rmSync(fixture.invocation);
    const second = invoke(fixture);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /no pending Preview checkpoint/);
    assert.equal(existsSync(fixture.invocation), false);
  });
});

test('foreign completed Preview post-cut recovery supports an exact non-reset release', () => {
  withFixture(
    (fixture) => {
      const result = invoke(fixture);
      assert.equal(result.status, 0, result.stderr);
      const args = readFileSync(fixture.invocation, 'utf8').trim().split('\n');
      assert.equal(args.includes('--foundation-reset-evidence'), false);
    },
    { withReset: false },
  );
});

test('candidate current checkpoint resumes every auxiliary cleanup crash prefix', async (t) => {
  for (const removed of [[], ['traffic'], ['traffic', 'cleanup']]) {
    await t.test(removed.length === 0 ? 'both pending' : `removed ${removed.join('+')}`, () => {
      withFixture((fixture) => {
        writeCandidateCurrent(fixture);
        if (removed.includes('traffic')) rmSync(fixture.trafficPending);
        if (removed.includes('cleanup')) rmSync(fixture.cleanupPlanPending);
        const result = invoke(fixture);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(existsSync(fixture.pending), false);
        assert.equal(existsSync(fixture.trafficPending), false);
        assert.equal(existsSync(fixture.cleanupPlanPending), false);
      });
    });
  }
});

test('a checkpoint belonging to the current candidate remains for the normal deployment path', () => {
  withFixture((fixture) => {
    const before = readFileSync(fixture.pending, 'utf8');
    const result = invoke(fixture, sourceA);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /belongs to the current candidate/);
    assert.equal(readFileSync(fixture.pending, 'utf8'), before);
    assert.equal(existsSync(fixture.invocation), false);
  });
});

test('foreign Preview recovery rejects invalid durable state before invoking the controller', async (t) => {
  const reject = async (name, mutate, pattern) => {
    await t.test(name, () => {
      withFixture((fixture) => {
        const pendingBefore = readFileSync(fixture.pending, 'utf8');
        mutate(fixture);
        const mutatedPending = readFileSync(fixture.pending, 'utf8');
        const result = invoke(fixture);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, pattern);
        assert.equal(existsSync(fixture.invocation), false);
        assert.equal(readFileSync(fixture.pending, 'utf8'), mutatedPending);
        assert.notEqual(pendingBefore.length, 0);
      });
    });
  };

  await reject(
    'foreign auxiliary evidence',
    (fixture) => {
      writeJson(join(fixture.previewRoot, `release-${sourceC}.traffic.pending.json`), {
        foreign: true,
      });
    },
    /foreign auxiliary pending evidence/,
  );
  await reject(
    'malformed release current checkpoint',
    (fixture) => {
      writeJson(join(fixture.previewRoot, 'current.json'), { malformed: true });
    },
    /release current checkpoint is invalid/,
  );
  await reject(
    'symbolic-link release current checkpoint',
    (fixture) => {
      const current = join(fixture.previewRoot, 'current.json');
      const target = join(fixture.root, 'current-target.json');
      writeJson(target, { target: true });
      rmSync(current);
      symlinkSync(target, current);
    },
    /release current checkpoint is unsafe/,
  );
  await reject(
    'missing predecessor traffic evidence',
    (fixture) => {
      rmSync(fixture.trafficPending);
    },
    /auxiliary pending evidence is missing before current commit/,
  );
  await reject(
    'missing predecessor cleanup plan',
    (fixture) => {
      rmSync(fixture.cleanupPlanPending);
    },
    /auxiliary pending evidence is missing before current commit/,
  );
  await reject(
    'symbolic-link pending traffic evidence',
    (fixture) => {
      rmSync(fixture.trafficPending);
      symlinkSync(join(fixture.releaseDirectory, 'traffic-evidence.json'), fixture.trafficPending);
    },
    /auxiliary pending evidence is unsafe/,
  );
  await reject(
    'pending traffic evidence mismatch',
    (fixture) => {
      writeJson(fixture.trafficPending, { changed: true });
    },
    /pending traffic evidence changed/,
  );
  await reject(
    'pending cleanup plan mismatch',
    (fixture) => {
      writeJson(fixture.cleanupPlanPending, { changed: true });
    },
    /pending cleanup plan changed/,
  );
  await reject(
    'symbolic-link traffic state directory',
    (fixture) => {
      const target = join(fixture.root, 'traffic-preview-target');
      renameSync(fixture.trafficPreviewRoot, target);
      symlinkSync(target, fixture.trafficPreviewRoot, 'dir');
    },
    /traffic state directory is missing or unsafe/,
  );
  await reject(
    'armed checkpoint',
    (fixture) => {
      const pending = JSON.parse(readFileSync(fixture.pending, 'utf8'));
      pending.phase = 'armed';
      pending.trafficCutAt = null;
      pending.cleanupPlanDigest = null;
      writeJson(fixture.pending, pending);
    },
    /not a completed post-cut checkpoint/,
  );
  await reject(
    'cleanup digest mismatch',
    (fixture) => {
      const pending = JSON.parse(readFileSync(fixture.pending, 'utf8'));
      pending.cleanupPlanDigest = `sha256:${'f'.repeat(64)}`;
      writeJson(fixture.pending, pending);
    },
    /cleanup plan digest changed/,
  );
  await reject(
    'reset evidence digest mismatch',
    (fixture) => {
      const pending = JSON.parse(readFileSync(fixture.pending, 'utf8'));
      pending.foundationResetEvidenceDigest = `sha256:${'f'.repeat(64)}`;
      writeJson(fixture.pending, pending);
    },
    /foundation reset evidence digest changed/,
  );
  await reject(
    'traffic identity mismatch',
    (fixture) => {
      const traffic = JSON.parse(readFileSync(fixture.trafficCurrent, 'utf8'));
      traffic.sourceSha = sourceB;
      writeJson(fixture.trafficCurrent, traffic);
    },
    /traffic current state does not identify/,
  );
  await reject(
    'symlinked release input',
    (fixture) => {
      const apps = join(fixture.releaseDirectory, 'apps.yaml');
      rmSync(apps);
      symlinkSync('/dev/null', apps);
    },
    /release evidence file is missing or unsafe/,
  );
  await reject(
    'unsafe checksum file set',
    (fixture) => {
      writeFileSync(
        join(fixture.releaseDirectory, 'SHA256SUMS'),
        `${'0'.repeat(64)}  ../../outside\n`,
      );
    },
    /unsafe or malformed entries/,
  );
  await reject(
    'nested deploy evidence mismatch',
    (fixture) => {
      const evidence = JSON.parse(
        readFileSync(join(fixture.releaseDirectory, 'deploy-evidence.json'), 'utf8'),
      );
      evidence.cleanup.verifiedAbsent = false;
      writeJson(join(fixture.releaseDirectory, 'deploy-evidence.json'), evidence);
      writeChecksums(fixture.releaseDirectory, fixture.checksumNames);
    },
    /deploy evidence is not complete/,
  );
});

test('no-checkpoint recovery rejects orphan auxiliary pending evidence', () => {
  withFixture((fixture) => {
    rmSync(fixture.pending);
    const result = invoke(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /orphan auxiliary pending evidence/);
    assert.equal(existsSync(fixture.invocation), false);
  });
});

test('missing pristine release state roots are a safe first-deployment no-op', () => {
  withFixture((fixture) => {
    rmSync(fixture.evidenceRoot, { recursive: true, force: true });
    rmSync(fixture.trafficRoot, { recursive: true, force: true });
    const result = invoke(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no pending Preview checkpoint/);
    assert.equal(existsSync(fixture.invocation), false);
  });
});

test('the recovery helper has a closed Preview-only, non-destructive interface', () => {
  assert.match(source, /--candidate-source-sha/);
  assert.match(
    source,
    /--environment preview[\s\\\n]*--fresh-reset[\s\\\n]*--recover-existing-post-cut/,
  );
  assert.doesNotMatch(source, /--environment production|kubectl|helm/);
  assert.doesNotMatch(source, /rm\s+-[^\n]*pending|mv\s+[^\n]*current\.json/);
});
