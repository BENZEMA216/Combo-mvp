import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { parseCreatorAgentContextDraft } from '@cb/creator-agent-protocol/agent-context';
import {
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  parseCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import { parseCreatorAgentPackageDraftSnapshotV2 } from '@cb/creator-agent-protocol/agent-package-draft';
import { preProcessFile } from 'typescript';
import { describe, expect, it } from 'vitest';

import { compileCreatorAgentPackageFromContext } from '../agent-package-context-compiler.js';
import { compileCreatorAgentPackageDraftV2 } from '../agent-package-compiler.js';
import { loadCreatorAgentPackage } from '../infrastructure/agent-package-loader.js';

function input() {
  return {
    protocol: 'combo.agent-context-request/1',
    request: '把刚才的核验方法做成 Agent。',
    content: {
      name: '证据核验员',
      description: '将依据和推断分开。',
      instructions: '先列依据，然后检查假设，最后给出结论。',
      starterPrompts: ['核验这个方案。'],
      outputDescription: '输出结论与依据。',
      coverageSummary: '本轮可用上下文包含方法说明；更早的内容可能缺失。',
    },
  };
}
const bundle = resolve(import.meta.dirname, '../../dist/agent-package-context-compiler.mjs');

describe('available-context Package compiler', () => {
  it('compiles deterministic exact files accepted by the formal loader without creating a Session', () => {
    const request = JSON.stringify(input());
    const result = compileCreatorAgentPackageFromContext(request);
    expect(compileCreatorAgentPackageFromContext(request)).toEqual(result);
    expect(result.status).toBe('compiled');
    expect(result.runtime).toEqual({ status: 'not_run' });
    expect(parseCreatorAgentContextDraft(result.draftText)).toEqual(result.draft);
    const manifest = parseCreatorAgentPackageManifest(result.manifestText);
    expect(digestCreatorAgentPackage(manifest)).toBe(result.packageDigest);
    expect(result.files.map((file) => file.path)).toEqual([
      'agent.json',
      'AGENT.md',
      'skills/extracted-method/SKILL.md',
      'skills/extracted-method/provenance.json',
    ]);
    for (const file of result.files) {
      const bytes = Buffer.from(file.content, 'utf8');
      expect(file.bytes).toBe(bytes.byteLength);
      expect(file.sha256).toBe(digestCreatorAgentPackageFile(bytes));
    }
    expect(result.files.map(({ content }) => content).join('\n')).not.toContain(
      input().content.coverageSummary,
    );
    expect(result.files.map(({ content }) => content).join('\n')).not.toContain(input().request);
    const agentText = result.files.find(({ path }) => path === 'AGENT.md')!.content;
    expect(agentText).toContain('bundled extracted-method Skill');
    expect(agentText).toContain(
      'that task may still retain its earlier context; do not claim isolation',
    );
    expect(agentText).not.toContain('The creator context is not mounted');
    expect(agentText).not.toContain('installed extracted-method Skill');
    const root = mkdtempSync(join(tmpdir(), 'combo-context-compiler-'));
    try {
      for (const file of result.files) {
        const path = join(root, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      }
      const loaded = loadCreatorAgentPackage(root);
      try {
        expect(loaded.packageDigest).toBe(result.packageDigest);
      } finally {
        loaded.release();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores package bytes after A-B-A and keeps private Draft metadata out of package addressing', () => {
    const first = compileCreatorAgentPackageFromContext(JSON.stringify(input()));
    const changed = input();
    changed.content.instructions = '改用另一套方法进行核验。';
    expect(compileCreatorAgentPackageFromContext(JSON.stringify(changed)).packageDigest).not.toBe(
      first.packageDigest,
    );
    expect(compileCreatorAgentPackageFromContext(JSON.stringify(input())).files).toEqual(
      first.files,
    );
    const other = input();
    other.request = '请整理核验方法。';
    other.content.coverageSummary = '另一次上下文整理。';
    const second = compileCreatorAgentPackageFromContext(JSON.stringify(other));
    expect(second.draftFingerprint).not.toBe(first.draftFingerprint);
    expect(second.packageDigest).toBe(first.packageDigest);
  });

  it.each([
    'request',
    'name',
    'description',
    'instructions',
    'starterPrompts',
    'outputDescription',
    'coverageSummary',
  ] as const)('rejects credential material in %s without leaking it', (field) => {
    const raw = input();
    const secret = `sk-${'a'.repeat(32)}`;
    if (field === 'request') raw.request = secret;
    else if (field === 'starterPrompts') raw.content.starterPrompts = [secret];
    else raw.content[field] = secret;
    let failure: unknown;
    try {
      compileCreatorAgentPackageFromContext(JSON.stringify(raw));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'AGENT_CONTEXT_UNSAFE' });
    expect(String(failure)).not.toContain(secret);
    expect(failure).not.toHaveProperty('cause');
  });

  it('does not pass off unverified context as a V2 attested Draft', () => {
    const result = compileCreatorAgentPackageFromContext(JSON.stringify(input()));
    expect(() => compileCreatorAgentPackageDraftV2(result.draftText)).toThrow();
    expect(() => parseCreatorAgentPackageDraftSnapshotV2(result.draftText)).toThrow();
    const forged = {
      ...input(),
      source: {
        kind: 'current_conversation',
        sourceBoundary: 'desktop_attested_active_current_task',
      },
    };
    expect(() => compileCreatorAgentPackageFromContext(JSON.stringify(forged))).toThrow();
    let calls = 0;
    expect(() =>
      compileCreatorAgentPackageFromContext({
        get content() {
          calls++;
          return input().content;
        },
      }),
    ).toThrow();
    expect(calls).toBe(0);
  });

  it('runs the standalone stdin bundle without dependency, credential, or source-reader configuration', () => {
    expect(existsSync(bundle)).toBe(true);
    const result = spawnSync(process.execPath, [bundle], {
      input: JSON.stringify(input()),
      encoding: 'utf8',
      env: { NODE_PATH: '' },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(
      compileCreatorAgentPackageFromContext(JSON.stringify(input())),
    );
    const loaded = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const m=await import(${JSON.stringify(bundle)}); console.log(typeof m.compileCreatorAgentPackageFromContext);`,
      ],
      { encoding: 'utf8', env: { NODE_PATH: '' }, timeout: 10_000 },
    );
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toBe('function\n');
    expect(loaded.stderr).toBe('');
  });

  it.each([
    '{}',
    'x'.repeat(65_537),
    '界'.repeat(22_000),
    '{"protocol":"combo.agent-package-draft/2"}',
    JSON.stringify({ ...input(), rawTranscript: 'PRIVATE_CANARY' }),
  ])('returns one safe error record for invalid stdin', (text) => {
    const result = spawnSync(process.execPath, [bundle], {
      input: text,
      encoding: 'utf8',
      env: { NODE_PATH: '' },
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      protocol: 'combo.agent-context-error/1',
      status: 'error',
      code: 'AGENT_CONTEXT_INPUT_INVALID',
    });
    expect(result.stdout).not.toContain('PRIVATE_CANARY');
  });

  it('keeps the pure compiler dependency closure free of file readers, network, Host, and execution', () => {
    const visited = new Set<string>();
    function scan(path: string): void {
      if (visited.has(path)) return;
      visited.add(path);
      for (const { fileName } of preProcessFile(readFileSync(path, 'utf8'), true, true)
        .importedFiles) {
        expect(fileName).not.toMatch(
          /node:(?:fs|child_process|net|http|https|tls|worker_threads)|sqlite|codex|session|project-context-index|publisher|loader|broker/u,
        );
        if (fileName.startsWith('.'))
          scan(resolve(dirname(path), fileName.replace(/\.js$/u, '.ts')));
        else if (fileName.startsWith('@cb/creator-agent-protocol/'))
          scan(
            resolve(
              import.meta.dirname,
              '../../../../packages/creator-agent-protocol/src',
              `${fileName.split('/').at(-1)}.ts`,
            ),
          );
      }
    }
    scan(resolve(import.meta.dirname, '../agent-package-context-compiler.ts'));
  });

  it('rejects malformed UTF-8 and positional source arguments with a safe single error', () => {
    for (const [args, text] of [
      [[bundle], Buffer.from([0xc3, 0x28])],
      [[bundle, 'PRIVATE_SOURCE_PATH'], Buffer.from(JSON.stringify(input()))],
    ] as const) {
      const result = spawnSync(process.execPath, [...args], {
        input: text,
        encoding: 'utf8',
        env: { NODE_PATH: '' },
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        protocol: 'combo.agent-context-error/1',
        code: 'AGENT_CONTEXT_INPUT_INVALID',
      });
      expect(result.stdout).not.toContain('PRIVATE_SOURCE_PATH');
    }
  });
});
