// upsert_artifact —— 暴露给 Pi 的可信产物工具。正文先写不可变对象，随后只有在绑定
// Turn 仍为 running 时才提交 Artifact 索引；Studio 还会校验 Miniapp 运行契约。
import { randomUUID } from 'node:crypto';
import { StringEnum, Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ArtifactView, SessionMode } from '@cb/shared';
import type { RuntimeDb } from '../../platform/infra/db.js';
import type { RuntimeObjectStore } from '../../platform/infra/object-store.js';
import {
  ARTIFACT_BUCKET,
  artifactVersionStorageKey,
  contentTypeFor,
  readArtifactInSession,
  upsertArtifactForRunningTurn,
} from './repo.js';
import { StudioArtifactValidationError, validateStudioHtml } from './studio-contract.js';

const ArtifactParams = Type.Object({
  artifactId: Type.Optional(
    Type.String({
      description:
        '要更新的产物 id（来自之前调用的回执）。省略 = 新建一个产物；同一份成品反复修改必须带同一个 id。',
    }),
  ),
  kind: StringEnum(['html', 'markdown', 'code', 'structured'], {
    description:
      'html=自包含可交互网页(沙箱iframe预览); markdown=富文本文档; code=单文件代码; structured=结构化JSON(评分/清单/字段表)。',
  }),
  title: Type.String({ description: '产物标题（展示在画布顶部）。' }),
  language: Type.Optional(
    Type.String({ description: 'kind=code 时的语言标注，如 ts/python/sql；其余 kind 可省。' }),
  ),
  content: Type.String({
    description:
      '产物完整内容。html 须为完整自包含 HTML 文档；structured 须为合法 JSON 字符串；其余为对应文本。',
  }),
});
type ArtifactParamsT = Static<typeof ArtifactParams>;

export interface ArtifactToolContext {
  db: RuntimeDb;
  objectStore: RuntimeObjectStore;
  sessionId: string;
  turnId: string;
  turnSignal: AbortSignal;
  mode?: SessionMode;
  capabilityId?: string;
  /** 产出或更新一项产物后回调；run-turn 据此发送 AG-UI 产物更新事件。 */
  onArtifact: (artifact: ArtifactView) => void;
}

export type ArtifactAgentTool = AgentTool<typeof ArtifactParams, { artifactId: string }>;

export function createArtifactTool(ctx: ArtifactToolContext): ArtifactAgentTool {
  return {
    name: 'upsert_artifact',
    label: '产出/更新产物',
    description:
      '把一份可独立留存的成品（文档/网页/代码/结构化数据）写成产物展示给用户。修改已有产物时带上回执里的 artifactId。',
    parameters: ArtifactParams,
    async execute(
      _toolCallId: string,
      params: ArtifactParamsT,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<{ artifactId: string }>> {
      const operationSignal = signal ? AbortSignal.any([signal, ctx.turnSignal]) : ctx.turnSignal;
      if (operationSignal.aborted) throw new DOMException('artifact write aborted', 'AbortError');

      const studio = ctx.mode === 'studio';
      if (studio) {
        if (!ctx.capabilityId) {
          throw new Error('Studio artifact tool requires capabilityId');
        }
        if (params.kind !== 'html') {
          throw new StudioArtifactValidationError(['Studio 主产物必须使用 kind=html']);
        }
        const validation = validateStudioHtml(params.content);
        if (!validation.ok) throw new StudioArtifactValidationError(validation.errors);
      }

      // 模型给的编号只有真实存在于本会话才算更新，否则按新建处理。
      const requested = params.artifactId?.trim();
      const requestedExisting = requested
        ? await readArtifactInSession(ctx.db, requested, ctx.sessionId)
        : null;
      if (operationSignal.aborted) throw new DOMException('artifact write aborted', 'AbortError');

      // Studio 每次写不可变 revision；普通运行产物保留同一 Artifact 索引。
      const existing = studio ? null : requestedExisting;
      const id = existing?.id ?? randomUUID();
      const storageKey = artifactVersionStorageKey(ctx.sessionId, id, randomUUID());

      // 先写不可变暂存对象。中断后的迟到上传最多留下不可见孤儿对象。
      await ctx.objectStore.putObject(
        ARTIFACT_BUCKET,
        storageKey,
        new TextEncoder().encode(params.content),
        { contentType: contentTypeFor(params.kind), abortSignal: operationSignal },
      );
      if (operationSignal.aborted) throw new DOMException('artifact write aborted', 'AbortError');

      const view = await upsertArtifactForRunningTurn(
        ctx.db,
        {
          id,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          kind: params.kind,
          title: params.title,
          storageKey,
          meta: params.language ? { language: params.language } : {},
        },
        operationSignal,
      );
      if (!view) throw new DOMException('artifact turn is no longer running', 'AbortError');

      ctx.onArtifact(view);
      return {
        content: [
          {
            type: 'text',
            text: studio
              ? `已生成 Miniapp revision「${params.title}」（artifactId=${id}）。本轮完整成功后才会设为 Agent 当前 UI；后续修改请再生成新 revision，不要复用这个 artifactId。请用一两句话说明并邀请继续迭代。`
              : `已${existing ? '更新' : '产出'}产物「${params.title}」（artifactId=${id}，kind=${params.kind}），已在画布展示给用户。后续修改同一产物请带同一个 artifactId。请用一两句话说明并邀请继续迭代，不要在正文重复产物全文。`,
          },
        ],
        details: { artifactId: id },
      };
    },
  };
}
