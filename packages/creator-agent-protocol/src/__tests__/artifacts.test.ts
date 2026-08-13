import { describe, expect, it } from 'vitest';
import { createJsonSchemaBundle, createOpenApiDocument } from '../artifacts.js';

describe('生成的 JSON Schema 与 OpenAPI', () => {
  it('schema bundle 包含六份共享协议和 Gate 0 registries', () => {
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, unknown> };
    for (const required of [
      'AgentVersionManifest',
      'SnapshotManifest',
      'BrokerHandshake',
      'BrokerEnvelope',
      'InvocationTransition',
      'VnextErrorResponse',
      'SandboxSpec',
      'SandboxAttestation',
      'TestCaseRegistry',
      'EvidenceBundleManifest',
    ]) {
      expect(bundle.schemas[required], required).toBeDefined();
    }
  });

  it('OpenAPI 3.1 暴露 Creator/Consumer 核心路径与共享组件', () => {
    const openapi = createOpenApiDocument() as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(openapi.openapi).toBe('3.1.0');
    for (const path of [
      '/v1/creator/snapshot-uploads',
      '/v1/creator/agents/{agentId}/versions',
      '/v1/public/agents/{slug}/conversations',
      '/v1/conversations/{conversationId}/messages',
      '/v1/conversations/{conversationId}/events',
      '/v1/invocations/{invocationId}:cancel',
      '/v1/invocations/{invocationId}:retry',
    ]) {
      expect(openapi.paths[path], path).toBeDefined();
    }
    expect(openapi.components.schemas.VnextErrorResponse).toBeDefined();
  });
});
