import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
  onRequestHookHandler,
  preHandlerHookHandler,
} from 'fastify';
import { CreatorAgentPackageReleaseIdSchema } from '@cb/creator-agent-protocol/agent-package-release';
import { ErrorCode, errorBodyFor, type Envelope } from '@cb/shared';

import {
  agentPackagePublisherTestGateFromEnv,
  type AgentPackagePublisherTestGate,
} from '../../platform/config/env.js';
import { asTxPool } from '../../platform/infra/db-tx.js';
import { createS3ImmutableObjectStore } from '../../platform/infra/object-store.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { registerEndpoints, sendError, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireAuth } from '../../platform/middleware/auth.js';
import {
  AgentPackageReleaseFailure,
  PgAgentPackageReleaseRepository,
  publishControlledTestAgentPackage,
  readControlledTestAgentPackageRelease,
} from './service.js';

export const AGENT_PACKAGE_RELEASE_BODY_LIMIT = 4 * 1_024 * 1_024;
export const AGENT_PACKAGE_RELEASE_COLLECTION_PATH = '/agent-package-releases';

function noStore(): onRequestHookHandler {
  return async function (_req, reply) {
    reply.header('cache-control', 'no-store');
  };
}

function requireJson(): preHandlerHookHandler {
  return async function (req, reply) {
    const raw = req.headers['content-type'];
    const mediaType = typeof raw === 'string' ? raw.split(';', 1)[0]?.trim().toLowerCase() : '';
    if (mediaType === 'application/json') return;
    const { body } = errorBodyFor(ErrorCode.VALIDATION_FAILED, req.id, {
      userMessage: '请求必须使用 JSON 格式。',
    });
    return reply.code(415).send({ error: body });
  };
}

function controlledPublisherGate(req: FastifyRequest): AgentPackagePublisherTestGate | null {
  try {
    return agentPackagePublisherTestGateFromEnv(req.server.infra.env);
  } catch {
    return null;
  }
}

/** 登录用户必须是 gate 唯一 publisher；其他登录主体与关闭路由一样只看到 404。 */
function requireControlledPublisher(): preHandlerHookHandler {
  return async function (req, reply) {
    const gate = controlledPublisherGate(req);
    if (gate !== null && req.auth?.userId === gate.publisherUserId) return;
    return sendError(req, reply, ErrorCode.NOT_FOUND);
  };
}

function repository(req: FastifyRequest): PgAgentPackageReleaseRepository {
  return new PgAgentPackageReleaseRepository(asTxPool(req.server.infra.db), req.server.infra.db);
}

function sendPublisherFailure(
  req: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof AgentPackageReleaseFailure) {
    const code =
      error.kind === 'validation'
        ? ErrorCode.VALIDATION_FAILED
        : error.kind === 'idempotency_conflict'
          ? ErrorCode.IDEMPOTENCY_CONFLICT
          : error.kind === 'state_conflict'
            ? ErrorCode.STATE_CONFLICT
            : ErrorCode.DEPENDENCY_UNAVAILABLE;
    req.log.warn({ code, traceId: req.id }, 'Agent Package release request rejected');
    return sendError(req, reply, code);
  }
  req.log.error({ code: ErrorCode.INTERNAL, traceId: req.id }, 'Agent Package release failed');
  return sendError(req, reply, ErrorCode.INTERNAL);
}

function requestAbortScope(
  req: FastifyRequest,
  reply: FastifyReply,
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  const abortResponse = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  req.raw.once('aborted', abortRequest);
  reply.raw.once('close', abortResponse);
  if (req.raw.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      req.raw.removeListener('aborted', abortRequest);
      reply.raw.removeListener('close', abortResponse);
    },
  };
}

function createReleaseHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    const gate = controlledPublisherGate(req);
    const ownerUserId = req.auth?.userId;
    if (gate === null || ownerUserId !== gate.publisherUserId) {
      return sendError(req, reply, ErrorCode.NOT_FOUND);
    }

    const abort = requestAbortScope(req, reply);
    try {
      const result = await publishControlledTestAgentPackage(
        {
          objectStore: createS3ImmutableObjectStore(req.server.infra.env),
          repository: repository(req),
        },
        {
          ownerUserId,
          expectedPackageDigest: gate.packageDigest,
          body: req.body,
          signal: abort.signal,
        },
      );
      const body: Envelope<typeof result.stored.release> = {
        data: result.stored.release,
        meta: { traceId: req.id },
      };
      return reply.code(result.created ? 201 : 200).send(body);
    } catch (error) {
      return sendPublisherFailure(req, reply, error);
    } finally {
      abort.dispose();
    }
  };
}

function getReleaseHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    const gate = controlledPublisherGate(req);
    const ownerUserId = req.auth?.userId;
    if (gate === null || ownerUserId !== gate.publisherUserId) {
      return sendError(req, reply, ErrorCode.NOT_FOUND);
    }
    const parsed = CreatorAgentPackageReleaseIdSchema.safeParse(
      (req.params as { releaseId?: unknown }).releaseId,
    );
    if (!parsed.success) return sendError(req, reply, ErrorCode.NOT_FOUND);

    try {
      const stored = await readControlledTestAgentPackageRelease(
        repository(req),
        ownerUserId,
        parsed.data,
      );
      if (stored === null || stored.release.packageDigest !== gate.packageDigest) {
        return sendError(req, reply, ErrorCode.NOT_FOUND);
      }
      const body: Envelope<typeof stored.release> = {
        data: stored.release,
        meta: { traceId: req.id },
      };
      return reply.code(200).send(body);
    } catch (error) {
      return sendPublisherFailure(req, reply, error);
    }
  };
}

export const AGENT_PACKAGE_RELEASE_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: AGENT_PACKAGE_RELEASE_COLLECTION_PATH,
    // Authenticate and conceal the owner-only route before Fastify parses an attacker body.
    onRequest: [
      noStore(),
      requireTrustedMutationOrigin(),
      requireAuth(),
      requireControlledPublisher(),
    ],
    preHandlers: [requireJson()],
    bodyLimit: AGENT_PACKAGE_RELEASE_BODY_LIMIT,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: createReleaseHandler(),
  },
  {
    method: 'GET',
    url: `${AGENT_PACKAGE_RELEASE_COLLECTION_PATH}/:releaseId`,
    onRequest: [noStore()],
    preHandlers: [requireAuth(), requireControlledPublisher()],
    handler: getReleaseHandler(),
  },
];

export async function registerAgentPackageReleaseRoutes(scoped: FastifyInstance): Promise<void> {
  await scoped.register(async (publisherScope) => {
    publisherScope.setErrorHandler((error, req, reply) => {
      const statusCode = (error as { statusCode?: number }).statusCode;
      const code =
        statusCode === 429
          ? ErrorCode.RATE_LIMITED
          : (error as { validation?: unknown }).validation ||
              statusCode === 400 ||
              statusCode === 413 ||
              statusCode === 415
            ? ErrorCode.VALIDATION_FAILED
            : ErrorCode.INTERNAL;
      const log =
        code === ErrorCode.INTERNAL ? req.log.error.bind(req.log) : req.log.warn.bind(req.log);
      log({ code, traceId: req.id }, 'Agent Package release HTTP boundary rejected');
      const { http, body } = errorBodyFor(code, req.id);
      const preserved = statusCode === 413 || statusCode === 415 ? statusCode : http;
      reply.code(preserved).send({ error: body });
    });
    registerEndpoints(publisherScope, AGENT_PACKAGE_RELEASE_ENDPOINTS);
  });
}
