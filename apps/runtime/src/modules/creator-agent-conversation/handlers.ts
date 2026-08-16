import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { CreateConversationRequestSchema, IdempotencyKeySchema } from '@cb/creator-agent-protocol';
import {
  AgentPublicSlugSchema,
  ConsumerConversationError,
  createConsumerConversation,
  type DeploymentEnvironment,
} from './repo.js';
import { sendVnextError } from './http-boundary.js';
import type { VisibleTranscriptDigester } from './visible-transcript-digester.js';

function deploymentEnvironment(value: string): DeploymentEnvironment | null {
  if (value === 'development' || value === 'test') return 'TEST';
  if (value === 'preview') return 'PREVIEW';
  if (value === 'production') return 'PROD';
  return null;
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
