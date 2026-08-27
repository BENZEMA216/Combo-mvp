import {
  serializeCreatorAgentPackageCreatorRequest,
  verifyCreatorAgentPackageCreatorBootstrapHandoff,
  verifyCreatorAgentPackageDraftSnapshot,
  type CreatorAgentPackageCreatorBootstrapHandoff,
  type CreatorAgentPackageDraftSnapshot,
} from '@cb/creator-agent-protocol/agent-package-draft';

import {
  CreatorAgentProjectCompilerError,
  type CreatorAgentProjectCompilerErrorCode,
} from '../authoring/project-behavior-extractor.js';
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
    // Cleanup evidence has priority over cancellation because an aborted Host may still be alive.
    if (
      error instanceof CreatorAgentProjectCompilerError &&
      error.code === 'PROJECT_COMPILER_STOP_INCOMPLETE'
    )
      throw classifyCompilerError(error);
    if (options.signal?.aborted === true) throw cancelled(error);
    if (error instanceof CreatorAgentProjectCompilerError) throw classifyCompilerError(error);
    if (
      error instanceof CreatorAgentPackageCreatorError &&
      error.code === 'AGENT_PACKAGE_DRAFT_PROJECT_UNAVAILABLE'
    ) {
      throw currentProjectUnavailable(error);
    }
    if (
      error instanceof CreatorAgentPackageCreatorError &&
      error.code === 'AGENT_PACKAGE_DRAFT_OUTPUT_INVALID'
    ) {
      throw draftInvalid(error);
    }
    // Remaining Creator errors are trusted composition or wiring failures and stay private.
    throw internalFailure(error);
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
  | 'SOURCE_READ_FAILED'
  | 'SOURCE_LIMIT'
  | 'SOURCE_CHANGED'
  | 'CLEANUP_INCOMPLETE'
  | 'HOST_FAILED'
  | 'OUTPUT_INVALID'
  | 'OUTPUT_REJECTED'
  // Retained for consumers of older combo.agent-package-creator-bridge-error/1 producers.
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

type CompilerErrorClassification = Readonly<{
  code: CreatorAgentPackageCreatorBridgeErrorCode;
  stage: CreatorAgentPackageCreatorBridgeStage;
  message: string;
}>;

const INTERNAL_COMPILER_ERROR_CLASSIFICATION: CompilerErrorClassification = Object.freeze({
  code: 'INTERNAL',
  stage: 'EXTRACT_DRAFT',
  message: 'Creator Bridge 未完成，且没有暴露内部错误信息。',
});

const REJECTED_COMPILER_OUTPUT_CLASSIFICATION: CompilerErrorClassification = Object.freeze({
  code: 'OUTPUT_REJECTED',
  stage: 'EXTRACT_DRAFT',
  message: '提取候选结果被 Creator Bridge 的安全策略拒绝。',
});

// The exhaustive record makes every future compiler code choose an explicit public category.
const COMPILER_ERROR_CLASSIFICATIONS = Object.freeze({
  PROJECT_CONTEXT_PATH_INVALID: {
    code: 'CURRENT_PROJECT_UNAVAILABLE',
    stage: 'BIND_CURRENT_PROJECT',
    message: 'Codex Host 当前 Project 无法被可靠绑定。',
  },
  PROJECT_CONTEXT_SCAN_FAILED: {
    code: 'SOURCE_READ_FAILED',
    stage: 'EXTRACT_DRAFT',
    message: 'Creator Bridge 无法完整读取当前 Project 的允许来源。',
  },
  PROJECT_CONTEXT_SCAN_LIMIT: {
    code: 'SOURCE_LIMIT',
    stage: 'EXTRACT_DRAFT',
    message: '当前 Project 超过 Creator Bridge 的安全扫描上限。',
  },
  PROJECT_CONTEXT_CHANGED: {
    code: 'SOURCE_CHANGED',
    stage: 'EXTRACT_DRAFT',
    message: '当前 Project 在提取期间发生变化，请在变更稳定后重试。',
  },
  PROJECT_COMPILER_CONFIGURATION_INVALID: INTERNAL_COMPILER_ERROR_CLASSIFICATION,
  PROJECT_CONTEXT_AUTHORIZATION_REQUIRED: INTERNAL_COMPILER_ERROR_CLASSIFICATION,
  PROJECT_COMPILER_GIT_INVALID: INTERNAL_COMPILER_ERROR_CLASSIFICATION,
  PROJECT_COMPILER_HOST_FAILED: {
    code: 'HOST_FAILED',
    stage: 'EXTRACT_DRAFT',
    message: '结构化 Codex Host 未能完成本次 Agent 流程提取。',
  },
  PROJECT_COMPILER_OUTPUT_INVALID: {
    code: 'OUTPUT_INVALID',
    stage: 'EXTRACT_DRAFT',
    message: '结构化 Codex Host 返回的结果不符合严格提取合同。',
  },
  PROJECT_COMPILER_SAFETY_REJECTED: REJECTED_COMPILER_OUTPUT_CLASSIFICATION,
  PROJECT_COMPILER_RUNTIME_UNSUPPORTED: INTERNAL_COMPILER_ERROR_CLASSIFICATION,
  PROJECT_COMPILER_SECRET_OUTPUT: REJECTED_COMPILER_OUTPUT_CLASSIFICATION,
  PROJECT_COMPILER_STOP_INCOMPLETE: {
    code: 'CLEANUP_INCOMPLETE',
    stage: 'EXTRACT_DRAFT',
    message: 'Codex Host 清理未完整结束；本次创作不能视为安全完成。',
  },
} satisfies Readonly<Record<CreatorAgentProjectCompilerErrorCode, CompilerErrorClassification>>);

function classifyCompilerError(
  error: CreatorAgentProjectCompilerError,
): CreatorAgentPackageCreatorBridgeError {
  // Runtime values may come from a newer compiler build; unknown codes fail closed as INTERNAL.
  const classification = (
    COMPILER_ERROR_CLASSIFICATIONS as Readonly<Partial<Record<string, CompilerErrorClassification>>>
  )[error.code];
  if (classification === undefined) return internalFailure(error);
  return bridgeError(classification.code, classification.stage, classification.message, error);
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

function internalFailure(cause: unknown): CreatorAgentPackageCreatorBridgeError {
  return bridgeError(
    'INTERNAL',
    'EXTRACT_DRAFT',
    'Creator Bridge 未完成，且没有暴露内部错误信息。',
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
