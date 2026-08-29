import type { McpOAuthScope } from '@cb/shared';

import type { Queryable } from '../../platform/infra/db.js';
import type { TxPool } from '../../platform/infra/db-tx.js';
import { externalMcpPublicOrigin, type Env } from '../../platform/config/env.js';
import {
  PROJECT_HISTORY_AGENT_MCP_RESOURCES,
  PROJECT_HISTORY_AGENT_MCP_TOOLS,
  PgProjectHistoryAgentRepository,
  createProjectHistoryAgentService,
  executeProjectHistoryAgentMcpTool,
  readProjectHistoryAgentMcpResource,
} from '../project-history-agent/index.js';
import type { McpPrincipal } from './repo.js';
import { AGENT_BUILDER_APP_RESOURCE } from './agent-builder-app.js';
import { EXTERNAL_MCP_TOOLS } from './tools.js';

const projectHistoryToolByName = new Map(
  PROJECT_HISTORY_AGENT_MCP_TOOLS.map((tool) => [tool.name, tool] as const),
);

export const PROJECT_HISTORY_EXTERNAL_MCP_TOOLS = Object.freeze(
  PROJECT_HISTORY_AGENT_MCP_TOOLS.map(({ authorization, ...definition }) =>
    deepFreezeContribution({
      definition,
      requiredScope: (authorization === 'owner'
        ? 'combo.agent:write'
        : 'combo.agent:read') as McpOAuthScope,
    }),
  ),
);

export const PROJECT_HISTORY_EXTERNAL_MCP_RESOURCES = deepFreezeContribution([
  ...PROJECT_HISTORY_AGENT_MCP_RESOURCES,
]);

export function assertNoProjectHistoryExternalMcpCollisions(input: {
  legacyToolNames: readonly string[];
  appendedToolNames: readonly string[];
  legacyResourceUris: readonly string[];
  appendedResourceUris: readonly string[];
}): void {
  assertUniqueCatalogValues('tool name', [...input.legacyToolNames, ...input.appendedToolNames]);
  assertUniqueCatalogValues('resource URI', [
    ...input.legacyResourceUris,
    ...input.appendedResourceUris,
  ]);
}

assertNoProjectHistoryExternalMcpCollisions({
  legacyToolNames: EXTERNAL_MCP_TOOLS.map(({ name }) => name),
  appendedToolNames: PROJECT_HISTORY_EXTERNAL_MCP_TOOLS.map(({ definition }) => definition.name),
  legacyResourceUris: [AGENT_BUILDER_APP_RESOURCE.uri],
  appendedResourceUris: PROJECT_HISTORY_EXTERNAL_MCP_RESOURCES.map(({ uri }) => uri),
});

export function readProjectHistoryExternalMcpResource(uri: string) {
  return readProjectHistoryAgentMcpResource(uri);
}

export async function maybeExecuteProjectHistoryExternalMcpTool(input: {
  db: Queryable & TxPool;
  principal: McpPrincipal;
  env: Pick<Env, 'EXTERNAL_MCP_PUBLIC_ORIGIN'>;
  traceId: string;
  reportInternalFailure: (fields: Readonly<Record<string, unknown>>) => void;
  name: string;
  rawArguments: unknown;
}) {
  const tool = projectHistoryToolByName.get(input.name as never);
  if (!tool) return null;
  const requiredScope = tool.authorization === 'owner' ? 'combo.agent:write' : 'combo.agent:read';
  if (!input.principal.scopes.includes(requiredScope)) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false }) }],
      structuredContent: { error: { category: 'insufficient_scope' } },
      isError: true as const,
    };
  }
  const service = createProjectHistoryAgentService({
    repository: new PgProjectHistoryAgentRepository(input.db, input.db),
    publicOrigin: externalMcpPublicOrigin(input.env),
  });
  return executeProjectHistoryAgentMcpTool(
    {
      service,
      traceId: input.traceId,
      reportInternalFailure: input.reportInternalFailure,
      ...(tool.authorization === 'owner' ? { ownerUserId: input.principal.userId } : {}),
    },
    input.name,
    input.rawArguments,
  );
}

function assertUniqueCatalogValues(kind: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`external MCP ${kind} collision: ${value}`);
    seen.add(value);
  }
}

function deepFreezeContribution<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeContribution(child);
  }
  return Object.freeze(value);
}
