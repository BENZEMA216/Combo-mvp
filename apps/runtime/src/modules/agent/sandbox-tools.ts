import { Type, type Static } from '@earendil-works/pi-ai';
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@earendil-works/pi-agent-core';
import type {
  SandboxBackend,
  SandboxCommandFrame,
  SandboxTurnContext,
} from '../../platform/infra/sandbox-backend.js';
import { SandboxBackendError } from '../../platform/infra/sandbox-backend.js';

const ReadParams = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 1024,
    description: '相对 /workspace 的 POSIX 文件路径。禁止绝对路径、..、反斜杠和符号链接。',
  }),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 1_073_741_824,
      description: '从第几个 UTF-8 字节开始读取。',
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 4, maximum: 262_144, description: '最多读取的字节数。' }),
  ),
});

const WriteParams = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 1024,
    description: '相对 /workspace 的 POSIX 文件路径。',
  }),
  content: Type.String({
    maxLength: 524_288,
    description: '要原子写入的完整 UTF-8 文本，服务端按 UTF-8 字节再次限长。',
  }),
  createParents: Type.Optional(
    Type.Boolean({ description: '是否安全创建缺失的父目录，默认 false。' }),
  ),
});

const EditParams = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 1024,
    description: '相对 /workspace 的 POSIX 文件路径。',
  }),
  oldText: Type.String({
    minLength: 1,
    maxLength: 524_288,
    description: '必须在当前文件中存在的原文本，不能为空。',
  }),
  newText: Type.String({ maxLength: 524_288, description: '替换后的文本。' }),
  replaceAll: Type.Optional(
    Type.Boolean({
      description: '默认 false，要求 oldText 唯一；设为 true 时替换全部匹配。',
    }),
  ),
});

const BashParams = Type.Object({
  command: Type.String({
    minLength: 1,
    maxLength: 65_536,
    description: '在 /workspace 中由非交互 bash 执行的命令。',
  }),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 300_000,
      description: '命令超时毫秒数；默认 120000，最大 300000。',
    }),
  ),
});

export interface SandboxToolDetails {
  operation: 'read' | 'write' | 'edit' | 'bash';
  path?: string;
  sizeBytes?: number;
  offset?: number;
  nextOffset?: number;
  writtenBytes?: number;
  replacements?: number;
  commandId?: string;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
  durationMs?: number;
  stream?: 'stdout' | 'stderr';
}

type ReadAgentTool = AgentTool<typeof ReadParams, SandboxToolDetails>;
type WriteAgentTool = AgentTool<typeof WriteParams, SandboxToolDetails>;
type EditAgentTool = AgentTool<typeof EditParams, SandboxToolDetails>;
type BashAgentTool = AgentTool<typeof BashParams, SandboxToolDetails>;
export type SandboxAgentTool = ReadAgentTool | WriteAgentTool | EditAgentTool | BashAgentTool;

export interface SandboxToolsContext extends SandboxTurnContext {
  backend: SandboxBackend;
  /** Turn-owned fence; Pi's per-call signal is not trusted as the only abort source. */
  turnSignal: AbortSignal;
  /** Stops Pi when remote descendant cleanup cannot be proven. */
  onCleanupUnconfirmed?: () => void;
}

const SAFE_TOOL_ERRORS: Record<SandboxBackendError['code'], string> = {
  disabled: '沙箱工具未启用，无法执行该操作。',
  unauthorized: '当前轮次无权访问沙箱。',
  capacity: '当前沙箱容量已满，请稍后重试。',
  unavailable: '沙箱操作未能完成，请稍后重试。',
  invalid_path: '沙箱路径无效，请使用工作区内的相对路径。',
  not_found: '沙箱中的目标文件不存在。',
  edit_conflict: '编辑前提不匹配，请重新读取文件后再修改。',
  file_too_large: '沙箱文件或请求超过大小限制。',
  aborted: '沙箱操作已取消。',
  cleanup_unconfirmed: '沙箱命令清理未能确认，本轮必须停止。',
};

function safeToolError(error: unknown, onCleanupUnconfirmed?: () => void): Error {
  const code = error instanceof SandboxBackendError ? error.code : 'unavailable';
  if (code === 'cleanup_unconfirmed') onCleanupUnconfirmed?.();
  return new SandboxBackendError(code, SAFE_TOOL_ERRORS[code]);
}

class HeadTailBuffer {
  private readonly headLimit = 32 * 1024;
  private readonly tailLimit = 32 * 1024;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private totalBytes = 0;

  append(stream: 'stdout' | 'stderr', value: string): void {
    const bytes = Buffer.from(stream === 'stderr' ? `[stderr]\n${value}` : value);
    this.totalBytes += bytes.byteLength;
    if (this.head.byteLength < this.headLimit) {
      const remaining = this.headLimit - this.head.byteLength;
      this.head = Buffer.concat([this.head, bytes.subarray(0, remaining)]);
    }
    this.tail = Buffer.concat([this.tail, bytes]);
    if (this.tail.byteLength > this.tailLimit) {
      this.tail = this.tail.subarray(this.tail.byteLength - this.tailLimit);
    }
  }

  text(): string {
    if (this.totalBytes <= this.headLimit) return this.head.toString();
    if (this.totalBytes <= this.headLimit + this.tailLimit) {
      const overlap = this.head.byteLength + this.tail.byteLength - this.totalBytes;
      return Buffer.concat([this.head, this.tail.subarray(Math.max(0, overlap))]).toString();
    }
    return `${this.head.toString()}\n\n[中间输出已省略]\n\n${this.tail.toString()}`;
  }
}

function boundedUpdater(
  onUpdate: AgentToolUpdateCallback<SandboxToolDetails> | undefined,
): (frame: Extract<SandboxCommandFrame, { type: 'output' }>) => void {
  let updates = 0;
  let lastAt = 0;
  return (frame) => {
    if (!onUpdate || updates >= 32) return;
    const now = Date.now();
    if (updates > 0 && now - lastAt < 250) return;
    updates += 1;
    lastAt = now;
    const preview = Buffer.from(frame.data)
      .subarray(0, 4 * 1024)
      .toString();
    onUpdate({
      content: [{ type: 'text', text: preview }],
      details: { operation: 'bash', commandId: frame.commandId, stream: frame.stream },
    });
  };
}

export function createSandboxTools(
  context: SandboxToolsContext,
): [ReadAgentTool, WriteAgentTool, EditAgentTool, BashAgentTool] {
  const turn: SandboxTurnContext = {
    sessionId: context.sessionId,
    turnId: context.turnId,
    ownerUserId: context.ownerUserId,
  };
  const operationSignal = (callSignal?: AbortSignal): AbortSignal => {
    const signal = callSignal
      ? AbortSignal.any([context.turnSignal, callSignal])
      : context.turnSignal;
    if (signal.aborted) {
      throw new SandboxBackendError('aborted', '沙箱操作已取消。');
    }
    return signal;
  };
  const assertNotAborted = (signal: AbortSignal): void => {
    if (signal.aborted) throw new SandboxBackendError('aborted', '沙箱操作已取消。');
  };

  const read: ReadAgentTool = {
    name: 'read',
    label: '读取沙箱文件',
    description: '读取本会话沙箱 /workspace 内的 UTF-8 文本文件。只接受相对路径。',
    parameters: ReadParams,
    executionMode: 'sequential',
    async execute(
      _toolCallId: string,
      params: Static<typeof ReadParams>,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<SandboxToolDetails>> {
      try {
        const boundedSignal = operationSignal(signal);
        const result = await context.backend.read(turn, params, boundedSignal);
        assertNotAborted(boundedSignal);
        const nextOffset = result.offset + Buffer.byteLength(result.content);
        const notice = result.truncated
          ? `\n\n[读取已截断；下一次请从 UTF-8 字节偏移 ${nextOffset} 继续，文件共 ${result.sizeBytes} 字节。]`
          : '';
        return {
          content: [{ type: 'text', text: result.content + notice }],
          details: {
            operation: 'read',
            path: params.path,
            sizeBytes: result.sizeBytes,
            offset: result.offset,
            nextOffset,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        throw safeToolError(error, context.onCleanupUnconfirmed);
      }
    },
  };

  const write: WriteAgentTool = {
    name: 'write',
    label: '写入沙箱文件',
    description: '把完整 UTF-8 文本原子写入本会话沙箱。不会访问 Runtime 宿主文件系统。',
    parameters: WriteParams,
    executionMode: 'sequential',
    async execute(
      _toolCallId: string,
      params: Static<typeof WriteParams>,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<SandboxToolDetails>> {
      try {
        const boundedSignal = operationSignal(signal);
        const result = await context.backend.write(turn, params, boundedSignal);
        assertNotAborted(boundedSignal);
        return {
          content: [{ type: 'text', text: `已写入 ${result.writtenBytes} 字节。` }],
          details: { operation: 'write', path: params.path, writtenBytes: result.writtenBytes },
        };
      } catch (error) {
        throw safeToolError(error, context.onCleanupUnconfirmed);
      }
    },
  };

  const edit: EditAgentTool = {
    name: 'edit',
    label: '编辑沙箱文件',
    description: '按原文本前提原子编辑本会话沙箱文件；默认要求匹配唯一。',
    parameters: EditParams,
    executionMode: 'sequential',
    async execute(
      _toolCallId: string,
      params: Static<typeof EditParams>,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<SandboxToolDetails>> {
      try {
        const boundedSignal = operationSignal(signal);
        const result = await context.backend.edit(turn, params, boundedSignal);
        assertNotAborted(boundedSignal);
        return {
          content: [{ type: 'text', text: `已完成 ${result.replacements} 处替换。` }],
          details: {
            operation: 'edit',
            path: params.path,
            replacements: result.replacements,
          },
        };
      } catch (error) {
        throw safeToolError(error, context.onCleanupUnconfirmed);
      }
    },
  };

  const bash: BashAgentTool = {
    name: 'bash',
    label: '执行沙箱命令',
    description: '在独立、无网络、资源受限的 sandboxd Pod 的 /workspace 中执行非交互 bash 命令。',
    parameters: BashParams,
    executionMode: 'sequential',
    async execute(
      _toolCallId: string,
      params: Static<typeof BashParams>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<SandboxToolDetails>,
    ): Promise<AgentToolResult<SandboxToolDetails>> {
      const output = new HeadTailBuffer();
      const update = boundedUpdater(onUpdate);
      try {
        const boundedSignal = operationSignal(signal);
        const result = await context.backend.command(
          turn,
          params,
          (frame) => {
            if (boundedSignal.aborted || frame.type !== 'output') return;
            output.append(frame.stream, frame.data);
            update(frame);
          },
          boundedSignal,
        );
        assertNotAborted(boundedSignal);
        const text = output.text();
        const flags = [
          `退出码 ${result.exitCode}`,
          ...(result.signal ? [`信号 ${result.signal}`] : []),
          ...(result.timedOut ? ['已超时'] : []),
          ...(result.cancelled ? ['已取消'] : []),
          ...(result.truncated ? ['输出达到 1 MiB 上限'] : []),
        ];
        return {
          content: [
            {
              type: 'text',
              text: `${text || '(命令无输出)'}\n\n[命令状态：${flags.join('；')}。]`,
            },
          ],
          details: {
            operation: 'bash',
            commandId: result.commandId,
            exitCode: result.exitCode,
            ...(result.signal ? { signal: result.signal } : {}),
            timedOut: result.timedOut,
            cancelled: result.cancelled,
            truncated: result.truncated,
            durationMs: result.durationMs,
          },
        };
      } catch (error) {
        throw safeToolError(error, context.onCleanupUnconfirmed);
      }
    },
  };

  return [read, write, edit, bash];
}
