import { createHash } from 'node:crypto';
import {
  AgentTestDetailSchema,
  AgentTestListSchema,
  ErrorEnvelopeSchema,
  SavedAgentUiRevisionSchema,
  StartAgentTestBodySchema,
  SaveAgentUiRevisionBodySchema,
  StudioSessionEntrySchema,
  type AgentTestDetail,
  type AgentTestList,
  type SaveAgentUiRevisionBody,
  type SavedAgentUiRevision,
  type StartAgentTestBody,
  type StudioSessionEntry,
} from '@cb/shared';
import { z } from 'zod';

const REQUEST_TIMEOUT_MS = 20_000;

const envelope = <T extends z.ZodTypeAny>(schema: T) => z.object({ data: schema }).passthrough();

export class McpRuntimeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retriable: boolean,
    readonly action: string,
    readonly traceId?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpRuntimeRequestError';
  }
}

export interface McpRuntimeClientOptions {
  baseUrl: string;
  authorization: string;
}

export class McpRuntimeClient {
  constructor(private readonly options: McpRuntimeClientOptions) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(new URL(path, this.options.baseUrl), {
        ...init,
        signal,
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: this.options.authorization,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new McpRuntimeRequestError(
        'Combo Runtime 暂时不可达，请稍后重试。',
        503,
        true,
        'retry',
      );
    }
    if (response.ok) return response;
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      raw = null;
    }
    const parsed = ErrorEnvelopeSchema.safeParse(raw);
    if (parsed.success) {
      throw new McpRuntimeRequestError(
        parsed.data.error.userMessage,
        response.status,
        parsed.data.error.retriable,
        parsed.data.error.action,
        parsed.data.error.traceId,
        parsed.data.error.details,
      );
    }
    throw new McpRuntimeRequestError(
      'Combo Runtime 暂时无法完成请求，请稍后重试。',
      response.status,
      response.status >= 500,
      response.status >= 500 ? 'retry' : 'change_input',
    );
  }

  private async json<TSchema extends z.ZodTypeAny>(
    path: string,
    schema: TSchema,
    init?: RequestInit,
  ): Promise<z.output<TSchema>> {
    const response = await this.request(path, init);
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new McpRuntimeRequestError('Combo Runtime 返回了无法识别的响应。', 502, true, 'retry');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new McpRuntimeRequestError('Combo Runtime 响应没有通过契约校验。', 502, true, 'retry');
    }
    return parsed.data;
  }

  async createStudioSession(capabilityId: string): Promise<StudioSessionEntry> {
    const response = await this.json(
      '/internal/mcp/studio/sessions',
      envelope(StudioSessionEntrySchema),
      { method: 'POST', body: JSON.stringify({ capabilityId }) },
    );
    return response.data;
  }

  async saveAgentUiRevision(
    sessionId: string,
    body: SaveAgentUiRevisionBody,
  ): Promise<SavedAgentUiRevision> {
    const parsed = SaveAgentUiRevisionBodySchema.parse(body);
    const response = await this.json(
      `/internal/mcp/studio/sessions/${encodeURIComponent(sessionId)}/ui-revisions`,
      envelope(SavedAgentUiRevisionSchema),
      { method: 'POST', body: JSON.stringify(parsed) },
    );
    return response.data;
  }

  async readArtifactContent(artifactId: string): Promise<{
    artifact: { id: string; contentType: string; byteLength: number; sha256: string };
    html: string;
  }> {
    const response = await this.request(
      `/internal/mcp/artifacts/${encodeURIComponent(artifactId)}/content`,
    );
    const contentType = response.headers.get('content-type')?.trim();
    if (!contentType?.toLowerCase().startsWith('text/html')) {
      throw new McpRuntimeRequestError(
        'Combo Runtime 返回的 Agent UI 不是 HTML。',
        502,
        false,
        'escalate',
      );
    }
    const html = await response.text();
    return {
      artifact: {
        id: artifactId,
        contentType,
        byteLength: new TextEncoder().encode(html).byteLength,
        sha256: createHash('sha256').update(html).digest('hex'),
      },
      html,
    };
  }

  async startAgentTest(revisionId: string, body: StartAgentTestBody): Promise<AgentTestDetail> {
    const parsed = StartAgentTestBodySchema.parse(body);
    const response = await this.json(
      `/internal/mcp/agent-revisions/${encodeURIComponent(revisionId)}/tests`,
      envelope(AgentTestDetailSchema),
      { method: 'POST', body: JSON.stringify(parsed) },
    );
    return response.data;
  }

  async listAgentTests(projectId: string, limit?: number): Promise<AgentTestList> {
    const path = new URL(
      `/internal/mcp/agent-projects/${encodeURIComponent(projectId)}/tests`,
      this.options.baseUrl,
    );
    if (limit !== undefined) path.searchParams.set('limit', String(limit));
    const response = await this.json(path.toString(), envelope(AgentTestListSchema));
    return response.data;
  }

  async readAgentTest(testId: string): Promise<AgentTestDetail> {
    const response = await this.json(
      `/internal/mcp/agent-tests/${encodeURIComponent(testId)}`,
      envelope(AgentTestDetailSchema),
    );
    return response.data;
  }
}
