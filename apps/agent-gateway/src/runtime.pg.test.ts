import { currentBrokerContractDigest } from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import type { AgentGatewayProcessConfig } from './config.js';
import { createPostgresAgentGatewayRuntime } from './runtime.js';

const databaseUrl = process.env.DATABASE_URL;
const brokerPassword = process.env.POSTGRES_AGENT_BROKER_PASSWORD;
const enabled =
  process.env.CREATOR_AGENT_GATEWAY_PG_TEST === '1' && Boolean(databaseUrl && brokerPassword);
const pgDescribe = enabled ? describe.sequential : describe.skip;

pgDescribe('Agent Gateway executable real PostgreSQL readiness', () => {
  it('starts only with the exact broker role and 0030 lifecycle schema, then drains cleanly', async () => {
    const url = new URL(databaseUrl ?? 'postgresql://invalid@127.0.0.1:1/invalid');
    const sourceSha = 'a'.repeat(40);
    const config: AgentGatewayProcessConfig = {
      environment: 'test',
      sourceSha,
      releaseId: `release-${sourceSha}`,
      releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
      host: '127.0.0.1',
      port: 0,
      healthHost: '127.0.0.1',
      healthPort: 0,
      maxConnections: 2,
      publisherEnabled: false,
      publisherPollIntervalMs: 1_000,
      shutdownTimeoutMs: 5_000,
      database: {
        host: url.hostname,
        port: Number(url.port || '5432'),
        database: url.pathname.slice(1),
        user: 'combo_agent_broker',
        password: brokerPassword ?? 'invalid',
      },
      policy: {
        acceptedWorkerVersions: ['combo-worker-runtime-pg/1'],
        acceptedCodexRuntimeArtifacts: [`sha256:${'c'.repeat(64)}`],
        acceptedCodexProtocolSchemaDigests: [`sha256:${'d'.repeat(64)}`],
        acceptedIsolationModes: ['apple-container-v1'],
        acceptedBrokerContractDigests: [currentBrokerContractDigest()],
      },
    };
    const runtime = createPostgresAgentGatewayRuntime(config);

    const address = await runtime.start();
    const healthOrigin = `http://127.0.0.1:${address.health.port}`;
    const ready = await fetch(`${healthOrigin}/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'agent-gateway',
      sourceSha,
      capability: 'broker-lifecycle-ready/test-v2',
    });
    expect(address.transport.path).toBe('/v1/worker/connect');

    await runtime.stop();
    await expect(fetch(`${healthOrigin}/health`)).rejects.toThrow();
  });
});
