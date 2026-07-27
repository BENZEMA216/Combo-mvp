#!/usr/bin/env bash
# 本地诚实边界：静态渲染可选 overlay，并用 Docker internal network 启动一个受限
# sandboxd 和一个临时协议驱动。不会 apply Kubernetes，也不验证 gVisor。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
SUFFIX="$$"
NETWORK="combo-sandbox-test-${SUFFIX}"
SANDBOX_CONTAINER="combo-sandboxd-test-${SUFFIX}"
DRIVER_CONTAINER="combo-sandbox-driver-${SUFFIX}"
IMAGE="combo-sandboxd:local-e2e-${SUFFIX}"
LOCAL_UID="$(id -u)"
LOCAL_GID="$(id -g)"
if [ "$LOCAL_UID" -eq 0 ]; then
  LOCAL_UID=10000
  LOCAL_GID=10000
fi
WORKSPACE_MOUNT="$TMP_DIR/workspace"
WORKSPACE_IMAGE="$TMP_DIR/workspace.ext4"
WORKSPACE_MODE='unbounded-test-directory'
LOOPBACK_MOUNTED=0

cleanup() {
  docker rm -f "$DRIVER_CONTAINER" "$SANDBOX_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker image rm -f "$IMAGE" >/dev/null 2>&1 || true
  if [ "$LOOPBACK_MOUNTED" -eq 1 ]; then
    sudo -n umount "$WORKSPACE_MOUNT" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

for required in docker node pnpm kubectl; do
  command -v "$required" >/dev/null 2>&1 || {
    echo "$required is required" >&2
    exit 1
  }
done

docker info >/dev/null
pnpm --dir "$ROOT_DIR" -F @cb/infra test

mkdir -p "$WORKSPACE_MOUNT"
if [ "$(uname -s)" = 'Linux' ] \
  && command -v fallocate >/dev/null 2>&1 \
  && command -v mkfs.ext4 >/dev/null 2>&1 \
  && command -v findmnt >/dev/null 2>&1 \
  && command -v blockdev >/dev/null 2>&1 \
  && command -v sudo >/dev/null 2>&1 \
  && sudo -n true >/dev/null 2>&1; then
  fallocate -l 1073741824 "$WORKSPACE_IMAGE"
  mkfs.ext4 -q -F -m 0 "$WORKSPACE_IMAGE"
  sudo -n mount -o loop,nodev,nosuid "$WORKSPACE_IMAGE" "$WORKSPACE_MOUNT"
  LOOPBACK_MOUNTED=1
  sudo -n rm -rf -- "$WORKSPACE_MOUNT/lost+found"
  sudo -n chown "$LOCAL_UID:$LOCAL_GID" "$WORKSPACE_MOUNT"
  sudo -n chmod 0700 "$WORKSPACE_MOUNT"
  workspace_device="$(findmnt -n -o SOURCE --target "$WORKSPACE_MOUNT")"
  [ "$(sudo -n blockdev --getsize64 "$workspace_device")" = '1073741824' ] || {
    echo 'loopback workspace is not exactly 1 GiB' >&2
    exit 1
  }
  WORKSPACE_MODE='one-GiB-loopback-ext4'
elif [ "${SANDBOX_E2E_REQUIRE_LOOPBACK:-0}" = '1' ]; then
  echo 'this run requires Linux loopback workspace support' >&2
  exit 1
else
  chmod 0700 "$WORKSPACE_MOUNT"
  echo 'warning: local protocol E2E is using an unbounded disk directory; the CI job requires loopback' >&2
fi

docker build -q -f "$ROOT_DIR/infra/Dockerfile.sandboxd" -t "$IMAGE" "$ROOT_DIR" >/dev/null
docker network create --internal "$NETWORK" >/dev/null

# Build the production Runtime client and Pi tool implementation. The driver later
# mounts only compiled output and read-only dependencies, never source, credentials
# from Runtime, a host workspace, or Kubernetes configuration.
pnpm --dir "$ROOT_DIR" -F @cb/shared build >/dev/null
pnpm --dir "$ROOT_DIR" -F @cb/runtime build >/dev/null

KEY_FILE="$TMP_DIR/keys.json"
TERMINATION_LOG="$TMP_DIR/termination.log"
: >"$TERMINATION_LOG"
chmod 666 "$TERMINATION_LOG"
node --input-type=module >"$KEY_FILE" <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
process.stdout.write(JSON.stringify({
  privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
}));
NODE
chmod 600 "$KEY_FILE"
PUBLIC_KEY="$(node -e "const fs=require('fs'); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).publicKey)" "$KEY_FILE")"

cat >"$TMP_DIR/driver.mjs" <<'NODE'
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SandboxClient } from '/repo/apps/runtime/dist/platform/infra/sandbox-client.js';
import { createSandboxCapabilitySigner } from '/repo/apps/runtime/dist/platform/infra/sandbox-capability.js';
import { createSandboxTools } from '/repo/apps/runtime/dist/modules/agent/sandbox-tools.js';

const keys = JSON.parse(await readFile('/test/keys.json', 'utf8'));
const signer = createSandboxCapabilitySigner(keys.privateKey);
const client = new SandboxClient({
  baseUrl: 'http://sandboxd:8080',
  sessionId: 'session-local-e2e',
  podUid: 'pod-local-e2e',
  signer,
  // Docker has no Kubernetes UID deletion API. Any callback here is a test
  // failure because authenticated cancel must confirm cleanup itself.
  onCancelFailure: async () => {
    throw new Error('sandboxd cancellation could not be confirmed');
  },
});

const turnContext = {
  sessionId: 'session-local-e2e',
  turnId: 'turn-local-e2e',
  ownerUserId: 'owner-local-e2e',
};
const httpBackend = {
  enabled: true,
  describe: (_context, signal) => client.describe(signal),
  read: (_context, input, signal) => client.read(input, signal),
  write: (_context, input, signal) => client.write(input, signal),
  edit: (_context, input, signal) => client.edit(input, signal),
  command: (_context, input, onFrame, signal) =>
    client.command({ commandId: randomUUID(), ...input }, onFrame, signal),
  interruptSession: async () => undefined,
  releaseSession: async () => undefined,
  dispose: async () => undefined,
};
const turnController = new AbortController();
const tools = Object.fromEntries(
  createSandboxTools({
    backend: httpBackend,
    ...turnContext,
    turnSignal: turnController.signal,
  }).map((tool) => [tool.name, tool]),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function expectCode(action, code) {
  try {
    await action();
  } catch (error) {
    if (error?.code === code) return;
    throw error;
  }
  throw new Error(`expected ${code}`);
}

async function command(commandText, timeoutMs) {
  const commandId = randomUUID();
  let output = '';
  const frames = [];
  const result = await client.command(
    { commandId, command: commandText, ...(timeoutMs ? { timeoutMs } : {}) },
    (frame) => {
      frames.push(frame);
      if (frame.type === 'output') output += frame.data;
    },
  );
  return { result, output, frames };
}

async function disconnectDetachedTransport() {
  const commandId = randomUUID();
  const requestId = randomUUID();
  const body = new TextEncoder().encode(
    JSON.stringify({
      commandId,
      command:
        "setsid /bin/bash --noprofile --norc -c 'sleep 30' >/dev/null 2>&1 & pid=$!; start=$(awk '{print $22}' /proc/$pid/stat); printf '%s:%s\\n' \"$pid\" \"$start\"; wait $pid",
      timeoutMs: 10_000,
    }),
  );
  const token = await signer.sign({
    sessionId: 'session-local-e2e',
    podUid: 'pod-local-e2e',
    operation: 'command',
    requestId,
    body,
  });
  const controller = new AbortController();
  const response = await fetch('http://sandboxd:8080/v1/commands', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
      'X-Sandbox-Session-Id': 'session-local-e2e',
      'X-Sandbox-Pod-Uid': 'pod-local-e2e',
    },
    body,
    signal: controller.signal,
  });
  assert(response.ok && response.body, 'raw disconnect command did not start');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let output = '';
  let identity = null;
  readLoop: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const frame = JSON.parse(line);
      if (frame.type === 'output' && frame.stream === 'stdout') {
        output += Buffer.from(frame.data, 'base64').toString();
        identity = output.match(/^(\d+):(\d+)\n/);
        if (identity) break readLoop;
      }
      newline = buffered.indexOf('\n');
    }
  }
  assert(identity, 'raw disconnect command did not stream detached PID identity');
  controller.abort();
  await reader.cancel().catch(() => undefined);
  return identity;
}

let healthy = false;
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const health = await fetch('http://sandboxd:8080/health');
    if (health.ok) {
      healthy = true;
      break;
    }
  } catch {}
  await delay(100);
}
assert(healthy, 'sandboxd health timeout');

const described = await client.describe();
assert(described.protocolVersion === '1', 'protocol mismatch');
assert(described.sessionId === 'session-local-e2e', 'session identity mismatch');
assert(described.podUid === 'pod-local-e2e', 'Pod identity mismatch');
assert(described.commandOutputEncoding === 'base64', 'command encoding mismatch');
assert(described.limits.maxOutputBytes === 1024 * 1024, 'output limit mismatch');
assert(described.limits.maxOutputFrames === 4096, 'output frame limit mismatch');

const writtenByTool = await tools.write.execute(
  'tool-write',
  { path: 'src/note.txt', content: 'alpha', createParents: true },
);
assert(writtenByTool.details.writtenBytes === 5, 'Pi write tool did not reach SandboxClient');
const readByTool = await tools.read.execute('tool-read', { path: 'src/note.txt' });
assert(readByTool.content[0]?.text === 'alpha', 'Pi read tool did not return sandboxd content');
const editedByTool = await tools.edit.execute('tool-edit', {
  path: 'src/note.txt',
  oldText: 'alpha',
  newText: 'beta',
});
assert(editedByTool.details.replacements === 1, 'Pi edit tool did not reach SandboxClient');
const edited = await client.read({ path: 'src/note.txt' });
assert(edited.content === 'beta', 'edit mismatch');
const bashByTool = await tools.bash.execute('tool-bash', { command: 'printf tool-ok' });
assert(
  bashByTool.content[0]?.text.includes('tool-ok') && bashByTool.details.exitCode === 0,
  'Pi bash tool did not reach SandboxClient',
);
await expectCode(() => client.read({ path: '../etc/passwd' }), 'invalid_path');

let firstOutputSeen;
const firstOutput = new Promise((resolve) => {
  firstOutputSeen = resolve;
});
const streamedFrames = [];
const streamedRun = client.command(
  {
    commandId: randomUUID(),
    command: "printf 'first\\n'; sleep 0.25; printf 'second\\n' >&2",
  },
  (frame) => {
    streamedFrames.push(frame);
    if (frame.type === 'output') firstOutputSeen();
  },
);
const outputArrivedBeforeExit = await Promise.race([
  firstOutput.then(() => true),
  delay(2_000).then(() => false),
]);
assert(outputArrivedBeforeExit, 'stream output did not arrive before command completion');
const streamedResult = await streamedRun;
assert(streamedResult.exitCode === 0, 'streamed command failed');
assert(streamedFrames[0]?.type === 'start', 'stream start frame missing');
assert(streamedFrames.at(-1)?.type === 'exit', 'stream exit frame missing');
assert(
  streamedFrames.some(
    (frame) => frame.type === 'output' && frame.stream === 'stdout' && frame.data === 'first\n',
  ),
  'streamed stdout missing',
);
assert(
  streamedFrames.some(
    (frame) => frame.type === 'output' && frame.stream === 'stderr' && frame.data === 'second\n',
  ),
  'streamed stderr missing',
);

const hardLimits = await command("printf '%s:%s' \"$(ulimit -Hn)\" \"$(ulimit -Hu)\"");
assert(hardLimits.output === '128:256', `raisable process limits: ${hardLimits.output}`);
if (process.env.SANDBOX_E2E_WORKSPACE_MODE === 'one-GiB-loopback-ext4') {
  const quota = await command(
    "set +e; fallocate -l 1100M quota-check.bin >/dev/null 2>&1; rc=$?; rm -f quota-check.bin; [ $rc -ne 0 ]",
    120_000,
  );
  assert(quota.result.exitCode === 0, 'workspace accepted more than its physical 1 GiB slot');
}

const linked = await command('ln -s /etc/passwd escape.txt');
assert(linked.result.exitCode === 0, 'symlink setup failed');
await expectCode(() => client.read({ path: 'escape.txt' }), 'invalid_path');

const timedOut = await command('sleep 30', 50);
assert(timedOut.result.timedOut, 'timeout terminal missing');
const outputLimited = await command('yes x');
assert(outputLimited.result.truncated, 'output-limit terminal missing');

async function assertDetachedGone(pid, start, label) {
  const checked = await command(
    `if [ -r /proc/${pid}/stat ] && [ "$(awk '{print $22}' /proc/${pid}/stat)" = "${start}" ]; then exit 99; fi`,
  );
  assert(checked.result.exitCode === 0, `${label} detached descendant survived cleanup`);
}

const cancelId = randomUUID();
let cancelOutput = '';
let cancelIdentityReady;
const cancelIdentity = new Promise((resolve) => {
  cancelIdentityReady = resolve;
});
const cancelledRun = client.command(
  {
    commandId: cancelId,
    command:
      "setsid /bin/bash --noprofile --norc -c 'sleep 30' >/dev/null 2>&1 & pid=$!; start=$(awk '{print $22}' /proc/$pid/stat); printf '%s:%s\\n' \"$pid\" \"$start\"; wait $pid",
    timeoutMs: 10_000,
  },
  (frame) => {
    if (frame.type !== 'output' || frame.stream !== 'stdout') return;
    cancelOutput += frame.data;
    const identity = cancelOutput.match(/^(\d+):(\d+)\n/);
    if (identity) cancelIdentityReady(identity);
  },
);
const cancelMatch = await cancelIdentity;
const cancelRequest = client.cancel(cancelId);
const cancelled = await cancelledRun;
assert(await cancelRequest, 'cancel endpoint did not find command');
assert(cancelled.cancelled, 'cancel terminal missing');
await assertDetachedGone(cancelMatch[1], cancelMatch[2], 'HTTP cancel');

const abortController = new AbortController();
let abortOutput = '';
let abortIdentityReady;
const abortIdentity = new Promise((resolve) => {
  abortIdentityReady = resolve;
});
const abortedRun = client.command(
  {
    commandId: randomUUID(),
    command:
      "setsid /bin/bash --noprofile --norc -c 'sleep 30' >/dev/null 2>&1 & pid=$!; start=$(awk '{print $22}' /proc/$pid/stat); printf '%s:%s\\n' \"$pid\" \"$start\"; wait $pid",
    timeoutMs: 10_000,
  },
  (frame) => {
    if (frame.type !== 'output' || frame.stream !== 'stdout') return;
    abortOutput += frame.data;
    const identity = abortOutput.match(/^(\d+):(\d+)\n/);
    if (identity) abortIdentityReady(identity);
  },
  abortController.signal,
);
const abortMatch = await abortIdentity;
abortController.abort();
await expectCode(() => abortedRun, 'aborted');
await assertDetachedGone(abortMatch[1], abortMatch[2], 'Abort');

const disconnectedMatch = await disconnectDetachedTransport();
// HTTP disconnect cleanup has a one-second TERM grace before the final KILL
// sweep. Wait for that bounded path before asking sandboxd to accept a new command.
await delay(2_000);
await assertDetachedGone(disconnectedMatch[1], disconnectedMatch[2], 'HTTP disconnect');

const logMarker = 'workspace-secret-exfiltration-marker';
const loopback = await command(
  `exec 3<>/dev/tcp/127.0.0.1/8080; printf 'POST /v1/files/read HTTP/1.1\\r\\nHost: localhost\\r\\nX-Request-Id: ${logMarker}\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n{}' >&3; cat <&3 || true`,
);
assert(
  loopback.output.includes('401 Unauthorized') && loopback.output.includes('"unauthorized"'),
  'loopback authentication probe did not receive the expected rejection',
);
assert(!loopback.output.includes(logMarker), 'unauthenticated request id was echoed');

const fdLogMarker = 'workspace-fd-log-exfiltration-marker';
const fdProbe = await command(
  `if (printf '${fdLogMarker}' > /proc/1/fd/1) 2>/dev/null; then exit 99; fi; printf blocked`,
);
assert(fdProbe.result.exitCode === 0, 'command opened the sandboxd log file descriptor');

const terminationMarker = 'workspace-termination-log-exfiltration-marker';
const terminationProbe = await command(
  `if (printf '${terminationMarker}' > /dev/termination-log) 2>/dev/null; then exit 99; fi; printf blocked`,
);
assert(
  terminationProbe.result.exitCode === 0,
  'command wrote the Kubernetes termination message channel',
);

console.log('Runtime Pi tools + SandboxClient authenticated read/write/edit/bash protocol: PASS');
NODE

docker run -d --name "$SANDBOX_CONTAINER" --network "$NETWORK" --network-alias sandboxd \
  --read-only --user "$LOCAL_UID:$LOCAL_GID" --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 256 --memory 384m --cpus 0.5 \
  --mount "type=bind,src=$WORKSPACE_MOUNT,dst=/workspace" \
  --mount "type=bind,src=$TERMINATION_LOG,dst=/dev/termination-log" \
  --tmpfs "/tmp:rw,size=268435456,mode=0700,uid=$LOCAL_UID,gid=$LOCAL_GID" \
  -e SANDBOX_SESSION_ID=session-local-e2e \
  -e SANDBOX_POD_UID=pod-local-e2e \
  -e SANDBOX_CAPABILITY_PUBLIC_KEY="$PUBLIC_KEY" \
  --entrypoint /bin/bash \
  "$IMAGE" -c "set -e; printf stale >/workspace/stale.txt; mkdir /workspace/stale-dir; printf stale >/workspace/stale-dir/nested.txt; chmod 000 /workspace; /usr/local/bin/wipe-workspace; test ! -e /workspace/stale.txt; test ! -e /workspace/stale-dir; exec /usr/local/bin/sandboxd" >/dev/null

docker run --name "$DRIVER_CONTAINER" --network "$NETWORK" --read-only \
  --user "$LOCAL_UID:$LOCAL_GID" \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 --memory 256m --cpus 0.5 \
  --tmpfs "/tmp:rw,size=16777216,mode=0700,uid=$LOCAL_UID,gid=$LOCAL_GID" \
  -e SANDBOX_E2E_WORKSPACE_MODE="$WORKSPACE_MODE" \
  --mount "type=bind,src=$TMP_DIR/driver.mjs,dst=/test/driver.mjs,readonly" \
  --mount "type=bind,src=$KEY_FILE,dst=/test/keys.json,readonly" \
  --mount "type=bind,src=$ROOT_DIR/apps/runtime/dist,dst=/repo/apps/runtime/dist,readonly" \
  --mount "type=bind,src=$ROOT_DIR/apps/runtime/node_modules,dst=/repo/apps/runtime/node_modules,readonly" \
  --mount "type=bind,src=$ROOT_DIR/node_modules,dst=/repo/node_modules,readonly" \
  node:24-slim node /test/driver.mjs

if docker logs "$SANDBOX_CONTAINER" 2>&1 | grep -Eq 'workspace-(secret|fd-log|termination-log)-exfiltration-marker'; then
  echo 'sandbox command leaked workspace data into sandboxd logs' >&2
  exit 1
fi
if [ -s "$TERMINATION_LOG" ]; then
  echo 'sandbox command wrote the simulated Kubernetes termination log' >&2
  exit 1
fi

echo 'sandbox overlay static render/assertions: PASS'
echo "sandboxd disk-workspace ($WORKSPACE_MODE) wipe/mutation/stream/timeout/cancel/disconnect E2E: PASS"
echo 'Kubernetes Pod allocation and Local PV scheduling: NOT LIVE-TESTED'
echo 'gVisor/runsc: NOT TESTED'
