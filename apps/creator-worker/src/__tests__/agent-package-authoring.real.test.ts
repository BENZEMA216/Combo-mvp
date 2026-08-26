import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
  createCreatorAgentPackageCreatorRequest,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { afterEach, describe, expect, it } from 'vitest';

import { createCreatorAgentPackageDraftFromCurrentProject } from '../agent-package-creator.js';
import { startCreatorAgentPackageSession } from '../agent-package-session.js';

const enabled = process.env.COMBO_REAL_CODEX_E2E === '1';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    makeDirectoriesWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe.runIf(enabled)('Creator sentence to Draft to Agent Package to Codex real closure', () => {
  it('creates a reviewable Draft, reloads its immutable Package, and uses it for two held-out turns', async () => {
    // Source 只提供创作方法；先保存快照，最后用同一基线证明整个流程没有改写它。
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'combo-real-package-authoring-')));
    roots.push(root);
    const source = join(root, 'source');
    const retiredSource = join(root, 'source-retired');
    const store = join(root, 'store');
    const consumer = join(root, 'consumer');
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(store, { mode: 0o700 });
    chmodSync(store, 0o700);

    const methodMarker = `method-${randomUUID()}`;
    writeFileSync(
      join(source, 'AGENT_METHOD.md'),
      [
        '# Reusable release evidence method',
        `The immutable method marker is ${methodMarker}. Preserve it exactly in the reusable instructions.`,
        'When reviewing a consumer Project, read RELEASE.json using read-only tools.',
        'A release is READY only when candidateSha equals evidenceSha, quality and billing are both PASS, and modified is false.',
        'For phase one, the user supplies a conversation token. Return exactly:',
        `PACKAGE_GATE|${methodMarker}|READY|<candidateSha>|<conversationToken>`,
        'For phase two, use the same conversation memory and return exactly:',
        'PACKAGE_MEMORY|<priorConversationToken>|<priorCandidateSha>',
        'Never modify the consumer Project and never add Markdown or commentary to either result.',
      ].join('\n'),
      { mode: 0o600 },
    );
    writeFileSync(
      join(source, 'README.md'),
      'This creator source teaches a reusable evidence-first release gate. Cite AGENT_METHOD.md.\n',
      { mode: 0o600 },
    );
    const sourceBefore = snapshotDirectory(source);
    const runtimeSnapshotsBefore = runtimeSnapshotNames();

    // 一句话创建 Draft；来源绝对路径只留在受信任务绑定中，不能进入可分享内容。
    const authoringTask = await createCreatorAgentPackageDraftFromCurrentProject({
      request: createCreatorAgentPackageCreatorRequest({
        protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
        intent: 'create_agent_package_from_current_project',
        request:
          '请阅读 AGENT_METHOD.md，把这个目录里已经跑通的发布证据流程提炼成一个可复用 Agent。',
      }),
      currentProjectPath: source,
      allowUnisolatedRead: true,
      allowSensitiveProjectContext: true,
      allowLoopbackProxy: true,
      turnTimeoutMs: 300_000,
    });
    const draft = authoringTask.readDraft();
    expect(draft.creatorRequest.request).toContain('AGENT_METHOD.md');
    expect(draft.source.citedSources.map(({ path }) => path)).toContain('AGENT_METHOD.md');
    expect(JSON.stringify(draft)).not.toContain(source);
    // 编译必须绑定用户实际看到的 exact Draft revision，避免并发修订后静默编译另一版。
    const authored = authoringTask.compile({
      draftId: draft.draftId,
      draftRevision: draft.revision,
      draftFingerprint: draft.draftFingerprint,
      storeDirectory: store,
    });

    expect(authored.reloadVerified).toBe(true);
    expect(authored.sourceReceipt.citedSources.map(({ path }) => path)).toContain(
      'AGENT_METHOD.md',
    );
    expect(snapshotDirectory(source)).toEqual(sourceBefore);
    const packageBefore = snapshotDirectory(authored.packagePath);
    const packageText = packageBefore.map(({ text }) => text).join('\n');
    expect(packageText).toContain(methodMarker);
    // 冻结后移走 Source，再生成随机消费事实，证明运行时只依赖 Package 与 Consumer。
    renameSync(source, retiredSource);

    const candidateSha = createHash('sha256').update(randomUUID()).digest('hex');
    const conversationToken = `conversation-${randomUUID()}`;
    mkdirSync(consumer, { mode: 0o700 });
    writeFileSync(
      join(consumer, 'RELEASE.json'),
      `${JSON.stringify({
        candidateSha,
        evidenceSha: candidateSha,
        checks: { quality: 'PASS', billing: 'PASS' },
        modified: false,
      })}\n`,
      { mode: 0o600 },
    );
    const consumerBefore = snapshotDirectory(consumer);
    expect(packageText).not.toContain(candidateSha);
    expect(packageText).not.toContain(conversationToken);

    // 同一 Session 只创建一个 Codex thread；连续 send 用来验证跨轮上下文仍然存在。
    const session = await startCreatorAgentPackageSession({
      packagePath: authored.packagePath,
      projectPath: consumer,
      allowUnisolatedRead: true,
      allowLoopbackProxy: true,
      turnTimeoutMs: 180_000,
    });
    try {
      expect(session.packageDigest).toBe(authored.packageDigest);
      const first = await session.send(
        `Phase one. My conversation token is ${conversationToken}. Apply the installed package method to RELEASE.json.`,
      );
      expect(first).toBe(`PACKAGE_GATE|${methodMarker}|READY|${candidateSha}|${conversationToken}`);
      const second = await session.send(
        'Phase two. Use the same Agent conversation and return the required memory line.',
      );
      expect(second).toBe(`PACKAGE_MEMORY|${conversationToken}|${candidateSha}`);
    } finally {
      await session.close();
    }

    // 最后同时核对三处内容与临时资源，避免“回答正确但留下副作用”的假通过。
    expect(snapshotDirectory(retiredSource)).toEqual(sourceBefore);
    expect(snapshotDirectory(consumer)).toEqual(consumerBefore);
    expect(snapshotDirectory(authored.packagePath)).toEqual(packageBefore);
    expect(runtimeSnapshotNames()).toEqual(runtimeSnapshotsBefore);
    expect(recursiveFileNames(root).some((path) => path.endsWith('.sqlite'))).toBe(false);
  }, 900_000);
});

type SnapshotEntry = Readonly<{
  path: string;
  digest: string;
  mode: number;
  size: number;
  mtimeMs: number;
  text: string;
}>;

function snapshotDirectory(root: string): readonly SnapshotEntry[] {
  return recursiveFileNames(root).map((path) => {
    const absolute = join(root, ...path.split('/'));
    const bytes = readFileSync(absolute);
    const stat = statSync(absolute);
    return Object.freeze({
      path,
      digest: createHash('sha256').update(bytes).digest('hex'),
      mode: stat.mode & 0o777,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    });
  });
}

function recursiveFileNames(root: string): string[] {
  const files: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    const directory = parent ? join(root, ...parent.split('/')) : root;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files.sort();
}

function runtimeSnapshotNames(): readonly string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('combo-agent-package-runtime-'))
    .sort();
}

function makeDirectoriesWritable(root: string): void {
  const pending = [root];
  for (let index = 0; index < pending.length; index += 1) {
    const directory = pending[index]!;
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(join(directory, entry.name));
    }
  }
}
