import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { WorkerSqliteStore } from '@cb/creator-agent-broker-journal/sqlite-store';
import type { WorkerDurableTransportRepository } from '@cb/creator-worker-broker-client/sqlite-repository';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkerSerialPumpError } from '../index.js';
import {
  PROMPT_CANARY,
  RESULT_CANARY,
  addStartInput,
  closeRig,
  createRig,
  enqueueCommand,
  eventually,
  fingerprint,
  makePump,
  reopenRig,
  settleSuccess,
  waitForPhase,
  type Rig,
} from './test-fixture.js';

const rigs = new Set<Rig>();

afterEach(() => {
  vi.useRealTimers();
  for (const rig of rigs) closeRig(rig);
  rigs.clear();
});

function rig(options: Parameters<typeof createRig>[0] = {}): Rig {
  const made = createRig(options);
  rigs.add(made);
  return made;
}

describe('WorkerSerialPump', () => {
  it('runs prepare -> start -> sealed success and hands exact facts across two SQLite stores', async () => {
    const current = rig();
    const start = addStartInput(current);

    enqueuePrepare(current);
    expect(await current.pump.tick()).toMatchObject({ commandsApplied: 1, factsEnqueued: 0 });
    await waitForPhase(current, 'PREPARED');
    enqueueStart(current, start);
    await current.pump.tick();
    await waitForPhase(current, 'RUNNING');
    expect(current.host.inputs).toHaveLength(1);
    expect(current.host.inputs[0]?.text).toBe(PROMPT_CANARY);

    settleSuccess(current);
    await waitForPhase(current, 'TERMINAL_READY');
    const pending = current.journal.readPendingFacts(current.journalOwner);
    expect(pending.map(({ factType }) => factType)).toEqual(['STARTED', 'TERMINAL']);
    const exactFacts = pending.map((reference) =>
      current.journal.readOutboxFact<{ ciphertext: string }>(current.journalOwner, reference),
    );

    expect(await current.pump.tick()).toMatchObject({
      commandsApplied: 0,
      factsEnqueued: 2,
      flush: 'FLUSHED',
    });
    expect(current.journal.readPendingFacts(current.journalOwner)).toEqual([]);
    for (const fact of exactFacts) {
      expect(
        current.transport.readDelivery(current.transportOwner, fact.reference.factId),
      ).toMatchObject({
        sourceId: fact.reference.factId,
        sourceFingerprint: fact.reference.payloadFingerprint,
      });
    }

    current.transport.close(current.transportOwner);
    const database = new DatabaseSync(current.transportOptions.filename, { readOnly: true });
    const rows = database
      .prepare(
        `SELECT delivery_message_id AS deliveryMessageId, body_json AS bodyJson
           FROM transport_logical_outbox WHERE body_type='worker.message'
           ORDER BY logical_sequence`,
      )
      .all() as Array<{ deliveryMessageId: string; bodyJson: string }>;
    database.close();
    expect(rows).toHaveLength(2);
    for (const [index, row] of rows.entries()) {
      const fact = exactFacts[index]!;
      expect(row.deliveryMessageId).toBe(fact.reference.factId);
      expect(JSON.parse(row.bodyJson)).toEqual({
        type: 'worker.message',
        messageType: index === 0 ? 'worker.started' : 'worker.terminal',
        sourceId: fact.reference.factId,
        sourceFingerprint: fact.reference.payloadFingerprint,
        payload: { fact: fact.payload, sealedEnvelope: fact.sealedEnvelope },
      });
    }
    expect(exactFacts[0]?.sealedEnvelope).toBeNull();
    expect(exactFacts[1]?.sealedEnvelope).toEqual({ ciphertext: 'opaque.r2d' });
    expect(rawSqliteBytes(current)).not.toContain(PROMPT_CANARY);
    expect(rawSqliteBytes(current)).not.toContain(RESULT_CANARY);
  });

  it('rejects a transport-incompatible sealed envelope before durable terminal commit', async () => {
    const current = rig();
    const incompatibleEnvelope = Object.freeze({ constructor: 'opaque' });
    expect(Object.hasOwn(incompatibleEnvelope, 'constructor')).toBe(true);
    current.pump = makePump(current, {
      sealResult: async () => ({
        sealedResultId: 'sealed.incompatible',
        sealedFingerprint: fingerprint('sealed.incompatible'),
        envelope: incompatibleEnvelope as unknown as { ciphertext: string },
      }),
    });
    await startRunning(current);
    expect(current.journal.readPendingFacts(current.journalOwner)).toMatchObject([
      { factType: 'STARTED' },
    ]);

    settleSuccess(current, 'must not become a poisoned terminal');
    await eventually(() => (current.pump.status === 'BLOCKED' ? true : undefined));
    expect(current.journal.readInvocation(current.journalOwner, 'invocation.r2d')?.phase).toBe(
      'RUNNING',
    );
    expect(current.journal.readPendingFacts(current.journalOwner)).toMatchObject([
      { factType: 'STARTED' },
    ]);
    expect(current.host.startCalls).toBe(1);
    expect(() => current.pump.tick()).toThrow(expect.objectContaining({ code: 'PUMP_BLOCKED' }));
    expect(current.host.startCalls).toBe(1);
  });

  it('validates the seal-authority snapshot after caller mutation, not an earlier reference', async () => {
    const current = rig();
    let envelope: Readonly<object> = Object.freeze({ ciphertext: 'initially-compatible' });
    let envelopeReads = 0;
    current.pump = makePump(current, {
      sealResult: async () => ({
        sealedResultId: 'sealed.mutated',
        sealedFingerprint: fingerprint('sealed.mutated'),
        get envelope() {
          envelopeReads += 1;
          const returned = envelope;
          if (envelopeReads === 1) {
            queueMicrotask(() => {
              envelope = Object.freeze({ constructor: 'late-poison' });
            });
          }
          return returned as { ciphertext: string };
        },
      }),
    });
    await startRunning(current);

    settleSuccess(current, 'snapshot must be checked');
    await eventually(() => (current.pump.status === 'BLOCKED' ? true : undefined));
    expect(envelopeReads).toBeGreaterThanOrEqual(2);
    expect(current.journal.readInvocation(current.journalOwner, 'invocation.r2d')?.phase).toBe(
      'RUNNING',
    );
    expect(current.journal.readPendingFacts(current.journalOwner)).toMatchObject([
      { factType: 'STARTED' },
    ]);
    expect(current.host.startCalls).toBe(1);
  });

  it('never launches Host before command-applied commit and exact-replays after restart', async () => {
    const current = rig();
    const start = addStartInput(current);
    let failMark = false;
    const transport = boundProxy(current.transport, {
      markCommandApplied: (owner, messageId) => {
        if (failMark && messageId === 'command.start') throw new Error('mark failpoint');
        return current.transport.markCommandApplied(owner, messageId);
      },
    } satisfies Partial<WorkerDurableTransportRepository>);
    current.pump = makePump(current, { transport });

    enqueuePrepare(current);
    await current.pump.tick();
    enqueueStart(current, start, 'command.start');
    failMark = true;
    await expect(current.pump.tick()).rejects.toMatchObject({ code: 'PUMP_BLOCKED' });
    expect(current.host.startCalls).toBe(0);
    expect(current.journal.readInvocation(current.journalOwner, 'invocation.r2d')?.phase).toBe(
      'DISPATCHING',
    );
    expect(current.transport.readPendingCommands(current.transportOwner)).toHaveLength(1);

    expect(reopenRig(current)).toHaveLength(1);
    await current.pump.tick();
    expect(current.transport.readPendingCommands(current.transportOwner)).toEqual([]);
    expect(current.host.startCalls).toBe(0);
  });

  it('does not let a hanging outcome block cancel and drops terminal-first late interrupt evidence', async () => {
    const hanging = rig();
    await startRunning(hanging);
    enqueueCancel(hanging);
    await hanging.pump.tick();
    await eventually(() => (hanging.host.interruptWrites.length === 1 ? true : undefined));
    expect(hanging.pump.status).toBe('IDLE');
    const controller = hanging.host.controllers[0]!;
    controller.settleInterrupted({
      thread: controller.handle.thread,
      turnId: controller.handle.turnId,
      completedAt: Date.now(),
      terminalStatus: 'interrupted',
      terminalError: 'NONE',
      outputState: 'NOT_APPLICABLE',
    });
    expect((await waitForPhase(hanging, 'TERMINAL_READY')).terminal).toMatchObject({
      outcome: 'CANCELLED',
    });

    const terminalFirst = rig();
    await startRunning(terminalFirst);
    terminalFirst.host.onInterruptWrite = () =>
      queueMicrotask(() => settleSuccess(terminalFirst, 'terminal won'));
    enqueueCancel(terminalFirst);
    await terminalFirst.pump.tick();
    expect((await waitForPhase(terminalFirst, 'TERMINAL_READY')).terminal).toMatchObject({
      outcome: 'SUCCEEDED',
    });
    await eventually(() => (terminalFirst.host.interruptWrites.length === 1 ? true : undefined));
    expect(terminalFirst.pump.status).toBe('IDLE');
  });

  it('exact-replays a cross-database handoff after enqueue won but journal mark failed', async () => {
    const current = rig();
    await startRunning(current);
    const started = current.journal.readPendingFacts(current.journalOwner)[0]!;
    let failMark = true;
    const journal = boundProxy(current.journal, {
      markFactEnqueued: (owner, reference) => {
        if (failMark) throw new Error('handoff mark failpoint');
        return current.journal.markFactEnqueued(owner, reference);
      },
    } satisfies Partial<WorkerSqliteStore>);
    current.pump = makePump(current, { journal });

    await expect(current.pump.tick()).rejects.toMatchObject({ code: 'PUMP_BLOCKED' });
    expect(current.transport.readDelivery(current.transportOwner, started.factId)).not.toBeNull();
    expect(current.journal.readPendingFacts(current.journalOwner)).toContainEqual(started);

    failMark = false;
    reopenRig(current);
    await current.pump.tick();
    expect(current.journal.readPendingFacts(current.journalOwner)).toEqual([]);
    current.transport.close(current.transportOwner);
    const database = new DatabaseSync(current.transportOptions.filename, { readOnly: true });
    const count = database
      .prepare(`SELECT COUNT(*) AS count FROM transport_logical_outbox WHERE source_id=?`)
      .get(started.factId) as { count: number };
    database.close();
    expect(count.count).toBe(1);
  });

  it('renews the journal owner before its original lease expires so late outcome can commit', async () => {
    vi.useFakeTimers({ now: 1_787_281_400_000 });
    const current = rig({ journalLeaseMs: 1_000 });
    addStartInput(current);
    enqueuePrepare(current);
    vi.setSystemTime(1_787_281_400_900);
    await current.pump.tick();
    enqueueStart(current, addStartInput(current));
    await current.pump.tick();
    await waitForPhase(current, 'RUNNING');
    vi.setSystemTime(1_787_281_401_100);
    settleSuccess(current);
    await waitForPhase(current, 'TERMINAL_READY');
  });

  it('stops through conservative recovery, never owns Host stop, and ignores late outcome', async () => {
    const current = rig();
    await startRunning(current);
    await current.pump.stop();
    const before = current.journal.readInvocation(current.journalOwner, 'invocation.r2d')!;
    expect(before.phase).toBe('TERMINAL_READY');
    expect(before.state).toMatchObject({
      terminal: {
        outcome: 'UNCERTAIN',
        reason: 'PROCESS_RESTART_WITH_LIVE_TURN',
        hostReason: null,
      },
    });
    expect(current.host.stopCalls).toBe(0);
    expect(JSON.stringify(before.state)).not.toContain('HOST_SESSION_LOST');
    settleSuccess(current, 'late after stop');
    await Promise.resolve();
    expect(current.journal.readInvocation(current.journalOwner, 'invocation.r2d')).toEqual(before);
    expect(current.pump.status).toBe('STOPPED');
  });

  it('aborts an ignored resolver so stop is bounded and late resolution has no authority', async () => {
    const current = rig();
    const start = addStartInput(current);
    let resolverEntered = false;
    let resolveLate!: (value: Readonly<{ input: unknown; inputFingerprint: string }>) => void;
    const late = new Promise<Readonly<{ input: unknown; inputFingerprint: string }>>((resolve) => {
      resolveLate = resolve;
    });
    current.pump = makePump(current, {
      resolveStartInput: async () => {
        resolverEntered = true;
        return late;
      },
    });
    enqueuePrepare(current);
    await current.pump.tick();
    enqueueStart(current, start);
    const activeTick = current.pump.tick();
    const tickRejection = expect(activeTick).rejects.toMatchObject({ code: 'PUMP_STOPPED' });
    await eventually(() => (resolverEntered ? true : undefined));
    await expect(current.pump.stop()).resolves.toBeUndefined();
    await tickRejection;
    expect(current.journal.readInvocation(current.journalOwner, 'invocation.r2d')?.phase).toBe(
      'PREPARED',
    );
    expect(current.transport.readPendingCommands(current.transportOwner)).toHaveLength(1);
    expect(current.host.startCalls).toBe(0);

    resolveLate(current.resolutions.get(start.inputRef)!);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(current.journal.readInvocation(current.journalOwner, 'invocation.r2d')?.phase).toBe(
      'PREPARED',
    );
    expect(current.host.startCalls).toBe(0);
  });

  it('bounds an ignored resolver timeout without committing start authority', async () => {
    vi.useFakeTimers({ now: 1_787_281_400_000 });
    const current = rig();
    const start = addStartInput(current);
    expect(() => makePump(current, { startInputTimeoutMs: 0 })).toThrow(/1\.\.60000/u);
    expect(() => makePump(current, { startInputTimeoutMs: 60_001 })).toThrow(/1\.\.60000/u);
    let resolverEntered = false;
    current.pump = makePump(current, {
      startInputTimeoutMs: 1,
      resolveStartInput: async () => {
        resolverEntered = true;
        return new Promise<never>(() => undefined);
      },
    });
    enqueuePrepare(current);
    await current.pump.tick();
    enqueueStart(current, start);
    const activeTick = current.pump.tick();
    const rejection = expect(activeTick).rejects.toMatchObject({ code: 'START_INPUT_TIMEOUT' });
    await eventually(() => (resolverEntered ? true : undefined));
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(current.pump.status).toBe('BLOCKED');
    expect(current.journal.readInvocation(current.journalOwner, 'invocation.r2d')?.phase).toBe(
      'PREPARED',
    );
    expect(current.transport.readPendingCommands(current.transportOwner)).toHaveLength(1);
    expect(current.host.startCalls).toBe(0);
  });

  it('treats transient flush rejection as deferred but detects present and later BLOCKED status', async () => {
    const current = rig();
    current.driver.status = 'BACKING_OFF';
    current.driver.flushFailure = new Error('socket retry');
    await expect(current.pump.tick()).resolves.toMatchObject({ flush: 'DEFERRED' });
    expect(current.pump.status).toBe('IDLE');

    current.driver.status = 'READY';
    current.driver.flushFailure = undefined;
    current.driver.flushResult = 'DEFERRED';
    enqueuePrepare(current);
    await current.pump.tick();
    enqueueCancel(current);
    expect(await current.pump.tick()).toMatchObject({
      factsEnqueued: 1,
      flush: 'DEFERRED',
      workMayRemain: true,
    });
    current.driver.status = 'BLOCKED';
    await expect(current.pump.tick()).rejects.toBeInstanceOf(WorkerSerialPumpError);
    expect(current.pump.status).toBe('BLOCKED');
  });

  it('coalesces concurrent ticks and blocks exact unknown or malformed commands', async () => {
    const empty = rig();
    const first = empty.pump.tick();
    expect(empty.pump.tick()).toBe(first);
    await first;

    const unknown = rig();
    enqueueCommand(unknown, 'invocation.unknown', {});
    await expect(unknown.pump.tick()).rejects.toMatchObject({ code: 'COMMAND_UNSUPPORTED' });
    expect(unknown.transport.readPendingCommands(unknown.transportOwner)).toHaveLength(1);

    const malformed = rig();
    enqueueCommand(malformed, 'invocation.prepare', {
      invocationId: 'invocation.r2d',
      unexpected: true,
    });
    await expect(malformed.pump.tick()).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    expect(malformed.transport.readPendingCommands(malformed.transportOwner)).toHaveLength(1);
  });

  it('serializes an unknown background failure ahead of a deferred resolver continuation', async () => {
    const current = rig();
    const firstStart = addStartInput(current, 'input.first');
    let failSeal!: () => void;
    const sealGate = new Promise<void>((resolve) => {
      failSeal = resolve;
    });
    let releaseResolver!: () => void;
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    let resolverEntered = false;
    current.pump = makePump(current, {
      sealResult: async () => {
        await sealGate;
        throw new Error('sealer unavailable');
      },
      resolveStartInput: async (inputRef) => {
        const found = current.resolutions.get(inputRef)!;
        if (inputRef === 'input.second') {
          resolverEntered = true;
          await resolverGate;
        }
        return found;
      },
    });
    enqueuePrepare(current, 'invocation.first', 'prepare.first');
    await current.pump.tick();
    enqueueStartFor(current, 'invocation.first', firstStart, 'start.first');
    await current.pump.tick();
    await waitForPhase(current, 'RUNNING', 'invocation.first');
    settleSuccess(current, 'first result');

    enqueuePrepare(current, 'invocation.second', 'prepare.second');
    await current.pump.tick();
    const secondStart = addStartInput(current, 'input.second');
    enqueueStartFor(current, 'invocation.second', secondStart, 'start.second');
    const startTick = current.pump.tick();
    await eventually(() => (resolverEntered ? true : undefined));
    failSeal();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    releaseResolver();
    await expect(startTick).rejects.toMatchObject({ code: 'PUMP_BLOCKED' });
    expect(current.host.startCalls).toBe(1);
    expect(current.journal.readInvocation(current.journalOwner, 'invocation.second')?.phase).toBe(
      'PREPARED',
    );
  });
});

function enqueuePrepare(
  current: Rig,
  invocationId = 'invocation.r2d',
  messageId = 'command.prepare',
): void {
  enqueueCommand(current, 'invocation.prepare', { invocationId }, messageId);
}

function enqueueStart(
  current: Rig,
  start: ReturnType<typeof addStartInput>,
  messageId = 'command.start',
): void {
  enqueueStartFor(current, 'invocation.r2d', start, messageId);
}

function enqueueStartFor(
  current: Rig,
  invocationId: string,
  start: ReturnType<typeof addStartInput>,
  messageId: string,
): void {
  enqueueCommand(
    current,
    'invocation.start',
    { invocationId, attemptId: `attempt.${invocationId}`, ...start },
    messageId,
  );
}

function enqueueCancel(current: Rig): void {
  enqueueCommand(current, 'invocation.cancel', {
    invocationId: 'invocation.r2d',
    attemptId: 'attempt.invocation.r2d',
    attempt: 1,
    reason: 'USER_CANCEL',
  });
}

async function startRunning(current: Rig): Promise<void> {
  const start = addStartInput(current);
  enqueuePrepare(current);
  await current.pump.tick();
  enqueueStart(current, start);
  await current.pump.tick();
  await waitForPhase(current, 'RUNNING');
}

function rawSqliteBytes(current: Rig): string {
  return readdirSync(current.root)
    .filter((name) => name.includes('sqlite'))
    .map((name) => readFileSync(join(current.root, name)).toString('latin1'))
    .join('\n');
}

function boundProxy<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get: (inner, property) => {
      const replacement = Reflect.get(overrides, property);
      if (replacement !== undefined) return replacement;
      const value = Reflect.get(inner, property, inner) as unknown;
      return typeof value === 'function' ? value.bind(inner) : value;
    },
  });
}
