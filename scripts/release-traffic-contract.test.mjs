import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  releaseIdForSource,
  releaseManifestDigest,
  serializeReleaseManifest,
} from './release-manifest.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SWITCH_TRAFFIC = join(import.meta.dirname, 'switch-release-traffic.sh');
const WEB_UNIT = 'combo-release-production-web-forward.service';
const MINIO_UNIT = 'combo-release-production-minio-forward.service';
const UNITS = [WEB_UNIT, MINIO_UNIT];
const NGINX_PATH = '/etc/nginx/conf.d/zz-agora-demo.conf';
const ENV_PATH = '/etc/combo-release/production-web-forward.env';
const NONPUBLIC_CONTEXT = 'fixture-not-for-output';

const NGINX_OLD = `server {
  server_name agora.43-160-242-46.sslip.io;
  location / { proxy_pass http://127.0.0.1:30080; }
  location /api/ { proxy_pass http://127.0.0.1:30080; }
  location /try/ { proxy_pass http://127.0.0.1:30080; }
}
server {
  server_name s3.43-160-242-46.sslip.io;
  location / { proxy_pass http://127.0.0.1:30900; }
}
`;

const NGINX_RELEASE = NGINX_OLD.replaceAll(
  'proxy_pass http://127.0.0.1:30080;',
  'proxy_pass http://127.0.0.1:18082;',
).replace('proxy_pass http://127.0.0.1:30900;', 'proxy_pass http://127.0.0.1:19002;');

test('Preview traffic proves the access gate without reading or sending its token', () => {
  const source = readFileSync(SWITCH_TRAFFIC, 'utf8');
  const gateStart = source.indexOf('preview_gate_ready() {');
  const gateEnd = source.indexOf('\n}\n', gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  const gate = source.slice(gateStart, gateEnd);
  assert.match(gate, /__review\/healthz/);
  assert.match(gate, /status_code.*401/s);
  assert.match(gate, /X-Combo-Review-Gate:\[\[:space:\]\]\*required/);
  assert.doesNotMatch(gate, /Cookie:|REVIEW_ACCESS_TOKEN|secret/i);
});

const FAKE_SUDO = String.raw`#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const fakeRoot = process.env.FAKE_HOST_ROOT;
const statePath = process.env.FAKE_HOST_STATE;
const logPath = process.env.FAKE_HOST_LOG;
const raw = process.argv.slice(2);
const args = raw[0] === '-n' ? raw.slice(1) : raw;
const command = args[0];
const rest = args.slice(1);
fs.appendFileSync(logPath, JSON.stringify(args) + '\n');

function mapped(value) {
  return value.startsWith('/etc/') ? path.join(fakeRoot, value) : value;
}

function load() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function save(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function install() {
  const directory = rest.includes('-d');
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '-d') continue;
    if (argument === '-o' || argument === '-g' || argument === '-m') {
      index += 1;
      continue;
    }
    positional.push(argument);
  }
  if (directory) {
    for (const target of positional) fs.mkdirSync(mapped(target), { recursive: true });
    return;
  }
  const source = mapped(positional.at(-2));
  const target = mapped(positional.at(-1));
  ensureParent(target);
  fs.copyFileSync(source, target);
}

function systemctl() {
  const action = rest[0];
  const unit = action === 'is-active' || action === 'is-enabled' ? rest.at(-1) : rest[1];
  const state = load();
  state.units[unit] ??= { active: false, enabled: false, pid: 0 };
  const record = state.units[unit];
  if (action === 'is-active') process.exit(record.active ? 0 : 3);
  if (action === 'is-enabled') process.exit(record.enabled ? 0 : 1);
  if (action === 'daemon-reload') return;
  if (action === 'stop') {
    record.active = false;
    record.pid = 0;
  } else if (action === 'enable') {
    record.enabled = true;
  } else if (action === 'disable') {
    record.enabled = false;
  } else if (action === 'restart') {
    record.active = true;
    state.nextPid += 1;
    record.pid = state.nextPid;
  } else if (action === 'reload' && unit === 'nginx') {
    if (state.failReloads > 0) {
      state.failReloads -= 1;
      save(state);
      process.exit(1);
    }
    state.nginxReloads += 1;
  } else if (action === 'show') {
    process.stdout.write(String(record.active ? record.pid : 0) + '\n');
    return;
  }
  save(state);
}

if (command === 'test') {
  let negate = false;
  let index = 0;
  if (rest[index] === '!') {
    negate = true;
    index += 1;
  }
  const operator = rest[index];
  const target = mapped(rest[index + 1]);
  let result = operator === '-f'
    ? fs.existsSync(target) && fs.statSync(target).isFile()
    : operator === '-L' && fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink();
  if (negate) result = !result;
  process.exit(result ? 0 : 1);
}

if (command === 'cp') {
  const positional = rest.filter((argument) => argument !== '--');
  const source = mapped(positional.at(-2));
  const target = mapped(positional.at(-1));
  ensureParent(target);
  fs.copyFileSync(source, target);
} else if (command === 'chown') {
  // Ownership is represented by the isolated fake host boundary.
} else if (command === 'install') {
  install();
} else if (command === 'rm') {
  fs.rmSync(mapped(rest.at(-1)), { force: true });
} else if (command === 'systemctl') {
  systemctl();
} else if (command === 'nginx') {
  const state = load();
  if (state.failNginxTests > 0) {
    state.failNginxTests -= 1;
    save(state);
    process.exit(1);
  }
} else if (command === 'ss') {
  const state = load();
  const match = rest.join(' ').match(/sport = :(\d+)/);
  if (!match) process.exit(96);
  const port = match[1];
  const unit = port === '18082'
    ? 'combo-release-production-web-forward.service'
    : port === '19002'
      ? 'combo-release-production-minio-forward.service'
      : null;
  if (!unit) process.exit(95);
  const record = state.units[unit];
  for (let index = 0; index < state.listenerCounts[port]; index += 1) {
    process.stdout.write(
      'LISTEN 0 128 127.0.0.1:' + port + ' 0.0.0.0:* users:(("kubectl",pid=' +
        record.pid + ',fd=' + (7 + index) + '))\n',
    );
  }
} else if (command === 'sha256sum') {
  const file = mapped(rest.at(-1));
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  process.stdout.write(digest + '  ' + rest.at(-1) + '\n');
} else {
  process.stderr.write('unsupported fake sudo command: ' + command + '\n');
  process.exit(97);
}
`;

const FAKE_CURL = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args.at(-1);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_HOST_STATE, 'utf8'));
fs.appendFileSync(process.env.FAKE_HOST_LOG, JSON.stringify(['curl', ...args]) + '\n');
if (!url.endsWith('/version.json')) process.exit(0);
const metadata = url.startsWith('http://127.0.0.1:')
  ? process.env.FAKE_CURRENT_METADATA
  : state.publicMode === 'current'
    ? process.env.FAKE_CURRENT_METADATA
    : process.env.FAKE_OLD_METADATA;
process.stdout.write(fs.readFileSync(metadata, 'utf8'));
`;

function executable(file, contents) {
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
}

function manifestFor(sourceSha, builtAt) {
  const digest = (character) => `sha256:${character.repeat(64)}`;
  return {
    schemaVersion: 1,
    sourceSha,
    releaseId: releaseIdForSource(sourceSha),
    images: {
      api: `ghcr.io/dangdang-tech/combo-api@${digest('1')}`,
      runtime: `ghcr.io/dangdang-tech/combo-runtime@${digest('2')}`,
      web: `ghcr.io/dangdang-tech/combo-web@${digest('3')}`,
    },
    migrationHead: '0006_one_running_turn_per_session.sql',
    builtAt,
    webAssetManifest: digest('4'),
  };
}

function metadataFor(manifest) {
  return {
    schemaVersion: 1,
    environment: 'production',
    sourceSha: manifest.sourceSha,
    releaseId: manifest.releaseId,
    builtAt: manifest.builtAt,
    releaseManifestDigest: releaseManifestDigest(manifest),
    webAssetManifest: manifest.webAssetManifest,
  };
}

function hostPath(fixture, absolutePath) {
  return join(fixture.hostRoot, absolutePath);
}

function readState(fixture) {
  return JSON.parse(readFileSync(fixture.statePath, 'utf8'));
}

function createFixture({
  unitExists = false,
  unitActive = false,
  unitEnabled = false,
  minioUnitExists = unitExists,
  minioUnitActive = unitActive,
  minioUnitEnabled = unitEnabled,
  nginx = NGINX_OLD,
  envContents = null,
  publicMode = 'current',
  failReloads = 0,
  webListenerCount = 1,
  minioListenerCount = 1,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'combo-release-traffic-'));
  const bin = join(root, 'bin');
  const hostRoot = join(root, 'host');
  const statePath = join(root, 'state.json');
  const logPath = join(root, 'calls.jsonl');
  mkdirSync(bin);
  mkdirSync(hostPath({ hostRoot }, '/etc/nginx/conf.d'), { recursive: true });
  mkdirSync(hostPath({ hostRoot }, '/etc/systemd/system'), { recursive: true });
  mkdirSync(hostPath({ hostRoot }, '/etc/combo-release'), { recursive: true });
  writeFileSync(hostPath({ hostRoot }, NGINX_PATH), nginx);
  if (unitExists) {
    writeFileSync(
      hostPath({ hostRoot }, `/etc/systemd/system/${WEB_UNIT}`),
      '[Unit]\nDescription=previous Web forward\n',
    );
  }
  if (minioUnitExists) {
    writeFileSync(
      hostPath({ hostRoot }, `/etc/systemd/system/${MINIO_UNIT}`),
      '[Unit]\nDescription=previous MinIO forward\n',
    );
  }
  if (envContents !== null) writeFileSync(hostPath({ hostRoot }, ENV_PATH), envContents);
  writeFileSync(logPath, '');
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        units: {
          [WEB_UNIT]: {
            active: unitActive,
            enabled: unitEnabled,
            pid: unitActive ? 3999 : 0,
          },
          [MINIO_UNIT]: {
            active: minioUnitActive,
            enabled: minioUnitEnabled,
            pid: minioUnitActive ? 4000 : 0,
          },
        },
        nextPid: 4100,
        listenerCounts: {
          18082: webListenerCount,
          19002: minioListenerCount,
        },
        publicMode,
        failReloads,
        failNginxTests: 0,
        nginxReloads: 0,
      },
      null,
      2,
    )}\n`,
  );
  executable(join(bin, 'sudo'), FAKE_SUDO);
  executable(join(bin, 'curl'), FAKE_CURL);
  executable(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  executable(
    join(bin, 'realpath'),
    '#!/usr/bin/env node\nconst fs = require("node:fs");\nconst value = process.argv.at(-1);\nprocess.stdout.write(fs.realpathSync(value) + "\\n");\n',
  );
  for (const command of ['systemctl', 'ss', 'nginx']) {
    executable(
      join(bin, command),
      `#!/usr/bin/env bash\necho '${command} must run through fake sudo' >&2\nexit 98\n`,
    );
  }
  executable(
    join(bin, 'id'),
    '#!/usr/bin/env bash\ncase "${1:-}" in -un) echo xingzheng;; -u|-g) echo 1000;; *) echo xingzheng;; esac\n',
  );
  return { root, bin, hostRoot, statePath, logPath };
}

function runSwitch(fixture, manifest, evidenceName = 'traffic-evidence.json') {
  const manifestPath = join(fixture.root, `${manifest.sourceSha}.json`);
  const metadataPath = join(fixture.root, `${manifest.sourceSha}.metadata.json`);
  const oldMetadataPath = join(fixture.root, 'old.metadata.json');
  const evidencePath = join(fixture.root, evidenceName);
  writeFileSync(manifestPath, serializeReleaseManifest(manifest));
  writeFileSync(metadataPath, `${JSON.stringify(metadataFor(manifest))}\n`);
  writeFileSync(
    oldMetadataPath,
    `${JSON.stringify({
      ...metadataFor(manifest),
      sourceSha: '0'.repeat(40),
      releaseId: `release-${'0'.repeat(40)}`,
    })}\n`,
  );
  const result = spawnSync(
    'bash',
    [
      SWITCH_TRAFFIC,
      '--environment',
      'production',
      '--manifest',
      manifestPath,
      '--manifest-digest',
      releaseManifestDigest(manifest),
      '--evidence-output',
      evidencePath,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        FAKE_HOST_ROOT: fixture.hostRoot,
        FAKE_HOST_STATE: fixture.statePath,
        FAKE_HOST_LOG: fixture.logPath,
        FAKE_CURRENT_METADATA: metadataPath,
        FAKE_OLD_METADATA: oldMetadataPath,
      },
    },
  );
  return { ...result, evidencePath };
}

function assertNoNonpublicOutput(result) {
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(NONPUBLIC_CONTEXT));
}

test('first activation atomically publishes Web and MinIO loopback evidence', (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('a'.repeat(40), '2026-07-24T08:00:00.000Z');

  const result = runSwitch(fixture, manifest);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(hostPath(fixture, NGINX_PATH), 'utf8'), NGINX_RELEASE);
  assert.equal(
    readFileSync(hostPath(fixture, ENV_PATH), 'utf8'),
    `COMBO_RELEASE_WEB_SERVICE=release-${manifest.sourceSha.slice(0, 12)}-web\n`,
  );
  const state = readState(fixture);
  assert.deepEqual(state.units[WEB_UNIT], { active: true, enabled: true, pid: 4101 });
  assert.deepEqual(state.units[MINIO_UNIT], { active: true, enabled: true, pid: 4102 });
  const evidence = JSON.parse(readFileSync(result.evidencePath, 'utf8'));
  assert.equal(evidence.sourceSha, manifest.sourceSha);
  assert.equal(evidence.s3Origin, 'https://s3.43-160-242-46.sslip.io');
  assert.equal(evidence.units.length, 2);
  assert.equal(evidence.units[0].service, `release-${manifest.sourceSha.slice(0, 12)}-web`);
  assert.equal(evidence.units[0].port, 18082);
  assert.equal(evidence.units[1].service, 'release-minio');
  assert.equal(evidence.units[1].port, 19002);
  assert.deepEqual(evidence.checks, {
    loopbackWebRelease: true,
    loopbackMinioReady: true,
    publicWebRelease: true,
    publicMinioReady: true,
  });
  assert.deepEqual(state.listenerCounts, { 18082: 1, 19002: 1 });
  assertNoNonpublicOutput(result);
});

test('repeating the same activation is idempotent', (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('b'.repeat(40), '2026-07-24T08:01:00.000Z');
  const firstResult = runSwitch(fixture, manifest, 'first-evidence.json');
  assert.equal(firstResult.status, 0, firstResult.stderr);
  const firstState = readState(fixture);
  assert.equal(firstState.nginxReloads, 1);

  const secondResult = runSwitch(fixture, manifest, 'second-evidence.json');

  assert.equal(secondResult.status, 0, secondResult.stderr);
  assert.equal(readFileSync(hostPath(fixture, NGINX_PATH), 'utf8'), NGINX_RELEASE);
  assert.equal(
    readFileSync(hostPath(fixture, ENV_PATH), 'utf8'),
    `COMBO_RELEASE_WEB_SERVICE=release-${manifest.sourceSha.slice(0, 12)}-web\n`,
  );
  const secondState = readState(fixture);
  assert.equal(secondState.nginxReloads, 1);
  assert.deepEqual(secondState.units[WEB_UNIT], { active: true, enabled: true, pid: 4103 });
  assert.deepEqual(secondState.units[MINIO_UNIT], { active: true, enabled: true, pid: 4104 });
  assert.deepEqual(JSON.parse(readFileSync(secondResult.evidencePath, 'utf8')).checks, {
    loopbackWebRelease: true,
    loopbackMinioReady: true,
    publicWebRelease: true,
    publicMinioReady: true,
  });
  assertNoNonpublicOutput(secondResult);
});

test('stale public metadata restores Nginx, both units, env, and active state', (t) => {
  const previousEnv = `COMBO_RELEASE_WEB_SERVICE=release-${'d'.repeat(12)}-web\nNONPUBLIC_CONTEXT=${NONPUBLIC_CONTEXT}\n`;
  const previousWebUnit = '[Unit]\nDescription=previous Web forward\n';
  const previousMinioUnit = '[Unit]\nDescription=previous MinIO forward\n';
  const fixture = createFixture({
    unitExists: true,
    unitActive: true,
    unitEnabled: false,
    envContents: previousEnv,
    publicMode: 'old',
  });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(
    readFileSync(hostPath(fixture, `/etc/systemd/system/${WEB_UNIT}`), 'utf8'),
    previousWebUnit,
  );
  assert.equal(
    readFileSync(hostPath(fixture, `/etc/systemd/system/${MINIO_UNIT}`), 'utf8'),
    previousMinioUnit,
  );
  const manifest = manifestFor('e'.repeat(40), '2026-07-24T08:03:00.000Z');

  const result = runSwitch(fixture, manifest);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public Web did not converge/);
  assert.equal(readFileSync(hostPath(fixture, NGINX_PATH), 'utf8'), NGINX_OLD);
  assert.equal(readFileSync(hostPath(fixture, ENV_PATH), 'utf8'), previousEnv);
  assert.equal(
    readFileSync(hostPath(fixture, `/etc/systemd/system/${WEB_UNIT}`), 'utf8'),
    previousWebUnit,
  );
  assert.equal(
    readFileSync(hostPath(fixture, `/etc/systemd/system/${MINIO_UNIT}`), 'utf8'),
    previousMinioUnit,
  );
  assert.deepEqual(readState(fixture).units[WEB_UNIT], {
    active: true,
    enabled: false,
    pid: 4103,
  });
  assert.deepEqual(readState(fixture).units[MINIO_UNIT], {
    active: true,
    enabled: false,
    pid: 4104,
  });
  assert.equal(existsSync(result.evidencePath), false);
  assertNoNonpublicOutput(result);
});

test('Nginx reload failure restores the entire previous transaction', (t) => {
  const fixture = createFixture({ failReloads: 1 });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('f'.repeat(40), '2026-07-24T08:04:00.000Z');

  const result = runSwitch(fixture, manifest);

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(hostPath(fixture, NGINX_PATH), 'utf8'), NGINX_OLD);
  assert.equal(existsSync(hostPath(fixture, ENV_PATH)), false);
  for (const unit of UNITS) {
    assert.equal(existsSync(hostPath(fixture, `/etc/systemd/system/${unit}`)), false);
  }
  assert.deepEqual(readState(fixture).units[WEB_UNIT], {
    active: false,
    enabled: false,
    pid: 0,
  });
  assert.deepEqual(readState(fixture).units[MINIO_UNIT], {
    active: false,
    enabled: false,
    pid: 0,
  });
  assert.equal(existsSync(result.evidencePath), false);
  assertNoNonpublicOutput(result);
});

test('multiple listeners are rejected before Nginx traffic changes', (t) => {
  const fixture = createFixture({ webListenerCount: 2 });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('9'.repeat(40), '2026-07-24T08:05:00.000Z');

  const result = runSwitch(fixture, manifest);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /single IPv4 loopback listener/);
  assert.equal(readFileSync(hostPath(fixture, NGINX_PATH), 'utf8'), NGINX_OLD);
  assert.equal(existsSync(hostPath(fixture, ENV_PATH)), false);
  for (const unit of UNITS) {
    assert.equal(existsSync(hostPath(fixture, `/etc/systemd/system/${unit}`)), false);
  }
  assert.equal(existsSync(result.evidencePath), false);
  assertNoNonpublicOutput(result);
});
