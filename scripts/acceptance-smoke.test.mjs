import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const zeroId = '00000000-0000-7000-8000-000000000000';

const readPaths = new Set([
  '/api/v1/me',
  '/api/v1/tasks',
  `/api/v1/tasks/${zeroId}`,
  '/api/v1/capabilities',
  `/api/v1/capabilities/${zeroId}`,
  `/api/v1/capabilities/${zeroId}/definition`,
  '/api/v1/agent-projects',
  `/api/v1/agent-projects/${zeroId}`,
  `/api/v1/agent-projects/${zeroId}/revisions/${zeroId}`,
  '/api/v1/billing/wallet',
  `/api/v1/billing/recharge-orders/by-intent/${zeroId}`,
  `/api/v1/billing/recharge-orders/${zeroId}`,
  '/api/v1/runtime/capabilities',
  '/api/v1/runtime/sessions',
  `/api/v1/runtime/sessions/${zeroId}`,
  `/api/v1/runtime/artifacts/${zeroId}/content`,
  `/api/v1/runtime/agent-tests/${zeroId}`,
  `/api/v1/runtime/agent-projects/${zeroId}/tests`,
]);

const fullOriginWriteProbes = [
  ['POST', '/api/v1/tasks'],
  ['POST', `/api/v1/tasks/${zeroId}/retry`],
  ['POST', `/api/v1/capabilities/${zeroId}/publish`],
  ['POST', `/api/v1/capabilities/${zeroId}/unpublish`],
  ['POST', '/api/v1/agent-projects'],
  ['POST', `/api/v1/agent-projects/${zeroId}/revisions`],
  ['POST', `/api/v1/agent-projects/${zeroId}/tests/${zeroId}/reviews`],
  ['POST', `/api/v1/agent-projects/${zeroId}/releases`],
  ['POST', '/api/v1/runtime/studio/sessions'],
  ['POST', '/api/v1/runtime/sessions'],
  ['PATCH', `/api/v1/runtime/sessions/${zeroId}`],
  ['DELETE', `/api/v1/runtime/sessions/${zeroId}`],
  ['POST', `/api/v1/runtime/sessions/${zeroId}/messages`],
  ['POST', `/api/v1/runtime/sessions/${zeroId}/interrupt`],
  ['POST', `/api/v1/runtime/studio/sessions/${zeroId}/ui-revisions`],
  ['POST', `/api/v1/runtime/agent-revisions/${zeroId}/tests`],
  ['POST', `/api/v1/runtime/agents/${zeroId}/sessions`],
];
const trustedOnlyWriteProbes = [['POST', '/api/v1/billing/recharge-orders']];
const writeProbes = [...fullOriginWriteProbes, ...trustedOnlyWriteProbes];

const publicAuthWritePaths = new Set([
  '/api/v1/auth/email/challenges',
  '/api/v1/auth/email/verifications',
]);
const ssePaths = new Set([
  `/api/v1/tasks/${zeroId}/events`,
  `/api/v1/runtime/sessions/${zeroId}/stream`,
]);

const writeProbeKey = (method, path) => `${method} ${path}`;

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function runAcceptance(origin, curlHome) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('/bin/bash', ['scripts/acceptance-smoke.sh'], {
      cwd: repo,
      env: {
        ...process.env,
        ALL_PROXY: '',
        API_BASE: origin,
        CB_SESSION_COOKIE_JAR: '',
        CURL_HOME: curlHome,
        HOME: curlHome,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        NO_PROXY: '127.0.0.1,localhost',
        WEB_BASE: `${origin}/`,
        XDG_CONFIG_HOME: curlHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectRun);
    child.once('close', (code, signal) => resolveRun({ code, signal, stderr, stdout }));
  });
}

test('acceptance smoke enforces the complete anonymous Origin-first matrix', async (context) => {
  const curlHome = await mkdtemp(join(tmpdir(), 'combo-acceptance-curl-home-'));
  await writeFile(
    join(curlHome, '.curlrc'),
    'header = "Cookie: ambient_session=must-not-be-sent"\n',
    'utf8',
  );
  let observedAmbientCookie = false;
  const observedReads = new Map([...readPaths].map((path) => [path, 0]));
  const observedSseProbes = new Map();
  const observedPublicAuthWrites = new Map([...publicAuthWritePaths].map((path) => [path, []]));
  const observedLogoutProbes = [];
  const observedWrites = new Map(
    writeProbes.map(([method, path]) => [writeProbeKey(method, path), []]),
  );
  let breakMissingOriginGuard = false;
  let origin;
  const server = createServer((request, response) => {
    if (request.headers.cookie !== undefined) observedAmbientCookie = true;
    const requestUrl = new URL(request.url, origin);
    const path = requestUrl.pathname;
    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && path === '/ready') {
      sendJson(response, 200, { data: { ready: true } });
      return;
    }
    if (request.method === 'GET' && path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>fixture</title>');
      return;
    }
    if (request.method === 'GET' && readPaths.has(path)) {
      observedReads.set(path, observedReads.get(path) + 1);
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method === 'GET' && ssePaths.has(path)) {
      let probe = 'anonymous';
      if (request.headers.authorization === 'Bearer placeholder') probe = 'bearer';
      if (requestUrl.searchParams.get('access_token') === 'placeholder') probe = 'query';
      const probeKey = `${path} ${probe}`;
      observedSseProbes.set(probeKey, (observedSseProbes.get(probeKey) ?? 0) + 1);
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method === 'POST' && publicAuthWritePaths.has(path)) {
      const requestOrigin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      let probe;
      let statusCode;
      if (requestOrigin === undefined) {
        probe = 'missing';
        statusCode = 403;
      } else if (requestOrigin === 'https://wrong-origin.invalid' && fetchSite === 'cross-site') {
        probe = 'wrong';
        statusCode = 403;
      } else if (requestOrigin === origin && fetchSite === 'same-origin') {
        probe = 'trusted';
        statusCode = 415;
      } else {
        probe = 'unexpected';
        statusCode = 400;
      }
      observedPublicAuthWrites.get(path).push(probe);
      sendJson(response, statusCode, { error: statusCode === 415 ? 'media_type' : 'forbidden' });
      return;
    }
    if (request.method === 'POST' && path === '/api/v1/auth/logout') {
      const requestOrigin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      let probe = 'unexpected';
      if (requestOrigin === undefined) probe = 'missing';
      if (requestOrigin === 'https://wrong-origin.invalid' && fetchSite === 'cross-site') {
        probe = 'wrong';
      }
      if (requestOrigin === origin && fetchSite === 'same-origin') probe = 'trusted';
      observedLogoutProbes.push(probe);
      const trusted = probe === 'trusted';
      sendJson(
        response,
        trusted ? 200 : 403,
        trusted ? { data: { ok: true } } : { error: 'forbidden' },
      );
      return;
    }
    const probeKey = writeProbeKey(request.method, path);
    if (observedWrites.has(probeKey)) {
      const requestOrigin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      let probe;
      let statusCode;
      if (requestOrigin === undefined) {
        probe = 'missing';
        statusCode = breakMissingOriginGuard && path === '/api/v1/tasks' ? 401 : 403;
      } else if (requestOrigin === 'https://wrong-origin.invalid' && fetchSite === 'cross-site') {
        probe = 'wrong';
        statusCode = 403;
      } else if (requestOrigin === origin && fetchSite === 'same-origin') {
        probe = 'trusted';
        statusCode = 401;
      } else {
        probe = 'unexpected';
        statusCode = 400;
      }
      observedWrites.get(probeKey).push(probe);
      sendJson(response, statusCode, { error: statusCode === 401 ? 'unauthorized' : 'forbidden' });
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  });
  context.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(curlHome, { force: true, recursive: true });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;

  const result = await runAcceptance(origin, curlHome);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /浏览器写入 Origin-first 边界生效/);
  assert.match(result.stdout, /未提供 CB_SESSION_COOKIE_JAR/);
  assert.equal(result.stderr, '');
  assert.equal(observedAmbientCookie, false, 'ambient .curlrc Cookie must never reach a probe');
  for (const path of readPaths) {
    assert.equal(observedReads.get(path), 1, `${path} must receive exactly one read probe`);
  }
  for (const path of ssePaths) {
    assert.equal(
      observedSseProbes.get(`${path} anonymous`),
      2,
      `${path} needs two anonymous probes`,
    );
    assert.equal(observedSseProbes.get(`${path} bearer`), 1, `${path} needs one Bearer probe`);
    assert.equal(observedSseProbes.get(`${path} query`), 1, `${path} needs one query-token probe`);
  }

  for (const [method, path] of fullOriginWriteProbes) {
    const key = writeProbeKey(method, path);
    assert.deepEqual(
      observedWrites.get(key).toSorted(),
      ['missing', 'trusted', 'wrong'],
      `${key} must receive every anonymous Origin probe`,
    );
  }
  for (const [method, path] of trustedOnlyWriteProbes) {
    const key = writeProbeKey(method, path);
    assert.deepEqual(
      observedWrites.get(key),
      ['trusted'],
      `${key} must use one trusted anonymous probe to preserve its 10/min rate limit`,
    );
  }
  for (const path of publicAuthWritePaths) {
    assert.deepEqual(
      observedPublicAuthWrites.get(path).toSorted(),
      ['missing', 'trusted', 'wrong'],
      `POST ${path} must receive every public auth Origin probe`,
    );
  }
  assert.deepEqual(
    observedLogoutProbes.toSorted(),
    ['missing', 'trusted', 'wrong'],
    'logout must receive every anonymous Origin probe',
  );

  breakMissingOriginGuard = true;
  const rejected = await runAcceptance(origin, curlHome);
  assert.equal(rejected.signal, null);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /POST \/api\/v1\/tasks 缺少 Origin 未返回 403（实际 401）/);
  assert.equal(observedAmbientCookie, false, 'rejected run must also ignore ambient .curlrc');
});
