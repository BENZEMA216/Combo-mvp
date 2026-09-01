import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { createCreatorAgentPackageCapability } from '@cb/creator-agent-protocol/agent-package-capability';
import {
  CreateRecoveryRechargeOrderBodySchema,
  ErrorCode,
  HOSTED_KNOWLEDGE_AGENT_SLUG,
  HostedKnowledgeAgentDescriptorSchema,
  StartHostedKnowledgeAgentResultSchema,
  type Envelope,
  type HostedKnowledgeAgentDescriptor,
  type StartHostedKnowledgeAgentResult,
} from '@cb/shared';
import { z } from 'zod';

import { knowledgeAgentTestGateFromEnv, type Env } from '../../platform/config/env.js';
import { sendError, registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import type { Queryable } from '../../platform/infra/db.js';
import type { RuntimeObjectStore } from '../../platform/infra/object-store.js';
import { requireAuth } from '../../platform/middleware/auth.js';
import { readAccessibleCapabilitySummary } from '../capability/loader.js';
import { createSession } from '../session/repo.js';
import {
  KnowledgeAgentResolutionError,
  resolveKnowledgeAgentPackage,
  type ResolvedKnowledgeAgent,
} from './resolver.js';

const EmptyStartBodySchema = z.object({}).strict().optional();

type HostedEntryResolution =
  | {
      kind: 'ok';
      agent: ResolvedKnowledgeAgent;
      capabilityId: string;
    }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

function isClosedResolution(error: KnowledgeAgentResolutionError): boolean {
  return (
    error.failure === 'closed' ||
    error.failure === 'not_found' ||
    error.failure === 'invalid_registry' ||
    error.failure === 'invalid_package'
  );
}

/**
 * Resolves only the exact v2 Test gate. The public slug never selects mutable Registry or object
 * state, and the caller receives no publisher, Capability, Release, digest, prompt, or object key.
 */
export async function resolveHostedKnowledgeAgent(input: {
  db: Queryable;
  objectStore: RuntimeObjectStore;
  env: Env;
  userId: string;
}): Promise<HostedEntryResolution> {
  const gate = knowledgeAgentTestGateFromEnv(input.env);
  if (!gate || gate.protocol !== 'combo.knowledge-agent-runtime-test-gate/2') {
    return { kind: 'not_found' };
  }
  // The fixed-price product must be payable by the exact recovery-order contract. Fail before
  // touching mutable Capability/Package state instead of advertising or starting a dead-end flow.
  if (
    !CreateRecoveryRechargeOrderBodySchema.shape.amountCents.safeParse(
      input.env.RUNTIME_BILLING_UNIT_PRICE_CENTS,
    ).success
  ) {
    return { kind: 'unavailable' };
  }

  try {
    const capability = await readAccessibleCapabilitySummary(
      input.db,
      gate.capabilityId,
      input.userId,
    );
    if (!capability) return { kind: 'not_found' };
    const projection = createCreatorAgentPackageCapability({
      version: 2,
      protocol: 'combo.agent-package-capability/2',
      release: {
        protocol: 'combo.agent-package-release/1',
        releaseId: gate.releaseId,
        packageDigest: gate.packageDigest,
      },
    });
    const agent = await resolveKnowledgeAgentPackage({
      db: input.db,
      objectStore: input.objectStore,
      capability,
      projection,
      gate,
    });
    return { kind: 'ok', agent, capabilityId: capability.id };
  } catch (error) {
    if (error instanceof KnowledgeAgentResolutionError && isClosedResolution(error)) {
      return { kind: 'not_found' };
    }
    return { kind: 'unavailable' };
  }
}

function entryInput(req: FastifyRequest): {
  db: Queryable;
  objectStore: RuntimeObjectStore;
  env: Env;
  userId: string;
} | null {
  const userId = req.auth?.userId;
  if (!userId) return null;
  return {
    db: req.server.infra.db,
    objectStore: req.server.infra.objectStore,
    env: req.server.infra.env,
    userId,
  };
}

export function getHostedKnowledgeAgentHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const input = entryInput(req);
    if (!input) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const resolved = await resolveHostedKnowledgeAgent(input);
    if (resolved.kind === 'not_found') return sendError(req, reply, ErrorCode.NOT_FOUND);
    if (resolved.kind === 'unavailable') {
      return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
    }
    const data: HostedKnowledgeAgentDescriptor = HostedKnowledgeAgentDescriptorSchema.parse({
      slug: HOSTED_KNOWLEDGE_AGENT_SLUG,
      name: resolved.agent.name,
      summary: resolved.agent.description,
      billing: {
        currency: 'CNY',
        unitPriceCents: input.env.RUNTIME_BILLING_UNIT_PRICE_CENTS.toString(),
        freeUses: input.env.RUNTIME_BILLING_FREE_USES,
      },
    });
    const body: Envelope<HostedKnowledgeAgentDescriptor> = {
      data,
      meta: { traceId: req.id },
    };
    reply.header('cache-control', 'private, no-store').code(200).send(body);
    return reply;
  };
}

export function startHostedKnowledgeAgentHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const input = entryInput(req);
    if (!input) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    if (!EmptyStartBodySchema.safeParse(req.body).success) {
      return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    }
    const resolved = await resolveHostedKnowledgeAgent(input);
    if (resolved.kind === 'not_found') return sendError(req, reply, ErrorCode.NOT_FOUND);
    if (resolved.kind === 'unavailable') {
      return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
    }
    try {
      const session = await createSession(input.db, {
        capabilityId: resolved.capabilityId,
        ownerUserId: input.userId,
        agentBinding: resolved.agent.binding,
      });
      const data: StartHostedKnowledgeAgentResult = StartHostedKnowledgeAgentResultSchema.parse({
        sessionId: session.id,
      });
      const body: Envelope<StartHostedKnowledgeAgentResult> = {
        data,
        meta: { traceId: req.id },
      };
      reply.header('cache-control', 'private, no-store').code(201).send(body);
      return reply;
    } catch {
      return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
    }
  };
}

const browserMutationGuards = [requireTrustedMutationOrigin(), requireAuth()];

export const HOSTED_KNOWLEDGE_AGENT_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'GET',
    url: `/runtime/agents/${HOSTED_KNOWLEDGE_AGENT_SLUG}`,
    preHandlers: [requireAuth()],
    handler: getHostedKnowledgeAgentHandler(),
  },
  {
    method: 'POST',
    url: `/runtime/agents/${HOSTED_KNOWLEDGE_AGENT_SLUG}/start`,
    preHandlers: browserMutationGuards,
    handler: startHostedKnowledgeAgentHandler(),
  },
];

export async function registerHostedKnowledgeAgentRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, HOSTED_KNOWLEDGE_AGENT_ENDPOINTS);
}
