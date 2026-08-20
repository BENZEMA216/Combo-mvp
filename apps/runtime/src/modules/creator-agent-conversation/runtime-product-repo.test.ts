import { randomUUID } from 'node:crypto';

import {
  ExecutionCapabilitySchema,
  executionCapabilityDigest,
  type ExecutionCapability,
} from '@cb/creator-agent-protocol';
import type { EncryptedMessage, MessageAad } from '@cb/creator-agent-persistence';
import { describe, expect, it, vi } from 'vitest';

import type { QueryResultLike, RuntimeDb } from '../../platform/infra/db.js';
import type { ConsumerMessageAuthority } from './consumer-message-authority.js';
import type { InvocationPrepareAuthority } from './invocation-prepare-authority.js';
import {
  readConsumerConversationTranscript,
  readConsumerInvocation,
  sendConsumerMessage,
  type ConsumerRuntimeProductAuthorities,
} from './runtime-product-repo.js';

const HMAC = `hmac-sha256:${'a'.repeat(64)}`;
const SHA = 'b'.repeat(64);

function uuidV7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

function fakeDb(
  responder: (sql: string, params: unknown[] | undefined) => Promise<{ rows: unknown[] }>,
  events?: string[],
) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const query = async <R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResultLike<R>> => {
    queries.push({ sql, params });
    if (sql === 'COMMIT') events?.push('db:commit');
    if (sql.includes('creator_agent_finalize_consumer_message_v2')) events?.push('db:finalize');
    const result = await responder(sql, params);
    return { rows: result.rows as R[], rowCount: result.rows.length };
  };
  const db: RuntimeDb = {
    query,
    async connect() {
      return { query, release: vi.fn() };
    },
  };
  return { db, queries };
}

function encrypted(): EncryptedMessage {
  return {
    algorithm: 'aes-256-gcm/v1',
    keyId: 'owner-key-v1',
    nonce: Buffer.alloc(12, 1),
    ciphertext: Buffer.from('hello'),
    authTag: Buffer.alloc(16, 2),
    cipherDigest: 'c'.repeat(64),
    contentDigest: HMAC,
    aadVersion: 1,
  };
}

function capability(input: {
  capabilityId: string;
  providerRequestId: string;
  invocationId: string;
  conversationId: string;
  deploymentId: string;
  agentVersionId: string;
  installationId: string;
  leaseId: string;
  fence: string;
  requestDigest: string;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  notBefore: string;
  expiresAt: string;
  signal?: AbortSignal;
}): ExecutionCapability {
  const { installationId, signal: _signal, ...wireInput } = input;
  return ExecutionCapabilitySchema.parse({
    protocol: 'combo.execution-capability/1',
    schemaVersion: 1,
    ...wireInput,
    agentVersionDigest: SHA,
    workerInstallationId: installationId,
    budget: { maxInputTokens: 1_024, maxOutputTokens: 512, maxCostMicros: 10_000 },
    nonce: Buffer.alloc(32, 4).toString('base64url'),
    signatureAlgorithm: 'ES256',
    signatureEncoding: 'ieee-p1363',
    signature: Buffer.alloc(64, 5).toString('base64url'),
  });
}

function sendAuthorities(options: { badDigest?: boolean; events?: string[] } = {}) {
  let sealCalls = 0;
  let prepareCalls = 0;
  let idCalls = 0;
  let bindCalls = 0;
  const message: ConsumerMessageAuthority = {
    async bindUserMessage() {
      bindCalls += 1;
      return {
        requestDigest: HMAC,
        async seal() {
          sealCalls += 1;
          options.events?.push('authority:seal');
          return encrypted();
        },
      };
    },
    async openMessage() {
      throw new Error('not used');
    },
  };
  const invocationPrepare: InvocationPrepareAuthority = {
    async prepare(input) {
      prepareCalls += 1;
      options.events?.push('authority:sign');
      const wire = capability(input);
      return {
        capability: wire,
        capabilityDigest: options.badDigest ? '0'.repeat(64) : executionCapabilityDigest(wire),
      };
    },
  };
  const authorities: ConsumerRuntimeProductAuthorities = {
    message,
    invocationPrepare,
    serverIds: {
      async issue(count) {
        idCalls += 1;
        options.events?.push('authority:ids');
        return Array.from({ length: count }, uuidV7);
      },
    },
  };
  return {
    authorities,
    counts: () => ({ bindCalls, sealCalls, prepareCalls, idCalls }),
  };
}

function readyPreflight(creatorId: string) {
  const now = Date.now();
  return {
    outcome: 'READY',
    existing_invocation_id: null,
    existing_state: null,
    creator_id: creatorId,
    deployment_id: uuidV7(),
    agent_version_id: uuidV7(),
    agent_version_digest: SHA,
    snapshot_digest: 'd'.repeat(64),
    installation_id: uuidV7(),
    lease_id: uuidV7(),
    fence: '7',
    capability_not_before: new Date(now - 1_000),
    deadline_at: new Date(now + 30_000),
    capability_expires_at: new Date(now + 60_000),
    resolved_model: 'openai/gpt-5',
    reasoning_effort: 'medium',
  };
}

describe('Runtime product repository', () => {
  it('atomically finalizes a v2 prepare and maps internal DISPATCH_PENDING to public QUEUED', async () => {
    const creatorId = uuidV7();
    const conversationId = uuidV7();
    const consumerId = randomUUID();
    const events: string[] = [];
    const { authorities, counts } = sendAuthorities({ events });
    const { db, queries } = fakeDb(async (sql) => {
      if (sql.includes('SELECT creator_id') && sql.includes('agent_conversations')) {
        return { rows: [{ creator_id: creatorId }] };
      }
      if (sql.includes('creator_agent_preflight_consumer_message_v2')) {
        return { rows: [readyPreflight(creatorId)] };
      }
      if (sql.includes('creator_agent_finalize_consumer_message_v2')) {
        return {
          rows: [
            {
              finalize_outcome: 'ADMITTED',
              invocation_id: (queries.at(-1)?.params ?? [])[3],
              invocation_state: 'DISPATCH_PENDING',
            },
          ],
        };
      }
      return { rows: [] };
    }, events);

    const result = await sendConsumerMessage(
      db,
      {
        consumerId,
        conversationId,
        clientMessageId: randomUUID(),
        text: 'hello',
      },
      authorities,
    );

    expect(result.state).toBe('QUEUED');
    expect(counts()).toEqual({ bindCalls: 1, sealCalls: 1, prepareCalls: 1, idCalls: 1 });
    const finalize = queries.find((query) =>
      query.sql.includes('creator_agent_finalize_consumer_message_v2'),
    );
    expect(finalize?.params).toHaveLength(20);
    expect(finalize?.params?.[18]).toMatchObject({
      protocol: 'combo.execution-capability/1',
      requestDigest: HMAC,
    });
    expect(events).toEqual([
      'db:commit',
      'db:commit',
      'authority:ids',
      'authority:seal',
      'authority:sign',
      'db:finalize',
      'db:commit',
    ]);
  });

  it('authenticates the request digest but performs no seal/sign/ID/finalize on exact replay', async () => {
    const creatorId = uuidV7();
    const existingInvocationId = uuidV7();
    const { authorities, counts } = sendAuthorities();
    const { db, queries } = fakeDb(async (sql) => {
      if (sql.includes('SELECT creator_id') && sql.includes('agent_conversations')) {
        return { rows: [{ creator_id: creatorId }] };
      }
      if (sql.includes('creator_agent_preflight_consumer_message_v2')) {
        return {
          rows: [
            {
              outcome: 'REPLAY',
              existing_invocation_id: existingInvocationId,
              existing_state: 'SUCCEEDED',
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      sendConsumerMessage(
        db,
        {
          consumerId: randomUUID(),
          conversationId: uuidV7(),
          clientMessageId: randomUUID(),
          text: 'same authenticated request',
        },
        authorities,
      ),
    ).resolves.toEqual({
      protocol: 'combo.creator-agent-http/1',
      invocationId: existingInvocationId,
      state: 'QUEUED',
    });
    expect(counts()).toEqual({ bindCalls: 1, sealCalls: 0, prepareCalls: 0, idCalls: 0 });
    expect(
      queries.some((query) => query.sql.includes('creator_agent_finalize_consumer_message_v2')),
    ).toBe(false);
  });

  it('recomputes the capability digest and calls no finalizer when an adapter lies', async () => {
    const creatorId = uuidV7();
    const { authorities } = sendAuthorities({ badDigest: true });
    const { db, queries } = fakeDb(async (sql) => {
      if (sql.includes('SELECT creator_id') && sql.includes('agent_conversations')) {
        return { rows: [{ creator_id: creatorId }] };
      }
      if (sql.includes('creator_agent_preflight_consumer_message_v2')) {
        return { rows: [readyPreflight(creatorId)] };
      }
      return { rows: [] };
    });

    await expect(
      sendConsumerMessage(
        db,
        {
          consumerId: randomUUID(),
          conversationId: uuidV7(),
          clientMessageId: randomUUID(),
          text: 'do not write',
        },
        authorities,
      ),
    ).rejects.toMatchObject({
      code: 'EXECUTION_CAPABILITY_INVALID',
    });
    expect(
      queries.some((query) => query.sql.includes('creator_agent_finalize_consumer_message_v2')),
    ).toBe(false);
  });

  it('rejects a non-ASCII model policy before ID, seal, sign, or finalize', async () => {
    const creatorId = uuidV7();
    const { authorities, counts } = sendAuthorities();
    const { db, queries } = fakeDb(async (sql) => {
      if (sql.includes('SELECT creator_id') && sql.includes('agent_conversations')) {
        return { rows: [{ creator_id: creatorId }] };
      }
      if (sql.includes('creator_agent_preflight_consumer_message_v2')) {
        return { rows: [{ ...readyPreflight(creatorId), resolved_model: '模型/test' }] };
      }
      return { rows: [] };
    });

    await expect(
      sendConsumerMessage(
        db,
        {
          consumerId: randomUUID(),
          conversationId: uuidV7(),
          clientMessageId: randomUUID(),
          text: 'fail closed before external authority',
        },
        authorities,
      ),
    ).rejects.toThrow();
    expect(counts()).toEqual({ bindCalls: 1, sealCalls: 0, prepareCalls: 0, idCalls: 0 });
    expect(
      queries.some((query) => query.sql.includes('creator_agent_finalize_consumer_message_v2')),
    ).toBe(false);
  });

  it('opens every transcript row with exact owner/conversation/message/role AAD', async () => {
    const creatorId = uuidV7();
    const conversationId = uuidV7();
    const firstMessageId = uuidV7();
    const secondMessageId = uuidV7();
    const events: string[] = [];
    const seenAad: MessageAad[] = [];
    const messageAuthority: ConsumerMessageAuthority = {
      async bindUserMessage() {
        throw new Error('not used');
      },
      async openMessage({ aad }) {
        events.push('authority:open');
        seenAad.push(aad);
        return aad.role === 'USER' ? 'question' : 'answer';
      },
    };
    const rowBase = {
      invocation_id: uuidV7(),
      content_algorithm: 'aes-256-gcm/v1',
      content_key_id: 'owner-key-v1',
      content_nonce: Buffer.alloc(12, 1),
      content_ciphertext: Buffer.from('x'),
      content_auth_tag: Buffer.alloc(16, 2),
      content_cipher_digest: 'c'.repeat(64),
      content_digest: HMAC,
      content_aad_version: 1,
      created_at: new Date(),
    };
    const { db, queries } = fakeDb(async (sql) => {
      if (sql.includes('FROM agent_conversations')) {
        return {
          rows: [
            {
              id: conversationId,
              agent_id: uuidV7(),
              agent_version_id: uuidV7(),
              creator_id: creatorId,
              version_digest: SHA,
              state: 'IDLE',
              created_at: new Date(),
              expires_at: new Date(Date.now() + 60_000),
            },
          ],
        };
      }
      if (sql.includes('FROM agent_messages')) {
        return {
          rows: [
            { ...rowBase, id: firstMessageId, turn_no: 1, role: 'USER' },
            { ...rowBase, id: secondMessageId, turn_no: 1, role: 'ASSISTANT' },
          ],
        };
      }
      if (sql.includes('FROM consumer_event_streams')) return { rows: [{ latest_cursor: '9' }] };
      return { rows: [] };
    }, events);

    const transcript = await readConsumerConversationTranscript(
      db,
      { consumerId: randomUUID(), conversationId },
      messageAuthority,
    );
    expect(transcript.messages.map(({ text }) => text)).toEqual(['question', 'answer']);
    expect(seenAad).toEqual([
      {
        schemaVersion: 1,
        ownerId: creatorId,
        conversationId,
        messageId: firstMessageId,
        role: 'USER',
      },
      {
        schemaVersion: 1,
        ownerId: creatorId,
        conversationId,
        messageId: secondMessageId,
        role: 'ASSISTANT',
      },
    ]);
    expect(queries[0]?.sql).toContain('REPEATABLE READ READ ONLY');
    expect(events).toEqual(['db:commit', 'authority:open', 'authority:open']);
  });

  it('fails closed on the 41st transcript row and performs no message open', async () => {
    const creatorId = uuidV7();
    const conversationId = uuidV7();
    let openCalls = 0;
    const messageAuthority: ConsumerMessageAuthority = {
      async bindUserMessage() {
        throw new Error('not used');
      },
      async openMessage() {
        openCalls += 1;
        return 'must not open';
      },
    };
    const { db, queries } = fakeDb(async (sql) => {
      if (sql.includes('FROM agent_conversations')) {
        return {
          rows: [
            {
              id: conversationId,
              agent_id: uuidV7(),
              agent_version_id: uuidV7(),
              creator_id: creatorId,
              version_digest: SHA,
              state: 'IDLE',
              created_at: new Date(),
              expires_at: new Date(Date.now() + 60_000),
            },
          ],
        };
      }
      if (sql.includes('FROM agent_messages')) {
        return {
          rows: Array.from({ length: 41 }, (_value, index) => ({
            id: uuidV7(),
            invocation_id: uuidV7(),
            turn_no: index + 1,
            role: 'USER',
            content_algorithm: 'aes-256-gcm/v1',
            content_key_id: 'owner-key-v1',
            content_nonce: Buffer.alloc(12, 1),
            content_ciphertext: Buffer.from('x'),
            content_auth_tag: Buffer.alloc(16, 2),
            content_cipher_digest: 'c'.repeat(64),
            content_digest: HMAC,
            content_aad_version: 1,
            created_at: new Date(),
          })),
        };
      }
      if (sql.includes('FROM consumer_event_streams')) return { rows: [{ latest_cursor: '41' }] };
      return { rows: [] };
    });

    await expect(
      readConsumerConversationTranscript(
        db,
        { consumerId: randomUUID(), conversationId },
        messageAuthority,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_OFFLINE' });
    expect(openCalls).toBe(0);
    expect(queries.find(({ sql }) => sql.includes('FROM agent_messages'))?.sql).toContain(
      'LIMIT 41',
    );
  });

  it('returns an invocation view with the frozen public error classification', async () => {
    const creatorId = uuidV7();
    const conversationId = uuidV7();
    const invocationId = uuidV7();
    const { db } = fakeDb(async (sql) => {
      if (sql.includes('SELECT creator_id, conversation_id')) {
        return { rows: [{ creator_id: creatorId, conversation_id: conversationId }] };
      }
      if (sql.includes('SELECT id, conversation_id')) {
        return {
          rows: [
            {
              id: invocationId,
              conversation_id: conversationId,
              creator_id: creatorId,
              state: 'FAILED',
              result_digest: null,
              error_code: 'TURN_FAILED',
              retry_of_invocation_id: null,
              created_at: new Date(),
              terminal_at: new Date(),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const view = await readConsumerInvocation(db, {
      consumerId: randomUUID(),
      invocationId,
      requestId: 'request-1234',
    });
    expect(view.error).toMatchObject({ code: 'TURN_FAILED', requestId: 'request-1234' });
  });
});
