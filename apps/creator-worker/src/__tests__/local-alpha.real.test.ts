import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { runCreatorWorkerLocalAlpha } from '../index.js';

const enabled = process.env.COMBO_REAL_CODEX_E2E === '1';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.runIf(enabled)('Creator Worker local Alpha real gate', () => {
  it('runs one bundled Codex answer through Broker, both SQLite stores, and the R2E Runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'combo-real-local-alpha-'));
    temporaryDirectories.push(root);
    const projectPath = join(root, 'project');
    const stateDirectory = join(root, 'state');
    await mkdir(projectPath, { mode: 0o700 });
    const answer = `combo-local-alpha-${randomUUID()}`;
    const promptMarker = `prompt-marker-${randomUUID()}`;
    await writeFile(join(projectPath, 'CANARY.txt'), `${answer}\n`, { mode: 0o600 });
    const before = await snapshotProject(projectPath);

    const result = await runCreatorWorkerLocalAlpha({
      projectPath,
      stateDirectory,
      prompt: `${promptMarker}. Read CANARY.txt and reply with exactly its single line, with no punctuation.`,
      allowUnisolatedRead: true,
      turnTimeoutMs: 120_000,
    });

    expect(result.text).toBe(answer);
    expect(await snapshotProject(projectPath)).toEqual(before);
    const transport = new DatabaseSync(join(stateDirectory, 'transport.sqlite'), {
      readOnly: true,
    });
    const deliveries = transport
      .prepare(
        `SELECT state FROM transport_logical_outbox
         WHERE body_type='worker.message' ORDER BY logical_sequence`,
      )
      .all() as Array<{ state: string }>;
    transport.close();
    expect(deliveries).toEqual([{ state: 'ACKED' }, { state: 'ACKED' }]);
    const durableBytes = await readDurableBytes(stateDirectory);
    expect(durableBytes).not.toContain(promptMarker);
    expect(durableBytes).not.toContain(answer);
  }, 180_000);
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

async function readDurableBytes(stateDirectory: string): Promise<string> {
  const names = await readdir(stateDirectory);
  const contents = await Promise.all(
    names
      .filter((name) => name.includes('.sqlite'))
      .map((name) => readFile(join(stateDirectory, name))),
  );
  return Buffer.concat(contents).toString('utf8');
}
