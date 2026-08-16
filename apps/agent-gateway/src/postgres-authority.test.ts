import { randomUUID } from 'node:crypto';

import { currentBrokerContractDigest } from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import {
  PostgresAgentGatewayAuthority,
  type GatewayCompatibilityPolicy,
  type GatewayConnection,
  type GatewayPool,
  type GatewayQueryResult,
  type PostgresGatewayAuthorityError,
} from './postgres-authority.js';

const POLICY: GatewayCompatibilityPolicy = {
  acceptedWorkerVersions: ['combo-worker-test/1'],
  acceptedCodexRuntimeArtifacts: [`sha256:${'a'.repeat(64)}`],
  acceptedCodexProtocolSchemaDigests: [`sha256:${'b'.repeat(64)}`],
  acceptedIsolationModes: ['apple-container-v1'],
  acceptedBrokerContractDigests: [currentBrokerContractDigest()],
  sessionTtlMs: 60_000,
  leaseTtlMs: 10_000,
  responseTtlMs: 5_000,
  transactionTimeoutMs: 100,
};

function randomUuidV7(): string {
  const value = randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

type CommitMode = 'LATE_COMMITTED' | 'ROLLED_BACK' | 'UNKNOWN';

interface StoredReceipt {
  operation_kind: string;
  operation_key: string;
  request_digest: string;
  result_value: unknown;
  result_digest: string;
}

class CommitOutcomePool implements GatewayPool {
  readonly challengeId = randomUuidV7();
  readonly queries: string[] = [];
  readonly releases: boolean[] = [];
  #connections = 0;
  #pendingReceipt: StoredReceipt | undefined;
  #committedReceipt: StoredReceipt | undefined;
  #finishOriginal!: () => void;
  readonly #originalFinished = new Promise<void>((resolve) => {
    this.#finishOriginal = resolve;
  });

  constructor(readonly mode: CommitMode) {}

  async connect(): Promise<GatewayConnection> {
    const connection = this.#connections++;
    return {
      query: <Row>(sql: string, parameters?: readonly unknown[], signal?: AbortSignal) =>
        this.#query<Row>(connection, sql, parameters, signal),
      release: (destroy = false) => this.releases.push(destroy),
    };
  }

  async #query<Row>(
    connection: number,
    sql: string,
    parameters?: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<GatewayQueryResult<Row>> {
    this.queries.push(sql.trim().replace(/\s+/gu, ' '));
    if (sql.includes('creator_agent_issue_worker_challenge')) {
      return result([{ challenge_id: this.challengeId }] as Row[]);
    }
    if (sql.includes('INSERT INTO worker_gateway_operation_receipts')) {
      if (parameters === undefined || parameters.length !== 6) throw new Error('bad receipt');
      this.#pendingReceipt = {
        operation_kind: String(parameters[1]),
        operation_key: String(parameters[2]),
        request_digest: String(parameters[3]),
        result_value: JSON.parse(String(parameters[4])) as unknown,
        result_digest: String(parameters[5]),
      };
      return result([], 1);
    }
    if (sql === 'COMMIT') {
      if (connection !== 0) throw new Error('recovery must not COMMIT');
      if (this.mode === 'ROLLED_BACK') {
        this.#finishOriginal();
        throw new Error('server rolled back commit');
      }
      if (this.mode === 'UNKNOWN') throw new Error('commit transport disappeared');
      return new Promise<GatewayQueryResult<Row>>((resolve, reject) => {
        const onAbort = (): void => reject(signal?.reason ?? new Error('commit timeout'));
        signal?.addEventListener('abort', onAbort, { once: true });
        setTimeout(() => {
          this.#committedReceipt = this.#pendingReceipt;
          this.#finishOriginal();
          resolve(result([]));
        }, 150);
      });
    }
    if (sql.includes('pg_advisory_xact_lock') && connection > 0) {
      await Promise.race([
        this.#originalFinished,
        new Promise<never>((_resolve, reject) => {
          const abort = (): void => reject(signal?.reason ?? new Error('recovery timeout'));
          if (signal?.aborted === true) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        }),
      ]);
      return result([]);
    }
    if (sql.includes('FROM worker_gateway_operation_receipts')) {
      const matches =
        this.#committedReceipt !== undefined &&
        parameters !== undefined &&
        this.#committedReceipt.operation_kind === String(parameters[1]) &&
        this.#committedReceipt.operation_key === String(parameters[2]);
      return result(matches ? ([this.#committedReceipt] as Row[]) : []);
    }
    return result([]);
  }
}

class PublisherCandidatePool implements GatewayPool {
  public readonly queries: string[] = [];
  public readonly commandId = randomUuidV7();
  public readonly deploymentId = randomUuidV7();

  public async connect(): Promise<GatewayConnection> {
    return {
      query: <Row>(sql: string) => {
        this.queries.push(sql.trim().replace(/\s+/gu, ' '));
        if (sql.includes('SELECT command.command_id::text, command.deployment_id::text')) {
          return Promise.resolve(
            result([{ command_id: this.commandId, deployment_id: this.deploymentId }] as Row[]),
          );
        }
        return Promise.resolve(result([]));
      },
      release: () => undefined,
    };
  }
}

function result<Row>(rows: Row[], rowCount = rows.length): GatewayQueryResult<Row> {
  return { rows, rowCount };
}

describe('PostgresAgentGatewayAuthority compatibility policy', () => {
  it('requires at least one accepted Broker contract digest', () => {
    const pool = new CommitOutcomePool('UNKNOWN');
    expect(
      () =>
        new PostgresAgentGatewayAuthority(
          { api: pool, broker: pool },
          { ...POLICY, acceptedBrokerContractDigests: [] },
        ),
    ).toThrow();
  });

  it('does not mutate an otherwise eligible Test command outside the Deployment rollout fence', async () => {
    const pool = new PublisherCandidatePool();
    const authority = new PostgresAgentGatewayAuthority(
      { api: pool, broker: pool },
      { ...POLICY, publisherDeploymentAllowlist: [randomUuidV7()] },
    );

    await expect(
      authority.claimBrokerCommand(
        {
          ownerId: randomUuidV7(),
          installationId: randomUuidV7(),
          connectionId: randomUuidV7(),
          workerSessionId: randomUuidV7(),
        },
        AbortSignal.timeout(2_000),
      ),
    ).resolves.toBeUndefined();

    expect(pool.queries.some((sql) => sql.startsWith('UPDATE broker_outbox'))).toBe(false);
    expect(
      pool.queries.some((sql) => sql.includes('INSERT INTO worker_gateway_operation_receipts')),
    ).toBe(false);
  });
});

describe('PostgresAgentGatewayAuthority COMMIT recovery', () => {
  it('returns the exact durable result after the COMMIT transport times out', async () => {
    const pool = new CommitOutcomePool('LATE_COMMITTED');
    const authority = new PostgresAgentGatewayAuthority({ api: pool, broker: pool }, POLICY);
    const creatorId = randomUuidV7();
    const installationId = randomUuidV7();
    const deploymentId = randomUuidV7();
    const operationId = randomUuidV7();

    await expect(
      authority.issueChallenge({
        creatorId,
        installationId,
        deploymentId,
        deploymentGeneration: '1',
        operationId,
        signal: AbortSignal.timeout(2_000),
      }),
    ).resolves.toEqual({ challengeId: pool.challengeId });

    expect(pool.queries.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    expect(pool.queries.some((sql) => sql === 'ROLLBACK')).toBe(false);
    expect(pool.queries.filter((sql) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2);
    expect(pool.queries.some((sql) => sql.includes('FROM worker_gateway_operation_receipts'))).toBe(
      true,
    );
    expect(pool.releases).toEqual([true, true]);
  });

  it('replays the committed result for the same stable operation key without issuing again', async () => {
    const pool = new CommitOutcomePool('LATE_COMMITTED');
    const authority = new PostgresAgentGatewayAuthority({ api: pool, broker: pool }, POLICY);
    const request = {
      creatorId: randomUuidV7(),
      installationId: randomUuidV7(),
      deploymentId: randomUuidV7(),
      deploymentGeneration: '1',
      operationId: randomUuidV7(),
    };

    const first = await authority.issueChallenge({
      ...request,
      signal: AbortSignal.timeout(2_000),
    });
    const replay = await authority.issueChallenge({
      ...request,
      signal: AbortSignal.timeout(2_000),
    });

    expect(replay).toEqual(first);
    expect(
      pool.queries.filter((sql) => sql.includes('creator_agent_issue_worker_challenge')),
    ).toHaveLength(1);
    expect(pool.queries.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    expect(pool.releases).toEqual([true, true, true]);
  });

  it('reports a definitive non-commit without sending ROLLBACK after COMMIT', async () => {
    const pool = new CommitOutcomePool('ROLLED_BACK');
    const authority = new PostgresAgentGatewayAuthority({ api: pool, broker: pool }, POLICY);
    const operationId = randomUuidV7();

    await expect(
      authority.issueChallenge({
        creatorId: randomUuidV7(),
        installationId: randomUuidV7(),
        deploymentId: randomUuidV7(),
        deploymentGeneration: '1',
        operationId,
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toMatchObject({
      code: 'COMMIT_NOT_APPLIED',
      operationKey: operationId,
    } satisfies Partial<PostgresGatewayAuthorityError>);

    expect(pool.queries.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    expect(pool.queries.some((sql) => sql === 'ROLLBACK')).toBe(false);
    expect(pool.releases).toEqual([true, true]);
  });

  it('reports an explicit unknown result when the recovery barrier cannot settle', async () => {
    const pool = new CommitOutcomePool('UNKNOWN');
    const authority = new PostgresAgentGatewayAuthority({ api: pool, broker: pool }, POLICY);
    const operationId = randomUuidV7();

    await expect(
      authority.issueChallenge({
        creatorId: randomUuidV7(),
        installationId: randomUuidV7(),
        deploymentId: randomUuidV7(),
        deploymentGeneration: '1',
        operationId,
        signal: AbortSignal.timeout(3_000),
      }),
    ).rejects.toMatchObject({
      code: 'COMMIT_OUTCOME_UNKNOWN',
      operationKey: operationId,
    } satisfies Partial<PostgresGatewayAuthorityError>);

    expect(pool.queries.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    expect(pool.queries.some((sql) => sql === 'ROLLBACK')).toBe(false);
    expect(pool.releases).toEqual([true, true]);
  });
});
