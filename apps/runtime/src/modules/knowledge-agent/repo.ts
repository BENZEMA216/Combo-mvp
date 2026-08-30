import { createHash } from 'node:crypto';
import type { CreatorKnowledgeBundle } from '@cb/creator-agent-protocol/knowledge-bundle';
import {
  INSUFFICIENT_EVIDENCE_ANSWER,
  KnowledgeAgentBindingSchema,
  KnowledgeTurnResultSchema,
  knowledgeBindingsEqual,
  type KnowledgeAgentBinding,
  type KnowledgeTurnResult,
} from '@cb/shared';

import {
  withTransaction,
  type Queryable,
  type RuntimeDb,
  type TransactionOptions,
} from '../../platform/infra/db.js';
import { appendTurnMessage, toIso, type MessageRecord } from '../session/repo.js';
import {
  completeUsageCharge,
  findUsageChargeByTurn,
  releaseUsageCharge,
  type KnowledgeExecutionOutcome,
  type UsageChargeRecord,
} from '../billing/repo.js';
import {
  finishTurnCas,
  lockRunningTurn,
  lockTurnSession,
  type TerminalTurn,
  type TerminalTurnStatus,
  type TurnLastError,
} from '../agent/turn-repo.js';

export type KnowledgeValidationCode =
  | 'accepted'
  | 'insufficient_evidence'
  | 'not_run'
  | 'rejected'
  | 'unavailable'
  | 'protocol_invalid';

export interface KnowledgeTerminalInput {
  sessionId: string;
  turnId: string;
  /**
   * The ordinary executor supplies the resolved binding as a second assertion. Recovery paths
   * deliberately omit it and use the immutable usage reservation as their only product truth.
   */
  binding?: KnowledgeAgentBinding;
  outcome: KnowledgeExecutionOutcome;
  validationCode: KnowledgeValidationCode;
  answer: string | null;
  citationChunkIds: readonly string[];
  runtimeSourceSha: string;
  lastError?: TurnLastError | null;
}

export interface KnowledgeTerminalResult {
  won: boolean;
  turnStatus?: TerminalTurnStatus;
  response?: MessageRecord | null;
  receiptId?: string;
}

function digestText(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function terminalStatus(outcome: KnowledgeExecutionOutcome): TerminalTurnStatus {
  if (outcome === 'answered' || outcome === 'insufficient_evidence') return 'completed';
  return outcome;
}

type ResolvedKnowledgeTerminalInput = KnowledgeTerminalInput & { binding: KnowledgeAgentBinding };

function validateTerminalInput(input: KnowledgeTerminalInput): void {
  if (!/^[0-9a-f]{40}$/u.test(input.runtimeSourceSha)) {
    throw new Error('knowledge terminal Runtime identity is invalid');
  }
  if (input.binding && input.binding.productKind !== 'knowledge_agent_test') {
    throw new Error('knowledge terminal binding is invalid');
  }
  if (input.outcome === 'answered') {
    if (
      input.validationCode !== 'accepted' ||
      !input.answer ||
      input.answer === INSUFFICIENT_EVIDENCE_ANSWER ||
      input.citationChunkIds.length < 1
    ) {
      throw new Error('answered knowledge terminal is invalid');
    }
  } else if (input.outcome === 'insufficient_evidence') {
    if (
      input.validationCode !== 'insufficient_evidence' ||
      input.answer !== INSUFFICIENT_EVIDENCE_ANSWER ||
      input.citationChunkIds.length !== 0
    ) {
      throw new Error('insufficient knowledge terminal is invalid');
    }
  } else if (
    input.answer !== null ||
    input.citationChunkIds.length !== 0 ||
    (input.outcome === 'interrupted' && input.validationCode !== 'not_run') ||
    (input.outcome === 'failed' &&
      !['not_run', 'rejected', 'unavailable', 'protocol_invalid'].includes(input.validationCode))
  ) {
    throw new Error('failed knowledge terminal is invalid');
  }
  for (let index = 0; index < input.citationChunkIds.length; index += 1) {
    const current = input.citationChunkIds[index]!;
    if (
      !/^chunk[.]knowledge[.][0-9a-f]{32}$/u.test(current) ||
      (index > 0 && input.citationChunkIds[index - 1]! >= current)
    ) {
      throw new Error('knowledge terminal citations are invalid');
    }
  }
}

function bindingMatchesCharge(binding: KnowledgeAgentBinding, charge: UsageChargeRecord): boolean {
  const frozen = charge.knowledgeBinding;
  return (
    charge.productKind === 'knowledge_agent_test' &&
    frozen !== null &&
    frozen.capability.id === binding.capability.id &&
    frozen.capability.protocol === binding.capability.protocol &&
    frozen.release.protocol === binding.release.protocol &&
    frozen.release.releaseId === binding.release.releaseId &&
    frozen.release.packageDigest === binding.release.packageDigest &&
    frozen.releaseScope === binding.releaseScope &&
    frozen.knowledge.protocol === binding.knowledge.protocol &&
    frozen.knowledge.resourcePath === binding.knowledge.resourcePath &&
    frozen.knowledge.resourceDigest === binding.knowledge.resourceDigest
  );
}

async function insertReceipt(
  db: Queryable,
  input: ResolvedKnowledgeTerminalInput,
  charge: UsageChargeRecord,
  response: MessageRecord | null,
): Promise<string> {
  if (!charge.billingPolicyVersion || !charge.validatorPolicyVersion) {
    throw new Error('knowledge usage policy snapshot is missing');
  }
  const settledCents =
    input.outcome === 'answered' && charge.chargeSource === 'wallet' ? charge.reservedCents : 0n;
  const result = await db.query<{ id: string }>(
    `INSERT INTO agent_usage_receipts
       (protocol, usage_charge_id, owner_user_id, usage_id, capability_id, session_id, turn_id,
        product_kind, capability_protocol, release_id, package_digest, release_scope,
        knowledge_resource_path, knowledge_resource_digest,
        billing_policy_version, validator_policy_version,
        unit_price_cents, free_limit_snapshot, charge_source, settled_cents,
        execution_outcome, validation_code, response_message_id, response_digest,
        citation_chunk_ids, execution_environment, runtime_release_id, runtime_source_sha)
     VALUES
       ('combo.agent-usage-receipt/1', $1, $2, $3, $4, $5, $6,
        'knowledge_agent_test', $7, $8, $9, $10, $11, $12, $13, $14,
        $15::bigint, $16, $17, $18::bigint, $19, $20, $21, $22, $23::text[],
        'test', $24, $25)
     RETURNING id`,
    [
      charge.id,
      charge.ownerUserId,
      charge.usageId,
      charge.capabilityId,
      charge.sessionId,
      charge.turnId,
      input.binding.capability.protocol,
      input.binding.release.releaseId,
      input.binding.release.packageDigest,
      input.binding.releaseScope,
      input.binding.knowledge.resourcePath,
      input.binding.knowledge.resourceDigest,
      charge.billingPolicyVersion,
      charge.validatorPolicyVersion,
      charge.unitPriceCents.toString(),
      charge.freeLimitSnapshot,
      charge.chargeSource,
      settledCents.toString(),
      input.outcome,
      input.validationCode,
      response?.id ?? null,
      response && input.answer !== null ? digestText(input.answer) : null,
      [...input.citationChunkIds],
      `release-${input.runtimeSourceSha}`,
      input.runtimeSourceSha,
    ],
  );
  const receiptId = result.rows[0]?.id;
  if (!receiptId) throw new Error('knowledge receipt insert returned no row');
  return receiptId;
}

/**
 * Commits the only authoritative knowledge terminal. The transaction follows the database lock
 * order Session -> Turn -> usage charge -> response Message and appends Redis only after return.
 */
export async function finishKnowledgeTurn(
  db: RuntimeDb,
  input: KnowledgeTerminalInput,
  options: {
    beforeFinish?: (turn: { id: string; sessionId: string }) => Promise<void>;
    transaction?: TransactionOptions;
  } = {},
): Promise<KnowledgeTerminalResult> {
  validateTerminalInput(input);
  return withTransaction(
    db,
    async (transaction) => {
      await lockTurnSession(transaction, input.sessionId);
      if (!(await lockRunningTurn(transaction, input.turnId, input.sessionId))) {
        return { won: false };
      }
      const charge = await findUsageChargeByTurn(transaction, input.turnId);
      if (
        !charge ||
        charge.status !== 'reserved' ||
        charge.sessionId !== input.sessionId ||
        charge.productKind !== 'knowledge_agent_test' ||
        charge.knowledgeBinding === null ||
        (input.binding !== undefined && !bindingMatchesCharge(input.binding, charge))
      ) {
        throw new Error('knowledge usage reservation is invalid');
      }
      const resolvedInput: ResolvedKnowledgeTerminalInput = {
        ...input,
        binding: charge.knowledgeBinding,
      };
      await options.beforeFinish?.({ id: input.turnId, sessionId: input.sessionId });

      const status = terminalStatus(input.outcome);
      const won = await finishTurnCas(transaction, {
        id: input.turnId,
        status,
        lastError: input.lastError ?? null,
      });
      if (!won) return { won: false };

      let response: MessageRecord | null = null;
      if (input.answer !== null) {
        response = await appendTurnMessage(transaction, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          idx: 1,
          role: 'assistant',
          content: [{ type: 'text', text: input.answer }],
          status: 'completed',
        });
      }

      if (input.outcome === 'answered') {
        await completeUsageCharge(transaction, charge, 'answered');
      } else {
        await releaseUsageCharge(transaction, charge, input.outcome);
      }
      const receiptId = await insertReceipt(transaction, resolvedInput, charge, response);
      return { won: true, turnStatus: status, response, receiptId };
    },
    options.transaction,
  );
}

/**
 * Knowledge counterpart to the legacy stale-Turn sweeper. It never writes a candidate response;
 * every claimed Turn releases the reservation and records an immutable failed receipt.
 */
export async function sweepExpiredKnowledgeTurns(
  db: RuntimeDb,
  cutoff: Date,
  input: {
    runtimeSourceSha: string;
    beforeFinish?: (turn: { id: string; sessionId: string }) => Promise<void>;
  },
): Promise<TerminalTurn[]> {
  const candidates = await db.query<{ id: string; session_id: string }>(
    `SELECT t.id, t.session_id
       FROM turns t
       JOIN usage_charges uc ON uc.turn_id = t.id
      WHERE t.status = 'running'
        AND t.created_at < $1
        AND uc.product_kind = 'knowledge_agent_test'
      ORDER BY t.created_at, t.id`,
    [cutoff],
  );
  const swept: TerminalTurn[] = [];
  for (const candidate of candidates.rows) {
    const lastError: TurnLastError = {
      code: 'TURN_ABANDONED',
      message: '轮次运行超时，已由清扫器终止。',
    };
    const terminal = await finishKnowledgeTurn(
      db,
      {
        sessionId: candidate.session_id,
        turnId: candidate.id,
        outcome: 'failed',
        validationCode: 'unavailable',
        answer: null,
        citationChunkIds: [],
        runtimeSourceSha: input.runtimeSourceSha,
        lastError,
      },
      { beforeFinish: input.beforeFinish },
    );
    if (terminal.won) {
      swept.push({
        id: candidate.id,
        sessionId: candidate.session_id,
        status: 'failed',
        lastError,
      });
    }
  }
  return swept;
}

export interface KnowledgeReceiptDbRow {
  id: string;
  usage_id: string;
  turn_id: string;
  capability_id: string;
  capability_protocol: string;
  release_id: string;
  package_digest: string;
  release_scope: string;
  knowledge_resource_path: string;
  knowledge_resource_digest: string;
  billing_policy_version: string;
  validator_policy_version: string;
  unit_price_cents: string | number | bigint;
  free_limit_snapshot: number;
  charge_source: string;
  settled_cents: string | number | bigint;
  execution_outcome: string;
  validation_code: string;
  response_message_id: string | null;
  response_digest: string | null;
  citation_chunk_ids: string[];
  execution_environment: string;
  runtime_release_id: string;
  runtime_source_sha: string;
  created_at: string | Date;
}

export async function readKnowledgeUsageReceipts(
  db: Queryable,
  sessionId: string,
): Promise<KnowledgeReceiptDbRow[]> {
  const result = await db.query<KnowledgeReceiptDbRow>(
    `SELECT id, usage_id, turn_id, capability_id, capability_protocol,
            release_id, package_digest, release_scope,
            knowledge_resource_path, knowledge_resource_digest,
            billing_policy_version, validator_policy_version,
            unit_price_cents, free_limit_snapshot, charge_source, settled_cents,
            execution_outcome, validation_code, response_message_id, response_digest,
            citation_chunk_ids, execution_environment,
            runtime_release_id, runtime_source_sha, created_at
       FROM agent_usage_receipts
      WHERE session_id = $1
      ORDER BY created_at, id`,
    [sessionId],
  );
  return result.rows;
}

function nonNegativeCents(value: string | number | bigint): string {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(value);
    if (parsed < 0n) throw new Error('negative');
    return parsed.toString();
  } catch {
    throw new Error('knowledge receipt amount is invalid');
  }
}

function responseText(message: MessageRecord): string {
  if (
    message.role !== 'assistant' ||
    message.status !== 'completed' ||
    message.content.length !== 1
  ) {
    throw new Error('knowledge receipt response Message is invalid');
  }
  const block = message.content[0];
  if (
    typeof block !== 'object' ||
    block === null ||
    Object.getPrototypeOf(block) !== Object.prototype ||
    Reflect.ownKeys(block).length !== 2 ||
    (block as { type?: unknown }).type !== 'text' ||
    typeof (block as { text?: unknown }).text !== 'string'
  ) {
    throw new Error('knowledge receipt response Message is invalid');
  }
  return (block as { text: string }).text;
}

function bindingFromReceipt(row: KnowledgeReceiptDbRow): KnowledgeAgentBinding {
  return KnowledgeAgentBindingSchema.parse({
    productKind: 'knowledge_agent_test',
    capability: { id: row.capability_id, protocol: row.capability_protocol },
    release: {
      protocol: 'combo.agent-package-release/1',
      releaseId: row.release_id,
      packageDigest: row.package_digest,
    },
    releaseScope: row.release_scope,
    knowledge: {
      protocol: 'combo.knowledge-bundle/1',
      resourcePath: row.knowledge_resource_path,
      resourceDigest: row.knowledge_resource_digest,
    },
  });
}

/** Re-verifies every display field from the immutable receipt, Message, and frozen Bundle bytes. */
export function projectKnowledgeResults(input: {
  binding: KnowledgeAgentBinding;
  receipts: readonly KnowledgeReceiptDbRow[];
  messages: readonly MessageRecord[];
  knowledge: CreatorKnowledgeBundle;
}): KnowledgeTurnResult[] {
  const messages = new Map(input.messages.map((message) => [message.id, message]));
  const chunks = new Map(input.knowledge.chunks.map((chunk) => [chunk.id, chunk]));
  return input.receipts.map((row) => {
    const binding = bindingFromReceipt(row);
    if (!knowledgeBindingsEqual(binding, input.binding)) {
      throw new Error('knowledge receipt binding diverged from Session');
    }
    let answer: { messageId: string; text: string; responseDigest: string } | null = null;
    if (row.response_message_id !== null) {
      const message = messages.get(row.response_message_id);
      if (!message || message.turnId !== row.turn_id) {
        throw new Error('knowledge receipt response Message is missing');
      }
      const text = responseText(message);
      const responseDigest = digestText(text);
      if (row.response_digest !== responseDigest) {
        throw new Error('knowledge receipt response digest mismatch');
      }
      answer = { messageId: message.id, text, responseDigest };
    } else if (row.response_digest !== null) {
      throw new Error('knowledge receipt response digest has no Message');
    }

    const citations = row.citation_chunk_ids.map((chunkId) => {
      const chunk = chunks.get(chunkId);
      if (!chunk) throw new Error('knowledge receipt citation is absent from the frozen Bundle');
      return {
        chunkId: chunk.id,
        sourceId: chunk.source.sourceId,
        displayLabel: chunk.source.displayLabel,
      };
    });
    return KnowledgeTurnResultSchema.parse({
      protocol: 'combo.agent-usage-receipt/1',
      receiptId: row.id,
      usageId: row.usage_id,
      turnId: row.turn_id,
      createdAt: toIso(row.created_at),
      binding,
      billing: {
        policyVersion: row.billing_policy_version,
        source: row.charge_source,
        currency: 'CNY',
        unitPriceCents: nonNegativeCents(row.unit_price_cents),
        settledCents: nonNegativeCents(row.settled_cents),
        freeLimitSnapshot: row.free_limit_snapshot,
      },
      runtime: {
        environment: row.execution_environment,
        releaseId: row.runtime_release_id,
        sourceSha: row.runtime_source_sha,
      },
      outcome: row.execution_outcome,
      validation: {
        policyVersion: row.validator_policy_version,
        code: row.validation_code,
      },
      answer,
      citations,
    });
  });
}
