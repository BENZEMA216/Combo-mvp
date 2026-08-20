import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  CreateConversationRequestSchema,
  IdempotencyKeySchema,
  SendConversationMessageRequestSchema,
  Uint63StringSchema,
  UuidSchema,
  hasExactClientIdempotencyBinding,
} from '@cb/creator-agent-protocol';
import {
  AgentPublicSlugSchema,
  ConsumerConversationError,
  createConsumerConversation,
  type DeploymentEnvironment,
} from './repo.js';
import { sendVnextError } from './http-boundary.js';
import type { VisibleTranscriptDigester } from './visible-transcript-digester.js';
import {
  ConsumerEventReplayError,
  formatConsumerEventSse,
  pollConsumerEvents,
} from './consumer-events.js';
import {
  ConsumerRuntimeProductError,
  readConsumerConversationTranscript,
  readConsumerInvocation,
  sendConsumerMessage,
  type ConsumerRuntimeProductAuthorities,
} from './runtime-product-repo.js';

function deploymentEnvironment(value: string): DeploymentEnvironment | null {
  if (value === 'development' || value === 'test') return 'TEST';
  if (value === 'preview') return 'PREVIEW';
  if (value === 'production') return 'PROD';
  return null;
}

function sendRuntimeProductError(
  req: FastifyRequest,
  reply: FastifyReply,
  error: ConsumerRuntimeProductError,
): FastifyReply {
  return sendVnextError(req, reply, error.code);
}

function sendKnownError(
  req: FastifyRequest,
  reply: FastifyReply,
  error: ConsumerConversationError,
): FastifyReply {
  return sendVnextError(req, reply, error.code);
}

/** POST /v1/public/agents/:slug/conversations. */
export function createConsumerConversationHandler(
  options: {
    visibleTranscriptDigester?: VisibleTranscriptDigester;
  } = {},
): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const consumerId = req.auth?.userId;
    if (!consumerId) {
      return sendVnextError(req, reply, 'UNAUTHORIZED');
    }
    const creatorAgentDb = req.server.infra.creatorAgentDb;
    if (creatorAgentDb === null) return sendVnextError(req, reply, 'AGENT_OFFLINE');
    // OpenAPI requires an explicit application/json body. An absent body is not equivalent to
    // the structurally empty request object, even though the current schema has no data fields.
    const parsedBody =
      req.body === undefined
        ? { success: false as const }
        : CreateConversationRequestSchema.safeParse(req.body);
    const parsedSlug = AgentPublicSlugSchema.safeParse((req.params as { slug?: unknown }).slug);
    const parsedKey = IdempotencyKeySchema.safeParse(req.headers['idempotency-key']);
    const environment = deploymentEnvironment(req.server.infra.env.COMBO_ENVIRONMENT);
    if (!parsedBody.success || !parsedSlug.success || !parsedKey.success || environment === null) {
      return sendVnextError(req, reply, 'INVALID_INPUT');
    }

    try {
      const result = await createConsumerConversation(
        creatorAgentDb,
        {
          consumerId,
          publicSlug: parsedSlug.data,
          idempotencyKey: parsedKey.data,
          environment,
        },
        {
          visibleTranscriptDigester:
            options.visibleTranscriptDigester ?? req.server.infra.visibleTranscriptKms?.digester,
        },
      );
      // The frozen OpenAPI surface returns the same 201 resource representation for both the
      // first commit and an exact Idempotency-Key replay; replay is an internal storage fact.
      reply.code(201).send(result.conversation);
      return reply;
    } catch (error) {
      if (error instanceof ConsumerConversationError) return sendKnownError(req, reply, error);
      req.log.error({ err: error, traceId: req.id }, 'create Creator-hosted conversation failed');
      return sendVnextError(req, reply, 'AGENT_OFFLINE');
    }
  };
}

/** POST /v1/conversations/:conversationId/messages. */
export function sendConsumerMessageHandler(
  options: { authorities?: ConsumerRuntimeProductAuthorities } = {},
): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const consumerId = req.auth?.userId;
    if (!consumerId) return sendVnextError(req, reply, 'UNAUTHORIZED');
    const creatorAgentDb = req.server.infra.creatorAgentDb;
    const authorities =
      options.authorities ?? req.server.infra.creatorAgentRuntimeProduct ?? undefined;
    if (creatorAgentDb === null || !authorities) return sendVnextError(req, reply, 'AGENT_OFFLINE');
    const parsedConversation = UuidSchema.safeParse(
      (req.params as { conversationId?: unknown }).conversationId,
    );
    const parsedBody = SendConversationMessageRequestSchema.safeParse(req.body);
    const idempotencyKey = req.headers['idempotency-key'];
    if (
      !parsedConversation.success ||
      !parsedBody.success ||
      !hasExactClientIdempotencyBinding(idempotencyKey, parsedBody.data.clientMessageId)
    ) {
      return sendVnextError(req, reply, 'INVALID_INPUT');
    }
    try {
      const response = await sendConsumerMessage(
        creatorAgentDb,
        {
          consumerId,
          conversationId: parsedConversation.data,
          ...parsedBody.data,
        },
        authorities,
      );
      reply.code(202).send(response);
      return reply;
    } catch (error) {
      if (error instanceof ConsumerRuntimeProductError) {
        return sendRuntimeProductError(req, reply, error);
      }
      req.log.error({ err: error, traceId: req.id }, 'send Creator-hosted message failed');
      return sendVnextError(req, reply, 'AGENT_OFFLINE');
    }
  };
}

/** GET /v1/conversations/:conversationId. */
export function getConsumerConversationTranscriptHandler(
  options: { authorities?: ConsumerRuntimeProductAuthorities } = {},
): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const consumerId = req.auth?.userId;
    if (!consumerId) return sendVnextError(req, reply, 'UNAUTHORIZED');
    const creatorAgentDb = req.server.infra.creatorAgentDb;
    const authorities =
      options.authorities ?? req.server.infra.creatorAgentRuntimeProduct ?? undefined;
    const parsedConversation = UuidSchema.safeParse(
      (req.params as { conversationId?: unknown }).conversationId,
    );
    if (!parsedConversation.success) return sendVnextError(req, reply, 'INVALID_INPUT');
    if (creatorAgentDb === null || !authorities) return sendVnextError(req, reply, 'AGENT_OFFLINE');
    try {
      const transcript = await readConsumerConversationTranscript(
        creatorAgentDb,
        { consumerId, conversationId: parsedConversation.data },
        authorities.message,
      );
      reply.code(200).send(transcript);
      return reply;
    } catch (error) {
      if (error instanceof ConsumerRuntimeProductError) {
        return sendRuntimeProductError(req, reply, error);
      }
      req.log.error({ err: error, traceId: req.id }, 'read Creator-hosted transcript failed');
      return sendVnextError(req, reply, 'AGENT_OFFLINE');
    }
  };
}

/** GET /v1/invocations/:invocationId. */
export function getConsumerInvocationHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const consumerId = req.auth?.userId;
    if (!consumerId) return sendVnextError(req, reply, 'UNAUTHORIZED');
    const creatorAgentDb = req.server.infra.creatorAgentDb;
    if (creatorAgentDb === null) return sendVnextError(req, reply, 'AGENT_OFFLINE');
    const parsedInvocation = UuidSchema.safeParse(
      (req.params as { invocationId?: unknown }).invocationId,
    );
    if (!parsedInvocation.success) return sendVnextError(req, reply, 'INVALID_INPUT');
    try {
      const invocation = await readConsumerInvocation(creatorAgentDb, {
        consumerId,
        invocationId: parsedInvocation.data,
        requestId: req.id,
      });
      reply.code(200).send(invocation);
      return reply;
    } catch (error) {
      if (error instanceof ConsumerRuntimeProductError) {
        return sendRuntimeProductError(req, reply, error);
      }
      req.log.error({ err: error, traceId: req.id }, 'read Creator-hosted invocation failed');
      return sendVnextError(req, reply, 'AGENT_OFFLINE');
    }
  };
}

/**
 * GET /v1/conversations/:conversationId/events.
 *
 * This is a bounded terminal-event replay page, not an unbounded token stream: the handler polls
 * at most four read-only snapshots, emits only durable invocation.terminal frames, then closes.
 * Clients continue with Last-Event-ID when `hasMore` or a later terminal event is expected.
 */
export function getConsumerEventsHandler(
  options: { poll?: typeof pollConsumerEvents } = {},
): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const consumerId = req.auth?.userId;
    if (!consumerId) return sendVnextError(req, reply, 'UNAUTHORIZED');
    const creatorAgentDb = req.server.infra.creatorAgentDb;
    if (creatorAgentDb === null) return sendVnextError(req, reply, 'AGENT_OFFLINE');
    const parsedConversation = UuidSchema.safeParse(
      (req.params as { conversationId?: unknown }).conversationId,
    );
    const rawLastEventId = req.headers['last-event-id'];
    const parsedLastEventId = Uint63StringSchema.safeParse(rawLastEventId ?? '0');
    if (!parsedConversation.success || !parsedLastEventId.success) {
      return sendVnextError(req, reply, 'INVALID_INPUT');
    }

    const connection = new AbortController();
    const abortDisconnectedRequest = (): void => {
      if (!connection.signal.aborted) {
        connection.abort(new DOMException('Consumer Event request disconnected', 'AbortError'));
      }
    };
    req.raw.once('close', abortDisconnectedRequest);
    req.raw.once('aborted', abortDisconnectedRequest);
    try {
      const page = await (options.poll ?? pollConsumerEvents)(
        creatorAgentDb,
        {
          consumerId,
          conversationId: parsedConversation.data,
          lastEventId: parsedLastEventId.data,
          limit: 50,
        },
        {
          maxAttempts: 4,
          intervalMs: 250,
          signal: AbortSignal.any([connection.signal, AbortSignal.timeout(5_000)]),
        },
      );
      if (connection.signal.aborted) return reply;
      const body = page.events.map((event) => formatConsumerEventSse(event)).join('');
      reply
        .code(200)
        .header('Cache-Control', 'no-store')
        .header('X-Accel-Buffering', 'no')
        .type('text/event-stream; charset=utf-8')
        .send(body);
      return reply;
    } catch (error) {
      if (connection.signal.aborted) return reply;
      if (error instanceof ConsumerEventReplayError) {
        if (error.code === 'SSE_CURSOR_EXPIRED') {
          return sendVnextError(req, reply, 'SSE_CURSOR_EXPIRED');
        }
        if (error.code === 'CONVERSATION_UNAVAILABLE') {
          return sendVnextError(req, reply, 'FORBIDDEN');
        }
        return sendVnextError(req, reply, 'AGENT_OFFLINE');
      }
      req.log.error({ err: error, traceId: req.id }, 'replay Creator-hosted events failed');
      return sendVnextError(req, reply, 'AGENT_OFFLINE');
    } finally {
      req.raw.off('close', abortDisconnectedRequest);
      req.raw.off('aborted', abortDisconnectedRequest);
    }
  };
}
