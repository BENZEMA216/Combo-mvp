import {
  serializeCreatorAgentPackageCreatorRequest,
  verifyCreatorAgentPackageCreatorBootstrapHandoff,
  verifyCreatorAgentPackageDraftSnapshot,
  type CreatorAgentPackageCreatorBootstrapHandoff,
  type CreatorAgentPackageDraftSnapshot,
} from '@cb/creator-agent-protocol/agent-package-draft';

import { CreatorAgentProjectCompilerError } from '../authoring/project-behavior-extractor.js';
import {
  CreatorAgentPackageCreatorError,
  type CreatorAgentPackageDraftAuthoringTask,
  type CreatorAgentPackageDraftCreationOptions,
} from './agent-package-creator.js';

export type CreatorAgentPackageCreatorBridgeStage =
  | 'HANDOFF'
  | 'BIND_CURRENT_PROJECT'
  | 'EXTRACT_DRAFT'
  | 'VALIDATE_DRAFT';

export type CreatorAgentPackageCreatorBridgeProgress = Readonly<{
  stage: CreatorAgentPackageCreatorBridgeStage;
  message: string;
}>;

export type CreatorAgentPackageCreatorBridgeOptions = Readonly<{
  signal?: AbortSignal;
  turnTimeoutMs?: number;
  progressSink?: (progress: CreatorAgentPackageCreatorBridgeProgress) => void;
}>;

export type CreatorAgentPackageCreatorBridgeDependencies = Readonly<{
  resolveHostBoundCurrentProject(): string;
  createDraft(
    options: CreatorAgentPackageDraftCreationOptions,
  ): Promise<CreatorAgentPackageDraftAuthoringTask>;
}>;

export async function createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
  rawHandoff: unknown,
  options: CreatorAgentPackageCreatorBridgeOptions,
  dependencies: CreatorAgentPackageCreatorBridgeDependencies,
): Promise<CreatorAgentPackageDraftSnapshot> {
  const handoff = verifyHandoff(rawHandoff);
  assertNotCancelled(options.signal, 'HANDOFF');
  options.progressSink?.({ stage: 'HANDOFF', message: 'Creator handoff 已验证。' });

  let currentProjectPath: string;
  try {
    // Project 身份只来自 Codex Host 已绑定的工作目录，公开 handoff 永远不携带路径。
    currentProjectPath = dependencies.resolveHostBoundCurrentProject();
  } catch (error) {
    throw currentProjectUnavailable(error);
  }
  assertNotCancelled(options.signal, 'BIND_CURRENT_PROJECT');
  options.progressSink?.({
    stage: 'BIND_CURRENT_PROJECT',
    message: 'Codex Host 当前 Project 已绑定。',
  });

  let task: CreatorAgentPackageDraftAuthoringTask;
  try {
    // Plugin 在启动桥接前取得全量创作读取授权；这些授权不能由不受信 handoff 自行声明。
    task = await dependencies.createDraft({
      request: handoff.creatorRequest,
      currentProjectPath,
      allowUnisolatedRead: true,
      allowSensitiveProjectContext: true,
      allowLoopbackProxy: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    });
  } catch (error) {
    if (
      error instanceof CreatorAgentProjectCompilerError &&
      error.code === 'PROJECT_COMPILER_STOP_INCOMPLETE'
    ) {
      throw bridgeError(
        'CLEANUP_INCOMPLETE',
        'EXTRACT_DRAFT',
        'Codex Host 清理未完整结束；本次创作不能视为安全完成。',
        error,
      );
    }
    if (options.signal?.aborted === true) throw cancelled(error);
    if (error instanceof CreatorAgentProjectCompilerError) {
      if (error.code === 'PROJECT_CONTEXT_PATH_INVALID') {
        throw currentProjectUnavailable(error);
      }
      if (error.code === 'PROJECT_CONTEXT_SCAN_LIMIT') {
        throw bridgeError(
          'SOURCE_LIMIT',
          'EXTRACT_DRAFT',
          '当前 Project 超过 Creator Bridge 的安全扫描上限。',
          error,
        );
      }
      if (error.code === 'PROJECT_CONTEXT_CHANGED') {
        throw bridgeError(
          'SOURCE_CHANGED',
          'EXTRACT_DRAFT',
          '当前 Project 在提取期间发生变化，请在变更稳定后重试。',
          error,
        );
      }
    }
    if (
      error instanceof CreatorAgentPackageCreatorError &&
      error.code === 'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID'
    ) {
      throw currentProjectUnavailable(error);
    }
    if (
      error instanceof CreatorAgentPackageCreatorError &&
      error.code === 'AGENT_PACKAGE_DRAFT_OUTPUT_INVALID'
    ) {
      throw draftInvalid(error);
    }
    throw bridgeError(
      'EXTRACTION_FAILED',
      'EXTRACT_DRAFT',
      '当前 Project 的 Agent 流程提取未完成。',
      error,
    );
  }
  assertNotCancelled(options.signal, 'EXTRACT_DRAFT');
  options.progressSink?.({ stage: 'EXTRACT_DRAFT', message: '当前 Project 已完成提取。' });

  try {
    const draft = verifyCreatorAgentPackageDraftSnapshot(task.readDraft());
    if (
      serializeCreatorAgentPackageCreatorRequest(draft.creatorRequest) !==
      serializeCreatorAgentPackageCreatorRequest(handoff.creatorRequest)
    ) {
      throw new TypeError('Draft creator request does not match the exact handoff.');
    }
    options.progressSink?.({ stage: 'VALIDATE_DRAFT', message: 'Agent Package Draft 已验证。' });
    return draft;
  } catch (error) {
    throw draftInvalid(error);
  }
}

function verifyHandoff(input: unknown): CreatorAgentPackageCreatorBootstrapHandoff {
  try {
    return verifyCreatorAgentPackageCreatorBootstrapHandoff(input);
  } catch (error) {
    throw bridgeError(
      'HANDOFF_INVALID',
      'HANDOFF',
      'Creator handoff 无效；请从官方创建指南重新发起。',
      error,
    );
  }
}

export type CreatorAgentPackageCreatorBridgeErrorCode =
  | 'HANDOFF_INVALID'
  | 'CURRENT_PROJECT_UNAVAILABLE'
  | 'SOURCE_LIMIT'
  | 'SOURCE_CHANGED'
  | 'CLEANUP_INCOMPLETE'
  | 'EXTRACTION_FAILED'
  | 'DRAFT_INVALID'
  | 'CANCELLED'
  | 'INTERNAL';

export class CreatorAgentPackageCreatorBridgeError extends Error {
  public constructor(
    public readonly code: CreatorAgentPackageCreatorBridgeErrorCode,
    public readonly stage: CreatorAgentPackageCreatorBridgeStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CreatorAgentPackageCreatorBridgeError';
  }
}

function bridgeError(
  code: CreatorAgentPackageCreatorBridgeErrorCode,
  stage: CreatorAgentPackageCreatorBridgeStage,
  message: string,
  cause: unknown,
): CreatorAgentPackageCreatorBridgeError {
  return new CreatorAgentPackageCreatorBridgeError(
    code,
    stage,
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function currentProjectUnavailable(cause: unknown): CreatorAgentPackageCreatorBridgeError {
  return bridgeError(
    'CURRENT_PROJECT_UNAVAILABLE',
    'BIND_CURRENT_PROJECT',
    'Codex Host 当前 Project 无法被可靠绑定。',
    cause,
  );
}

function draftInvalid(cause: unknown): CreatorAgentPackageCreatorBridgeError {
  return bridgeError(
    'DRAFT_INVALID',
    'VALIDATE_DRAFT',
    '提取结果无法形成有效的 Agent Package Draft。',
    cause,
  );
}

function cancelled(
  cause: unknown,
  stage: CreatorAgentPackageCreatorBridgeStage = 'EXTRACT_DRAFT',
): CreatorAgentPackageCreatorBridgeError {
  return bridgeError('CANCELLED', stage, 'Agent Package Draft 创作已取消。', cause);
}

function assertNotCancelled(
  signal: AbortSignal | undefined,
  stage: CreatorAgentPackageCreatorBridgeStage,
): void {
  if (signal?.aborted === true) throw cancelled(signal.reason, stage);
}
