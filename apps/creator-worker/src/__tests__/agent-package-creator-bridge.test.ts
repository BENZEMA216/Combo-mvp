import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_PROTOCOL,
  CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_MAX_BYTES,
  CREATOR_AGENT_PACKAGE_CREATOR_GUIDE,
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
  CREATOR_AGENT_PACKAGE_CREATOR_SOURCE_BINDING,
  CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL,
  createCreatorAgentPackageCreatorBootstrapHandoff,
  createCreatorAgentPackageDraftSnapshot,
  serializeCreatorAgentPackageCreatorBootstrapHandoff,
  type CreatorAgentPackageCreatorBootstrapHandoff,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { describe, expect, it, vi } from 'vitest';

import { CreatorAgentProjectCompilerError } from '../authoring/project-behavior-extractor.js';
import { createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies } from '../application/agent-package-creator-bridge.js';

const ROOT_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SOURCE_DIGEST = `sha256:${'b'.repeat(64)}` as const;

describe('Agent Package Creator Bridge', () => {
  it('binds one validated handoff to the Host current Project and returns its exact Draft', async () => {
    const handoff = creatorHandoff();
    const draft = creatorDraft(handoff);
    const resolveHostBoundCurrentProject = vi.fn(() => '/host-bound-project');
    const createDraft = vi.fn(async () =>
      Object.freeze({
        readDraft: () => draft,
        revise: vi.fn(),
        compile: vi.fn(),
      }),
    );
    const stages: string[] = [];

    const result = await createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
      handoff,
      { progressSink: ({ stage }) => stages.push(stage) },
      { resolveHostBoundCurrentProject, createDraft },
    );

    expect(result).toEqual(draft);
    expect(resolveHostBoundCurrentProject).toHaveBeenCalledTimes(1);
    expect(createDraft).toHaveBeenCalledWith({
      request: handoff.creatorRequest,
      currentProjectPath: '/host-bound-project',
      allowUnisolatedRead: true,
      allowSensitiveProjectContext: true,
      allowLoopbackProxy: true,
    });
    expect(stages).toEqual(['HANDOFF', 'BIND_CURRENT_PROJECT', 'EXTRACT_DRAFT', 'VALIDATE_DRAFT']);
  });

  it('rejects invalid handoffs before resolving or reading any Project', async () => {
    const resolveHostBoundCurrentProject = vi.fn(() => '/should-not-run');
    const createDraft = vi.fn();

    await expect(
      createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
        { ...creatorHandoff(), projectPath: '/private/source' },
        {},
        { resolveHostBoundCurrentProject, createDraft },
      ),
    ).rejects.toMatchObject({ code: 'HANDOFF_INVALID', stage: 'HANDOFF' });
    expect(resolveHostBoundCurrentProject).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('rejects unavailable Host binding and a Draft whose creator request was swapped', async () => {
    const handoff = creatorHandoff();
    await expect(
      createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
        handoff,
        {},
        {
          resolveHostBoundCurrentProject: () => {
            throw new Error('/private/source must stay internal');
          },
          createDraft: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({
      code: 'CURRENT_PROJECT_UNAVAILABLE',
      stage: 'BIND_CURRENT_PROJECT',
      message: 'Codex Host 当前 Project 无法被可靠绑定。',
    });

    const otherHandoff = createCreatorAgentPackageCreatorBootstrapHandoff({
      ...handoff,
      creatorRequest: {
        ...handoff.creatorRequest,
        request: '请把当前目录的回滚流程提炼成一个 Agent。',
      },
    });
    await expect(
      createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
        handoff,
        {},
        {
          resolveHostBoundCurrentProject: () => '/host-bound-project',
          createDraft: async () =>
            Object.freeze({
              readDraft: () => creatorDraft(otherHandoff),
              revise: vi.fn(),
              compile: vi.fn(),
            }),
        },
      ),
    ).rejects.toMatchObject({ code: 'DRAFT_INVALID', stage: 'VALIDATE_DRAFT' });
  });

  it('maps cancellation to one bounded public error before Project access', async () => {
    const cancellation = new AbortController();
    cancellation.abort(new DOMException('private abort detail', 'AbortError'));
    const resolveHostBoundCurrentProject = vi.fn(() => '/should-not-run');

    await expect(
      createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
        creatorHandoff(),
        { signal: cancellation.signal },
        { resolveHostBoundCurrentProject, createDraft: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED', message: 'Agent Package Draft 创作已取消。' });
    expect(resolveHostBoundCurrentProject).not.toHaveBeenCalled();
  });

  it.each([
    ['PROJECT_CONTEXT_SCAN_LIMIT', 'SOURCE_LIMIT'],
    ['PROJECT_CONTEXT_CHANGED', 'SOURCE_CHANGED'],
  ] as const)('maps %s to the actionable bridge code %s', async (compilerCode, bridgeCode) => {
    await expect(
      createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
        creatorHandoff(),
        {},
        {
          resolveHostBoundCurrentProject: () => '/host-bound-project',
          createDraft: async () => {
            throw new CreatorAgentProjectCompilerError(compilerCode, 'private compiler detail');
          },
        },
      ),
    ).rejects.toMatchObject({ code: bridgeCode, stage: 'EXTRACT_DRAFT' });
  });

  it('maps a scanner path rejection back to the Host Project binding stage', async () => {
    await expect(
      createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
        creatorHandoff(),
        {},
        {
          resolveHostBoundCurrentProject: () => '/host-bound-project',
          createDraft: async () => {
            throw new CreatorAgentProjectCompilerError(
              'PROJECT_CONTEXT_PATH_INVALID',
              'private path detail',
            );
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'CURRENT_PROJECT_UNAVAILABLE',
      stage: 'BIND_CURRENT_PROJECT',
    });
  });

  it('does not hide incomplete Host cleanup behind a signal exit', async () => {
    const cancellation = new AbortController();
    await expect(
      createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
        creatorHandoff(),
        { signal: cancellation.signal },
        {
          resolveHostBoundCurrentProject: () => '/host-bound-project',
          createDraft: async () => {
            cancellation.abort(new DOMException('private abort detail', 'AbortError'));
            throw new CreatorAgentProjectCompilerError(
              'PROJECT_COMPILER_STOP_INCOMPLETE',
              'private cleanup detail',
            );
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE', stage: 'EXTRACT_DRAFT' });
  });

  it('ships one standalone executable that accepts no Project path argument', () => {
    const root = mkdtempSync(join(tmpdir(), 'combo-creator-bridge-artifact-'));
    try {
      const bridge = join(root, 'creator-bridge.mjs');
      copyFileSync(join(process.cwd(), 'dist', 'agent-package-creator-bridge.mjs'), bridge);
      const help = spawnSync(process.execPath, [bridge, '--help'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '' },
      });
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain('accepts no Project path');

      const imported = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `await import(${JSON.stringify(pathToFileURL(bridge).href)})`,
        ],
        { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } },
      );
      expect(imported.status, imported.stderr).toBe(0);
      expect(imported.stdout).toBe('');

      const unbound = spawnSync(process.execPath, [bridge], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '' },
        input: `${serializeCreatorAgentPackageCreatorBootstrapHandoff(creatorHandoff())}\n`,
      });
      expect(unbound.status).toBe(1);
      expect(unbound.stdout).toBe('');
      expect(unbound.stderr).toContain('"code":"CURRENT_PROJECT_UNAVAILABLE"');
      expect(unbound.stderr).not.toContain(root);

      const privatePath = '/Users/alice/private-project';
      const rejected = spawnSync(process.execPath, [bridge, privatePath], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '' },
      });
      expect(rejected.status).toBe(2);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toContain('"code":"HANDOFF_INVALID"');
      expect(rejected.stderr).not.toContain(privatePath);
      expect(rejected.stderr).not.toMatch(/stack|cause/u);

      const malformed = spawnSync(process.execPath, [bridge], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '' },
        input: Buffer.from([0xff]),
      });
      expect(malformed.status).toBe(2);
      expect(malformed.stdout).toBe('');
      expect(malformed.stderr).toContain('Creator handoff 必须使用有效的 UTF-8。');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits after oversized input even when the writer keeps its pipe open', async () => {
    const bridge = join(process.cwd(), 'dist', 'agent-package-creator-bridge.mjs');
    const child = spawn(process.execPath, [bridge], {
      env: { ...process.env, NODE_PATH: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    child.stdin.on('error', () => undefined);
    child.stdin.write(
      Buffer.alloc(CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_MAX_BYTES + 3, 0x78),
    );

    const code = await new Promise<number | null>((resolveCode, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Creator Bridge did not exit after oversized input.'));
      }, 2_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (exitCode) => {
        clearTimeout(timeout);
        resolveCode(exitCode);
      });
    });

    expect(code).toBe(2);
    expect(Buffer.concat(stdout).toString('utf8')).toBe('');
    const errorLines = Buffer.concat(stderr).toString('utf8').trim().split('\n');
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('"code":"HANDOFF_INVALID"');
  });
});

function creatorHandoff(): CreatorAgentPackageCreatorBootstrapHandoff {
  return createCreatorAgentPackageCreatorBootstrapHandoff({
    protocol: CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_PROTOCOL,
    creatorGuide: CREATOR_AGENT_PACKAGE_CREATOR_GUIDE,
    sourceBinding: CREATOR_AGENT_PACKAGE_CREATOR_SOURCE_BINDING,
    creatorRequest: {
      protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
      intent: 'create_agent_package_from_current_project',
      request: '请阅读 combo.workflow.md，把当前目录的发布流程提炼成一个 Agent。',
    },
  });
}

function creatorDraft(handoff: CreatorAgentPackageCreatorBootstrapHandoff) {
  return createCreatorAgentPackageDraftSnapshot({
    protocol: CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL,
    draftId: `draft.agent-package.${'1'.repeat(32)}`,
    revision: 1,
    parentDraftFingerprint: null,
    creatorRequest: handoff.creatorRequest,
    source: {
      kind: 'current_project',
      contextRootDigest: ROOT_DIGEST,
      indexedEntryCount: 1,
      indexedFileCount: 1,
      uniqueIndexedByteCount: 10,
      coverageSummary: '发布流程定义了可以复用的验收方法。',
      citedSources: [{ path: 'combo.workflow.md', digest: SOURCE_DIGEST }],
    },
    content: {
      name: '发布验收 Agent',
      description: '根据项目证据执行发布验收。',
      instructions: '先核对版本身份，再核对质量证据，最后给出结论。',
      starterPrompts: ['检查这次发布是否可以上线。'],
      outputDescription: '返回结论、阻断项和证据。',
    },
  });
}
