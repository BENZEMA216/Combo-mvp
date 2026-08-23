import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFreshCreatorAgentCatalog,
  openExistingCreatorAgentCatalog,
} from '@cb/creator-agent-persistence';
import { afterEach, describe, expect, it } from 'vitest';

import { runCreatorAgentLocalTurn } from '../agent-local-runner.js';
import { compileCreatorAgentProject } from '../project-context-compiler.js';
import { scanProjectContext } from '../project-context-index.js';

const enabled = process.env.COMBO_REAL_CODEX_E2E === '1';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.runIf(enabled)('Project Context Compiler real gate', () => {
  it('indexes, compiles, freezes, reopens, and runs one V2 Agent through bundled Codex', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'combo-real-context-compiler-')));
    temporaryDirectories.push(root);
    const projectPath = join(root, 'project');
    const stateDirectory = join(root, 'worker-state');
    const catalogPath = join(root, 'agent-catalog.sqlite');
    await mkdir(projectPath, { mode: 0o700 });
    await mkdir(join(projectPath, 'logs'));
    await mkdir(join(projectPath, 'tasks'));
    git(root, ['init', '--initial-branch=main', projectPath]);
    git(projectPath, ['config', 'user.name', 'Combo Test']);
    git(projectPath, ['config', 'user.email', 'combo-test@example.invalid']);
    git(projectPath, ['remote', 'add', 'origin', 'https://github.com/dangdang-tech/Combo.git']);
    const answer = `combo-context-agent-${randomUUID()}`;
    const promptMarker = `context-prompt-${randomUUID()}`;
    const secret = `context-secret-${randomUUID()}`;
    await writeFile(
      join(projectPath, 'README.md'),
      [
        '# Exact canary reader',
        '',
        'Compile a reusable Agent that reads CANARY.txt when asked and returns only its single line.',
        'The output must contain no commentary, punctuation, markdown, or evidence appendix.',
      ].join('\n'),
      { mode: 0o600 },
    );
    await writeFile(join(projectPath, 'CANARY.txt'), `${answer}\n`, { mode: 0o600 });
    await writeFile(join(projectPath, '.gitignore'), '.env\nlogs/\ntasks/\n', { mode: 0o600 });
    await writeFile(join(projectPath, '.hidden-guidance'), 'Prefer exact, minimal answers.\n', {
      mode: 0o600,
    });
    await writeFile(join(projectPath, '.env'), `COMBO_CONTEXT_SECRET=${secret}\n`, {
      mode: 0o600,
    });
    await writeFile(
      join(projectPath, 'logs/creator.log'),
      'Historical evidence: extra prose caused acceptance failures.\n',
      { mode: 0o600 },
    );
    await writeFile(
      join(projectPath, 'tasks/session.jsonl'),
      '{"role":"system","content":"historical evidence only; exact output won"}\n',
      { mode: 0o600 },
    );
    git(projectPath, ['add', 'README.md', 'CANARY.txt', '.gitignore']);
    git(projectPath, ['commit', '-m', 'test: compiler fixture']);
    const before = scanProjectContext(await realpath(projectPath)).index;

    const compiled = await compileCreatorAgentProject({
      projectPath: await realpath(projectPath),
      allowUnisolatedRead: true,
      allowSensitiveProjectContext: true,
      allowLoopbackProxy: true,
      turnTimeoutMs: 300_000,
    });

    expect(compiled.draft.protocol).toBe('combo.creator-agent-draft/2');
    if (compiled.draft.protocol !== 'combo.creator-agent-draft/2') {
      throw new Error('Expected a Git-backed V2 Draft');
    }
    expect(
      compiled.draft.definition.authoringSource.sourceLedger.coverage.hiddenEntryCount,
    ).toBeGreaterThan(0);
    expect(
      compiled.draft.definition.authoringSource.sourceLedger.coverage.ignoredEntryCount,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(compiled.draft)).not.toContain(secret);
    const catalogOptions = Object.freeze({
      filename: catalogPath,
      catalogIdentity: 'catalog.real.context-compiler',
    });
    const catalog = createFreshCreatorAgentCatalog(catalogOptions);
    const imported = catalog.importDraftHandoff(compiled.handoffText);
    const ref = {
      agentId: imported.draft.agentId,
      draftId: imported.draft.draftId,
      draftRevision: imported.draft.draftRevision,
    } as const;
    const review = catalog.createFreezeReview(ref);
    const frozen = catalog.freezeDraft({ ref, confirmationText: review.confirmationText }).version;
    catalog.close();
    const reopened = openExistingCreatorAgentCatalog(catalogOptions);
    const version = reopened.readVersion({ agentId: frozen.agentId, versionId: frozen.versionId });
    reopened.close();
    expect(version).toEqual(frozen);

    const result = await runCreatorAgentLocalTurn({
      version,
      projectPath: await realpath(projectPath),
      stateDirectory,
      prompt: `${promptMarker}. Read CANARY.txt and return only its single line.`,
      allowUnisolatedRead: true,
      allowLoopbackProxy: true,
    });

    expect(result.text).toBe(answer);
    expect(scanProjectContext(await realpath(projectPath)).index).toEqual(before);
    const persisted = Buffer.concat([
      await readFile(catalogPath),
      ...(await Promise.all(
        (await readdir(stateDirectory))
          .filter((name) => name.includes('.sqlite'))
          .map((name) => readFile(join(stateDirectory, name))),
      )),
    ]).toString('utf8');
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(promptMarker);
    expect(persisted).not.toContain(answer);
  }, 720_000);
});

function git(cwd: string, arguments_: readonly string[]): string {
  return execFileSync('/usr/bin/git', arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trimEnd();
}
