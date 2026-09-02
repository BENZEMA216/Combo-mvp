import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));

function fakeCurlSource() {
  return `#!/usr/bin/env bash
set -euo pipefail
args="$*"
url="\${!#}"
output=''
previous=''
for argument in "$@"; do
  if [[ "$previous" == -o ]]; then output="$argument"; fi
  previous="$argument"
done
if [[ "\${FAKE_CURL_MODE:-ready}" == unreachable ]]; then
  exit 7
fi
if [[ "$url" == "\${WEB_BASE}/" && "\${FAKE_WEB_READY:-1}" != 1 ]]; then
  exit 7
fi
if [[ "$args" == *"%{content_type}"* ]]; then
  printf 'application/json'
elif [[ "$args" == *"%{http_code}"* ]]; then
  if [[ "$url" == */api/v1/__not_exist__ ]]; then
    if [[ -n "$output" && "$output" != /dev/null ]]; then
      printf '{"userMessage":"not found"}' >"$output"
    fi
    printf '404'
  elif [[ "$url" == */api/v1/auth/logout ]]; then printf '200'; else printf '401'; fi
elif [[ "$url" == */health ]]; then
  printf '{"status":"ok"}'
elif [[ "$url" == */ready ]]; then
  printf '{"ready":true,"dependencies":[{"name":"db"},{"name":"redis_queue"},{"name":"redis_hot"},{"name":"minio"},{"name":"llm"}]}'
else
  printf '{}'
fi
`;
}

function runScript(script, extraEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'combo-smoke-truth-'));
  try {
    const curl = join(directory, 'curl');
    writeFileSync(curl, fakeCurlSource());
    chmodSync(curl, 0o700);
    return spawnSync('bash', [join(repo, 'scripts', script)], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        API_BASE: 'https://api.example.test',
        WEB_BASE: 'https://web.example.test',
        ...extraEnv,
      },
      encoding: 'utf8',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('acceptance smoke reports an unavailable stack as NOT_RUN with exit 2', () => {
  const result = runScript('acceptance-smoke.sh', { FAKE_CURL_MODE: 'unreachable' });
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /\[not-run\].*未执行验收/);
});

test('acceptance smoke cannot turn a missing authenticated session into PASS', () => {
  const result = runScript('acceptance-smoke.sh', { CB_SESSION_COOKIE_JAR: '' });
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /\[not-run\].*CB_SESSION_COOKIE_JAR/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /鉴权主链路与 SSE 验收通过/);
});

test('basic smoke cannot report all-pass when the Web boundary did not run', () => {
  const result = runScript('smoke.sh', { FAKE_WEB_READY: '0' });
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /\[not-run\].*Web/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /冒烟全部通过/);
});

test('basic smoke reports an unavailable API as NOT_RUN with exit 2', () => {
  const result = runScript('smoke.sh', { FAKE_CURL_MODE: 'unreachable' });
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /\[not-run\].*API.*冒烟未执行/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /冒烟全部通过/);
});
