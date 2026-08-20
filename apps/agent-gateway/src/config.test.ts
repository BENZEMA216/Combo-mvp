import { currentBrokerContractDigest } from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import { parseAgentGatewayProcessConfig } from './config.js';

const SOURCE_SHA = 'a'.repeat(40);
const DEPLOYMENT_ID = '018f4f95-3a22-7b55-9f6f-4cd6c6c8fdf1';

function validEnvironment(): Record<string, string> {
  return {
    COMBO_ENVIRONMENT: 'test',
    COMBO_SOURCE_SHA: SOURCE_SHA,
    COMBO_RELEASE_ID: `release-${SOURCE_SHA}`,
    COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${'b'.repeat(64)}`,
    AGENT_GATEWAY_ENABLED: 'true',
    AGENT_GATEWAY_PUBLISHER_ENABLED: 'true',
    AGENT_GATEWAY_ACCEPTED_WORKER_VERSIONS: '["combo-worker-test/1"]',
    AGENT_GATEWAY_ACCEPTED_CODEX_RUNTIME_ARTIFACTS: `["sha256:${'c'.repeat(64)}"]`,
    AGENT_GATEWAY_ACCEPTED_CODEX_PROTOCOL_SCHEMA_DIGESTS: `["sha256:${'d'.repeat(64)}"]`,
    AGENT_GATEWAY_ACCEPTED_ISOLATION_MODES: '["apple-container-v1"]',
    AGENT_GATEWAY_PUBLISHER_DEPLOYMENT_ALLOWLIST: `["${DEPLOYMENT_ID}"]`,
    AGENT_GATEWAY_TEST_KEYRING_PATH: '/run/secrets/combo-agent-gateway-test-keyring.json',
    PGHOST: 'postgres.combo-test.svc.cluster.local',
    PGDATABASE: 'combo',
    PGUSER: 'combo_agent_broker',
    POSTGRES_AGENT_BROKER_PASSWORD: 'non-secret-test-password',
  };
}

describe('Agent Gateway executable configuration', () => {
  it('binds an enabled Test publisher to exact release and Deployment allowlists', () => {
    const config = parseAgentGatewayProcessConfig(validEnvironment());

    expect(config).toMatchObject({
      environment: 'test',
      sourceSha: SOURCE_SHA,
      releaseId: `release-${SOURCE_SHA}`,
      host: '0.0.0.0',
      port: 3300,
      healthPort: 3301,
      publisherEnabled: true,
      database: {
        user: 'combo_agent_broker',
        host: 'postgres.combo-test.svc.cluster.local',
      },
      policy: {
        acceptedBrokerContractDigests: [currentBrokerContractDigest()],
        publisherDeploymentAllowlist: [DEPLOYMENT_ID],
      },
    });
  });

  it('permits an empty rollout list only while the publisher is disabled', () => {
    const environment = validEnvironment();
    environment.AGENT_GATEWAY_PUBLISHER_ENABLED = 'false';
    environment.AGENT_GATEWAY_PUBLISHER_DEPLOYMENT_ALLOWLIST = '[]';

    const config = parseAgentGatewayProcessConfig(environment);
    expect(config.publisherEnabled).toBe(false);
    expect(config.policy.publisherDeploymentAllowlist).toBeUndefined();
  });

  it('maps equal-length N-1/N arrays by index and rejects ambiguous profile keys', () => {
    const environment = validEnvironment();
    environment.AGENT_GATEWAY_ACCEPTED_WORKER_VERSIONS = JSON.stringify([
      'combo-worker-test/0',
      'combo-worker-test/1',
    ]);
    environment.AGENT_GATEWAY_ACCEPTED_CODEX_RUNTIME_ARTIFACTS = JSON.stringify([
      `sha256:${'e'.repeat(64)}`,
      `sha256:${'c'.repeat(64)}`,
    ]);
    environment.AGENT_GATEWAY_ACCEPTED_CODEX_PROTOCOL_SCHEMA_DIGESTS = JSON.stringify([
      `sha256:${'f'.repeat(64)}`,
      `sha256:${'d'.repeat(64)}`,
    ]);
    environment.AGENT_GATEWAY_ACCEPTED_ISOLATION_MODES = JSON.stringify([
      'lima-vz-v1',
      'apple-container-v1',
    ]);

    const config = parseAgentGatewayProcessConfig(environment);
    expect(config.policy).toMatchObject({
      acceptedWorkerVersions: ['combo-worker-test/0', 'combo-worker-test/1'],
      acceptedCodexRuntimeArtifacts: [`sha256:${'e'.repeat(64)}`, `sha256:${'c'.repeat(64)}`],
      acceptedCodexProtocolSchemaDigests: [`sha256:${'f'.repeat(64)}`, `sha256:${'d'.repeat(64)}`],
      acceptedIsolationModes: ['lima-vz-v1', 'apple-container-v1'],
    });

    const unequal = { ...environment };
    unequal.AGENT_GATEWAY_ACCEPTED_ISOLATION_MODES = '["apple-container-v1"]';
    expect(() => parseAgentGatewayProcessConfig(unequal)).toThrow(/equal length/u);

    const duplicateWorker = { ...environment };
    duplicateWorker.AGENT_GATEWAY_ACCEPTED_WORKER_VERSIONS = JSON.stringify([
      'combo-worker-test/1',
      'combo-worker-test/1',
    ]);
    expect(() => parseAgentGatewayProcessConfig(duplicateWorker)).toThrow(/unique/u);
  });

  it.each(['preview', 'production'])(
    'rejects the Test-only executable in %s before creating a database pool',
    (environmentName) => {
      const environment = validEnvironment();
      environment.COMBO_ENVIRONMENT = environmentName;
      expect(() => parseAgentGatewayProcessConfig(environment)).toThrow();
    },
  );

  it('rejects a globally enabled publisher without a Deployment rollout fence', () => {
    const environment = validEnvironment();
    environment.AGENT_GATEWAY_PUBLISHER_DEPLOYMENT_ALLOWLIST = '[]';
    expect(() => parseAgentGatewayProcessConfig(environment)).toThrow(
      /non-empty exact Deployment allowlist/u,
    );
  });

  it('rejects an enabled lifecycle publisher without an absolute mounted Test keyring', () => {
    const missing = validEnvironment();
    delete missing.AGENT_GATEWAY_TEST_KEYRING_PATH;
    expect(() => parseAgentGatewayProcessConfig(missing)).toThrow(/mounted Test keyring/u);

    const relative = validEnvironment();
    relative.AGENT_GATEWAY_TEST_KEYRING_PATH = 'secrets/keyring.json';
    expect(() => parseAgentGatewayProcessConfig(relative)).toThrow(/absolute/u);
  });

  it('rejects a release tuple mismatch, elevated role, duplicates, and control bytes', () => {
    const mismatch = validEnvironment();
    mismatch.COMBO_RELEASE_ID = `release-${'f'.repeat(40)}`;
    expect(() => parseAgentGatewayProcessConfig(mismatch)).toThrow();

    const elevated = validEnvironment();
    elevated.PGUSER = 'postgres';
    expect(() => parseAgentGatewayProcessConfig(elevated)).toThrow();

    const duplicate = validEnvironment();
    duplicate.AGENT_GATEWAY_PUBLISHER_DEPLOYMENT_ALLOWLIST = JSON.stringify([
      DEPLOYMENT_ID,
      DEPLOYMENT_ID,
    ]);
    expect(() => parseAgentGatewayProcessConfig(duplicate)).toThrow(/unique/u);

    const password = validEnvironment();
    password.POSTGRES_AGENT_BROKER_PASSWORD = 'canary-password-with-newline\n';
    let thrown: unknown;
    try {
      parseAgentGatewayProcessConfig(password);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(JSON.stringify(thrown)).not.toContain(password.POSTGRES_AGENT_BROKER_PASSWORD);
  });

  it('rejects unknown or non-canonical array inputs and a shared listener port', () => {
    const malformed = validEnvironment();
    malformed.AGENT_GATEWAY_ACCEPTED_WORKER_VERSIONS = 'combo-worker-test/1';
    expect(() => parseAgentGatewayProcessConfig(malformed)).toThrow(/canonical JSON array/u);

    const unknownIsolation = validEnvironment();
    unknownIsolation.AGENT_GATEWAY_ACCEPTED_ISOLATION_MODES = '["docker-root-v1"]';
    expect(() => parseAgentGatewayProcessConfig(unknownIsolation)).toThrow();

    const samePort = validEnvironment();
    samePort.AGENT_GATEWAY_PORT = '3300';
    samePort.AGENT_GATEWAY_HEALTH_PORT = '3300';
    expect(() => parseAgentGatewayProcessConfig(samePort)).toThrow(/must differ/u);
  });
});
