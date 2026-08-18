import {
  assertWorkerConversationReadyFactDigest,
  HmacSha256DigestSchema,
  IsoDateTimeSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  UuidSchema,
  VnextErrorCodeSchema,
  WorkerConversationReadyFactSchema,
  type WorkerInvocationCancelledFact,
  WorkerInvocationCancelledFactSchema,
  type WorkerInvocationFailedFact,
  WorkerInvocationFailedFactSchema,
  type WorkerInvocationPreparedFact,
  WorkerInvocationPreparedFactSchema,
  type WorkerInvocationStartedFact,
  WorkerInvocationStartedFactSchema,
  type WorkerInvocationSucceededFact,
  WorkerInvocationSucceededFactSchema,
} from '@cb/creator-agent-protocol';
import {
  type AssistantMessageSealer,
  type CommittedCancelled,
  type CommittedFailed,
  type CommittedPrepared,
  type CommittedStarted,
  type CommittedSuccess,
  type PostgresCloudJournal,
} from '@cb/creator-agent-persistence';

import {
  PostgresGatewayAuthorityError,
  type GatewayBusinessEventProjector,
  type GatewayProjectionDecision,
  type GatewayTransaction,
  type ProjectableWorkerEvent,
} from './postgres-authority.js';

type InvocationLifecycleProjector = Pick<
  PostgresCloudJournal,
  'projectPrepared' | 'projectStarted' | 'projectSuccess' | 'projectFailed' | 'projectCancelled'
>;

type ConversationReadyRow = Readonly<{
  outcome: string;
  conversation_state: string | null;
  open_command_id: string | null;
}>;

const CONVERSATION_STATES = new Set([
  'OPENING',
  'IDLE',
  'BUSY',
  'SUSPENDED',
  'CLOSING',
  'CLOSED',
  'FAILED',
  'EXPIRED',
]);

/**
 * PostgreSQL business projection adapter for the Agent Gateway.
 *
 * Every supported event is projected through the caller's existing Gateway transaction and
 * AbortSignal. Ordinary Cloud projector failures propagate so the whole transaction rolls back.
 * A DB-owned durable SECURITY_BLOCKED outcome is different: it is returned as SECURITY_BLOCK so
 * the same transaction can commit its alert, sequence receipt, and CLOUD_COMMITTED security ACK.
 */
export class PostgresGatewayBusinessEventProjector implements GatewayBusinessEventProjector {
  public constructor(
    private readonly lifecycle?: InvocationLifecycleProjector,
    private readonly sealAssistantMessage?: AssistantMessageSealer,
  ) {}

  public async project(input: {
    transaction: GatewayTransaction;
    session: Parameters<GatewayBusinessEventProjector['project']>[0]['session'];
    transport: Parameters<GatewayBusinessEventProjector['project']>[0]['transport'];
    event: ProjectableWorkerEvent;
    signal: AbortSignal;
  }): Promise<GatewayProjectionDecision> {
    input.signal.throwIfAborted();
    switch (input.event.type) {
      case 'conversation.ready':
        return this.#projectConversationReady({
          transaction: input.transaction,
          transport: input.transport,
          event: input.event,
          signal: input.signal,
        });
      case 'invocation.prepared': {
        const lifecycle = this.#requireInvocationLifecycle();
        await clearConsumerContext(input.transaction, input.signal);
        const body = input.event.body;
        const fact = WorkerInvocationPreparedFactSchema.parse({
          protocol: body.protocol,
          schemaVersion: body.schemaVersion,
          type: body.type,
          sourceEventId: body.sourceEventId,
          invocationId: body.invocationId,
          agentVersionDigest: body.agentVersionDigest,
          snapshotDigest: body.snapshotDigest,
          executionCapabilityDigest: body.executionCapabilityDigest,
          leaseId: body.leaseId,
          fence: body.fence,
          requestDigest: body.requestDigest,
          prepareCommandId: body.prepareCommandId,
        });
        const outcome = await lifecycle.projectPrepared(
          input.transaction,
          {
            creatorId: input.transport.creatorId,
            installationId: input.transport.installationId,
            fact,
            factDigest: body.factDigest,
          },
          input.signal,
        );
        if (outcome.kind === 'SECURITY_BLOCKED') return 'SECURITY_BLOCK';
        const committed = outcome.committed;
        assertCommittedPrepared(committed, fact, body.factDigest);
        if (committed.state === 'RECONCILING') return 'RECONCILE';
        return committed.replayed ? 'IDEMPOTENT_REPLAY' : 'APPLIED';
      }
      case 'invocation.started': {
        const lifecycle = this.#requireInvocationLifecycle();
        await clearConsumerContext(input.transaction, input.signal);
        const body = input.event.body;
        const fact = WorkerInvocationStartedFactSchema.parse({
          protocol: body.protocol,
          schemaVersion: body.schemaVersion,
          type: body.type,
          sourceEventId: body.sourceEventId,
          invocationId: body.invocationId,
          agentVersionDigest: body.agentVersionDigest,
          snapshotDigest: body.snapshotDigest,
          executionCapabilityDigest: body.executionCapabilityDigest,
          leaseId: body.leaseId,
          fence: body.fence,
          startCommandId: body.startCommandId,
          runtimeThreadId: body.runtimeThreadId,
          runtimeTurnId: body.runtimeTurnId,
          dispatchReceiptDigest: body.dispatchReceiptDigest,
          sandboxAttestationDigest: body.sandboxAttestationDigest,
        });
        const outcome = await lifecycle.projectStarted(
          input.transaction,
          {
            creatorId: input.transport.creatorId,
            installationId: input.transport.installationId,
            fact,
            factDigest: body.factDigest,
          },
          input.signal,
        );
        if (outcome.kind === 'SECURITY_BLOCKED') return 'SECURITY_BLOCK';
        const committed = outcome.committed;
        assertCommittedStarted(committed, fact, body.factDigest);
        if (committed.state === 'RECONCILING') return 'RECONCILE';
        return committed.replayed ? 'IDEMPOTENT_REPLAY' : 'APPLIED';
      }
      case 'invocation.succeeded': {
        const lifecycle = this.#requireInvocationLifecycle();
        await clearConsumerContext(input.transaction, input.signal);
        const body = input.event.body;
        const fact = WorkerInvocationSucceededFactSchema.parse({
          protocol: body.protocol,
          schemaVersion: body.schemaVersion,
          type: body.type,
          sourceEventId: body.sourceEventId,
          invocationId: body.invocationId,
          agentVersionDigest: body.agentVersionDigest,
          snapshotDigest: body.snapshotDigest,
          executionCapabilityDigest: body.executionCapabilityDigest,
          leaseId: body.leaseId,
          fence: body.fence,
          runtimeThreadId: body.runtimeThreadId,
          runtimeTurnId: body.runtimeTurnId,
          startedFactDigest: body.startedFactDigest,
          resultDigest: body.resultDigest,
          localResultCipherDigest: body.localResultCipherDigest,
        });
        const outcome = await lifecycle.projectSuccess(
          input.transaction,
          {
            creatorId: input.transport.creatorId,
            installationId: input.transport.installationId,
            fact,
            factDigest: body.factDigest,
            resultCiphertext: body.resultCiphertext,
          },
          this.sealAssistantMessage,
          input.signal,
        );
        if (outcome.kind === 'SECURITY_BLOCKED') return 'SECURITY_BLOCK';
        const committed = outcome.committed;
        assertCommittedSuccess(committed, fact);
        return committed.replayed ? 'IDEMPOTENT_REPLAY' : 'APPLIED';
      }
      case 'invocation.failed': {
        const lifecycle = this.#requireInvocationLifecycle();
        await clearConsumerContext(input.transaction, input.signal);
        const body = input.event.body;
        const fact = WorkerInvocationFailedFactSchema.parse({
          protocol: body.protocol,
          schemaVersion: body.schemaVersion,
          type: body.type,
          sourceEventId: body.sourceEventId,
          invocationId: body.invocationId,
          agentVersionDigest: body.agentVersionDigest,
          snapshotDigest: body.snapshotDigest,
          executionCapabilityDigest: body.executionCapabilityDigest,
          leaseId: body.leaseId,
          fence: body.fence,
          errorCode: body.errorCode,
        });
        VnextErrorCodeSchema.parse(fact.errorCode);
        const outcome = await lifecycle.projectFailed(
          input.transaction,
          {
            creatorId: input.transport.creatorId,
            installationId: input.transport.installationId,
            fact,
            factDigest: body.factDigest,
          },
          input.signal,
        );
        if (outcome.kind === 'SECURITY_BLOCKED') return 'SECURITY_BLOCK';
        const committed = outcome.committed;
        assertCommittedFailed(committed, fact);
        return committed.replayed ? 'IDEMPOTENT_REPLAY' : 'APPLIED';
      }
      case 'version.ready':
      case 'version.rejected':
      case 'invocation.delta':
      case 'invocation.uncertain':
        throw new PostgresGatewayAuthorityError('BUSINESS_PROJECTOR_UNAVAILABLE');
      case 'invocation.cancelled': {
        const lifecycle = this.#requireInvocationLifecycle();
        await clearConsumerContext(input.transaction, input.signal);
        const body = input.event.body;
        const fact = WorkerInvocationCancelledFactSchema.parse({
          protocol: body.protocol,
          schemaVersion: body.schemaVersion,
          type: body.type,
          sourceEventId: body.sourceEventId,
          invocationId: body.invocationId,
          agentVersionDigest: body.agentVersionDigest,
          snapshotDigest: body.snapshotDigest,
          executionCapabilityDigest: body.executionCapabilityDigest,
          leaseId: body.leaseId,
          fence: body.fence,
          interruptReceiptDigest: body.interruptReceiptDigest,
        });
        const outcome = await lifecycle.projectCancelled(
          input.transaction,
          {
            creatorId: input.transport.creatorId,
            installationId: input.transport.installationId,
            fact,
            factDigest: body.factDigest,
          },
          input.signal,
        );
        if (outcome.kind === 'SECURITY_BLOCKED') return 'SECURITY_BLOCK';
        const committed = outcome.committed;
        assertCommittedCancelled(committed, fact);
        return committed.replayed ? 'IDEMPOTENT_REPLAY' : 'APPLIED';
      }
      default:
        throw new PostgresGatewayAuthorityError('BUSINESS_PROJECTOR_UNAVAILABLE');
    }
  }

  #requireInvocationLifecycle(): InvocationLifecycleProjector {
    if (this.lifecycle === undefined) {
      throw new PostgresGatewayAuthorityError('BUSINESS_PROJECTOR_UNAVAILABLE');
    }
    return this.lifecycle;
  }

  async #projectConversationReady(input: {
    transaction: GatewayTransaction;
    transport: Parameters<GatewayBusinessEventProjector['project']>[0]['transport'];
    event: Extract<ProjectableWorkerEvent, { type: 'conversation.ready' }>;
    signal: AbortSignal;
  }): Promise<GatewayProjectionDecision> {
    const body = input.event.body;
    const fact = assertWorkerConversationReadyFactDigest(
      WorkerConversationReadyFactSchema.parse({
        protocol: body.protocol,
        schemaVersion: body.schemaVersion,
        type: body.type,
        sourceEventId: body.sourceEventId,
        conversationId: body.conversationId,
        openCommandId: body.openCommandId,
        deploymentId: body.deploymentId,
        agentVersionId: body.agentVersionId,
        agentVersionDigest: body.agentVersionDigest,
        snapshotDigest: body.snapshotDigest,
        installationId: body.installationId,
        workerSessionId: body.workerSessionId,
        leaseId: body.leaseId,
        fence: body.fence,
        sandboxInstanceId: body.sandboxInstanceId,
        runtimeThreadId: body.runtimeThreadId,
        readyEvidenceDigest: body.readyEvidenceDigest,
      }),
      body.factDigest,
    );
    if (
      input.event.correlationId !== fact.conversationId ||
      fact.deploymentId !== input.transport.deploymentId ||
      fact.installationId !== input.transport.installationId
    ) {
      return 'SECURITY_BLOCK';
    }
    await clearConsumerContext(input.transaction, input.signal);
    const tenant = await input.transaction.query<{ consumer_subject_id: string }>(
      `SELECT conversation.consumer_subject_id::text
         FROM public.agent_conversations AS conversation
         JOIN public.agent_versions AS version
           ON version.id = conversation.agent_version_id
          AND version.creator_id = conversation.creator_id
          AND version.version_digest = conversation.version_digest
         JOIN public.context_snapshots AS snapshot
           ON snapshot.id = version.snapshot_id
          AND snapshot.creator_id = version.creator_id
         JOIN public.broker_outbox AS open_command
           ON open_command.command_id = $8::uuid
          AND open_command.creator_id = conversation.creator_id
          AND open_command.target_worker_id = conversation.assigned_worker_id
          AND open_command.conversation_id = conversation.id
          AND open_command.consumer_subject_id = conversation.consumer_subject_id
          AND open_command.deployment_id = conversation.deployment_id
         JOIN public.worker_leases AS original_lease
           ON original_lease.id = $9::uuid
          AND original_lease.creator_id = conversation.creator_id
          AND original_lease.worker_id = conversation.assigned_worker_id
          AND original_lease.deployment_id = conversation.deployment_id
          AND original_lease.fence = $10::bigint
          AND open_command.assignment_lease_id = original_lease.id
          AND open_command.assignment_fence = original_lease.fence
         JOIN public.worker_gateway_sessions AS original_session
           ON original_session.id = $11::uuid
          AND original_session.creator_id = conversation.creator_id
          AND original_session.installation_id = conversation.assigned_worker_id
          AND original_session.connection_id = original_lease.connection_id
        WHERE conversation.id = $1::uuid
          AND conversation.creator_id = $2::uuid
          AND conversation.deployment_id = $3::uuid
          AND conversation.agent_version_id = $4::uuid
          AND conversation.version_digest = $5::text
          AND snapshot.snapshot_digest = $6::text
          AND conversation.assigned_worker_id = $7::uuid
          AND open_command.command_type = 'conversation.open'
          AND open_command.state IN ('SENT', 'ACKED')`,
      [
        fact.conversationId,
        input.transport.creatorId,
        fact.deploymentId,
        fact.agentVersionId,
        fact.agentVersionDigest,
        fact.snapshotDigest,
        fact.installationId,
        fact.openCommandId,
        fact.leaseId,
        fact.fence,
        fact.workerSessionId,
      ],
      input.signal,
    );
    if (tenant.rows.length === 0) return 'SECURITY_BLOCK';
    if (tenant.rows.length !== 1) throw persistenceFailure();
    const parsedConsumerId = UuidSchema.safeParse(tenant.rows[0]?.consumer_subject_id);
    if (!parsedConsumerId.success) throw persistenceFailure();
    const consumerId = parsedConsumerId.data;
    await input.transaction.query(
      `SELECT pg_catalog.set_config('app.consumer_id', $1::text, true)`,
      [consumerId],
      input.signal,
    );
    const result = await input.transaction.query<ConversationReadyRow>(
      `SELECT outcome, conversation_state, open_command_id::text
         FROM public.creator_agent_commit_conversation_ready_fact(
           $1::uuid, $2::text, $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, $7::uuid, $8::text,
           $9::text, $10::uuid, $11::uuid, $12::uuid,
           $13::bigint, $14::uuid, $15::text, $16::text
         )`,
      [
        fact.sourceEventId,
        body.factDigest,
        fact.conversationId,
        input.transport.creatorId,
        consumerId,
        fact.deploymentId,
        fact.agentVersionId,
        fact.agentVersionDigest,
        fact.snapshotDigest,
        fact.installationId,
        fact.workerSessionId,
        fact.leaseId,
        fact.fence,
        fact.sandboxInstanceId,
        fact.runtimeThreadId,
        fact.readyEvidenceDigest,
      ],
      input.signal,
    );
    if (result.rows.length !== 1) throw persistenceFailure();
    const row = result.rows[0]!;
    if (row.outcome === 'REJECTED') {
      if (row.conversation_state !== null || row.open_command_id !== null) {
        throw persistenceFailure();
      }
      return 'SECURITY_BLOCK';
    }
    if (
      (row.outcome !== 'APPLIED' && row.outcome !== 'REPLAY') ||
      row.conversation_state === null ||
      !CONVERSATION_STATES.has(row.conversation_state) ||
      row.open_command_id === null
    ) {
      throw persistenceFailure();
    }
    if (!UuidSchema.safeParse(row.open_command_id).success) throw persistenceFailure();
    if (row.open_command_id !== fact.openCommandId) throw persistenceFailure();
    if (row.outcome === 'APPLIED' && row.conversation_state !== 'IDLE') {
      throw persistenceFailure();
    }
    return row.outcome === 'REPLAY' ? 'IDEMPOTENT_REPLAY' : 'APPLIED';
  }
}

async function clearConsumerContext(
  transaction: GatewayTransaction,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await transaction.query(
    `SELECT pg_catalog.set_config('app.consumer_id', ''::text, true)`,
    [],
    signal,
  );
}

function persistenceFailure(): PostgresGatewayAuthorityError {
  return new PostgresGatewayAuthorityError('PERSISTENCE_INVARIANT_FAILED');
}

function assertCommittedPrepared(
  committed: CommittedPrepared,
  fact: WorkerInvocationPreparedFact,
  factDigest: string,
): void {
  if (
    committed.invocationId !== fact.invocationId ||
    committed.prepareCommandId !== fact.prepareCommandId ||
    !Sha256HexSchema.safeParse(committed.factDigest).success ||
    committed.factDigest !== factDigest ||
    (committed.state !== 'PERSISTED' && committed.state !== 'RECONCILING') ||
    (committed.state === 'PERSISTED' && committed.startCommandId === null) ||
    (committed.state === 'RECONCILING' && committed.startCommandId !== null) ||
    typeof committed.replayed !== 'boolean'
  ) {
    throw persistenceFailure();
  }
  if (
    committed.startCommandId !== null &&
    !UuidSchema.safeParse(committed.startCommandId).success
  ) {
    throw persistenceFailure();
  }
}

function assertCommittedStarted(
  committed: CommittedStarted,
  fact: WorkerInvocationStartedFact,
  factDigest: string,
): void {
  if (
    committed.invocationId !== fact.invocationId ||
    committed.startCommandId !== fact.startCommandId ||
    !Sha256HexSchema.safeParse(committed.factDigest).success ||
    committed.factDigest !== factDigest ||
    (committed.state !== 'RUNNING' && committed.state !== 'RECONCILING') ||
    typeof committed.replayed !== 'boolean' ||
    !IsoDateTimeSchema.safeParse(committed.startedAt).success
  ) {
    throw persistenceFailure();
  }
}

function assertCommittedSuccess(
  committed: CommittedSuccess,
  fact: WorkerInvocationSucceededFact,
): void {
  if (
    committed.invocationId !== fact.invocationId ||
    committed.resultDigest !== fact.resultDigest ||
    !HmacSha256DigestSchema.safeParse(committed.resultDigest).success ||
    !UuidSchema.safeParse(committed.assistantMessageId).success ||
    (committed.consumerEventCursor === null && committed.replayed !== true) ||
    (committed.consumerEventCursor !== null &&
      !Uint63StringSchema.safeParse(committed.consumerEventCursor).success) ||
    typeof committed.replayed !== 'boolean'
  ) {
    throw persistenceFailure();
  }
}

function assertCommittedCancelled(
  committed: CommittedCancelled,
  fact: WorkerInvocationCancelledFact,
): void {
  if (
    committed.invocationId !== fact.invocationId ||
    committed.state !== 'CANCELLED' ||
    (committed.consumerEventCursor === null && committed.replayed !== true) ||
    (committed.consumerEventCursor !== null &&
      !Uint63StringSchema.safeParse(committed.consumerEventCursor).success) ||
    typeof committed.replayed !== 'boolean'
  ) {
    throw persistenceFailure();
  }
}

function assertCommittedFailed(committed: CommittedFailed, fact: WorkerInvocationFailedFact): void {
  if (
    committed.invocationId !== fact.invocationId ||
    committed.state !== 'FAILED' ||
    !VnextErrorCodeSchema.safeParse(committed.errorCode).success ||
    committed.errorCode !== fact.errorCode ||
    (committed.consumerEventCursor === null && committed.replayed !== true) ||
    (committed.consumerEventCursor !== null &&
      !Uint63StringSchema.safeParse(committed.consumerEventCursor).success) ||
    typeof committed.replayed !== 'boolean'
  ) {
    throw persistenceFailure();
  }
}
