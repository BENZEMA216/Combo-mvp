import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { CreatorAgentPackageReleaseIdSchema } from '@cb/creator-agent-protocol/agent-package-release';
import { ErrorCode, errorBodyFor } from '@cb/shared';
import { requireAuth } from '../../platform/middleware/auth.js';
import {
  canonicalBrowserOrigins,
  requireTrustedMutationOrigin,
} from '../../platform/http/browser-origin.js';
import { registerEndpoints, sendError, type EndpointDecl } from '../../platform/http/_helpers.js';
import { asTxPool } from '../../platform/infra/db-tx.js';
import {
  createS3ImmutableObjectStore,
  type ImmutableObjectStore,
} from '../../platform/infra/object-store.js';
import {
  EmptyTransferBody,
  TransferFailure,
  TransferId,
  isTransferSecret,
} from './transfer-contract.js';
import { AgentTransferService } from './transfer-service.js';
import { AgentPublicationService } from './publication-service.js';
import { agentReceiverInstructions, getAgentReceiverArtifact } from './receiver-handoff.js';

const objectDeadlines = new WeakMap<FastifyRequest, AbortSignal>();
function services(req: FastifyRequest) {
  const { db, env } = req.server.infra;
  const origin = canonicalBrowserOrigins(env)[0];
  if (!origin) throw new TransferFailure('unavailable');
  const store = createS3ImmutableObjectStore(env);
  let signal = objectDeadlines.get(req);
  if (!signal) {
    const aborted = new AbortController();
    req.raw.once('aborted', () => aborted.abort());
    if (req.raw.aborted) aborted.abort();
    signal = AbortSignal.any([aborted.signal, AbortSignal.timeout(30_000)]);
    objectDeadlines.set(req, signal);
  }
  const boundedSignal = signal;
  const objects: ImmutableObjectStore = {
    commit: (input) => store.commit({ ...input, signal: boundedSignal }),
    read: (input) => store.read({ ...input, signal: boundedSignal }),
  };
  return {
    transfer: new AgentTransferService(asTxPool(db), db, objects, origin),
    publication: new AgentPublicationService(asTxPool(db), db, objects, origin),
  };
}
function fail(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  const kind = error instanceof TransferFailure ? error.kind : 'unavailable';
  const code =
    kind === 'validation'
      ? ErrorCode.VALIDATION_FAILED
      : kind === 'not_found'
        ? ErrorCode.NOT_FOUND
        : kind === 'conflict' || kind === 'expired'
          ? ErrorCode.STATE_CONFLICT
          : ErrorCode.DEPENDENCY_UNAVAILABLE;
  const { http, body } = errorBodyFor(
    code,
    req.id,
    kind === 'expired' ? { userMessage: '上传授权已过期。已保存的内容仍可在原授权页查看。' } : {},
  );
  req.log.warn({ code, traceId: req.id }, 'Agent transfer request rejected');
  return reply.code(kind === 'expired' ? 410 : http).send({ error: body });
}
const noStore: onRequestHookHandler = async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  reply.header('referrer-policy', 'no-referrer');
};
const testOnly: onRequestHookHandler = async (req, reply) => {
  if (req.server.infra.env.COMBO_ENVIRONMENT !== 'test')
    return sendError(req, reply, ErrorCode.NOT_FOUND);
};
const noQuery: onRequestHookHandler = async (req, reply) => {
  if (Object.keys((req.query as object | undefined) ?? {}).length)
    return sendError(req, reply, ErrorCode.NOT_FOUND);
};
const requireJson: onRequestHookHandler = async (req, reply) => {
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json')
    return;
  const { body } = errorBodyFor(ErrorCode.VALIDATION_FAILED, req.id);
  return reply.code(415).send({ error: body });
};
function transferId(req: FastifyRequest): string {
  const parsed = TransferId.safeParse((req.params as { transferId?: unknown }).transferId);
  if (!parsed.success) throw new TransferFailure('not_found');
  return parsed.data;
}
function desktopSecret(req: FastifyRequest): string {
  const value = req.headers.authorization;
  const secret = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : null;
  if (!isTransferSecret(secret)) throw new TransferFailure('not_found');
  return secret;
}
/** These are non-browser endpoints, never an alternate Cookie or OAuth login surface. */
function desktopOnly(withSecret: boolean): onRequestHookHandler {
  return async (req, reply) => {
    if (
      req.headers.cookie !== undefined ||
      req.headers.origin !== undefined ||
      req.headers['sec-fetch-site'] !== undefined ||
      req.headers['sec-fetch-dest'] !== undefined ||
      req.headers['sec-fetch-user'] !== undefined ||
      // Node's native fetch adds mode=cors, without browser Site/Dest/Origin metadata.
      // This is transport compatibility, never authentication or an Origin exemption.
      (req.headers['sec-fetch-mode'] !== undefined && req.headers['sec-fetch-mode'] !== 'cors') ||
      (!withSecret && req.headers.authorization !== undefined)
    )
      return sendError(req, reply, ErrorCode.FORBIDDEN);
    if (withSecret) {
      try {
        // Reject bad/expired credentials before parsing attacker-controlled upload bytes.
        await services(req).transfer.status(transferId(req), desktopSecret(req));
      } catch (error) {
        return fail(req, reply, error);
      }
    }
  };
}
const base = [noStore, testOnly, noQuery];
const desktop = (secret: boolean) => [...base, desktopOnly(secret), requireJson];
const browser = (mutation: boolean) =>
  mutation
    ? [...base, requireTrustedMutationOrigin(), requireAuth(), requireJson]
    : [...base, requireAuth()];
const small = { bodyLimit: 4_096, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
async function invoke(req: FastifyRequest, reply: FastifyReply, operation: () => Promise<unknown>) {
  try {
    return reply.send({ data: await operation(), meta: { traceId: req.id } });
  } catch (error) {
    return fail(req, reply, error);
  }
}
export const AGENT_TRANSFER_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/agent-package-transfers',
    ...small,
    onRequest: desktop(false),
    handler: (req, reply) => invoke(req, reply, () => services(req).transfer.create(req.body)),
  },
  {
    method: 'POST',
    url: '/agent-package-transfers/:transferId/status',
    ...small,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    onRequest: desktop(true),
    handler: (req, reply) =>
      invoke(req, reply, () => {
        if (!EmptyTransferBody.safeParse(req.body).success) throw new TransferFailure('validation');
        return services(req).transfer.status(transferId(req), desktopSecret(req));
      }),
  },
  {
    method: 'POST',
    url: '/agent-package-transfers/:transferId/upload',
    ...small,
    bodyLimit: 1_048_576,
    onRequest: desktop(true),
    handler: (req, reply) =>
      invoke(req, reply, () =>
        services(req).transfer.upload(transferId(req), desktopSecret(req), req.body),
      ),
  },
  {
    method: 'GET',
    url: '/agent-package-transfers/:transferId',
    onRequest: browser(false),
    handler: (req, reply) =>
      invoke(req, reply, () => {
        if (!req.auth) throw new TransferFailure('not_found');
        return services(req).transfer.review(transferId(req), req.auth.userId);
      }),
  },
  {
    method: 'POST',
    url: '/agent-package-transfers/:transferId/approval',
    ...small,
    onRequest: browser(true),
    handler: (req, reply) =>
      invoke(req, reply, () => {
        if (!req.auth) throw new TransferFailure('not_found');
        return services(req).transfer.approve(transferId(req), req.auth.userId, req.body);
      }),
  },
  {
    method: 'POST',
    url: '/agent-package-transfers/:transferId/publication',
    ...small,
    onRequest: browser(true),
    handler: (req, reply) =>
      invoke(req, reply, () => {
        if (!req.auth) throw new TransferFailure('not_found');
        return services(req).publication.publish(transferId(req), req.auth.userId, req.body);
      }),
  },
  ...['', '/package'].map(
    (suffix): EndpointDecl => ({
      method: 'GET',
      url: `/agent-package-publications/:releaseId${suffix}`,
      onRequest: base,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      handler: async (req, reply) => {
        try {
          const parsed = CreatorAgentPackageReleaseIdSchema.safeParse(
            (req.params as { releaseId?: unknown }).releaseId,
          );
          if (!parsed.success) throw new TransferFailure('not_found');
          const data = await services(req).publication.read(parsed.data);
          if (!suffix) return reply.send({ data, meta: { traceId: req.id } });
          return reply
            .header(
              'content-disposition',
              `attachment; filename="agent-package-${parsed.data.slice(-32)}.json"`,
            )
            .type('application/json; charset=utf-8')
            .send(data.package);
        } catch (error) {
          return fail(req, reply, error);
        }
      },
    }),
  ),
  {
    method: 'GET',
    url: '/agent-package-publications/:releaseId/codex-installation',
    onRequest: base,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: (req, reply) =>
      invoke(req, reply, async () => {
        const releaseId = CreatorAgentPackageReleaseIdSchema.safeParse(
          (req.params as { releaseId?: unknown }).releaseId,
        );
        if (!releaseId.success) throw new TransferFailure('not_found');
        const publication = await services(req).publication.read(releaseId.data);
        if (publication.release.releaseId !== releaseId.data)
          throw new TransferFailure('unavailable');
        const origin = canonicalBrowserOrigins(req.server.infra.env)[0];
        if (!origin) throw new TransferFailure('unavailable');
        return agentReceiverInstructions(publication, origin, await getAgentReceiverArtifact());
      }),
  },
  {
    method: 'GET',
    url: '/agent-package-receivers/v1/:artifactFile',
    onRequest: base,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      try {
        const { artifactFile } = req.params as { artifactFile?: unknown };
        if (typeof artifactFile !== 'string' || !/^[0-9a-f]{64}\.mjs$/u.test(artifactFile))
          throw new TransferFailure('not_found');
        const artifact = await getAgentReceiverArtifact();
        if (artifact.filename !== artifactFile) throw new TransferFailure('not_found');
        return reply
          .header(
            'content-disposition',
            `attachment; filename="combo-agent-receiver-${artifactFile}"`,
          )
          .header('x-content-type-options', 'nosniff')
          .type('text/javascript; charset=utf-8')
          .send(artifact.bytes);
      } catch (error) {
        return fail(req, reply, error);
      }
    },
  },
];
export async function registerAgentTransferRoutes(app: FastifyInstance) {
  if (app.infra.env.COMBO_ENVIRONMENT !== 'test') return;
  await app.register(async (scope) => {
    scope.setErrorHandler((error, req, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      const code =
        status === 429
          ? ErrorCode.RATE_LIMITED
          : [400, 413, 415].includes(status ?? 0)
            ? ErrorCode.VALIDATION_FAILED
            : ErrorCode.INTERNAL;
      const { http, body } = errorBodyFor(code, req.id);
      reply
        .header('cache-control', 'no-store')
        .code(status === 413 || status === 415 ? status : http)
        .send({ error: body });
    });
    registerEndpoints(scope, AGENT_TRANSFER_ENDPOINTS);
  });
}
