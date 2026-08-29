import { describe, expect, it } from 'vitest';

import { AGENT_BUILDER_APP_RESOURCE } from '../modules/external-mcp/agent-builder-app.js';
import { EXTERNAL_MCP_TOOLS } from '../modules/external-mcp/tools.js';
import {
  PROJECT_HISTORY_EXTERNAL_MCP_RESOURCES,
  PROJECT_HISTORY_EXTERNAL_MCP_TOOLS,
  assertNoProjectHistoryExternalMcpCollisions,
} from '../modules/external-mcp/project-history-composition.js';
import {
  PROJECT_HISTORY_AGENT_MCP_RESOURCES,
  PROJECT_HISTORY_AGENT_MCP_TOOLS,
} from '../modules/project-history-agent/index.js';

const LEGACY_TOOL_NAMES = [
  'create_extraction_task',
  'read_extraction_task',
  'list_capabilities',
  'read_capability_definition',
  'list_agent_projects',
  'render_agent_builder',
  'create_agent_project',
  'target_agent_project',
  'read_agent_project',
  'save_agent_ui',
  'read_agent_ui',
  'commit_agent_revision',
  'read_agent_revision',
  'run_agent_test',
  'list_agent_tests',
  'read_agent_test',
  'record_agent_test_review',
  'publish_agent_revision',
  'create_project_agent_share',
  'read_project_agent_share',
  'create_codex_agent_share',
  'read_codex_agent_share',
  'prepare_codex_agent_run',
] as const;

const PROJECT_HISTORY_TOOL_NAMES = [
  'create_agent_package_draft',
  'render_agent_package_draft',
  'create_agent_package_share',
  'read_agent_package_share',
  'prepare_agent_package_run',
] as const;

describe('external MCP Project-history compatibility composition', () => {
  it('preserves the exact 0.8.3 legacy catalog and appends five collision-free tools', () => {
    expect(EXTERNAL_MCP_TOOLS.map(({ name }) => name)).toEqual(LEGACY_TOOL_NAMES);
    expect(PROJECT_HISTORY_AGENT_MCP_TOOLS.map(({ name }) => name)).toEqual(
      PROJECT_HISTORY_TOOL_NAMES,
    );
    const combined = [
      ...EXTERNAL_MCP_TOOLS,
      ...PROJECT_HISTORY_EXTERNAL_MCP_TOOLS.map(({ definition }) => definition),
    ];
    expect(combined).toHaveLength(28);
    expect(new Set(combined.map(({ name }) => name)).size).toBe(28);
  });

  it('preserves the legacy App and appends one collision-free typed Draft resource', () => {
    expect(PROJECT_HISTORY_EXTERNAL_MCP_RESOURCES).toEqual(PROJECT_HISTORY_AGENT_MCP_RESOURCES);
    const resources = [AGENT_BUILDER_APP_RESOURCE, ...PROJECT_HISTORY_EXTERNAL_MCP_RESOURCES];
    expect(resources).toHaveLength(2);
    expect(new Set(resources.map(({ uri }) => uri)).size).toBe(2);
  });

  it.each([
    {
      label: 'tool name',
      input: {
        legacyToolNames: ['existing'],
        appendedToolNames: ['existing'],
        legacyResourceUris: ['ui://combo/legacy'],
        appendedResourceUris: ['ui://combo/new'],
      },
    },
    {
      label: 'resource URI',
      input: {
        legacyToolNames: ['existing'],
        appendedToolNames: ['new'],
        legacyResourceUris: ['ui://combo/existing'],
        appendedResourceUris: ['ui://combo/existing'],
      },
    },
  ])('fails closed on an adversarial $label collision', ({ input }) => {
    expect(() => assertNoProjectHistoryExternalMcpCollisions(input)).toThrow(/collision/u);
  });

  it('deep-freezes the appended catalog contribution without mutating legacy behavior', () => {
    expect(Object.isFrozen(PROJECT_HISTORY_EXTERNAL_MCP_TOOLS)).toBe(true);
    expect(Object.isFrozen(PROJECT_HISTORY_EXTERNAL_MCP_TOOLS[0]?.definition)).toBe(true);
    expect(Object.isFrozen(PROJECT_HISTORY_EXTERNAL_MCP_TOOLS[0]?.definition.inputSchema)).toBe(
      true,
    );
    expect(Object.isFrozen(PROJECT_HISTORY_EXTERNAL_MCP_RESOURCES)).toBe(true);
  });
});
