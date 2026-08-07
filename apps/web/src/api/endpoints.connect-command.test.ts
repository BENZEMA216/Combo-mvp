/// <reference types="node" />
// @vitest-environment node

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { connectCommand } from './endpoints.js';

function connectCommandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_PROXY: '127.0.0.1',
    no_proxy: '127.0.0.1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
  };
}

async function runConnectCommand(
  command: string,
  xtrace = false,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn('sh', xtrace ? ['-x', '-c', command] : ['-c', command], {
    env: connectCommandEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    const [status] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

async function serveConnectScript(script: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(script);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe('connectCommand', () => {
  it('buffers the complete history script without temporary files or removal commands', () => {
    const command = connectCommand('fixture-code', 'https://combo.example');

    expect(command.startsWith('(set +x;')).toBe(true);
    expect(command).toContain(
      "combo_connect_script=$(curl -fsSL -- 'https://combo.example/api/v1/connect/script?code=fixture-code')",
    );
    expect(command).toContain('case "$combo_connect_script" in *[![:space:]]*');
    expect(command).toContain(
      'printf \'%s\\n\' "$combo_connect_script" | env BASH_ENV=/dev/null ENV=/dev/null COMBO_SOURCE_SCOPE=history /bin/sh',
    );
    expect(command).not.toContain('<<');
    expect(command).not.toContain('mktemp');
    expect(command).not.toMatch(/\brm\b/);
    expect(command).not.toContain('trap');
    expect(command).not.toContain('unlink');
    expect(command).not.toContain('combo_connect_tmp');
  });

  it('returns non-zero when the history script download fails', () => {
    const command = connectCommand('fixture-code', 'http://127.0.0.1:1');
    const result = spawnSync('sh', ['-c', command], {
      encoding: 'utf8',
      timeout: 2_000,
      env: connectCommandEnv(),
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \n\t\n'],
  ])('does not execute an %s successful history script download', async (_label, body) => {
    const fixture = await serveConnectScript(body);
    try {
      const result = await runConnectCommand(connectCommand('fixture-code', fixture.origin));

      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Combo connect script response was empty or whitespace-only.',
      );
    } finally {
      await closeServer(fixture.server);
    }
  });

  it('executes a complete history script through stdin with the explicit scope', async () => {
    const fixture = await serveConnectScript(`#!/bin/sh
# downloaded-history-script-private-marker
test "\${COMBO_SOURCE_SCOPE:-}" = history || exit 71
test "\${BASH_ENV:-}" = /dev/null || exit 72
test "\${ENV:-}" = /dev/null || exit 73
test "$#" -eq 0 || exit 74
printf '%s\\n' combo-history-connect-executed
`);
    try {
      const result = await runConnectCommand(connectCommand('fixture-code', fixture.origin));

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('combo-history-connect-executed\n');
      expect(result.stdout + result.stderr).not.toContain(
        'downloaded-history-script-private-marker',
      );
    } finally {
      await closeServer(fixture.server);
    }
  });

  it('disables inherited xtrace before touching the history connect URL', async () => {
    const fixture = await serveConnectScript("printf '%s\\n' combo-history-xtrace-safe");
    try {
      const command = connectCommand('fixture-code', fixture.origin);
      const result = await runConnectCommand(command, true);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('combo-history-xtrace-safe\n');
      expect(result.stderr).toContain('+ set +x');
      expect(result.stderr).not.toContain(fixture.origin);
      expect(result.stderr).not.toContain('fixture-code');
    } finally {
      await closeServer(fixture.server);
    }
  });
});
