import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { CodexAppServerClient, type HostDiagnosticEvent } from './app-server-client.js';
import { CreatorWorker } from './creator-worker.js';
import type { CodexHost, HostThread, HostTurnHandle } from './host-types.js';
import { CreatorWorkerHttpServer, type CreatorWorkerServerAddress } from './http-server.js';

const REAL_CODEX_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex';
const enabled = process.env.COMBO_REAL_CODEX_E2E === '1';
const realTurnTimeoutMs = Number(process.env.COMBO_REAL_CODEX_TURN_TIMEOUT_MS ?? 120_000);
const execFileAsync = promisify(execFile);

class ObservedHost implements CodexHost {
  readonly threads: HostThread[] = [];
  readonly messageIds: string[] = [];

  constructor(private readonly inner: CodexHost) {}

  start(): Promise<void> {
    return this.inner.start();
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }

  async createThread(): Promise<HostThread> {
    const thread = await this.inner.createThread();
    this.threads.push(thread);
    return thread;
  }

  startTurn(input: {
    thread: HostThread;
    messageId: string;
    text: string;
    timeoutMs: number;
  }): HostTurnHandle {
    this.messageIds.push(input.messageId);
    return this.inner.startTurn(input);
  }
}

describe.runIf(enabled)('Creator Worker with the bundled Codex Host', () => {
  it('does not load MCP configuration from the creator home or bound Project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'combo-real-config-isolation-'));
    const projectPath = join(root, 'project');
    const sourceHome = join(root, 'source-home');
    const sourceCodexHome = join(sourceHome, '.codex');
    const globalMarker = join(root, 'global-mcp-spawned');
    const projectMarker = join(root, 'project-mcp-spawned');
    await mkdir(join(projectPath, '.codex'), { recursive: true });
    await mkdir(sourceCodexHome, { recursive: true, mode: 0o700 });
    await writeFile(join(sourceCodexHome, 'auth.json'), '{}', { mode: 0o600 });
    await writeFile(
      join(sourceCodexHome, 'config.toml'),
      `[mcp_servers.global_audit]\ncommand = "/usr/bin/touch"\nargs = [${JSON.stringify(globalMarker)}]\n`,
      'utf8',
    );
    await writeFile(
      join(projectPath, '.codex', 'config.toml'),
      `[mcp_servers.project_audit]\ncommand = "/usr/bin/touch"\nargs = [${JSON.stringify(projectMarker)}]\n`,
      'utf8',
    );
    const appServer = new CodexAppServerClient({
      codexBinary: REAL_CODEX_BINARY,
      projectPath,
      allowUnisolatedRead: true,
      developerInstructions: 'No inference is requested in this configuration isolation probe.',
      environment: { HOME: sourceHome },
    });

    try {
      await appServer.start();
      await appServer.createThread();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await expect(access(globalMarker)).rejects.toBeDefined();
      await expect(access(projectMarker)).rejects.toBeDefined();
    } finally {
      await appServer.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps two loopback API conversations isolated and deduplicates a completed message', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'combo-real-creator-worker-'));
    const diagnostics: HostDiagnosticEvent[] = [];
    const version = await execFileAsync(REAL_CODEX_BINARY, ['--version']);
    expect(version.stdout.trim()).toMatch(/^codex-cli 0\.147\.0-alpha\.6\.5$/);
    await writeFile(
      join(projectPath, 'FACTS.txt'),
      'This sanitized test Project has the immutable fact FIXTURE-ORBIT-731.\n',
      'utf8',
    );
    const appServer = new CodexAppServerClient({
      codexBinary: REAL_CODEX_BINARY,
      projectPath,
      allowUnisolatedRead: true,
      allowLoopbackProxy: true,
      developerInstructions:
        'This is a sanitized read-only adapter test. Do not use tools except reading FACTS.txt. ' +
        'Never access paths outside this Project. Follow the requested short response format.',
      diagnosticSink: (event) => diagnostics.push(event),
    });
    const observed = new ObservedHost(appServer);
    const worker = new CreatorWorker({
      host: observed,
      maxConcurrentTurns: 1,
      turnTimeoutMs: realTurnTimeoutMs,
    });
    const http = new CreatorWorkerHttpServer({ worker, agentName: 'Sanitized real Host fixture' });

    try {
      await worker.start();
      const address = await http.start();
      const capability = new URL(address.experienceUrl).hash.slice('#access='.length);
      const page = await fetch(address.origin);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Sanitized real Host fixture');
      const conversationA = await createApiConversation(address, capability);
      const conversationB = await createApiConversation(address, capability);

      const a1Input = {
        conversationId: conversationA,
        messageId: 'real-a-1',
        text: 'Read FACTS.txt. Remember ALPHA-427 only inside this conversation. Reply with FIXTURE-ORBIT-731 and ALPHA-427.',
      };
      const a1 = await sendApiMessage(address, capability, a1Input);
      expect(a1.text).toContain('FIXTURE-ORBIT-731');
      expect(a1.text).toContain('ALPHA-427');

      const a1Replay = await sendApiMessage(address, capability, a1Input);
      expect(a1Replay).toEqual(a1);
      expect(observed.messageIds.filter((id) => id === 'real-a-1')).toHaveLength(1);

      const b1 = await sendApiMessage(address, capability, {
        conversationId: conversationB,
        messageId: 'real-b-1',
        text: 'Remember BRAVO-983 only inside this conversation. Reply with BRAVO-983 and do not invent another codeword.',
      });
      expect(b1.text).toContain('BRAVO-983');
      expect(b1.text).not.toContain('ALPHA-427');

      const a2 = await sendApiMessage(address, capability, {
        conversationId: conversationA,
        messageId: 'real-a-2',
        text: 'What private codeword did I ask you to remember in this conversation? Reply with only that codeword.',
      });
      expect(a2.text).toContain('ALPHA-427');
      expect(a2.text).not.toContain('BRAVO-983');

      const b2 = await sendApiMessage(address, capability, {
        conversationId: conversationB,
        messageId: 'real-b-2',
        text: 'What private codeword did I ask you to remember in this conversation? Reply with only that codeword.',
      });
      expect(b2.text).toContain('BRAVO-983');
      expect(b2.text).not.toContain('ALPHA-427');

      expect(observed.threads).toHaveLength(2);
      expect(new Set(observed.threads.map((thread) => thread.id)).size).toBe(2);
      expect(observed.messageIds).toEqual(['real-a-1', 'real-b-1', 'real-a-2', 'real-b-2']);
    } catch (error) {
      throw new Error(`Real Codex gate failed after ${JSON.stringify(diagnostics)}`, {
        cause: error,
      });
    } finally {
      await http.stop();
      await worker.stop();
      await rm(projectPath, { recursive: true, force: true });
    }
  }, 300_000);
});

function apiHeaders(
  address: CreatorWorkerServerAddress,
  capability: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${capability}`,
    'Content-Type': 'application/json',
    Origin: address.origin,
    'X-Combo-Creator-Worker': '1',
  };
}

async function createApiConversation(
  address: CreatorWorkerServerAddress,
  capability: string,
): Promise<string> {
  const response = await fetch(`${address.origin}/api/conversations`, {
    method: 'POST',
    headers: apiHeaders(address, capability),
    body: '{}',
  });
  expect(response.status).toBe(201);
  const payload = (await response.json()) as {
    ok: true;
    data: { conversationId: string };
  };
  expect(payload.ok).toBe(true);
  return payload.data.conversationId;
}

async function sendApiMessage(
  address: CreatorWorkerServerAddress,
  capability: string,
  input: { conversationId: string; messageId: string; text: string },
): Promise<{ text: string }> {
  const response = await fetch(
    `${address.origin}/api/conversations/${input.conversationId}/messages`,
    {
      method: 'POST',
      headers: apiHeaders(address, capability),
      body: JSON.stringify({ messageId: input.messageId, text: input.text }),
    },
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { ok: true; data: { text: string } };
  expect(payload.ok).toBe(true);
  return payload.data;
}
