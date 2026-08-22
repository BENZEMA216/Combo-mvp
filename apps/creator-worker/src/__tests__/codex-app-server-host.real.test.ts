import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostStartTurnInputSchema } from '@cb/creator-agent-protocol/host';
import { afterEach, describe, expect, it } from 'vitest';

import { createBundledCodexHost } from '../codex-app-server-host.js';

const enabled = process.env.COMBO_REAL_CODEX_E2E === '1';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.runIf(enabled)('bundled Codex Host real gate', () => {
  it('runs one read-only turn through the reviewed ChatGPT bundle without changing the Project', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'combo-real-codex-host-'));
    temporaryDirectories.push(projectPath);
    const canary = `combo-r2f-${randomUUID()}`;
    await writeFile(join(projectPath, 'CANARY.txt'), `${canary}\n`, { mode: 0o600 });
    const before = await snapshotProject(projectPath);
    const host = createBundledCodexHost({
      projectPath,
      developerInstructions:
        'Operate read-only. Read CANARY.txt when asked, use no network, and return only the requested answer.',
      allowUnisolatedRead: true,
      rpcTimeoutMs: 30_000,
      processTerminationGraceMs: 2_000,
    });
    try {
      await host.start();
      const thread = await host.createThread();
      const handle = await host.startTurn(
        HostStartTurnInputSchema.parse({
          thread,
          messageId: randomUUID(),
          text: 'Read CANARY.txt and reply with exactly its single line, with no punctuation.',
          timeoutMs: 90_000,
        }),
      );
      const outcome = handle.verifyOutcome(await handle.outcome);
      expect(outcome.terminal.outcome).toBe('SUCCEEDED');
      if (outcome.result === null) throw new Error('Codex turn did not succeed.');
      expect(outcome.result.text).toBe(canary);
    } finally {
      await host.stop();
    }
    expect(await snapshotProject(projectPath)).toEqual(before);
  }, 120_000);
});

async function snapshotProject(projectPath: string): Promise<readonly string[]> {
  const names = (await readdir(projectPath)).sort();
  const entries = await Promise.all(
    names.map(async (name) => {
      const content = await readFile(join(projectPath, name));
      return `${name}:${createHash('sha256').update(content).digest('hex')}`;
    }),
  );
  return Object.freeze(entries);
}
