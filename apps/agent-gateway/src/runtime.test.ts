import { describe, expect, it, vi } from 'vitest';

import type { AgentGatewayProcessConfig } from './config.js';
import {
  AgentGatewayRuntime,
  attachBrokerPoolErrorBoundary,
  checkBrokerDatabaseReady,
  type AgentGatewayRuntimeDependencies,
  type RuntimeGateway,
} from './runtime.js';

const SOURCE_SHA = 'a'.repeat(40);

function config(): AgentGatewayProcessConfig {
  return {
    environment: 'test',
    sourceSha: SOURCE_SHA,
    releaseId: `release-${SOURCE_SHA}`,
    releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
    host: '127.0.0.1',
    port: 3300,
    healthHost: '127.0.0.1',
    healthPort: 0,
    maxConnections: 10,
    publisherEnabled: false,
    publisherPollIntervalMs: 1_000,
    shutdownTimeoutMs: 5_000,
    database: {
      host: '127.0.0.1',
      port: 5432,
      database: 'combo',
      user: 'combo_agent_broker',
      password: 'non-secret-test-password',
    },
    policy: {
      acceptedWorkerVersions: ['combo-worker-test/1'],
      acceptedCodexRuntimeArtifacts: [`sha256:${'c'.repeat(64)}`],
      acceptedCodexProtocolSchemaDigests: [`sha256:${'d'.repeat(64)}`],
      acceptedIsolationModes: ['apple-container-v1'],
      acceptedBrokerContractDigests: [`sha256:${'e'.repeat(64)}`],
    },
  };
}

class FakeGateway implements RuntimeGateway {
  public readonly start = vi.fn(async () => ({
    host: '127.0.0.1',
    port: 3300,
    path: '/v1/worker/connect' as const,
  }));
  public readonly stop = vi.fn(async () => undefined);
}

function dependencies(options: { databaseReady?: boolean } = {}) {
  const gateway = new FakeGateway();
  let databaseReady = options.databaseReady ?? true;
  const closeDatabase = vi.fn(async () => undefined);
  const checkDatabaseReady = vi.fn(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!databaseReady) throw new Error('sensitive-database-error-must-not-escape');
  });
  const value: AgentGatewayRuntimeDependencies = {
    gateway,
    checkDatabaseReady,
    closeDatabase,
  };
  return {
    value,
    gateway,
    closeDatabase,
    checkDatabaseReady,
    setDatabaseReady: (next: boolean) => {
      databaseReady = next;
    },
  };
}

describe('Agent Gateway executable lifecycle', () => {
  it('consumes idle Pool errors without exposing the driver cause or trusting the sink', () => {
    const listeners: Array<(error: Error) => void> = [];
    const pool = {
      on: vi.fn((event: string, listener: (error: Error) => void) => {
        expect(event).toBe('error');
        listeners.push(listener);
      }),
    } as unknown as Parameters<typeof attachBrokerPoolErrorBoundary>[0];
    const sink = vi.fn(() => {
      throw new Error('diagnostic-sink-failure');
    });
    attachBrokerPoolErrorBoundary(pool, sink);

    expect(listeners).toHaveLength(1);
    expect(() => listeners[0]?.(new Error('raw-database-host-canary'))).not.toThrow();
    expect(sink).toHaveBeenCalledWith('database_idle_client_error');
    expect(JSON.stringify(sink.mock.calls)).not.toContain('raw-database-host-canary');
  });

  it('destroys a database client that resolves only after the readiness deadline', async () => {
    let resolveClient: ((client: { release(destroy?: boolean): void }) => void) | undefined;
    const release = vi.fn();
    const pendingClient = new Promise<{ release(destroy?: boolean): void }>((resolve) => {
      resolveClient = resolve;
    });
    const pool = {
      connect: vi.fn(() => pendingClient),
    } as unknown as Parameters<typeof checkBrokerDatabaseReady>[0];
    const abort = new AbortController();

    const readiness = checkBrokerDatabaseReady(pool, abort.signal);
    abort.abort();
    await expect(readiness).rejects.toMatchObject({ name: 'AbortError' });

    resolveClient?.({ release });
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(true));
  });

  it('serves release-bound liveness and dynamic database readiness', async () => {
    const fixture = dependencies();
    const runtime = new AgentGatewayRuntime(config(), fixture.value);
    const address = await runtime.start();
    const origin = `http://127.0.0.1:${address.health.port}`;

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'agent-gateway',
      environment: 'test',
      sourceSha: SOURCE_SHA,
      releaseId: `release-${SOURCE_SHA}`,
      capability: 'conversation.open-ready/test-v1',
    });

    const ready = await fetch(`${origin}/ready`);
    expect(ready.status).toBe(200);
    expect(fixture.checkDatabaseReady).toHaveBeenCalledTimes(2);

    fixture.setDatabaseReady(false);
    const unavailable = await fetch(`${origin}/ready`);
    expect(unavailable.status).toBe(503);
    const unavailableBody = await unavailable.text();
    expect(unavailableBody).toContain('"status":"down"');
    expect(unavailableBody).not.toContain('sensitive-database-error');

    const wrongMethod = await fetch(`${origin}/health`, { method: 'POST' });
    expect(wrongMethod.status).toBe(405);
    const unknown = await fetch(`${origin}/internal`);
    expect(unknown.status).toBe(404);

    await runtime.stop();
    expect(fixture.gateway.stop).toHaveBeenCalledTimes(1);
    expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('does not open the Worker listener when the least-privilege database gate is down', async () => {
    const fixture = dependencies({ databaseReady: false });
    const runtime = new AgentGatewayRuntime(config(), fixture.value);

    await expect(runtime.start()).rejects.toThrow('sensitive-database-error-must-not-escape');
    expect(fixture.gateway.start).not.toHaveBeenCalled();
    await runtime.stop();
    expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent starts and stops without double-closing authority resources', async () => {
    const fixture = dependencies();
    const runtime = new AgentGatewayRuntime(config(), fixture.value);

    const [first, second] = await Promise.all([runtime.start(), runtime.start()]);
    expect(first).toEqual(second);
    expect(fixture.gateway.start).toHaveBeenCalledTimes(1);

    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(fixture.gateway.stop).toHaveBeenCalledTimes(1);
    expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
    await expect(runtime.start()).rejects.toThrow('AGENT_GATEWAY_RUNTIME_STOPPING');
  });

  it('closes the database even when transport drain fails and reports a stable stop error', async () => {
    const fixture = dependencies();
    fixture.gateway.stop.mockRejectedValueOnce(new Error('sensitive-transport-cause'));
    const runtime = new AgentGatewayRuntime(config(), fixture.value);
    await runtime.start();

    await expect(runtime.stop()).rejects.toThrow('AGENT_GATEWAY_RUNTIME_STOP_FAILED');
    expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
  });
});
