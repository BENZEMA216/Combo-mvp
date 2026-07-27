import { describe, expect, it, vi } from 'vitest';
import {
  type SandboxBackend,
  SandboxBackendError,
  type SandboxTurnContext,
} from '../platform/infra/sandbox-backend.js';
import { createSandboxTools } from '../modules/agent/sandbox-tools.js';

function backendFixture(): SandboxBackend {
  return {
    enabled: true,
    describe: async () => ({
      protocolVersion: '1',
      sessionId: 'session-1',
      podUid: 'pod-1',
      workspace: '/workspace',
      commandOutputEncoding: 'base64',
      operations: [],
      limits: {
        maxRequestBytes: 1,
        maxReadBytes: 1,
        maxFileBytes: 1,
        maxOutputBytes: 1,
        maxOutputFrames: 1,
        maxFrameBytes: 1,
        commandTimeoutMs: 1,
        maxCommandTimeMs: 1,
      },
    }),
    read: async () => ({ content: 'hello', sizeBytes: 5, offset: 0, truncated: false }),
    write: async (_context, input) => ({ writtenBytes: Buffer.byteLength(input.content) }),
    edit: async () => ({ replacements: 1 }),
    async command(_context, _input, onFrame) {
      const commandId = 'command-1';
      onFrame({ type: 'start', commandId });
      for (let index = 0; index < 100; index += 1) {
        onFrame({
          type: 'output',
          commandId,
          stream: index % 2 === 0 ? 'stdout' : 'stderr',
          data: `${index}\n`,
        });
      }
      onFrame({ type: 'exit', commandId, exitCode: 0 });
      return {
        commandId,
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        truncated: false,
        durationMs: 10,
      };
    },
    interruptSession: async () => undefined,
    releaseSession: async () => undefined,
    dispose: async () => undefined,
  };
}

const context: SandboxTurnContext = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  ownerUserId: 'owner-1',
};
const toolContext = { ...context, turnSignal: new AbortController().signal };

describe('sandbox Pi tools', () => {
  it('registers only the four exact tools in stable order and forces sequential execution', () => {
    const tools = createSandboxTools({ ...toolContext, backend: backendFixture() });
    expect(tools.map((tool) => tool.name)).toEqual(['read', 'write', 'edit', 'bash']);
    expect(tools.every((tool) => tool.executionMode === 'sequential')).toBe(true);
    expect(
      tools.map((tool) => ({
        name: tool.name,
        required: (tool.parameters as { required?: string[] }).required,
      })),
    ).toEqual([
      { name: 'read', required: ['path'] },
      { name: 'write', required: ['path', 'content'] },
      { name: 'edit', required: ['path', 'oldText', 'newText'] },
      { name: 'bash', required: ['command'] },
    ]);
  });

  it('returns Pi 0.80.2 content/details for every operation without a usage field', async () => {
    const [read, write, edit, bash] = createSandboxTools({
      ...toolContext,
      backend: backendFixture(),
    });
    const results = [
      await read!.execute('read-1', { path: 'note.txt' }),
      await write!.execute('write-1', { path: 'note.txt', content: 'hello' }),
      await edit!.execute('edit-1', {
        path: 'note.txt',
        oldText: 'hello',
        newText: 'world',
      }),
      await bash!.execute('bash-1', { command: 'printf hello' }),
    ];
    for (const result of results) {
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.details.operation).toBeTruthy();
      expect(result).not.toHaveProperty('usage');
    }
  });

  it('bounds bash onUpdate calls and preserves a bounded head/tail final result', async () => {
    const backend = backendFixture();
    const bash = createSandboxTools({ ...toolContext, backend })[3];
    const updates: unknown[] = [];
    const result = await bash.execute('bash-1', { command: 'many' }, undefined, (update) =>
      updates.push(update),
    );
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.length).toBeLessThanOrEqual(32);
    expect(result.details).toMatchObject({ operation: 'bash', exitCode: 0 });
    expect(
      Buffer.byteLength(result.content[0]!.type === 'text' ? result.content[0]!.text : ''),
    ).toBeLessThanOrEqual(66 * 1024);
  });

  it('exposes byte-accurate continuation metadata when a read is truncated', async () => {
    const backend = backendFixture();
    backend.read = async () => ({
      content: '你',
      sizeBytes: 10,
      offset: 2,
      truncated: true,
    });
    const read = createSandboxTools({ ...toolContext, backend })[0];
    const result = await read.execute('read-1', { path: 'note.txt' });
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('偏移 5');
    expect(result.details).toMatchObject({ offset: 2, nextOffset: 5, truncated: true });
  });

  it('binds the Turn and Pi call AbortSignals to the authenticated backend call', async () => {
    const backend = backendFixture();
    const readSpy = vi.spyOn(backend, 'read');
    const read = createSandboxTools({ ...toolContext, backend })[0]!;
    const controller = new AbortController();
    await read.execute('read-1', { path: 'note.txt' }, controller.signal);
    const receivedSignal = readSpy.mock.calls[0]?.[2];
    expect(readSpy).toHaveBeenCalledWith(context, { path: 'note.txt' }, receivedSignal);
    expect(receivedSignal?.aborted).toBe(false);
    controller.abort();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('rejects a tool call made after the owning Turn aborts even when Pi omits its call signal', async () => {
    const backend = backendFixture();
    const readSpy = vi.spyOn(backend, 'read');
    const turn = new AbortController();
    const read = createSandboxTools({ ...context, backend, turnSignal: turn.signal })[0]!;
    turn.abort();
    await expect(read.execute('late-read', { path: 'note.txt' })).rejects.toThrow('沙箱操作已取消');
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('redacts even a typed backend exception before Pi returns it to the model', async () => {
    const backend = backendFixture();
    backend.read = async () => {
      throw new SandboxBackendError(
        'unavailable',
        'https://cluster.internal token=secret /host/private',
      );
    };
    const read = createSandboxTools({ ...toolContext, backend })[0]!;
    await expect(read.execute('read-1', { path: 'note.txt' })).rejects.toThrow('沙箱操作未能完成');
    await expect(read.execute('read-2', { path: 'note.txt' })).rejects.not.toThrow('secret');
  });

  it('aborts the owning Turn when descendant cleanup cannot be confirmed', async () => {
    const backend = backendFixture();
    backend.command = async () => {
      throw new SandboxBackendError('cleanup_unconfirmed', 'pod uid and private details');
    };
    const onCleanupUnconfirmed = vi.fn();
    const bash = createSandboxTools({
      ...toolContext,
      backend,
      onCleanupUnconfirmed,
    })[3];
    await expect(bash.execute('bash-unsafe', { command: 'sleep 30' })).rejects.toThrow(
      '本轮必须停止',
    );
    expect(onCleanupUnconfirmed).toHaveBeenCalledOnce();
  });

  it('redacts unexpected backend exceptions before Pi returns them to the model', async () => {
    const backend = backendFixture();
    backend.read = async () => {
      throw new Error('https://cluster.internal token=secret /host/private');
    };
    const read = createSandboxTools({ ...toolContext, backend })[0]!;
    await expect(read.execute('read-1', { path: 'note.txt' })).rejects.toThrow('沙箱操作未能完成');
    await expect(read.execute('read-2', { path: 'note.txt' })).rejects.not.toThrow('secret');
  });
});
