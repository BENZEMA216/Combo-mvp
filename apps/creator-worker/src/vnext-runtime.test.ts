import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HostTurnRegistry,
  type WorkerCommandPumpTickResult,
} from '@cb/creator-worker-broker-client';

import type { CodexHost, HostThread, HostTurnHandle } from './host-types.js';
import {
  VnextCreatorWorkerRuntime,
  type VnextRuntimeBrokerPort,
  type VnextRuntimePumpPort,
  type VnextRuntimeTransportPort,
} from './vnext-runtime.js';

const INSTALLATION_ID = '00000000-0000-7000-8000-000000000001';
const OWNER_TOKEN = 'vnext-runtime-owner-token-0123456789';
const createdRuntimes: VnextCreatorWorkerRuntime[] = [];

afterEach(async () => {
  const runtimes = createdRuntimes.splice(0);
  await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
});

describe('VnextCreatorWorkerRuntime', () => {
  it('recovers before Host/Broker effects, reaches READY, drains evidence, and stops in order', async () => {
    const order: string[] = [];
    const fixture = createRuntime({ order });

    await fixture.runtime.start();
    await fixture.runtime.waitUntilReady(AbortSignal.timeout(1_000));
    expect(fixture.runtime.status).toBe('READY');
    expect(order.slice(0, 4)).toEqual([
      'owner.acquire',
      'pump.recover',
      'host.start',
      'broker.start',
    ]);

    await fixture.runtime.stop();
    expect(fixture.runtime.status).toBe('STOPPED');
    expect(order).toContain('pump.wait-terminals');
    expect(order).toContain('pump.drain-evidence');
    expect(order.indexOf('pump.wait-terminals')).toBeLessThan(order.indexOf('broker.stop'));
    expect(order.indexOf('pump.drain-evidence')).toBeLessThan(order.indexOf('broker.stop'));
    expect(order.indexOf('broker.stop')).toBeLessThan(order.indexOf('host.stop'));
    expect(order.at(-1)).toBe('transport.close');
  });

  it('never reports READY when process-start recovery finds durable conversations to reattach', async () => {
    const fixture = createRuntime({ readyConversationsNeedingReattach: 1 });
    await fixture.runtime.start();
    expect(fixture.runtime.status).toBe('BLOCKED');
    await expect(fixture.runtime.waitUntilReady(AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: 'RUNTIME_BLOCKED',
    });
    expect(fixture.host.start).toHaveBeenCalledTimes(1);
    expect(fixture.broker.start).toHaveBeenCalledTimes(1);
    await fixture.runtime.stop();
  });

  it('coalesces starts and keeps same-process polling on one recovery generation', async () => {
    const fixture = createRuntime();
    const first = fixture.runtime.start();
    const second = fixture.runtime.start();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    await fixture.runtime.waitUntilReady(AbortSignal.timeout(1_000));
    fixture.runtime.wake();
    await eventually(() => fixture.pump.tick.mock.calls.length >= 2);
    expect(fixture.pump.recoverAfterProcessStart).toHaveBeenCalledTimes(1);
    expect(fixture.host.start).toHaveBeenCalledTimes(1);
    expect(fixture.broker.start).toHaveBeenCalledTimes(1);
    await fixture.runtime.stop();
  });

  it('fails closed before Host/Broker startup when another process owns the installation', async () => {
    const fixture = createRuntime({ acquireInstallation: false });
    await expect(fixture.runtime.start()).rejects.toMatchObject({
      code: 'INSTALLATION_OWNERSHIP_REJECTED',
    });
    expect(fixture.runtime.status).toBe('BLOCKED');
    expect(fixture.pump.recoverAfterProcessStart).not.toHaveBeenCalled();
    expect(fixture.host.start).not.toHaveBeenCalled();
    expect(fixture.broker.start).not.toHaveBeenCalled();
  });

  it('refuses to stop Host/Broker when terminal observers cannot durably settle', async () => {
    const never = new Promise<void>(() => undefined);
    const fixture = createRuntime({ waitForTerminalObservers: () => never, drainTimeoutMs: 50 });
    await fixture.runtime.start();
    await fixture.runtime.waitUntilReady(AbortSignal.timeout(1_000));

    await expect(fixture.runtime.stop()).rejects.toMatchObject({ code: 'DRAIN_TIMEOUT' });
    expect(fixture.runtime.status).toBe('BLOCKED');
    expect(fixture.broker.stop).not.toHaveBeenCalled();
    expect(fixture.host.stop).not.toHaveBeenCalled();
    expect(fixture.transport.close).not.toHaveBeenCalled();
  });

  it('refuses to stop Host/Broker until a bounded evidence drain proves quiescence', async () => {
    const progressed: WorkerCommandPumpTickResult = {
      status: 'PROGRESSED',
      commands: 0,
      facts: 1,
      cloudAcks: 0,
    };
    const fixture = createRuntime({
      drainResults: [progressed, progressed],
      finalDrainRounds: 2,
    });
    await fixture.runtime.start();
    await fixture.runtime.waitUntilReady(AbortSignal.timeout(1_000));

    await expect(fixture.runtime.stop()).rejects.toMatchObject({ code: 'DRAIN_INCOMPLETE' });
    expect(fixture.runtime.status).toBe('BLOCKED');
    expect(fixture.broker.stop).not.toHaveBeenCalled();
    expect(fixture.host.stop).not.toHaveBeenCalled();

    await fixture.runtime.stop();
    expect(fixture.runtime.status).toBe('STOPPED');
  });

  it('keeps BLOCKED command lanes draining evidence on later polling turns', async () => {
    const blocked: WorkerCommandPumpTickResult = {
      status: 'BLOCKED',
      commands: 0,
      facts: 1,
      cloudAcks: 1,
      blockReason: 'UNSUPPORTED_COMMAND',
      blockedCommandType: 'deployment.drain',
    };
    const fixture = createRuntime({ tickResult: blocked });
    await fixture.runtime.start();
    await eventually(() => fixture.runtime.status === 'BLOCKED');
    const before = fixture.pump.tick.mock.calls.length;
    fixture.runtime.wake();
    await eventually(() => fixture.pump.tick.mock.calls.length > before);
    expect(fixture.runtime.status).toBe('BLOCKED');
    await fixture.runtime.stop();
  });
});

type RuntimeFixtureOptions = Readonly<{
  order?: string[];
  acquireInstallation?: boolean;
  readyConversationsNeedingReattach?: number;
  waitForTerminalObservers?: () => Promise<void>;
  tickResult?: WorkerCommandPumpTickResult;
  drainResults?: WorkerCommandPumpTickResult[];
  drainTimeoutMs?: number;
  finalDrainRounds?: number;
}>;

function createRuntime(options: RuntimeFixtureOptions = {}) {
  const order = options.order ?? [];
  const host = fakeHost(order);
  const transport: VnextRuntimeTransportPort & {
    acquireInstallation: ReturnType<typeof vi.fn>;
    releaseInstallation: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  } = {
    acquireInstallation: vi.fn(async () => {
      order.push('owner.acquire');
      return options.acquireInstallation ?? true;
    }),
    releaseInstallation: vi.fn(async () => {
      order.push('owner.release');
    }),
    close: vi.fn(() => {
      order.push('transport.close');
    }),
  };
  let connected = false;
  const broker: VnextRuntimeBrokerPort & {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  } = {
    get connected() {
      return connected;
    },
    start: vi.fn(async () => {
      order.push('broker.start');
      connected = true;
    }),
    stop: vi.fn(async () => {
      order.push('broker.stop');
      connected = false;
    }),
  };
  const idle: WorkerCommandPumpTickResult = {
    status: 'IDLE',
    commands: 0,
    facts: 0,
    cloudAcks: 0,
  };
  const pump: VnextRuntimePumpPort & Record<string, ReturnType<typeof vi.fn>> = {
    activeTerminalObservers: 0,
    recoverAfterProcessStart: vi.fn(async () => {
      order.push('pump.recover');
      return {
        recoveredHostActions: 0,
        readyConversationsNeedingReattach: options.readyConversationsNeedingReattach ?? 0,
      };
    }),
    tick: vi.fn(async () => options.tickResult ?? idle),
    drainEvidence: vi.fn(async () => {
      order.push('pump.drain-evidence');
      return options.drainResults?.shift() ?? idle;
    }),
    waitForTerminalObservers: vi.fn(async () => {
      order.push('pump.wait-terminals');
      await (options.waitForTerminalObservers?.() ?? Promise.resolve());
    }),
  };
  const registry = new HostTurnRegistry();
  const runtime = new VnextCreatorWorkerRuntime({
    installationId: INSTALLATION_ID,
    ownerToken: OWNER_TOKEN,
    host,
    transport,
    broker,
    pump,
    registry,
    pollIntervalMs: 10,
    drainTimeoutMs: options.drainTimeoutMs ?? 1_000,
    finalDrainRounds: options.finalDrainRounds,
  });
  createdRuntimes.push(runtime);
  return { runtime, host, transport, broker, pump, registry, order };
}

function fakeHost(order: string[]): CodexHost & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => {
      order.push('host.start');
    }),
    stop: vi.fn(async () => {
      order.push('host.stop');
    }),
    createThread: vi.fn(
      async (): Promise<HostThread> => ({
        id: 'thread-unused',
        generation: 1,
        workspaceRootsAcknowledged: true,
      }),
    ),
    startTurn: vi.fn((): HostTurnHandle => {
      throw new Error('unused');
    }),
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('eventually-timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
