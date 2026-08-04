import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (letter) => `${letter}`.repeat(64);
const POSTGRES_IMAGE =
  'postgres@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7';
const REDIS_IMAGE = 'redis@sha256:bb186d083732f669da90be8b0f975a37812b15e913465bb14d845db72a4e3e08';
const MINIO_IMAGE =
  'minio/minio@sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0';
const MINIO_MC_IMAGE =
  'minio/mc@sha256:fb8f773eac8ef9d6da0486d5dec2f42f219358bcb8de579d1623d518c9ebd4cc';
const containerContractsEnabled = process.env.COMBO_RUN_CONTAINER_CONTRACTS === '1';
const dockerAvailable =
  containerContractsEnabled && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const imageArgs = [
  '--api-image',
  `ghcr.io/dangdang-tech/combo-api@sha256:${digest('a')}`,
  '--runtime-image',
  `ghcr.io/dangdang-tech/combo-runtime@sha256:${digest('b')}`,
  '--web-image',
  `ghcr.io/dangdang-tech/combo-web@sha256:${digest('c')}`,
];
const RELEASE_SHA = 'd'.repeat(40);
const RELEASE_MANIFEST = {
  schemaVersion: 1,
  sourceSha: RELEASE_SHA,
  releaseId: `release-${RELEASE_SHA}`,
  images: {
    api: imageArgs[1],
    runtime: imageArgs[3],
    web: imageArgs[5],
  },
  migrationHead: '0009_billing.sql',
  builtAt: '2026-07-24T08:00:00.000Z',
  webAssetManifest: `sha256:${digest('e')}`,
};

function text(path) {
  return readFileSync(join(repo, path), 'utf8');
}

function writeReleaseFixture(root, releaseManifest = RELEASE_MANIFEST) {
  const manifest = join(root, 'release.json');
  const digestFile = join(root, 'release-manifest-digest.txt');
  const serialized = `${JSON.stringify(releaseManifest, null, 2)}\n`;
  writeFileSync(manifest, serialized);
  writeFileSync(digestFile, `sha256:${sha(serialized)}\n`);
  return [
    '--revision',
    RELEASE_SHA,
    '--release-manifest',
    manifest,
    '--release-manifest-digest-file',
    digestFile,
  ];
}

function render(root = repo) {
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-render-'));
  const output = join(work, 'rendered.yaml');
  const releaseArgs = writeReleaseFixture(work);
  try {
    execFileSync(
      'bash',
      [
        join(root, 'scripts/combo-dev-deploy.sh'),
        '--render-only',
        '--output',
        output,
        ...imageArgs,
        ...releaseArgs,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'combo-dev-fixture-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'infra/k8s/overlays'), { recursive: true });
  cpSync(join(repo, 'scripts/combo-dev-deploy.sh'), join(root, 'scripts/combo-dev-deploy.sh'));
  cpSync(join(repo, 'infra/k8s/overlays/combo-dev'), join(root, 'infra/k8s/overlays/combo-dev'), {
    recursive: true,
  });
  return root;
}

function runLogsAuditFixture(mode, activityMode = 'product') {
  const root = mkdtempSync(join(tmpdir(), 'combo-dev-logs-fixture-'));
  const bin = join(root, 'bin');
  const audit = join(root, 'combo-dev-logs');
  const marker = join(root, 'marker');
  const state = join(root, 'state');
  const getState = join(root, 'get-state');
  const invocations = join(root, 'invocations');
  const controlState = join(root, 'control-state');
  const controlWork = join(controlState, 'work');
  const markerValue = 'SYNTHETIC_MARKER_1234567890';
  mkdirSync(bin);
  mkdirSync(controlWork, { recursive: true, mode: 0o700 });
  chmodSync(controlState, 0o700);
  chmodSync(controlWork, 0o700);
  writeFileSync(marker, `${markerValue}\n`, { mode: 0o600 });
  writeFileSync(state, '0\n', { mode: 0o600 });
  writeFileSync(getState, '0\n', { mode: 0o600 });
  writeFileSync(invocations, '', { mode: 0o600 });
  let source = text('scripts/combo-dev-logs.sh');
  for (const [expected, replacement] of [
    [
      "export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'",
      `export PATH='${bin}:/usr/bin:/bin'`,
    ],
    ['readonly ACTIVITY_ATTEMPTS=15', 'readonly ACTIVITY_ATTEMPTS=3'],
    ['readonly ACTIVITY_RETRY_SECONDS=2', 'readonly ACTIVITY_RETRY_SECONDS=0'],
    ['readonly LOG_CAPTURE_BYTES=8388609', 'readonly LOG_CAPTURE_BYTES=64'],
    ["readonly CONTROL_STATE='/opt/combo-dev/state'", `readonly CONTROL_STATE='${controlState}'`],
    ["readonly CONTROL_WORK='/opt/combo-dev/state/work'", `readonly CONTROL_WORK='${controlWork}'`],
    ['/opt/combo-dev/bin/combo-dev-storage-guard', join(bin, 'combo-dev-storage-guard')],
  ]) {
    assert.ok(source.includes(expected), `fixture replacement missing: ${expected}`);
    source = source.replace(expected, replacement);
  }
  writeFileSync(audit, source, { mode: 0o700 });
  writeFileSync(
    join(bin, 'stat'),
    `#!/usr/bin/env bash
set -euo pipefail
last=\${!#}
if [[ "$last" == "$FAKE_CONTROL_STATE" || "$last" == "$FAKE_CONTROL_WORK" ]]; then
  [[ "$1" == -c && "$2" == '%u:%g:%a' ]] || exit 2
  printf '%s\n' '0:0:700'
  exit 0
fi
exec /usr/bin/stat "$@"
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'findmnt'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" $FAKE_CONTROL_STATE "* || " $* " == *" $FAKE_CONTROL_WORK "* ]]; then
  printf '%s\n' "$FAKE_CONTROL_STATE"
  exit 0
fi
exit 2
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'combo-dev-storage-guard'),
    '#!/usr/bin/env bash\n[[ "$*" == "--check-only" ]]\n',
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'kubectl'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_INVOCATIONS"
app=''
pod=''
for arg in "$@"; do
  [[ "$arg" == app=* ]] && app=\${arg#app=}
  [[ "$arg" == *-pod ]] && pod=$arg
done
if [[ " $* " == *" get pods "* ]]; then
  case "$app" in
    api|worker|runtime|web) container=$app ;;
    postgres|minio) container=$app ;;
    redis-queue|redis-hot) container=redis ;;
    *) exit 2 ;;
  esac
  restart=0
  [[ "$FAKE_MODE" =~ ^(previous|previous-leak)$ && "$app" == worker ]] && restart=1
  [[ "$FAKE_MODE" == restart-multiple && "$app" == worker ]] && restart=2
  if [[ "$FAKE_MODE" == restart-race && "$app" == worker ]]; then
    count=$(<"$FAKE_GET_STATE")
    count=$((count + 1))
    printf '%s\\n' "$count" >"$FAKE_GET_STATE"
    (( count >= 2 )) && restart=1
  fi
  printf '{"items":[{"metadata":{"name":"%s-pod","uid":"%s-uid"},"status":{"phase":"Running","containerStatuses":[{"name":"%s","ready":true,"restartCount":%s}]}}]}\\n' "$app" "$app" "$container" "$restart"
  exit 0
fi
if [[ " $* " == *" logs "* ]]; then
  previous=0
  [[ " $* " == *" --previous "* ]] && previous=1
  case "$pod" in
    api-pod)
      if [[ "$FAKE_MODE" == truncated ]]; then
        printf '%0100d\\n' 0
      elif [[ "$FAKE_MODE" == leak-then-source-fail ]]; then
        count=$(<"$FAKE_STATE")
        count=$((count + 1))
        printf '%s\\n' "$count" >"$FAKE_STATE"
        if (( count == 1 )); then
          printf '%s\\n' "$FAKE_MARKER"
        else
          printf '%s\\n' '{"msg":"route not found"}'
        fi
      else
        printf '%s\\n' '{"msg":"route not found"}'
      fi
      ;;
    runtime-pod)
      if [[ "$FAKE_MODE" == leak-then-source-fail && $(<"$FAKE_STATE") == 1 ]]; then
        exit 1
      fi
      printf '%s\\n' '{"msg":"route not found"}'
      ;;
    worker-pod)
      if [[ "$FAKE_MODE" =~ ^(previous|previous-leak|restart-race)$ && "$previous" == 1 ]]; then
        if [[ "$FAKE_MODE" == previous-leak ]]; then
          printf '%s\\n' "$FAKE_MARKER"
        else
          printf '%s\\n' '{"msg":"pipeline finished"}'
        fi
      elif [[ "$FAKE_MODE" == delayed ]]; then
        count=$(<"$FAKE_STATE")
        count=$((count + 1))
        printf '%s\\n' "$count" >"$FAKE_STATE"
        if (( count >= 2 )); then
          printf '%s\\n' '{"msg":"pipeline finished"}'
        else
          printf '%s\\n' '{"msg":"worker ready"}'
        fi
      elif [[ "$FAKE_MODE" =~ ^(missing|previous|previous-leak|restart-race)$ ]]; then
        printf '%s\\n' '{"msg":"worker ready"}'
      else
        printf '%s\\n' '{"msg":"pipeline finished"}'
      fi
      ;;
    minio-pod)
      if [[ "$FAKE_MODE" == leak ]]; then
        printf '%s\\n' "$FAKE_MARKER"
      elif [[ "$FAKE_MODE" == credential ]]; then
        printf '%s\\n' 'Authorization: Bearer TEST_SECRET_TOKEN'
      else
        printf '%s\\n' '{"msg":"storage ready"}'
      fi
      ;;
    *) printf '%s\\n' '{"msg":"source ready"}' ;;
  esac
  exit 0
fi
exit 2
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'cat'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$FAKE_MODE" == cat-fail && "$*" == *"/minio.current.log"* ]]; then
  exit 1
fi
exec /usr/bin/cat "$@"
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'grep'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$FAKE_MODE" == grep-fail && "$*" == *"/all.log"* ]]; then
  exit 2
fi
exec /usr/bin/grep "$@"
`,
    { mode: 0o700 },
  );
  try {
    const result = spawnSync(
      'bash',
      [
        audit,
        '--since-time',
        '2026-07-25T14:00:00Z',
        '--marker-file',
        marker,
        '--activity-mode',
        activityMode,
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          FAKE_MODE: mode,
          FAKE_MARKER: markerValue,
          FAKE_STATE: state,
          FAKE_GET_STATE: getState,
          FAKE_INVOCATIONS: invocations,
          FAKE_CONTROL_STATE: controlState,
          FAKE_CONTROL_WORK: controlWork,
        },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      invocations: readFileSync(invocations, 'utf8'),
      markerValue,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runSmokeLogProbeFixture(mode) {
  const root = mkdtempSync(join(tmpdir(), 'combo-dev-smoke-probe-'));
  const smoke = text('scripts/combo-dev-smoke.sh');
  const start = smoke.indexOf('check_logs_fail_closed() {');
  const end = smoke.indexOf('\n}\n\nmain() {', start);
  assert.ok(start > 0 && end > start);
  const check = smoke.slice(start, end + 2);
  const harness = [
    'set -Eeuo pipefail',
    'WORK=$1',
    `WEB_ORIGIN='http://127.0.0.1:18080'`,
    `status() { printf '[fixture] %s\\n' "$1"; }`,
    `fail() { printf '[fixture] FAIL: %s\\n' "$1" >&2; exit 1; }`,
    `blocked() { printf '[fixture] BLOCKED: %s\\n' "$1" >&2; exit 2; }`,
    `openssl() { printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }`,
    `curl() {`,
    `  case "$FAKE_CURL_MODE" in`,
    `    transport) return 7 ;;`,
    `    wrong-status) printf '200'; return 0 ;;`,
    `    *) printf '404'; return 0 ;;`,
    `  esac`,
    `}`,
    check,
    `check_logs_fail_closed '2026-07-25T14:00:00Z' baseline`,
  ].join('\n');
  try {
    return spawnSync('bash', ['-c', harness, 'combo-dev-smoke-probe', root], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, FAKE_CURL_MODE: mode },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runStorageCapacityFixture({
  rootFree,
  rootInodes = 900_000,
  dataFree,
  dataInodes = 900_000,
  stateFree = 2 * 1024 ** 3,
  stateInodes = 10_000,
}) {
  const guard = join(repo, 'scripts/combo-dev-storage-guard.sh');
  const harness = `
source ${JSON.stringify(guard)}
df() {
  local target=\${!#} metric=''
  case " $* " in
    *" --output=avail "*) metric=avail ;;
    *" --output=size "*) metric=size ;;
    *" --output=iavail "*) metric=iavail ;;
    *" --output=itotal "*) metric=itotal ;;
    *) return 2 ;;
  esac
  printf '%s\n' header
  case "$target:$metric" in
    /:avail) printf '%s\n' "$FAKE_ROOT_FREE" ;;
    /:size) printf '%s\n' "$FAKE_ROOT_TOTAL" ;;
    /:iavail) printf '%s\n' "$FAKE_ROOT_INODES" ;;
    /:itotal) printf '%s\n' "$FAKE_TOTAL_INODES" ;;
    "$DATA_MOUNT":avail) printf '%s\n' "$FAKE_DATA_FREE" ;;
    "$DATA_MOUNT":size) printf '%s\n' "$FAKE_DATA_TOTAL" ;;
    "$DATA_MOUNT":iavail) printf '%s\n' "$FAKE_DATA_INODES" ;;
    "$DATA_MOUNT":itotal) printf '%s\n' "$FAKE_TOTAL_INODES" ;;
    "$CONTROL_STATE":avail) printf '%s\n' "$FAKE_STATE_FREE" ;;
    "$CONTROL_STATE":iavail) printf '%s\n' "$FAKE_STATE_INODES" ;;
    *) return 2 ;;
  esac
}
classify_host_capacity
if control_headroom_ok; then control=ok; else control=low; fi
printf 'rootWarning=%s rootCritical=%s dataWarning=%s dataCritical=%s control=%s\n' \
  "$ROOT_CAPACITY_WARNING" "$ROOT_CAPACITY_CRITICAL" \
  "$DATA_CAPACITY_WARNING" "$DATA_CAPACITY_CRITICAL" "$control"
`;
  return spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_ROOT_FREE: String(rootFree),
      FAKE_ROOT_TOTAL: String(180 * 1024 ** 3),
      FAKE_ROOT_INODES: String(rootInodes),
      FAKE_DATA_FREE: String(dataFree),
      FAKE_DATA_TOTAL: String(206.5 * 1024 ** 3),
      FAKE_DATA_INODES: String(dataInodes),
      FAKE_TOTAL_INODES: '1000000',
      FAKE_STATE_FREE: String(stateFree),
      FAKE_STATE_INODES: String(stateInodes),
    },
  });
}

function runControlStateIdentityFixture(mode) {
  const root = mkdtempSync(join(tmpdir(), 'combo-dev-control-state-'));
  const dataMount = join(root, 'data');
  const parent = join(dataMount, 'combo-host');
  const image = join(parent, 'control-state.img');
  const state = join(root, 'state');
  const stateReal = mode === 'state-symlink' ? join(root, 'state-real') : state;
  const legacyIncoming = join(root, 'compat/incoming');
  const legacyReleases = join(root, 'compat/releases');
  const legacyEvidence = join(root, 'compat/evidence');
  for (const path of [
    parent,
    join(stateReal, 'incoming'),
    join(stateReal, 'releases/.staging'),
    join(stateReal, 'work'),
    join(stateReal, 'evidence'),
    legacyIncoming,
    legacyReleases,
    legacyEvidence,
  ]) {
    mkdirSync(path, { recursive: true });
  }
  if (mode === 'state-symlink') symlinkSync(stateReal, state);
  writeFileSync(image, 'fixture');
  if (mode !== 'missing-sentinel') {
    writeFileSync(join(stateReal, '.combo-dev-control-state'), 'combo-dev-control-state=v1\n');
  }

  const guard = text('scripts/combo-dev-storage-guard.sh');
  const start = guard.indexOf('verify_control_state() {');
  const end = guard.indexOf('\n}\n\ncontrol_headroom_ok() {', start);
  assert.ok(start > 0 && end > start);
  const verify = guard
    .slice(start, end + 2)
    .replaceAll('/opt/combo-dev/incoming', legacyIncoming)
    .replaceAll('/opt/combo-dev/releases', legacyReleases)
    .replaceAll('/var/lib/combo-dev/evidence', legacyEvidence);
  const harness = `
set -u
CONTROL_STATE=${JSON.stringify(state)}
CONTROL_STATE_PARENT=${JSON.stringify(parent)}
CONTROL_STATE_IMAGE=${JSON.stringify(image)}
DATA_ANCHOR_CHECK=/bin/true
CONTROL_STATE_SENTINEL=${JSON.stringify(join(state, '.combo-dev-control-state'))}
CONTROL_STATE_SENTINEL_VALUE='combo-dev-control-state=v1'
CONTROL_STATE_BYTES=4294967296
CONTROL_STATE_LABEL='combo-dev-state'
CONTROL_STATE_MIN_BYTES=$((3584 * 1024 * 1024))
CONTROL_STATE_MAX_BYTES=$((4 * 1024 * 1024 * 1024))
DATA_MOUNT=${JSON.stringify(dataMount)}
FAKE_MODE=${JSON.stringify(mode)}
stat() {
  local format='' path=\${!#}
  [[ \${1:-} == -c ]] && format=$2
  case "$format:$path" in
    '%u:%g:%a':"$CONTROL_STATE") printf '%s\\n' '0:0:700' ;;
    '%u:%g:%a':"$CONTROL_STATE_PARENT")
      [[ "$FAKE_MODE" == bad-permissions ]] && printf '%s\\n' '0:0:755' || printf '%s\\n' '0:0:700' ;;
    '%u:%g:%a':"$CONTROL_STATE_SENTINEL") printf '%s\\n' '0:0:400' ;;
    '%u:%g:%a':"$CONTROL_STATE_IMAGE") printf '%s\\n' '0:0:600' ;;
    '%u:%g:%a':*/incoming) printf '%s\\n' '0:0:1733' ;;
    '%u:%g:%a':*/releases) printf '%s\\n' '0:0:755' ;;
    '%u:%g:%a':*/releases/.staging|'%u:%g:%a':*/work) printf '%s\\n' '0:0:700' ;;
    '%u:%g:%a':*/evidence) printf '%s\\n' '0:0:755' ;;
    '%s':"$CONTROL_STATE_IMAGE") printf '%s\\n' '4294967296' ;;
    '%d':"$CONTROL_STATE_IMAGE"|'%d':"$DATA_MOUNT") printf '%s\\n' '200' ;;
    '%d':/) [[ "$FAKE_MODE" == same-device-bind ]] && printf '%s\\n' '200' || printf '%s\\n' '100' ;;
    '%d:%i':*/incoming) printf '%s\\n' '200:11' ;;
    '%d:%i':*/releases) printf '%s\\n' '200:12' ;;
    '%d:%i':*/evidence) printf '%s\\n' '200:13' ;;
    *) /usr/bin/stat "$@" ;;
  esac
}
findmnt() {
  local selector='' column=''
  while (($#)); do
    case "$1" in
      -M|-T) selector=$2; shift 2 ;;
      -o) column=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  case "$selector:$column" in
    "$CONTROL_STATE_IMAGE":TARGET)
      [[ "$FAKE_MODE" == wrong-mount ]] && printf '%s\\n' / || printf '%s\\n' "$CONTROL_STATE_PARENT" ;;
    "$CONTROL_STATE":TARGET) printf '%s\\n' "$CONTROL_STATE" ;;
    "$CONTROL_STATE":SOURCE) printf '%s\\n' /dev/loop7 ;;
    "$CONTROL_STATE":OPTIONS) printf '%s\\n' rw,nodev,nosuid,noexec ;;
    "$CONTROL_STATE":FSTYPE) printf '%s\\n' ext4 ;;
    /:SOURCE) printf '%s\\n' /dev/root ;;
    "$DATA_MOUNT":SOURCE) printf '%s\\n' /dev/data ;;
    "$DATA_MOUNT":TARGET) printf '%s\\n' "$DATA_MOUNT" ;;
    */incoming:TARGET|*/releases:TARGET|*/releases/.staging:TARGET|*/work:TARGET|*/evidence:TARGET)
      case "$selector" in
        ${JSON.stringify(legacyIncoming)}|${JSON.stringify(legacyReleases)}|${JSON.stringify(legacyEvidence)}) printf '%s\\n' "$selector" ;;
        *) printf '%s\\n' "$CONTROL_STATE" ;;
      esac ;;
    ${JSON.stringify(legacyIncoming)}:OPTIONS|${JSON.stringify(legacyReleases)}:OPTIONS|${JSON.stringify(legacyEvidence)}:OPTIONS)
      printf '%s\\n' rw,nodev,nosuid,noexec ;;
    ${JSON.stringify(legacyIncoming)}:FSROOT) printf '%s\\n' /incoming ;;
    ${JSON.stringify(legacyReleases)}:FSROOT) printf '%s\\n' /releases ;;
    ${JSON.stringify(legacyEvidence)}:FSROOT) printf '%s\\n' /evidence ;;
    *) return 2 ;;
  esac
}
losetup() { printf '%s\\n' "$CONTROL_STATE_IMAGE"; }
blockdev() { [[ "$FAKE_MODE" == wrong-size ]] && printf '%s\\n' 1 || printf '%s\\n' "$CONTROL_STATE_BYTES"; }
blkid() { [[ "$FAKE_MODE" == wrong-label ]] && printf '%s\\n' wrong || printf '%s\\n' "$CONTROL_STATE_LABEL"; }
df() { printf '%s\\n%s\\n' size "$CONTROL_STATE_BYTES"; }
host_findmnt() { findmnt --task 1 "$@"; }
${verify}
verify_control_state
`;
  try {
    return spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runStorageGuardTimerReadyFixture({
  enabled = 'enabled',
  active = 'active',
  next = '123456789',
} = {}) {
  const source = text('scripts/combo-dev-bootstrap.sh');
  const start = source.indexOf('storage_guard_timer_ready() {');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  const readiness = source.slice(start, end + 2);
  const harness = `
set -Eeuo pipefail
timeout() { shift; "$@"; }
systemctl() {
  case "$1" in
    is-enabled) printf '%s\\n' "$FAKE_ENABLED" ;;
    is-active) printf '%s\\n' "$FAKE_ACTIVE" ;;
    show) printf '%s\\n' "$FAKE_NEXT" ;;
    *) return 2 ;;
  esac
}
${readiness}
storage_guard_timer_ready
`;
  return spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_ENABLED: enabled,
      FAKE_ACTIVE: active,
      FAKE_NEXT: next,
    },
  });
}

function expectRenderFailure(root, marker) {
  const output = join(root, 'out.yaml');
  const releaseArgs = writeReleaseFixture(root);
  const result = spawnSync(
    'bash',
    [
      join(root, 'scripts/combo-dev-deploy.sh'),
      '--render-only',
      '--output',
      output,
      ...imageArgs,
      ...releaseArgs,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, marker);
}

function documents(rendered) {
  return rendered.split(/^---\s*$/m).filter((value) => value.trim());
}

function identity(document) {
  return {
    kind: document.match(/^kind:\s*(\S+)/m)?.[1],
    name: document.match(/^metadata:\n(?:^(?: {2}.*)?\n)*?^ {2}name:\s*(\S+)/m)?.[1],
  };
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const rendered = render();
const renderedDocuments = documents(rendered);

function documentFor(kind, name) {
  const found = renderedDocuments.find((document) => {
    const value = identity(document);
    return value.kind === kind && value.name === name;
  });
  assert.ok(found, `${kind}/${name} must exist`);
  return found;
}

test('stage-only render mounts only the three prebound static claims', () => {
  assert.equal(renderedDocuments.length, 40);
  assert.equal(rendered.includes('hostPath:'), false);
  assert.equal(
    renderedDocuments.some((document) =>
      ['StorageClass', 'PersistentVolume', 'PersistentVolumeClaim'].includes(
        identity(document).kind,
      ),
    ),
    false,
  );
  const claims = {
    postgres: 'data-postgres-0',
    'redis-queue': 'data-redis-queue-0',
    minio: 'data-minio-0',
  };
  for (const [name, claim] of Object.entries(claims)) {
    const document = documentFor('StatefulSet', name);
    assert.match(
      document,
      new RegExp(`^ {6}- name: data\n {8}persistentVolumeClaim:\n {10}claimName: ${claim}$`, 'm'),
    );
    assert.match(
      document,
      /mountPath: \/combo-dev-volume-marker[\s\S]*subPath: \.combo-dev-volume/,
    );
    assert.match(
      document,
      /mountPath: (?:\/data|\/var\/lib\/postgresql\/data)[\s\S]*subPath: data/,
    );
    assert.match(document, new RegExp(`combo-dev-static-volume=${name}:v1`));
    assert.doesNotMatch(document, /volumeClaimTemplates:|persistentVolumeClaimRetentionPolicy:/);
  }

  const root = fixture();
  try {
    const sourcePath = join(root, 'infra/k8s/overlays/combo-dev/foundation/resources.yaml');
    const source = readFileSync(sourcePath, 'utf8');
    writeFileSync(
      sourcePath,
      source.replace('            claimName: data-postgres-0', '            claimName: other'),
    );
    expectRenderFailure(root, /guard:static-pvc-mount/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Test apps share one exact immutable release identity without Secret expansion', () => {
  const metadataName = `combo-release-meta-${RELEASE_SHA.slice(0, 12)}`;
  const metadata = documentFor('ConfigMap', metadataName);
  const expected = {
    COMBO_ENVIRONMENT: 'test',
    COMBO_SOURCE_SHA: RELEASE_SHA,
    COMBO_RELEASE_ID: `release-${RELEASE_SHA}`,
    COMBO_BUILT_AT: RELEASE_MANIFEST.builtAt,
    COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${sha(
      `${JSON.stringify(RELEASE_MANIFEST, null, 2)}\n`,
    )}`,
    COMBO_WEB_ASSET_MANIFEST: RELEASE_MANIFEST.webAssetManifest,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.match(metadata, new RegExp(`^ {2}${key}: ["']?${regexEscape(value)}["']?$`, 'm'));
  }
  assert.equal((metadata.match(/^ {2}COMBO_[A-Z_]+:/gm) ?? []).length, 6);
  assert.equal((metadata.match(/^immutable: true$/gm) ?? []).length, 1);
  assert.doesNotMatch(metadata, /0{40}|sha256:0{64}/);

  for (const name of ['api', 'runtime', 'web', 'worker']) {
    const workload = documentFor('Deployment', name);
    assert.match(
      workload,
      new RegExp(`^ {8}envFrom:\n {8}- configMapRef:\n {12}name: ${metadataName}$`, 'm'),
    );
    assert.equal((workload.match(/envFrom:/g) ?? []).length, 1);
    assert.doesNotMatch(workload, /^\s*-\s*secretRef:/m);
  }

  const web = documentFor('Deployment', 'web');
  const nginx = text('infra/k8s/overlays/combo-dev/apps/nginx-dev.conf');
  const runtimeConfig = text('infra/web-runtime-config.sh');
  assert.match(web, /readOnlyRootFilesystem: true/);
  assert.match(web, /mountPath: \/var\/run[\s\S]*name: nginx-run/);
  assert.doesNotMatch(
    runtimeConfig,
    />"?\/usr\/share\/nginx\/html\/(?:try\/)?(?:runtime-config|version)\.json/,
  );
  for (const [endpoint, file] of [
    ['/runtime-config.json', 'runtime-config.json'],
    ['/version.json', 'version.json'],
    ['/try/runtime-config.json', 'try-runtime-config.json'],
  ]) {
    assert.match(
      nginx,
      new RegExp(
        `location = ${endpoint.replaceAll('/', '\\/')} \\{[\\s\\S]*?alias \\/var\\/run\\/combo-web\\/${file};`,
      ),
    );
  }
  assert.match(nginx, /alias \/usr\/share\/nginx\/html\/try\//);
  assert.doesNotMatch(nginx, /alias \/usr\/share\/nginx\/try\//);
  for (const prefix of ['/assets/', '/try/assets/']) {
    const escaped = prefix.replaceAll('/', '\\/');
    assert.match(
      nginx,
      new RegExp(
        `location \\^~ ${escaped} \\{[\\s\\S]*?try_files \\$uri =404;[\\s\\S]*?Cache-Control "public, max-age=31536000, immutable"`,
      ),
    );
  }

  const root = fixture();
  try {
    const deploy = join(root, 'scripts/combo-dev-deploy.sh');
    const source = readFileSync(deploy, 'utf8');
    assert.equal((source.match(/^immutable: true$/gm) ?? []).length, 1);
    writeFileSync(deploy, source.replace(/^immutable: true$/m, 'immutable: false'));
    expectRenderFailure(root, /guard:release-metadata-immutable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Test payment configuration is referenced only by Authoring API', () => {
  const paymentNames = [
    'BILLING_RECHARGE_PACKAGES_JSON',
    'LESHOUYING_ENABLED',
    'LESHOUYING_ENVIRONMENT',
    'LESHOUYING_PRODUCTION_ENABLED',
    'LESHOUYING_INSTITUTION_NO',
    'LESHOUYING_MERCHANT_NO',
    'LESHOUYING_INSTITUTION_KEY',
    'LESHOUYING_NOTIFY_URL',
    'LESHOUYING_FRONT_URL',
  ];
  const api = documentFor('Deployment', 'api');
  for (const name of paymentNames) {
    assert.match(
      api,
      new RegExp(
        `- name: ${name}\\n\\s+valueFrom:\\n\\s+secretKeyRef:\\n\\s+key: ${name}\\n\\s+name: combo-dev-env\\n\\s+optional: true`,
      ),
    );
  }
  for (const workloadName of ['worker', 'runtime']) {
    const workload = documentFor('Deployment', workloadName);
    for (const name of paymentNames) {
      assert.doesNotMatch(workload, new RegExp(`\\b${name}\\b`));
    }
  }
  assert.match(api, /- name: LESHOUYING_TIMEOUT_MS\n\s+value: "5000"/);
  assert.match(api, /- name: BILLING_RECONCILE_INTERVAL_MS\n\s+value: "15000"/);
  const runtime = documentFor('Deployment', 'runtime');
  assert.match(runtime, /- name: RUNTIME_BILLING_FREE_USES\n\s+value: "3"/);
  assert.match(runtime, /- name: RUNTIME_BILLING_UNIT_PRICE_CENTS\n\s+value: "100"/);
  for (const workloadName of ['api', 'worker']) {
    const workload = documentFor('Deployment', workloadName);
    assert.doesNotMatch(workload, /\bRUNTIME_BILLING_(?:FREE_USES|UNIT_PRICE_CENTS)\b/);
  }
  for (const workloadName of ['worker', 'runtime']) {
    const workload = documentFor('Deployment', workloadName);
    assert.doesNotMatch(workload, /\b(?:LESHOUYING_TIMEOUT_MS|BILLING_RECONCILE_INTERVAL_MS)\b/);
  }
});

test('Test migration pins the 0009 ledger and proves a second idempotent pass', () => {
  const migrate = documentFor('Job', 'migrate');
  assert.match(migrate, /^ {8}- name: EXPECTED_MIGRATION_HEAD\n {10}value: 0009_billing\.sql$/m);
  assert.match(migrate, /^ {8}- name: MIGRATION_RUNS\n {10}value: "2"$/m);
  assert.match(migrate, /^ {2}ttlSecondsAfterFinished: 7200$/m);
});

test('Test migration evidence uses the exact ordered 0000-0009 source ledger', () => {
  const expected = [
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
  const sourceLedger = readdirSync(join(repo, 'db/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.deepEqual(sourceLedger, expected);

  const deploy = text('scripts/combo-dev-deploy.sh');
  const workflow = text('.github/workflows/combo-dev.yml');
  const deployLists = [...deploy.matchAll(/expected_migrations = \[\n(?<body>[\s\S]*?)\n\]/g)].map(
    (match) => [...match.groups.body.matchAll(/'([^']+\.sql)'/g)].map((item) => item[1]),
  );
  assert.equal(deployLists.length, 2);
  for (const list of deployLists) assert.deepEqual(list, expected);

  const workflowList = workflow.match(
    /\.migration\.appliedMigrations == \[\n(?<body>[\s\S]*?)\n {12}\]/,
  );
  assert.ok(workflowList?.groups?.body);
  assert.deepEqual(
    [...workflowList.groups.body.matchAll(/"([^"]+\.sql)"/g)].map((item) => item[1]),
    expected,
  );

  assert.match(deploy, /if lines != expected_lines:\n {4}raise SystemExit\(2\)/);
  assert.match(deploy, /0017_\|0018_/);
  assert.doesNotMatch(`${deploy}\n${workflow}`, /0004_upload_bundle_protocol\.sql/);
  for (const list of [...deployLists, expected]) {
    assert.doesNotMatch(list.join('\n'), /(?:^|\n)001[78]_/);
  }
});

test('Test migration proof accepts containerd config digests but fences the live imageID', () => {
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-migration-proof-'));
  const deploy = text('scripts/combo-dev-deploy.sh');
  const captureStart = deploy.indexOf('capture_migration_proof() {');
  const captureEnd = deploy.indexOf('\nwait_apps() {', captureStart);
  const captureSource = deploy.slice(captureStart, captureEnd);
  const verifier = captureSource.match(/<<'PY'\n(?<source>[\s\S]*?)\nPY\n/)?.groups?.source;
  assert.ok(verifier);
  assert.match(captureSource, /local candidate="\$\{output\}\.next"/);
  assert.match(captureSource, /if python3 - \\/);
  assert.match(captureSource, /\[\[ -f "\$candidate" && ! -L "\$candidate" \]\] \|\| return 1/);
  assert.match(captureSource, /chmod 0600 "\$candidate" \|\| return 1/);
  assert.match(captureSource, /mv -T -- "\$candidate" "\$output" \|\| return 1/);
  assert.match(captureSource, /else\n {4}return 1\n {2}fi/);

  const revision = 'a'.repeat(40);
  const expectedDigest = digest('b');
  const expectedImage = `ghcr.io/dangdang-tech/combo-api@sha256:${expectedDigest}`;
  const reportedImage = `sha256:${digest('c')}`;
  const expectedHead = '0009_billing.sql';
  const jobUid = '11111111-1111-4111-8111-111111111111';
  const podUid = '22222222-2222-4222-8222-222222222222';
  const job = join(work, 'job.json');
  const pods = join(work, 'pods.json');
  const logs = join(work, 'migration.log');
  const output = join(work, 'proof.json');
  const expectedMigrations = [
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
  const jobObject = {
    metadata: {
      name: 'migrate',
      namespace: 'combo-preview',
      uid: jobUid,
      labels: { app: 'migrate' },
      creationTimestamp: '2026-07-25T14:00:00Z',
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 600,
      ttlSecondsAfterFinished: 7200,
      template: {
        spec: {
          containers: [
            {
              name: 'migrate',
              image: expectedImage,
              command: ['node', '--experimental-strip-types', 'db/scripts/migrate.ts'],
              env: [
                { name: 'EXPECTED_MIGRATION_HEAD', value: expectedHead },
                { name: 'MIGRATION_RUNS', value: '2' },
              ],
            },
          ],
        },
      },
    },
    status: {
      startTime: '2026-07-25T14:00:01Z',
      completionTime: '2026-07-25T14:00:04Z',
      succeeded: 1,
      conditions: [{ type: 'Complete', status: 'True' }],
    },
  };
  const podObject = {
    metadata: {
      name: 'migrate-proof1',
      namespace: 'combo-preview',
      uid: podUid,
      labels: { 'job-name': 'migrate' },
      ownerReferences: [
        {
          kind: 'Job',
          name: 'migrate',
          uid: jobUid,
          controller: true,
        },
      ],
    },
    spec: {
      containers: [{ name: 'migrate', image: expectedImage }],
    },
    status: {
      phase: 'Succeeded',
      containerStatuses: [
        {
          name: 'migrate',
          image: reportedImage,
          imageID: expectedImage,
          state: {
            terminated: {
              exitCode: 0,
              reason: 'Completed',
              startedAt: '2026-07-25T14:00:02Z',
              finishedAt: '2026-07-25T14:00:03Z',
            },
          },
        },
      ],
    },
  };
  const logLines = [
    ...expectedMigrations.map((name) => `applying ${name} ...`),
    `migration pass 1/2 up to date at ${expectedHead}.`,
    `migration pass 2/2 up to date at ${expectedHead}.`,
    'application database roles ready.',
  ];

  try {
    writeFileSync(job, JSON.stringify(jobObject));
    writeFileSync(pods, JSON.stringify({ items: [podObject] }));
    writeFileSync(logs, `${logLines.join('\n')}\n`);
    const args = ['-', revision, '123', '1', expectedImage, expectedHead, job, pods, logs, output];
    const accepted = spawnSync('python3', args, {
      input: verifier,
      encoding: 'utf8',
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    const proof = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(proof.pod.image, expectedImage);
    assert.equal(proof.pod.imageID, expectedImage);

    writeFileSync(logs, `${logLines.slice(0, -1).join('\n')}\n`);
    rmSync(output, { force: true });
    const missingRoleProof = spawnSync('python3', args, {
      input: verifier,
      encoding: 'utf8',
    });
    assert.equal(missingRoleProof.status, 2);
    assert.equal(existsSync(output), false);
    writeFileSync(logs, `${logLines.join('\n')}\n`);

    podObject.status.containerStatuses[0].imageID = `ghcr.io/dangdang-tech/combo-api@sha256:${digest('d')}`;
    writeFileSync(pods, JSON.stringify({ items: [podObject] }));
    rmSync(output, { force: true });
    const rejected = spawnSync('python3', args, {
      input: verifier,
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 2);
    assert.equal(existsSync(output), false);

    podObject.status.containerStatuses[0].imageID = expectedImage;
    podObject.spec.containers[0].image = `ghcr.io/dangdang-tech/combo-api@sha256:${digest('e')}`;
    writeFileSync(pods, JSON.stringify({ items: [podObject] }));
    const wrongSpec = spawnSync('python3', args, {
      input: verifier,
      encoding: 'utf8',
    });
    assert.equal(wrongSpec.status, 2);
    assert.equal(existsSync(output), false);

    podObject.spec.containers[0].image = expectedImage;
    podObject.metadata.ownerReferences[0].uid = '33333333-3333-4333-8333-333333333333';
    writeFileSync(pods, JSON.stringify({ items: [podObject] }));
    const wrongOwner = spawnSync('python3', args, {
      input: verifier,
      encoding: 'utf8',
    });
    assert.equal(wrongOwner.status, 2);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Test live image evidence binds PodSpec and imageID without trusting runtime aliases', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const liveStart = deploy.indexOf('expected_images = {');
  const liveEnd = deploy.indexOf('\ninventory_keys = {', liveStart);
  const liveVerifier = deploy.slice(liveStart, liveEnd);
  assert.match(liveVerifier, /containers\[0\]\.get\('image'\) != expected_image/);
  assert.match(
    liveVerifier,
    /not digest_matches\(statuses\[0\]\.get\('imageID'\), expected_image\)/,
  );
  assert.doesNotMatch(liveVerifier, /statuses\[0\]\.get\('image'\)/);
});

test('Manual PR Test publishes branch-only sanitized evidence before SSH cleanup', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const storageGuard = text('scripts/combo-dev-storage-guard.sh');
  const storageGuardUnit = text('infra/host/combo-dev/combo-dev-storage-guard.service');
  const evidence = workflow.indexOf('Collect and verify sanitized Test evidence');
  const cleanup = workflow.indexOf('Remove transient runner and upload files');
  assert.ok(evidence > 0 && cleanup > evidence);
  assert.match(
    workflow,
    /evidence_artifact_name="combo-branch-test-evidence-\$\{REVISION\}-\$\{RUN_ATTEMPT\}"/,
  );
  assert.doesNotMatch(
    workflow,
    /evidence_artifact_name="combo-test-evidence-\$\{REVISION\}-\$\{RUN_ATTEMPT\}"/,
  );
  assert.match(workflow, /name: \$\{\{ steps\.evidence\.outputs\.artifact_name \}\}/);
  assert.match(workflow, /--arg sourceBranch "\$SOURCE_BRANCH"/);
  assert.match(workflow, /--arg sourceEvent "\$SOURCE_EVENT"/);
  assert.match(workflow, /--arg sourceWorkflow "\$SOURCE_WORKFLOW"/);
  assert.match(workflow, /sourceWorkflow: \$sourceWorkflow/);
  assert.match(workflow, /sourceEvent: \$sourceEvent/);
  assert.match(workflow, /sourceBranch: \$sourceBranch/);
  assert.match(workflow, /sourceConclusion: \$sourceConclusion/);
  assert.match(workflow, /controllerSha: \$controllerSha/);
  assert.match(workflow, /sourceMode: \$sourceMode/);
  assert.match(workflow, /source_conclusion=release-job-success/);
  assert.doesNotMatch(workflow, /source_conclusion=success/);
  assert.match(workflow, /\.sourceConclusion == \$sourceConclusion/);
  assert.match(workflow, /\.controllerSha == \$controllerSha/);
  assert.match(workflow, /\.sourceMode == \$sourceMode/);
  assert.match(
    workflow,
    /--revision "\$revision"[\s\\\n]*--workflow-run-id "\$workflow_run_id"[\s\\\n]*--workflow-run-attempt "\$workflow_run_attempt"/,
  );
  assert.match(workflow, /\.workflowRunId == \$runId/);
  assert.match(workflow, /\.workflowRunAttempt == \$runAttempt/);
  assert.match(workflow, /\.reset\.workflowRunId == \$runId/);
  assert.match(workflow, /\.reset\.workflowRunAttempt == \$runAttempt/);
  assert.match(workflow, /\.migration\.workflowRunId == \$runId/);
  assert.match(workflow, /\.migration\.workflowRunAttempt == \$runAttempt/);
  assert.match(workflow, /migration\.head == "0009_billing\.sql"/);
  assert.match(workflow, /migration\.job\.ttlSecondsAfterFinished == 7200/);
  assert.match(workflow, /legacyObjectsAbsent == true/);
  assert.doesNotMatch(workflow, /\. \+ \{workflowRunId:/);
  assert.match(deploy, /readonly NAMESPACE='combo-preview'/);
  assert.match(
    deploy,
    /write_test_evidence[\s\\\n]*"\$revision" "\$workflow_run_id" "\$workflow_run_attempt"[\s\\\n]*"\$manifest" "\$digest_file" "\$RESET_PROOF_IN_USE" "\$migration_proof"/,
  );
  assert.match(deploy, /local evidence_dir='\/var\/lib\/combo-dev\/evidence'/);
  assert.match(
    deploy,
    /local output="\$evidence_dir\/\$\{revision\}\.\$\{workflow_run_id\}\.\$\{workflow_run_attempt\}\.json"/,
  );
  for (const control of [bootstrap, deploy, reset, storageGuard]) {
    assert.doesNotMatch(control, /install -d -o root -g root -m 0700 \/var\/lib\/combo-dev/);
    assert.match(control, /install -d -o root -g root -m 0711 \/var\/lib\/combo-dev/);
  }
  assert.doesNotMatch(bootstrap, /install -d[^\n]*\/var\/lib\/combo-dev\/evidence/);
  assert.match(bootstrap, /verify_control_state \|\| return 1/);
  assert.match(bootstrap, /FSROOT[\s\S]*'\/evidence'/);
  assert.match(storageGuardUnit, /^StateDirectory=combo-dev$/m);
  assert.match(storageGuardUnit, /^StateDirectoryMode=0711$/m);
  assert.doesNotMatch(storageGuardUnit, /^StateDirectoryMode=0700$/m);
  assert.match(deploy, /stat -c '%u:%g:%a' "\$evidence_dir"[\s\S]*'0:0:755'/);
  assert.match(deploy, /install -o root -g root -m 0644 "\$candidate" "\$output"/);
  assert.match(deploy, /mv -T -- "\$RESET_PROOF" "\$CONSUMED_RESET_PROOF"/);
  assert.match(deploy, /RESET_PROOF_MAX_AGE_SECONDS=900/);
  assert.match(
    deploy,
    /RESET_PROOF="\/var\/lib\/combo-dev\/reset-proof\.\$\{revision\}\.\$\{workflow_run_id\}\.\$\{workflow_run_attempt\}\.json"/,
  );
  assert.match(reset, /install -o root -g root -m 0600 "\$candidate" "\$RESET_PROOF"/);
  assert.match(reset, /assert_static_volume_data_empty/);
  assert.match(reset, /capture_rebuilt_foundation/);
  assert.match(reset, /'workflowRunId': workflow_run_id/);
  assert.match(reset, /'workflowRunAttempt': workflow_run_attempt/);
  assert.match(deploy, /'workflowRunAttempt': workflow_run_attempt/);
  assert.match(deploy, /capture_migration_proof/);
  assert.match(deploy, /lines != expected_lines/);
  assert.match(deploy, /'logSha256': f"sha256:/);
  assert.doesNotMatch(deploy, /freshResetRequiredByWorkflow/);
  assert.doesNotMatch(deploy, /'jobSucceeded': True/);
  assert.doesNotMatch(
    deploy.slice(
      deploy.indexOf('write_test_evidence() {'),
      deploy.indexOf('prune_stale_configs() {'),
    ),
    /combo-review|Kubernetes Secrets|PRODUCTION_NAMESPACE|PRODUCTION_KUBECONFIG|productAcceptance/,
  );
});

test('Test host gate remains credential-free and leaves product acceptance to trusted workflow control', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  const workflow = text('.github/workflows/combo-dev.yml');
  const dispatcherStart = workflow.indexOf(
    'Upload the fixed bundle and invoke the root-owned dispatcher',
  );
  const dispatcherEnd = workflow.indexOf('Prove development ports remain private', dispatcherStart);
  const dispatcherStep = workflow.slice(dispatcherStart, dispatcherEnd);

  assert.doesNotMatch(deploy, /ACCEPTANCE_RUNNER|\/opt\/combo-dev\/acceptance\/run/);
  assert.doesNotMatch(deploy, /productAcceptance|acceptance_path|acceptance = load/);
  assert.match(deploy, /combo-dev-smoke"[\s\\\n]*--revision "\$revision" --since-time "\$start"/);
  assert.doesNotMatch(smoke, /validate_external_evidence|--evidence|browser_auth/);
  assert.match(smoke, /check_loopback_only[\s\S]*check_logs_fail_closed "\$since" baseline/);
  assert.match(
    smoke,
    /logs_only == 1[\s\S]*verify_pending_acceptance_identity[\s\S]*check_logs_fail_closed "\$since" product/,
  );
  assert.match(dispatcherStep, /id: deploy_test/);
  assert.match(dispatcherStep, /deployment_completed=true/);
  assert.ok(
    dispatcherStep.indexOf('sudo /opt/combo-dev/bin/combo-dev-deploy') <
      dispatcherStep.indexOf("printf 'deployment_completed=true"),
  );
  assert.doesNotMatch(dispatcherStep, /mutation_started/);
  assert.doesNotMatch(dispatcherStep, /ACCEPTANCE_RESEND_API_KEY|resend-sent-email/);
});

test('Test runs and validates the exact release artifact six-area browser acceptance', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const checkout = workflow.indexOf('Check out the trusted main Test controller');
  const setupNode = workflow.indexOf('Use Node 24 for release artifact validation');
  const installDependencies = workflow.indexOf('Install trusted Test control dependencies');
  const download = workflow.indexOf('Download the immutable release artifact');
  const deploy = workflow.indexOf('Upload the fixed bundle and invoke the root-owned dispatcher');
  const live = workflow.indexOf('Run the exact artifact six-area Test browser acceptance');
  const failureUpload = workflow.indexOf('Upload sanitized Test browser failure evidence');
  const failureStop = workflow.indexOf('Fail Test after preserving browser failure evidence');
  const evidence = workflow.indexOf('Collect and verify sanitized Test evidence');
  const upload = workflow.indexOf('Upload sanitized Test evidence');
  const accept = workflow.indexOf('Complete the exact Test acceptance');
  const fence = workflow.indexOf('Fence Test after post-deploy acceptance failure');
  const cleanup = workflow.indexOf('Remove transient runner and upload files');
  assert.ok(
    checkout > 0 &&
      setupNode > checkout &&
      installDependencies > setupNode &&
      download > installDependencies &&
      deploy > download &&
      live > deploy &&
      failureUpload > live &&
      failureStop > failureUpload &&
      evidence > failureStop &&
      upload > evidence &&
      accept > upload &&
      fence > accept &&
      cleanup > fence,
  );
  assert.match(
    workflow,
    /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020[\s\S]*node-version: 24/,
  );
  assert.match(workflow.slice(workflow.indexOf('\n  deploy:'), checkout), /timeout-minutes: 300/);
  const deployJob = workflow.slice(workflow.indexOf('\n  deploy:'));
  assert.match(
    deployJob,
    /Check out the trusted main Test controller[\s\S]*ref: \$\{\{ needs\.authorize\.outputs\.controller_sha \}\}/,
  );
  assert.doesNotMatch(
    deployJob.slice(0, download),
    /ref: \$\{\{ needs\.(?:select|authorize)\.outputs\.revision \}\}/,
  );
  assert.match(deployJob, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(deployJob, /node scripts\/release-manifest\.mjs verify/);
  assert.match(deployJob, /node scripts\/web-asset-manifest\.mjs verify/);

  const liveStep = workflow.slice(live, failureUpload);
  assert.match(liveStep, /runner=scripts\/goal-b-test-acceptance\.mjs/);
  assert.match(liveStep, /resend_reader=scripts\/resend-sent-email\.mjs/);
  assert.match(liveStep, /validator=scripts\/promotion-evidence\.mjs/);
  assert.match(liveStep, /playwright_dir=scripts\/node_modules\/playwright-core/);
  assert.match(liveStep, /trusted_acceptance="\$RUNNER_TEMP\/trusted-test-acceptance"/);
  assert.match(
    liveStep,
    /ACCEPTANCE_RESEND_API_KEY: \$\{\{ secrets\.ACCEPTANCE_RESEND_API_KEY \}\}/,
  );
  assert.match(
    liveStep,
    /install -m 0600[\s\\\n]*"\$runner"[\s\\\n]*"\$trusted_acceptance\/acceptance\/live-browser-acceptance\.mjs"/,
  );
  assert.match(
    liveStep,
    /tar -C "\$trusted_acceptance" -czf "\$archive"[\s\\\n]*acceptance\/live-browser-acceptance\.mjs[\s\\\n]*acceptance\/playwright-core\.tgz[\s\\\n]*acceptance\/resend-sent-email\.mjs/,
  );
  assert.doesNotMatch(liveStep, /\$RELEASE_ROOT\/(?:acceptance|scripts)\//);
  assert.match(liveStep, /--environment test/);
  assert.match(liveStep, /test_web_origin=https:\/\/test\.43-160-242-46\.sslip\.io/);
  assert.match(liveStep, /test_s3_origin=https:\/\/test-s3\.43-160-242-46\.sslip\.io/);
  assert.match(liveStep, /--web-origin https:\/\/test\.43-160-242-46\.sslip\.io/);
  assert.match(liveStep, /--output "\$output"/);
  assert.match(liveStep, /acceptance\/resend-sent-email\.mjs/);
  assert.match(
    liveStep,
    /printf '%s\\n' "\$ACCEPTANCE_RESEND_API_KEY"[\s\S]*IFS= read -r acceptance_resend_api_key; export ACCEPTANCE_RESEND_API_KEY/,
  );
  assert.match(liveStep, /unset ACCEPTANCE_RESEND_API_KEY/);
  assert.match(liveStep, /nvm_script="\$HOME\/\.nvm\/nvm\.sh"/);
  assert.match(liveStep, /\[\[ -f "\$nvm_script" && ! -L "\$nvm_script" \]\]/);
  assert.match(liveStep, /nvm use --silent 24 >\/dev\/null/);
  assert.match(liveStep, /node_major[\s\S]*\[\[ "\$node_major" == 24 \]\]/);
  assert.match(liveStep, /\[\[ "\$\(stat -c '%a' "\$output"\)" == 600 \]\]/);
  assert.match(liveStep, /runner_rc=\$\?/);
  assert.match(liveStep, /\[\[ "\$runner_rc" == 0 \|\| "\$runner_rc" == 1 \]\]/);
  assert.match(
    liveStep,
    /validate-live-browser-failure[\s\\\n]*--environment test[\s\\\n]*--evidence "\$evidence"[\s\\\n]*--identity "\$identity"/,
  );
  assert.match(liveStep, /printf 'acceptance_status=%s\\n' "\$acceptance_status"/);
  assert.match(
    liveStep,
    /combo-test-failure-evidence-\$\{REVISION\}-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}/,
  );
  assert.match(
    liveStep,
    /validate-live-browser[\s\\\n]*--environment test[\s\\\n]*--evidence "\$evidence"[\s\\\n]*--identity "\$identity"/,
  );
  assert.match(liveStep, /deploymentWorkflow: "\.github\/workflows\/combo-dev\.yml"/);
  assert.match(liveStep, /deploymentRunId: \$deploymentRunId/);
  assert.match(liveStep, /deploymentRunAttempt: \$deploymentRunAttempt/);
  assert.match(liveStep, /sourceCiRunId: \$sourceCiRunId/);
  assert.match(liveStep, /sourceCiRunAttempt: \$sourceCiRunAttempt/);
  assert.match(liveStep, /releaseArtifactId: \$releaseArtifactId/);
  assert.match(liveStep, /releaseArtifactDigest: \$releaseArtifactDigest/);
  assert.match(
    liveStep,
    /combo-dev-publication[\s\\\n]*--open-pending "\$REVISION" "\$RUN_ID" "\$RUN_ATTEMPT"/,
  );
  assert.match(liveStep, /public_ready == 1/);
  assert.match(liveStep, /"\$test_web_origin\/version\.json"/);
  assert.match(liveStep, /"\$test_s3_origin\/minio\/health\/ready"/);
  assert.match(liveStep, /access-control-allow-origin: \$test_web_origin/);
  assert.doesNotMatch(liveStep, /combo-dev-forwarder-lease|release_forwarder_lease/);
  assert.ok(liveStep.indexOf('public_ready == 1') < liveStep.indexOf('node "$runner"'));
  assert.match(
    liveStep,
    /combo-dev-smoke[\s\\\n]*--logs-only[\s\\\n]*--revision "\$revision"[\s\\\n]*--since-time "\$product_started_at"[\s\\\n]*--workflow-run-id "\$workflow_run_id"[\s\\\n]*--workflow-run-attempt "\$workflow_run_attempt"/,
  );
  assert.match(liveStep, /product_started_at=\$\(ssh combo-dev-target date -u/);
  assert.ok(liveStep.indexOf('product_started_at=') < liveStep.indexOf('node "$runner"'));
  assert.ok(liveStep.indexOf('node "$runner"') < liveStep.indexOf('--logs-only'));
  assert.doesNotMatch(
    liveStep,
    /sudo (?:-- )?systemctl (?:start|stop) combo-dev-(?:web|s3)-forward/,
  );
  assert.doesNotMatch(liveStep, /docker|COMBO_PRODUCTION_ACCEPTANCE|CLOUD_REVIEW_ACCESS_TOKEN/);
  assert.doesNotMatch(
    `${workflow.slice(0, live)}${workflow.slice(evidence)}`,
    /ACCEPTANCE_RESEND_API_KEY/,
  );

  const failureSteps = workflow.slice(failureUpload, evidence);
  assert.match(
    failureSteps,
    /always\(\) && steps\.live_browser\.outputs\.acceptance_status == 'failed'/,
  );
  assert.match(
    failureSteps,
    /name: combo-test-failure-evidence-\$\{\{ needs\.authorize\.outputs\.revision \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(failureSteps, /path: \$\{\{ steps\.live_browser\.outputs\.failure_path \}\}/);
  assert.match(
    failureSteps,
    /always\(\) && steps\.live_browser\.outputs\.acceptance_status == 'failed'/,
  );
  assert.doesNotMatch(failureSteps, /combo-test-evidence-\$\{\{/);
  assert.doesNotMatch(failureSteps, /source-release\.json|ACCEPTANCE_RESEND_API_KEY/);

  const evidenceStep = workflow.slice(evidence, upload);
  assert.match(evidenceStep, /if: steps\.live_browser\.outputs\.acceptance_status == 'passed'/);
  assert.doesNotMatch(evidenceStep, /all\(\.productAcceptance|\.productAcceptance\[\]/);
  assert.doesNotMatch(evidenceStep, /del\(\.productAcceptance\)/);
  assert.match(evidenceStep, /has\("productAcceptance"\) \| not/);
  assert.match(evidenceStep, /test-live-browser-acceptance\.json/);
  assert.match(evidenceStep, /test-promotion-identity\.json/);
  assert.match(evidenceStep, /liveBrowserAcceptanceDigest/);
  assert.match(evidenceStep, /testIdentityDigest/);
  assert.match(evidenceStep, /controllerSha: \$controllerSha/);
  assert.match(evidenceStep, /sourceMode: \$sourceMode/);
  assert.match(evidenceStep, /validate-live-browser/);
  assert.match(evidenceStep, /validate-identity/);
  assert.match(evidenceStep, /\.workflowRunAttempt == \$runAttempt/);
  assert.match(
    evidenceStep,
    /\/var\/lib\/combo-dev\/evidence\/\$\{REVISION\}\.\$\{RUN_ID\}\.\$\{RUN_ATTEMPT\}\.json/,
  );
  assert.match(
    evidenceStep,
    /"combo-test-evidence-\$\{REVISION\}\.json"[\s\\\n]*source-release\.json[\s\\\n]*test-live-browser-acceptance\.json[\s\\\n]*test-promotion-identity\.json/,
  );
  assert.match(evidenceStep, /cmp -s "\$expected_files" "\$actual_files"/);

  const acceptStep = workflow.slice(accept, fence);
  assert.match(acceptStep, /id: accept_test/);
  assert.match(
    acceptStep,
    /combo-dev-storage-guard[\s\\\n]*--complete-acceptance "\$REVISION" "\$RUN_ID" "\$RUN_ATTEMPT"/,
  );

  const fenceStep = workflow.slice(fence, cleanup);
  assert.match(
    fenceStep,
    /always\(\) && steps\.deploy_test\.outputs\.deployment_completed == 'true' && steps\.accept_test\.outcome != 'success'/,
  );
  assert.match(fenceStep, /timeout-minutes: 15/);
  assert.match(
    fenceStep,
    /combo-dev-storage-guard[\s\\\n]*--fence-attempt "\$REVISION" "\$RUN_ID" "\$RUN_ATTEMPT"/,
  );
  assert.doesNotMatch(fenceStep, /combo-dev-reset|flock|reset-proof/);
  assert.doesNotMatch(fenceStep, /ACCEPTANCE_RESEND_API_KEY|kubectl|combo-review|namespace\/combo/);

  const cleanupStep = workflow.slice(cleanup);
  assert.match(cleanupStep, /if: always\(\)/);
  assert.match(
    cleanupStep,
    /\/opt\/combo-dev\/incoming\/\$\{REVISION\}\.\$\{RUN_ID\}\.\$\{RUN_ATTEMPT\}\.tar\.gz/,
  );
  assert.match(
    cleanupStep,
    /\/opt\/combo-dev\/incoming\/\$\{REVISION\}\.acceptance\.\$\{RUN_ID\}\.\$\{RUN_ATTEMPT\}\.tar\.gz/,
  );
  assert.match(
    cleanupStep,
    /data\/combo-acceptance\/test\/\$\{REVISION\}\.\$\{RUN_ID\}\.\$\{RUN_ATTEMPT\}\.json/,
  );
  assert.match(cleanupStep, /combo-dev-live-browser-\$\{REVISION\}\.tar\.gz/);
  assert.match(cleanupStep, /combo-test-live-browser-\$\{REVISION\}\.json/);
  assert.match(cleanupStep, /combo-test-identity-\$\{REVISION\}\.json/);
  assert.match(cleanupStep, /"\$RUNNER_TEMP\/combo-release\.zip"/);
  assert.match(cleanupStep, /"\$RUNNER_TEMP\/combo-release"/);
  assert.match(
    cleanupStep,
    /rm -rf --[\s\\\n]*"\$RUNNER_TEMP\/combo-release"[\s\\\n]*"\$RUNNER_TEMP\/combo-test-evidence-\$\{REVISION\}"/,
  );
  assert.match(
    cleanupStep,
    /combo-test-failure-evidence-\$\{REVISION\}-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}/,
  );
  assert.match(cleanupStep, /if ! rm -f --/);
  assert.match(cleanupStep, /if ! rm -rf --/);
  assert.match(cleanupStep, /exit "\$cleanup_rc"/);
});

test('Preview consumes Main CD directly while Test remains an independent manual PR flow', () => {
  const preview = text('.github/workflows/preview.yml');
  const testWorkflow = text('.github/workflows/combo-dev.yml');
  const policyStart = preview.indexOf('  policy:');
  const deployStart = preview.indexOf('\n  deploy:', policyStart);
  const policy = preview.slice(policyStart, deployStart);
  const modeCheck = policy.indexOf('case "$MODE" in');
  const outputWrite = policy.indexOf("printf 'mode=%s");
  assert.ok(
    policyStart >= 0 && deployStart > policyStart && modeCheck > 0 && outputWrite > modeCheck,
  );
  assert.match(preview, /workflows: \[Main CD\]/);
  assert.match(policy, /\.name == "Main CD"/);
  assert.match(policy, /\.path == "\.github\/workflows\/ci\.yml"/);
  assert.match(policy, /\.event == "push"/);
  assert.match(policy, /\.head_branch == "main"/);
  assert.match(policy, /\.head_sha == \$revision/);
  assert.match(policy, /\.status == "completed"/);
  assert.match(policy, /\.conclusion == "success"/);
  assert.match(policy, /actions\/runs\/\$\{SOURCE_RUN_ID\}\/artifacts/);
  assert.match(policy, /\.name == "assemble immutable release artifact"/);
  assert.match(policy, /\$releaseJobs\[0\]\.started_at <= \$artifactCreatedAt/);
  assert.match(policy, /\$artifactCreatedAt <= \$releaseJobs\[0\]\.completed_at/);
  assert.match(
    policy,
    /paused\)\n\s+echo 'Preview automatic promotion is explicitly paused by repository policy\.'\n\s+;;/,
  );
  assert.match(preview, /if: needs\.policy\.outputs\.mode == 'enabled'/);
  assert.doesNotMatch(preview, /combo-dev\.yml|combo-test-evidence|TEST_EVIDENCE|TEST_RUN/);
  assert.doesNotMatch(preview, /automatic Test|test_admission|testEvidence|testRunId/);

  const testTriggers = testWorkflow.slice(
    testWorkflow.indexOf('on:\n'),
    testWorkflow.indexOf('\npermissions:'),
  );
  assert.match(testTriggers, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(testTriggers, /workflow_run|push:|pull_request:/);
  assert.match(testWorkflow, /pull_request_number:[\s\S]*revision:/);
  assert.match(testWorkflow, /\.state == "open"/);
  assert.match(testWorkflow, /\.base\.ref == "main"/);
  assert.match(testWorkflow, /\.head\.sha == \$revision/);
  assert.match(testWorkflow, /\.head\.repo\.full_name == \$repository/);
  assert.match(testWorkflow, /evidence_artifact_name="combo-branch-test-evidence-/);
  assert.doesNotMatch(testWorkflow, /evidence_artifact_name="combo-test-evidence-/);

  const sshSetup = preview.indexOf(
    '      - name: Configure the existing deployment SSH identity',
    deployStart,
  );
  const preflight = preview.indexOf(
    '      - name: Preflight the tecent2 release host without mutation',
    sshSetup,
  );
  const cas = preview.indexOf(
    '      - name: Revalidate all frozen admissions immediately before the first Preview mutation',
    preflight,
  );
  const firstMutation = preview.indexOf(
    '      - name: Check the existing Preview registry credential',
    cas,
  );
  assert.ok(preflight > sshSetup && cas > preflight && firstMutation > cas);
  assert.equal(preview.indexOf('\n      - name:', cas + 1) + 1, firstMutation);
  const beforeCas = preview.slice(deployStart, cas);
  assert.doesNotMatch(beforeCas, /kubectl[\s\S]{0,120}\brun "\$name"/);
  assert.doesNotMatch(beforeCas, /create secret docker-registry/);
  assert.doesNotMatch(beforeCas, /kubectl[\s\S]{0,120}\bapply -f/);
  assert.doesNotMatch(beforeCas, /scp -q/);
  const casStep = preview.slice(cas, firstMutation);
  assert.match(casStep, /git\/ref\/heads\/main/);
  assert.match(casStep, /POLICY_MODE: \$\{\{ needs\.policy\.outputs\.mode \}\}/);
  assert.match(casStep, /ADMISSION_MODE: \$\{\{ vars\.COMBO_PREVIEW_AUTO_PROMOTION_MODE \}\}/);
  assert.match(casStep, /\[\[ "\$POLICY_MODE" == enabled \]\]/);
  assert.match(casStep, /\[\[ "\$ADMISSION_MODE" == enabled \]\]/);
  assert.match(casStep, /actions\/runs\/\$\{SOURCE_RUN_ID\}/);
  assert.match(casStep, /\.name == "Main CD"/);
  assert.match(casStep, /\.run_attempt == \$runAttempt/);
  assert.match(casStep, /actions\/artifacts\/\$\{SOURCE_ARTIFACT_ID\}/);
  assert.match(casStep, /\.digest == \$digest/);

  const promotionStart = preview.indexOf('      - name: Create Preview promotion evidence');
  const promotionEnd = preview.indexOf(
    '      - name: Upload the Production admission evidence',
    promotionStart,
  );
  const promotion = preview.slice(promotionStart, promotionEnd);
  assert.match(promotion, /schemaVersion: 5/);
  assert.doesNotMatch(
    promotion,
    /testRun|testEvidence|testIdentity|testBrowser|testSource|testDeployment/,
  );

  const cleanupStart = preview.indexOf('      - name: Remove transient SSH and bundle files');
  const cleanup = preview.slice(cleanupStart);
  assert.match(cleanup, /if: always\(\)/);
  assert.match(cleanup, /cleanup_probes\(\)/);
  assert.match(cleanup, /preconditions: \{uid: \$uid\}/);
  assert.match(cleanup, /combo-preview-pull-\$\{run_id\}-\$\{run_attempt\}/);
  assert.match(cleanup, /combo-preview-pull-\$\{run_id\}-\$\{run_attempt\}-retry/);
  assert.match(cleanup, /"\$RUNNER_TEMP\/combo-release"/);
  assert.match(cleanup, /"\$RUNNER_TEMP\/preview-remote-evidence"/);
  assert.match(cleanup, /if ! rm -f --/);
  assert.match(cleanup, /if ! rm -rf --/);
  assert.match(cleanup, /exit "\$cleanup_rc"/);
  assert.doesNotMatch(cleanup, /\|\| true/);

  assert.doesNotMatch(
    `${testWorkflow}\n${preview}`,
    /(?:^|\n)\s*docker\s+(?:build|compose|info|inspect|pull|push|run)\b/m,
  );
});

test('Test evidence inventories every relevant namespaced kind without reading Secrets', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const rbac = text('infra/k8s/overlays/combo-dev/platform/rbac.yaml');
  const evidenceWriter = deploy.slice(
    deploy.indexOf('write_test_evidence() {'),
    deploy.indexOf('prune_stale_configs() {'),
  );
  for (const resource of [
    'deployments.apps',
    'statefulsets.apps',
    'daemonsets.apps',
    'jobs.batch',
    'cronjobs.batch',
    'services',
    'pods',
    'configmaps',
    'serviceaccounts',
    'networkpolicies.networking.k8s.io',
    'ingresses.networking.k8s.io',
    'horizontalpodautoscalers.autoscaling',
    'roles.rbac.authorization.k8s.io',
    'rolebindings.rbac.authorization.k8s.io',
    'resourcequotas',
    'limitranges',
    'persistentvolumeclaims',
  ]) {
    assert.ok(evidenceWriter.includes(resource), resource);
  }
  assert.doesNotMatch(evidenceWriter, /\bget\s+[^\n]*\bsecrets?\b/i);
  assert.match(evidenceWriter, /resource_inventory\['excludedKinds'\] = \['Secret'\]/);
  assert.match(evidenceWriter, /'DaemonSet': set\(\)/);
  assert.match(evidenceWriter, /'CronJob': set\(\)/);
  assert.match(evidenceWriter, /'Ingress': set\(\)/);
  assert.match(evidenceWriter, /'HorizontalPodAutoscaler': set\(\)/);

  const secretRules = [
    ...rbac.matchAll(
      /- apiGroups: \[''\]\n {4}resources: \['secrets'\]\n {4}resourceNames: \[([^\]]+)\]\n {4}verbs: \[([^\]]+)\]/g,
    ),
  ];
  assert.equal(secretRules.length, 0);
  for (const rule of [
    "resources: ['serviceaccounts', 'resourcequotas', 'limitranges']\n    verbs: ['get', 'list', 'watch']",
    "resources: ['daemonsets']\n    verbs: ['get', 'list', 'watch', 'delete']",
    "resources: ['replicasets']\n    verbs: ['get', 'list', 'watch', 'delete']",
    "resources: ['replicationcontrollers']\n    verbs: ['get', 'list', 'watch', 'delete']",
    "resources: ['cronjobs']\n    verbs: ['get', 'list', 'watch', 'delete']",
    "resources: ['ingresses']\n    verbs: ['get', 'list', 'watch']",
    "resources: ['horizontalpodautoscalers']\n    verbs: ['get', 'list', 'watch', 'delete']",
  ]) {
    assert.ok(rbac.includes(rule), rule);
  }
});

test('control scripts never directly get, list, or delete a Secret', () => {
  for (const path of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-smoke.sh',
    'scripts/combo-dev-logs.sh',
    'scripts/combo-dev-storage-guard.sh',
    'scripts/combo-dev-forwarder-lease.sh',
  ]) {
    const normalized = text(path).replaceAll(/\\\n\s*/g, ' ');
    const commands = [
      ...normalized.matchAll(/(?:"\$\{(?:AK|K|DK|FK|PK)\[@\]\}"|\bkubectl\b)([^\n;|]{0,500})/g),
    ].map((match) => match[0]);
    for (const command of commands) {
      assert.doesNotMatch(
        command,
        /\b(?:get|delete)\b[^\n;|]*\bsecrets?(?:\/|\b)/i,
        `${path}: ${command}`,
      );
    }
  }
});

test('root-side release validation rejects a boolean schema version', () => {
  const root = fixture();
  try {
    const output = join(root, 'out.yaml');
    const invalid = clone(RELEASE_MANIFEST);
    invalid.schemaVersion = true;
    const releaseArgs = writeReleaseFixture(root, invalid);
    const result = spawnSync(
      'bash',
      [
        join(root, 'scripts/combo-dev-deploy.sh'),
        '--render-only',
        '--output',
        output,
        ...imageArgs,
        ...releaseArgs,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /render-only 发布清单校验失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Restricted combo-preview workloads reject every hostPath injection', () => {
  const namespace = text('infra/k8s/overlays/combo-dev/platform/namespace.yaml');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  const jobProbe = deploy.slice(
    deploy.indexOf('server_preflight() {'),
    deploy.indexOf('apply_and_wait_foundation() {'),
  );
  const networkCanary = smoke.slice(
    smoke.indexOf('run_network_canary() {'),
    smoke.indexOf('check_logs_fail_closed() {'),
  );
  assert.match(namespace, /pod-security\.kubernetes\.io\/enforce: restricted/);
  assert.equal(rendered.includes('hostPath:'), false);
  assert.doesNotMatch(jobProbe, /^\s+hostPath:/m);
  assert.doesNotMatch(networkCanary, /^\s+hostPath:/m);

  const root = fixture();
  try {
    const resources = join(root, 'infra/k8s/overlays/combo-dev/apps/resources.yaml');
    const source = readFileSync(resources, 'utf8');
    writeFileSync(
      resources,
      source.replace(
        '      volumes:\n        - configMap:\n            name: combo-dev-nginx',
        '      volumes:\n        - hostPath:\n            path: /tmp\n            type: Directory\n          name: forbidden-host\n        - configMap:\n            name: combo-dev-nginx',
      ),
    );
    expectRenderFailure(root, /guard:(?:forbidden|workload-hostpath)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PostgreSQL migration supports fresh, legacy, repeat, and fail-closed partial starts', () => {
  const postgres = documentFor('StatefulSet', 'postgres');
  const migration = text('infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh');
  assert.match(postgres, /name: PGDATA\n\s+value: \/var\/lib\/postgresql\/data\/pgdata/);
  assert.match(postgres, /\/opt\/combo-dev\/postgres-entrypoint\.sh/);
  assert.match(postgres, /runAsUser: 70/);
  assert.match(postgres, /runAsGroup: 70/);
  assert.match(migration, /\.combo-dev-pgdata-migration/);
  assert.doesNotMatch(migration, /-printf|-print0|read\s+-[^\n]*d/);
  assert.ok(
    migration.indexOf('"$mover" -- "$root/PG_VERSION"') > migration.indexOf('for source in'),
  );
  assert.match(migration, /\[\[ ! -e "\$state" \]\] \|\| block/);

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-postgres-'));
  try {
    const entrypoint = join(work, 'entrypoint');
    const mover = join(work, 'mover');
    const count = join(work, 'move-count');
    writeFileSync(entrypoint, '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(
      mover,
      `#!/usr/bin/env bash
set -eu
n=0
[[ ! -f "$MOVE_COUNT" ]] || n=$(cat "$MOVE_COUNT")
n=$((n+1))
printf '%s\\n' "$n" >"$MOVE_COUNT"
(( n != 2 )) || exit 9
exec mv "$@"
`,
    );
    chmodSync(entrypoint, 0o755);
    chmodSync(mover, 0o755);
    const script = join(repo, 'infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh');
    const run = (root, selectedMover = '/bin/mv', extra = {}) =>
      spawnSync('bash', [script], {
        env: {
          ...process.env,
          COMBO_DEV_POSTGRES_DATA_ROOT: root,
          PGDATA: join(root, 'pgdata'),
          COMBO_DEV_POSTGRES_ENTRYPOINT: entrypoint,
          COMBO_DEV_POSTGRES_MOVER: selectedMover,
          COMBO_DEV_POSTGRES_TEST_MODE: '1',
          ...extra,
        },
        stdio: 'ignore',
      });

    const freshRoot = join(work, 'fresh');
    mkdirSync(freshRoot);
    assert.equal(run(freshRoot).status, 0);
    assert.equal(run(freshRoot).status, 0);

    const legacyRoot = join(work, 'legacy');
    mkdirSync(join(legacyRoot, 'base'), { recursive: true });
    writeFileSync(join(legacyRoot, 'PG_VERSION'), '16\n');
    writeFileSync(join(legacyRoot, 'base', 'record'), 'one');
    writeFileSync(join(legacyRoot, '.hidden'), 'two');
    assert.equal(run(legacyRoot).status, 0);
    assert.equal(readFileSync(join(legacyRoot, 'pgdata', 'PG_VERSION'), 'utf8'), '16\n');
    assert.equal(readFileSync(join(legacyRoot, 'pgdata', 'base', 'record'), 'utf8'), 'one');
    assert.equal(readFileSync(join(legacyRoot, 'pgdata', '.hidden'), 'utf8'), 'two');
    assert.equal(run(legacyRoot).status, 0);

    const failedRoot = join(work, 'failed');
    mkdirSync(failedRoot);
    writeFileSync(join(failedRoot, 'PG_VERSION'), '16\n');
    writeFileSync(join(failedRoot, 'first'), 'one');
    writeFileSync(join(failedRoot, 'second'), 'two');
    const failed = run(failedRoot, mover, { MOVE_COUNT: count });
    assert.notEqual(failed.status, 0);
    assert.equal(readFileSync(count, 'utf8').trim(), '2');
    assert.equal(readFileSync(join(failedRoot, 'PG_VERSION'), 'utf8'), '16\n');
    assert.equal(
      readFileSync(join(failedRoot, '.combo-dev-pgdata-migration'), 'utf8'),
      'state=in-progress\n',
    );
    assert.equal(run(failedRoot, mover, { MOVE_COUNT: count }).status, 2);
    assert.equal(readFileSync(count, 'utf8').trim(), '2');

    const nonemptyRoot = join(work, 'nonempty-child');
    mkdirSync(join(nonemptyRoot, 'pgdata'), { recursive: true });
    writeFileSync(join(nonemptyRoot, 'PG_VERSION'), '16\n');
    writeFileSync(join(nonemptyRoot, 'pgdata', 'partial'), 'partial');
    assert.equal(run(nonemptyRoot).status, 2);
    assert.equal(readFileSync(join(nonemptyRoot, 'PG_VERSION'), 'utf8'), '16\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('static local PV bindings are complete, canonical, and cannot fall back outside the mount', () => {
  const storage = text('infra/k8s/overlays/combo-dev/platform/storage-volumes.yaml');
  const storageClass = text('infra/k8s/overlays/combo-dev/platform/storage-class.yaml');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  const hostReadme = text('infra/host/combo-dev/README.md');

  const validateStorage = (source) => {
    const docs = documents(source);
    const pvs = docs.filter((document) => identity(document).kind === 'PersistentVolume');
    const pvcs = docs.filter((document) => identity(document).kind === 'PersistentVolumeClaim');
    assert.deepEqual(pvs.map((document) => identity(document).name).sort(), [
      'combo-dev-minio',
      'combo-dev-postgres',
      'combo-dev-redis-queue',
    ]);
    assert.deepEqual(pvcs.map((document) => identity(document).name).sort(), [
      'data-minio-0',
      'data-postgres-0',
      'data-redis-queue-0',
    ]);
    const expected = {
      'combo-dev-postgres': ['data-postgres-0', '8Gi', '/home/xingzheng/data/combo-dev/postgres'],
      'combo-dev-redis-queue': [
        'data-redis-queue-0',
        '2Gi',
        '/home/xingzheng/data/combo-dev/redis-queue',
      ],
      'combo-dev-minio': ['data-minio-0', '6Gi', '/home/xingzheng/data/combo-dev/minio'],
    };
    for (const document of pvs) {
      const name = identity(document).name;
      const [claim, size, localPath] = expected[name];
      assert.match(document, new RegExp(`^    storage: ${size}$`, 'm'));
      assert.match(document, /^ {2}persistentVolumeReclaimPolicy: Retain$/m);
      assert.match(document, new RegExp(`^    name: ${claim}$`, 'm'));
      assert.match(document, new RegExp(`^    path: ${localPath.replaceAll('/', '\\/')}$`, 'm'));
      assert.match(
        document,
        /key: kubernetes\.io\/hostname[\s\S]*operator: In[\s\S]*COMBO_DEV_NODE_HOSTNAME/,
      );
      assert.doesNotMatch(document, /hostPath:|DirectoryOrCreate/);
    }
    for (const document of pvcs) {
      const claim = identity(document).name;
      const match = Object.entries(expected).find(([, value]) => value[0] === claim);
      assert.ok(match);
      const [pv, [, size]] = match;
      assert.match(document, new RegExp(`^  volumeName: ${pv}$`, 'm'));
      assert.match(document, new RegExp(`^      storage: ${size}$`, 'm'));
      assert.match(document, /^ {2}storageClassName: combo-dev-bounded$/m);
    }
  };

  validateStorage(storage);
  assert.throws(() =>
    validateStorage(storage.replace('name: combo-dev-minio', 'name: missing-minio')),
  );
  assert.throws(() =>
    validateStorage(
      storage.replace(
        '/home/xingzheng/data/combo-dev/minio',
        '/home/xingzheng/data/combo-dev-fallback/minio',
      ),
    ),
  );
  assert.match(storageClass, /provisioner: kubernetes\.io\/no-provisioner/);
  assert.match(storageClass, /reclaimPolicy: Retain/);
  assert.match(storageClass, /volumeBindingMode: WaitForFirstConsumer/);
  assert.doesNotMatch(storageClass, /combo\.dev\/local-path/);
  assert.equal(storage.match(/COMBO_DEV_NODE_HOSTNAME/g)?.length, 3);
  assert.equal(storage.includes('hostPath:'), false);
  assert.equal(
    existsSync(join(repo, 'infra/k8s/overlays/combo-dev/platform/storage-provisioner.yaml')),
    false,
  );
  assert.equal(
    existsSync(join(repo, 'infra/k8s/overlays/combo-dev/platform/storage-rbac.yaml')),
    false,
  );

  const bootstrapMutations = bootstrap.slice(
    bootstrap.indexOf('bootstrap_mutations() {'),
    bootstrap.lastIndexOf('main() {'),
  );
  const namespaceSanitizer = bootstrap.slice(
    bootstrap.indexOf('sanitize_preview_namespace() {'),
    bootstrap.indexOf('mark_failure_fence() {'),
  );
  assert.doesNotMatch(
    namespaceSanitizer,
    /\b(?:get|delete)\b[^\n]*\bsecrets?\b|\bsecrets?\b[^\n]*\bdelete\b/i,
  );
  assert.ok(
    bootstrapMutations.indexOf('MUTATING=1') <
      bootstrapMutations.indexOf('prepare_static_storage_paths'),
  );
  assert.ok(
    bootstrapMutations.indexOf('prepare_static_storage_paths') <
      bootstrapMutations.indexOf('install_static_storage_bindings_admin'),
  );
  for (const token of [
    '$POSTGRES_STORAGE_PATH 70 70',
    '$REDIS_QUEUE_STORAGE_PATH 999 1000',
    '$MINIO_STORAGE_PATH 1000 1000',
    'chown root:root "$STORAGE_POOL"',
    'findmnt -rn -T "$path" -o TARGET',
    'install -d -o "$uid" -g "$gid" -m 0700 "$path"',
  ]) {
    assert.ok(bootstrap.includes(token));
  }
  assert.match(guard, /findmnt -rn -M "\$STORAGE_POOL" -o TARGET/);
  assert.match(guard, /stat -c '%u:%g:%a' "\$STORAGE_POOL"/);
  assert.match(guard, /"\$source" != "\$parent_source"/);
  assert.match(guard, /"\$target" == "\$STORAGE_POOL"/);
  for (const script of [bootstrap, text('scripts/combo-dev-deploy.sh'), guard]) {
    assert.doesNotMatch(script, /df -P[^\n]*--output/);
  }
  if (process.platform === 'linux') {
    assert.equal(spawnSync('df', ['-B1', '--output=size', '/'], { stdio: 'ignore' }).status, 0);
    assert.equal(spawnSync('df', ['--output=iavail', '/'], { stdio: 'ignore' }).status, 0);
  }

  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-storage-guard.sh',
  ]) {
    assert.match(text(scriptPath), /validate-mount-dependencies/);
  }
  assert.doesNotMatch(bootstrap, /combo\.dev\/local-path|combo-dev-local-path/);
  const mountWork = mkdtempSync(join(tmpdir(), 'combo-dev-mount-contract-'));
  try {
    const input = join(mountWork, 'mounts');
    const check = (value) => {
      writeFileSync(input, value);
      return spawnSync(
        'python3',
        [
          join(repo, 'scripts/combo-dev-production-safety.py'),
          'validate-mount-dependencies',
          '--input',
          input,
          '--data-mount',
          '/home/xingzheng/data',
          '--storage-pool',
          '/home/xingzheng/data/combo-dev',
        ],
        { stdio: 'ignore' },
      ).status;
    };
    assert.equal(check('/home/xingzheng/data /var/lib/rancher/k3s\n'), 0);
    assert.notEqual(check('/home/xingzheng/data/combo-dev\n'), 0);
    assert.notEqual(check('/home/xingzheng/data/combo-dev/postgres\n'), 0);
    assert.notEqual(check('/home/xingzheng/data/combo-dev/../combo-dev/minio\n'), 0);
    assert.notEqual(check('/var/lib/rancher/k3s\n'), 0);
  } finally {
    rmSync(mountWork, { recursive: true, force: true });
  }
  assert.match(hostReadme, /RequiresMountsFor=\/home\/xingzheng\/data/);
  assert.doesNotMatch(hostReadme, /RequiresMountsFor=\/home\/xingzheng\/data\/combo-dev/);
});

test('bootstrap accepts only the exact disposable legacy preview storage and removes it before static binding', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const marker = 'python3 - "$pvc" "$pv" "$K3S_DATA_DIR" "$WORK/legacy-storage.json" <<\'PY\' ||';
  const start = bootstrap.indexOf(marker);
  assert.notEqual(start, -1);
  const bodyStart = bootstrap.indexOf('\n', start) + 1;
  const bodyEnd = bootstrap.indexOf('\nPY\n', bodyStart);
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart);
  const classifier = bootstrap.slice(bodyStart, bodyEnd);
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-legacy-storage-'));
  try {
    mkdirSync(join(work, 'k3s', 'storage'), { recursive: true });
    const dataDir = realpathSync(join(work, 'k3s'));
    const storageDir = join(dataDir, 'storage');
    const definitions = [
      ['combo-preview-postgres-data-postgres-0', '11111111-1111-1111-1111-111111111111'],
      ['combo-preview-redis-queue-data-redis-queue-0', '22222222-2222-2222-2222-222222222222'],
      ['combo-preview-minio-data-minio-0', '33333333-3333-3333-3333-333333333333'],
    ];
    const claims = [];
    const volumes = [];
    for (const [name, uid] of definitions) {
      const volume = `pvc-${uid}`;
      const localPath = join(storageDir, `${volume}_combo-preview_${name}`);
      mkdirSync(localPath);
      claims.push({
        metadata: { name, uid },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: 'local-path',
          volumeMode: 'Filesystem',
          volumeName: volume,
        },
        status: { phase: 'Bound' },
      });
      volumes.push({
        metadata: { name: volume },
        spec: {
          accessModes: ['ReadWriteOnce'],
          capacity: { storage: '1Gi' },
          claimRef: { name, namespace: 'combo-preview', uid },
          local: { path: localPath },
          persistentVolumeReclaimPolicy: 'Delete',
          storageClassName: 'local-path',
          volumeMode: 'Filesystem',
        },
        status: { phase: 'Bound' },
      });
    }
    const pvc = join(work, 'pvc.json');
    const pv = join(work, 'pv.json');
    const output = join(work, 'contract.json');
    const run = (claimItems, volumeItems) => {
      writeFileSync(pvc, JSON.stringify({ items: claimItems }));
      writeFileSync(pv, JSON.stringify({ items: volumeItems }));
      rmSync(output, { force: true });
      return spawnSync('python3', ['-c', classifier, pvc, pv, dataDir, output], {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        stdio: 'ignore',
      }).status;
    };
    assert.equal(run(claims, volumes), 0);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).claims.length, 3);

    const wrongClaim = clone(claims);
    wrongClaim[0].metadata.name = 'unexpected-preview-data';
    assert.notEqual(run(wrongClaim, volumes), 0);
    const wrongPath = clone(volumes);
    wrongPath[0].spec.local.path = join(work, 'outside');
    assert.notEqual(run(claims, wrongPath), 0);
    const wrongReclaim = clone(volumes);
    wrongReclaim[0].spec.persistentVolumeReclaimPolicy = 'Retain';
    assert.notEqual(run(claims, wrongReclaim), 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  assert.match(bootstrap, /bootstrap_boundary legacy-storage-cleanup/);
  assert.match(bootstrap, /wait --for=delete "persistentvolume\/\$volume"/);
  assert.match(bootstrap, /\[\[ ! -e "\$path" && ! -L "\$path" \]\]/);
  const freshHarness = `
source ${JSON.stringify(join(repo, 'scripts/combo-dev-bootstrap.sh'))}
fake_kubectl() { return 0; }
AK=(fake_kubectl)
if namespace_exists_admin; then exit 9; else [[ $? == 1 ]]; fi
fence_all_writers_admin
sanitize_preview_namespace
`;
  assert.equal(spawnSync('bash', ['-c', freshHarness], { stdio: 'ignore' }).status, 0);
});

test('data Pod identities and bootstrap ownership match the pinned image contracts', () => {
  const foundation = text('infra/k8s/overlays/combo-dev/foundation/resources.yaml');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const postgres = documentFor('StatefulSet', 'postgres');
  const redisQueue = documentFor('StatefulSet', 'redis-queue');
  const redisHot = documentFor('Deployment', 'redis-hot');
  const minio = documentFor('StatefulSet', 'minio');
  assert.match(postgres, /runAsGroup: 70[\s\S]*runAsUser: 70/);
  assert.match(redisQueue, /runAsGroup: 1000[\s\S]*runAsUser: 999/);
  assert.match(redisHot, /runAsGroup: 1000[\s\S]*runAsUser: 999/);
  assert.match(minio, /runAsGroup: 1000[\s\S]*runAsUser: 1000/);
  assert.match(bootstrap, /\$POSTGRES_STORAGE_PATH 70 70/);
  assert.match(bootstrap, /\$REDIS_QUEUE_STORAGE_PATH 999 1000/);
  assert.match(bootstrap, /\$MINIO_STORAGE_PATH 1000 1000/);
  assert.match(foundation, new RegExp(POSTGRES_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(foundation, new RegExp(REDIS_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(foundation, new RegExp(MINIO_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test(
  'exact pinned data images expose the required runtime identities',
  { skip: !dockerAvailable },
  () => {
    const probes = [
      [
        POSTGRES_IMAGE,
        ['--entrypoint', '/bin/sh'],
        'test "$(id -u postgres):$(id -g postgres)" = 70:70 && command -v cat >/dev/null && command -v docker-entrypoint.sh >/dev/null',
      ],
      [
        REDIS_IMAGE,
        ['--entrypoint', '/bin/sh'],
        'test "$(id -u redis):$(id -g redis)" = 999:1000 && command -v cat >/dev/null && command -v redis-server >/dev/null',
      ],
      [
        MINIO_IMAGE,
        ['--user', '1000:1000', '--entrypoint', '/bin/sh'],
        'test "$(id -u):$(id -g)" = 1000:1000 && command -v cat >/dev/null && test -x /usr/bin/docker-entrypoint.sh',
      ],
      [
        MINIO_MC_IMAGE,
        ['--entrypoint', '/bin/sh'],
        'command -v mc >/dev/null && command -v sleep >/dev/null',
      ],
    ];
    for (const [image, options, command] of probes) {
      const result = spawnSync('docker', ['run', '--rm', ...options, image, '-ec', command], {
        stdio: 'ignore',
      });
      assert.equal(result.status, 0, `${image} identity probe failed`);
    }
  },
);

test(
  'MinIO initialization runs with the exact pinned mc image toolset',
  { skip: !dockerAvailable },
  () => {
    const resource = text('infra/k8s/overlays/combo-dev/init/resources.yaml');
    const lines = resource.split('\n');
    const start = lines.indexOf('  init-buckets.sh: |') + 1;
    const end = lines.indexOf('kind: ConfigMap');
    assert.ok(start > 0 && end > start);
    const script = lines
      .slice(start, end)
      .map((line) => (line.length === 0 ? '' : line.slice(4)))
      .join('\n');
    const work = mkdtempSync(join(tmpdir(), 'combo-dev-minio-init-'));
    try {
      const scriptPath = join(work, 'init.sh');
      const fakeMc = join(work, 'mc');
      writeFileSync(scriptPath, `${script}\n`);
      writeFileSync(
        fakeMc,
        `#!/bin/sh
case "$*" in
  "admin user list local --json")
    printf '%s\\n' '{"status":"success","accessKey":"appKey1"}'
    [ -f /tmp/fake-mc-removed ] || printf '%s\\n' '{"status":"success","accessKey":"staleKey1"}'
    ;;
  "admin user remove local staleKey1") : >/tmp/fake-mc-removed ;;
  "admin user info local staleKey1") exit 1 ;;
  "alias set revoked "*) exit 1 ;;
  *) exit 0 ;;
esac
`,
      );
      chmodSync(scriptPath, 0o755);
      chmodSync(fakeMc, 0o755);
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/sh',
          '-v',
          `${work}:/probe:ro`,
          '-e',
          'MINIO_ROOT_USER=rootuser',
          '-e',
          'MINIO_ROOT_PASSWORD=rootpass',
          '-e',
          'S3_ACCESS_KEY=appKey1',
          '-e',
          'S3_SECRET_KEY=secretKey1',
          '-e',
          'S3_ENDPOINT=http://minio.invalid',
          '-e',
          'MC_CONFIG_DIR=/tmp/mc-test',
          MINIO_MC_IMAGE,
          '-ec',
          'PATH=/probe:/bin /bin/sh /probe/init.sh',
        ],
        { stdio: 'ignore' },
      );
      assert.equal(result.status, 0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test(
  'fresh static volumes are unwritable before exact ownership and writable afterward',
  { skip: !dockerAvailable },
  () => {
    const token = mkdtempSync(join(tmpdir(), 'combo-dev-volume-token-')).split('/').at(-1);
    const specs = [
      { name: 'postgres', image: POSTGRES_IMAGE, user: '70:70' },
      { name: 'redis', image: REDIS_IMAGE, user: '999:1000' },
      { name: 'minio', image: MINIO_IMAGE, user: '1000:1000' },
    ];
    const volumes = [];
    try {
      for (const spec of specs) {
        const volume = `combo-dev-test-${token}-${spec.name}`.toLowerCase();
        volumes.push(volume);
        execFileSync('docker', ['volume', 'create', volume], { stdio: 'ignore' });
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            'chown 0:0 /volume && chmod 0700 /volume',
          ],
          { stdio: 'ignore' },
        );
        const denied = spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '--user',
            spec.user,
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            'touch /volume/probe',
          ],
          { stdio: 'ignore' },
        );
        assert.notEqual(
          denied.status,
          0,
          `${spec.name} unexpectedly wrote a root-owned fresh volume`,
        );
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            `chown ${spec.user} /volume && chmod 0700 /volume`,
          ],
          { stdio: 'ignore' },
        );
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--user',
            spec.user,
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${volume}:/volume`,
            spec.image,
            '-ec',
            'touch /volume/probe && rm /volume/probe',
          ],
          { stdio: 'ignore' },
        );
        if (spec.name === 'postgres') {
          execFileSync(
            'docker',
            [
              'run',
              '--rm',
              '--user',
              spec.user,
              '--entrypoint',
              '/bin/sh',
              '-v',
              `${volume}:/volume`,
              spec.image,
              '-ec',
              'mkdir /volume/pgdata && initdb -D /volume/pgdata --auth-local=trust --auth-host=reject >/dev/null',
            ],
            { stdio: 'ignore' },
          );
        }
      }
    } finally {
      for (const volume of volumes) {
        spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
      }
      rmSync(join(tmpdir(), token), { recursive: true, force: true });
    }
  },
);

test(
  'PostgreSQL migration runs with only commands in the exact pinned Alpine image',
  { skip: !dockerAvailable },
  () => {
    const tokenDirectory = mkdtempSync(join(tmpdir(), 'combo-dev-migration-token-'));
    const token = tokenDirectory.split('/').at(-1);
    const volume = `combo-dev-test-${token}-migration`.toLowerCase();
    const script = join(repo, 'infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh');
    const marker = join(tokenDirectory, 'volume-marker');
    writeFileSync(marker, 'wrong-volume-marker\n');
    try {
      execFileSync('docker', ['volume', 'create', volume], { stdio: 'ignore' });
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/sh',
          '-v',
          `${volume}:/var/lib/postgresql/data`,
          POSTGRES_IMAGE,
          '-ec',
          'mkdir -p /var/lib/postgresql/data/base && printf "16\\n" > /var/lib/postgresql/data/PG_VERSION && printf x > /var/lib/postgresql/data/base/item && chown -R 70:70 /var/lib/postgresql/data && chmod 0700 /var/lib/postgresql/data',
        ],
        { stdio: 'ignore' },
      );
      const args = [
        'run',
        '--rm',
        '--user',
        '70:70',
        '--entrypoint',
        '/bin/bash',
        '-e',
        'COMBO_DEV_POSTGRES_DATA_ROOT=/var/lib/postgresql/data',
        '-e',
        'PGDATA=/var/lib/postgresql/data/pgdata',
        '-e',
        'COMBO_DEV_POSTGRES_ENTRYPOINT=/bin/true',
        '-e',
        'COMBO_DEV_POSTGRES_MOVER=/bin/mv',
        '-e',
        'COMBO_DEV_STORAGE_MARKER=/combo-dev-volume-marker',
        '-e',
        'COMBO_DEV_STORAGE_MARKER_STATE=combo-dev-static-volume=postgres:v1',
        '-v',
        `${volume}:/var/lib/postgresql/data`,
        '-v',
        `${marker}:/combo-dev-volume-marker:ro`,
        '-v',
        `${script}:/opt/combo-dev/postgres-entrypoint.sh:ro`,
        POSTGRES_IMAGE,
        '/opt/combo-dev/postgres-entrypoint.sh',
      ];
      const wrongMarker = spawnSync('docker', args, { stdio: 'ignore' });
      assert.equal(wrongMarker.status, 2);
      writeFileSync(marker, 'combo-dev-static-volume=postgres:v1\n');
      execFileSync('docker', args, { stdio: 'ignore' });
      execFileSync('docker', args, { stdio: 'ignore' });
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/sh',
          '-v',
          `${volume}:/var/lib/postgresql/data`,
          POSTGRES_IMAGE,
          '-ec',
          'test ! -e /var/lib/postgresql/data/PG_VERSION && test -f /var/lib/postgresql/data/pgdata/PG_VERSION && test -f /var/lib/postgresql/data/pgdata/base/item && test ! -e /var/lib/postgresql/data/.combo-dev-pgdata-migration && for command in bash cat mkdir mv chmod rm sync; do command -v "$command" >/dev/null; done && ! find /tmp -maxdepth 0 -printf x >/dev/null 2>&1',
        ],
        { stdio: 'ignore' },
      );
    } finally {
      spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
      rmSync(tokenDirectory, { recursive: true, force: true });
    }
  },
);

test('render security is tied to exact stage bytes and rejects root decoys, unsafe services, commands, and secret references', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  assert.doesNotMatch(deploy, /kubectl kustomize "\$destination\/overlay"/);
  assert.match(deploy, /expected_all='\\n---\\n'\.join/);
  assert.match(
    deploy,
    /sha256sum platform\.yaml foundation\.yaml init\.yaml migrate\.yaml apps\.yaml all\.yaml/,
  );
  assert.match(deploy, /assert_validated_render "\$render"/);
  assert.match(deploy, /seen != allowed_files/);
  assert.doesNotMatch(deploy, /allowed_prefix/);

  for (const [mutation, marker] of [
    [
      (root) => {
        const rootKustomization = join(root, 'infra/k8s/overlays/combo-dev/kustomization.yaml');
        writeFileSync(
          rootKustomization,
          'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - platform\n',
        );
        const apps = join(root, 'infra/k8s/overlays/combo-dev/apps/resources.yaml');
        writeFileSync(
          apps,
          readFileSync(apps, 'utf8').replace('  type: ClusterIP\n', '  type: NodePort\n'),
        );
      },
      /guard:forbidden/,
    ],
    [
      (root) => {
        const foundation = join(root, 'infra/k8s/overlays/combo-dev/foundation/resources.yaml');
        writeFileSync(
          foundation,
          readFileSync(foundation, 'utf8').replace(
            '            - redis-server\n            - /usr/local/etc/redis/redis.conf\n',
            '            - sh\n            - -c\n',
          ),
        );
      },
      /guard:command/,
    ],
    [
      (root) => {
        const migrate = join(root, 'infra/k8s/overlays/combo-dev/migrate/resources.yaml');
        writeFileSync(
          migrate,
          readFileSync(migrate, 'utf8').replace('name: combo-dev-env', 'name: other-config'),
        );
      },
      /guard:secret-reference/,
    ],
  ]) {
    const root = fixture();
    try {
      mutation(root);
      expectRenderFailure(root, marker);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('production fingerprint preserves stable object and Pod identities while ignoring only volatile API metadata', () => {
  const safety = text('scripts/combo-dev-production-safety.py');
  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
  ]) {
    assert.match(
      text(scriptPath),
      /combo-dev-production-safety(?:\.py)?"? canonicalize-production/,
    );
    assert.doesNotMatch(text(scriptPath), /images:\s*\[/);
  }
  for (const field of ['"uid"', '"podIP"', '"podIPs"', '"startTime"']) {
    assert.ok(safety.includes(field));
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-fingerprint-'));
  try {
    const base = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'postgres-0',
        namespace: 'combo',
        uid: 'pod-one',
        labels: { app: 'postgres' },
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'StatefulSet',
            name: 'postgres',
            uid: 'owner-one',
            controller: true,
          },
        ],
        resourceVersion: '1',
        creationTimestamp: '2026-01-01T00:00:00Z',
      },
      spec: {
        nodeName: 'node-one',
        containers: [{ name: 'postgres', image: 'postgres@sha256:x' }],
      },
      status: {
        phase: 'Running',
        podIP: '10.42.0.10',
        podIPs: [{ ip: '10.42.0.10' }],
        startTime: '2026-01-01T00:00:10Z',
        containerStatuses: [
          {
            name: 'postgres',
            ready: true,
            restartCount: 0,
            image: 'postgres@sha256:x',
            imageID: 'postgres@sha256:x',
            state: { running: { startedAt: '2026-01-01T00:00:11Z' } },
          },
        ],
      },
    };
    const canonicalize = (name, object) => {
      const input = join(work, `${name}.input.json`);
      const output = join(work, `${name}.output.json`);
      writeFileSync(input, JSON.stringify({ items: [object] }));
      execFileSync(
        'python3',
        [
          join(repo, 'scripts/combo-dev-production-safety.py'),
          'canonicalize-production',
          '--input',
          input,
          '--output',
          output,
        ],
        { stdio: 'ignore' },
      );
      return readFileSync(output, 'utf8');
    };
    const first = canonicalize('first', base);
    const volatile = clone(base);
    volatile.metadata.resourceVersion = '999';
    volatile.metadata.creationTimestamp = '2026-02-02T00:00:00Z';
    assert.equal(sha(first), sha(canonicalize('volatile', volatile)));

    for (const [name, mutate] of [
      ['pod-uid', (value) => (value.metadata.uid = 'pod-two')],
      ['owner-uid', (value) => (value.metadata.ownerReferences[0].uid = 'owner-two')],
      ['pod-ip', (value) => (value.status.podIP = '10.42.0.11')],
      ['pod-start', (value) => (value.status.startTime = '2026-01-02T00:00:10Z')],
      [
        'container-start',
        (value) =>
          (value.status.containerStatuses[0].state.running.startedAt = '2026-01-02T00:00:11Z'),
      ],
    ]) {
      const replaced = clone(base);
      mutate(replaced);
      assert.notEqual(sha(first), sha(canonicalize(name, replaced)), name);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('production observer gate resolves every binding and exact effective rule instead of sampling one permission', () => {
  const safety = text('scripts/combo-dev-production-safety.py');
  const rbac = text('infra/k8s/overlays/combo-dev/platform/rbac.yaml');
  for (const token of [
    'SelfSubjectRulesReview',
    'rolebindings.rbac.authorization.k8s.io',
    'clusterrolebindings.rbac.authorization.k8s.io',
    'observer RBAC contains a wildcard rule',
    'observer has resource access outside production',
    'observer and auditor do not use the same cluster trust',
    'secrets',
    'deletecollection',
  ]) {
    assert.ok(safety.includes(token));
  }
  assert.match(
    rbac,
    /resources: \['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings'\]/,
  );
  assert.match(rbac, /verbs: \['get', 'list'\]/);
  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
  ]) {
    assert.match(text(scriptPath), /verify-observer/);
    assert.doesNotMatch(text(scriptPath), /can_observer_exact/);
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-observer-unit-'));
  try {
    const unit = join(work, 'observer-unit.py');
    writeFileSync(
      unit,
      `import importlib.util
spec=importlib.util.spec_from_file_location('safety', ${JSON.stringify(join(repo, 'scripts/combo-dev-production-safety.py'))})
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def item(kind,name,rules,namespace=None):
    metadata={'name':name}
    if namespace is not None: metadata['namespace']=namespace
    return {'kind':kind,'metadata':metadata,'rules':rules}
production_rules=[
 {'apiGroups':['apps'],'resources':['deployments','statefulsets'],'verbs':['get','list','watch']},
 {'apiGroups':[''],'resources':['services','persistentvolumeclaims','pods'],'verbs':['get','list','watch']},
]
roles={'items':[item('Role','observer',production_rules,'combo')]}
rolebindings={'items':[{'kind':'RoleBinding','metadata':{'name':'observer','namespace':'combo'},'subjects':[{'kind':'User','name':'observer'}],'roleRef':{'kind':'Role','name':'observer'}}]}
clusterroles={'items':[
 item('ClusterRole','basic',[{'apiGroups':['authorization.k8s.io'],'resources':['selfsubjectaccessreviews','selfsubjectrulesreviews'],'verbs':['create']},{'apiGroups':['authentication.k8s.io'],'resources':['selfsubjectreviews'],'verbs':['create']}]),
 item('ClusterRole','discovery',[{'nonResourceURLs':['/api','/apis','/openapi/*','/version'],'verbs':['get']}]),
]}
clusterbindings={'items':[
 {'kind':'ClusterRoleBinding','metadata':{'name':'basic'},'subjects':[{'kind':'Group','name':'system:authenticated'}],'roleRef':{'kind':'ClusterRole','name':'basic'}},
 {'kind':'ClusterRoleBinding','metadata':{'name':'discovery'},'subjects':[{'kind':'Group','name':'system:authenticated'}],'roleRef':{'kind':'ClusterRole','name':'discovery'}},
]}
module.validate_bindings('observer',{'system:authenticated'},'combo',roles,rolebindings,clusterroles,clusterbindings)
over_roles={'items':roles['items']+[item('Role','extra',[{'apiGroups':[''],'resources':['secrets'],'verbs':['get']}],'default')]}
over_bindings={'items':rolebindings['items']+[{'kind':'RoleBinding','metadata':{'name':'extra','namespace':'default'},'subjects':[{'kind':'User','name':'observer'}],'roleRef':{'kind':'Role','name':'extra'}}]}
try:
    module.validate_bindings('observer',{'system:authenticated'},'combo',over_roles,over_bindings,clusterroles,clusterbindings)
except module.SafetyError:
    pass
else:
    raise SystemExit(2)
`,
    );
    const result = spawnSync('python3', [unit], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: 'ignore',
    });
    assert.equal(result.status, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('bootstrap failure injection at every apply and credential boundary leaves forwarders and writers fenced', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  for (const script of [deploy, reset, bootstrap, guard]) {
    assert.match(script, /\/var\/lib\/combo-dev\/writers-fenced/);
  }
  for (const [name, script] of [
    ['deploy', deploy],
    ['reset', reset],
  ]) {
    const cleanup = script.slice(
      script.indexOf('cleanup() {'),
      script.indexOf('trap cleanup EXIT'),
    );
    const marker = cleanup.indexOf('mark_failure_fence');
    const forwarders = cleanup.indexOf(
      name === 'deploy' ? 'stop_forwarders_for_failure' : 'stop_forwarders',
    );
    const writers = cleanup.indexOf(
      name === 'deploy' ? 'fence_all_writers_cleanup' : 'fence_all_writers',
    );
    const inventory = cleanup.indexOf('verify_complete_writer_inventory_zero');
    const capability = cleanup.indexOf('record_failed_attempt_capability');
    assert.ok(marker >= 0 && marker < forwarders, name);
    assert.ok(forwarders < writers && writers < inventory, name);
    assert.ok(inventory < capability, name);
  }
  for (const [name, script] of [
    ['deploy', deploy],
    ['reset', reset],
  ]) {
    const cleanup = script.slice(
      script.indexOf('cleanup() {'),
      script.indexOf('trap cleanup EXIT'),
    );
    const work = mkdtempSync(join(tmpdir(), `combo-dev-${name}-cleanup-`));
    const calls = join(work, 'calls');
    const stopFunction = name === 'deploy' ? 'stop_forwarders_for_failure' : 'stop_forwarders';
    const fenceFunction = name === 'deploy' ? 'fence_all_writers_cleanup' : 'fence_all_writers';
    try {
      const result = spawnSync(
        'bash',
        [
          '-c',
          `
set -u
INCOMING_BUNDLE=''
RESET_PROOF_IN_USE=''
CANDIDATE_RELEASE=''
RELEASE_DIR=''
RELEASE_CREATED=0
WORK=''
MUTATING=1
SUCCESS=0
mark_failure_fence() { :; }
remove_consumed_reset_proof() { return 0; }
remove_current_attempt_reset_proofs() { return 0; }
remove_all_reset_proofs() { return 0; }
stop_forwarders_for_failure() { printf 'stop\\n' >>"$CALLS"; return 1; }
stop_forwarders() { printf 'stop\\n' >>"$CALLS"; return 1; }
fence_all_writers_cleanup() { printf 'fence\\n' >>"$CALLS"; return 0; }
fence_all_writers() { printf 'fence\\n' >>"$CALLS"; return 0; }
verify_complete_writer_inventory_zero() { printf 'inventory\\n' >>"$CALLS"; return 0; }
record_failed_attempt_capability() { printf 'capability\\n' >>"$CALLS"; return 0; }
status() { :; }
${cleanup}
false
cleanup
`,
        ],
        { encoding: 'utf8', env: { ...process.env, CALLS: calls } },
      );
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.equal(readFileSync(calls, 'utf8'), 'stop\nfence\ninventory\n', name);
      assert.ok(cleanup.includes(`${stopFunction} >/dev/null 2>&1 || convergence_ok=0`));
      assert.ok(cleanup.includes(`${fenceFunction} >/dev/null 2>&1 || convergence_ok=0`));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  for (const script of [deploy, reset, guard]) {
    assert.match(script, /redis-hot/);
    assert.match(
      script,
      /minio-init migrate combo-dev-network-canary|JOBS=\(minio-init migrate combo-dev-network-canary\)/,
    );
  }
  const bootstrapFence = bootstrap.slice(
    bootstrap.indexOf('fence_all_writers_admin() {'),
    bootstrap.indexOf('credential_certificate_valid_for() {'),
  );
  assert.match(bootstrapFence, /get deployments\.apps,statefulsets\.apps -o name/);
  assert.match(bootstrapFence, /scale "\$controller" --replicas=0/);
  for (const resource of [
    'horizontalpodautoscalers.autoscaling',
    'cronjobs.batch',
    'daemonsets.apps',
    'jobs.batch',
    'replicationcontrollers',
    'replicasets.apps',
  ]) {
    assert.ok(bootstrapFence.includes(resource), resource);
  }
  assert.match(bootstrapFence, /delete pods --all/);
  assert.doesNotMatch(bootstrapFence, /APP_NAMES|FOUNDATION_STATEFUL/);

  const boundaries = [
    'sanitize-preview',
    'legacy-storage-cleanup',
    'namespace-apply',
    'static-storage-paths',
    'static-storage-bindings',
    'storage-class-apply',
    'static-volumes-apply',
    'rbac-apply',
    'fencer-credential',
    'dispatcher-credential',
    'approval-files',
    'platform-apply',
    'development-secrets',
    'env-secret-apply',
    'registry-secret-apply',
    'control-files-install',
  ];
  const actualBoundaries = [...bootstrap.matchAll(/bootstrap_boundary ([a-z][a-z0-9-]+)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(actualBoundaries)].sort(), [...boundaries].sort());
  const mainBody = bootstrap.slice(bootstrap.lastIndexOf('\nmain() {'));
  for (const readOnlyStep of [
    'host_preflight',
    'validate_config_names_only',
    'verify_observer_boundary',
    'before=$(production_fingerprint)',
    'prepare_cluster_platform_contract',
    'classify_preview_storage_admin',
  ]) {
    assert.ok(
      mainBody.indexOf(readOnlyStep) < mainBody.indexOf('bootstrap_mutations'),
      readOnlyStep,
    );
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-bootstrap-failure-'));
  try {
    const harness = `
source ${JSON.stringify(join(repo, 'scripts/combo-dev-bootstrap.sh'))}
status() { :; }
record() { printf '%s\\n' "$1" >>"$TEST_LOG"; }
mark_failure_fence() { record marker; }
stop_forwarders() { record forwarders; }
forwarders_stopped() { return 0; }
fence_all_writers_admin() { record writers; }
bootstrap_boundary() {
  local boundary=$1
  shift
  record "boundary:$boundary"
  [[ "$boundary" != "$FAIL_AT" ]] || return 71
  "$@"
}
fake_kubectl() { return 0; }
AK=(fake_kubectl)
sanitize_preview_namespace() { return 0; }
cleanup_legacy_preview_storage_admin() { return 0; }
prepare_static_storage_paths() { return 0; }
check_static_storage_guard() { return 0; }
install_static_storage_bindings_admin() {
  bootstrap_boundary storage-class-apply true || return
  bootstrap_boundary static-volumes-apply true || return
}
provision_fencer_credential() { return 0; }
provision_dispatcher_credential() { return 0; }
write_bootstrap_approvals() { return 0; }
dispatcher_credential_valid() { return 0; }
fencer_credential_valid() { return 0; }
static_storage_is_valid_admin() { return 0; }
verify_cluster_platform_admin() { return 0; }
provision_secrets() {
  bootstrap_boundary env-secret-apply true || return
  bootstrap_boundary registry-secret-apply true || return
  bootstrap_boundary session-credential-file true || return
  bootstrap_boundary session-secret-apply true || return
}
install_control_files() { return 0; }
WORK=''
bootstrap_mutations
`;
    for (const boundary of boundaries) {
      const log = join(work, `${boundary}.log`);
      const result = spawnSync('bash', ['-c', harness], {
        env: { ...process.env, FAIL_AT: boundary, TEST_LOG: log },
        stdio: 'ignore',
      });
      assert.notEqual(result.status, 0, boundary);
      const events = readFileSync(log, 'utf8').trim().split('\n');
      const firstBoundary = events.findIndex((event) => event.startsWith('boundary:'));
      assert.deepEqual(
        events.slice(0, firstBoundary),
        ['marker', 'forwarders', 'writers'],
        boundary,
      );
      assert.ok(events.includes(`boundary:${boundary}`), boundary);
      assert.ok(events.lastIndexOf('marker') > firstBoundary, boundary);
      assert.ok(events.lastIndexOf('forwarders') > firstBoundary, boundary);
      assert.ok(events.lastIndexOf('writers') > firstBoundary, boundary);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  assert.match(deploy, /fence_all_writers_cleanup/);
  assert.match(deploy, /run_pre_app_storage[\s\S]*rm -f -- "\$FAILURE_FENCE_MARKER"/);
  assert.match(
    deploy,
    /flock -w 300 8[\s\S]*verify_writers_restored[\s\S]*rm -f -- "\$FAILURE_FENCE_MARKER"/,
  );
  assert.match(reset, /combo-dev-smoke --storage-only[\s\S]*fence_all_writers \|\| blocked/);
  assert.doesNotMatch(reset, /rm -f -- "\$FAILURE_FENCE_MARKER"/);
  assert.match(guard, /verify_writers_fenced/);
});

test('first bootstrap tolerates absent forwarder units and serializes the persistent storage guard', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const stopBody = bootstrap.slice(
    bootstrap.indexOf('stop_forwarders() {'),
    bootstrap.indexOf('cleanup() {'),
  );
  assert.match(
    stopBody,
    /systemctl stop combo-dev-web-forward\.service combo-dev-s3-forward\.service[\s\\\n]*combo-dev-public-web-forward\.service combo-dev-public-s3-forward\.service[^\n]*\|\| true/,
  );
  assert.ok(stopBody.indexOf('systemctl stop') < stopBody.indexOf('forwarders_stopped'));

  const installBody = bootstrap.slice(
    bootstrap.indexOf('install_control_files() {'),
    bootstrap.indexOf('production_fingerprint() {'),
  );
  const timerStop = installBody.indexOf('systemctl disable --now combo-dev-storage-guard.timer');
  const firstCheck = installBody.indexOf('systemctl start combo-dev-storage-guard.service');
  const timerStart = installBody.indexOf('systemctl enable --now combo-dev-storage-guard.timer');
  assert.ok(timerStop >= 0);
  assert.ok(timerStop < firstCheck);
  assert.ok(firstCheck < timerStart);
  assert.match(
    bootstrap,
    /bootstrap_boundary platform-apply "\$\{AK\[@\]\}" apply --server-side[\s\S]*--field-manager=combo-dev-dispatcher --force-conflicts/,
  );
});

test('safe-idle capability is exact, atomic, and fail-closed in every control path', () => {
  const safe = 'combo-dev-writers=safe-idle-v1';
  const generic = 'combo-dev-writers=fenced';
  const owner = `${process.getuid()}:${process.getgid()}:600`;

  function functionRegion(path, start, end) {
    const source = text(path);
    const startAt = source.indexOf(start);
    const endAt = source.indexOf(end, startAt);
    assert.ok(startAt >= 0, `${path}: missing region start ${start}`);
    assert.ok(endAt > startAt, `${path}: missing region end ${end}`);
    return source.slice(startAt, endAt);
  }

  function sandboxSource(source) {
    return source
      .replaceAll('/var/lib/combo-dev', '${STATE_DIR}')
      .replaceAll('install -d -o root -g root -m 0711', 'install -d -m 0711')
      .replaceAll('chown root:root "$candidate"', 'true')
      .replaceAll('0:0:600', owner);
  }

  function markerSnapshot(path) {
    try {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) return { kind: 'symlink', mode: metadata.mode & 0o777 };
      return {
        kind: metadata.isFile() ? 'file' : 'other',
        mode: metadata.mode & 0o777,
        value: metadata.isFile() ? readFileSync(path, 'utf8').trimEnd() : undefined,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { kind: 'absent' };
      throw error;
    }
  }

  function installMarker(state, marker, victim) {
    switch (state) {
      case 'absent':
        break;
      case 'safe':
        writeFileSync(marker, `${safe}\n`, { mode: 0o600 });
        break;
      case 'generic':
        writeFileSync(marker, `${generic}\n`, { mode: 0o600 });
        break;
      case 'unknown':
        writeFileSync(marker, 'combo-dev-writers=unknown\n', { mode: 0o600 });
        break;
      case 'wrong-mode':
        writeFileSync(marker, `${safe}\n`, { mode: 0o600 });
        chmodSync(marker, 0o644);
        break;
      case 'symlink':
        writeFileSync(victim, `${safe}\n`, { mode: 0o600 });
        symlinkSync(victim, marker);
        break;
      default:
        assert.fail(`unsupported marker state: ${state}`);
    }
  }

  function runHarness({ source, markerState, body, externalSymlink = false, environment = {} }) {
    const root = mkdtempSync(join(tmpdir(), 'combo-dev-safe-idle-'));
    const stateDir = join(root, 'state');
    const marker = join(stateDir, 'writers-fenced');
    const external = join(stateDir, 'external-fence');
    const pending = join(stateDir, 'acceptance-pending');
    const victim = join(root, 'victim');
    const outcome = join(root, 'outcome');
    mkdirSync(stateDir, { mode: 0o711 });
    installMarker(markerState, marker, victim);
    if (externalSymlink) {
      writeFileSync(victim, 'victim-must-not-change\n', { mode: 0o600 });
      symlinkSync(victim, external);
    }
    const harness = `
set -Eeuo pipefail
umask 077
FAILURE_FENCE_MARKER="$STATE_DIR/writers-fenced"
EXTERNAL_FENCE_MARKER="$STATE_DIR/external-fence"
ACCEPTANCE_PENDING_MARKER="$STATE_DIR/acceptance-pending"
PUBLICATION_MARKER="$STATE_DIR/publication"
FENCE_LOCK_FILE="$STATE_DIR/fence.lock"
FORWARDER_LOCK_FILE="$STATE_DIR/forwarders.lock"
OPERATION_LOCK_FILE="$STATE_DIR/operation.lock"
FAILURE_FENCE_VALUE='${generic}'
SAFE_IDLE_FENCE_VALUE='${safe}'
ACCEPTANCE_PENDING_SECONDS=7200
MUTATING=0
ATTEMPT_REVISION=''
ATTEMPT_RUN_ID=''
ATTEMPT_RUN_ATTEMPT=''
verify_control_state() { return 0; }
${sandboxSource(source)}
${body}
`;
    try {
      const result = spawnSync('bash', ['-c', harness], {
        encoding: 'utf8',
        env: {
          ...process.env,
          STATE_DIR: stateDir,
          OUTCOME: outcome,
          ...environment,
        },
      });
      return {
        result,
        outcome: existsSync(outcome) ? readFileSync(outcome, 'utf8').trimEnd() : '',
        marker: markerSnapshot(marker),
        external: markerSnapshot(external),
        pending: markerSnapshot(pending),
        victim: existsSync(victim) ? readFileSync(victim, 'utf8').trimEnd() : undefined,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const guardFunctions = functionRegion(
    'scripts/combo-dev-storage-guard.sh',
    'write_writers_fence() {',
    'mark_maintenance_fence_complete() {',
  );
  const guard = text('scripts/combo-dev-storage-guard.sh');
  const guardStart = guard.indexOf(
    'if [[ -e "$FAILURE_FENCE_MARKER" || -L "$FAILURE_FENCE_MARKER" ]]',
  );
  const guardEnd = guard.indexOf(
    'if [[ -e "$ACCEPTANCE_PENDING_MARKER" || -L "$ACCEPTANCE_PENDING_MARKER" ]]',
    guardStart,
  );
  assert.ok(guardStart >= 0 && guardEnd > guardStart);
  const guardBranch = guard.slice(guardStart, guardEnd);
  const guardBody = `
forwarders_stopped() { [[ "\${FORWARDER_ACTIVE:-0}" == 0 ]]; }
verify_writers_fenced() { [[ "\${WRITER_ACTIVE:-0}" == 0 ]]; }
verify_complete_writer_inventory_zero() { [[ "\${INVENTORY_ACTIVE:-0}" == 0 ]]; }
status() { printf '%s\\n' safe >"$OUTCOME"; }
fence_now() { printf '%s\\n' fenced >"$OUTCOME"; }
exercise_guard_marker() {
${guardBranch}
  printf '%s\\n' continue >"$OUTCOME"
}
exercise_guard_marker
`;
  for (const [markerState, expected] of [
    ['absent', 'continue'],
    ['safe', 'safe'],
    ['generic', 'fenced'],
    ['unknown', 'fenced'],
    ['wrong-mode', 'fenced'],
    ['symlink', 'fenced'],
  ]) {
    const observed = runHarness({ source: guardFunctions, markerState, body: guardBody });
    assert.equal(observed.result.status, 0, `${markerState}: ${observed.result.stderr}`);
    assert.equal(observed.outcome, expected, markerState);
  }
  for (const environment of [
    { WRITER_ACTIVE: '1' },
    { FORWARDER_ACTIVE: '1' },
    { INVENTORY_ACTIVE: '1' },
  ]) {
    const observed = runHarness({
      source: guardFunctions,
      markerState: 'safe',
      body: guardBody,
      environment,
    });
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.equal(observed.outcome, 'fenced');
  }
  for (const [name, setup, externalSymlink] of [
    ['system-alone', `printf 'system\\n' >"$EXTERNAL_FENCE_MARKER"`, false],
    ['unknown-alone', `printf 'unknown\\n' >"$EXTERNAL_FENCE_MARKER"`, false],
    ['symlink-alone', '', true],
  ]) {
    const observed = runHarness({
      source: guardFunctions,
      markerState: 'absent',
      externalSymlink,
      body: `
${setup}
${guardBody}
`,
    });
    assert.equal(observed.result.status, 0, `${name}: ${observed.result.stderr}`);
    assert.equal(observed.outcome, 'fenced', name);
  }

  const forwarderFenceCheck = functionRegion(
    'scripts/combo-dev-forwarder-lease.sh',
    'failure_fences_absent() {',
    'process_start() {',
  );
  for (const [name, markerState, setup, externalSymlink, expected] of [
    ['clear', 'absent', '', false, 'allowed'],
    ['writers', 'generic', '', false, 'blocked'],
    ['external', 'absent', `printf 'system\\n' >"$EXTERNAL_FENCE_MARKER"`, false, 'blocked'],
    ['external-symlink', 'absent', '', true, 'blocked'],
  ]) {
    const observed = runHarness({
      source: forwarderFenceCheck,
      markerState,
      externalSymlink,
      body: `
${setup}
if failure_fences_absent; then
  printf 'allowed\\n' >"$OUTCOME"
else
  printf 'blocked\\n' >"$OUTCOME"
fi
`,
    });
    assert.equal(observed.result.status, 0, `${name}: ${observed.result.stderr}`);
    assert.equal(observed.outcome, expected, name);
  }

  const persistFences = guard.slice(
    guard.indexOf('persist_fences_and_stop_forwarders() {'),
    guard.indexOf('fence_now_locked() {'),
  );
  const genericFence = persistFences.indexOf('mark_failure_fence');
  const externalFence = persistFences.indexOf('mark_external_fence');
  const stopForwarders = persistFences.indexOf('systemctl stop');
  const unlockForwarders = persistFences.indexOf('flock -u 7');
  assert.ok(genericFence >= 0 && genericFence < externalFence);
  assert.ok(externalFence < stopForwarders && stopForwarders < unlockForwarders);

  const externalReplacement = runHarness({
    source: guardFunctions,
    markerState: 'generic',
    externalSymlink: true,
    body: `
if mark_external_fence system; then
  printf '%s\\n' success >"$OUTCOME"
else
  printf '%s\\n' rejected >"$OUTCOME"
fi
`,
  });
  assert.equal(externalReplacement.result.status, 0, externalReplacement.result.stderr);
  assert.equal(externalReplacement.outcome, 'success');
  assert.deepEqual(externalReplacement.external, { kind: 'file', mode: 0o600, value: 'system' });
  assert.equal(externalReplacement.victim, 'victim-must-not-change');

  const requestedAttempt = 'attempt aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 10 2';
  const differentAttempt = 'attempt bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 11 3';
  for (const [name, setup, externalSymlink, expected] of [
    ['absent', '', false, requestedAttempt],
    [
      'same-attempt',
      `printf '${requestedAttempt}\\n' >"$EXTERNAL_FENCE_MARKER"`,
      false,
      requestedAttempt,
    ],
    [
      'system-wrong-mode',
      `printf 'system\\n' >"$EXTERNAL_FENCE_MARKER"\nchmod 0644 "$EXTERNAL_FENCE_MARKER"`,
      false,
      'system',
    ],
    ['unknown', `printf 'unknown\\n' >"$EXTERNAL_FENCE_MARKER"`, false, 'system'],
    [
      'different-attempt',
      `printf '${differentAttempt}\\n' >"$EXTERNAL_FENCE_MARKER"`,
      false,
      'system',
    ],
    ['symlink', '', true, 'system'],
  ]) {
    const observed = runHarness({
      source: guardFunctions,
      markerState: 'generic',
      externalSymlink,
      body: `
${setup}
mark_external_fence '${requestedAttempt}'
printf '%s\\n' "$(<"$EXTERNAL_FENCE_MARKER")" >"$OUTCOME"
`,
    });
    assert.equal(observed.result.status, 0, `${name}: ${observed.result.stderr}`);
    assert.equal(observed.outcome, expected, name);
    assert.deepEqual(observed.external, { kind: 'file', mode: 0o600, value: expected }, name);
    if (externalSymlink) assert.equal(observed.victim, 'victim-must-not-change', name);
  }

  const systemProvenance = runHarness({
    source: guardFunctions,
    markerState: 'generic',
    body: `
printf 'system\\n' >"$EXTERNAL_FENCE_MARKER"
chmod 0600 "$EXTERNAL_FENCE_MARKER"
mark_external_fence 'attempt aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 10 2'
printf '%s\\n' "$(<"$EXTERNAL_FENCE_MARKER")" >"$OUTCOME"
`,
  });
  assert.equal(systemProvenance.result.status, 0, systemProvenance.result.stderr);
  assert.equal(systemProvenance.outcome, 'system');
  assert.deepEqual(systemProvenance.external, { kind: 'file', mode: 0o600, value: 'system' });

  const guardRecoveryFunctions = `${guardFunctions}\n${functionRegion(
    'scripts/combo-dev-storage-guard.sh',
    'recoverable_attempt_fence_identity() {',
    'forwarders_stopped() {',
  )}`;
  for (const [name, setup, expected] of [
    [
      'exact-pair',
      `printf '${requestedAttempt}\\n' >"$EXTERNAL_FENCE_MARKER"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 10 2 9999999999\\n' >"$ACCEPTANCE_PENDING_MARKER"`,
      requestedAttempt,
    ],
    ['missing-pending', `printf '${requestedAttempt}\\n' >"$EXTERNAL_FENCE_MARKER"`, 'rejected'],
    [
      'mismatched-pending',
      `printf '${requestedAttempt}\\n' >"$EXTERNAL_FENCE_MARKER"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 10 3 9999999999\\n' >"$ACCEPTANCE_PENDING_MARKER"`,
      'rejected',
    ],
    [
      'extra-newline',
      `printf '${requestedAttempt}\\n' >"$EXTERNAL_FENCE_MARKER"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 10 2 9999999999\\n\\n' >"$ACCEPTANCE_PENDING_MARKER"`,
      'rejected',
    ],
  ]) {
    const observed = runHarness({
      source: guardRecoveryFunctions,
      markerState: 'generic',
      body: `
${setup}
if identity=$(recoverable_attempt_fence_identity); then
  printf '%s\\n' "$identity" >"$OUTCOME"
else
  printf 'rejected\\n' >"$OUTCOME"
fi
`,
    });
    assert.equal(observed.result.status, 0, `${name}: ${observed.result.stderr}`);
    assert.equal(observed.outcome, expected, name);
  }

  const deployFunctions = functionRegion(
    'scripts/combo-dev-deploy.sh',
    'write_writers_fence() {',
    'apply_foundation_replicas() {',
  );
  for (const markerState of ['absent', 'safe', 'generic', 'unknown', 'wrong-mode', 'symlink']) {
    const observed = runHarness({
      source: deployFunctions,
      markerState,
      body: `
if claim_safe_idle_fence; then
  printf '%s\\n' success >"$OUTCOME"
else
  printf '%s\\n' rejected >"$OUTCOME"
fi
`,
    });
    assert.equal(observed.result.status, 0, `${markerState}: ${observed.result.stderr}`);
    assert.equal(observed.outcome, markerState === 'safe' ? 'success' : 'rejected', markerState);
    if (markerState === 'safe') {
      assert.deepEqual(observed.marker, { kind: 'file', mode: 0o600, value: generic });
    }
  }
  const interruptedClaim = runHarness({
    source: deployFunctions,
    markerState: 'safe',
    body: `
mark_failure_fence() { kill -TERM "$$"; }
trap 'printf "%s\\n" "$MUTATING" >"$OUTCOME"; exit 143' TERM
claim_safe_idle_fence
`,
  });
  assert.equal(interruptedClaim.result.status, 143);
  assert.equal(interruptedClaim.outcome, '1');
  assert.deepEqual(interruptedClaim.marker, { kind: 'file', mode: 0o600, value: safe });

  const failedDeployCapability = runHarness({
    source: deployFunctions,
    markerState: 'generic',
    body: `
ATTEMPT_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ATTEMPT_RUN_ID=10
ATTEMPT_RUN_ATTEMPT=2
record_failed_attempt_capability
printf '%s\\n' "$(<"$EXTERNAL_FENCE_MARKER")" >"$OUTCOME"
`,
  });
  assert.equal(failedDeployCapability.result.status, 0, failedDeployCapability.result.stderr);
  assert.equal(
    failedDeployCapability.outcome,
    'attempt aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 10 2',
  );
  assert.deepEqual(failedDeployCapability.external, {
    kind: 'file',
    mode: 0o600,
    value: 'attempt aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 10 2',
  });
  assert.equal(failedDeployCapability.pending.kind, 'file');
  assert.equal(failedDeployCapability.pending.mode, 0o600);
  assert.match(
    failedDeployCapability.pending.value,
    /^aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 10 2 [1-9][0-9]*$/,
  );

  const consumedProofCleanup = runHarness({
    source: deployFunctions,
    markerState: 'generic',
    body: `
ATTEMPT_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ATTEMPT_RUN_ID=10
ATTEMPT_RUN_ATTEMPT=2
RESET_PROOF_IN_USE="$STATE_DIR/reset-proof.$ATTEMPT_REVISION.$ATTEMPT_RUN_ID.$ATTEMPT_RUN_ATTEMPT.consumed.json"
printf '{}\\n' >"$RESET_PROOF_IN_USE"
if remove_consumed_reset_proof; then
  printf 'deleted\\n' >"$OUTCOME"
else
  printf 'retained\\n' >"$OUTCOME"
fi
`,
  });
  assert.equal(consumedProofCleanup.result.status, 0, consumedProofCleanup.result.stderr);
  assert.equal(consumedProofCleanup.outcome, 'deleted');

  const deployCleanup = sandboxSource(
    text('scripts/combo-dev-deploy.sh').slice(
      text('scripts/combo-dev-deploy.sh').indexOf('cleanup() {'),
      text('scripts/combo-dev-deploy.sh').indexOf('trap cleanup EXIT'),
    ),
  );
  for (const [name, proofSetup, expectedOutcome] of [
    ['unconsumed-proof-is-removed', `printf '{}\\n' >"$RESET_PROOF"`, 'capability'],
    ['unremovable-proof-blocks-capability', `mkdir "$RESET_PROOF"`, ''],
  ]) {
    const observed = runHarness({
      source: `${deployFunctions}\n${deployCleanup}`,
      markerState: 'generic',
      body: `
ATTEMPT_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ATTEMPT_RUN_ID=10
ATTEMPT_RUN_ATTEMPT=2
RESET_PROOF="$STATE_DIR/reset-proof.$ATTEMPT_REVISION.$ATTEMPT_RUN_ID.$ATTEMPT_RUN_ATTEMPT.json"
CONSUMED_RESET_PROOF="$STATE_DIR/reset-proof.$ATTEMPT_REVISION.$ATTEMPT_RUN_ID.$ATTEMPT_RUN_ATTEMPT.consumed.json"
RESET_PROOF_IN_USE=''
INCOMING_BUNDLE=''
CANDIDATE_RELEASE=''
RELEASE_DIR=''
RELEASE_CREATED=0
WORK=''
MUTATING=1
SUCCESS=0
${proofSetup}
stop_forwarders_for_failure() { return 0; }
fence_all_writers_cleanup() { return 0; }
verify_complete_writer_inventory_zero() { return 0; }
record_failed_attempt_capability() { printf 'capability\\n' >"$OUTCOME"; return 0; }
status() { :; }
cleanup
`,
    });
    assert.equal(observed.result.status, 0, `${name}: ${observed.result.stderr}`);
    assert.equal(observed.outcome, expectedOutcome, name);
  }

  for (const [path, end, action, stubs] of [
    ['scripts/combo-dev-bootstrap.sh', 'fence_all_writers_admin() {', 'mark_safe_idle_fence', ''],
    [
      'scripts/combo-dev-reset.sh',
      'apply_foundation_replicas() {',
      'finish_reset_safe_idle_fence',
      'forwarders_stopped() { return 0; }\nverify_all_writers_zero() { return 0; }\nverify_complete_writer_inventory_zero() { return 0; }',
    ],
  ]) {
    const functions = functionRegion(path, 'write_writers_fence() {', end);
    for (const markerState of ['absent', 'safe', 'generic', 'unknown', 'wrong-mode', 'symlink']) {
      const observed = runHarness({
        source: functions,
        markerState,
        body: `
${stubs}
if ${action}; then
  printf '%s\\n' success >"$OUTCOME"
else
  printf '%s\\n' rejected >"$OUTCOME"
fi
`,
      });
      assert.equal(observed.result.status, 0, `${path}/${markerState}: ${observed.result.stderr}`);
      assert.equal(observed.outcome, markerState === 'generic' ? 'success' : 'rejected');
      if (markerState === 'generic') {
        assert.deepEqual(observed.marker, { kind: 'file', mode: 0o600, value: safe });
      }
    }
  }

  const incompleteResetInventory = runHarness({
    source: functionRegion(
      'scripts/combo-dev-reset.sh',
      'write_writers_fence() {',
      'apply_foundation_replicas() {',
    ),
    markerState: 'generic',
    body: `
forwarders_stopped() { return 0; }
verify_all_writers_zero() { return 0; }
verify_complete_writer_inventory_zero() { return 1; }
if finish_reset_safe_idle_fence; then
  printf 'accepted\\n' >"$OUTCOME"
else
  printf 'rejected\\n' >"$OUTCOME"
fi
`,
  });
  assert.equal(incompleteResetInventory.result.status, 0, incompleteResetInventory.result.stderr);
  assert.equal(incompleteResetInventory.outcome, 'rejected');
  assert.deepEqual(incompleteResetInventory.marker, {
    kind: 'file',
    mode: 0o600,
    value: generic,
  });

  const resetFunctions = functionRegion(
    'scripts/combo-dev-reset.sh',
    'write_writers_fence() {',
    'apply_foundation_replicas() {',
  );
  const resetProofCleanup = runHarness({
    source: resetFunctions,
    markerState: 'generic',
    body: `
RESET_PROOF_ROOT="$STATE_DIR"
WORK="$STATE_DIR/work"
mkdir "$WORK"
printf '{}\\n' >"$STATE_DIR/reset-proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.20.3.json"
printf '{}\\n' >"$STATE_DIR/reset-proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.20.3.consumed.json"
if remove_all_reset_proofs; then
  printf 'deleted\\n' >"$OUTCOME"
else
  printf 'retained\\n' >"$OUTCOME"
fi
`,
  });
  assert.equal(resetProofCleanup.result.status, 0, resetProofCleanup.result.stderr);
  assert.equal(resetProofCleanup.outcome, 'deleted');

  const resetProofEpochReplacement = runHarness({
    source: resetFunctions,
    markerState: 'generic',
    body: `
RESET_PROOF_ROOT="$STATE_DIR"
WORK="$STATE_DIR/work"
mkdir "$WORK"
old_proof="$STATE_DIR/reset-proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.10.1.json"
old_consumed="$STATE_DIR/reset-proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.10.1.consumed.json"
new_proof="$STATE_DIR/reset-proof.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.20.2.json"
printf '{}\\n' >"$old_proof"
printf '{}\\n' >"$old_consumed"
if remove_all_reset_proofs; then
  printf '{}\\n' >"$new_proof"
fi
if [[ ! -e "$old_proof" && ! -L "$old_proof" &&
  ! -e "$old_consumed" && ! -L "$old_consumed" && -f "$new_proof" ]]; then
  printf 'replaced\\n' >"$OUTCOME"
else
  printf 'replayable\\n' >"$OUTCOME"
fi
`,
  });
  assert.equal(
    resetProofEpochReplacement.result.status,
    0,
    resetProofEpochReplacement.result.stderr,
  );
  assert.equal(resetProofEpochReplacement.outcome, 'replaced');

  for (const [name, setup] of [
    [
      'symlink',
      `printf '{}\\n' >"$STATE_DIR/proof-target"\nln -s "$STATE_DIR/proof-target" "$STATE_DIR/reset-proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.10.1.json"`,
    ],
    [
      'directory',
      `mkdir "$STATE_DIR/reset-proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.10.1.json"`,
    ],
    ['invalid-name', `printf '{}\\n' >"$STATE_DIR/reset-proof.invalid.json"`],
    [
      'wrong-mode',
      `printf '{}\\n' >"$STATE_DIR/reset-proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.10.1.json"\nchmod 0644 "$STATE_DIR/reset-proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.10.1.json"`,
    ],
  ]) {
    const observed = runHarness({
      source: resetFunctions,
      markerState: 'generic',
      body: `
RESET_PROOF_ROOT="$STATE_DIR"
WORK="$STATE_DIR/work"
mkdir "$WORK"
${setup}
if remove_all_reset_proofs; then
  printf 'accepted\\n' >"$OUTCOME"
else
  printf 'rejected\\n' >"$OUTCOME"
fi
`,
    });
    assert.equal(observed.result.status, 0, `${name}: ${observed.result.stderr}`);
    assert.equal(observed.outcome, 'rejected', name);
  }

  const resetCleanup = sandboxSource(
    text('scripts/combo-dev-reset.sh').slice(
      text('scripts/combo-dev-reset.sh').indexOf('cleanup() {'),
      text('scripts/combo-dev-reset.sh').indexOf('trap cleanup EXIT'),
    ),
  );
  const invalidProofBlocksRecovery = runHarness({
    source: `${resetFunctions}\n${resetCleanup}`,
    markerState: 'generic',
    body: `
RESET_PROOF_ROOT="$STATE_DIR"
WORK="$STATE_DIR/work"
mkdir "$WORK"
mkdir "$STATE_DIR/reset-proof.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.10.1.json"
MUTATING=1
SUCCESS=0
stop_forwarders() { return 0; }
fence_all_writers() { return 0; }
verify_complete_writer_inventory_zero() { return 0; }
record_failed_attempt_capability() { printf 'capability\\n' >"$OUTCOME"; return 0; }
status() { :; }
cleanup
`,
  });
  assert.equal(
    invalidProofBlocksRecovery.result.status,
    0,
    invalidProofBlocksRecovery.result.stderr,
  );
  assert.equal(invalidProofBlocksRecovery.outcome, '');

  const bootstrapProofCleanup = functionRegion(
    'scripts/combo-dev-bootstrap.sh',
    'remove_all_reset_proofs() {',
    'fence_all_writers_admin() {',
  ).trim();
  const resetProofCleanupFunction = functionRegion(
    'scripts/combo-dev-reset.sh',
    'remove_all_reset_proofs() {',
    'write_private_attempt_marker() {',
  ).trim();
  assert.equal(bootstrapProofCleanup, resetProofCleanupFunction);
  const bootstrapSource = text('scripts/combo-dev-bootstrap.sh');
  const bootstrapMain = bootstrapSource.slice(bootstrapSource.indexOf('main() {'));
  assert.ok(
    bootstrapMain.indexOf('remove_all_reset_proofs') <
      bootstrapMain.indexOf('mark_safe_idle_fence'),
  );
  const resetSource = text('scripts/combo-dev-reset.sh');
  const resetMain = resetSource.slice(resetSource.indexOf('main() {'));
  const beginMutation = resetMain.indexOf('begin_reset_mutation_fence');
  const firstProofPurge = resetMain.indexOf('remove_all_reset_proofs', beginMutation);
  const secondProofPurge = resetMain.indexOf('remove_all_reset_proofs', firstProofPurge + 1);
  const writeProof = resetMain.indexOf('write_reset_proof', secondProofPurge);
  assert.ok(beginMutation < firstProofPurge && firstProofPurge < secondProofPurge);
  assert.ok(secondProofPurge < writeProof);

  const rejectedResetPreservesProof = runHarness({
    source: resetFunctions,
    markerState: 'generic',
    body: `
ATTEMPT_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ATTEMPT_RUN_ID=20
ATTEMPT_RUN_ATTEMPT=3
RESET_PROOF="$STATE_DIR/reset-proof.$ATTEMPT_REVISION.$ATTEMPT_RUN_ID.$ATTEMPT_RUN_ATTEMPT.json"
CONSUMED_RESET_PROOF="$STATE_DIR/reset-proof.$ATTEMPT_REVISION.$ATTEMPT_RUN_ID.$ATTEMPT_RUN_ATTEMPT.consumed.json"
printf '{}\\n' >"$RESET_PROOF"
printf 'system\\n' >"$EXTERNAL_FENCE_MARKER"
if begin_reset_mutation_fence "$ATTEMPT_REVISION" "$ATTEMPT_RUN_ID" "$ATTEMPT_RUN_ATTEMPT"; then
  printf 'accepted\\n' >"$OUTCOME"
elif [[ -f "$RESET_PROOF" && "$MUTATING" == 0 ]]; then
  printf 'preserved\\n' >"$OUTCOME"
else
  printf 'lost\\n' >"$OUTCOME"
fi
`,
  });
  assert.equal(
    rejectedResetPreservesProof.result.status,
    0,
    rejectedResetPreservesProof.result.stderr,
  );
  assert.equal(rejectedResetPreservesProof.outcome, 'preserved');

  const zeroController = (kind) => ({
    kind,
    spec: { replicas: 0 },
    status: { replicas: 0, readyReplicas: 0, availableReplicas: 0 },
  });
  for (const [name, items, expected] of [
    ['empty', [], 'zero'],
    [
      'scaled-zero-controllers',
      [
        zeroController('Deployment'),
        zeroController('StatefulSet'),
        zeroController('ReplicaSet'),
        zeroController('ReplicationController'),
        { kind: 'Pod', status: { phase: 'Succeeded', containerStatuses: [] } },
      ],
      'zero',
    ],
    ['active-replicaset', [{ ...zeroController('ReplicaSet'), spec: { replicas: 1 } }], 'active'],
    [
      'active-replication-controller',
      [{ ...zeroController('ReplicationController'), status: { replicas: 1 } }],
      'active',
    ],
    ['hpa', [{ kind: 'HorizontalPodAutoscaler' }], 'active'],
    ['daemonset', [{ kind: 'DaemonSet' }], 'active'],
    ['job', [{ kind: 'Job' }], 'active'],
    [
      'running-pod',
      [
        {
          kind: 'Pod',
          status: { phase: 'Running', containerStatuses: [{ state: { running: {} } }] },
        },
      ],
      'active',
    ],
  ]) {
    const observed = runHarness({
      source: resetFunctions,
      markerState: 'generic',
      environment: { INVENTORY_JSON: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }) },
      body: `
fake_kubectl() { printf '%s\\n' "$INVENTORY_JSON"; }
timeout() { shift; "$@"; }
K=(fake_kubectl)
NAMESPACE=combo-preview
WORK=$(dirname "$STATE_DIR")
if verify_complete_writer_inventory_zero; then
  printf 'zero\\n' >"$OUTCOME"
else
  printf 'active\\n' >"$OUTCOME"
fi
`,
    });
    assert.equal(observed.result.status, 0, `${name}: ${observed.result.stderr}`);
    assert.equal(observed.outcome, expected, name);
  }
  for (const markerState of ['absent', 'safe', 'generic', 'unknown', 'wrong-mode', 'symlink']) {
    const observed = runHarness({
      source: resetFunctions,
      markerState,
      body: `
stop_forwarders() { return 0; }
if begin_reset_mutation_fence aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 20 3; then
  printf 'success:%s\\n' "$MUTATING" >"$OUTCOME"
else
  printf 'rejected:%s\\n' "$MUTATING" >"$OUTCOME"
fi
`,
    });
    assert.equal(observed.result.status, 0, `${markerState}: ${observed.result.stderr}`);
    const accepted = markerState === 'absent' || markerState === 'safe';
    assert.equal(observed.outcome, accepted ? 'success:1' : 'rejected:0');
    if (accepted) {
      assert.deepEqual(observed.marker, { kind: 'file', mode: 0o600, value: generic });
    }
  }

  const oldRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const exactRecovery = runHarness({
    source: resetFunctions,
    markerState: 'generic',
    body: `
forwarders_stopped() { return 0; }
stop_forwarders() { return 0; }
verify_complete_writer_inventory_zero() { return 0; }
printf 'attempt ${oldRevision} 10 2\\n' >"$EXTERNAL_FENCE_MARKER"
printf '${oldRevision} 10 2 9999999999\\n' >"$ACCEPTANCE_PENDING_MARKER"
chmod 0600 "$EXTERNAL_FENCE_MARKER" "$ACCEPTANCE_PENDING_MARKER"
if begin_reset_mutation_fence aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 20 3; then
  printf 'success:%s:%s\\n' "$MUTATING" "$RECOVERED_FROM_ATTEMPT" >"$OUTCOME"
else
  printf 'rejected:%s\\n' "$MUTATING" >"$OUTCOME"
fi
`,
  });
  assert.equal(exactRecovery.result.status, 0, exactRecovery.result.stderr);
  assert.equal(exactRecovery.outcome, `success:1:${oldRevision} 10 2`);
  assert.deepEqual(exactRecovery.marker, { kind: 'file', mode: 0o600, value: generic });
  assert.deepEqual(exactRecovery.external, { kind: 'absent' });
  assert.deepEqual(exactRecovery.pending, { kind: 'absent' });

  const repeatedFailureRecovery = runHarness({
    source: resetFunctions,
    markerState: 'generic',
    body: `
forwarders_stopped() { return 0; }
stop_forwarders() { return 0; }
verify_complete_writer_inventory_zero() { return 0; }
ATTEMPT_REVISION=${oldRevision}
ATTEMPT_RUN_ID=10
ATTEMPT_RUN_ATTEMPT=2
record_failed_attempt_capability
MUTATING=0
begin_reset_mutation_fence aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 20 3
first_recovery=$RECOVERED_FROM_ATTEMPT
ATTEMPT_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ATTEMPT_RUN_ID=20
ATTEMPT_RUN_ATTEMPT=3
record_failed_attempt_capability
MUTATING=0
begin_reset_mutation_fence cccccccccccccccccccccccccccccccccccccccc 30 4
printf '%s|%s\\n' "$first_recovery" "$RECOVERED_FROM_ATTEMPT" >"$OUTCOME"
`,
  });
  assert.equal(repeatedFailureRecovery.result.status, 0, repeatedFailureRecovery.result.stderr);
  assert.equal(
    repeatedFailureRecovery.outcome,
    `${oldRevision} 10 2|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 20 3`,
  );
  assert.deepEqual(repeatedFailureRecovery.external, { kind: 'absent' });
  assert.deepEqual(repeatedFailureRecovery.pending, { kind: 'absent' });

  for (const [name, setup] of [
    [
      'same-current-attempt',
      `printf 'attempt aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 20 3\\n' >"$EXTERNAL_FENCE_MARKER"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 20 3 9999999999\\n' >"$ACCEPTANCE_PENDING_MARKER"`,
    ],
    [
      'system',
      `printf 'system\\n' >"$EXTERNAL_FENCE_MARKER"
printf '${oldRevision} 10 2 9999999999\\n' >"$ACCEPTANCE_PENDING_MARKER"`,
    ],
    [
      'identity-mismatch',
      `printf 'attempt ${oldRevision} 10 2\\n' >"$EXTERNAL_FENCE_MARKER"
printf '${oldRevision} 10 3 9999999999\\n' >"$ACCEPTANCE_PENDING_MARKER"`,
    ],
    ['missing-pending', `printf 'attempt ${oldRevision} 10 2\\n' >"$EXTERNAL_FENCE_MARKER"`],
    [
      'wrong-mode',
      `printf 'attempt ${oldRevision} 10 2\\n' >"$EXTERNAL_FENCE_MARKER"
printf '${oldRevision} 10 2 9999999999\\n' >"$ACCEPTANCE_PENDING_MARKER"
chmod 0644 "$EXTERNAL_FENCE_MARKER"`,
    ],
    [
      'external-extra-newline',
      `printf 'attempt ${oldRevision} 10 2\\n\\n' >"$EXTERNAL_FENCE_MARKER"
printf '${oldRevision} 10 2 9999999999\\n' >"$ACCEPTANCE_PENDING_MARKER"`,
    ],
    [
      'pending-extra-newline',
      `printf 'attempt ${oldRevision} 10 2\\n' >"$EXTERNAL_FENCE_MARKER"
printf '${oldRevision} 10 2 9999999999\\n\\n' >"$ACCEPTANCE_PENDING_MARKER"`,
    ],
  ]) {
    const observed = runHarness({
      source: resetFunctions,
      markerState: 'generic',
      body: `
forwarders_stopped() { return 0; }
verify_complete_writer_inventory_zero() { return 0; }
${setup}
if begin_reset_mutation_fence aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 20 3; then
  printf 'success:%s\\n' "$MUTATING" >"$OUTCOME"
else
  printf 'rejected:%s\\n' "$MUTATING" >"$OUTCOME"
fi
`,
    });
    assert.equal(observed.result.status, 0, `${name}: ${observed.result.stderr}`);
    assert.equal(observed.outcome, 'rejected:0', name);
    assert.deepEqual(observed.marker, { kind: 'file', mode: 0o600, value: generic });
    assert.notDeepEqual(observed.external, { kind: 'absent' }, name);
  }

  for (const environment of [{ WRITER_ACTIVE: '1' }, { FORWARDER_ACTIVE: '1' }]) {
    const observed = runHarness({
      source: resetFunctions,
      markerState: 'generic',
      environment,
      body: `
forwarders_stopped() { [[ "\${FORWARDER_ACTIVE:-0}" == 0 ]]; }
verify_complete_writer_inventory_zero() { [[ "\${WRITER_ACTIVE:-0}" == 0 ]]; }
printf 'attempt ${oldRevision} 10 2\\n' >"$EXTERNAL_FENCE_MARKER"
printf '${oldRevision} 10 2 9999999999\\n' >"$ACCEPTANCE_PENDING_MARKER"
chmod 0600 "$EXTERNAL_FENCE_MARKER" "$ACCEPTANCE_PENDING_MARKER"
if begin_reset_mutation_fence aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 20 3; then
  printf 'success:%s\\n' "$MUTATING" >"$OUTCOME"
else
  printf 'rejected:%s\\n' "$MUTATING" >"$OUTCOME"
fi
`,
    });
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.equal(observed.outcome, 'rejected:0');
    assert.deepEqual(observed.marker, { kind: 'file', mode: 0o600, value: generic });
    assert.notDeepEqual(observed.external, { kind: 'absent' });
    assert.notDeepEqual(observed.pending, { kind: 'absent' });
  }

  const blockedByExternal = runHarness({
    source: resetFunctions,
    markerState: 'safe',
    externalSymlink: true,
    body: `
if begin_reset_mutation_fence aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 20 3; then
  printf 'success:%s\\n' "$MUTATING" >"$OUTCOME"
else
  printf 'rejected:%s\\n' "$MUTATING" >"$OUTCOME"
fi
`,
  });
  assert.equal(blockedByExternal.result.status, 0, blockedByExternal.result.stderr);
  assert.equal(blockedByExternal.outcome, 'rejected:0');
  assert.deepEqual(blockedByExternal.marker, { kind: 'file', mode: 0o600, value: safe });
  assert.equal(blockedByExternal.victim, 'victim-must-not-change');

  const interruptedReset = runHarness({
    source: resetFunctions,
    markerState: 'safe',
    body: `
mark_failure_fence() { kill -TERM "$$"; }
trap 'printf "%s\\n" "$MUTATING" >"$OUTCOME"; exit 143' TERM
begin_reset_mutation_fence aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 20 3
`,
  });
  assert.equal(interruptedReset.result.status, 143);
  assert.equal(interruptedReset.outcome, '1');
  assert.deepEqual(interruptedReset.marker, { kind: 'file', mode: 0o600, value: safe });

  for (const environment of [{ WRITER_ACTIVE: '1' }, { FORWARDER_ACTIVE: '1' }]) {
    const observed = runHarness({
      source: resetFunctions,
      markerState: 'generic',
      environment,
      body: `
forwarders_stopped() { [[ "\${FORWARDER_ACTIVE:-0}" == 0 ]]; }
verify_all_writers_zero() { [[ "\${WRITER_ACTIVE:-0}" == 0 ]]; }
if finish_reset_safe_idle_fence; then
  printf '%s\\n' success >"$OUTCOME"
else
  printf '%s\\n' rejected >"$OUTCOME"
fi
`,
    });
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.equal(observed.outcome, 'rejected');
    assert.deepEqual(observed.marker, { kind: 'file', mode: 0o600, value: generic });
  }
});

test('post-deploy acceptance is TTL-bound and failure fencing cannot mint a replay proof', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');

  assert.match(deploy, /ACCEPTANCE_PENDING_SECONDS=7200/);
  assert.match(deploy, /claim_safe_idle_fence[\s\S]*consume_reset_proof/);
  const proofConsumption = deploy.slice(
    deploy.indexOf('consume_reset_proof() {'),
    deploy.indexOf('validate_cluster_platform_live() {'),
  );
  assert.ok(
    proofConsumption.indexOf('writers_fence_has_value "$FAILURE_FENCE_VALUE"') <
      proofConsumption.indexOf('mv -T -- "$RESET_PROOF"'),
  );
  assert.ok(
    proofConsumption.indexOf('! -e "$EXTERNAL_FENCE_MARKER"') <
      proofConsumption.indexOf('mv -T -- "$RESET_PROOF"'),
  );
  assert.match(
    deploy,
    /flock -w 300 8[\s\S]*! -e "\$EXTERNAL_FENCE_MARKER" && ! -L "\$EXTERNAL_FENCE_MARKER"[\s\S]*! -e "\$PUBLICATION_MARKER" && ! -L "\$PUBLICATION_MARKER"[\s\S]*write_acceptance_pending[\s\S]*rm -f -- "\$FAILURE_FENCE_MARKER"/,
  );
  assert.match(guard, /--fence-attempt\)/);
  assert.match(guard, /fence_now '受控 Test 后置验收未完成' 0 0/);
  assert.match(guard, /mark_failure_fence[\s\S]*mark_external_fence/);
  assert.match(
    guard,
    /recoverable_attempt_fence_identity\(\)[\s\S]*\^attempt\\ \[0-9a-f\]\{40\}[\s\S]*ACCEPTANCE_PENDING_MARKER/,
  );
  assert.match(
    guard,
    /fence_now\(\)[\s\S]*flock -w 300 8[\s\S]*identity" == preserve-attempt[\s\S]*recoverable_attempt_fence_identity/,
  );
  assert.match(
    guard,
    /FAILURE_FENCE_MARKER[\s\S]*fence_now '持久失败阻断标记仍然存在' 0 0 preserve-attempt/,
  );
  assert.match(
    guard,
    /ACCEPTANCE_PENDING_MARKER[\s\S]*flock -w 300 8[\s\S]*pending_acceptance_state[\s\S]*fence_now_locked 'Test 后置验收超过固定期限'/,
  );
  assert.match(
    guard,
    /complete_acceptance[\s\S]*marker_run_id[\s\S]*marker_run_attempt[\s\S]*rm -f -- "\$ACCEPTANCE_PENDING_MARKER"/,
  );
  assert.doesNotMatch(guard, /reset-proof|RESET_PROOF|wipe_static_volume_data/);
  assert.match(reset, /begin_reset_mutation_fence/);
  assert.match(reset, /finish_reset_safe_idle_fence/);
  const failureFence = workflow.slice(
    workflow.indexOf('Fence Test after post-deploy acceptance failure'),
    workflow.indexOf('Remove transient runner and upload files'),
  );
  assert.match(failureFence, /--fence-attempt "\$REVISION" "\$RUN_ID" "\$RUN_ATTEMPT"/);
  assert.doesNotMatch(failureFence, /combo-dev-reset|DESTROY-COMBO-PREVIEW-DATA/);
});

test('the always-on host guard uses an independent minimal fencer for missing, malformed, expiring, or unauthorized dispatcher credentials', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  const unit = text('infra/host/combo-dev/combo-dev-storage-guard.service');
  const timer = text('infra/host/combo-dev/combo-dev-storage-guard.timer');
  const rbac = text('infra/k8s/overlays/combo-dev/platform/rbac.yaml');
  const lease = text('scripts/combo-dev-forwarder-lease.sh');
  assert.match(bootstrap, /issue_client_credential combo-dev-dispatcher 90/);
  assert.match(bootstrap, /issue_client_credential combo-dev-fencer 365/);
  assert.match(bootstrap, /provision_fencer_credential[\s\S]*provision_dispatcher_credential/);
  assert.match(deploy, /DISPATCHER_OPERATION_MIN_SECONDS=\$\(\(4 \* 60 \* 60\)\)/);
  for (const script of [deploy, reset, guard]) {
    assert.match(script, /DISPATCHER_FENCE_BEFORE_SECONDS=\$\(\(7 \* 24 \* 60 \* 60\)\)/);
  }
  assert.doesNotMatch(unit, /ConditionPathExists/);
  assert.match(unit, /^ProtectHome=read-only$/m);
  assert.match(unit, /^RuntimeDirectory=combo-dev-storage-guard$/m);
  assert.match(unit, /^RuntimeDirectoryMode=0700$/m);
  assert.match(unit, /^ReadWritePaths=\/run \/var\/lib\/combo-dev$/m);
  assert.doesNotMatch(
    unit,
    /ReadWritePaths=.*(?:\/home\/xingzheng\/data|\/opt\/combo-dev|\/var\/lib\/combo-dev\/evidence)/m,
  );
  assert.match(guard, /readonly GUARD_RUNTIME='\/run\/combo-dev-storage-guard'/);
  assert.match(guard, /host_findmnt\(\) \{ findmnt --task 1 "\$@"; \}/);
  const hostFindmntCalls = [...guard.matchAll(/\$\(host_findmnt ([^\n]+)/g)].map(
    (match) => match[1],
  );
  assert.ok(hostFindmntCalls.length >= 18);
  assert.doesNotMatch(guard, /\$\(findmnt /);
  assert.match(timer, /^OnActiveSec=1min$/m);
  assert.match(timer, /^OnUnitInactiveSec=1min$/m);
  assert.doesNotMatch(timer, /^OnUnitActiveSec=/m);
  for (const script of [bootstrap, deploy, reset]) {
    assert.match(script, /storage_guard_timer_ready\(\)/);
    assert.match(script, /systemctl is-active combo-dev-storage-guard\.timer/);
    assert.match(script, /NextElapseUSecMonotonic/);
    assert.match(script, /"\$next" != 0/);
    assert.match(script, /"\$next" != infinity/);
    assert.match(script, /storage_guard_timer_ready \|\| blocked/);
  }
  for (const script of [deploy, reset]) {
    const preflightStart = script.indexOf(
      script === deploy ? 'host_preflight() {' : 'preflight() {',
    );
    const preflight = script.slice(preflightStart, script.indexOf('\n}\n', preflightStart) + 2);
    assert.ok(
      preflight.indexOf('systemctl start combo-dev-storage-guard.service') <
        preflight.indexOf('storage_guard_timer_ready || blocked'),
    );
  }
  assert.match(guard, /--cache-dir="\$GUARD_RUNTIME\/kubectl-cache"/);
  assert.match(guard, /mktemp -d "\$GUARD_RUNTIME\/guard-credential\.XXXXXX"/);
  assert.doesNotMatch(
    guard,
    /--cache-dir="\$CONTROL_WORK|mktemp -d "\$CONTROL_WORK\/guard-credential/,
  );
  assert.match(guard, /--fence-host-maintenance\) fence_only=1; maintenance_fence=1/);
  assert.match(guard, /fence_now '受控 Test 主机存储维护' 0 0 system/);
  assert.match(guard, /mark_maintenance_fence_complete/);
  const fencerRoleStart = rbac.indexOf('kind: Role\nmetadata:\n  name: combo-dev-fencer');
  const fencerRoleEnd = rbac.indexOf('\n---', fencerRoleStart);
  assert.ok(fencerRoleStart >= 0);
  assert.ok(fencerRoleEnd > fencerRoleStart);
  const fencerRole = rbac.slice(fencerRoleStart, fencerRoleEnd);
  assert.match(
    fencerRole,
    /resources: \['deployments'\]\n {4}resourceNames: \['api', 'worker', 'runtime', 'web', 'redis-hot'\]\n {4}verbs: \['get'\]/,
  );
  assert.match(
    fencerRole,
    /resources: \['deployments\/scale'\]\n {4}resourceNames: \['api', 'worker', 'runtime', 'web', 'redis-hot'\]\n {4}verbs: \['patch'\]/,
  );
  assert.match(
    fencerRole,
    /resources: \['statefulsets'\]\n {4}resourceNames: \['postgres', 'redis-queue', 'minio'\]\n {4}verbs: \['get'\]/,
  );
  assert.match(
    fencerRole,
    /resources: \['statefulsets\/scale'\]\n {4}resourceNames: \['postgres', 'redis-queue', 'minio'\]\n {4}verbs: \['patch'\]/,
  );
  assert.equal(fencerRole.match(/\/scale/g)?.length, 2);
  assert.equal(fencerRole.match(/'patch'/g)?.length, 2);
  assert.doesNotMatch(fencerRole, /verbs: \[[^\]]*(?:create|update)[^\]]*\]/);
  assert.doesNotMatch(
    fencerRole,
    /resources: \['(?:deployments|statefulsets)'\]\n {4}resourceNames: [^\n]+\n {4}verbs: \[[^\]\n]*patch[^\]\n]*\]/,
  );
  for (const script of [bootstrap, guard]) {
    const canI = script.slice(
      script.indexOf(script === bootstrap ? 'can_i_with_credential() {' : 'can_i() {'),
      script.indexOf(
        script === bootstrap ? 'trusted_source_tree() {' : 'dispatcher_access_valid() {',
      ),
    );
    assert.match(canI, /--subresource="\$subresource"/);
    const fencerChecks = script.slice(
      script.indexOf(
        script === bootstrap ? 'fencer_credential_valid() {' : 'fencer_access_valid() {',
      ),
      script.indexOf(
        script === bootstrap ? 'issue_client_credential() {' : 'mark_failure_fence() {',
      ),
    );
    assert.match(fencerChecks, /yes patch "deployments\.apps\/\$name" "\$NAMESPACE" scale/);
    assert.match(fencerChecks, /yes patch "statefulsets\.apps\/\$name" "\$NAMESPACE" scale/);
    assert.match(fencerChecks, /no patch deployments\.apps\/api "\$NAMESPACE"/);
    assert.match(fencerChecks, /no update deployments\.apps\/api "\$NAMESPACE" scale/);
    assert.match(fencerChecks, /no patch deployments\.apps\/api "\$PRODUCTION_NAMESPACE" scale/);
  }
  assert.match(lease, /FAILURE_FENCE_MARKER/);

  const fenceBody = guard.slice(
    guard.indexOf('fence_now_locked() {'),
    guard.indexOf('fence_now() {'),
  );
  const persistenceBody = guard.slice(
    guard.indexOf('persist_fences_and_stop_forwarders() {'),
    guard.indexOf('fencer_resource_exists() {'),
  );
  assert.ok(
    persistenceBody.indexOf('mark_failure_fence') < persistenceBody.indexOf('mark_external_fence'),
  );
  assert.ok(
    persistenceBody.indexOf('mark_external_fence') < persistenceBody.indexOf('systemctl stop'),
  );
  assert.ok(
    fenceBody.indexOf('persist_fences_and_stop_forwarders "$identity" || failed=1') <
      fenceBody.indexOf('credential_certificate_valid_for "$FENCER_KUBECONFIG"'),
  );
  assert.ok(
    fenceBody.indexOf('credential_certificate_valid_for "$FENCER_KUBECONFIG"') <
      fenceBody.indexOf('fence_writers_with_minimal_credential'),
  );
  assert.ok(
    fenceBody.indexOf('fence_writers_with_minimal_credential') <
      fenceBody.indexOf('verify_complete_writer_inventory_zero'),
  );

  for (const [name, persistResult, inventoryResult] of [
    ['host-side-failure-still-fences-kubernetes', '1', '0'],
    ['unexpected-writer-prevents-pass', '0', '1'],
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
set -u
FENCER_KUBECONFIG=/unused
FENCER_OPERATION_MIN_SECONDS=1
LOW_MARKER=/unused
persist_fences_and_stop_forwarders() { printf 'persist\\n'; return "$PERSIST_RESULT"; }
credential_certificate_valid_for() { return 0; }
fencer_access_valid() { return 0; }
fence_writers_with_minimal_credential() { printf 'fencer\\n'; return 0; }
verify_complete_writer_inventory_zero() { printf 'inventory\\n'; return "$INVENTORY_RESULT"; }
fail() { printf 'fail\\n'; exit 97; }
status() { printf 'pass\\n'; }
${fenceBody}
fence_now_locked reason 0 0 system
`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PERSIST_RESULT: persistResult, INVENTORY_RESULT: inventoryResult },
      },
    );
    assert.equal(result.status, 97, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, 'persist\nfencer\ninventory\nfail\n', name);
  }
  for (const message of ['调度凭据缺失、损坏或进入预到期窗口', '调度凭据已失效或权限发生漂移']) {
    assert.ok(guard.includes(message));
  }

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-credential-guard-'));
  try {
    const caKey = join(work, 'ca.key');
    const caCert = join(work, 'ca.crt');
    const key = join(work, 'client.key');
    const request = join(work, 'client.csr');
    const expiring = join(work, 'expiring.crt');
    for (const args of [
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=test-ca',
        '-keyout',
        caKey,
        '-out',
        caCert,
      ],
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=combo-dev-dispatcher',
        '-keyout',
        key,
        '-out',
        request,
      ],
      [
        'x509',
        '-req',
        '-in',
        request,
        '-CA',
        caCert,
        '-CAkey',
        caKey,
        '-set_serial',
        '2',
        '-days',
        '1',
        '-out',
        expiring,
      ],
    ]) {
      execFileSync('openssl', args, { stdio: 'ignore' });
    }
    const kubeconfig = (certificate) =>
      `apiVersion: v1\nkind: Config\nclusters:\n- name: k3s\n  cluster:\n    server: https://127.0.0.1:6443\n    certificate-authority-data: ${readFileSync(caCert).toString('base64')}\nusers:\n- name: combo-dev-dispatcher\n  user:\n    client-certificate-data: ${readFileSync(certificate).toString('base64')}\n    client-key-data: ${readFileSync(key).toString('base64')}\ncontexts:\n- name: combo-dev\n  context:\n    cluster: k3s\n    user: combo-dev-dispatcher\ncurrent-context: combo-dev\n`;
    const expiringConfig = join(work, 'expiring.kubeconfig');
    const malformedConfig = join(work, 'malformed.kubeconfig');
    writeFileSync(expiringConfig, kubeconfig(expiring), { mode: 0o600 });
    writeFileSync(malformedConfig, 'not: [valid\n', { mode: 0o600 });
    const guardPath = join(repo, 'scripts/combo-dev-storage-guard.sh');
    const credentialHarness = (path) => `
source ${JSON.stringify(guardPath)}
private_file() { [[ -f "$1" ]]; }
credential_certificate_valid_for ${JSON.stringify(path)} combo-dev-dispatcher $((2 * 24 * 60 * 60))
`;
    for (const path of [join(work, 'missing.kubeconfig'), malformedConfig, expiringConfig]) {
      assert.notEqual(
        spawnSync('bash', ['-c', credentialHarness(path)], { stdio: 'ignore' }).status,
        0,
      );
    }
    const unauthorized = spawnSync(
      'bash',
      ['-c', `source ${JSON.stringify(guardPath)}; can_i() { return 1; }; dispatcher_access_valid`],
      { stdio: 'ignore' },
    );
    assert.notEqual(unauthorized.status, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the recurring storage guard timer rejects disabled, inactive, zero, and unscheduled states', () => {
  assert.equal(runStorageGuardTimerReadyFixture().status, 0);
  for (const fixture of [
    { enabled: 'disabled' },
    { active: 'inactive' },
    { next: '' },
    { next: '0' },
    { next: 'infinity' },
  ]) {
    const result = runStorageGuardTimerReadyFixture(fixture);
    assert.notEqual(result.status, 0, JSON.stringify(fixture));
  }
});

test('log audit retries delayed activity without weakening its fixed evidence set', () => {
  const result = runLogsAuditFixture('delayed');
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.match(result.stdout, /PASS sources=8 activity=3 redaction=PASS/);
  assert.equal((result.invocations.match(/logs worker-pod/g) ?? []).length, 2);
});

test('pre-artifact log baseline accepts an idle Worker while retaining all-source leak scans', () => {
  const result = runLogsAuditFixture('missing', 'baseline');
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.match(result.stdout, /PASS sources=8 activity=baseline redaction=PASS/);
  for (const app of [
    'api',
    'worker',
    'runtime',
    'web',
    'postgres',
    'redis-queue',
    'redis-hot',
    'minio',
  ]) {
    assert.match(result.invocations, new RegExp(`logs ${app}-pod`));
  }
});

test('log audit includes one bounded previous container after dependency recovery', () => {
  const result = runLogsAuditFixture('previous');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.invocations, /logs worker-pod -c worker --previous/);
  assert.match(result.stdout, /PASS sources=8 activity=3 redaction=PASS/);
});

test('log audit retries when container state changes during capture', () => {
  const result = runLogsAuditFixture('restart-race');
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.match(result.invocations, /logs worker-pod -c worker --previous/);
  assert.match(result.stdout, /PASS sources=8 activity=3 redaction=PASS/);
});

test('log audit remains blocked with a safe reason when activity never appears', () => {
  const result = runLogsAuditFixture('missing');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[combo-dev-logs\] BLOCKED: reason=worker-activity-missing\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /worker ready/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(result.markerValue));
});

test('log audit rejects restart history that cannot be covered by current and previous logs', () => {
  const result = runLogsAuditFixture('restart-multiple');
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /^\[combo-dev-logs\] BLOCKED: reason=source-worker-restart-history-out-of-range\n$/,
  );
  assert.doesNotMatch(result.invocations, /logs worker-pod/);
});

test('log audit blocks when its bounded combined corpus cannot be written', () => {
  const result = runLogsAuditFixture('cat-fail');
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /^\[combo-dev-logs\] BLOCKED: reason=source-minio-combined-log-unwritable\n$/,
  );
});

test('log audit blocks when its credential corpus cannot be searched', () => {
  const result = runLogsAuditFixture('grep-fail');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[combo-dev-logs\] BLOCKED: reason=log-corpus-unreadable\n$/);
});

test('log audit has a wall-clock deadline and blocks bounded corpus truncation', () => {
  const logs = text('scripts/combo-dev-logs.sh');
  assert.match(logs, /readonly AUDIT_MAX_SECONDS=90/);
  assert.match(logs, /AUDIT_DEADLINE_EPOCH=\$\(\(now \+ AUDIT_MAX_SECONDS\)\)/);
  assert.match(logs, /readonly LOG_CAPTURE_BYTES=8388609/);
  assert.match(logs, /head -c "\$LOG_CAPTURE_BYTES"/);
  assert.match(logs, /size < LOG_CAPTURE_BYTES/);
  assert.doesNotMatch(logs, /--tail=/);
  assert.doesNotMatch(logs, /--limit-bytes/);
  assert.match(logs, /retryable_reason\(\)/);
  assert.doesNotMatch(
    logs.slice(logs.indexOf('retryable_reason() {'), logs.indexOf('collect_snapshot() {')),
    /restart-history-out-of-range|log-corpus-unreadable|log-truncated/,
  );
});

test('log audit blocks when client-side capture reaches its hard byte boundary', () => {
  const result = runLogsAuditFixture('truncated');
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /^\[combo-dev-logs\] BLOCKED: reason=source-api-current-log-truncated\n$/,
  );
});

test('log audit fails immediately without echoing a detected marker', () => {
  const result = runLogsAuditFixture('leak');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\[combo-dev-logs\] FAIL: reason=synthetic-marker-detected\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(result.markerValue));
});

test('log audit scans previous container logs without echoing a detected marker', () => {
  const result = runLogsAuditFixture('previous-leak');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\[combo-dev-logs\] FAIL: reason=synthetic-marker-detected\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(result.markerValue));
});

test('log audit rejects credential patterns without echoing their payload', () => {
  const result = runLogsAuditFixture('credential');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\[combo-dev-logs\] FAIL: reason=credential-pattern-detected\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /TEST_SECRET_TOKEN/);
});

test('log audit cannot discard an early leak when a later source is unavailable', () => {
  const result = runLogsAuditFixture('leak-then-source-fail');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\[combo-dev-logs\] FAIL: reason=synthetic-marker-detected\n$/);
  assert.doesNotMatch(result.invocations, /logs runtime-pod/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(result.markerValue));
});

test('smoke exposes only allowlisted log-audit reason codes', () => {
  const smoke = text('scripts/combo-dev-smoke.sh');
  const start = smoke.indexOf('check_logs_fail_closed() {');
  const end = smoke.indexOf('\n}\n\nmain() {', start);
  assert.ok(start > 0 && end > start);
  const check = smoke.slice(start, end);
  assert.match(check, /log-audit\.status/);
  assert.match(check, /chmod 600 "\$diagnostic"/);
  assert.match(check, /diagnostic_line" =~ \^\\\[combo-dev-logs\\\]/);
  assert.match(check, /reason=\(\[a-z0-9-\]\{1,80\}\)/);
  assert.match(check, /DETAIL: log-audit=%s/);
  assert.doesNotMatch(check, /combo-dev-logs[\s\S]*>\/dev\/null 2>&1/);
});

test('smoke blocks before log audit when a synthetic activity probe is not delivered', () => {
  const result = runSmokeLogProbeFixture('transport');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[fixture\] BLOCKED: API 合成日志活动探针未送达。\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /aaaaaaaaaaaaaaaa/);
});

test('smoke requires the synthetic activity probe to reach the exact 404 route', () => {
  const result = runSmokeLogProbeFixture('wrong-status');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[fixture\] BLOCKED: API 合成日志活动探针未返回预期终态。\n$/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /aaaaaaaaaaaaaaaa/);
});

test('listener validation rejects every additional IPv4 or IPv6 address and wrong owning process', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  for (const script of [deploy, smoke]) {
    assert.match(script, /ss -H -ltnp/);
    assert.match(script, /systemctl show combo-dev-web-forward\.service -p MainPID/);
    assert.match(script, /validate-listeners/);
  }
  assert.match(
    deploy,
    /wait_loopback_listeners\(\) \{[\s\S]*for \(\(attempt = 1; attempt <= 30; attempt\+\+\)\)/,
  );
  assert.match(
    deploy,
    /systemctl start combo-dev-s3-forward\.service[\s\S]*wait_loopback_listeners/,
  );
  assert.match(deploy, /validate-listeners[\s\S]*\|\| return 1/);
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-listeners-'));
  try {
    const input = join(work, 'listeners');
    const line = (address, port, pid) =>
      `LISTEN 0 4096 ${address}:${port} 0.0.0.0:* users:(("kubectl",pid=${pid},fd=7))`;
    const base = [line('127.0.0.1', 18080, 111), line('127.0.0.1', 19000, 222)];
    const check = (lines) => {
      writeFileSync(input, `${lines.join('\n')}\n`);
      return spawnSync(
        'python3',
        [
          join(repo, 'scripts/combo-dev-production-safety.py'),
          'validate-listeners',
          '--input',
          input,
          '--web-pid',
          '111',
          '--s3-pid',
          '222',
        ],
        { stdio: 'ignore' },
      ).status;
    };
    assert.equal(check(base), 0);
    for (const extra of [
      line('192.0.2.25', 18080, 333),
      line('[2001:db8::25]', 18080, 333),
      line('0.0.0.0', 19000, 333),
      line('[::]', 19000, 333),
      line('[::1]', 19000, 333),
    ]) {
      assert.notEqual(check([...base, extra]), 0, extra);
    }
    assert.notEqual(check([line('127.0.0.1', 18080, 999), base[1]]), 0);
    assert.notEqual(check([base[0]]), 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('public live validator binds release images, Services, Pods, and EndpointSlices', () => {
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-public-live-'));
  const apiImage = imageArgs[1];
  const runtimeImage = imageArgs[3];
  const webImage = imageArgs[5];
  const images = {
    api: apiImage,
    worker: apiImage,
    runtime: runtimeImage,
    web: webImage,
    minio: MINIO_IMAGE,
  };
  const servicePorts = {
    api: ['http', 3000, 3000],
    runtime: ['http', 3100, 3100],
    web: ['http', 80, 8080],
    minio: ['api', 9000, 9000],
  };
  const paths = Object.fromEntries(
    ['images', 'metadata', 'deployments', 'statefulset', 'services', 'pods', 'slices'].map(
      (name) => [name, join(work, `${name}.json`)],
    ),
  );
  const deployment = (name) => ({
    metadata: { name, namespace: 'combo-preview', generation: 1 },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name, 'combo.dev/environment': 'combo-dev' } },
        spec: {
          containers: [
            {
              name,
              image: images[name],
              envFrom: [
                { configMapRef: { name: `combo-release-meta-${RELEASE_SHA.slice(0, 12)}` } },
              ],
            },
          ],
        },
      },
    },
    status: {
      observedGeneration: 1,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
    },
  });
  const pod = (name, index) => ({
    metadata: {
      name: name === 'minio' ? 'minio-0' : `${name}-fixture`,
      namespace: 'combo-preview',
      uid: `uid-${name}`,
      labels: { app: name, 'combo.dev/environment': 'combo-dev' },
    },
    spec: { containers: [{ name, image: images[name] }] },
    status: {
      phase: 'Running',
      podIP: `10.42.0.${index + 10}`,
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        {
          name,
          ready: true,
          image: images[name],
          imageID: `containerd://${images[name].split('@')[1]}`,
        },
      ],
    },
  });
  const payload = {
    metadata: {
      metadata: {
        name: `combo-release-meta-${RELEASE_SHA.slice(0, 12)}`,
        namespace: 'combo-preview',
      },
      immutable: true,
      data: {
        COMBO_ENVIRONMENT: 'test',
        COMBO_SOURCE_SHA: RELEASE_SHA,
        COMBO_RELEASE_ID: `release-${RELEASE_SHA}`,
      },
    },
    deployments: { kind: 'List', items: ['api', 'worker', 'runtime', 'web'].map(deployment) },
    statefulset: {
      metadata: { name: 'minio', namespace: 'combo-preview', generation: 1 },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'minio' } },
        template: {
          metadata: { labels: { app: 'minio', 'combo.dev/environment': 'combo-dev' } },
          spec: { containers: [{ name: 'minio', image: MINIO_IMAGE }] },
        },
      },
      status: {
        observedGeneration: 1,
        replicas: 1,
        currentReplicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        currentRevision: 'minio-revision',
        updateRevision: 'minio-revision',
      },
    },
    services: {
      kind: 'List',
      items: Object.entries(servicePorts).map(([name, [portName, port, targetPort]], index) => ({
        metadata: { name, namespace: 'combo-preview' },
        spec: {
          type: 'ClusterIP',
          clusterIP: `10.43.0.${index + 10}`,
          selector: { app: name },
          ports: [{ name: portName, port, protocol: 'TCP', targetPort }],
        },
      })),
    },
  };
  payload.pods = {
    kind: 'List',
    items: Object.keys(images).map((name, index) => pod(name, index)),
  };
  payload.slices = {
    kind: 'EndpointSliceList',
    items: Object.entries(servicePorts).map(([name, [portName, , targetPort]]) => {
      const selected = payload.pods.items.find((item) => item.metadata.labels.app === name);
      return {
        metadata: {
          name: `${name}-slice`,
          namespace: 'combo-preview',
          labels: { 'kubernetes.io/service-name': name },
        },
        ports: [{ name: portName, port: targetPort, protocol: 'TCP' }],
        endpoints: [
          {
            addresses: [selected.status.podIP],
            conditions: { ready: true },
            targetRef: {
              kind: 'Pod',
              namespace: 'combo-preview',
              name: selected.metadata.name,
              uid: selected.metadata.uid,
            },
          },
        ],
      };
    }),
  };
  const run = (overrides = {}) => {
    const candidate = structuredClone(payload);
    for (const [key, mutate] of Object.entries(overrides)) mutate(candidate[key]);
    writeFileSync(
      paths.images,
      `API_IMAGE=${apiImage}\nRUNTIME_IMAGE=${runtimeImage}\nWEB_IMAGE=${webImage}\n`,
    );
    for (const key of ['metadata', 'deployments', 'statefulset', 'services', 'pods', 'slices']) {
      writeFileSync(paths[key], `${JSON.stringify(candidate[key])}\n`);
    }
    return spawnSync(
      'python3',
      [
        join(repo, 'scripts/combo-dev-production-safety.py'),
        'validate-public-live',
        '--revision',
        RELEASE_SHA,
        '--image-metadata',
        paths.images,
        '--release-metadata',
        paths.metadata,
        '--deployments',
        paths.deployments,
        '--statefulset',
        paths.statefulset,
        '--services',
        paths.services,
        '--pods',
        paths.pods,
        '--endpoint-slices',
        paths.slices,
      ],
      { stdio: 'ignore' },
    ).status;
  };
  try {
    assert.equal(run(), 0);
    assert.notEqual(
      run({ services: (value) => (value.items[0].spec.selector = { app: 'web' }) }),
      0,
    );
    assert.notEqual(run({ pods: (value) => value.items.push(structuredClone(value.items[3])) }), 0);
    assert.notEqual(
      run({ pods: (value) => (value.items[3].status.containerStatuses[0].imageID = 'bad') }),
      0,
    );
    assert.notEqual(
      run({ slices: (value) => (value.items[0].endpoints[0].targetRef.uid = 'wrong') }),
      0,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('public Test publication keeps exact identity, isolated listeners, TLS hosts, and fail-closed cleanup', () => {
  const publication = text('scripts/combo-dev-publication.sh');
  const safety = text('scripts/combo-dev-production-safety.py');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  const webUnit = text('infra/host/combo-dev/combo-dev-public-web-forward.service');
  const s3Unit = text('infra/host/combo-dev/combo-dev-public-s3-forward.service');
  const nginx = text('infra/host/combo-dev/combo-dev-public-nginx.conf');
  const prepare = text('infra/host/combo-dev/combo-dev-prepare-public-domain.sh');
  const hostReadme = text('infra/host/combo-dev/README.md');

  assert.match(publication, /--open-pending/);
  assert.match(publication, /pending_matches "\$revision" "\$run_id" "\$run_attempt"/);
  assert.match(publication, /live_revision_matches "\$revision"/);
  assert.ok(publication.indexOf('flock -s -w 300 9') < publication.indexOf('flock -w 300 8'));
  assert.ok(publication.indexOf('flock -w 300 8') < publication.indexOf('flock -w 30 7'));
  assert.match(publication, /validate-public-listeners/);
  assert.match(publication, /validate-public-live/);
  assert.match(safety, /validate-public-listeners/);
  assert.match(safety, /validate-public-live/);
  assert.match(webUnit, /--address=127\.0\.0\.1 service\/web 18083:80/);
  assert.match(s3Unit, /--address=127\.0\.0\.1 service\/minio 19003:9000/);
  assert.doesNotMatch(`${webUnit}\n${s3Unit}`, /^\[Install\]$/m);

  assert.match(nginx, /server_name test\.43-160-242-46\.sslip\.io;/);
  assert.match(nginx, /server_name test-s3\.43-160-242-46\.sslip\.io;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:18083/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:19003/);
  assert.match(nginx, /access_log off;/);
  assert.match(nginx, /error_page 502 504 = @test_unavailable/);

  for (const source of [bootstrap, deploy, reset, guard]) {
    assert.match(source, /PUBLICATION_MARKER='\/var\/lib\/combo-dev\/publication'/);
    assert.match(source, /combo-dev-public-web-forward\.service/);
    assert.match(source, /combo-dev-public-s3-forward\.service/);
  }
  assert.match(reset, /validate-public-live/);
  assert.match(guard, /validate-public-live/);
  assert.match(bootstrap, /strict_remove_publication_marker \|\| failed=1/);
  assert.doesNotMatch(
    bootstrap,
    /rm -f -- "\$EXTERNAL_FENCE_MARKER" "\$ACCEPTANCE_PENDING_MARKER" "\$PUBLICATION_MARKER"/,
  );
  assert.match(guard, /acceptance=pending/);
  assert.match(guard, /publication=active/);
  assert.match(guard, /writers=safe-idle/);
  assert.match(prepare, /systemctl enable --now certbot-renew\.timer/);
  assert.match(prepare, /TIMER_ROLLBACK_ARMED=1/);
  assert.match(prepare, /-checkhost "\$WEB_HOST"/);
  assert.match(prepare, /-checkhost "\$S3_HOST"/);
  assert.match(prepare, /-checkend 604800/);
  assert.ok(
    hostReadme.indexOf('combo-dev-prepare-public-domain.sh --confirm=') <
      hostReadme.indexOf('sudo bash scripts/combo-dev-bootstrap.sh'),
  );
  assert.ok(
    prepare.indexOf('rm -f -- "$ACME_TARGET"') <
      prepare.indexOf('nginx -t >/dev/null 2>&1 && systemctl reload nginx.service'),
  );
});

test('public S3 smoke uses a fixed SigV4 vector and never emits credentials or signed URLs', () => {
  const smokePath = join(repo, 'scripts/combo-dev-public-s3-smoke.py');
  const source = readFileSync(smokePath, 'utf8');
  const result = spawnSync(
    'python3',
    [
      '-c',
      [
        'import datetime as dt,runpy,sys,urllib.parse',
        'm=runpy.run_path(sys.argv[1])',
        "u=m['presigned_url']('PUT','.combo-public-smoke/test.bin','testaccess','testsecret',dt.datetime(2026,8,4,12,0,0,tzinfo=dt.timezone.utc))",
        "print(urllib.parse.parse_qs(urllib.parse.urlsplit(u).query)['X-Amz-Signature'][0])",
      ].join(';'),
      smokePath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    '3da91ba3e6d0abc1653c6921294cf4ae795af92eb494cc8acb59e20603c53f69',
  );
  assert.match(source, /ProxyHandler\(\{\}\)/);
  assert.match(source, /hmac\.compare_digest\(received, body\)/);
  assert.match(source, /print\("\[combo-dev-public-s3-smoke] PASS operation=put-get-delete"\)/);
  assert.doesNotMatch(source, /print\([^\n]*(?:access_key|secret_key|presigned_url|url)/);
});

test('network canary uses a pinned deterministic TCP probe and proves its positive control before denied targets', () => {
  const smoke = text('scripts/combo-dev-smoke.sh');
  assert.match(
    smoke,
    /python@sha256:37b14db89f587f9eaa890e4a442a3fe55db452b69cca1403cc730bd0fbdc8aaf/,
  );
  assert.doesNotMatch(smoke, /\bnc\s+-z\b/);
  assert.doesNotMatch(
    smoke.slice(
      smoke.indexOf('run_network_canary() {'),
      smoke.indexOf('check_logs_fail_closed() {'),
    ),
    /hostPath:/,
  );
  const start = smoke.indexOf('              import os');
  const end = smoke.indexOf('              # The Web Service is SHA-scoped.', start);
  assert.ok(start > 0 && end > start);
  assert.match(smoke, /production_service = "release-postgres\.combo\.svc\.cluster\.local"/);
  assert.match(smoke, /\(production_service, 5432\)/);
  assert.doesNotMatch(smoke, /web\.combo\.svc\.cluster\.local/);
  const positiveControl = smoke
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/^ {14}/, ''))
    .join('\n');
  assert.ok(
    positiveControl.indexOf('probe("127.0.0.1", control_port)') <
      positiveControl.indexOf('control.close()'),
  );
  assert.equal(spawnSync('python3', ['-c', positiveControl], { stdio: 'ignore' }).status, 0);
  const brokenProbe = positiveControl.replace(
    'if connection.connect_ex(address) == 0:',
    'if False:',
  );
  assert.equal(spawnSync('python3', ['-c', brokenProbe], { stdio: 'ignore' }).status, 3);
  if (dockerAvailable) {
    assert.equal(
      spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--read-only',
          '--user',
          '65534:65534',
          'python@sha256:37b14db89f587f9eaa890e4a442a3fe55db452b69cca1403cc730bd0fbdc8aaf',
          'python3',
          '-c',
          positiveControl,
        ],
        { stdio: 'ignore' },
      ).status,
      0,
    );
  }
});

test('combo-dev nginx consumes the exact client-events route without proxying or logging its body', () => {
  const nginx = text('infra/k8s/overlays/combo-dev/apps/nginx-dev.conf');
  const match = nginx.match(/location = \/api\/v1\/client-events \{([\s\S]*?)\n {2}\}/);
  assert.ok(match);
  assert.match(match[1], /access_log off;/);
  assert.match(match[1], /return 204;/);
  assert.match(match[1], /Cache-Control "no-store"/);
  assert.doesNotMatch(match[1], /proxy_pass|\$request_body/);
  assert.equal((nginx.match(/\/api\/v1\/client-events/g) ?? []).length, 1);

  const root = fixture();
  try {
    const path = join(root, 'infra/k8s/overlays/combo-dev/apps/nginx-dev.conf');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        '    return 204;',
        '    proxy_pass http://$api_host:3000;',
      ),
    );
    expectRenderFailure(root, /guard:telemetry-boundary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Test prunes only stale Web and release metadata after proving every live reference', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const start = deploy.indexOf('prune_stale_configs() {');
  const end = deploy.indexOf('\ncheck_loopback_listeners_once() {', start);
  assert.ok(start > 0 && end > start);
  const prune = deploy.slice(start, end);
  assert.match(prune, /get deployment "\$\{APP_NAMES\[@\]\}" -o json/);
  assert.match(
    prune,
    /\(\[\.\[\]\.metadata\.name\] \| sort\) != \["api", "runtime", "web", "worker"\]/,
  );
  assert.match(prune, /\(\$release_refs \| unique \| length\) != 1/);
  assert.match(prune, /\^combo-release-meta-\[0-9a-f\]\{12\}\$/);
  assert.match(prune, /\^combo-dev-nginx-\[a-z0-9\]\+\$/);
  assert.match(
    prune,
    /get configmaps -l combo\.dev\/environment=combo-dev -o json[\s\S]*stale_json=/,
  );
  assert.match(prune, /delete "configmap\/\$name" --wait=false/);
  assert.doesNotMatch(prune, /delete "\$item"/);
  assert.ok(prune.indexOf('live_refs=$(') < prune.indexOf('listed=$('));
  assert.ok(prune.indexOf('stale_json=$(') < prune.indexOf('delete "configmap/$name"'));

  const flow = deploy.slice(deploy.indexOf('\nmain() {'));
  assert.ok(flow.indexOf('wait_apps ') < flow.indexOf('prune_stale_configs'));
  assert.ok(
    flow.indexOf('prune_stale_configs') <
      flow.indexOf('systemctl start combo-dev-web-forward.service'),
  );
  assert.match(deploy.slice(0, deploy.indexOf('host_preflight() {')), /fence_all_writers_cleanup/);
});

test('Test, Preview, and Production serialize only deploy jobs and preserve promotion trust', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const ci = text('.github/workflows/ci.yml');
  const prCi = text('.github/workflows/pr-ci.yml');
  const testDeploy = text('scripts/combo-dev-deploy.sh');
  const preview = text('.github/workflows/preview.yml');
  const production = text('.github/workflows/cd.yml');
  const deployGroup = (value) =>
    value.match(
      /^ {4}concurrency:\n {6}group: ([^\n]+)\n {6}queue: ([^\n]+)\n {6}cancel-in-progress: ([^\n]+)$/m,
    );
  for (const delivery of [workflow, preview, production]) {
    const group = deployGroup(delivery);
    assert.ok(group);
    assert.equal(group[1], 'cd-tecent2');
    assert.equal(group[2], 'max');
    assert.equal(group[3], 'false');
    assert.doesNotMatch(delivery, /^concurrency:/m);
  }

  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  const triggers = workflow.slice(workflow.indexOf('on:\n'), workflow.indexOf('\npermissions:'));
  const productionTriggers = production.slice(
    production.indexOf('on:\n'),
    production.indexOf('\npermissions:'),
  );
  assert.match(triggers, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(triggers, /workflow_run|push:|pull_request:/);
  assert.match(productionTriggers, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(productionTriggers, /workflow_run|push:|pull_request:/);
  assert.match(preview, /^ {2}workflow_run:/m);
  assert.match(preview, /workflows: \[Main CD\]/);
  assert.match(preview, /branches: \[main\]/);
  assert.match(preview, /COMBO_PREVIEW_AUTO_PROMOTION_MODE/);
  assert.match(ci, /^name: Main CD$/m);
  assert.match(ci, /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.doesNotMatch(ci.slice(0, ci.indexOf('\npermissions:')), /pull_request:/);
  assert.match(ci, /group: main-cd-\$\{\{ inputs\.revision \|\| 'main' \}\}/);
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'push' \}\}/);
  assert.doesNotMatch(ci, /github\.event_name == 'workflow_call'/);
  assert.match(prCi, /^name: PR CI$/m);
  assert.match(prCi, /^ {2}pull_request:$/m);
  assert.match(prCi, /^ {4}name: CI \/ quality$/m);
  assert.doesNotMatch(prCi, /\bdocker\b|packages: write|environment:|secrets\./);
  assert.match(prCi, /run: pnpm test:fast/);
  assert.doesNotMatch(prCi, /^ {8}run: pnpm test$/m);
  assert.match(
    workflow,
    /pull_request_number:[\s\S]*required: true[\s\S]*revision:[\s\S]*required: true/,
  );
  assert.match(workflow, /INPUT_PULL_REQUEST_NUMBER: \$\{\{ inputs\.pull_request_number \}\}/);
  assert.match(workflow, /INPUT_REVISION: \$\{\{ inputs\.revision \}\}/);
  assert.match(
    workflow,
    /for candidate in "\$ACTOR" "\$TRIGGERING_ACTOR"; do[\s\S]*collaborators\/\$\{candidate\}\/permission[\s\S]*admin:\*\|write:\*\|\*:maintain/,
  );
  assert.match(workflow, /git check-ref-format "refs\/heads\/\$source_branch"/);
  assert.match(workflow, /\[\[ "\$INPUT_REVISION" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(workflow, /repos\/\$\{GITHUB_REPOSITORY\}\/pulls\/\$\{INPUT_PULL_REQUEST_NUMBER\}/);
  assert.match(workflow, /\.state == "open"/);
  assert.match(workflow, /\.base\.ref == "main"/);
  assert.match(workflow, /\.base\.sha == \$controller/);
  assert.match(workflow, /\.head\.repo\.full_name == \$repository/);
  assert.match(workflow, /\.head\.sha == \$revision/);
  assert.match(workflow, /\.merge_base_commit\.sha == \$controller/);
  assert.match(
    workflow,
    /git\/ref\/heads\/\$\{encoded_branch\}[\s\S]*\[\[ "\$branch_sha" == "\$INPUT_REVISION" \]\]/,
  );
  assert.match(
    workflow,
    /git\/commits\/\$\{INPUT_REVISION\}"[\s\\\n]*--jq '\.sha' \| grep -Fx "\$INPUT_REVISION"/,
  );
  assert.match(production, /REVISION: \$\{\{ inputs\.revision \}\}/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(production, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(production, /compare\/\$\{REVISION\}\.\.\.main/);
  const productionCleanup = production.slice(
    production.indexOf('      - name: Remove transient SSH and bundle files'),
  );
  for (const remotePath of [
    'data/combo-release-incoming/${REVISION}.journal-audit.${RUN_ID}.${RUN_ATTEMPT}.mjs',
    '.${REVISION}.journal-audit.${RUN_ID}.${RUN_ATTEMPT}.upload',
  ]) {
    assert.ok(
      productionCleanup.includes(remotePath),
      `Production always-cleanup must remove ${remotePath}`,
    );
  }
  assert.match(
    workflow,
    /build_branch_release:[\s\S]*needs: select[\s\S]*packages: write[\s\S]*uses: \.\/\.github\/workflows\/ci\.yml[\s\S]*revision: \$\{\{ needs\.select\.outputs\.revision \}\}[\s\S]*publish_release: true/,
  );
  assert.doesNotMatch(
    workflow.slice(
      workflow.indexOf('\n  build_branch_release:'),
      workflow.indexOf('\n  authorize:'),
    ),
    /secrets:\s*inherit/,
  );
  assert.match(ci, /^ {2}workflow_call:/m);
  assert.match(
    ci,
    /workflow_call:[\s\S]*revision:[\s\S]*required: true[\s\S]*publish_release:[\s\S]*required: true/,
  );
  assert.match(workflow, /\[\[ "\$WORKFLOW_REF" == refs\/heads\/main \]\]/);
  assert.match(workflow, /\[\[ "\$remote_main" == "\$CONTROLLER_SHA" \]\]/);
  assert.match(
    workflow,
    /Check out the trusted main Test controller[\s\S]*ref: \$\{\{ needs\.authorize\.outputs\.controller_sha \}\}/,
  );
  const privilegedDeploy = workflow.slice(workflow.indexOf('\n  deploy:'));
  assert.match(privilegedDeploy, /environment: combo-dev/);
  assert.doesNotMatch(
    privilegedDeploy,
    /ref: \$\{\{ needs\.(?:select|authorize)\.outputs\.revision \}\}/,
  );
  assert.doesNotMatch(privilegedDeploy, /\$RELEASE_ROOT\/(?:scripts|acceptance|infra)\//);
  assert.match(privilegedDeploy, /bash scripts\/combo-dev-deploy\.sh --render-only/);
  assert.match(privilegedDeploy, /runner=scripts\/goal-b-test-acceptance\.mjs/);
  assert.match(privilegedDeploy, /resend_reader=scripts\/resend-sent-email\.mjs/);
  assert.match(privilegedDeploy, /validator=scripts\/promotion-evidence\.mjs/);

  assert.match(workflow, /repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{SOURCE_CI_RUN_ID\}/);
  assert.match(workflow, /\.path == "\.github\/workflows\/combo-dev\.yml"/);
  assert.match(workflow, /\.event == "workflow_dispatch"/);
  assert.match(workflow, /\.head_branch == "main"/);
  assert.match(workflow, /\.head_sha == \$controller/);
  assert.match(workflow, /\.status == "in_progress"/);
  assert.match(workflow, /\.conclusion == null/);
  assert.match(workflow, /\.repository\.full_name == \$repository/);
  assert.match(workflow, /\.head_repository\.full_name == \$repository/);
  assert.match(workflow, /\[\[ "\$SOURCE_CI_RUN_ID" == "\$GITHUB_RUN_ID" \]\]/);
  assert.match(workflow, /\[\[ "\$SOURCE_CI_RUN_ATTEMPT" == "\$GITHUB_RUN_ATTEMPT" \]\]/);
  assert.match(
    workflow,
    /--arg title "Test PR #\$\{PULL_REQUEST_NUMBER\} deployment request \$\{SOURCE_CI_RUN_ID\}"[\s\S]*\.name == \$title[\s\S]*\.display_title == \$title[\s\S]*\.event == "workflow_dispatch"/,
  );
  assert.doesNotMatch(workflow, /\.name == "Test deployment"/);
  assert.match(
    workflow,
    /artifact_release_job='build the exact branch Test artifact \/ assemble immutable release artifact'/,
  );
  assert.match(workflow, /image_job_prefix='build the exact branch Test artifact \/ '/);
  assert.match(
    workflow,
    /artifacts\?per_page=100&name=\$\{artifact_name\}/,
    'Test must resolve only the named release artifact from the selected producer run',
  );
  assert.match(workflow, /\.total_count == 1/);
  assert.match(workflow, /\$matches\[0\]\.expired == false/);
  assert.match(workflow, /\$matches\[0\]\.digest \| test\("\^sha256:/);
  assert.match(workflow, /\$matches\[0\]\.workflow_run\.id == \$runId/);
  assert.match(workflow, /\$matches\[0\]\.workflow_run\.head_sha == \$headSha/);
  assert.match(
    workflow,
    /actions\/runs\/\$\{SOURCE_CI_RUN_ID\}\/attempts\/\$\{SOURCE_CI_RUN_ATTEMPT\}\/jobs/,
  );
  assert.match(workflow, /\.name == \$releaseJob/);
  assert.match(workflow, /\$releaseJobs\[0\]\.started_at <= \$artifactCreatedAt/);
  assert.match(workflow, /\$artifactCreatedAt <= \$releaseJobs\[0\]\.completed_at/);
  assert.match(workflow, /for key in api runtime web; do/);
  assert.match(
    workflow,
    /image_artifact_name="combo-image-digest-\$\{REVISION\}-\$\{SOURCE_CI_RUN_ATTEMPT\}-\$\{key\}"/,
  );
  assert.match(workflow, /image_job="\$\{image_job_prefix\}image \/ \$\{key\}"/);
  assert.match(workflow, /\(\$imageJobs \| length\) == 1/);
  assert.match(workflow, /actions\/artifacts\/\$\{image_artifact_id\}\/zip/);
  assert.match(workflow, /sha256sum "\$image_archive"[\s\S]*==[\s\\\n]*"\$image_artifact_digest"/);
  assert.match(workflow, /\[\[ "\$\{image_archive_paths\[0\]\}" == "\$\{key\}\.image" \]\]/);
  for (const key of ['api', 'runtime', 'web']) {
    assert.ok(
      workflow.includes(`--arg ${key}Image "$(<"$digest_root/${key}.image")"`),
      `release manifest must bind the exact ${key} digest artifact`,
    );
  }
  assert.match(
    workflow,
    /\.images == \{[\s\S]*api: \$apiImage,[\s\S]*runtime: \$runtimeImage,[\s\S]*web: \$webImage/,
  );
  assert.match(
    workflow,
    /actions\/artifacts\/\$\{RELEASE_ARTIFACT_ID\}\/zip/,
    'Test must download the exact artifact ID selected from the producer run',
  );
  assert.match(
    workflow,
    /\[\[ "\$actual_artifact_digest" == "\$RELEASE_ARTIFACT_DIGEST" \]\]/,
    'Test must fail when the downloaded archive differs from its GitHub artifact digest',
  );
  assert.match(workflow, /needs: authorize/);
  assert.match(
    workflow,
    /deploy:[\s\S]*needs: authorize[\s\S]*if: always\(\) && needs\.authorize\.result == 'success'/,
    'Test deployment must run after an authorized source even when its optional branch-build ancestor was skipped',
  );
  assert.match(workflow, /environment: combo-dev/);
  assert.match(workflow, /sha256sum -c metadata\/artifact-files\.sha256/);
  assert.match(workflow, /cmp -s "\$expected" "\$actual"/);
  assert.match(workflow, /node scripts\/release-manifest\.mjs verify/);
  assert.match(workflow, /node scripts\/web-asset-manifest\.mjs verify/);
  assert.match(workflow, /file_set_digest/);
  assert.match(workflow, /release_artifact_digest/);
  assert.match(workflow, /source-release\.json/);
  assert.match(workflow, /sourceCiRunAttempt/);
  assert.match(workflow, /releaseArtifactId/);
  assert.match(workflow, /releaseArtifactName/);
  assert.match(workflow, /releaseArtifactDigest/);
  assert.match(workflow, /artifactFileSetDigest/);
  assert.match(workflow, /webAssetManifestDigest/);
  assert.doesNotMatch(workflow, /COMBO_PREVIEW_AUTO_PROMOTION_MODE|PREVIEW_MODE/);
  assert.doesNotMatch(workflow, /verify_preview_policy_is_paused/);
  assert.doesNotMatch(workflow, /actions\/workflows\/preview\.yml\/runs/);
  assert.match(
    workflow,
    /evidence_artifact_name="combo-branch-test-evidence-\$\{REVISION\}-\$\{RUN_ATTEMPT\}"/,
  );
  assert.doesNotMatch(workflow, /main-ci|evidence_artifact_name="combo-test-evidence-/);
  assert.match(workflow, /sourceWorkflow: \$sourceWorkflow/);
  assert.match(workflow, /sourceEvent: \$sourceEvent/);
  assert.match(workflow, /sourceBranch: \$sourceBranch/);
  assert.match(workflow, /controllerSha: \$controllerSha/);
  assert.match(workflow, /sourceMode: \$sourceMode/);
  assert.match(workflow, /\[\[ "\$SOURCE_WORKFLOW" == \.github\/workflows\/combo-dev\.yml \]\]/);
  assert.match(workflow, /\[\[ "\$SOURCE_EVENT" == workflow_dispatch \]\]/);
  assert.match(workflow, /\[\[ "\$SOURCE_MODE" == branch-build \]\]/);
  assert.doesNotMatch(preview, /combo-dev\.yml|combo-test-evidence|automatic Test/);
  assert.doesNotMatch(
    workflow,
    /actions\/variables\/COMBO_PREVIEW_AUTO_PROMOTION_MODE/,
    'The workflow token cannot read the repository Variables REST endpoint',
  );
  assert.doesNotMatch(
    preview,
    /actions\/variables\/COMBO_PREVIEW_AUTO_PROMOTION_MODE/,
    'Preview must use the policy output and protected job-admission vars context',
  );
  assert.match(
    workflow,
    /main advanced while the pull request Test waited for its deployment gate/,
  );
  assert.match(
    workflow,
    /git\/ref\/heads\/main"[\s\\\n]*--jq '\.object\.sha'\)" == "\$CONTROLLER_SHA"/,
  );
  const deploymentCompleted = workflow.indexOf("printf 'deployment_completed=true");
  const uploadStep = workflow.indexOf('Upload the fixed bundle');
  const finalControllerCheck = workflow.lastIndexOf('git/ref/heads/main', deploymentCompleted);
  const destructiveReset = workflow.indexOf(
    'sudo -n /opt/combo-dev/bin/combo-dev-reset',
    uploadStep,
  );
  assert.ok(finalControllerCheck > uploadStep);
  assert.ok(finalControllerCheck < destructiveReset);
  assert.ok(workflow.indexOf('sudo -n /opt/combo-dev/bin/combo-dev-deploy') < deploymentCompleted);
  assert.doesNotMatch(workflow, /mutation_started/);
  assert.match(workflow, /\.run_attempt == \$runAttempt/);
  assert.match(workflow, /\.digest == \$digest/);
  assert.match(
    ci,
    /^ {2}release:\n[\s\S]*?^ {4}if: >-\n\s+\(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\) \|\|\n\s+inputs\.publish_release == true/m,
  );
  assert.match(
    ci,
    /push: >-\n\s+\$\{\{ \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\) \|\|\n\s+inputs\.publish_release == true \}\}/,
  );
  const webContract = ci.slice(
    ci.indexOf('      - name: Verify the hardened Web runtime metadata path'),
    ci.indexOf('      - name: Record the immutable image reference'),
  );
  assert.match(webContract, /IMAGE_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(webContract, /case "\$PUBLISH_RELEASE" in/);
  assert.match(webContract, /\[\[ "\$IMAGE_DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/);
  assert.match(webContract, /IMAGE_REF="\$IMAGE_REPOSITORY@\$IMAGE_DIGEST"/);
  assert.match(webContract, /docker pull "\$IMAGE_REF"/);
  assert.match(
    webContract,
    /false\)[\s\S]*IMAGE_REF="\$IMAGE_TAG"[\s\S]*docker image inspect "\$IMAGE_REF"/,
  );
  assert.match(webContract, /"\$IMAGE_REF" >\/dev\/null/);
  assert.doesNotMatch(webContract, /docker pull "\$IMAGE_TAG"/);
  assert.match(
    webContract,
    /infra\/k8s\/release\/overlays\/preview\/apps\/review-nginx\.conf,dst=\/etc\/nginx\/templates\/default\.conf\.template,readonly/,
  );
  const previewContractStart = webContract.indexOf(
    'container="combo-web-preview-contract-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
  );
  assert.ok(previewContractStart >= 0, 'Preview Web runtime contract must be present');
  const previewContract = webContract.slice(previewContractStart);
  assert.match(
    previewContract,
    /cp infra\/k8s\/release\/overlays\/preview\/apps\/review-entry-redirect\.html[\s\\\n]*"\$review_pages\/entry-redirect\.html"/,
  );
  assert.match(
    previewContract,
    /src=\$review_pages,dst=\/usr\/share\/nginx\/html\/__review,readonly/,
  );
  assert.match(previewContract, /--read-only/);
  assert.match(previewContract, /--user 101:101/);
  assert.match(previewContract, /--cap-drop ALL/);
  for (const path of ['/etc/nginx/conf.d', '/var/cache/nginx', '/var/run', '/tmp']) {
    assert.match(previewContract, new RegExp(`--tmpfs ${path.replaceAll('/', '\\/')}:`));
  }
  assert.doesNotMatch(
    previewContract,
    /preview_token|--env REVIEW_ACCESS_TOKEN|Cookie: combo_review_access/,
  );
  assert.match(
    previewContract,
    /GET \/capabilities HTTP\/1\.1[\s\S]*preview-app-page\.http[\s\S]*HTTP\/1\.1 200 OK/,
  );
  assert.match(
    previewContract,
    /GET \/version\.json HTTP\/1\.1[\s\S]*preview-version\.http[\s\S]*HTTP\/1\.1 200 OK/,
  );
  assert.match(
    previewContract,
    /GET \/__review\/enter\?returnTo=%2Fcapabilities[\s\S]*正在进入邮箱验证/,
  );
  assert.match(previewContract, /docker exec "\$container" nginx -t/);
  assert.match(previewContract, /docker exec "\$container" sh -c 'command -v nc >\/dev\/null'/);
  assert.match(previewContract, /timeout 10 docker exec -i "\$container" nc 127\.0\.0\.1 80/);
  assert.match(previewContract, /\^X-Combo-Review-Gate:/);
  assert.match(previewContract, /\^Set-Cookie:\.\*combo_review_access/);
  assert.match(previewContract, /http:\/\/127\.0\.0\.1\/try\//);
  assert.match(previewContract, /try\/sessions\/combo-runtime-route-contract/);
  assert.match(previewContract, /runtime_asset=.*sed -n/s);
  assert.match(previewContract, /http:\/\/127\.0\.0\.1\/try\/assets\/combo-missing-deadbeef\.js/);
  assert.match(workflow, /combo-release-mutation\.lock/);
  assert.match(workflow, /flock -n 9/);
  assert.doesNotMatch(workflow, /flock -w [0-9]+ 9/);
  assert.match(
    workflow,
    /revalidate_test_authority[\s\S]*mv -fT -- "\$temporary" "\$remote"[\s\S]*revalidate_test_authority[\s\S]*flock -n 9[\s\S]*combo-dev-reset[\s\S]*combo-dev-deploy[\s\S]*printf 'deployment_completed=true/,
  );
  assert.match(
    workflow,
    /"\$RELEASE_ROOT\/metadata\/release\.json"[\s\\\n]*"\$RELEASE_ROOT\/metadata\/release-manifest-digest\.txt"[\s\\\n]*"\$root\/metadata\/"/,
  );
  assert.match(testDeploy, /'metadata\/release\.json', 'metadata\/release-manifest-digest\.txt'/);
  assert.match(
    testDeploy,
    /validate_release_manifest[\s\\\n]*"\$manifest" "\$digest_file" "\$revision" "\$api_image" "\$runtime_image" "\$web_image"/,
  );
  assert.match(testDeploy, /combo-release-meta-\$\{revision:0:12\}/);
  assert.match(
    workflow,
    /combo-dev-reset[\s\\\n]*--confirm=DESTROY-COMBO-PREVIEW-DATA[\s\S]*combo-dev-deploy/,
  );
  assert.match(preview, /combo-preview-promotion-\$\{\{/);
  assert.match(preview, /\.name == "Main CD"/);
  assert.match(preview, /\.path == "\.github\/workflows\/ci\.yml"/);
  assert.match(preview, /\.event == "push"/);
  assert.match(preview, /\.head_branch == "main"/);
  assert.doesNotMatch(preview, /combo-test-evidence|testEvidence|testRunId/);
  assert.match(production, /environment: production/);
  assert.match(production, /combo-preview-promotion-\$\{REVISION\}-\$\{PREVIEW_RUN_ATTEMPT\}/);
  assert.match(production, /artifactFileSetDigest/);
  const productionPreviewEvidence = production.slice(
    production.indexOf('      - name: Validate Preview evidence and its source main CI run'),
    production.indexOf(
      '      - name:',
      production.indexOf('      - name: Validate Preview evidence and its source main CI run') + 1,
    ),
  );
  assert.match(productionPreviewEvidence, /keys == \(\[[\s\S]*?\] \| sort\)/);
  for (const requiredKey of [
    '"remoteCleanupEvidenceDigest"',
    '"status"',
    '"sourceArtifactId"',
    '"browserAcceptanceDigest"',
  ]) {
    assert.ok(
      productionPreviewEvidence.includes(requiredKey),
      `Production Preview evidence schema must include ${requiredKey}`,
    );
  }
  assert.match(productionPreviewEvidence, /and \.schemaVersion == 5/);
  assert.doesNotMatch(productionPreviewEvidence, /testRun|testEvidence|testIdentity|testBrowser/);
  assert.match(workflow, /echo ' {2}ServerAliveInterval 30'/);
  assert.match(workflow, /echo ' {2}ServerAliveCountMax 20'/);
  assert.match(workflow, /echo ' {2}TCPKeepAlive yes'/);
  assert.match(preview, /\[\[ "\$SOURCE_BRANCH" == main \]\]/);
  assert.match(production, /\.path == "\.github\/workflows\/preview\.yml"/);
  const credentialCheck = preview.slice(
    preview.indexOf('      - name: Check the existing Preview registry credential'),
    preview.indexOf('      - name: Upload and deploy the exact Preview bundle'),
  );
  assert.match(credentialCheck, /imagePullSecrets: \[\{name: "combo-preview-ghcr-pull"\}\]/);
  assert.match(credentialCheck, /Configure a long-lived read:packages credential/);
  assert.doesNotMatch(credentialCheck, /GHCR_(?:TOKEN|USER)|docker-registry|create secret/);
  assert.doesNotMatch(preview, /steps\.pull_credential\.outputs\.refresh|GITHUB_OUTPUT.*refresh/);
  assert.doesNotMatch(workflow, /issue\s*#?112/i);
});

test('Preview and Production preserve exact sanitized browser failure evidence', () => {
  const preview = text('.github/workflows/preview.yml');
  const production = text('.github/workflows/cd.yml');

  const previewRun = preview.indexOf('Run the exact-bundle six-area Preview browser acceptance');
  const previewUpload = preview.indexOf(
    'Upload sanitized Preview browser failure evidence',
    previewRun,
  );
  const previewFail = preview.indexOf(
    'Fail Preview after preserving browser failure evidence',
    previewUpload,
  );
  const previewAdmission = preview.indexOf(
    'Prove the current Preview checkpoint and complete resource inventory',
    previewFail,
  );
  assert.ok(
    previewRun > 0 &&
      previewUpload > previewRun &&
      previewFail > previewUpload &&
      previewAdmission > previewFail,
  );
  const previewBrowser = preview.slice(previewRun, previewUpload);
  assert.match(previewBrowser, /id: browser_admission/);
  assert.match(previewBrowser, /runner_rc=\$\?/);
  assert.match(previewBrowser, /validate-live-browser-failure[\s\\\n]*--environment preview/);
  assert.match(
    previewBrowser,
    /combo-preview-failure-evidence-\$\{REVISION\}-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}/,
  );
  const previewFailure = preview.slice(previewUpload, previewAdmission);
  assert.match(
    previewFailure,
    /always\(\) && steps\.browser_admission\.outputs\.acceptance_status == 'failed'/,
  );
  assert.match(
    previewFailure,
    /combo-preview-failure-evidence-\$\{\{ needs\.policy\.outputs\.revision \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.doesNotMatch(previewFailure, /preview-promotion\.json|ACCEPTANCE_RESEND_API_KEY/);

  const productionRun = production.indexOf(
    'Run the exact-bundle Production email OTP and six-area browser acceptance',
  );
  const productionUpload = production.indexOf(
    'Upload sanitized Production browser failure evidence',
    productionRun,
  );
  const productionFail = production.indexOf(
    'Fail Production after preserving browser failure evidence',
    productionUpload,
  );
  const productionAttestation = production.indexOf(
    'Generate and validate the workflow-owned Production acceptance attestation',
    productionFail,
  );
  assert.ok(
    productionRun > 0 &&
      productionUpload > productionRun &&
      productionFail > productionUpload &&
      productionAttestation > productionFail,
  );
  const productionBrowser = production.slice(productionRun, productionUpload);
  assert.match(productionBrowser, /id: production_browser/);
  assert.match(productionBrowser, /runner_rc=\$\?/);
  assert.match(productionBrowser, /validate-live-browser-failure[\s\\\n]*--environment production/);
  assert.match(
    productionBrowser,
    /combo-production-failure-evidence-\$\{REVISION\}-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}/,
  );
  const productionFailure = production.slice(productionUpload, productionAttestation);
  assert.match(
    productionFailure,
    /always\(\) && steps\.production_browser\.outputs\.acceptance_status == 'failed'/,
  );
  assert.match(
    productionFailure,
    /combo-production-failure-evidence-\$\{\{ needs\.resolve\.outputs\.revision \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.doesNotMatch(productionFailure, /production-deployment\.json|ACCEPTANCE_RESEND_API_KEY/);
});

test('every retained cluster-scoped object is compared against one canonical bootstrap contract', () => {
  const safety = join(repo, 'scripts/combo-dev-production-safety.py');
  const work = mkdtempSync(join(tmpdir(), 'combo-dev-platform-contract-'));
  const pv = (name, claim, size, path) => ({
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name, labels: { 'combo.dev/environment': 'combo-dev' } },
    spec: {
      capacity: { storage: size },
      volumeMode: 'Filesystem',
      accessModes: ['ReadWriteOnce'],
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 'combo-dev-bounded',
      claimRef: { namespace: 'combo-preview', name: claim },
      local: { path },
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                { key: 'kubernetes.io/hostname', operator: 'In', values: ['node-one'] },
              ],
            },
          ],
        },
      },
    },
  });
  const objects = [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'combo-preview',
        labels: {
          'combo.dev/environment': 'combo-dev',
          'pod-security.kubernetes.io/enforce': 'restricted',
        },
      },
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: 'combo-dev-control-auditor' },
      rules: [{ apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'list'] }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'combo-dev-control-auditor' },
      subjects: [
        { kind: 'User', apiGroup: 'rbac.authorization.k8s.io', name: 'combo-dev-dispatcher' },
      ],
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: 'combo-dev-control-auditor',
      },
    },
    {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'combo-dev-bounded' },
      provisioner: 'kubernetes.io/no-provisioner',
      reclaimPolicy: 'Retain',
      volumeBindingMode: 'WaitForFirstConsumer',
      allowVolumeExpansion: false,
    },
    pv('combo-dev-postgres', 'data-postgres-0', '8Gi', '/home/xingzheng/data/combo-dev/postgres'),
    pv(
      'combo-dev-redis-queue',
      'data-redis-queue-0',
      '2Gi',
      '/home/xingzheng/data/combo-dev/redis-queue',
    ),
    pv('combo-dev-minio', 'data-minio-0', '6Gi', '/home/xingzheng/data/combo-dev/minio'),
  ];
  try {
    const input = join(work, 'desired.json');
    const expected = join(work, 'expected.json');
    const live = join(work, 'live.json');
    writeFileSync(input, JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }));
    execFileSync(
      'python3',
      [safety, 'canonicalize-platform', '--input', input, '--output', expected],
      { stdio: 'ignore' },
    );
    const compare = (items) => {
      writeFileSync(live, JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));
      return spawnSync(
        'python3',
        [safety, 'compare-platform', '--expected', expected, '--live', live],
        { stdio: 'ignore' },
      ).status;
    };
    const serverDecorated = clone(objects);
    serverDecorated[0].metadata.labels['kubernetes.io/metadata.name'] = 'combo-preview';
    serverDecorated[0].spec = { finalizers: ['kubernetes'] };
    for (const item of serverDecorated.slice(4)) {
      item.metadata.finalizers = ['kubernetes.io/pv-protection'];
      item.spec.claimRef.uid = 'server-generated';
      item.status = { phase: 'Bound' };
    }
    assert.equal(compare(serverDecorated), 0);

    const mutations = [
      [0, (item) => (item.metadata.labels['pod-security.kubernetes.io/enforce'] = 'baseline')],
      [1, (item) => item.rules[0].verbs.push('watch')],
      [2, (item) => (item.subjects[0].name = 'other-user')],
      [
        3,
        (item) =>
          (item.metadata.annotations = { 'storageclass.kubernetes.io/is-default-class': 'true' }),
      ],
      [4, (item) => (item.spec.local.path = '/tmp/postgres')],
      [5, (item) => (item.spec.capacity.storage = '3Gi')],
      [
        6,
        (item) =>
          (item.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values = [
            'other-node',
          ]),
      ],
    ];
    for (const [index, mutate] of mutations) {
      const drifted = clone(serverDecorated);
      mutate(drifted[index]);
      assert.notEqual(
        compare(drifted),
        0,
        `${drifted[index].kind}/${drifted[index].metadata.name}`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  assert.match(bootstrap, /create --dry-run=client --validate=strict/);
  assert.match(bootstrap, /canonicalize-platform/);
  for (const scriptPath of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-smoke.sh',
  ]) {
    assert.match(text(scriptPath), /compare-platform/);
  }
  assert.equal(
    existsSync(join(repo, 'infra/k8s/overlays/combo-dev/platform/storage-provisioner.yaml')),
    false,
  );
  assert.doesNotMatch(
    text('scripts/combo-dev-bootstrap.sh'),
    /combo-dev-local-path|combo\.dev\/local-path/,
  );
});

test('MinIO initialization removes stale application identities and performs a negative post-removal check', () => {
  const init = text('infra/k8s/overlays/combo-dev/init/resources.yaml');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  assert.match(bootstrap, /re\.fullmatch\(r'\[A-Za-z0-9\]/);
  assert.match(init, /mc admin user list local --json/);
  assert.match(init, /mc admin user remove local "\$identity" >\/dev\/null 2>&1/);
  assert.match(init, /if mc admin user info local "\$identity" >\/dev\/null 2>&1; then/);
  assert.match(init, /mc ls revoked\/combo-raw >\/dev\/null 2>&1/);
  assert.match(init, /inventory_users\(\) \{/);
  assert.match(init, /\[ "\$inventory_records" -eq 1 \]/);
  assert.doesNotMatch(init, /^\s+(?:grep|sed|awk|jq)\b/m);
  assert.doesNotMatch(init, /echo .*\$identity/);
});

test('OpenSSH effective configuration retains exactly the two approved local forwards', () => {
  const connect = text('scripts/combo-dev-connect.sh');
  assert.match(connect, /ClearAllForwardings=no/);
  assert.doesNotMatch(connect, /-o ClearAllForwardings=yes/);
  assert.match(connect, /ssh -G "\$\{SSH_ARGS\[@\]\}"/);
  assert.match(connect, /localforward\|remoteforward\|dynamicforward/);
  const args = [
    '-G',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ClearAllForwardings=no',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-L',
    '127.0.0.1:18080:127.0.0.1:18080',
    '-L',
    '127.0.0.1:19000:127.0.0.1:19000',
    'localhost',
  ];
  const result = spawnSync('ssh', args, { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const forwards = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('localforward '))
    .map((line) => line.slice('localforward '.length));
  assert.deepEqual(forwards, [
    '[127.0.0.1]:18080 [127.0.0.1]:18080',
    '[127.0.0.1]:19000 [127.0.0.1]:19000',
  ]);

  const work = mkdtempSync(join(tmpdir(), 'combo-dev-ssh-config-'));
  try {
    mkdirSync(join(work, '.ssh'), { recursive: true });
    writeFileSync(
      join(work, '.ssh/config'),
      'Host combo-dev-extra\n  HostName localhost\n  LocalForward 127.0.0.1:19999 127.0.0.1:19999\n',
    );
    chmodSync(join(work, '.ssh/config'), 0o600);
    const withExtra = spawnSync(
      'ssh',
      ['-G', '-F', join(work, '.ssh/config'), ...args.slice(1, -1), 'combo-dev-extra'],
      { encoding: 'utf8' },
    );
    assert.equal(withExtra.status, 0);
    assert.equal(
      withExtra.stdout
        .split('\n')
        .filter((line) => /^(localforward|remoteforward|dynamicforward) /.test(line)).length,
      3,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Test capacity preparation is bounded, authenticated, and precedes every destructive reset', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const reset = text('scripts/combo-dev-reset.sh');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const policy = text('infra/host/combo-dev/combo-host-syslog');
  const policyDigest = createHash('sha256').update(policy).digest('hex');

  assert.match(
    policy,
    /^\/var\/log\/messages \/var\/log\/secure \/var\/log\/cron \/var\/log\/maillog \/var\/log\/spooler \{$/m,
  );
  assert.match(policy, /^ {4}size 256M$/m);
  assert.match(policy, /^ {4}rotate 7$/m);
  assert.doesNotMatch(policy, /^ {4}maxage /m);
  assert.match(policy, /^ {4}compress$/m);
  assert.match(policy, /^ {4}create 0600 root root$/m);
  assert.doesNotMatch(policy, /^ {4}delaycompress$/m);
  assert.match(policy, /^ {8}\/bin\/systemctl kill -s HUP rsyslog\.service >\/dev\/null 2>&1$/m);
  assert.match(reset, new RegExp(`HOST_SYSLOG_POLICY_SHA256='${policyDigest}'`));
  assert.match(reset, /HOST_SYSLOG_POLICY='\/etc\/logrotate\.d\/combo-host-syslog'/);
  assert.match(reset, /stat -c '%u:%g:%a' \/etc\/logrotate\.d[\s\S]*'0:0:755'/);
  assert.match(reset, /stat -c '%u:%g:%a' "\$HOST_SYSLOG_POLICY"[\s\S]*'0:0:644'/);

  const prepareStep = workflow.indexOf(
    'Revalidate the pull request and prepare bounded Test host capacity',
  );
  const uploadStep = workflow.indexOf(
    'Upload the fixed bundle and invoke the root-owned dispatcher',
  );
  const deploymentCompleted = workflow.indexOf("printf 'deployment_completed=true");
  const destructiveReset = workflow.indexOf('--confirm=DESTROY-COMBO-PREVIEW-DATA');
  const deployCall = workflow.indexOf('sudo -n /opt/combo-dev/bin/combo-dev-deploy');
  const capacityCall = workflow.indexOf('--prepare-capacity', prepareStep);
  assert.ok(
    prepareStep > 0 &&
      capacityCall > prepareStep &&
      uploadStep > capacityCall &&
      destructiveReset > uploadStep &&
      deployCall > destructiveReset &&
      deploymentCompleted > deployCall,
  );
  assert.match(
    workflow.slice(prepareStep, uploadStep),
    /archive_bytes=\$\(stat -c '%s' "\$ARCHIVE"\)[\s\S]*archive_bytes <= 512 \* 1024 \* 1024[\s\S]*combo-dev-reset[\s\\\n]*--prepare-capacity[\s\\\n]*--incoming-bytes "\$archive_bytes"/,
  );
  assert.doesNotMatch(workflow.slice(prepareStep, uploadStep), /deployment_completed|scp|rm -rf/);
  assert.doesNotMatch(workflow, /mutation_started/);

  const cleanup = reset.slice(
    reset.indexOf('plan_stale_test_cleanup() {'),
    reset.indexOf('prepare_capacity() {'),
  );
  assert.match(reset, /readonly RELEASES_DIR='\/opt\/combo-dev\/releases'/);
  assert.match(reset, /readonly INCOMING_DIR='\/opt\/combo-dev\/incoming'/);
  assert.match(reset, /--prepare-capacity\) prepare=\$\(\(prepare \+ 1\)\)/);
  assert.match(reset, /容量准备参数只能出现一次/);
  assert.match(
    reset,
    /required=\$\(\(CONTROL_STATE_MIN_FREE_BYTES \+ 2 \* incoming_bytes \+ CONTROL_WORK_MARGIN_BYTES\)\)/,
  );
  assert.match(
    deploy,
    /required=\$\(\(CONTROL_STATE_MIN_FREE_BYTES \+ required_extra \+ CONTROL_WORK_MARGIN_BYTES\)\)/,
  );
  assert.match(reset, /MUTATING=0/);
  assert.match(cleanup, /safe_release_tree/);
  assert.match(cleanup, /value\.st_dev != expected_device/);
  assert.match(cleanup, /assert_release_tree_unmounted/);
  assert.match(reset, /findmnt -rn -o TARGET/);
  assert.match(
    cleanup,
    /assert_release_tree_unmounted[\s\S]*plan_stale_test_cleanup[\s\S]*for path in "\$\{stale_releases\[@\]\}"[\s\S]*assert_release_tree_unmounted[\s\S]*rm -rf --one-file-system/,
  );
  assert.match(cleanup, /len\(keep\) >= 3/);
  assert.match(cleanup, /2 \* 24 \* 60 \* 60/);
  assert.match(cleanup, /\.acceptance/);
  assert.match(cleanup, /rm -rf --one-file-system -- "\$path"/);
  assert.match(cleanup, /rm -f -- "\$path"/);
  assert.doesNotMatch(
    cleanup,
    /docker|containerd|crictl|ctr |image prune|volume prune|\/var\/lib\/(?:docker|containerd)|\/home\/xingzheng\/data\/combo-dev/,
  );

  const prepareBody = reset.slice(
    reset.indexOf('prepare_capacity() {'),
    reset.indexOf('verify_k3s_mount_dependencies() {'),
  );
  const policyDebug = prepareBody.indexOf('logrotate --debug');
  const tmpfilesStart = prepareBody.indexOf('systemctl start systemd-tmpfiles-clean.service');
  const testCleanup = prepareBody.indexOf('clean_stale_test_artifacts');
  const policyRun = prepareBody.indexOf('timeout 900 logrotate');
  assert.ok(policyDebug > 0 && tmpfilesStart > policyDebug && testCleanup > tmpfilesStart);
  assert.ok(policyRun > testCleanup);
  assert.match(prepareBody, /systemctl is-active rsyslog\.service/);
  assert.match(prepareBody, /systemctl is-active systemd-tmpfiles-clean\.timer/g);
  assert.match(prepareBody, /timeout 600 systemctl start systemd-tmpfiles-clean\.service/);
  assert.match(prepareBody, /WORK=\$\(mktemp -d "\$CONTROL_WORK\/capacity\.XXXXXX"\)/);
  assert.match(prepareBody, /timeout 900 logrotate "\$HOST_SYSLOG_POLICY"/);
  assert.match(
    prepareBody,
    /capacity bytes root_before=\$root_before root_after=\$root_after data_before=\$data_before data_after=\$data_after/,
  );
  assert.match(prepareBody, /assert_capacity_ready/);
  assert.doesNotMatch(prepareBody, /rm[^\n]*\/tmp|find[^\n]*\/tmp/);
  assert.doesNotMatch(prepareBody, /MUTATING=1|wipe_static_volume_data|fence_all_writers/);

  const mainBody = reset.slice(reset.lastIndexOf('\nmain() {'));
  const capacityRecheck = mainBody.lastIndexOf('assert_capacity_ready');
  assert.ok(capacityRecheck > mainBody.indexOf('flock -w 300 9'));
  assert.ok(
    capacityRecheck < mainBody.lastIndexOf('WORK=$(mktemp -d "$CONTROL_WORK/reset.XXXXXX")'),
  );
  assert.ok(capacityRecheck < mainBody.indexOf('begin_reset_mutation_fence'));
  const resetAdmission = reset.slice(
    reset.indexOf('begin_reset_mutation_fence() {'),
    reset.indexOf('finish_reset_safe_idle_fence() {'),
  );
  assert.ok(resetAdmission.indexOf('MUTATING=1') < resetAdmission.indexOf('mark_failure_fence'));

  for (const control of [bootstrap, deploy])
    assert.match(control, /infra\/host\/combo-dev\/combo-host-syslog/);
  assert.match(
    bootstrap,
    /install -o root -g root -m 0644 "\$ROOT\/infra\/host\/combo-dev\/combo-host-syslog" \/etc\/logrotate\.d\/combo-host-syslog/,
  );
  assert.match(deploy, /'infra\/host\/combo-dev\/combo-host-syslog'/);
  assert.match(
    workflow,
    /infra\/host\/combo-dev\/combo-host-syslog "\$root\/infra\/host\/combo-dev\/"/,
  );
});

test('Test capacity admission separates deployment data headroom from root OS health', () => {
  const gib = 1024 ** 3;
  const healthy = runStorageCapacityFixture({
    rootFree: Math.floor(44.79 * gib),
    dataFree: 100 * gib,
  });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(
    healthy.stdout,
    'rootWarning=0 rootCritical=0 dataWarning=0 dataCritical=0 control=ok\n',
  );

  const rootWarning = runStorageCapacityFixture({ rootFree: 25 * gib, dataFree: 100 * gib });
  assert.equal(rootWarning.status, 0, rootWarning.stderr);
  assert.match(rootWarning.stdout, /rootWarning=1 rootCritical=0/);

  const rootCritical = runStorageCapacityFixture({ rootFree: 17 * gib, dataFree: 100 * gib });
  assert.equal(rootCritical.status, 0, rootCritical.stderr);
  assert.match(rootCritical.stdout, /rootWarning=1 rootCritical=1/);

  const dataCritical = runStorageCapacityFixture({ rootFree: 50 * gib, dataFree: 20 * gib });
  assert.equal(dataCritical.status, 0, dataCritical.stderr);
  assert.match(dataCritical.stdout, /dataWarning=1 dataCritical=1/);

  for (const state of [
    { stateFree: gib - 1, stateInodes: 10_000 },
    { stateFree: 2 * gib, stateInodes: 4095 },
  ]) {
    const result = runStorageCapacityFixture({
      rootFree: 50 * gib,
      dataFree: 100 * gib,
      ...state,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /control=low/);
  }

  const guard = text('scripts/combo-dev-storage-guard.sh');
  assert.match(
    guard,
    /if \(\( ROOT_CAPACITY_WARNING == 1 \)\); then status 'WARN root-os-headroom'; fi/,
  );
  assert.match(
    guard,
    /if \(\( ROOT_CAPACITY_CRITICAL == 1 \)\); then[\s\S]*check_only == 1[\s\S]*fence_now '根盘低于 OS critical 字节或 inode 水位'/,
  );
  assert.match(
    guard,
    /if \(\( DATA_CAPACITY_CRITICAL == 1 \)\); then[\s\S]*check_only == 1[\s\S]*fence_now '父数据盘低于 critical 字节或 inode 水位' 1/,
  );
  assert.match(
    guard,
    /if ! control_headroom_ok; then[\s\S]*check_only == 1[\s\S]*fence_now 'control-state 低于字节或 inode 安全水位' 1/,
  );
  assert.match(
    guard,
    /if \(\( root_recovery_rc == 1 \)\); then\s+fence_now '根盘 OS 健康标记仍在 15 分钟恢复观察期' 0 0 preserve-attempt\s+return/,
  );

  for (const path of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-storage-guard.sh',
  ]) {
    const source = text(path);
    assert.doesNotMatch(source, /(?:45|40) \* 1024 \* 1024 \* 1024/);
    assert.doesNotMatch(source, /(?:不足|低于) ?(?:45|40) GiB/);
    assert.match(source, /CONTROL_STATE_IMAGE='\/var\/lib\/combo-host-data\/control-state\.img'/);
    assert.match(source, /blockdev --getsize64/);
    assert.match(source, /blkid -s LABEL -o value/);
    assert.match(source, /findmnt -rn -T "\$CONTROL_STATE_IMAGE" -o TARGET/);
  }
});

test('deployment admission retains bounded extraction, smoke, and nested log headroom at the exact edge', () => {
  const mib = 1024 ** 2;
  const gib = 1024 ** 3;
  const archive = 512 * mib;
  const admissionMargin = 640 * mib;
  const maximumExtractedBundle = 20 * mib;
  const smokeOverhead = 64 * mib;
  const nestedLogBudget = 512 * mib;
  const admittedFree = gib + 2 * archive + admissionMargin;

  // Upload and the trusted copy coexist before incoming is removed. After
  // extraction, smoke can allocate its bounded overhead and still invoke the
  // nested log audit without crossing the 1 GiB retained floor.
  const atMaximumCopyPeak = admittedFree - 2 * archive;
  const afterIncomingRemoval = atMaximumCopyPeak + archive;
  const nestedLogHeadroom =
    afterIncomingRemoval - maximumExtractedBundle - smokeOverhead - archive - gib;
  assert.equal(atMaximumCopyPeak, gib + admissionMargin);
  assert.ok(nestedLogHeadroom >= nestedLogBudget);

  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  const logs = text('scripts/combo-dev-logs.sh');
  assert.match(deploy, /CONTROL_WORK_MARGIN_BYTES=\$\(\(640 \* 1024 \* 1024\)\)/);
  assert.match(reset, /CONTROL_WORK_MARGIN_BYTES=\$\(\(640 \* 1024 \* 1024\)\)/);
  assert.match(smoke, /CONTROL_OPERATION_MIN_FREE_BYTES=\$\(\(1600 \* 1024 \* 1024\)\)/);
  assert.match(logs, /CONTROL_OPERATION_MIN_FREE_BYTES=\$\(\(1536 \* 1024 \* 1024\)\)/);
});

test('host-data canonical anchor pins a UUID-authenticated data-disk inode below root-owned ancestry', () => {
  const prepare = text('infra/host/combo-dev/combo-host-prepare-data-anchor.sh');
  const checker = text('infra/host/combo-dev/combo-host-data-mount-check.sh');
  const service = text('infra/host/combo-dev/combo-host-data-mount-check.service');
  const mount = text('infra/host/combo-dev/var-lib-combo\\x2dhost\\x2ddata.mount');
  const stateMount = text('infra/host/combo-dev/opt-combo\\x2ddev-state.mount');

  assert.match(prepare, /--confirm=PREPARE-COMBO-HOST-DATA-ANCHOR/);
  assert.match(prepare, /data-mount\.identity/);
  assert.match(prepare, /trusted_asset_ancestry/);
  assert.match(prepare, /\$\(stat -c '%u' "\$path"\) == 0/);
  assert.match(prepare, /8#\$mode & 8#022/);
  assert.match(prepare, /"\$SELF_ASSET" "\$CHECKER_ASSET"/);
  assert.match(prepare, /findmnt -rn -M "\$DATA_MOUNT" -o UUID/);
  assert.match(prepare, /before_identity=\$\(stat -c '%d:%i' "\$SOURCE_ROOT"\)/);
  assert.match(prepare, /"\$before_identity" == "\$after_identity"/);
  assert.doesNotMatch(prepare, /rm -rf|find[^\n]+-delete|docker|kubectl|helm/);

  assert.match(mount, /^What=\/home\/xingzheng\/data\/combo-host$/m);
  assert.match(mount, /^Where=\/var\/lib\/combo-host-data$/m);
  assert.match(service, /^DefaultDependencies=no$/m);
  assert.match(service, /^Requires=var-lib-combo\\x2dhost\\x2ddata\.mount$/m);
  assert.match(service, /^Before=local-fs\.target opt-combo\\x2ddev-state\.mount$/m);
  assert.match(service, /^Conflicts=umount\.target$/m);
  assert.doesNotMatch(service, /^PrivateTmp=/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ProtectHome=read-only$/m);
  assert.doesNotMatch(service, /^ReadWritePaths=/m);
  assert.match(checker, /\(\(\$# == 0\)\) \|\| fail '参数不合法。'/);
  assert.match(checker, /findmnt --task 1/);
  const findmntCalls = [...checker.matchAll(/\$\(findmnt ([^\n]+)/g)].map((match) => match[1]);
  assert.ok(findmntCalls.length >= 8);
  assert.ok(findmntCalls.every((call) => call.startsWith('--task 1 ')));
  assert.match(checker, /VFS-OPTIONS/);
  assert.match(checker, /FS-OPTIONS/);
  assert.match(checker, /actual_uuid.*expected_uuid/);
  assert.match(checker, /fsroot.*'\/combo-host'/s);
  assert.match(checker, /source_identity.*anchor_identity/s);
  assert.match(checker, /父数据盘回退到了根盘/);
  assert.match(checker, /combo-host-data-root=v1/);
  assert.doesNotMatch(checker, /allow-sandbox-read-only-parent/);
  assert.match(checker, /canonical anchor VFS 不是 rw/);
  assert.match(checker, /canonical anchor 文件系统不是 rw/);
  assert.match(stateMount, /^Requires=combo-host-data-mount-check\.service$/m);
  assert.match(stateMount, /^After=combo-host-data-mount-check\.service$/m);
  assert.match(stateMount, /^What=\/var\/lib\/combo-host-data\/control-state\.img$/m);
});

test('control-state preparation pre-arms rollback across command and signal boundaries', () => {
  const source = text('infra/host/combo-dev/combo-dev-prepare-control-state.sh');
  const cleanupStart = source.indexOf('cleanup() {');
  const cleanupEnd = source.indexOf('\n}\n\nrequire_command()', cleanupStart);
  const cleanup = source.slice(cleanupStart, cleanupEnd + 2);
  const main = source.slice(source.indexOf('\nmain() {'));
  assert.ok(cleanupStart > 0 && cleanupEnd > cleanupStart);
  assert.ok(main.indexOf('trap cleanup EXIT') < main.indexOf('chmod 0000 "$INCOMING_ROOT"'));
  assert.ok(main.indexOf("trap 'exit 130' INT TERM") < main.indexOf('chmod 0000 "$INCOMING_ROOT"'));
  assert.ok(main.indexOf('INCOMING_FROZEN=1') < main.indexOf('chmod 0000 "$INCOMING_ROOT"'));
  assert.ok(
    main.indexOf('MOUNTED_BY_SCRIPT=1') <
      main.indexOf('mount -o loop,rw,nodev,nosuid,noexec -- "$BACKING_FILE" "$STATE_ROOT"'),
  );
  for (const [flag, command] of [
    ['INCOMING_MOVED=1', 'mv -T -- "$INCOMING_ROOT" "$backup/incoming"'],
    ['RELEASES_MOVED=1', 'mv -T -- "$RELEASES_ROOT" "$backup/releases"'],
    ['EVIDENCE_MOVED=1', 'mv -T -- "$EVIDENCE_ROOT" "$backup/evidence"'],
  ]) {
    assert.ok(main.indexOf(flag) < main.indexOf(command));
  }
  assert.match(cleanup, /findmnt -rn --mountpoint "\$STATE_ROOT"[\s\S]*! umount "\$STATE_ROOT"/);
  assert.match(
    cleanup,
    /if \[\[ -d "\$backup"[\s\S]*elif \[\[ ! -e "\$backup"[\s\S]*-d "\$target"/,
  );
  const copyLoop = main.indexOf('for path in incoming releases evidence; do');
  const destinationMode = main.indexOf('chmod 1733 "$STATE_ROOT/incoming"', copyLoop);
  const finalIncomingManifest = main.indexOf(
    'tree_manifest "$INCOMING_ROOT" "$work/incoming.final.json"',
  );
  assert.ok(copyLoop > 0 && copyLoop < destinationMode && destinationMode < finalIncomingManifest);

  const root = mkdtempSync(join(tmpdir(), 'combo-dev-freeze-rollback-'));
  const incoming = join(root, 'incoming');
  mkdirSync(incoming);
  chmodSync(incoming, 0o000);
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set +e
MOUNTED_BY_SCRIPT=0
CUTOVER_BACKUP=''
CUTOVER_COMPLETE=0
INCOMING_MOVED=0
RELEASES_MOVED=0
EVIDENCE_MOVED=0
INCOMING_FROZEN=1
ROLLBACK_MANIFEST_DIR=''
STATE_ROOT=${JSON.stringify(join(root, 'state'))}
INCOMING_ROOT=${JSON.stringify(incoming)}
RELEASES_ROOT=${JSON.stringify(join(root, 'releases'))}
EVIDENCE_ROOT=${JSON.stringify(join(root, 'evidence'))}
STATE_UNIT=state.mount
INCOMING_UNIT=incoming.mount
RELEASES_UNIT=releases.mount
EVIDENCE_UNIT=evidence.mount
${cleanup}
false
cleanup`,
    ],
    { encoding: 'utf8' },
  );
  try {
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.equal(statSync(incoming).mode & 0o7777, 0o1733);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  for (const moveCommitted of [false, true]) {
    const moveRoot = mkdtempSync(join(tmpdir(), 'combo-dev-move-rollback-'));
    const target = join(moveRoot, 'incoming');
    const backupRoot = join(moveRoot, 'backup');
    const backup = join(backupRoot, 'incoming');
    const manifests = join(moveRoot, 'manifests');
    mkdirSync(join(backupRoot, '.manifests'), { recursive: true });
    mkdirSync(manifests);
    mkdirSync(moveCommitted ? backup : target);
    writeFileSync(join(moveCommitted ? backup : target, 'marker'), 'preserved\n');
    writeFileSync(join(manifests, 'incoming.json'), 'stable\n');
    const moveResult = spawnSync(
      'bash',
      [
        '-c',
        `set +e
systemctl() {
  case "$1" in
    is-active) printf 'inactive\\n' ;;
    is-enabled) printf 'disabled\\n' ;;
    *) return 0 ;;
  esac
}
findmnt() { return 1; }
tree_manifest() { printf 'stable\\n' >"$2"; }
MOUNTED_BY_SCRIPT=0
CUTOVER_BACKUP=${JSON.stringify(backupRoot)}
CUTOVER_COMPLETE=0
INCOMING_MOVED=1
RELEASES_MOVED=0
EVIDENCE_MOVED=0
INCOMING_FROZEN=0
ROLLBACK_MANIFEST_DIR=${JSON.stringify(manifests)}
STATE_ROOT=${JSON.stringify(join(moveRoot, 'state'))}
INCOMING_ROOT=${JSON.stringify(target)}
RELEASES_ROOT=${JSON.stringify(join(moveRoot, 'releases'))}
EVIDENCE_ROOT=${JSON.stringify(join(moveRoot, 'evidence'))}
STATE_UNIT=state.mount
INCOMING_UNIT=incoming.mount
RELEASES_UNIT=releases.mount
EVIDENCE_UNIT=evidence.mount
${cleanup}
false
cleanup`,
      ],
      { encoding: 'utf8' },
    );
    try {
      assert.equal(moveResult.status, 1, `${moveResult.stdout}${moveResult.stderr}`);
      assert.equal(readFileSync(join(target, 'marker'), 'utf8'), 'preserved\n');
      assert.equal(existsSync(backupRoot), false);
    } finally {
      rmSync(moveRoot, { recursive: true, force: true });
    }
  }
});

test('control-state identity rejects root fallback, missing identity, links, permissions, and size drift', () => {
  const valid = runControlStateIdentityFixture('valid');
  assert.equal(valid.status, 0, `${valid.stdout}${valid.stderr}`);
  for (const mode of [
    'wrong-mount',
    'missing-sentinel',
    'state-symlink',
    'bad-permissions',
    'wrong-size',
    'wrong-label',
    'same-device-bind',
  ]) {
    const result = runControlStateIdentityFixture(mode);
    assert.notEqual(result.status, 0, `${mode} unexpectedly passed`);
  }
});

test('Test releases commit inside canonical staging and pruning never crosses protected state', () => {
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const main = deploy.slice(deploy.lastIndexOf('\nmain() {'));
  const prune = deploy.slice(
    deploy.indexOf('prune_releases() {'),
    deploy.indexOf('render_only() {'),
  );
  const resetCleanup = reset.slice(
    reset.indexOf('plan_stale_test_cleanup() {'),
    reset.indexOf('prepare_capacity() {'),
  );

  assert.match(
    main,
    /candidate_extract=\$\(mktemp -d[\s\\\n]*"\$CONTROL_STAGING\/\$\{revision\}\.\$\{workflow_run_id\}\.\$\{workflow_run_attempt\}\.XXXXXXXX"\)/,
  );
  assert.match(main, /local canonical_release="\$CONTROL_RELEASES\/\$revision"/);
  assert.match(main, /mv -T "\$candidate_extract" "\$canonical_release"/);
  assert.doesNotMatch(main, /mv -T "\$candidate_extract" "\$candidate_release"/);
  assert.ok(
    main.indexOf('validate_bundle "$trusted_bundle" "$candidate_extract"') <
      main.indexOf('mv -T "$candidate_extract" "$canonical_release"'),
  );
  assert.doesNotMatch(main, /candidate_extract="\$WORK\/candidate"/);
  const retainBeforeSwitch = main.lastIndexOf('RELEASE_CREATED=0');
  const prepareCurrent = main.lastIndexOf('ln -sfn "$RELEASE_DIR" "$INSTALL_ROOT/current.next"');
  const commitCurrent = main.lastIndexOf(
    'mv -Tf "$INSTALL_ROOT/current.next" "$INSTALL_ROOT/current"',
  );
  assert.ok(
    retainBeforeSwitch > 0 && retainBeforeSwitch < prepareCurrent && prepareCurrent < commitCurrent,
  );

  assert.match(prune, /sha = re\.compile\(r'\^\[0-9a-f\]\{40\}\$'\)/);
  assert.match(prune, /if name == '\.staging':\n\s+continue/);
  assert.match(prune, /\^\/opt\/combo-dev\/releases\/\[0-9a-f\]\{40\}\$/);
  assert.match(prune, /rm -rf --one-file-system -- "\$path"/);
  assert.doesNotMatch(
    prune,
    /CONTROL_STAGING|CONTROL_WORK|CONTROL_EVIDENCE|state\/work|state\/evidence/,
  );
  assert.doesNotMatch(prune, /rm[^\n]*(?:\.staging|\/work|\/evidence)/);

  assert.match(resetCleanup, /if name == '\.staging':\n\s+continue/);
  assert.match(resetCleanup, /\^\/opt\/combo-dev\/releases\/\[0-9a-f\]\{40\}\$/);
  assert.doesNotMatch(resetCleanup, /rm[^\n]*(?:\.staging|\/work|\/evidence)/);
});

test('control-state source-root verification succeeds when no nested mounts exist', () => {
  const source = text('infra/host/combo-dev/combo-dev-prepare-control-state.sh');
  const functionStart = source.indexOf('verify_source_roots() {');
  const functionEnd = source.indexOf('\n}\n\nassert_no_open_incoming()', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const verifySourceRoots = source.slice(functionStart, functionEnd + 2);
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -Eeuo pipefail
INCOMING_ROOT=/opt/combo-dev/incoming
RELEASES_ROOT=/opt/combo-dev/releases
EVIDENCE_ROOT=/var/lib/combo-dev/evidence
fail() { printf '%s\\n' "$1" >&2; exit 1; }
stat() {
  case "\${*: -1}" in
    "$INCOMING_ROOT") printf '0:0:1733:directory\\n' ;;
    "$RELEASES_ROOT"|"$EVIDENCE_ROOT") printf '0:0:755:directory\\n' ;;
    *) return 1 ;;
  esac
}
findmnt() {
  if [[ "$*" == '-rn -o TARGET' ]]; then
    printf '/\\n/home/xingzheng/data\\n'
    return 0
  fi
  return 1
}
${verifySourceRoots}
verify_source_roots
printf 'verified\\n'
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'verified\n');
});

test('control-state capacity reads GNU df inode totals through the supported itotal field', () => {
  const prepare = text('infra/host/combo-dev/combo-dev-prepare-control-state.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');

  assert.doesNotMatch(prepare, /df --output=inodes/);
  assert.doesNotMatch(guard, /df --output=inodes/);
  assert.equal(prepare.match(/df --output=itotal/g)?.length, 1);
  assert.equal(guard.match(/df --output=itotal/g)?.length, 2);

  if (process.platform !== 'linux') return;
  const probe = spawnSync('df', ['--output=itotal', '/'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, `${probe.stdout}${probe.stderr}`);
  assert.match(probe.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? '', /^\d+$/);
});

test('control-state uses one ext4-compatible filesystem label across every host control', () => {
  const prepare = text('infra/host/combo-dev/combo-dev-prepare-control-state.sh');
  const controls = [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-storage-guard.sh',
  ].map((path) => text(path));
  const expectedLabel = 'combo-dev-state';

  assert.match(expectedLabel, /^[\x20-\x7e]+$/);
  assert.ok(expectedLabel.length <= 16);
  assert.match(prepare, /readonly FILESYSTEM_LABEL='combo-dev-state'/);
  assert.match(prepare, /mkfs\.ext4[^\n]+-L "\$FILESYSTEM_LABEL"/);
  assert.equal(prepare.match(/blkid -s LABEL -o value[^\n]+"\$FILESYSTEM_LABEL"/g)?.length, 2);
  assert.doesNotMatch(prepare, /-L combo-dev-control-state/);
  for (const source of controls) {
    assert.match(source, /readonly CONTROL_STATE_LABEL='combo-dev-state'/);
    assert.doesNotMatch(source, /readonly CONTROL_STATE_LABEL='combo-dev-control-state'/);
  }
});

test('control-state migration stays owner-gated and excludes unrelated host-runtime work', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const workflow = text('.github/workflows/combo-dev.yml');
  const prepareState = text('infra/host/combo-dev/combo-dev-prepare-control-state.sh');

  for (const path of [
    'combo-dev-prepare-control-state.sh',
    'combo-host-prepare-data-anchor.sh',
    'combo-host-data-mount-check.sh',
    'combo-host-data-mount-check.service',
    'var-lib-combo\\x2dhost\\x2ddata.mount',
    'opt-combo\\x2ddev-state.mount',
    'opt-combo\\x2ddev-incoming.mount',
    'opt-combo\\x2ddev-releases.mount',
    'var-lib-combo\\x2ddev-evidence.mount',
  ]) {
    assert.match(workflow, new RegExp(regexEscape(`infra/host/combo-dev/${path}`)));
    assert.match(deploy, new RegExp(regexEscape(`infra/host/combo-dev/${path}`)));
  }

  assert.match(prepareState, /readonly OPERATION_LOCK='\/run\/lock\/combo-dev\.lock'/);
  assert.match(prepareState, /readonly FENCE_LOCK='\/run\/lock\/combo-dev-fence\.lock'/);
  assert.match(prepareState, /--confirm=PREPARE-COMBO-DEV-CONTROL-STATE/);
  assert.match(prepareState, /consume_verified_maintenance_fence/);
  assert.match(prepareState, /combo-dev-storage-maintenance=fenced-v1/);
  assert.match(prepareState, /readonly CONTROL_PARENT='\/var\/lib\/combo-host-data'/);
  assert.match(prepareState, /assert_parent_capacity "\$BACKING_BYTES" 1/);
  assert.match(
    prepareState,
    /critical=\$\(max_threshold "\$total" "\$DATA_CRITICAL_MIN_BYTES" 10\)/,
  );
  assert.match(
    prepareState,
    /state_free >= STATE_MIN_FREE_BYTES && state_inodes >= STATE_MIN_FREE_INODES/,
  );
  assert.match(prepareState, /tree_manifest[\s\S]*cmp -s[\s\S]*CUTOVER_BACKUP/);
  assert.doesNotMatch(prepareState, /rm[^\n]*(?:root-backup-control-state|BACKING_FILE)/);

  for (const source of [bootstrap, deploy, workflow]) {
    assert.doesNotMatch(
      source,
      /runtime-storage|standalone-containerd|combo-host-happy|prepare-happy|host-logs\/happy/,
    );
  }
});

test('control digest authenticates every consumed kustomization and resource file', () => {
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const bootstrapControls = bootstrap.match(/readonly CONTROL_FILES=\((?<body>[\s\S]*?)\n\)/)
    ?.groups?.body;
  const deployControls = deploy.match(/readonly CONTROL_FILES=\((?<body>[\s\S]*?)\n\)/)?.groups
    ?.body;
  assert.ok(bootstrapControls);
  assert.equal(deployControls, bootstrapControls);
  for (const required of [
    'infra/k8s/overlays/combo-dev/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/platform/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/platform/network-policies.yaml',
    'infra/k8s/overlays/combo-dev/platform/rbac.yaml',
    'infra/k8s/overlays/combo-dev/platform/storage-class.yaml',
    'infra/k8s/overlays/combo-dev/platform/storage-volumes.yaml',
    'infra/k8s/overlays/combo-dev/foundation/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh',
    'infra/k8s/overlays/combo-dev/foundation/resources.yaml',
    'infra/k8s/overlays/combo-dev/init/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/init/resources.yaml',
    'infra/k8s/overlays/combo-dev/migrate/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/migrate/resources.yaml',
    'infra/k8s/overlays/combo-dev/apps/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/apps/resources.yaml',
    'infra/host/combo-dev/combo-dev-prepare-control-state.sh',
    'infra/host/combo-dev/combo-host-prepare-data-anchor.sh',
    'infra/host/combo-dev/combo-host-data-mount-check.sh',
    'infra/host/combo-dev/combo-host-data-mount-check.service',
    'infra/host/combo-dev/var-lib-combo\\x2dhost\\x2ddata.mount',
    'infra/host/combo-dev/opt-combo\\x2ddev-state.mount',
    'infra/host/combo-dev/opt-combo\\x2ddev-incoming.mount',
    'infra/host/combo-dev/opt-combo\\x2ddev-releases.mount',
    'infra/host/combo-dev/var-lib-combo\\x2ddev-evidence.mount',
    'infra/host/combo-dev/combo-host-syslog',
  ]) {
    assert.ok(bootstrapControls.includes(required));
  }
  assert.match(bootstrap, /\/opt\/combo-dev\/bootstrap-overlay/);
  assert.match(deploy, /"\$INSTALL_ROOT\/bootstrap-overlay\/apps\/resources\.yaml"/);
});

test('existing deployment invariants remain fail-closed', () => {
  const workflow = text('.github/workflows/combo-dev.yml');
  const deploy = text('scripts/combo-dev-deploy.sh');
  const reset = text('scripts/combo-dev-reset.sh');
  const bootstrap = text('scripts/combo-dev-bootstrap.sh');
  const guard = text('scripts/combo-dev-storage-guard.sh');
  const smoke = text('scripts/combo-dev-smoke.sh');
  const rbac = text('infra/k8s/overlays/combo-dev/platform/rbac.yaml');
  const testMinioInit = text('infra/k8s/overlays/combo-dev/init/resources.yaml');
  const releaseMinioInit = text('infra/k8s/job-minio-init.yaml');
  assert.match(
    rbac,
    /resources: \['jobs'\]\n {4}verbs: \['create', 'get', 'list', 'watch', 'patch', 'delete'\]/,
  );
  assert.match(deploy, /name: combo-dev-job-rbac-preflight/);
  assert.match(
    deploy,
    /apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher -f "\$job_probe"/,
  );
  assert.match(
    deploy,
    /\[\[ "\$stage" == foundation \]\][\s\S]*apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher --force-conflicts -f "\$render\/\$stage\.yaml"/,
  );
  assert.match(workflow, /scp -q "\$ARCHIVE" "combo-dev-target:\$temporary"/);
  assert.match(workflow, /ssh combo-dev-target mv -fT -- "\$temporary" "\$remote"/);
  assert.match(deploy, /INCOMING_BUNDLE=\$bundle/);
  assert.doesNotMatch(deploy, /head -c 65537|evidence_bytes/);
  assert.doesNotMatch(deploy, /ulimit -f/);
  assert.match(deploy, /\[\[ -z "\$INCOMING_BUNDLE" \]\] \|\| rm -f -- "\$INCOMING_BUNDLE"/);
  assert.match(reset, /wipe_static_volume_data/);
  assert.doesNotMatch(reset, /delete "persistentvolumeclaim\/\$name"/);
  assert.match(
    reset,
    /apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher --force-conflicts -k "\$FOUNDATION"/,
  );
  assert.doesNotMatch(reset, /combo-dev-session|DEV_SESSION_SECRET/);
  for (const manifest of [testMinioInit, releaseMinioInit]) {
    assert.match(manifest, /name: minio-init/);
    assert.match(manifest, /limits:[\s\S]*?memory: 256Mi/);
  }
  assert.match(
    rbac,
    /resourceNames: \['combo-dev-postgres', 'combo-dev-redis-queue', 'combo-dev-minio'\]/,
  );
  for (const script of [deploy, reset]) {
    assert.match(
      script,
      /apply --server-side --field-manager=combo-dev-replicas --force-conflicts -f -/,
    );
  }
  assert.match(
    smoke,
    /ownership=\$\("\$\{K\[@\]\}" -n "\$NAMESPACE" get "deployment\/\$name" --show-managed-fields=true -o json/,
  );
  assert.match(
    smoke,
    /curl_json\(\) \{[\s\S]*for \(\(attempt = 1; attempt <= 60; attempt\+\+\)\)[\s\S]*mv -fT "\$candidate" "\$output"[\s\S]*恢复窗口内不可读：\$path/,
  );
  assert.match(
    smoke,
    /tr -d '\\015' <"\$headers" \| grep -Fxci "access-control-allow-origin: \$PUBLIC_WEB_ORIGIN"/,
  );
  assert.doesNotMatch(smoke, /access-control-allow-origin:[^\n]*\\r/);
  for (const script of [bootstrap, deploy, reset]) {
    assert.match(script, /exec 9>"\$LOCK_FILE"\n\s+flock -w 300 9/);
  }
  assert.match(bootstrap, /scale "\$controller" --replicas=0/);
  assert.match(guard, /scale "\$kind\/\$name" --replicas=0/);
  assert.doesNotMatch(guard, /--field-manager=combo-dev-dispatcher/);
  for (const path of [
    'scripts/combo-dev-bootstrap.sh',
    'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-smoke.sh',
    'scripts/combo-dev-logs.sh',
    'scripts/combo-dev-storage-guard.sh',
    'scripts/combo-dev-forwarder-lease.sh',
  ]) {
    assert.match(
      text(path),
      /export PATH='\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin'/,
    );
  }
});
