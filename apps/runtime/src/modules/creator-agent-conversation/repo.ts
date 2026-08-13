import { createHash } from 'node:crypto';
import {
  canonicalizeJson,
  ConversationViewSchema,
  IdempotencyKeySchema,
  type VnextErrorCode,
} from '@cb/creator-agent-protocol';
import { z } from 'zod';
import { withTransaction, type RuntimeDb } from '../../platform/infra/db.js';

export const CONSUMER_CONVERSATION_TTL_SECONDS = 30 * 24 * 60 * 60;

export const AgentPublicSlugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/u);

export const DeploymentEnvironmentSchema = z.enum(['TEST', 'PREVIEW', 'PROD']);
export type DeploymentEnvironment = z.infer<typeof DeploymentEnvironmentSchema>;

const CreateConversationInputSchema = z
  .object({
    consumerId: z.string().uuid(),
    publicSlug: AgentPublicSlugSchema,
    idempotencyKey: IdempotencyKeySchema,
    environment: DeploymentEnvironmentSchema,
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(CONSUMER_CONVERSATION_TTL_SECONDS)
      .default(CONSUMER_CONVERSATION_TTL_SECONDS),
  })
  .strict();

export type CreateConsumerConversationInput = z.input<typeof CreateConversationInputSchema>;

interface CreateConsumerConversationOptions {
  /** Internal deterministic-test seam; production always uses the 2-second default. */
  transactionDeadlineMs?: number;
}

export class ConsumerConversationError extends Error {
  public constructor(
    public readonly code: Extract<
      VnextErrorCode,
      'FORBIDDEN' | 'IDEMPOTENCY_CONFLICT' | 'AGENT_OFFLINE' | 'VERSION_UNAVAILABLE'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'ConsumerConversationError';
  }
}

interface ExistingConversationRow {
  id: string;
  agent_id: string;
  agent_version_id: string;
  version_digest: string;
  state: string;
  created_at: Date | string;
  expires_at: Date | string;
  request_digest: string;
}

interface AccessibleAgentRow {
  agent_id: string;
  creator_id: string;
}

interface DeploymentRow {
  deployment_id: string;
  desired_state: string;
  observed_state: string;
  generation: string | number | bigint;
  observed_generation: string | number | bigint | null;
  lease_fence: string | number | bigint;
  serving_version_id: string | null;
  observed_worker_id: string | null;
  version_digest: string | null;
}

interface VersionControlRow {
  availability: string;
}

interface LiveWorkerRow {
  live: boolean;
}

type InsertedConversationRow = Omit<ExistingConversationRow, 'request_digest'>;

function isoDate(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error('Conversation timestamp is invalid');
  return parsed.toISOString();
}

export function createConversationRequestDigest(input: {
  publicSlug: string;
  environment: DeploymentEnvironment;
}): string {
  const bytes = canonicalizeJson({
    protocol: 'combo.creator-agent-create-conversation-request/1',
    publicSlug: AgentPublicSlugSchema.parse(input.publicSlug),
    environment: DeploymentEnvironmentSchema.parse(input.environment),
  });
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function conversationView(row: InsertedConversationRow) {
  return ConversationViewSchema.parse({
    protocol: 'combo.creator-agent-http/1',
    conversationId: row.id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    versionDigest: row.version_digest,
    state: row.state,
    createdAt: isoDate(row.created_at),
    expiresAt: isoDate(row.expires_at),
  });
}

/**
 * 在一个 PostgreSQL transaction 内把公开 slug、ACTIVE grant、ONLINE Deployment、
 * serving Version 和当前 Worker Lease 固定到不可变 Conversation。公开 slug 只定位，
 * 没有 ACTIVE grant 时 RLS 不会让调用者看到 Agent 行。
 */
export async function createConsumerConversation(
  db: RuntimeDb,
  rawInput: CreateConsumerConversationInput,
  options: CreateConsumerConversationOptions = {},
) {
  const input = CreateConversationInputSchema.parse(rawInput);
  const requestDigest = createConversationRequestDigest(input);
  // One deadline covers pool acquisition, every SQL statement, and COMMIT. The SQL authority
  // requires the Lease to remain live for >3 seconds at the lock point, so a transaction that can
  // run for at most 2 seconds cannot commit after the accepted Lease has naturally expired.
  const transactionDeadlineMs = options.transactionDeadlineMs ?? 2_000;
  if (
    !Number.isSafeInteger(transactionDeadlineMs) ||
    transactionDeadlineMs <= 0 ||
    transactionDeadlineMs > 2_000
  ) {
    throw new Error('Conversation transaction deadline is invalid');
  }
  const transactionDeadline = AbortSignal.timeout(transactionDeadlineMs);

  return withTransaction(
    db,
    async (tx) => {
      await tx.query(`SELECT set_config('app.consumer_id', $1, true)`, [input.consumerId]);
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `creator-agent:create-conversation:${input.consumerId}:${input.idempotencyKey}`,
      ]);

      const replay = await tx.query<ExistingConversationRow>(
        `SELECT id, agent_id, agent_version_id, version_digest, state,
                created_at, expires_at, request_digest
           FROM agent_conversations
          WHERE consumer_subject_id = $1 AND idempotency_key = $2`,
        [input.consumerId, input.idempotencyKey],
      );
      const existing = replay.rows[0];
      if (existing) {
        if (existing.request_digest !== requestDigest) {
          throw new ConsumerConversationError(
            'IDEMPOTENCY_CONFLICT',
            '同一 Idempotency-Key 绑定了不同的 Agent 或环境',
          );
        }
        return { conversation: conversationView(existing), replayed: true } as const;
      }

      const accessibleAgent = await tx.query<AccessibleAgentRow>(
        `SELECT agent.id AS agent_id, agent.creator_id
           FROM agents AS agent
           JOIN agent_access_grants AS access_grant
             ON access_grant.agent_id = agent.id
            AND access_grant.creator_id = agent.creator_id
            AND access_grant.consumer_subject_id = $2
            AND access_grant.state = 'ACTIVE'
          WHERE agent.public_slug = $1 AND agent.lifecycle = 'ACTIVE'
        `,
        [input.publicSlug, input.consumerId],
      );
      const agent = accessibleAgent.rows[0];
      if (!agent) {
        throw new ConsumerConversationError('FORBIDDEN', 'Consumer 没有该 Agent 的有效授权');
      }

      await tx.query(`SELECT set_config('app.creator_id', $1, true)`, [agent.creator_id]);

      // A Consumer-only RLS context may read an ACTIVE grant, but the API role intentionally has
      // no UPDATE privilege and therefore cannot acquire a row lock directly. The narrow definer
      // revalidates both transaction identities and SHARE-locks only this exact tuple.
      const lockedGrant = await tx.query<{ live: boolean }>(
        `SELECT creator_agent_lock_consumer_access($1, $2, $3) AS live`,
        [agent.agent_id, agent.creator_id, input.consumerId],
      );
      if (lockedGrant.rows[0]?.live !== true) {
        throw new ConsumerConversationError('FORBIDDEN', 'Consumer 没有该 Agent 的有效授权');
      }

      const deploymentResult = await tx.query<DeploymentRow>(
        `SELECT deployment.id AS deployment_id,
                deployment.desired_state,
                deployment.observed_state,
                deployment.generation,
                deployment.observed_generation,
                deployment.lease_fence,
                deployment.serving_version_id,
                deployment.observed_worker_id,
                version.version_digest
           FROM deployments AS deployment
           LEFT JOIN agent_versions AS version
             ON version.id = deployment.serving_version_id
            AND version.agent_id = deployment.agent_id
            AND version.creator_id = deployment.creator_id
          WHERE deployment.agent_id = $1
            AND deployment.creator_id = $2
            AND deployment.environment = $3
          FOR SHARE OF deployment`,
        [agent.agent_id, agent.creator_id, input.environment],
      );
      const deployment = deploymentResult.rows[0];
      if (!deployment) {
        throw new ConsumerConversationError('AGENT_OFFLINE', 'Agent 没有可用 Deployment');
      }
      if (deployment.serving_version_id === null || deployment.version_digest === null) {
        throw new ConsumerConversationError('VERSION_UNAVAILABLE', 'Agent Version 当前不可用');
      }
      if (
        deployment.desired_state !== 'ONLINE' ||
        deployment.observed_state !== 'ONLINE' ||
        deployment.observed_worker_id === null ||
        deployment.observed_generation === null ||
        BigInt(deployment.observed_generation) !== BigInt(deployment.generation)
      ) {
        throw new ConsumerConversationError('AGENT_OFFLINE', 'Creator Agent 当前不在线');
      }

      const versionControl = await tx.query<VersionControlRow>(
        `SELECT availability
           FROM agent_version_controls
          WHERE version_id = $1
            AND creator_id = $2
            AND availability = 'ACTIVE'
          FOR SHARE`,
        [deployment.serving_version_id, agent.creator_id],
      );
      if (!versionControl.rows[0]) {
        throw new ConsumerConversationError('VERSION_UNAVAILABLE', 'Agent Version 当前不可用');
      }

      const liveWorker = await tx.query<LiveWorkerRow>(
        `SELECT creator_agent_lock_live_worker($1, $2, $3, $4) AS live`,
        [
          deployment.deployment_id,
          agent.creator_id,
          deployment.observed_worker_id,
          deployment.lease_fence,
        ],
      );
      if (liveWorker.rows[0]?.live !== true) {
        throw new ConsumerConversationError('AGENT_OFFLINE', 'Creator Worker Lease 已失效');
      }

      const inserted = await tx.query<InsertedConversationRow>(
        `INSERT INTO agent_conversations (
           agent_id, deployment_id, agent_version_id, creator_id,
           consumer_subject_id, idempotency_key, request_digest, version_digest,
           state, assigned_worker_id, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           'IDLE', $9, now() + make_interval(secs => $10)
         )
         ON CONFLICT (consumer_subject_id, idempotency_key) DO NOTHING
         RETURNING id, agent_id, agent_version_id, version_digest, state, created_at, expires_at`,
        [
          agent.agent_id,
          deployment.deployment_id,
          deployment.serving_version_id,
          agent.creator_id,
          input.consumerId,
          input.idempotencyKey,
          requestDigest,
          deployment.version_digest,
          deployment.observed_worker_id,
          input.ttlSeconds,
        ],
      );
      const conversation = inserted.rows[0];
      if (!conversation) {
        // The unique constraint is the final authority even if a process crash or an
        // advisory-lock collision lets two transactions reach INSERT. PostgreSQL waits
        // for the winner before DO NOTHING, so this following statement sees its commit.
        const winnerResult = await tx.query<ExistingConversationRow>(
          `SELECT id, agent_id, agent_version_id, version_digest, state,
                  created_at, expires_at, request_digest
             FROM agent_conversations
            WHERE consumer_subject_id = $1 AND idempotency_key = $2
            FOR UPDATE`,
          [input.consumerId, input.idempotencyKey],
        );
        const winner = winnerResult.rows[0];
        if (!winner) throw new Error('Conversation idempotency winner is unavailable');
        if (winner.request_digest !== requestDigest) {
          throw new ConsumerConversationError(
            'IDEMPOTENCY_CONFLICT',
            '同一 Idempotency-Key 绑定了不同的 Agent 或环境',
          );
        }
        return { conversation: conversationView(winner), replayed: true } as const;
      }
      return { conversation: conversationView(conversation), replayed: false } as const;
    },
    { timeoutMs: transactionDeadlineMs, signal: transactionDeadline },
  );
}
