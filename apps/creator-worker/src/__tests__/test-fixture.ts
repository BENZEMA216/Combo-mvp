import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFreshWorkerSqliteStore,
  openExistingWorkerSqliteStore,
  type WorkerSqliteOwner,
  type WorkerSqliteStore,
  type WorkerSqliteStoreOptions,
} from '@cb/creator-agent-broker-journal/sqlite-store';
import {
  createBrokerTransportFrame,
  type BrokerTransportPayload,
} from '@cb/creator-agent-protocol/broker-transport';
import {
  HostThreadSchema,
  type CreatorHost,
  type HostStartTurnInput,
  type HostThread,
} from '@cb/creator-agent-protocol/host';
import {
  HOST_INTERRUPT_WRITE_LINEARIZED,
  HostTurnIdSchema,
  createHostTurnAdapterController,
  type HostInterruptWriteRequest,
  type HostTurnAdapterController,
} from '@cb/creator-agent-protocol/host-adapter';
import {
  createFreshWorkerDurableTransportRepository,
  openExistingWorkerDurableTransportRepository,
  type WorkerDurableTransportRepository,
  type WorkerTransportConnectionCursor,
  type WorkerTransportOwner,
  type WorkerTransportStoreOptions,
} from '@cb/creator-worker-broker-client/sqlite-repository';
import type {
  WorkerBrokerWebSocketDriver,
  WorkerBrokerWebSocketDriverState,
} from '@cb/creator-worker-broker-client/websocket-driver';

import {
  createWorkerSerialPump,
  type WorkerSerialPump,
  type WorkerSerialPumpOptions,
} from '../index.js';

export const PROMPT_CANARY = 'PROMPT_CANARY_r2d_must_never_be_durable';
export const RESULT_CANARY = 'RESULT_CANARY_r2d_must_never_be_durable';
export const SEALED_FINGERPRINT = `sha256:${'b'.repeat(64)}`;

const THREAD = HostThreadSchema.parse({
  id: 'thread.r2d',
  generation: 1,
  workspaceRootsAcknowledged: true,
});

export class FakeHost implements CreatorHost {
  public readonly inputs: HostStartTurnInput[] = [];
  public readonly controllers: HostTurnAdapterController[] = [];
  public readonly interruptWrites: HostInterruptWriteRequest[] = [];
  public startCalls = 0;
  public startLifecycleCalls = 0;
  public stopCalls = 0;
  public startGate?: Promise<void>;
  public onInterruptWrite?: (controller: HostTurnAdapterController) => void;

  public async start(): Promise<void> {
    this.startLifecycleCalls += 1;
  }

  public async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  public async createThread(): Promise<HostThread> {
    return THREAD;
  }

  public async startTurn(input: HostStartTurnInput) {
    this.startCalls += 1;
    this.inputs.push(input);
    const controller = createHostTurnAdapterController({
      thread: input.thread,
      turnId: HostTurnIdSchema.parse(`turn.r2d.${this.startCalls}`),
      writeInterrupt: (request) => {
        this.interruptWrites.push(request);
        this.onInterruptWrite?.(controller);
        return HOST_INTERRUPT_WRITE_LINEARIZED;
      },
    });
    this.controllers.push(controller);
    await this.startGate;
    return controller.handle;
  }
}

export class FakeDriver implements Pick<WorkerBrokerWebSocketDriver, 'flush' | 'status'> {
  public status: WorkerBrokerWebSocketDriverState = 'READY';
  public flushCalls = 0;
  public flushResult: 'FLUSHED' | 'DEFERRED' = 'FLUSHED';
  public flushFailure?: Error;

  public async flush(): Promise<'FLUSHED' | 'DEFERRED'> {
    this.flushCalls += 1;
    if (this.flushFailure !== undefined) throw this.flushFailure;
    return this.flushResult;
  }
}

export type Rig = {
  readonly root: string;
  readonly journalOptions: WorkerSqliteStoreOptions;
  readonly transportOptions: WorkerTransportStoreOptions;
  journal: WorkerSqliteStore;
  journalOwner: WorkerSqliteOwner;
  transport: WorkerDurableTransportRepository;
  transportOwner: WorkerTransportOwner;
  connection: WorkerTransportConnectionCursor;
  readonly host: FakeHost;
  readonly driver: FakeDriver;
  readonly resolutions: Map<string, Readonly<{ input: unknown; inputFingerprint: string }>>;
  pump: WorkerSerialPump;
  sequence: number;
  closed: boolean;
};

export function createRig(options: Readonly<{ journalLeaseMs?: number }> = {}): Rig {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'combo-r2d-pump-'));
  chmodSync(root, 0o700);
  const journalOptions = {
    filename: join(root, 'journal.sqlite'),
    storeIdentity: 'journal.r2d',
  } satisfies WorkerSqliteStoreOptions;
  const transportOptions = {
    filename: join(root, 'transport.sqlite'),
    storeIdentity: 'transport.r2d',
    installationId: 'installation.r2d',
  } satisfies WorkerTransportStoreOptions;
  const journal = createFreshWorkerSqliteStore(journalOptions);
  const acquired = journal.acquireOwner({ leaseMs: options.journalLeaseMs ?? 30_000 });
  const transport = createFreshWorkerDurableTransportRepository(transportOptions);
  const transportOwner = transport.acquireOwner();
  const connection = transport.activateLease(
    transportOwner,
    frame(0, 'lease.r2d', {
      type: 'lease.grant',
      leaseExpiresAtMs: Date.now() + 300_000,
    }),
  );
  const rig: Rig = {
    root,
    journalOptions,
    transportOptions,
    journal,
    journalOwner: acquired.owner,
    transport,
    transportOwner,
    connection,
    host: new FakeHost(),
    driver: new FakeDriver(),
    resolutions: new Map(),
    pump: undefined as never,
    sequence: 0,
    closed: false,
  };
  rig.pump = makePump(rig, { preparedInvocations: acquired.prepared });
  return rig;
}

export function makePump(
  rig: Rig,
  overrides: Partial<WorkerSerialPumpOptions<{ ciphertext: string }>> = {},
): WorkerSerialPump {
  return createWorkerSerialPump({
    journal: rig.journal,
    journalOwner: rig.journalOwner,
    transport: rig.transport,
    transportOwner: rig.transportOwner,
    host: rig.host,
    driver: rig.driver,
    resolveStartInput: async (inputRef) => {
      const found = rig.resolutions.get(inputRef);
      if (found === undefined) throw new Error('input reference unavailable');
      return found;
    },
    sealResult: async () => ({
      sealedResultId: 'sealed.r2d',
      sealedFingerprint: SEALED_FINGERPRINT,
      envelope: { ciphertext: 'opaque.r2d' },
    }),
    ...overrides,
  });
}

export function addStartInput(rig: Rig, inputRef = 'input.r2d') {
  const inputFingerprint = fingerprint(PROMPT_CANARY);
  rig.resolutions.set(inputRef, {
    input: {
      thread: THREAD,
      messageId: 'message.r2d',
      text: PROMPT_CANARY,
      timeoutMs: 10_000,
    },
    inputFingerprint,
  });
  return { inputRef, inputFingerprint };
}

export function enqueueCommand(
  rig: Rig,
  commandType: string,
  payload: BrokerTransportPayload,
  messageId = `command.r2d.${rig.sequence + 1}`,
): string {
  rig.sequence += 1;
  rig.transport.commitInbound(
    rig.transportOwner,
    rig.connection,
    frame(rig.sequence, messageId, { type: 'command', commandType, payload }),
  );
  return messageId;
}

export function settleSuccess(rig: Rig, result = RESULT_CANARY): void {
  const controller = rig.host.controllers.at(-1);
  if (controller === undefined) throw new Error('Host controller is unavailable');
  controller.settle(
    {
      thread: controller.handle.thread,
      turnId: controller.handle.turnId,
      completedAt: Date.now(),
      terminalStatus: 'completed',
      terminalError: 'NONE',
      outputState: 'USABLE',
    },
    { text: result },
  );
}

export async function waitForPhase(
  rig: Rig,
  phase: string,
  invocationId = 'invocation.r2d',
): Promise<Record<string, unknown>> {
  return eventually(() => {
    const current = rig.journal.readInvocation(rig.journalOwner, invocationId);
    return current?.phase === phase ? (current.state as Record<string, unknown>) : undefined;
  });
}

export function reopenRig(rig: Rig): readonly unknown[] {
  rig.journal.close(rig.journalOwner);
  rig.transport.close(rig.transportOwner);
  const journal = openExistingWorkerSqliteStore(rig.journalOptions);
  const acquired = journal.acquireOwner();
  const transport = openExistingWorkerDurableTransportRepository(rig.transportOptions);
  rig.journal = journal;
  rig.journalOwner = acquired.owner;
  rig.transport = transport;
  rig.transportOwner = transport.acquireOwner();
  rig.closed = false;
  rig.pump = makePump(rig, { preparedInvocations: acquired.prepared });
  return acquired.recovered;
}

export async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await Promise.resolve();
  }
  throw new Error('Expected asynchronous state did not converge.');
}

export function closeRig(rig: Rig): void {
  if (!rig.closed) {
    try {
      rig.journal.close(rig.journalOwner);
    } catch {
      // A deliberate failpoint may already have closed or poisoned the store.
    }
    try {
      rig.transport.close(rig.transportOwner);
    } catch {
      // A deliberate failpoint may already have closed or poisoned the store.
    }
    rig.closed = true;
  }
  rmSync(rig.root, { recursive: true, force: true });
}

function frame(
  sequence: number,
  messageId: string,
  body: Parameters<typeof createBrokerTransportFrame>[0]['body'],
) {
  return createBrokerTransportFrame({
    direction: 'CLOUD_TO_WORKER',
    connectionId: 'connection.r2d',
    sequence,
    installationId: 'installation.r2d',
    deploymentId: 'deployment.r2d',
    workerSessionId: 'session.r2d',
    leaseId: 'lease.r2d',
    fence: 1,
    messageId,
    body,
  });
}

export function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
