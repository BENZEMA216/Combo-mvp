import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostThreadSchema } from '@cb/creator-agent-protocol/host';
import {
  HostTurnIdSchema,
  createHostTurnAdapterController,
  type HostTurnAdapterController,
} from '@cb/creator-agent-protocol/host-adapter';

import { workerInvocationAttemptId } from '../effect-authority.js';
import {
  executeWorkerHostStart,
  sealAndFinalizeWorkerHostSuccess,
  verifyAndProjectHostOutcome,
} from '../host-projection.js';
import { createWorkerResultSealAuthority } from '../result-seal.js';
import {
  workerSqliteStoreTestHooks,
  type WorkerSqliteFaultPoint,
  type WorkerSqliteStoreInternalOptions,
  type WorkerSqliteStoreTestHooks,
} from '../sqlite-store-internal.js';
import {
  createFreshWorkerSqliteStore,
  openExistingWorkerSqliteStore,
  type WorkerInvocationCursor,
  type WorkerSqliteOwner,
  type WorkerSqliteStore,
  type WorkerSqliteStoreErrorCode,
  type WorkerSqliteStoreOptions,
} from '../sqlite-store.js';

const TEST_NOW = 1_787_281_400_000;
const SEALED_FINGERPRINT = `sha256:${'b'.repeat(64)}`;

type TrackedStore = {
  store: WorkerSqliteStore;
  owner?: WorkerSqliteOwner;
};

type FaultController = {
  hooks: WorkerSqliteStoreTestHooks;
  arm(point: WorkerSqliteFaultPoint): void;
  setNow(value: number): void;
};

type RunningInvocation = {
  controller: HostTurnAdapterController;
  cursor: WorkerInvocationCursor;
  startHost: ReturnType<typeof vi.fn>;
};

const trackedStores: TrackedStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const tracked of [...trackedStores].reverse()) {
    try {
      tracked.store.close(tracked.owner);
    } catch {
      // The assertion that matters already ran. Poisoned and fenced stores close best-effort.
    }
  }
  trackedStores.length = 0;
  for (const directory of [...temporaryDirectories].reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

function privateDatabasePath(name = 'worker.sqlite'): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'combo-worker-store-'));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function options(
  filename: string,
  hooks: WorkerSqliteStoreTestHooks = {},
  storeIdentity = 'worker.store.test',
): WorkerSqliteStoreOptions {
  return {
    filename,
    storeIdentity,
    [workerSqliteStoreTestHooks]: hooks,
  } as WorkerSqliteStoreOptions & WorkerSqliteStoreInternalOptions;
}

function track(store: WorkerSqliteStore): TrackedStore {
  const tracked = { store };
  trackedStores.push(tracked);
  return tracked;
}

function fresh(
  filename: string,
  hooks: WorkerSqliteStoreTestHooks = {},
  storeIdentity = 'worker.store.test',
): TrackedStore {
  return track(createFreshWorkerSqliteStore(options(filename, hooks, storeIdentity)));
}

function reopen(
  filename: string,
  hooks: WorkerSqliteStoreTestHooks = {},
  storeIdentity = 'worker.store.test',
): TrackedStore {
  return track(openExistingWorkerSqliteStore(options(filename, hooks, storeIdentity)));
}

function acquire(tracked: TrackedStore, leaseMs = 10_000): WorkerSqliteOwner {
  const acquired = tracked.store.acquireOwner({ leaseMs });
  tracked.owner = acquired.owner;
  return acquired.owner;
}

function expectStoreError(action: () => unknown, code: WorkerSqliteStoreErrorCode): void {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

function faultController(initialNow = TEST_NOW): FaultController {
  let now = initialNow;
  let armed: WorkerSqliteFaultPoint | null = null;
  return {
    hooks: {
      now: () => now,
      fault: (point) => {
        if (point !== armed) return;
        armed = null;
        throw new Error(`injected ${point}`);
      },
    },
    arm: (point) => {
      armed = point;
    },
    setNow: (value) => {
      now = value;
    },
  };
}

function scalar(database: DatabaseSync, sql: string): unknown {
  const row = database.prepare(sql).get() as Record<string, unknown>;
  return Object.values(row)[0];
}

function createController(suffix: string): HostTurnAdapterController {
  return createHostTurnAdapterController({
    thread: HostThreadSchema.parse({
      id: `thread.store.${suffix}`,
      generation: 1,
      workspaceRootsAcknowledged: true,
    }),
    turnId: HostTurnIdSchema.parse(`turn.store.${suffix}`),
    writeInterrupt: () => {
      throw new Error('interrupt is outside this test');
    },
  });
}

function settledObservation(controller: HostTurnAdapterController): unknown {
  return {
    thread: controller.handle.thread,
    turnId: controller.handle.turnId,
    completedAt: TEST_NOW + 10,
    terminalStatus: 'completed',
    terminalError: 'NONE',
    outputState: 'USABLE',
  };
}

async function advanceToRunning(
  tracked: TrackedStore,
  invocationId: string,
  suffix: string,
  beforeStarted?: () => void,
): Promise<RunningInvocation> {
  const owner = tracked.owner;
  if (owner === undefined) throw new Error('store owner is required');
  const prepared = tracked.store.prepareInvocation(owner, {
    invocationId,
    operationId: `prepare.${suffix}`,
  });
  if (prepared.cursor === null) throw new Error('expected PREPARED cursor');
  const dispatched = tracked.store.commitInvocationEvent(owner, prepared.cursor, {
    operationId: `dispatch.${suffix}`,
    event: {
      type: 'DISPATCH_INTENT_RECORDED',
      attemptId: workerInvocationAttemptId(`attempt.${suffix}`),
    },
  });
  const committedStart = dispatched.afterCommit[0];
  if (committedStart?.type !== 'START_HOST' || dispatched.cursor === null) {
    throw new Error('expected committed START_HOST effect');
  }
  const controller = createController(suffix);
  const startHost = vi.fn(async () => controller.handle);
  const disposition = await executeWorkerHostStart(committedStart, startHost);
  beforeStarted?.();
  const running = tracked.store.commitInvocationEvent(owner, dispatched.cursor, {
    operationId: `started.${suffix}`,
    event: { type: 'HOST_START_DISPOSITION_RECORDED', disposition },
  });
  if (running.cursor === null || running.invocation.phase !== 'RUNNING') {
    throw new Error('expected RUNNING cursor');
  }
  return { controller, cursor: running.cursor, startHost };
}

async function successfulTerminal(
  controller: HostTurnAdapterController,
  plaintext: string,
  suffix: string,
  envelope: Readonly<Record<string, unknown>>,
) {
  const outcome = controller.settle(settledObservation(controller), { text: plaintext });
  const verified = verifyAndProjectHostOutcome(controller.handle, outcome);
  if (verified.status !== 'SUCCESS_REQUIRES_SEAL') throw new Error('expected Host success');
  const authority = createWorkerResultSealAuthority(async () => ({
    sealedResultId: `sealed.${suffix}`,
    sealedFingerprint: SEALED_FINGERPRINT,
    envelope,
  }));
  const terminal = await sealAndFinalizeWorkerHostSuccess(verified, authority);
  return { authority, terminal };
}

describe('Worker SQLite store', () => {
  it('creates and reopens only the exact private SQLite v1 schema', () => {
    const filename = privateDatabasePath();
    const created = fresh(filename);

    expect(statSync(filename).mode & 0o777).toBe(0o600);
    created.store.close();
    const database = new DatabaseSync(filename);
    try {
      expect(scalar(database, 'PRAGMA application_id')).toBe(0x4342494a);
      expect(scalar(database, 'PRAGMA user_version')).toBe(1);
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name LIKE 'worker_%' ORDER BY name`,
          )
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual([
        'worker_invocation_events',
        'worker_invocation_outbox',
        'worker_invocations',
        'worker_sealed_results',
        'worker_store_meta',
        'worker_store_owner',
      ]);
      expect(scalar(database, 'PRAGMA integrity_check')).toBe('ok');
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }

    const opened = reopen(filename);
    const owner = acquire(opened);
    expect(opened.store.readInvocation(owner, 'missing.invocation')).toBeNull();
    expectStoreError(() => createFreshWorkerSqliteStore(options(filename)), 'STORE_EXISTS');
  });

  it('makes operation replay exact and rejects conflicting operation or Invocation reuse', () => {
    const tracked = fresh(privateDatabasePath());
    const owner = acquire(tracked);
    const prepared = tracked.store.prepareInvocation(owner, {
      invocationId: 'invocation.replay',
      operationId: 'operation.prepare.replay',
    });
    if (prepared.cursor === null) throw new Error('expected PREPARED cursor');

    const replay = tracked.store.prepareInvocation(owner, {
      invocationId: 'invocation.replay',
      operationId: 'operation.prepare.replay',
    });
    expect(replay).toMatchObject({ disposition: 'EXACT_REPLAY', cursor: prepared.cursor });
    expect(replay.afterCommit).toEqual([]);
    expectStoreError(
      () =>
        tracked.store.prepareInvocation(owner, {
          invocationId: 'invocation.other',
          operationId: 'operation.prepare.replay',
        }),
      'OPERATION_CONFLICT',
    );
    expectStoreError(
      () =>
        tracked.store.prepareInvocation(owner, {
          invocationId: 'invocation.replay',
          operationId: 'operation.prepare.other',
        }),
      'INVOCATION_CONFLICT',
    );

    const dispatchEvent = {
      type: 'DISPATCH_INTENT_RECORDED' as const,
      attemptId: workerInvocationAttemptId('attempt.replay'),
    };
    const dispatched = tracked.store.commitInvocationEvent(owner, prepared.cursor, {
      operationId: 'operation.dispatch.replay',
      event: dispatchEvent,
    });
    const dispatchReplay = tracked.store.commitInvocationEvent(owner, prepared.cursor, {
      operationId: 'operation.dispatch.replay',
      event: dispatchEvent,
    });
    expect(dispatchReplay.disposition).toBe('EXACT_REPLAY');
    expect(dispatchReplay.cursor).toBe(dispatched.cursor);
    expect(dispatchReplay.afterCommit).toEqual([]);
    expectStoreError(
      () =>
        tracked.store.commitInvocationEvent(owner, prepared.cursor!, {
          operationId: 'operation.dispatch.replay',
          event: { type: 'CANCEL_PROVEN_NOT_DISPATCHED' },
        }),
      'OPERATION_CONFLICT',
    );
  });

  it('rejects foreign, cloned, and structurally forged owner and cursor capabilities', () => {
    const first = fresh(privateDatabasePath('first.sqlite'), {}, 'worker.store.first');
    const second = fresh(privateDatabasePath('second.sqlite'), {}, 'worker.store.second');
    const firstOwner = acquire(first);
    const secondOwner = acquire(second);
    const firstPrepared = first.store.prepareInvocation(firstOwner, {
      invocationId: 'invocation.first',
      operationId: 'prepare.first',
    });
    const secondPrepared = second.store.prepareInvocation(secondOwner, {
      invocationId: 'invocation.second',
      operationId: 'prepare.second',
    });
    if (firstPrepared.cursor === null || secondPrepared.cursor === null) {
      throw new Error('expected PREPARED cursors');
    }

    expectStoreError(
      () => second.store.readInvocation(firstOwner, 'invocation.second'),
      'OWNER_STALE',
    );
    expectStoreError(
      () =>
        second.store.readInvocation(
          JSON.parse(JSON.stringify(secondOwner)) as WorkerSqliteOwner,
          'invocation.second',
        ),
      'OWNER_STALE',
    );
    expectStoreError(
      () =>
        second.store.commitInvocationEvent(secondOwner, firstPrepared.cursor!, {
          operationId: 'cancel.foreign',
          event: { type: 'CANCEL_PROVEN_NOT_DISPATCHED' },
        }),
      'CURSOR_STALE',
    );
    expectStoreError(
      () =>
        first.store.commitInvocationEvent(
          firstOwner,
          JSON.parse(JSON.stringify(firstPrepared.cursor)) as WorkerInvocationCursor,
          {
            operationId: 'cancel.cloned',
            event: { type: 'CANCEL_PROVEN_NOT_DISPATCHED' },
          },
        ),
      'CURSOR_STALE',
    );
  });

  it('returns an executable START_HOST capability only after the dispatch commit', async () => {
    const tracked = fresh(privateDatabasePath());
    const owner = acquire(tracked);
    const prepared = tracked.store.prepareInvocation(owner, {
      invocationId: 'invocation.dispatch',
      operationId: 'prepare.dispatch',
    });
    if (prepared.cursor === null) throw new Error('expected PREPARED cursor');
    const dispatched = tracked.store.commitInvocationEvent(owner, prepared.cursor, {
      operationId: 'dispatch.commit',
      event: {
        type: 'DISPATCH_INTENT_RECORDED',
        attemptId: workerInvocationAttemptId('attempt.dispatch'),
      },
    });
    const effect = dispatched.afterCommit[0];
    if (effect?.type !== 'START_HOST' || dispatched.cursor === null) {
      throw new Error('expected committed START_HOST');
    }
    expect(effect.commit).toEqual({
      invocationId: 'invocation.dispatch',
      revision: 1,
      ownerEpoch: owner.epoch,
    });

    const controller = createController('dispatch');
    const startHost = vi.fn(async () => controller.handle);
    expect(() =>
      executeWorkerHostStart(JSON.parse(JSON.stringify(effect)) as never, startHost),
    ).toThrow(/Committed Worker START_HOST effect/u);
    expect(startHost).not.toHaveBeenCalled();
    const disposition = await executeWorkerHostStart(effect, startHost);
    expect(startHost).toHaveBeenCalledTimes(1);
    const running = tracked.store.commitInvocationEvent(owner, dispatched.cursor, {
      operationId: 'dispatch.started',
      event: { type: 'HOST_START_DISPOSITION_RECORDED', disposition },
    });
    expect(running.invocation.phase).toBe('RUNNING');
    expect(running.outboxFacts).toMatchObject([{ factType: 'STARTED' }]);
  });

  it.each(['close', 'poison'] as const)(
    'invalidates a committed START_HOST before Host callback after Store %s',
    (termination) => {
      const faults = faultController();
      const tracked = fresh(privateDatabasePath(), faults.hooks);
      const owner = acquire(tracked);
      const prepared = tracked.store.prepareInvocation(owner, {
        invocationId: `invocation.effect.${termination}`,
        operationId: `prepare.effect.${termination}`,
      });
      if (prepared.cursor === null) throw new Error('expected PREPARED cursor');
      const dispatched = tracked.store.commitInvocationEvent(owner, prepared.cursor, {
        operationId: `dispatch.effect.${termination}`,
        event: {
          type: 'DISPATCH_INTENT_RECORDED',
          attemptId: workerInvocationAttemptId(`attempt.effect.${termination}`),
        },
      });
      const effect = dispatched.afterCommit[0];
      if (effect?.type !== 'START_HOST') throw new Error('expected committed START_HOST');

      if (termination === 'close') {
        tracked.store.close(owner);
      } else {
        faults.arm('AFTER_SQL_COMMIT');
        expectStoreError(
          () =>
            tracked.store.prepareInvocation(owner, {
              invocationId: 'invocation.poison.trigger',
              operationId: 'prepare.poison.trigger',
            }),
          'STORE_COMMIT_UNKNOWN',
        );
      }

      const startHost = vi.fn();
      expect(() => executeWorkerHostStart(effect, startHost)).toThrowError(
        expect.objectContaining({ code: 'STORE_CLOSED' }),
      );
      expect(startHost).not.toHaveBeenCalled();
    },
  );

  it.each(['AFTER_EVENT_INSERT', 'AFTER_INVOCATION_UPDATE', 'BEFORE_SQL_COMMIT'] as const)(
    'rolls dispatch fully back at %s',
    (point) => {
      const faults = faultController();
      const filename = privateDatabasePath();
      const tracked = fresh(filename, faults.hooks);
      const owner = acquire(tracked);
      const prepared = tracked.store.prepareInvocation(owner, {
        invocationId: `invocation.rollback.${point}`,
        operationId: `prepare.rollback.${point}`,
      });
      if (prepared.cursor === null) throw new Error('expected PREPARED cursor');
      const input = {
        operationId: `dispatch.rollback.${point}`,
        event: {
          type: 'DISPATCH_INTENT_RECORDED' as const,
          attemptId: workerInvocationAttemptId(`attempt.rollback.${point}`),
        },
      };

      faults.arm(point);
      expectStoreError(
        () => tracked.store.commitInvocationEvent(owner, prepared.cursor!, input),
        'STORE_IO',
      );
      expect(tracked.store.readInvocation(owner, `invocation.rollback.${point}`)).toMatchObject({
        revision: 0,
        phase: 'PREPARED',
      });
      expect(tracked.store.readPendingFacts(owner)).toEqual([]);

      const retry = tracked.store.commitInvocationEvent(owner, prepared.cursor, input);
      expect(retry).toMatchObject({ disposition: 'APPLIED', invocation: { revision: 1 } });
    },
  );

  it.each(['AFTER_SEALED_RESULT_INSERT', 'AFTER_OUTBOX_INSERT'] as const)(
    'rolls the success event, seal, state, and terminal outbox back at %s',
    async (point) => {
      const faults = faultController();
      const filename = privateDatabasePath();
      const tracked = fresh(filename, faults.hooks);
      const owner = acquire(tracked);
      const running = await advanceToRunning(
        tracked,
        `invocation.success.rollback.${point}`,
        `success.rollback.${point}`,
      );
      const sealed = await successfulTerminal(
        running.controller,
        'plaintext must roll back',
        `rollback.${point}`,
        { ciphertext: 'opaque' },
      );
      const input = {
        operationId: `terminal.rollback.${point}`,
        event: { type: 'HOST_TERMINAL_CONFIRMED' as const, terminal: sealed.terminal },
        resultSealAuthority: sealed.authority,
      };

      faults.arm(point);
      expectStoreError(
        () => tracked.store.commitInvocationEvent(owner, running.cursor, input),
        'STORE_IO',
      );
      expect(
        tracked.store.readInvocation(owner, `invocation.success.rollback.${point}`),
      ).toMatchObject({ revision: 2, phase: 'RUNNING', sealedResultId: null });
      expect(tracked.store.readPendingFacts(owner)).toMatchObject([{ factType: 'STARTED' }]);

      const retry = tracked.store.commitInvocationEvent(owner, running.cursor, input);
      expect(retry).toMatchObject({
        disposition: 'APPLIED',
        invocation: { phase: 'TERMINAL_READY' },
        outboxFacts: [{ factType: 'TERMINAL' }],
      });
    },
  );

  it('treats an unobserved committed dispatch as ambiguous and recovers it once without Host I/O', () => {
    const faults = faultController();
    const filename = privateDatabasePath();
    const first = fresh(filename, faults.hooks);
    const firstOwner = acquire(first, 1_000);
    const prepared = first.store.prepareInvocation(firstOwner, {
      invocationId: 'invocation.ambiguous',
      operationId: 'prepare.ambiguous',
    });
    if (prepared.cursor === null) throw new Error('expected PREPARED cursor');
    const startHost = vi.fn();

    faults.arm('AFTER_SQL_COMMIT');
    expectStoreError(
      () =>
        first.store.commitInvocationEvent(firstOwner, prepared.cursor!, {
          operationId: 'dispatch.ambiguous',
          event: {
            type: 'DISPATCH_INTENT_RECORDED',
            attemptId: workerInvocationAttemptId('attempt.ambiguous'),
          },
        }),
      'STORE_COMMIT_UNKNOWN',
    );
    expect(startHost).not.toHaveBeenCalled();
    expectStoreError(
      () => first.store.readInvocation(firstOwner, 'invocation.ambiguous'),
      'STORE_CLOSED',
    );

    faults.setNow(TEST_NOW + 1_001);
    const second = reopen(filename, faults.hooks);
    const acquired = second.store.acquireOwner({ leaseMs: 1_000 });
    second.owner = acquired.owner;
    expect(acquired.recovered).toMatchObject([
      {
        invocationId: 'invocation.ambiguous',
        fromPhase: 'DISPATCHING',
        toRevision: 2,
        terminalFact: { factType: 'TERMINAL' },
      },
    ]);
    expect(second.store.readInvocation(acquired.owner, 'invocation.ambiguous')).toMatchObject({
      revision: 2,
      phase: 'TERMINAL_READY',
      state: { terminal: { outcome: 'UNCERTAIN', reason: 'PROCESS_RESTART_WITH_DISPATCH_INTENT' } },
    });
    expect(second.store.readPendingFacts(acquired.owner)).toMatchObject([{ factType: 'TERMINAL' }]);
    expect(startHost).not.toHaveBeenCalled();

    second.store.close(acquired.owner);
    const third = reopen(filename, faults.hooks);
    const thirdAcquired = third.store.acquireOwner({ leaseMs: 1_000 });
    third.owner = thirdAcquired.owner;
    expect(thirdAcquired.recovered).toEqual([]);
    expect(third.store.readPendingFacts(thirdAcquired.owner)).toHaveLength(1);
  });

  it('binds recovery to its exact source row and closes a failed open before repair', () => {
    const filename = privateDatabasePath();
    const first = fresh(filename);
    const owner = acquire(first);
    for (const suffix of ['one', 'two']) {
      const prepared = first.store.prepareInvocation(owner, {
        invocationId: `invocation.recovery.${suffix}`,
        operationId: `prepare.recovery.${suffix}`,
      });
      if (prepared.cursor === null) throw new Error('expected PREPARED cursor');
      first.store.commitInvocationEvent(owner, prepared.cursor, {
        operationId: `dispatch.recovery.${suffix}`,
        event: {
          type: 'DISPATCH_INTENT_RECORDED',
          attemptId: workerInvocationAttemptId(`attempt.recovery.${suffix}`),
        },
      });
    }
    first.store.close(owner);

    const database = new DatabaseSync(filename);
    const rows = database
      .prepare(
        `SELECT invocation_id, recovery_json, recovery_fingerprint
           FROM worker_invocations ORDER BY invocation_id`,
      )
      .all() as Array<{
      invocation_id: string;
      recovery_json: string;
      recovery_fingerprint: string;
    }>;
    const [one, two] = rows;
    if (one === undefined || two === undefined) throw new Error('expected two recovery rows');
    const update = database.prepare(
      `UPDATE worker_invocations SET recovery_json = ?, recovery_fingerprint = ?
       WHERE invocation_id = ?`,
    );
    update.run(two.recovery_json, two.recovery_fingerprint, one.invocation_id);
    update.run(one.recovery_json, one.recovery_fingerprint, two.invocation_id);
    database.close();

    expectStoreError(() => openExistingWorkerSqliteStore(options(filename)), 'STORE_CORRUPT');
    const repair = new DatabaseSync(filename, { timeout: 100 });
    const repairUpdate = repair.prepare(
      `UPDATE worker_invocations SET recovery_json = ?, recovery_fingerprint = ?
       WHERE invocation_id = ?`,
    );
    repairUpdate.run(one.recovery_json, one.recovery_fingerprint, one.invocation_id);
    repairUpdate.run(two.recovery_json, two.recovery_fingerprint, two.invocation_id);
    repair.close();
    const reopened = reopen(filename);
    expect(reopened.store.acquireOwner().recovered).toHaveLength(2);
  });

  it('replays a terminal operation exactly after restart without reconstructing a cursor', () => {
    const filename = privateDatabasePath();
    const first = fresh(filename);
    const owner = acquire(first);
    const prepared = first.store.prepareInvocation(owner, {
      invocationId: 'invocation.terminal-replay',
      operationId: 'prepare.terminal-replay',
    });
    if (prepared.cursor === null) throw new Error('expected PREPARED cursor');
    first.store.commitInvocationEvent(owner, prepared.cursor, {
      operationId: 'cancel.terminal-replay',
      event: { type: 'CANCEL_PROVEN_NOT_DISPATCHED' },
    });
    first.store.close(owner);

    const second = reopen(filename);
    const acquired = second.store.acquireOwner();
    second.owner = acquired.owner;
    expect(acquired.prepared).toEqual([]);
    expect(
      second.store.replayInvocationEvent(acquired.owner, {
        invocationId: 'invocation.terminal-replay',
        operationId: 'cancel.terminal-replay',
        event: { type: 'CANCEL_PROVEN_NOT_DISPATCHED' },
      }),
    ).toMatchObject({
      disposition: 'EXACT_REPLAY',
      invocation: { phase: 'TERMINAL_READY' },
      cursor: null,
      outboxFacts: [{ factType: 'TERMINAL' }],
      afterCommit: [],
    });
    expect(
      second.store.replayInvocationEvent(acquired.owner, {
        invocationId: 'invocation.terminal-replay',
        operationId: 'unknown.terminal-replay',
        event: { type: 'CANCEL_PROVEN_NOT_DISPATCHED' },
      }),
    ).toBeNull();
    expectStoreError(
      () =>
        second.store.replayInvocationEvent(acquired.owner, {
          invocationId: 'invocation.terminal-replay',
          operationId: 'cancel.terminal-replay',
          event: { type: 'PROCESS_RECOVERY_WITHOUT_HANDLE' },
        }),
      'OPERATION_CONFLICT',
    );
  });

  it('rejects a terminal fact rebound to another event of the same Invocation', () => {
    const filename = privateDatabasePath();
    const tracked = fresh(filename);
    const owner = acquire(tracked);
    const prepared = tracked.store.prepareInvocation(owner, {
      invocationId: 'invocation.operation-binding',
      operationId: 'prepare.operation-binding',
    });
    if (prepared.cursor === null) throw new Error('expected PREPARED cursor');
    tracked.store.commitInvocationEvent(owner, prepared.cursor, {
      operationId: 'cancel.operation-binding',
      event: { type: 'CANCEL_PROVEN_NOT_DISPATCHED' },
    });
    tracked.store.close(owner);
    const database = new DatabaseSync(filename);
    database
      .prepare('UPDATE worker_invocation_outbox SET operation_id = ? WHERE fact_type = ?')
      .run('prepare.operation-binding', 'TERMINAL');
    database.close();
    expectStoreError(() => openExistingWorkerSqliteStore(options(filename)), 'STORE_CORRUPT');
  });

  it('blocks takeover while the exclusive connection lives, then fences old capabilities', () => {
    const faults = faultController();
    const filename = privateDatabasePath();
    const first = fresh(filename, faults.hooks);
    const firstOwner = acquire(first, 1_000);
    const prepared = first.store.prepareInvocation(firstOwner, {
      invocationId: 'invocation.fenced',
      operationId: 'prepare.fenced',
    });
    if (prepared.cursor === null) throw new Error('expected PREPARED cursor');
    expectStoreError(
      () => openExistingWorkerSqliteStore(options(filename, faults.hooks)),
      'STORE_BUSY',
    );
    faults.setNow(TEST_NOW + 1_001);
    expectStoreError(
      () => openExistingWorkerSqliteStore(options(filename, faults.hooks)),
      'STORE_BUSY',
    );
    expectStoreError(
      () => first.store.readInvocation(firstOwner, 'invocation.fenced'),
      'OWNER_EXPIRED',
    );
    first.store.close(firstOwner);

    const second = reopen(filename, faults.hooks);
    const takeover = second.store.acquireOwner({ leaseMs: 1_000 });
    second.owner = takeover.owner;
    expect(takeover.owner.epoch).toBe(firstOwner.epoch + 1);
    expect(takeover.prepared).toHaveLength(1);
    expectStoreError(
      () => first.store.readInvocation(firstOwner, 'invocation.fenced'),
      'STORE_CLOSED',
    );
    expectStoreError(
      () =>
        second.store.commitInvocationEvent(takeover.owner, prepared.cursor!, {
          operationId: 'cancel.old-cursor',
          event: { type: 'CANCEL_PROVEN_NOT_DISPATCHED' },
        }),
      'CURSOR_STALE',
    );
    const recoveredCursor = takeover.prepared[0];
    if (recoveredCursor === undefined) throw new Error('expected reconstructed PREPARED cursor');
    expect(
      second.store.commitInvocationEvent(takeover.owner, recoveredCursor, {
        operationId: 'cancel.new-owner',
        event: { type: 'CANCEL_PROVEN_NOT_DISPATCHED' },
      }).invocation.phase,
    ).toBe('TERMINAL_READY');
  });

  it('atomically persists a sealed success without persisting Host plaintext', async () => {
    const filename = privateDatabasePath();
    const tracked = fresh(filename);
    const owner = acquire(tracked);
    const running = await advanceToRunning(tracked, 'invocation.sealed', 'sealed');
    const plaintext = 'HOST-PLAINTEXT-CANARY-3b68d8a7';
    const envelope = Object.freeze({ ciphertext: 'opaque-ciphertext', keyVersion: 7 });
    const sealed = await successfulTerminal(running.controller, plaintext, 'success', envelope);
    const operationId = 'terminal.sealed';
    const input = {
      operationId,
      event: { type: 'HOST_TERMINAL_CONFIRMED' as const, terminal: sealed.terminal },
      resultSealAuthority: sealed.authority,
    };

    const fakeAuthority = { read: sealed.authority.read } as typeof sealed.authority;
    expect(() =>
      tracked.store.commitInvocationEvent(owner, running.cursor, {
        ...input,
        resultSealAuthority: fakeAuthority,
      }),
    ).toThrowError();
    expect(tracked.store.readInvocation(owner, 'invocation.sealed')).toMatchObject({
      phase: 'RUNNING',
      sealedResultId: null,
    });
    expect(tracked.store.readPendingFacts(owner)).toMatchObject([{ factType: 'STARTED' }]);

    const committed = tracked.store.commitInvocationEvent(owner, running.cursor, input);
    expect(committed).toMatchObject({
      disposition: 'APPLIED',
      invocation: { phase: 'TERMINAL_READY', sealedResultId: 'sealed.success' },
      outboxFacts: [{ factType: 'TERMINAL', sealedResultId: 'sealed.success', operationId }],
    });
    expect(committed.afterCommit).toEqual([]);
    expect(tracked.store.readPendingFacts(owner)).toMatchObject([
      { factType: 'STARTED', sealedResultId: null },
      { factType: 'TERMINAL', sealedResultId: 'sealed.success' },
    ]);
    const restored = tracked.store.readSealedEnvelope<typeof envelope>(owner, 'sealed.success');
    expect(restored).toEqual(envelope);
    expect(Object.isFrozen(restored)).toBe(true);

    const replay = tracked.store.commitInvocationEvent(owner, running.cursor, input);
    expect(replay.disposition).toBe('EXACT_REPLAY');
    expect(replay.afterCommit).toEqual([]);
    expect(replay.outboxFacts).toMatchObject([{ factType: 'TERMINAL' }]);

    const canary = Buffer.from(plaintext, 'utf8');
    for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
      if (!existsSync(path)) continue;
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(readFileSync(path).includes(canary), `${path} leaked Host plaintext`).toBe(false);
    }
    expect(running.startHost).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'equal timestamps', startedAt: TEST_NOW, terminalAt: TEST_NOW },
    { label: 'a backward wall clock', startedAt: TEST_NOW + 1_000, terminalAt: TEST_NOW + 500 },
  ])('keeps STARTED before TERMINAL under $label', async ({ startedAt, terminalAt }) => {
    const faults = faultController();
    const filename = privateDatabasePath();
    const tracked = fresh(filename, faults.hooks);
    const owner = acquire(tracked);
    const running = await advanceToRunning(tracked, 'inv.0', 'causal-order', () => {
      faults.setNow(startedAt);
    });
    faults.setNow(terminalAt);
    const sealed = await successfulTerminal(
      running.controller,
      'ephemeral ordered result',
      'causal-order',
      { ciphertext: 'opaque' },
    );
    tracked.store.commitInvocationEvent(owner, running.cursor, {
      operationId: 'terminal.causal-order',
      event: { type: 'HOST_TERMINAL_CONFIRMED', terminal: sealed.terminal },
      resultSealAuthority: sealed.authority,
    });
    expect(tracked.store.readPendingFacts(owner).map(({ factType }) => factType)).toEqual([
      'STARTED',
      'TERMINAL',
    ]);
  });

  it.each([
    {
      label: 'swapped outbox payloads',
      mutate(database: DatabaseSync) {
        const rows = database
          .prepare(
            'SELECT fact_type, payload_json, payload_fingerprint FROM worker_invocation_outbox',
          )
          .all() as Array<{
          fact_type: string;
          payload_json: string;
          payload_fingerprint: string;
        }>;
        const started = rows.find(({ fact_type }) => fact_type === 'STARTED');
        const terminal = rows.find(({ fact_type }) => fact_type === 'TERMINAL');
        if (started === undefined || terminal === undefined) throw new Error('expected both facts');
        const update = database.prepare(
          'UPDATE worker_invocation_outbox SET payload_json = ?, payload_fingerprint = ? WHERE fact_type = ?',
        );
        update.run(terminal.payload_json, terminal.payload_fingerprint, 'STARTED');
        update.run(started.payload_json, started.payload_fingerprint, 'TERMINAL');
      },
    },
    {
      label: 'a drifted sealed-result fingerprint',
      mutate(database: DatabaseSync) {
        database
          .prepare('UPDATE worker_sealed_results SET result_fingerprint = ?')
          .run(`sha256:${'c'.repeat(64)}`);
      },
    },
  ])('rejects $label across the terminal storage graph', async ({ mutate }) => {
    const filename = privateDatabasePath();
    const tracked = fresh(filename);
    const owner = acquire(tracked);
    const running = await advanceToRunning(tracked, 'invocation.cross-bind', 'cross-bind');
    const sealed = await successfulTerminal(
      running.controller,
      'ephemeral cross-binding result',
      'cross-bind',
      { ciphertext: 'opaque' },
    );
    tracked.store.commitInvocationEvent(owner, running.cursor, {
      operationId: 'terminal.cross-bind',
      event: { type: 'HOST_TERMINAL_CONFIRMED', terminal: sealed.terminal },
      resultSealAuthority: sealed.authority,
    });
    tracked.store.close(owner);
    const database = new DatabaseSync(filename);
    mutate(database);
    database.close();
    expectStoreError(() => openExistingWorkerSqliteStore(options(filename)), 'STORE_CORRUPT');
  });

  it('rejects an oversized sealed envelope without a partial terminal commit', async () => {
    const filename = privateDatabasePath();
    const tracked = fresh(filename);
    const owner = acquire(tracked);
    const running = await advanceToRunning(tracked, 'invocation.oversized', 'oversized');
    const sealed = await successfulTerminal(
      running.controller,
      'ephemeral oversized result',
      'oversized',
      { ciphertext: 'x'.repeat(65_536) },
    );

    expectStoreError(
      () =>
        tracked.store.commitInvocationEvent(owner, running.cursor, {
          operationId: 'terminal.oversized',
          event: { type: 'HOST_TERMINAL_CONFIRMED', terminal: sealed.terminal },
          resultSealAuthority: sealed.authority,
        }),
      'SEALED_RESULT_INVALID',
    );
    expect(tracked.store.readInvocation(owner, 'invocation.oversized')).toMatchObject({
      revision: 2,
      phase: 'RUNNING',
      sealedResultId: null,
    });
    expect(tracked.store.readPendingFacts(owner)).toMatchObject([{ factType: 'STARTED' }]);
  });

  it('fails closed for missing, unsafe, foreign, and catalog-modified database files', () => {
    const missing = privateDatabasePath('missing.sqlite');
    expectStoreError(() => openExistingWorkerSqliteStore(options(missing)), 'STORE_MISSING');

    const unsafe = privateDatabasePath('unsafe.sqlite');
    const unsafeDatabase = new DatabaseSync(unsafe);
    unsafeDatabase.close();
    chmodSync(unsafe, 0o644);
    expectStoreError(() => openExistingWorkerSqliteStore(options(unsafe)), 'STORE_FILE_UNSAFE');

    const foreign = privateDatabasePath('foreign.sqlite');
    const foreignDatabase = new DatabaseSync(foreign);
    foreignDatabase.exec('PRAGMA application_id = 7');
    foreignDatabase.close();
    chmodSync(foreign, 0o600);
    expectStoreError(
      () => openExistingWorkerSqliteStore(options(foreign)),
      'STORE_SCHEMA_MISMATCH',
    );

    const modified = privateDatabasePath('modified.sqlite');
    const created = fresh(modified);
    created.store.close();
    const modifier = new DatabaseSync(modified);
    modifier.exec('CREATE TABLE unexpected_schema(value TEXT) STRICT');
    modifier.close();
    expectStoreError(() => openExistingWorkerSqliteStore(options(modified)), 'STORE_CORRUPT');
  });

  it('rejects canonical event objects with extra fields before any durable write', () => {
    const filename = privateDatabasePath();
    const tracked = fresh(filename);
    const owner = acquire(tracked);
    const prepared = tracked.store.prepareInvocation(owner, {
      invocationId: 'invocation.extra-field',
      operationId: 'prepare.extra-field',
    });
    if (prepared.cursor === null) throw new Error('expected PREPARED cursor');

    expect(() =>
      tracked.store.commitInvocationEvent(owner, prepared.cursor!, {
        operationId: 'dispatch.extra-field',
        event: {
          type: 'DISPATCH_INTENT_RECORDED',
          attemptId: workerInvocationAttemptId('attempt.extra-field'),
          unexpected: true,
        } as never,
      }),
    ).toThrow(/must contain exactly/u);
    expect(tracked.store.readInvocation(owner, 'invocation.extra-field')).toMatchObject({
      revision: 0,
      phase: 'PREPARED',
    });
    expect(
      tracked.store.commitInvocationEvent(owner, prepared.cursor, {
        operationId: 'dispatch.extra-field',
        event: {
          type: 'DISPATCH_INTENT_RECORDED',
          attemptId: workerInvocationAttemptId('attempt.extra-field'),
        },
      }).disposition,
    ).toBe('APPLIED');
  });
});
