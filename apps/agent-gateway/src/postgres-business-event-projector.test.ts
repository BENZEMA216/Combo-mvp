import { readFileSync } from 'node:fs';

import {
  BrokerEnvelopeSchema,
  workerConversationReadyFactDigest,
  workerInvocationFactDigest,
  type BrokerEnvelope,
  type WorkerInvocationFailedFact,
} from '@cb/creator-agent-protocol';
import {
  type AssistantMessageSealer,
  type CommittedFailed,
  type CommittedPrepared,
  type CommittedStarted,
  type CommittedSuccess,
  type PostgresCloudJournal,
  type ProjectFailedOutcome,
  type ProjectPreparedOutcome,
  type ProjectStartedOutcome,
  type ProjectSuccessOutcome,
} from '@cb/creator-agent-persistence';
import { describe, expect, it, vi } from 'vitest';

import {
  type GatewayQueryResult,
  type GatewayTransaction,
  type ProjectableWorkerEvent,
} from './postgres-authority.js';
import { PostgresGatewayBusinessEventProjector } from './postgres-business-event-projector.js';

const CREATOR_ID = '0198f00d-3000-7000-8000-000000000010';
const CONSUMER_ID = '0198f00d-3000-7000-8000-000000000011';
const INSTALLATION_ID = '0198f00d-3000-7000-8000-000000000012';
const SESSION_ID = '0198f00d-3000-7000-8000-000000000014';
const CURRENT_CONNECTION_ID = '0198f00d-3000-7000-8000-000000000022';
const CURRENT_SESSION_ID = '0198f00d-3000-7000-8000-000000000023';
const DEPLOYMENT_ID = '0198f00d-3000-7000-8000-000000000015';
const LEASE_ID = '0198f00d-3000-7000-8000-000000000016';
const CURRENT_LEASE_ID = '0198f00d-3000-7000-8000-000000000024';
const CONVERSATION_ID = '0198f00d-3000-7000-8000-000000000017';
const READY_MESSAGE_ID = '0198f00d-3000-7000-8000-000000000018';
const SANDBOX_ID = '0198f00d-3000-7000-8000-000000000019';
const OPEN_COMMAND_ID = '0198f00d-3000-7000-8000-000000000020';
const AGENT_VERSION_ID = '0198f00d-3000-7000-8000-000000000021';
const INVOCATION_ID = '0198f00d-3000-7000-8000-000000000002';
const FAILED_MESSAGE_ID = '0198f00d-4000-7000-8000-000000000042';

type Lifecycle = Pick<
  PostgresCloudJournal,
  'projectPrepared' | 'projectStarted' | 'projectSuccess' | 'projectFailed' | 'projectCancelled'
>;

describe('PostgresGatewayBusinessEventProjector', () => {
  it('keeps the Test conversation.ready-only bootstrap fail closed for Invocation events', async () => {
    const transaction = emptyTransaction();
    const projector = new PostgresGatewayBusinessEventProjector();
    const prepared = fixture('broker-invocation-prepared.v1.json');
    const succeeded = fixture('broker-invocation-succeeded.v1.json');
    const failed = failedEvent();

    await expect(
      projector.project(projectorInput(transaction, prepared, AbortSignal.timeout(5_000))),
    ).rejects.toMatchObject({ code: 'BUSINESS_PROJECTOR_UNAVAILABLE' });
    await expect(
      projector.project(projectorInput(transaction, succeeded, AbortSignal.timeout(5_000))),
    ).rejects.toMatchObject({ code: 'BUSINESS_PROJECTOR_UNAVAILABLE' });
    await expect(
      projector.project(projectorInput(transaction, failed, AbortSignal.timeout(5_000))),
    ).rejects.toMatchObject({ code: 'BUSINESS_PROJECTOR_UNAVAILABLE' });
    expect(transaction.calls).toEqual([]);
  });

  it('passes the exact Gateway transaction and signal to prepared/started projectors', async () => {
    const transaction = emptyTransaction();
    const signal = AbortSignal.timeout(5_000);
    const lifecycle = lifecycleFixture();
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle, unavailableSealer);

    const prepared = fixture('broker-invocation-prepared.v1.json');
    lifecycle.projectPrepared
      .mockResolvedValueOnce(preparedOutcome(prepared, 'PERSISTED', false))
      .mockResolvedValueOnce(preparedOutcome(prepared, 'PERSISTED', true))
      .mockResolvedValueOnce(preparedOutcome(prepared, 'RECONCILING', false))
      .mockResolvedValueOnce(preparedOutcome(prepared, 'RECONCILING', true));
    await expect(projector.project(projectorInput(transaction, prepared, signal))).resolves.toBe(
      'APPLIED',
    );
    await expect(projector.project(projectorInput(transaction, prepared, signal))).resolves.toBe(
      'IDEMPOTENT_REPLAY',
    );
    await expect(projector.project(projectorInput(transaction, prepared, signal))).resolves.toBe(
      'RECONCILE',
    );
    await expect(projector.project(projectorInput(transaction, prepared, signal))).resolves.toBe(
      'RECONCILE',
    );
    const preparedCall = lifecycle.projectPrepared.mock.calls[0]!;
    expect(preparedCall[0]).toBe(transaction);
    expect(preparedCall[2]).toBe(signal);
    expect(preparedCall[1]).toMatchObject({
      creatorId: CREATOR_ID,
      installationId: INSTALLATION_ID,
      fact: { type: 'invocation.prepared' },
      factDigest: prepared.body.factDigest,
    });

    const started = fixture('broker-invocation-started.v1.json');
    lifecycle.projectStarted
      .mockResolvedValueOnce(startedOutcome(started, 'RUNNING', false))
      .mockResolvedValueOnce(startedOutcome(started, 'RUNNING', true))
      .mockResolvedValueOnce(startedOutcome(started, 'RECONCILING', false))
      .mockResolvedValueOnce(startedOutcome(started, 'RECONCILING', true));
    await expect(projector.project(projectorInput(transaction, started, signal))).resolves.toBe(
      'APPLIED',
    );
    await expect(projector.project(projectorInput(transaction, started, signal))).resolves.toBe(
      'IDEMPOTENT_REPLAY',
    );
    await expect(projector.project(projectorInput(transaction, started, signal))).resolves.toBe(
      'RECONCILE',
    );
    await expect(projector.project(projectorInput(transaction, started, signal))).resolves.toBe(
      'RECONCILE',
    );
    const startedCall = lifecycle.projectStarted.mock.calls[0]!;
    expect(startedCall[0]).toBe(transaction);
    expect(startedCall[2]).toBe(signal);
    expect(transaction.calls).toContainEqual([
      `SELECT pg_catalog.set_config('app.consumer_id', ''::text, true)`,
      [],
      signal,
    ]);
  });

  it('injects the exact terminal sealer and never opens a second transaction', async () => {
    const transaction = emptyTransaction();
    const signal = AbortSignal.timeout(5_000);
    const lifecycle = lifecycleFixture();
    const sealer = vi.fn<AssistantMessageSealer>();
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle, sealer);
    const succeeded = fixture('broker-invocation-succeeded.v1.json');
    lifecycle.projectSuccess
      .mockResolvedValueOnce(successOutcome(succeeded, false))
      .mockResolvedValueOnce(successOutcome(succeeded, true));

    await expect(projector.project(projectorInput(transaction, succeeded, signal))).resolves.toBe(
      'APPLIED',
    );
    await expect(projector.project(projectorInput(transaction, succeeded, signal))).resolves.toBe(
      'IDEMPOTENT_REPLAY',
    );
    const call = lifecycle.projectSuccess.mock.calls[0]!;
    expect(call[0]).toBe(transaction);
    expect(call[2]).toBeTypeOf('function');
    expect(call[3]).toBe(signal);
    expect(call[1]).toMatchObject({
      creatorId: CREATOR_ID,
      installationId: INSTALLATION_ID,
      fact: { type: 'invocation.succeeded' },
      factDigest: succeeded.body.factDigest,
      resultCiphertext: succeeded.body.resultCiphertext,
    });
    const sealerInput = {
      resultCiphertext: succeeded.body.resultCiphertext,
      aad: {
        schemaVersion: 1 as const,
        ownerId: CREATOR_ID,
        conversationId: CONVERSATION_ID,
        messageId: READY_MESSAGE_ID,
        role: 'ASSISTANT' as const,
      },
      signal,
    };
    await call[2]?.(sealerInput);
    expect(sealer).toHaveBeenCalledWith({
      ...sealerInput,
      installationId: INSTALLATION_ID,
      workerSessionId: CURRENT_SESSION_ID,
    });
  });

  it('projects a confirmed failure through the exact Gateway transaction and signal', async () => {
    const transaction = emptyTransaction();
    const signal = AbortSignal.timeout(5_000);
    const lifecycle = lifecycleFixture();
    const sealer = vi.fn<AssistantMessageSealer>();
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle, sealer);
    const failed = failedEvent();
    lifecycle.projectFailed
      .mockResolvedValueOnce(failedOutcome(failed, false))
      .mockResolvedValueOnce(failedOutcome(failed, true));

    await expect(projector.project(projectorInput(transaction, failed, signal))).resolves.toBe(
      'APPLIED',
    );
    await expect(projector.project(projectorInput(transaction, failed, signal))).resolves.toBe(
      'IDEMPOTENT_REPLAY',
    );

    const call = lifecycle.projectFailed.mock.calls[0]!;
    expect(call[0]).toBe(transaction);
    expect(call[2]).toBe(signal);
    expect(call[1]).toEqual({
      creatorId: CREATOR_ID,
      installationId: INSTALLATION_ID,
      fact: {
        protocol: failed.body.protocol,
        schemaVersion: failed.body.schemaVersion,
        type: failed.body.type,
        sourceEventId: failed.body.sourceEventId,
        invocationId: failed.body.invocationId,
        agentVersionDigest: failed.body.agentVersionDigest,
        snapshotDigest: failed.body.snapshotDigest,
        executionCapabilityDigest: failed.body.executionCapabilityDigest,
        leaseId: failed.body.leaseId,
        fence: failed.body.fence,
        errorCode: failed.body.errorCode,
      },
      factDigest: failed.body.factDigest,
    });
    expect(transaction.calls).toEqual([
      [`SELECT pg_catalog.set_config('app.consumer_id', ''::text, true)`, [], signal],
      [`SELECT pg_catalog.set_config('app.consumer_id', ''::text, true)`, [], signal],
    ]);
    expect(sealer).not.toHaveBeenCalled();
  });

  it('fails closed before Cloud projection for an unregistered failed error code', async () => {
    const transaction = emptyTransaction();
    const lifecycle = lifecycleFixture();
    const signal = AbortSignal.timeout(5_000);
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle, unavailableSealer);

    await expect(
      projector.project(projectorInput(transaction, failedEvent('UNREGISTERED_FAILURE'), signal)),
    ).rejects.toThrow();
    expect(lifecycle.projectFailed).not.toHaveBeenCalled();
    expect(transaction.calls).toEqual([
      [`SELECT pg_catalog.set_config('app.consumer_id', ''::text, true)`, [], signal],
    ]);
  });

  it.each([
    ['APPLIED', 'IDLE', OPEN_COMMAND_ID, 'APPLIED'],
    ['REPLAY', 'BUSY', OPEN_COMMAND_ID, 'IDEMPOTENT_REPLAY'],
    ['REJECTED', null, null, 'SECURITY_BLOCK'],
  ] as const)(
    'maps conversation.ready outcome %s from its original durable authority after re-envelope',
    async (outcome, conversationState, openCommandId, decision) => {
      const signal = AbortSignal.timeout(5_000);
      const transaction = scriptedTransaction([
        { rows: [], rowCount: 1 },
        { rows: [{ consumer_subject_id: CONSUMER_ID }], rowCount: 1 },
        { rows: [], rowCount: 1 },
        {
          rows: [
            {
              outcome,
              conversation_state: conversationState,
              open_command_id: openCommandId,
            },
          ],
          rowCount: 1,
        },
      ]);
      const projector = new PostgresGatewayBusinessEventProjector(
        lifecycleFixture(),
        unavailableSealer,
      );

      await expect(
        projector.project(projectorInput(transaction, conversationReady(), signal)),
      ).resolves.toBe(decision);
      expect(transaction.calls[1]?.[0]).not.toMatch(/FOR\s+(UPDATE|SHARE)/iu);
      expect(transaction.calls[3]?.[0]).toContain(
        'public.creator_agent_commit_conversation_ready_fact',
      );
      expect(transaction.calls[1]?.[1]).toEqual([
        CONVERSATION_ID,
        CREATOR_ID,
        DEPLOYMENT_ID,
        AGENT_VERSION_ID,
        'a'.repeat(64),
        'b'.repeat(64),
        INSTALLATION_ID,
        OPEN_COMMAND_ID,
        LEASE_ID,
        '2',
        SESSION_ID,
      ]);
      expect(transaction.calls[3]?.[1]).toEqual([
        OPEN_COMMAND_ID,
        conversationReady().body.factDigest,
        CONVERSATION_ID,
        CREATOR_ID,
        CONSUMER_ID,
        DEPLOYMENT_ID,
        AGENT_VERSION_ID,
        'a'.repeat(64),
        'b'.repeat(64),
        INSTALLATION_ID,
        SESSION_ID,
        LEASE_ID,
        '2',
        SANDBOX_ID,
        'runtime-thread-ready',
        'sha256:' + 'c'.repeat(64),
      ]);
      for (const call of transaction.calls) expect(call[2]).toBe(signal);
      expect(transaction.calls[3]?.[1]).not.toContain(CURRENT_SESSION_ID);
      expect(transaction.calls[3]?.[1]).not.toContain(CURRENT_LEASE_ID);
      expect(transaction.calls[3]?.[1]).not.toContain('3');
    },
  );

  it('blocks a ready fact from another installation or deployment before SQL', async () => {
    const projector = new PostgresGatewayBusinessEventProjector(
      lifecycleFixture(),
      unavailableSealer,
    );
    for (const changed of [
      { installationId: '0198f00d-3000-7000-8000-000000000099' },
      { deploymentId: '0198f00d-3000-7000-8000-000000000098' },
    ]) {
      const transaction = emptyTransaction();
      const ready = conversationReady();
      const fact = { ...ready.body, ...changed };
      const { factDigest: _oldDigest, ...factInput } = fact;
      const mismatched = BrokerEnvelopeSchema.parse({
        ...ready,
        body: {
          ...factInput,
          factDigest: workerConversationReadyFactDigest(factInput),
        },
      }) as Extract<BrokerEnvelope, { type: 'conversation.ready' }>;
      await expect(
        projector.project(projectorInput(transaction, mismatched, AbortSignal.timeout(5_000))),
      ).resolves.toBe('SECURITY_BLOCK');
      expect(transaction.calls).toHaveLength(0);
    }
  });

  it('propagates Cloud failures so the Gateway transaction cannot commit a partial projection', async () => {
    const transaction = emptyTransaction();
    const lifecycle = lifecycleFixture();
    const failure = new Error('partial-projector-failure');
    lifecycle.projectPrepared.mockRejectedValue(failure);
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle, unavailableSealer);
    await expect(
      projector.project(
        projectorInput(
          transaction,
          fixture('broker-invocation-prepared.v1.json'),
          AbortSignal.timeout(5_000),
        ),
      ),
    ).rejects.toBe(failure);
  });

  it('maps a durable prepared SECURITY_BLOCKED outcome without throwing the caller transaction', async () => {
    const transaction = emptyTransaction();
    const signal = AbortSignal.timeout(5_000);
    const lifecycle = lifecycleFixture();
    lifecycle.projectPrepared.mockResolvedValue({ kind: 'SECURITY_BLOCKED' });
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle, unavailableSealer);
    await expect(
      projector.project(
        projectorInput(transaction, fixture('broker-invocation-prepared.v1.json'), signal),
      ),
    ).resolves.toBe('SECURITY_BLOCK');
    expect(lifecycle.projectPrepared).toHaveBeenCalledTimes(1);
    expect(transaction.calls).toContainEqual([
      `SELECT pg_catalog.set_config('app.consumer_id', ''::text, true)`,
      [],
      signal,
    ]);
  });

  it('maps a durable started SECURITY_BLOCKED outcome without throwing the caller transaction', async () => {
    const transaction = emptyTransaction();
    const signal = AbortSignal.timeout(5_000);
    const lifecycle = lifecycleFixture();
    lifecycle.projectStarted.mockResolvedValue({ kind: 'SECURITY_BLOCKED' });
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle, unavailableSealer);
    await expect(
      projector.project(
        projectorInput(transaction, fixture('broker-invocation-started.v1.json'), signal),
      ),
    ).resolves.toBe('SECURITY_BLOCK');
    expect(lifecycle.projectStarted).toHaveBeenCalledTimes(1);
    expect(transaction.calls).toContainEqual([
      `SELECT pg_catalog.set_config('app.consumer_id', ''::text, true)`,
      [],
      signal,
    ]);
  });

  it('maps a durable failed SECURITY_BLOCKED outcome without sealing or throwing the caller transaction', async () => {
    const transaction = emptyTransaction();
    const signal = AbortSignal.timeout(5_000);
    const lifecycle = lifecycleFixture();
    const sealer = vi.fn<AssistantMessageSealer>();
    lifecycle.projectFailed.mockResolvedValue({ kind: 'SECURITY_BLOCKED' });
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle, sealer);
    await expect(
      projector.project(projectorInput(transaction, failedEvent(), signal)),
    ).resolves.toBe('SECURITY_BLOCK');
    expect(lifecycle.projectFailed).toHaveBeenCalledTimes(1);
    expect(transaction.calls).toContainEqual([
      `SELECT pg_catalog.set_config('app.consumer_id', ''::text, true)`,
      [],
      signal,
    ]);
    expect(sealer).not.toHaveBeenCalled();
  });

  it('maps a durable succeeded SECURITY_BLOCKED outcome without invoking its terminal sealer', async () => {
    const transaction = emptyTransaction();
    const signal = AbortSignal.timeout(5_000);
    const lifecycle = lifecycleFixture();
    lifecycle.projectSuccess.mockResolvedValue({ kind: 'SECURITY_BLOCKED' });
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle);
    await expect(
      projector.project(
        projectorInput(transaction, fixture('broker-invocation-succeeded.v1.json'), signal),
      ),
    ).resolves.toBe('SECURITY_BLOCK');
    expect(lifecycle.projectSuccess).toHaveBeenCalledTimes(1);
    expect(transaction.calls).toContainEqual([
      `SELECT pg_catalog.set_config('app.consumer_id', ''::text, true)`,
      [],
      signal,
    ]);
    expect(lifecycle.projectSuccess.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('allows an exact succeeded replay to terminate before a missing fresh-only sealer', async () => {
    const transaction = emptyTransaction();
    const signal = AbortSignal.timeout(5_000);
    const lifecycle = lifecycleFixture();
    const succeeded = fixture('broker-invocation-succeeded.v1.json');
    lifecycle.projectSuccess.mockResolvedValue({
      kind: 'COMMITTED',
      committed: {
        ...successResult(succeeded, true),
        consumerEventCursor: null,
      },
    });
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle);
    await expect(projector.project(projectorInput(transaction, succeeded, signal))).resolves.toBe(
      'IDEMPOTENT_REPLAY',
    );
    expect(lifecycle.projectSuccess.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('rejects a non-null succeeded replay cursor outside the uint63 contract', async () => {
    const lifecycle = lifecycleFixture();
    const succeeded = fixture('broker-invocation-succeeded.v1.json');
    lifecycle.projectSuccess.mockResolvedValue({
      kind: 'COMMITTED',
      committed: {
        ...successResult(succeeded, true),
        consumerEventCursor: 'not-a-cursor',
      },
    });
    await expect(
      new PostgresGatewayBusinessEventProjector(lifecycle).project(
        projectorInput(emptyTransaction(), succeeded, AbortSignal.timeout(5_000)),
      ),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_INVARIANT_FAILED' });
  });

  it('rejects a fresh succeeded outcome without its durable Consumer cursor', async () => {
    const lifecycle = lifecycleFixture();
    const succeeded = fixture('broker-invocation-succeeded.v1.json');
    lifecycle.projectSuccess.mockResolvedValue({
      kind: 'COMMITTED',
      committed: {
        ...successResult(succeeded, false),
        consumerEventCursor: null,
      },
    });
    await expect(
      new PostgresGatewayBusinessEventProjector(lifecycle).project(
        projectorInput(emptyTransaction(), succeeded, AbortSignal.timeout(5_000)),
      ),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_INVARIANT_FAILED' });
  });

  it('rejects a ready event whose wire correlation diverges from its Conversation', async () => {
    const transaction = emptyTransaction();
    const projector = new PostgresGatewayBusinessEventProjector(
      lifecycleFixture(),
      unavailableSealer,
    );
    const mismatched = {
      ...conversationReady(),
      correlationId: OPEN_COMMAND_ID,
    } as Extract<BrokerEnvelope, { type: 'conversation.ready' }>;
    await expect(
      projector.project(projectorInput(transaction, mismatched, AbortSignal.timeout(5_000))),
    ).resolves.toBe('SECURITY_BLOCK');
    expect(transaction.calls).toHaveLength(0);
  });

  it('rejects an already-aborted call before any SQL, Cloud, or sealing work', async () => {
    const transaction = emptyTransaction();
    const lifecycle = lifecycleFixture();
    const sealer = vi.fn<AssistantMessageSealer>();
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle, sealer);
    const controller = new AbortController();
    controller.abort();

    await expect(
      projector.project(
        projectorInput(
          transaction,
          fixture('broker-invocation-prepared.v1.json'),
          controller.signal,
        ),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(transaction.calls).toHaveLength(0);
    expect(lifecycle.projectPrepared).not.toHaveBeenCalled();
    expect(lifecycle.projectStarted).not.toHaveBeenCalled();
    expect(lifecycle.projectSuccess).not.toHaveBeenCalled();
    expect(lifecycle.projectFailed).not.toHaveBeenCalled();
    expect(sealer).not.toHaveBeenCalled();
  });

  it('fails closed when Cloud returns an identity that does not match the projected fact', async () => {
    const prepared = fixture('broker-invocation-prepared.v1.json');
    const preparedLifecycle = lifecycleFixture();
    preparedLifecycle.projectPrepared.mockResolvedValue({
      kind: 'COMMITTED',
      committed: {
        ...preparedResult(prepared, 'PERSISTED', false),
        invocationId: CONVERSATION_ID,
      },
    });
    await expect(
      new PostgresGatewayBusinessEventProjector(preparedLifecycle, unavailableSealer).project(
        projectorInput(emptyTransaction(), prepared, AbortSignal.timeout(5_000)),
      ),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_INVARIANT_FAILED' });

    const started = fixture('broker-invocation-started.v1.json');
    const startedLifecycle = lifecycleFixture();
    startedLifecycle.projectStarted.mockResolvedValue({
      kind: 'COMMITTED',
      committed: {
        ...startedResult(started, 'RUNNING', false),
        factDigest: 'f'.repeat(64),
      },
    });
    await expect(
      new PostgresGatewayBusinessEventProjector(startedLifecycle, unavailableSealer).project(
        projectorInput(emptyTransaction(), started, AbortSignal.timeout(5_000)),
      ),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_INVARIANT_FAILED' });

    const succeeded = fixture('broker-invocation-succeeded.v1.json');
    const successLifecycle = lifecycleFixture();
    successLifecycle.projectSuccess.mockResolvedValue({
      kind: 'COMMITTED',
      committed: {
        ...successResult(succeeded, false),
        resultDigest: 'hmac-sha256:' + 'e'.repeat(64),
      },
    });
    await expect(
      new PostgresGatewayBusinessEventProjector(successLifecycle, unavailableSealer).project(
        projectorInput(emptyTransaction(), succeeded, AbortSignal.timeout(5_000)),
      ),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_INVARIANT_FAILED' });

    const failed = failedEvent();
    const failedLifecycle = lifecycleFixture();
    failedLifecycle.projectFailed.mockResolvedValue({
      kind: 'COMMITTED',
      committed: {
        ...failedResult(failed, false),
        errorCode: 'TURN_TIMEOUT',
      },
    });
    await expect(
      new PostgresGatewayBusinessEventProjector(failedLifecycle, unavailableSealer).project(
        projectorInput(emptyTransaction(), failed, AbortSignal.timeout(5_000)),
      ),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_INVARIANT_FAILED' });
  });

  it('fails closed for every event whose durable projector is not implemented', async () => {
    const projector = new PostgresGatewayBusinessEventProjector(
      lifecycleFixture(),
      unavailableSealer,
    );
    const event = BrokerEnvelopeSchema.parse({
      ...conversationReady(),
      type: 'version.ready',
      correlationId: DEPLOYMENT_ID,
      body: {
        generation: '1',
        agentVersionDigest: 'a'.repeat(64),
        smokeAttestationDigest: 'sha256:' + 'b'.repeat(64),
      },
    }) as Extract<BrokerEnvelope, { type: 'version.ready' }>;
    await expect(
      projector.project(projectorInput(emptyTransaction(), event, AbortSignal.timeout(5_000))),
    ).rejects.toMatchObject({
      code: 'BUSINESS_PROJECTOR_UNAVAILABLE',
    });
  });

  it.each([
    'version.ready',
    'version.rejected',
    'invocation.delta',
    'invocation.uncertain',
  ] as const)('fails closed for unsupported %s events before calling Cloud', async (type) => {
    const lifecycle = lifecycleFixture();
    const sealer = vi.fn<AssistantMessageSealer>();
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle, sealer);
    const unsupported = { ...conversationReady(), type } as unknown as ProjectableWorkerEvent;
    await expect(
      projector.project(
        projectorInput(emptyTransaction(), unsupported, AbortSignal.timeout(5_000)),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_PROJECTOR_UNAVAILABLE' });
    expect(lifecycle.projectPrepared).not.toHaveBeenCalled();
    expect(lifecycle.projectStarted).not.toHaveBeenCalled();
    expect(lifecycle.projectSuccess).not.toHaveBeenCalled();
    expect(lifecycle.projectFailed).not.toHaveBeenCalled();
    expect(sealer).not.toHaveBeenCalled();
  });

  it('projects a canonical invocation.cancelled event through the lifecycle', async () => {
    const lifecycle = lifecycleFixture();
    lifecycle.projectCancelled = vi.fn(async () => ({
      kind: 'COMMITTED',
      committed: {
        invocationId: '0198f00d-5000-7000-8000-000000000001',
        state: 'CANCELLED',
        consumerEventCursor: '42',
        replayed: false,
      },
    }));
    const projector = new PostgresGatewayBusinessEventProjector(lifecycle, unavailableSealer);
    const event = {
      ...conversationReady(),
      type: 'invocation.cancelled',
      body: {
        protocol: 'combo.worker-invocation-fact/1',
        schemaVersion: 1,
        type: 'invocation.cancelled',
        sourceEventId: '0198f00d-5000-7000-8000-000000000001',
        invocationId: '0198f00d-5000-7000-8000-000000000001',
        agentVersionDigest: 'a'.repeat(64),
        snapshotDigest: 'b'.repeat(64),
        executionCapabilityDigest: 'c'.repeat(64),
        leaseId: '0198f00d-5000-7000-8000-000000000002',
        fence: '1',
        interruptReceiptDigest: `sha256:${'d'.repeat(64)}`,
        factDigest: 'e'.repeat(64),
      },
    } as unknown as ProjectableWorkerEvent;
    const decision = await projector.project(
      projectorInput(emptyTransaction(), event, AbortSignal.timeout(5_000)),
    );
    expect(decision).toBe('APPLIED');
    expect(lifecycle.projectCancelled).toHaveBeenCalledTimes(1);
    expect(lifecycle.projectSuccess).not.toHaveBeenCalled();
    expect(lifecycle.projectFailed).not.toHaveBeenCalled();
  });

  it('fails closed at runtime for an event type added ahead of this adapter', async () => {
    const projector = new PostgresGatewayBusinessEventProjector(
      lifecycleFixture(),
      unavailableSealer,
    );
    const futureEvent = {
      ...conversationReady(),
      type: 'future.worker.event',
    } as unknown as ProjectableWorkerEvent;
    await expect(
      projector.project(
        projectorInput(emptyTransaction(), futureEvent, AbortSignal.timeout(5_000)),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_PROJECTOR_UNAVAILABLE' });
  });
});

function fixture(
  name: 'broker-invocation-prepared.v1.json',
): Extract<BrokerEnvelope, { type: 'invocation.prepared' }>;
function fixture(
  name: 'broker-invocation-started.v1.json',
): Extract<BrokerEnvelope, { type: 'invocation.started' }>;
function fixture(
  name: 'broker-invocation-succeeded.v1.json',
): Extract<BrokerEnvelope, { type: 'invocation.succeeded' }>;
function fixture(
  name:
    | 'broker-invocation-prepared.v1.json'
    | 'broker-invocation-started.v1.json'
    | 'broker-invocation-succeeded.v1.json',
): Extract<
  BrokerEnvelope,
  { type: 'invocation.prepared' | 'invocation.started' | 'invocation.succeeded' }
> {
  return BrokerEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(`../../../packages/creator-agent-protocol/fixtures/${name}`, import.meta.url),
        'utf8',
      ),
    ),
  ) as Extract<
    BrokerEnvelope,
    { type: 'invocation.prepared' | 'invocation.started' | 'invocation.succeeded' }
  >;
}

function conversationReady(): Extract<BrokerEnvelope, { type: 'conversation.ready' }> {
  const fact = {
    protocol: 'combo.worker-conversation-ready-fact/1',
    schemaVersion: 1,
    type: 'conversation.ready',
    sourceEventId: OPEN_COMMAND_ID,
    conversationId: CONVERSATION_ID,
    openCommandId: OPEN_COMMAND_ID,
    deploymentId: DEPLOYMENT_ID,
    agentVersionId: AGENT_VERSION_ID,
    agentVersionDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64),
    installationId: INSTALLATION_ID,
    workerSessionId: SESSION_ID,
    leaseId: LEASE_ID,
    fence: '2',
    sandboxInstanceId: SANDBOX_ID,
    runtimeThreadId: 'runtime-thread-ready',
    readyEvidenceDigest: 'sha256:' + 'c'.repeat(64),
  } as const;
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'conversation.ready',
    messageId: READY_MESSAGE_ID,
    correlationId: CONVERSATION_ID,
    connectionId: CURRENT_CONNECTION_ID,
    sequence: '0',
    sentAt: '2026-08-14T01:00:00.000Z',
    expiresAt: '2026-08-14T01:00:30.000Z',
    lease: {
      deploymentId: DEPLOYMENT_ID,
      leaseId: CURRENT_LEASE_ID,
      workerSessionId: CURRENT_SESSION_ID,
      fence: '3',
    },
    body: { ...fact, factDigest: workerConversationReadyFactDigest(fact) },
  }) as Extract<BrokerEnvelope, { type: 'conversation.ready' }>;
}

function failedEvent(
  errorCode = 'TURN_FAILED',
): Extract<BrokerEnvelope, { type: 'invocation.failed' }> {
  const fact = {
    protocol: 'combo.worker-invocation-fact/1',
    schemaVersion: 1,
    type: 'invocation.failed',
    sourceEventId: INVOCATION_ID,
    invocationId: INVOCATION_ID,
    agentVersionDigest: 'e'.repeat(64),
    snapshotDigest: 'a'.repeat(64),
    executionCapabilityDigest: 'f'.repeat(64),
    leaseId: LEASE_ID,
    fence: '2',
    errorCode,
  } as const satisfies WorkerInvocationFailedFact;
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'invocation.failed',
    messageId: FAILED_MESSAGE_ID,
    correlationId: INVOCATION_ID,
    connectionId: CURRENT_CONNECTION_ID,
    sequence: '4',
    sentAt: '2026-08-14T01:00:04.000Z',
    expiresAt: '2026-08-14T01:00:34.000Z',
    lease: {
      deploymentId: DEPLOYMENT_ID,
      leaseId: CURRENT_LEASE_ID,
      workerSessionId: CURRENT_SESSION_ID,
      fence: '3',
    },
    body: { ...fact, factDigest: workerInvocationFactDigest(fact) },
  }) as Extract<BrokerEnvelope, { type: 'invocation.failed' }>;
}

function projectorInput(
  transaction: GatewayTransaction,
  event: Parameters<PostgresGatewayBusinessEventProjector['project']>[0]['event'],
  signal: AbortSignal,
): Parameters<PostgresGatewayBusinessEventProjector['project']>[0] {
  return {
    transaction,
    session: {
      ownerId: CREATOR_ID,
      installationId: INSTALLATION_ID,
      connectionId: CURRENT_CONNECTION_ID,
      workerSessionId: CURRENT_SESSION_ID,
    },
    transport: {
      creatorId: CREATOR_ID,
      installationId: INSTALLATION_ID,
      connectionId: CURRENT_CONNECTION_ID,
      workerSessionId: CURRENT_SESSION_ID,
      deploymentId: DEPLOYMENT_ID,
      leaseId: CURRENT_LEASE_ID,
      fence: '3',
    },
    event,
    signal,
  };
}

type QueryCall = readonly [string, readonly unknown[] | undefined, AbortSignal | undefined];
type RecordedTransaction = GatewayTransaction & { calls: QueryCall[] };

function emptyTransaction(): RecordedTransaction {
  return recordedTransaction(async () => ({ rows: [], rowCount: 1 }));
}

function scriptedTransaction(
  results: Array<{ rows: Record<string, unknown>[]; rowCount: number }>,
): RecordedTransaction {
  return recordedTransaction(async () => {
    const result = results.shift();
    if (!result) throw new Error('unexpected-query');
    return result;
  });
}

function recordedTransaction(
  handler: () => Promise<GatewayQueryResult<Record<string, unknown>>>,
): RecordedTransaction {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query<Row = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
      signal?: AbortSignal,
    ): Promise<GatewayQueryResult<Row>> {
      calls.push([sql, parameters, signal]);
      return (await handler()) as GatewayQueryResult<Row>;
    },
  };
}

function lifecycleFixture() {
  return {
    projectPrepared: vi.fn<Lifecycle['projectPrepared']>(),
    projectStarted: vi.fn<Lifecycle['projectStarted']>(),
    projectSuccess: vi.fn<Lifecycle['projectSuccess']>(),
    projectFailed: vi.fn<Lifecycle['projectFailed']>(),
    projectCancelled: vi.fn<Lifecycle['projectCancelled']>(),
  };
}

function preparedResult(
  event: Extract<BrokerEnvelope, { type: 'invocation.prepared' }>,
  state: CommittedPrepared['state'],
  replayed: boolean,
): CommittedPrepared {
  return {
    invocationId: event.body.invocationId,
    state,
    prepareCommandId: event.body.prepareCommandId,
    startCommandId: state === 'PERSISTED' ? OPEN_COMMAND_ID : null,
    factDigest: event.body.factDigest,
    replayed,
  };
}

function preparedOutcome(
  event: Extract<BrokerEnvelope, { type: 'invocation.prepared' }>,
  state: CommittedPrepared['state'],
  replayed: boolean,
): ProjectPreparedOutcome {
  return { kind: 'COMMITTED', committed: preparedResult(event, state, replayed) };
}

function startedResult(
  event: Extract<BrokerEnvelope, { type: 'invocation.started' }>,
  state: CommittedStarted['state'],
  replayed: boolean,
): CommittedStarted {
  return {
    invocationId: event.body.invocationId,
    state,
    startCommandId: event.body.startCommandId,
    factDigest: event.body.factDigest,
    startedAt: '2026-08-14T01:00:00.000Z',
    replayed,
  };
}

function startedOutcome(
  event: Extract<BrokerEnvelope, { type: 'invocation.started' }>,
  state: CommittedStarted['state'],
  replayed: boolean,
): ProjectStartedOutcome {
  return { kind: 'COMMITTED', committed: startedResult(event, state, replayed) };
}

function successResult(
  event: Extract<BrokerEnvelope, { type: 'invocation.succeeded' }>,
  replayed: boolean,
): CommittedSuccess {
  return {
    invocationId: event.body.invocationId,
    assistantMessageId: OPEN_COMMAND_ID,
    resultDigest: event.body.resultDigest,
    consumerEventCursor: '1',
    replayed,
  };
}

function successOutcome(
  event: Extract<BrokerEnvelope, { type: 'invocation.succeeded' }>,
  replayed: boolean,
): ProjectSuccessOutcome {
  return { kind: 'COMMITTED', committed: successResult(event, replayed) };
}

function failedResult(
  event: Extract<BrokerEnvelope, { type: 'invocation.failed' }>,
  replayed: boolean,
): CommittedFailed {
  return {
    invocationId: event.body.invocationId,
    state: 'FAILED',
    errorCode: 'TURN_FAILED',
    consumerEventCursor: '2',
    replayed,
  };
}

function failedOutcome(
  event: Extract<BrokerEnvelope, { type: 'invocation.failed' }>,
  replayed: boolean,
): ProjectFailedOutcome {
  return { kind: 'COMMITTED', committed: failedResult(event, replayed) };
}

const unavailableSealer: AssistantMessageSealer = () => {
  throw new Error('sealer-must-not-run-in-adapter-unit');
};
