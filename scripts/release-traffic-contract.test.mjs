import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const ROLLBACK_TRAFFIC = join(import.meta.dirname, 'rollback-release-traffic.sh');
const WEB_UNIT = 'combo-release-production-web-forward.service';
const MINIO_UNIT = 'combo-release-production-minio-forward.service';
const UNITS = [WEB_UNIT, MINIO_UNIT];
const NGINX_PATH = '/etc/nginx/conf.d/zz-agora-demo.conf';
const FORMAL_NGINX_PATH = '/etc/nginx/conf.d/happy.conf';
const ENV_PATH = '/etc/combo-release/production-web-forward.env';
const NONPUBLIC_CONTEXT = 'fixture-not-for-output';
const PREVIOUS_SOURCE = 'd'.repeat(40);
const PREVIOUS_SERVICE = `release-${PREVIOUS_SOURCE.slice(0, 12)}-web`;
const WEB_UNIT_SOURCE = readFileSync(
  join(ROOT, 'infra/host/release/combo-release-production-web-forward.service'),
  'utf8',
);
const MINIO_UNIT_SOURCE = readFileSync(
  join(ROOT, 'infra/host/release/combo-release-production-minio-forward.service'),
  'utf8',
);

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

const FORMAL_NGINX_OLD = `server {
  listen 80;
  server_name buildwithcombo.com www.buildwithcombo.com 43-160-242-46.sslip.io;
  return 301 https://buildwithcombo.com$request_uri;
}
server {
  listen 443 ssl;
  server_name buildwithcombo.com www.buildwithcombo.com 43-160-242-46.sslip.io;
  ssl_certificate /etc/letsencrypt/live/buildwithcombo.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/buildwithcombo.com/privkey.pem;
  location ~ ^/api/v1/tasks/.+/events$ { proxy_pass http://127.0.0.1:30080; }
  location ^~ /api/v1/runtime/ { proxy_pass http://127.0.0.1:30080; }
  location ~ ^/api/v1/connect/ { proxy_pass http://127.0.0.1:30080; }
  location / { proxy_pass http://127.0.0.1:30080; }
}
`;

const FORMAL_NGINX_RELEASE = FORMAL_NGINX_OLD.replaceAll(
  'proxy_pass http://127.0.0.1:30080;',
  'proxy_pass http://127.0.0.1:18082;',
);

const WEB_ASSET_MANIFEST = `${JSON.stringify(
  {
    schemaVersion: 1,
    assets: [
      {
        application: 'runtime-web',
        path: 'index.html',
        digest: `sha256:${'5'.repeat(64)}`,
      },
      {
        application: 'web',
        path: 'assets/index-deadbeef.js',
        digest: `sha256:${'6'.repeat(64)}`,
      },
      {
        application: 'web',
        path: 'index.html',
        digest: `sha256:${'7'.repeat(64)}`,
      },
    ],
  },
  null,
  2,
)}\n`;

function sha256(contents) {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

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

test('first formal cutover imports the prior release and rollback verifies its canary', () => {
  const activation = readFileSync(SWITCH_TRAFFIC, 'utf8');
  const rollback = readFileSync(ROLLBACK_TRAFFIC, 'utf8');
  assert.match(activation, /combo-releases\/goal-a/);
  assert.match(
    activation,
    /resolve_previous_release_identity[\s\S]*deploy-evidence\.json[\s\S]*release-manifest\.mjs/,
  );
  assert.match(activation, /existing Web Deployment does not match its trusted release evidence/);
  assert.match(activation, /FORMAL_INITIAL_SHA256=.*a2b92b1c/);
  assert.match(
    rollback,
    /previous_formal_mode" == release[\s\S]*FORMAL_ORIGIN[\s\S]*CANARY_ORIGIN/,
  );
  assert.match(rollback, /persisted formal Nginx rollback digest changed/);
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
  if (action === 'stop'
      && process.env.FAKE_FAIL_SYSTEMCTL_STOP_AFTER_PUBLIC === '1'
      && fs.existsSync(statePath + '.public-failed')) {
    process.exit(1);
  }
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
    : operator === '-d'
      ? fs.existsSync(target) && fs.statSync(target).isDirectory()
    : operator === '-L'
      ? fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()
      : operator === '-e' && fs.existsSync(target);
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
  fs.rmSync(mapped(rest.at(-1)), {
    force: true,
    recursive: rest.some((argument) => argument.includes('r')),
  });
} else if (command === 'mv') {
  const positional = rest.filter((argument) => argument !== '-T' && argument !== '--');
  const source = mapped(positional.at(-2));
  const target = mapped(positional.at(-1));
  ensureParent(target);
  fs.renameSync(source, target);
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
} else if (command === 'awk') {
  const file = mapped(rest.at(-1));
  const match = fs.readFileSync(file, 'utf8').match(/^COMBO_RELEASE_WEB_SERVICE=(.+)$/m);
  if (match) process.stdout.write(match[1] + '\n');
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
const valueAfter = (name) => {
  const index = args.lastIndexOf(name);
  return index < 0 ? null : args[index + 1];
};
const output = valueAfter('--output');
const headers = valueAfter('--dump-header');
const wantsWriteOut = args.includes('--write-out');
const current = url.startsWith('http://127.0.0.1:')
  || state.publicMode === 'current';
if (!current && process.env.FAKE_MARK_PUBLIC_FAILURE === '1') {
  fs.writeFileSync(process.env.FAKE_HOST_STATE + '.public-failed', '1\n');
}
let status = 200;
let contentType = 'application/json';
let cacheControl = 'no-store';
let body = '{}\n';
if (url.endsWith('/version.json') || url.endsWith('/runtime-config.json')
  || url.endsWith('/api/v1/version')) {
  body = fs.readFileSync(
    current ? process.env.FAKE_CURRENT_METADATA : process.env.FAKE_OLD_METADATA,
    'utf8',
  );
} else if (url.endsWith('/web-asset-manifest.json')) {
  body = fs.readFileSync(process.env.FAKE_WEB_ASSET_MANIFEST, 'utf8');
} else if (url.includes('/assets/combo-missing-')) {
  status = 404;
  contentType = 'text/html';
  cacheControl = 'public, max-age=31536000, immutable';
  body = '<html><body>404 Not Found</body></html>\n';
} else if (url.includes('/assets/')) {
  contentType = 'application/javascript';
  cacheControl = 'public, max-age=31536000, immutable';
  body = 'globalThis.comboFixture=true;\n';
} else if (url.endsWith('/') || url.endsWith('/tasks') || url.endsWith('/capabilities')) {
  contentType = 'text/html';
  cacheControl = 'no-cache, max-age=0, must-revalidate';
  body = '<!doctype html><html><div id="root"></div></html>\n';
} else if (url.endsWith('/health') || url.endsWith('/ready')) {
  body = '{"data":{"status":"ok","ready":true}}\n';
}
if (headers) {
  fs.writeFileSync(
    headers,
    'HTTP/2 ' + status + '\r\nContent-Type: ' + contentType +
      '\r\nCache-Control: ' + cacheControl + '\r\n\r\n',
  );
}
if (output && output !== '/dev/null') fs.writeFileSync(output, body);
if (!output) process.stdout.write(body);
if (wantsWriteOut) process.stdout.write(String(status) + ' 0');
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
    webAssetManifest: sha256(WEB_ASSET_MANIFEST),
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

function restorePredecessorTrafficState(fixture, checkpoint) {
  const previous = checkpoint.previous;
  writeFileSync(
    join(fixture.trafficStateRoot, 'production', 'current.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        environment: 'production',
        sourceSha: previous.sourceSha,
        releaseId: previous.releaseId,
        manifestDigest: previous.manifestDigest,
        canaryNginxSha256: previous.canaryNginxSha256,
        formalNginxSha256: previous.formalNginxSha256,
        webService: previous.webService,
      },
      null,
      2,
    )}\n`,
  );
}

function createFixture({
  unitExists = true,
  unitActive = true,
  unitEnabled = true,
  minioUnitExists = unitExists,
  minioUnitActive = unitActive,
  minioUnitEnabled = unitEnabled,
  nginx = NGINX_OLD,
  formalNginx = FORMAL_NGINX_OLD,
  envContents = `COMBO_RELEASE_WEB_SERVICE=${PREVIOUS_SERVICE}\n`,
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
  const trafficStateRoot = join(root, 'traffic-state');
  const checkpointRoot = join(root, 'traffic-checkpoints');
  const trafficLock = join(root, 'traffic.lock');
  mkdirSync(bin);
  mkdirSync(hostPath({ hostRoot }, '/etc/nginx/conf.d'), { recursive: true });
  mkdirSync(hostPath({ hostRoot }, '/etc/systemd/system'), { recursive: true });
  mkdirSync(hostPath({ hostRoot }, '/etc/combo-release'), { recursive: true });
  writeFileSync(hostPath({ hostRoot }, NGINX_PATH), nginx);
  writeFileSync(hostPath({ hostRoot }, FORMAL_NGINX_PATH), formalNginx);
  if (unitExists) {
    writeFileSync(hostPath({ hostRoot }, `/etc/systemd/system/${WEB_UNIT}`), WEB_UNIT_SOURCE);
  }
  if (minioUnitExists) {
    writeFileSync(hostPath({ hostRoot }, `/etc/systemd/system/${MINIO_UNIT}`), MINIO_UNIT_SOURCE);
  }
  if (envContents !== null) writeFileSync(hostPath({ hostRoot }, ENV_PATH), envContents);
  mkdirSync(join(trafficStateRoot, 'production'), { recursive: true });
  writeFileSync(
    join(trafficStateRoot, 'production', 'current.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        environment: 'production',
        sourceSha: PREVIOUS_SOURCE,
        releaseId: `release-${PREVIOUS_SOURCE}`,
        manifestDigest: `sha256:${'8'.repeat(64)}`,
        canaryNginxSha256: sha256(nginx),
        formalNginxSha256: sha256(formalNginx),
        webService: envContents
          ? (envContents.match(/^COMBO_RELEASE_WEB_SERVICE=(.+)$/m)?.[1] ?? '')
          : '',
      },
      null,
      2,
    )}\n`,
  );
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
  executable(
    join(bin, 'kubectl'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const resource = args.find((value) => value.startsWith('deployment/') || value.startsWith('service/'));
if (resource === 'deployment/${PREVIOUS_SERVICE}') {
  process.stdout.write(JSON.stringify({
    status: { readyReplicas: 1 },
    spec: {
      replicas: 1,
      template: { metadata: { annotations: {
        'combo.build/source-sha': '${PREVIOUS_SOURCE}',
        'combo.build/release-id': 'release-${PREVIOUS_SOURCE}'
      } } }
    }
  }) + '\\n');
} else if (resource === 'service/${PREVIOUS_SERVICE}') {
  process.stdout.write(JSON.stringify({
    spec: { selector: {
      app: '${PREVIOUS_SERVICE}',
      'combo.build/release-track': 'release-v1'
    } }
  }) + '\\n');
} else {
  process.exit(1);
}
`,
  );
  executable(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  executable(
    join(bin, 'mv'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${FAKE_FAIL_MOVE_TARGET:-}" &&
  "\${*: -1}" == "$FAKE_FAIL_MOVE_TARGET" ]]; then
  exit 1
fi
exec /usr/bin/mv "$@"
`,
  );
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
  return {
    root,
    bin,
    hostRoot,
    statePath,
    logPath,
    trafficStateRoot,
    checkpointRoot,
    trafficLock,
  };
}

function runSwitch(fixture, manifest, evidenceName = 'traffic-evidence.json', extraEnv = {}) {
  const manifestPath = join(fixture.root, `${manifest.sourceSha}.json`);
  const metadataPath = join(fixture.root, `${manifest.sourceSha}.metadata.json`);
  const oldMetadataPath = join(fixture.root, 'old.metadata.json');
  const webAssetManifestPath = join(fixture.root, 'web-asset-manifest.json');
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
  writeFileSync(webAssetManifestPath, WEB_ASSET_MANIFEST);
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
        FAKE_WEB_ASSET_MANIFEST: webAssetManifestPath,
        COMBO_RELEASE_TRAFFIC_STATE_ROOT: fixture.trafficStateRoot,
        COMBO_RELEASE_TRAFFIC_CHECKPOINT_ROOT: fixture.checkpointRoot,
        COMBO_RELEASE_TRAFFIC_LOCK: fixture.trafficLock,
        ...extraEnv,
      },
    },
  );
  return { ...result, evidencePath };
}

function runRollback(fixture, manifest, evidenceName = 'rollback-evidence.json') {
  const manifestPath = join(fixture.root, `${manifest.sourceSha}.json`);
  const previousMetadataPath = join(fixture.root, 'previous.metadata.json');
  const webAssetManifestPath = join(fixture.root, 'web-asset-manifest.json');
  const evidencePath = join(fixture.root, evidenceName);
  const state = readState(fixture);
  state.publicMode = 'old';
  writeFileSync(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(
    previousMetadataPath,
    `${JSON.stringify({
      schemaVersion: 1,
      environment: 'production',
      sourceSha: PREVIOUS_SOURCE,
      releaseId: `release-${PREVIOUS_SOURCE}`,
      builtAt: '2026-07-24T07:00:00.000Z',
      releaseManifestDigest: `sha256:${'8'.repeat(64)}`,
      webAssetManifest: `sha256:${'9'.repeat(64)}`,
    })}\n`,
  );
  const result = spawnSync(
    'bash',
    [
      ROLLBACK_TRAFFIC,
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
        FAKE_CURRENT_METADATA: previousMetadataPath,
        FAKE_OLD_METADATA: previousMetadataPath,
        FAKE_WEB_ASSET_MANIFEST: webAssetManifestPath,
        COMBO_RELEASE_TRAFFIC_STATE_ROOT: fixture.trafficStateRoot,
        COMBO_RELEASE_TRAFFIC_CHECKPOINT_ROOT: fixture.checkpointRoot,
        COMBO_RELEASE_TRAFFIC_LOCK: fixture.trafficLock,
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
  assert.equal(readFileSync(hostPath(fixture, FORMAL_NGINX_PATH), 'utf8'), FORMAL_NGINX_RELEASE);
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
    formalHome: true,
    formalVersion: true,
    formalSpaRoutes: true,
    formalApi: true,
    formalTls: true,
    formalHtmlCache: true,
    formalAssetCache: true,
    formalMissingAsset404: true,
    formalForcedRefresh: true,
    internalPortsLoopbackOnly: true,
  });
  assert.equal(evidence.formalOrigin, 'https://buildwithcombo.com');
  assert.equal(evidence.formalNginx.path, FORMAL_NGINX_PATH);
  assert.equal(evidence.routeCas.formal.contract, 'production-formal');
  assert.equal(evidence.rollback.persisted, true);
  const checkpoint = join(
    fixture.checkpointRoot,
    'production',
    manifest.releaseId,
    'checkpoint.json',
  );
  assert.equal(JSON.parse(readFileSync(checkpoint, 'utf8')).status, 'activated');
  assert.equal(
    existsSync(
      join(fixture.checkpointRoot, 'production', manifest.releaseId, 'nginx-formal.before'),
    ),
    true,
  );
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
    formalHome: true,
    formalVersion: true,
    formalSpaRoutes: true,
    formalApi: true,
    formalTls: true,
    formalHtmlCache: true,
    formalAssetCache: true,
    formalMissingAsset404: true,
    formalForcedRefresh: true,
    internalPortsLoopbackOnly: true,
  });
  assertNoNonpublicOutput(secondResult);
});

test('same-SHA activation rejects a different immutable manifest before mutation', (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('6'.repeat(40), '2026-07-24T08:01:30.000Z');
  const firstResult = runSwitch(fixture, manifest, 'first-evidence.json');
  assert.equal(firstResult.status, 0, firstResult.stderr);
  const currentPath = join(fixture.trafficStateRoot, 'production', 'current.json');
  const current = JSON.parse(readFileSync(currentPath, 'utf8'));
  current.manifestDigest = `sha256:${'a'.repeat(64)}`;
  writeFileSync(currentPath, `${JSON.stringify(current, null, 2)}\n`);
  const before = readState(fixture);

  const secondResult = runSwitch(fixture, manifest, 'second-evidence.json');

  assert.notEqual(secondResult.status, 0);
  assert.match(secondResult.stderr, /candidate traffic state identifies another immutable release/);
  assert.equal(existsSync(secondResult.evidencePath), false);
  assert.deepEqual(readState(fixture), before);
  assert.equal(
    JSON.parse(readFileSync(currentPath, 'utf8')).manifestDigest,
    `sha256:${'a'.repeat(64)}`,
  );
  assertNoNonpublicOutput(secondResult);
});

test('repeated activation rejects a missing persisted rollback backup', (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('c'.repeat(40), '2026-07-24T08:02:00.000Z');
  const firstResult = runSwitch(fixture, manifest, 'first-evidence.json');
  assert.equal(firstResult.status, 0, firstResult.stderr);
  rmSync(join(fixture.checkpointRoot, 'production', manifest.releaseId, 'nginx-canary.before'));

  const secondResult = runSwitch(fixture, manifest, 'second-evidence.json');

  assert.notEqual(secondResult.status, 0);
  assert.match(secondResult.stderr, /reused rollback backup is unavailable/);
  assert.equal(existsSync(secondResult.evidencePath), false);
  assertNoNonpublicOutput(secondResult);
});

test('candidate current state without its rollback checkpoint is rejected', (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('4'.repeat(40), '2026-07-24T08:02:15.000Z');
  const firstResult = runSwitch(fixture, manifest, 'first-evidence.json');
  assert.equal(firstResult.status, 0, firstResult.stderr);
  rmSync(join(fixture.checkpointRoot, 'production', manifest.releaseId), {
    recursive: true,
  });

  const secondResult = runSwitch(fixture, manifest, 'second-evidence.json');

  assert.notEqual(secondResult.status, 0);
  assert.match(secondResult.stderr, /candidate traffic state lacks its rollback checkpoint/);
  assert.equal(existsSync(secondResult.evidencePath), false);
  assertNoNonpublicOutput(secondResult);
});

test('activation recovers an activated checkpoint with predecessor current state', (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('1'.repeat(40), '2026-07-24T08:02:30.000Z');
  const firstResult = runSwitch(fixture, manifest, 'first-evidence.json');
  assert.equal(firstResult.status, 0, firstResult.stderr);
  const checkpointPath = join(
    fixture.checkpointRoot,
    'production',
    manifest.releaseId,
    'checkpoint.json',
  );
  const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  restorePredecessorTrafficState(fixture, checkpoint);

  const recovered = runSwitch(fixture, manifest, 'recovered-evidence.json');

  assert.equal(recovered.status, 0, recovered.stderr);
  const current = JSON.parse(
    readFileSync(join(fixture.trafficStateRoot, 'production', 'current.json'), 'utf8'),
  );
  assert.equal(current.sourceSha, manifest.sourceSha);
  assert.equal(JSON.parse(readFileSync(checkpointPath, 'utf8')).status, 'activated');
  assert.equal(
    JSON.parse(readFileSync(recovered.evidencePath, 'utf8')).sourceSha,
    manifest.sourceSha,
  );
  assertNoNonpublicOutput(recovered);
});

test('activation rolls an armed live candidate forward after a hard interruption', (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('2'.repeat(40), '2026-07-24T08:02:45.000Z');
  const firstResult = runSwitch(fixture, manifest, 'first-evidence.json');
  assert.equal(firstResult.status, 0, firstResult.stderr);
  const checkpointPath = join(
    fixture.checkpointRoot,
    'production',
    manifest.releaseId,
    'checkpoint.json',
  );
  const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  restorePredecessorTrafficState(fixture, checkpoint);
  checkpoint.status = 'armed';
  checkpoint.activatedAt = null;
  writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

  const recovered = runSwitch(fixture, manifest, 'recovered-evidence.json');

  assert.equal(recovered.status, 0, recovered.stderr);
  const current = JSON.parse(
    readFileSync(join(fixture.trafficStateRoot, 'production', 'current.json'), 'utf8'),
  );
  assert.equal(current.sourceSha, manifest.sourceSha);
  assert.equal(JSON.parse(readFileSync(checkpointPath, 'utf8')).status, 'activated');
  assert.equal(
    JSON.parse(readFileSync(recovered.evidencePath, 'utf8')).sourceSha,
    manifest.sourceSha,
  );
  assertNoNonpublicOutput(recovered);
});

test('failed evidence publication leaves a complete candidate that can resume', (t) => {
  const fixture = createFixture({ unitActive: true, unitEnabled: false });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('3'.repeat(40), '2026-07-24T08:02:50.000Z');
  const firstResult = runSwitch(fixture, manifest, 'first-evidence.json');
  assert.equal(firstResult.status, 0, firstResult.stderr);
  const checkpointPath = join(
    fixture.checkpointRoot,
    'production',
    manifest.releaseId,
    'checkpoint.json',
  );
  const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  restorePredecessorTrafficState(fixture, checkpoint);
  checkpoint.status = 'armed';
  checkpoint.activatedAt = null;
  writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  writeFileSync(hostPath(fixture, NGINX_PATH), NGINX_OLD);
  writeFileSync(hostPath(fixture, FORMAL_NGINX_PATH), FORMAL_NGINX_OLD);
  writeFileSync(hostPath(fixture, ENV_PATH), `COMBO_RELEASE_WEB_SERVICE=${PREVIOUS_SERVICE}\n`);
  const state = readState(fixture);
  state.units[WEB_UNIT] = { active: true, enabled: false, pid: 4201 };
  state.units[MINIO_UNIT] = { active: true, enabled: false, pid: 4202 };
  writeFileSync(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);
  const failedEvidence = join(fixture.root, 'failed-evidence.json');

  const failed = runSwitch(fixture, manifest, 'failed-evidence.json', {
    FAKE_FAIL_MOVE_TARGET: failedEvidence,
  });

  assert.notEqual(failed.status, 0);
  assert.equal(existsSync(failedEvidence), false);
  assert.equal(JSON.parse(readFileSync(checkpointPath, 'utf8')).status, 'activated');
  assert.equal(readFileSync(hostPath(fixture, NGINX_PATH), 'utf8'), NGINX_RELEASE);
  assert.equal(readFileSync(hostPath(fixture, FORMAL_NGINX_PATH), 'utf8'), FORMAL_NGINX_RELEASE);
  let current = JSON.parse(
    readFileSync(join(fixture.trafficStateRoot, 'production', 'current.json'), 'utf8'),
  );
  assert.equal(current.sourceSha, manifest.sourceSha);
  assertNoNonpublicOutput(failed);

  const recovered = runSwitch(fixture, manifest, 'recovered-evidence.json');

  assert.equal(recovered.status, 0, recovered.stderr);
  current = JSON.parse(
    readFileSync(join(fixture.trafficStateRoot, 'production', 'current.json'), 'utf8'),
  );
  assert.equal(current.sourceSha, manifest.sourceSha);
  assert.equal(
    JSON.parse(readFileSync(recovered.evidencePath, 'utf8')).sourceSha,
    manifest.sourceSha,
  );
});

test('stale public metadata restores Nginx, both units, env, and active state', (t) => {
  const previousEnv = `COMBO_RELEASE_WEB_SERVICE=${PREVIOUS_SERVICE}\n`;
  const previousWebUnit = WEB_UNIT_SOURCE;
  const previousMinioUnit = MINIO_UNIT_SOURCE;
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
  assert.equal(readFileSync(hostPath(fixture, FORMAL_NGINX_PATH), 'utf8'), FORMAL_NGINX_OLD);
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

test('incomplete compensation preserves the durable rollback checkpoint', (t) => {
  const fixture = createFixture({ publicMode: 'old' });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('8'.repeat(40), '2026-07-24T08:03:30.000Z');
  const currentPath = join(fixture.trafficStateRoot, 'production', 'current.json');

  const result = runSwitch(fixture, manifest, 'failed-evidence.json', {
    FAKE_FAIL_SYSTEMCTL_STOP_AFTER_PUBLIC: '1',
    FAKE_MARK_PUBLIC_FAILURE: '1',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /compensation was incomplete; preserving the rollback checkpoint/);
  assert.equal(existsSync(result.evidencePath), false);
  const checkpointPath = join(
    fixture.checkpointRoot,
    'production',
    manifest.releaseId,
    'checkpoint.json',
  );
  assert.equal(existsSync(checkpointPath), true);
  assert.equal(JSON.parse(readFileSync(checkpointPath, 'utf8')).status, 'armed');
  assert.equal(JSON.parse(readFileSync(currentPath, 'utf8')).sourceSha, PREVIOUS_SOURCE);
  assert.equal(readFileSync(hostPath(fixture, NGINX_PATH), 'utf8'), NGINX_OLD);
  assert.equal(readFileSync(hostPath(fixture, FORMAL_NGINX_PATH), 'utf8'), FORMAL_NGINX_OLD);
  assertNoNonpublicOutput(result);
});

test('Nginx reload failure restores the entire previous transaction', (t) => {
  const fixture = createFixture({ failReloads: 1 });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('f'.repeat(40), '2026-07-24T08:04:00.000Z');

  const result = runSwitch(fixture, manifest);

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(hostPath(fixture, NGINX_PATH), 'utf8'), NGINX_OLD);
  assert.equal(readFileSync(hostPath(fixture, FORMAL_NGINX_PATH), 'utf8'), FORMAL_NGINX_OLD);
  assert.equal(
    readFileSync(hostPath(fixture, ENV_PATH), 'utf8'),
    `COMBO_RELEASE_WEB_SERVICE=${PREVIOUS_SERVICE}\n`,
  );
  for (const unit of UNITS) {
    assert.equal(existsSync(hostPath(fixture, `/etc/systemd/system/${unit}`)), true);
  }
  assert.deepEqual(readState(fixture).units[WEB_UNIT], {
    active: true,
    enabled: true,
    pid: 4103,
  });
  assert.deepEqual(readState(fixture).units[MINIO_UNIT], {
    active: true,
    enabled: true,
    pid: 4104,
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
  assert.equal(readFileSync(hostPath(fixture, FORMAL_NGINX_PATH), 'utf8'), FORMAL_NGINX_OLD);
  assert.equal(
    readFileSync(hostPath(fixture, ENV_PATH), 'utf8'),
    `COMBO_RELEASE_WEB_SERVICE=${PREVIOUS_SERVICE}\n`,
  );
  for (const unit of UNITS) {
    assert.equal(existsSync(hostPath(fixture, `/etc/systemd/system/${unit}`)), true);
  }
  assert.equal(existsSync(result.evidencePath), false);
  assertNoNonpublicOutput(result);
});

test('rollback restores the exact prior route, units, and durable identity', (t) => {
  const fixture = createFixture({ unitActive: true, unitEnabled: false });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = manifestFor('7'.repeat(40), '2026-07-24T08:06:00.000Z');
  const activation = runSwitch(fixture, manifest);
  assert.equal(activation.status, 0, activation.stderr);

  const rollback = runRollback(fixture, manifest);

  assert.equal(
    rollback.status,
    0,
    `${rollback.stderr}\n${rollback.stdout}\n${readFileSync(fixture.logPath, 'utf8')}`,
  );
  assert.equal(readFileSync(hostPath(fixture, NGINX_PATH), 'utf8'), NGINX_OLD);
  assert.equal(readFileSync(hostPath(fixture, FORMAL_NGINX_PATH), 'utf8'), FORMAL_NGINX_OLD);
  assert.equal(
    readFileSync(hostPath(fixture, ENV_PATH), 'utf8'),
    `COMBO_RELEASE_WEB_SERVICE=${PREVIOUS_SERVICE}\n`,
  );
  assert.deepEqual(readState(fixture).units[WEB_UNIT].enabled, false);
  assert.deepEqual(readState(fixture).units[MINIO_UNIT].enabled, false);
  const current = JSON.parse(
    readFileSync(join(fixture.trafficStateRoot, 'production', 'current.json'), 'utf8'),
  );
  assert.equal(current.sourceSha, PREVIOUS_SOURCE);
  assert.equal(current.webService, PREVIOUS_SERVICE);
  const checkpoint = JSON.parse(
    readFileSync(
      join(fixture.checkpointRoot, 'production', manifest.releaseId, 'checkpoint.json'),
      'utf8',
    ),
  );
  assert.equal(checkpoint.status, 'rolled-back');
  const evidence = JSON.parse(readFileSync(rollback.evidencePath, 'utf8'));
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.sourceSha, manifest.sourceSha);
  assert.equal(evidence.restoredSourceSha, PREVIOUS_SOURCE);
  assert.equal(evidence.restoredReleaseId, `release-${PREVIOUS_SOURCE}`);
  assert.deepEqual(evidence.checks, {
    activeCas: true,
    previousTargetAvailable: true,
    unitsRestored: true,
    nginxRestored: true,
    publicWebRestored: true,
  });
  assertNoNonpublicOutput(rollback);
});
