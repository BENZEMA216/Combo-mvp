import { describe, expect, it } from 'vitest';

import { CreatorWorker, CreatorWorkerError } from './creator-worker.js';
import {
  CodexHostError,
  createHostInterruptedTerminalEvidence,
  type CodexHost,
  type HostThread,
  type HostTurnHandle,
  type HostTurnResult,
} from './host-types.js';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

interface FakeTurn {
  thread: HostThread;
  messageId: string;
  text: string;
  deferred: Deferred<HostTurnResult>;
  interruptCount: number;
}

class FakeHost implements CodexHost {
  started = false;
  startCount = 0;
  stopped = false;
  createThreadCount = 0;
  readonly turns: FakeTurn[] = [];
  createThreadError?: Error;
  autoReply?: (text: string) => string;
  startDeferred?: Deferred<void>;

  async start(): Promise<void> {
    this.startCount += 1;
    if (this.startDeferred) await this.startDeferred.promise;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async createThread(): Promise<HostThread> {
    this.createThreadCount += 1;
    if (this.createThreadError) throw this.createThreadError;
    return {
      id: `thread-${this.createThreadCount}`,
      generation: 1,
      workspaceRootsAcknowledged: false,
    };
  }

  startTurn(input: {
    thread: HostThread;
    messageId: string;
    text: string;
    timeoutMs: number;
  }): HostTurnHandle {
    const deferred = new Deferred<HostTurnResult>();
    const turn: FakeTurn = {
      thread: input.thread,
      messageId: input.messageId,
      text: input.text,
      deferred,
      interruptCount: 0,
    };
    this.turns.push(turn);
    const turnId = `turn-${this.turns.length}`;
    if (this.autoReply) deferred.resolve({ text: this.autoReply(input.text) });
    return {
      turnId: Promise.resolve(turnId),
      result: deferred.promise,
      interrupt: async () => {
        turn.interruptCount += 1;
        deferred.reject(new CodexHostError('HOST_INTERRUPTED', 'interrupted', true));
        return createHostInterruptedTerminalEvidence({
          threadId: input.thread.id,
          turnId,
          status: 'interrupted',
          error: null,
          completedAt: 0,
        });
      },
    };
  }
}

async function startedWorker(host = new FakeHost(), maxConcurrentTurns = 1) {
  const worker = new CreatorWorker({ host, maxConcurrentTurns, turnTimeoutMs: 5_000 });
  await worker.start();
  return { worker, host };
}

describe('CreatorWorker', () => {
  it('reuses one Host thread for a multi-turn conversation and isolates conversations', async () => {
    const { worker, host } = await startedWorker();
    host.autoReply = (text) => `reply:${text}`;
    const first = await worker.createConversation();
    const second = await worker.createConversation();

    await expect(
      worker.sendMessage({ conversationId: first.conversationId, messageId: 'm-1', text: 'one' }),
    ).resolves.toEqual({ text: 'reply:one' });
    await expect(
      worker.sendMessage({ conversationId: first.conversationId, messageId: 'm-2', text: 'two' }),
    ).resolves.toEqual({ text: 'reply:two' });
    await expect(
      worker.sendMessage({
        conversationId: second.conversationId,
        messageId: 'm-1',
        text: 'other',
      }),
    ).resolves.toEqual({ text: 'reply:other' });

    expect(host.createThreadCount).toBe(2);
    expect(host.turns.map((turn) => turn.thread.id)).toEqual(['thread-1', 'thread-1', 'thread-2']);
  });

  it('coalesces concurrent and completed replays for the same id and text', async () => {
    const { worker, host } = await startedWorker();
    const { conversationId } = await worker.createConversation();
    const input = { conversationId, messageId: 'same-id', text: 'same text' };

    const first = worker.sendMessage(input);
    const replay = worker.sendMessage(input);
    await Promise.resolve();
    expect(first).toBe(replay);
    expect(host.turns).toHaveLength(1);
    host.turns[0]!.deferred.resolve({ text: 'once' });
    await expect(Promise.all([first, replay])).resolves.toEqual([
      { text: 'once' },
      { text: 'once' },
    ]);

    await expect(worker.sendMessage(input)).resolves.toEqual({ text: 'once' });
    expect(host.turns).toHaveLength(1);
  });

  it('checks idempotency conflict before conversation busy', async () => {
    const { worker } = await startedWorker();
    const { conversationId } = await worker.createConversation();
    void worker
      .sendMessage({ conversationId, messageId: 'same', text: 'original' })
      .catch(() => undefined);

    expect(() =>
      worker.sendMessage({ conversationId, messageId: 'same', text: 'changed' }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(() =>
      worker.sendMessage({ conversationId, messageId: 'different', text: 'next' }),
    ).toThrowError(expect.objectContaining({ code: 'CONVERSATION_BUSY' }));
  });

  it('enforces global capacity before creating another Host thread', async () => {
    const { worker, host } = await startedWorker();
    const first = await worker.createConversation();
    const second = await worker.createConversation();
    const active = worker.sendMessage({
      conversationId: first.conversationId,
      messageId: 'first',
      text: 'hold',
    });
    await Promise.resolve();

    expect(() =>
      worker.sendMessage({
        conversationId: second.conversationId,
        messageId: 'second',
        text: 'wait',
      }),
    ).toThrowError(expect.objectContaining({ code: 'CAPACITY_REACHED' }));
    expect(host.createThreadCount).toBe(1);
    host.turns[0]!.deferred.resolve({ text: 'done' });
    await active;

    host.autoReply = () => 'next';
    await expect(
      worker.sendMessage({
        conversationId: second.conversationId,
        messageId: 'second',
        text: 'wait',
      }),
    ).resolves.toEqual({ text: 'next' });
  });

  it('routes interrupt once to the active Host turn and releases capacity', async () => {
    const { worker, host } = await startedWorker();
    const first = await worker.createConversation();
    const second = await worker.createConversation();
    const active = worker
      .sendMessage({ conversationId: first.conversationId, messageId: 'first', text: 'hold' })
      .catch((error: unknown) => error);
    await Promise.resolve();
    await worker.interrupt(first.conversationId);
    await worker.interrupt(first.conversationId).catch(() => undefined);
    expect(host.turns[0]!.interruptCount).toBe(1);
    await expect(active).resolves.toEqual(expect.objectContaining({ code: 'TURN_INTERRUPTED' }));

    host.autoReply = () => 'released';
    await expect(
      worker.sendMessage({ conversationId: second.conversationId, messageId: 'next', text: 'go' }),
    ).resolves.toEqual({ text: 'released' });
  });

  it('does not persist a thread mapping when thread creation fails', async () => {
    const { worker, host } = await startedWorker();
    host.createThreadError = new CodexHostError('HOST_NOT_READY', 'not ready', false, true);
    const { conversationId } = await worker.createConversation();
    const failure = worker.sendMessage({ conversationId, messageId: 'one', text: 'hello' });
    await expect(failure).rejects.toEqual(
      expect.objectContaining({ code: 'HOST_UNAVAILABLE', retryable: false }),
    );
    expect(host.turns).toHaveLength(0);
    expect(worker.status().activeTurns).toBe(0);
    expect(() =>
      worker.sendMessage({ conversationId, messageId: 'one', text: 'hello' }),
    ).toThrowError(expect.objectContaining({ code: 'CONVERSATION_NOT_FOUND' }));

    host.createThreadError = undefined;
    const replacement = await worker.createConversation();
    host.autoReply = () => 'recovered';
    await expect(
      worker.sendMessage({
        conversationId: replacement.conversationId,
        messageId: 'one',
        text: 'hello',
      }),
    ).resolves.toEqual({ text: 'recovered' });
    expect(host.startCount).toBe(2);
    expect(host.createThreadCount).toBe(2);
  });

  it('invalidates all ephemeral mappings after a Host process loss', async () => {
    const { worker, host } = await startedWorker();
    host.autoReply = () => 'initial';
    const first = await worker.createConversation();
    const second = await worker.createConversation();
    await worker.sendMessage({ conversationId: first.conversationId, messageId: 'a', text: 'a' });
    await worker.sendMessage({ conversationId: second.conversationId, messageId: 'b', text: 'b' });
    host.autoReply = undefined;
    const lost = worker.sendMessage({
      conversationId: first.conversationId,
      messageId: 'c',
      text: 'c',
    });
    await Promise.resolve();
    host.turns.at(-1)!.deferred.reject(new CodexHostError('HOST_SESSION_LOST', 'lost', true, true));
    await expect(lost).rejects.toEqual(expect.objectContaining({ code: 'HOST_UNAVAILABLE' }));
    expect(worker.status().online).toBe(false);
    for (const conversationId of [first.conversationId, second.conversationId]) {
      expect(() =>
        worker.sendMessage({ conversationId, messageId: 'after-loss', text: 'retry' }),
      ).toThrowError(expect.objectContaining({ code: 'CONVERSATION_NOT_FOUND' }));
    }
    const replacement = await worker.createConversation();
    host.autoReply = () => 'replacement';
    await expect(
      worker.sendMessage({
        conversationId: replacement.conversationId,
        messageId: 'replacement',
        text: 'new context',
      }),
    ).resolves.toEqual({ text: 'replacement' });
    expect(worker.status().online).toBe(true);
    expect(host.startCount).toBe(2);
    expect(host.turns.at(-1)!.thread.id).not.toBe(host.turns[0]!.thread.id);
  });

  it('uses stable public errors instead of leaking arbitrary Host failures', async () => {
    const { worker, host } = await startedWorker();
    const { conversationId } = await worker.createConversation();
    const result = worker.sendMessage({ conversationId, messageId: 'm', text: 'secret prompt' });
    await Promise.resolve();
    host.turns[0]!.deferred.reject(new Error('/private/project and provider stderr'));
    await expect(result).rejects.toEqual(new CreatorWorkerError('TURN_FAILED', 500, false));
  });

  it('cannot restart or create a conversation once shutdown begins', async () => {
    const { worker, host } = await startedWorker();
    const stopping = worker.stop();
    await expect(worker.start()).rejects.toEqual(
      expect.objectContaining({ code: 'HOST_UNAVAILABLE' }),
    );
    await expect(worker.createConversation()).rejects.toEqual(
      expect.objectContaining({ code: 'HOST_UNAVAILABLE' }),
    );
    await stopping;
    expect(host.startCount).toBe(1);
  });

  it('cannot become online when shutdown wins a pending Host start race', async () => {
    const host = new FakeHost();
    host.startDeferred = new Deferred<void>();
    const worker = new CreatorWorker({ host, turnTimeoutMs: 5_000 });
    const starting = worker.start();
    await Promise.resolve();
    const stopping = worker.stop();
    host.startDeferred.resolve();
    await expect(starting).rejects.toEqual(expect.objectContaining({ code: 'HOST_UNAVAILABLE' }));
    await stopping;
    expect(worker.status().online).toBe(false);
    await expect(worker.createConversation()).rejects.toEqual(
      expect.objectContaining({ code: 'HOST_UNAVAILABLE' }),
    );
  });
});
