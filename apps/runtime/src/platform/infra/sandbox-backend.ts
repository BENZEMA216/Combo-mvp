export interface SandboxTurnContext {
  sessionId: string;
  turnId: string;
  ownerUserId: string;
}

export interface SandboxDescribeResult {
  protocolVersion: string;
  sessionId: string;
  podUid: string;
  workspace: '/workspace';
  commandOutputEncoding: 'base64';
  operations: string[];
  limits: {
    maxRequestBytes: number;
    maxReadBytes: number;
    maxFileBytes: number;
    maxOutputBytes: number;
    maxOutputFrames: number;
    maxFrameBytes: number;
    commandTimeoutMs: number;
    maxCommandTimeMs: number;
  };
}

export interface SandboxReadInput {
  path: string;
  offset?: number;
  limit?: number;
}
export interface SandboxReadResult {
  content: string;
  sizeBytes: number;
  offset: number;
  truncated: boolean;
}

export interface SandboxWriteInput {
  path: string;
  content: string;
  createParents?: boolean;
}
export interface SandboxWriteResult {
  writtenBytes: number;
}

export interface SandboxEditInput {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}
export interface SandboxEditResult {
  replacements: number;
}

export type SandboxCommandFrame =
  | { type: 'start'; commandId: string }
  | { type: 'output'; commandId: string; stream: 'stdout' | 'stderr'; data: string }
  | {
      type: 'exit';
      commandId: string;
      exitCode: number;
      signal?: string;
      timedOut?: boolean;
      cancelled?: boolean;
      truncated?: boolean;
      durationMs?: number;
      error?: 'output_limit_exceeded' | 'timeout' | 'cancelled';
    }
  | { type: 'error'; commandId: string; error: string };

export interface SandboxCommandInput {
  command: string;
  timeoutMs?: number;
}
export interface SandboxCommandResult {
  commandId: string;
  exitCode: number;
  signal?: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
}

export class SandboxBackendError extends Error {
  readonly code:
    | 'disabled'
    | 'unauthorized'
    | 'capacity'
    | 'unavailable'
    | 'invalid_path'
    | 'not_found'
    | 'edit_conflict'
    | 'file_too_large'
    | 'aborted'
    | 'cleanup_unconfirmed';

  constructor(code: SandboxBackendError['code'], message: string) {
    super(message);
    this.name = 'SandboxBackendError';
    this.code = code;
  }
}

export interface SandboxBackend {
  readonly enabled: boolean;
  describe(context: SandboxTurnContext, signal?: AbortSignal): Promise<SandboxDescribeResult>;
  read(
    context: SandboxTurnContext,
    input: SandboxReadInput,
    signal?: AbortSignal,
  ): Promise<SandboxReadResult>;
  write(
    context: SandboxTurnContext,
    input: SandboxWriteInput,
    signal?: AbortSignal,
  ): Promise<SandboxWriteResult>;
  edit(
    context: SandboxTurnContext,
    input: SandboxEditInput,
    signal?: AbortSignal,
  ): Promise<SandboxEditResult>;
  command(
    context: SandboxTurnContext,
    input: SandboxCommandInput,
    onFrame: (frame: SandboxCommandFrame) => void,
    signal?: AbortSignal,
  ): Promise<SandboxCommandResult>;
  /** Confirms local cancellation or UID-conditionally deletes this Session's Pod across replicas. */
  interruptSession(sessionId: string): Promise<void>;
  /** Deletes a terminal Session's temporary Pod with Kubernetes UID preconditions. */
  releaseSession(sessionId: string): Promise<void>;
  /** Cancels this replica's commands and stops timers. Reusable idle Pods remain discoverable. */
  dispose(signal?: AbortSignal): Promise<void>;
}

const disabledError = () => new SandboxBackendError('disabled', '沙箱工具未启用，无法执行该操作。');

export function createDisabledSandboxBackend(): SandboxBackend {
  return {
    enabled: false,
    describe: async () => Promise.reject(disabledError()),
    read: async () => Promise.reject(disabledError()),
    write: async () => Promise.reject(disabledError()),
    edit: async () => Promise.reject(disabledError()),
    command: async () => Promise.reject(disabledError()),
    interruptSession: async () =>
      Promise.reject(
        new SandboxBackendError(
          'cleanup_unconfirmed',
          'disabled replica cannot verify a foreign sandbox process namespace',
        ),
      ),
    releaseSession: async () => undefined,
    dispose: async () => undefined,
  };
}
