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

import {
  CreatorAgentProjectCompilerError,
  type CreatorAgentProjectCompilerErrorCode,
} from '../authoring/project-behavior-extractor.js';
import { CreatorAgentPackageCreatorError } from '../application/agent-package-creator.js';
import { createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies } from '../application/agent-package-creator-bridge.js';
import {
  CREATOR_AGENT_PACKAGE_CREATOR_BRIDGE_ERROR_PROTOCOL,
  createCreatorAgentPackageCreatorBridgeErrorEnvelope,
} from '../agent-package-creator-bridge.js';

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
    ['PROJECT_CONTEXT_PATH_INVALID', 'CURRENT_PROJECT_UNAVAILABLE', 'BIND_CURRENT_PROJECT'],
    ['PROJECT_CONTEXT_SCAN_FAILED', 'SOURCE_READ_FAILED', 'EXTRACT_DRAFT'],
    ['PROJECT_CONTEXT_SCAN_LIMIT', 'SOURCE_LIMIT', 'EXTRACT_DRAFT'],
    ['PROJECT_CONTEXT_CHANGED', 'SOURCE_CHANGED', 'EXTRACT_DRAFT'],
    ['PROJECT_COMPILER_CONFIGURATION_INVALID', 'INTERNAL', 'EXTRACT_DRAFT'],
    ['PROJECT_CONTEXT_AUTHORIZATION_REQUIRED', 'INTERNAL', 'EXTRACT_DRAFT'],
    ['PROJECT_COMPILER_GIT_INVALID', 'INTERNAL', 'EXTRACT_DRAFT'],
    ['PROJECT_COMPILER_HOST_FAILED', 'HOST_FAILED', 'EXTRACT_DRAFT'],
    ['PROJECT_COMPILER_OUTPUT_INVALID', 'OUTPUT_INVALID', 'EXTRACT_DRAFT'],
    ['PROJECT_COMPILER_SAFETY_REJECTED', 'OUTPUT_REJECTED', 'EXTRACT_DRAFT'],
    ['PROJECT_COMPILER_RUNTIME_UNSUPPORTED', 'INTERNAL', 'EXTRACT_DRAFT'],
    ['PROJECT_COMPILER_SECRET_OUTPUT', 'OUTPUT_REJECTED', 'EXTRACT_DRAFT'],
    ['PROJECT_COMPILER_STOP_INCOMPLETE', 'CLEANUP_INCOMPLETE', 'EXTRACT_DRAFT'],
  ] satisfies readonly (readonly [CreatorAgentProjectCompilerErrorCode, string, string])[])(
    'maps %s to the stable bridge code %s',
    async (compilerCode, bridgeCode, stage) => {
      const privateDetail = `/private/project/${compilerCode}/secret-value`;
      let failure: unknown;

      try {
        await createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
          creatorHandoff(),
          {},
          {
            resolveHostBoundCurrentProject: () => '/host-bound-project',
            createDraft: async () => {
              throw new CreatorAgentProjectCompilerError(compilerCode, privateDetail, {
                cause: new Error(`private cause for ${compilerCode}`),
              });
            },
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: bridgeCode, stage });
      expect((failure as Error).message).not.toContain(privateDetail);
      expect((failure as Error).message).not.toContain('private cause');
      const envelope = createCreatorAgentPackageCreatorBridgeErrorEnvelope(
        failure,
        new AbortController().signal,
      );
      expect(Object.keys(envelope)).toEqual(['code', 'message', 'protocol', 'stage']);
      expect(envelope.protocol).toBe(CREATOR_AGENT_PACKAGE_CREATOR_BRIDGE_ERROR_PROTOCOL);
      expect(JSON.stringify(envelope)).not.toMatch(/private|cause|stack|secret-value/u);
    },
  );

  it('fails closed on unexpected Creator configuration and internal extraction failures', async () => {
    const failures = [
      new CreatorAgentPackageCreatorError(
        'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID',
        '/private/project/configuration detail',
      ),
      new Error('/private/project/unexpected internal detail'),
    ];

    for (const injected of failures) {
      let failure: unknown;
      try {
        await createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
          creatorHandoff(),
          {},
          {
            resolveHostBoundCurrentProject: () => '/host-bound-project',
            createDraft: async () => {
              throw injected;
            },
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: 'INTERNAL', stage: 'EXTRACT_DRAFT' });
      expect((failure as Error).message).not.toContain('/private/project');
    }
  });

  it('preserves an actionable Host Project error after Creator path binding fails', async () => {
    await expect(
      createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
        creatorHandoff(),
        {},
        {
          resolveHostBoundCurrentProject: () => '/host-bound-project',
          createDraft: async () => {
            throw new CreatorAgentPackageCreatorError(
              'AGENT_PACKAGE_DRAFT_PROJECT_UNAVAILABLE',
              '/private/project/path race detail',
            );
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'CURRENT_PROJECT_UNAVAILABLE',
      stage: 'BIND_CURRENT_PROJECT',
      message: 'Codex Host 当前 Project 无法被可靠绑定。',
    });
  });

  it('serializes arbitrary internal failures as one closed cause-free CLI envelope', () => {
    const privateCanary = '/private/project/never-serialize-this';
    const envelope = createCreatorAgentPackageCreatorBridgeErrorEnvelope(
      new Error(privateCanary),
      new AbortController().signal,
    );

    expect(envelope).toEqual({
      code: 'INTERNAL',
      message: 'Creator Bridge 未完成，且没有暴露内部错误信息。',
      protocol: CREATOR_AGENT_PACKAGE_CREATOR_BRIDGE_ERROR_PROTOCOL,
      stage: 'VALIDATE_DRAFT',
    });
    expect(Object.keys(envelope)).toEqual(['code', 'message', 'protocol', 'stage']);
    expect(JSON.stringify(envelope)).not.toMatch(/private|cause|stack|never-serialize/u);
  });

  it('keeps Draft construction rejection separate from structured Host output rejection', async () => {
    await expect(
      createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
        creatorHandoff(),
        {},
        {
          resolveHostBoundCurrentProject: () => '/host-bound-project',
          createDraft: async () => {
            throw new CreatorAgentPackageCreatorError(
              'AGENT_PACKAGE_DRAFT_OUTPUT_INVALID',
              'private Draft construction detail',
            );
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'DRAFT_INVALID',
      stage: 'VALIDATE_DRAFT',
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
