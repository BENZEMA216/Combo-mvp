export type CreatorSnapshotErrorCode =
  | 'CANONICAL_JSON_INVALID'
  | 'SNAPSHOT_ARCHIVE_INVALID'
  | 'SNAPSHOT_BINARY_FILE'
  | 'SNAPSHOT_CASE_COLLISION'
  | 'SNAPSHOT_COMPRESSED_TOO_LARGE'
  | 'SNAPSHOT_COMPRESSION_RATIO_EXCEEDED'
  | 'SNAPSHOT_DIGEST_MISMATCH'
  | 'SNAPSHOT_DUPLICATE_PATH'
  | 'SNAPSHOT_EMPTY'
  | 'SNAPSHOT_EXPANDED_TOO_LARGE'
  | 'SNAPSHOT_FILE_TOO_LARGE'
  | 'SNAPSHOT_HARDLINK_FORBIDDEN'
  | 'SNAPSHOT_IMMUTABLE_CONFLICT'
  | 'SNAPSHOT_OBJECT_INVALID'
  | 'SNAPSHOT_OBJECT_NOT_FOUND'
  | 'SNAPSHOT_STORAGE_UNAVAILABLE'
  | 'SNAPSHOT_INVALID_PATH'
  | 'SNAPSHOT_LFS_POINTER_FORBIDDEN'
  | 'SNAPSHOT_NUL_FORBIDDEN'
  | 'SNAPSHOT_PATH_BLOCKED'
  | 'SNAPSHOT_PATH_TOO_LONG'
  | 'SNAPSHOT_SECRET_DETECTED'
  | 'SNAPSHOT_SOURCE_CHANGED'
  | 'SNAPSHOT_SPARSE_FILE_FORBIDDEN'
  | 'SNAPSHOT_SPECIAL_FILE_FORBIDDEN'
  | 'SNAPSHOT_SYMLINK_FORBIDDEN'
  | 'SNAPSHOT_TOO_MANY_FILES'
  | 'SNAPSHOT_UNICODE_COLLISION'
  | 'SNAPSHOT_UTF8_REQUIRED'
  | 'SNAPSHOT_WRONG_FILE_TYPE'
  | 'SNAPSHOT_ENCRYPTION_INVALID'
  | 'AGENT_VERSION_INVALID'
  | 'AGENT_VERSION_IMMUTABLE_CONFLICT'
  | 'CONVERSATION_VERSION_PIN_CONFLICT';

const publicMessages: Record<CreatorSnapshotErrorCode, string> = {
  CANONICAL_JSON_INVALID: 'Canonical JSON 输入无效。',
  SNAPSHOT_ARCHIVE_INVALID: 'Snapshot archive 无效。',
  SNAPSHOT_BINARY_FILE: 'Snapshot 只接受可识别的 UTF-8 文本文件。',
  SNAPSHOT_CASE_COLLISION: 'Snapshot 存在大小写折叠后的路径冲突。',
  SNAPSHOT_COMPRESSED_TOO_LARGE: 'Snapshot 压缩对象超过上限。',
  SNAPSHOT_COMPRESSION_RATIO_EXCEEDED: 'Snapshot 压缩比超过安全上限。',
  SNAPSHOT_DIGEST_MISMATCH: 'Snapshot 完整性校验失败。',
  SNAPSHOT_DUPLICATE_PATH: 'Snapshot 存在重复路径。',
  SNAPSHOT_EMPTY: 'Snapshot 至少需要一个文件。',
  SNAPSHOT_EXPANDED_TOO_LARGE: 'Snapshot 内容总量超过上限。',
  SNAPSHOT_FILE_TOO_LARGE: 'Snapshot 单文件超过上限。',
  SNAPSHOT_HARDLINK_FORBIDDEN: 'Snapshot 不接受 hardlink。',
  SNAPSHOT_IMMUTABLE_CONFLICT: 'Snapshot 不可变对象发生冲突。',
  SNAPSHOT_OBJECT_INVALID: 'Snapshot 对象存储内容或元数据无效。',
  SNAPSHOT_OBJECT_NOT_FOUND: 'Snapshot 对象不存在。',
  SNAPSHOT_STORAGE_UNAVAILABLE: 'Snapshot 对象存储暂不可用。',
  SNAPSHOT_INVALID_PATH: 'Snapshot 包含无效相对路径。',
  SNAPSHOT_LFS_POINTER_FORBIDDEN: 'Snapshot 不接受 Git LFS pointer。',
  SNAPSHOT_NUL_FORBIDDEN: 'Snapshot 文件包含 NUL。',
  SNAPSHOT_PATH_BLOCKED: 'Snapshot 包含被策略阻断的路径。',
  SNAPSHOT_PATH_TOO_LONG: 'Snapshot 相对路径超过上限。',
  SNAPSHOT_SECRET_DETECTED: 'Snapshot 检测到高置信度敏感内容。',
  SNAPSHOT_SOURCE_CHANGED: 'Project 在 staging 期间发生变化。',
  SNAPSHOT_SPARSE_FILE_FORBIDDEN: 'Snapshot 不接受 sparse file。',
  SNAPSHOT_SPECIAL_FILE_FORBIDDEN: 'Snapshot 不接受特殊文件。',
  SNAPSHOT_SYMLINK_FORBIDDEN: 'Snapshot 不接受符号链接。',
  SNAPSHOT_TOO_MANY_FILES: 'Snapshot 文件数量超过上限。',
  SNAPSHOT_UNICODE_COLLISION: 'Snapshot 存在 Unicode 规范化路径冲突。',
  SNAPSHOT_UTF8_REQUIRED: 'Snapshot 文件名和正文必须是合法 UTF-8。',
  SNAPSHOT_WRONG_FILE_TYPE: 'Snapshot 文件类型不符合策略。',
  SNAPSHOT_ENCRYPTION_INVALID: 'Snapshot 加密对象认证失败。',
  AGENT_VERSION_INVALID: 'AgentVersion 执行清单无效。',
  AGENT_VERSION_IMMUTABLE_CONFLICT: 'AgentVersion 不可变内容发生冲突。',
  CONVERSATION_VERSION_PIN_CONFLICT: 'Conversation 已固定到另一个 AgentVersion。',
};

export class CreatorSnapshotError extends Error {
  readonly code: CreatorSnapshotErrorCode;

  constructor(code: CreatorSnapshotErrorCode, options?: ErrorOptions) {
    super(publicMessages[code], options);
    this.name = 'CreatorSnapshotError';
    this.code = code;
  }
}

function sanitizedCause(cause: unknown): unknown {
  if (cause === null || typeof cause !== 'object') return undefined;
  const candidate = cause as { name?: unknown; code?: unknown };
  const name = typeof candidate.name === 'string' ? candidate.name.slice(0, 64) : 'Error';
  const code =
    typeof candidate.code === 'string' || typeof candidate.code === 'number'
      ? String(candidate.code).slice(0, 64)
      : undefined;
  return Object.freeze(code === undefined ? { name } : { name, code });
}

export function fail(code: CreatorSnapshotErrorCode, cause?: unknown): never {
  const safeCause = sanitizedCause(cause);
  throw new CreatorSnapshotError(code, safeCause === undefined ? undefined : { cause: safeCause });
}

export function isSnapshotError(
  error: unknown,
  code?: CreatorSnapshotErrorCode,
): error is CreatorSnapshotError {
  return error instanceof CreatorSnapshotError && (code === undefined || error.code === code);
}
