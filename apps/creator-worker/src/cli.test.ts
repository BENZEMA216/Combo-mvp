import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from './cli.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Creator Worker CLI boundary', () => {
  it('rejects any attempt to replace the reviewed bundled Codex executable', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runCli(['--codex-bin', '/bin/echo'])).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith('启动参数无效。使用 --help 查看用法。\n');
  });

  it('requires the explicit unisolated-read acknowledgement before inspecting a Project', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runCli(['--project', '/does/not/need/to/exist'])).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      '体验版没有 OS 级文件读取隔离；只有显式加入 --allow-unisolated-read 才会启动。\n',
    );
  });

  it('rejects a symlink Project root before starting Codex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'combo-creator-worker-cli-'));
    const project = join(root, 'project');
    const link = join(root, 'project-link');
    await mkdir(project);
    await symlink(project, link, 'dir');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(runCli(['--project', link, '--allow-unisolated-read'])).resolves.toBe(2);
      expect(stderr).toHaveBeenCalledWith('Project 或 Codex 可执行文件未通过体验版安全检查。\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
