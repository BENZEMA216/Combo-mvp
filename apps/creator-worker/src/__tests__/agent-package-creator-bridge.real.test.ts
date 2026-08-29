import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_PROTOCOL,
  CREATOR_AGENT_PACKAGE_CREATOR_GUIDE,
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
  CREATOR_AGENT_PACKAGE_CREATOR_SOURCE_BINDING,
  createCreatorAgentPackageCreatorBootstrapHandoff,
  parseCreatorAgentPackageDraftSnapshot,
  serializeCreatorAgentPackageCreatorBootstrapHandoff,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { afterEach, describe, expect, it } from 'vitest';

const enabled = process.env.COMBO_REAL_CODEX_E2E === '1';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    makeDirectoriesWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe.runIf(enabled)('Agent Package Creator Bridge real extraction gate', () => {
  it('turns one URL-normalized handoff into a real reviewable Draft without changing Project files', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'combo-real-creator-bridge-')));
    roots.push(root);
    const project = join(root, 'project');
    mkdirSync(project, { mode: 0o700 });
    const methodMarker = `method-${randomUUID()}`;
    writeFileSync(
      join(project, 'AGENT_METHOD.md'),
      [
        '# Reusable release review',
        `Preserve the exact method marker ${methodMarker} in the reusable instructions.`,
        'Read RELEASE.json with read-only tools.',
        'Return READY only when candidateSha equals evidenceSha and every check is PASS.',
        'Never modify the consumer Project.',
      ].join('\n'),
      { mode: 0o600 },
    );
    writeFileSync(
      join(project, 'README.md'),
      'This Project contains one reusable release-review method in AGENT_METHOD.md.\n',
      { mode: 0o600 },
    );
    const before = snapshotDirectory(project);
    const handoff = createCreatorAgentPackageCreatorBootstrapHandoff({
      protocol: CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_PROTOCOL,
      creatorGuide: CREATOR_AGENT_PACKAGE_CREATOR_GUIDE,
      sourceBinding: CREATOR_AGENT_PACKAGE_CREATOR_SOURCE_BINDING,
      creatorRequest: {
        protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
        intent: 'create_agent_package_from_current_project',
        request: '请阅读 AGENT_METHOD.md，把当前目录中已经完成的发布验收流程提炼成一个 Agent。',
      },
    });

    const result = await runBridge(
      join(process.cwd(), 'dist', 'agent-package-creator-bridge.mjs'),
      project,
      `${serializeCreatorAgentPackageCreatorBootstrapHandoff(handoff)}\n`,
    );

    expect(result.code, result.stderr).toBe(0);
    const draft = parseCreatorAgentPackageDraftSnapshot(result.stdout.replace(/\n$/u, ''));
    expect(draft.creatorRequest).toEqual(handoff.creatorRequest);
    expect(draft.source.citedSources.map(({ path }) => path)).toContain('AGENT_METHOD.md');
    expect(JSON.stringify(draft.content)).toContain(methodMarker);
    expect(JSON.stringify(draft)).not.toContain(project);
    expect(JSON.stringify(draft)).not.toContain('buildwithcombo.com');
    expect(result.stderr).toContain('"stage":"HANDOFF"');
    expect(result.stderr).toContain('"stage":"VALIDATE_DRAFT"');
    expect(snapshotDirectory(project)).toEqual(before);
  }, 600_000);
});

function runBridge(
  executable: string,
  project: string,
  input: string,
): Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [executable], {
      cwd: project,
      env: {
        ...process.env,
        COMBO_AGENT_PACKAGE_CREATOR_HOST_BINDING: CREATOR_AGENT_PACKAGE_CREATOR_SOURCE_BINDING,
        NODE_PATH: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      resolveResult({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(input);
  });
}

type SnapshotEntry = Readonly<{
  path: string;
  digest: string;
  mode: number;
  size: number;
  mtimeMs: number;
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
