import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackageFile,
  serializeCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import { afterEach, describe, expect, it } from 'vitest';

import { startCreatorAgentPackageSession } from '../agent-package-session.js';

const enabled = process.env.COMBO_REAL_CODEX_E2E === '1';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.runIf(enabled)('Agent Package native Codex session real gate', () => {
  it('uses one package Skill and one Codex thread across two real turns', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'combo-real-agent-package-')));
    temporaryDirectories.push(root);
    const packagePath = join(root, 'package');
    const projectPath = join(root, 'project');
    await mkdir(join(packagePath, 'skills', 'package-canary'), { recursive: true, mode: 0o700 });
    await mkdir(projectPath, { mode: 0o700 });

    const projectCanary = `project-${randomUUID()}`;
    const skillMarker = `skill-${randomUUID()}`;
    const conversationToken = `conversation-${randomUUID()}`;
    await writeFile(join(projectPath, 'CANARY.txt'), `${projectCanary}\n`, { mode: 0o600 });
    const agent = Buffer.from(
      [
        '# Identity',
        'You are the installed Combo Agent Package canary.',
        '',
        '# Operating Loop',
        'For every user request, use the native `package-canary` Skill before answering.',
        '',
        '# Verification and Definition of Done',
        'Return exactly the format required by that Skill, without commentary.',
      ].join('\n'),
    );
    const skill = Buffer.from(
      [
        '---',
        'name: package-canary',
        'description: Use for every request in this installed Agent Package.',
        '---',
        '',
        '# Package canary protocol',
        `The package-only marker is ${skillMarker}.`,
        'For phase one, read CANARY.txt with a read-only Project tool and return exactly:',
        `${skillMarker}|<the exact CANARY.txt line>`,
        'For phase two, return exactly `MEMORY|<the conversation token from the prior user message>`.',
        'Do not add Markdown, punctuation, explanation, or whitespace.',
      ].join('\n'),
    );
    await writeFile(join(packagePath, 'AGENT.md'), agent, { mode: 0o600 });
    await writeFile(join(packagePath, 'skills', 'package-canary', 'SKILL.md'), skill, {
      mode: 0o600,
    });
    const manifest = createCreatorAgentPackageManifest({
      protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
      name: 'Package Canary',
      description: 'Proves native Skill activation and same-thread memory.',
      instructions: 'AGENT.md',
      skills: ['skills/package-canary/SKILL.md'],
      files: [resource('AGENT.md', agent), resource('skills/package-canary/SKILL.md', skill)],
    });
    await writeFile(
      join(packagePath, 'agent.json'),
      serializeCreatorAgentPackageManifest(manifest),
      { mode: 0o600 },
    );
    const beforeProject = await snapshotDirectory(projectPath);
    const beforePackage = await snapshotDirectory(packagePath);

    const session = await startCreatorAgentPackageSession({
      packagePath,
      projectPath,
      allowUnisolatedRead: true,
      allowLoopbackProxy: true,
      turnTimeoutMs: 180_000,
    });
    try {
      const first = await session.send(
        `Phase one. My conversation token is ${conversationToken}. Follow the installed package.`,
      );
      expect(first).toBe(`${skillMarker}|${projectCanary}`);
      const second = await session.send(
        'Phase two. Return the prior conversation token using the installed package format.',
      );
      expect(second).toBe(`MEMORY|${conversationToken}`);
    } finally {
      await session.close();
    }

    expect(await snapshotDirectory(projectPath)).toEqual(beforeProject);
    expect(await snapshotDirectory(packagePath)).toEqual(beforePackage);
    expect((await recursiveNames(root)).some((path) => path.endsWith('.sqlite'))).toBe(false);
  }, 420_000);
});

function resource(path: string, bytes: Uint8Array) {
  return {
    path,
    byteLength: bytes.byteLength,
    digest: digestCreatorAgentPackageFile(bytes),
  };
}

async function snapshotDirectory(root: string): Promise<readonly string[]> {
  const names = await recursiveNames(root);
  const entries = await Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(root, ...name.split('/')));
      return `${name}:${createHash('sha256').update(bytes).digest('hex')}`;
    }),
  );
  return Object.freeze(entries);
}

async function recursiveNames(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    const directory = parent ? join(root, ...parent.split('/')) : root;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files.sort();
}
