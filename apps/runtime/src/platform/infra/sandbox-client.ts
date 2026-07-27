import { randomUUID } from 'node:crypto';
import type {
  SandboxCommandFrame,
  SandboxCommandResult,
  SandboxDescribeResult,
  SandboxEditInput,
  SandboxEditResult,
  SandboxReadInput,
  SandboxReadResult,
  SandboxWriteInput,
  SandboxWriteResult,
} from './sandbox-backend.js';
import { SandboxBackendError } from './sandbox-backend.js';
import type { SandboxCapabilitySigner, SandboxOperation } from './sandbox-capability.js';

const JSON_REQUEST_LIMIT = 8 * 1024 * 1024;
const JSON_RESPONSE_LIMIT = 2 * 1024 * 1024;
const NDJSON_RESPONSE_LIMIT = 9 * 1024 * 1024;
const NDJSON_FRAME_LIMIT = 16 * 1024;
const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
const COMMAND_FRAME_COUNT_LIMIT = 4_098;
const COMMAND_TRANSPORT_LIMIT_MS = 315_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const CANCEL_ATTEMPTS = 10;
const CANCEL_RETRY_DELAY_MS = 25;

type SandboxWireCommandFrame =
  | Exclude<SandboxCommandFrame, { type: 'output' }>
  | {
      type: 'output';
      commandId: string;
      stream: 'stdout' | 'stderr';
      encoding: 'base64';
      data: string;
    };

export interface SandboxClientOptions {
  baseUrl: string;
  sessionId: string;
  podUid: string;
  signer: SandboxCapabilitySigner;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  commandTransportTimeoutMs?: number;
  onCancelFailure?: (commandId: string) => Promise<void>;
}

function unavailable(message = '沙箱返回了无效响应。'): SandboxBackendError {
  return new SandboxBackendError('unavailable', message);
}

function abortFailure(userSignal?: AbortSignal): SandboxBackendError {
  return userSignal?.aborted
    ? new SandboxBackendError('aborted', '沙箱操作已取消。')
    : unavailable('沙箱请求超时，请稍后重试。');
}

async function settleWithSignal<T>(
  operation: Promise<T>,
  boundedSignal: AbortSignal,
  userSignal?: AbortSignal,
): Promise<T> {
  if (boundedSignal.aborted) throw abortFailure(userSignal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      boundedSignal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortFailure(userSignal)));
    boundedSignal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function toBackendError(code: string | undefined, status: number): SandboxBackendError {
  switch (code) {
    case 'invalid_path':
      return new SandboxBackendError('invalid_path', '沙箱路径无效，请使用工作区内的相对路径。');
    case 'not_found':
      return new SandboxBackendError('not_found', '沙箱中的目标文件不存在。');
    case 'edit_conflict':
      return new SandboxBackendError('edit_conflict', '编辑前提不匹配，请重新读取文件后再修改。');
    case 'file_too_large':
    case 'request_too_large':
      return new SandboxBackendError('file_too_large', '沙箱文件或请求超过大小限制。');
    case 'unauthorized':
      return new SandboxBackendError('unauthorized', '沙箱授权已失效，请重试。');
    default:
      return new SandboxBackendError(
        'unavailable',
        status >= 500 ? '沙箱服务暂时不可用，请稍后重试。' : '沙箱操作未能完成，请检查输入后重试。',
      );
  }
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) throw unavailable('沙箱响应为空，请重试。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw unavailable('沙箱响应超过安全上限。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readResponse(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  try {
    return await readBounded(response, maximum);
  } catch (error) {
    if (error instanceof SandboxBackendError) throw error;
    if (signal?.aborted || (error as { name?: string }).name === 'AbortError') {
      throw new SandboxBackendError('aborted', '沙箱操作已取消。');
    }
    throw unavailable();
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw unavailable();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw unavailable();
  return value as number;
}

function parseDescribe(
  value: unknown,
  expectedSessionId: string,
  expectedPodUid: string,
): SandboxDescribeResult {
  const body = record(value);
  const limits = record(body.limits);
  const operations = body.operations;
  const expectedOperations = ['describe', 'read', 'write', 'edit', 'command', 'cancel'];
  if (
    typeof body.protocolVersion !== 'string' ||
    body.sessionId !== expectedSessionId ||
    body.podUid !== expectedPodUid ||
    body.workspace !== '/workspace' ||
    body.commandOutputEncoding !== 'base64' ||
    !Array.isArray(operations) ||
    operations.length !== expectedOperations.length ||
    !operations.every((operation, index) => operation === expectedOperations[index])
  ) {
    throw unavailable();
  }
  return {
    protocolVersion: body.protocolVersion,
    sessionId: expectedSessionId,
    podUid: expectedPodUid,
    workspace: '/workspace',
    commandOutputEncoding: 'base64',
    operations: expectedOperations,
    limits: {
      maxRequestBytes: safeInteger(limits.maxRequestBytes, 1),
      maxReadBytes: safeInteger(limits.maxReadBytes, 1),
      maxFileBytes: safeInteger(limits.maxFileBytes, 1),
      maxOutputBytes: safeInteger(limits.maxOutputBytes, 1),
      maxOutputFrames: safeInteger(limits.maxOutputFrames, 1),
      maxFrameBytes: safeInteger(limits.maxFrameBytes, 1),
      commandTimeoutMs: safeInteger(limits.commandTimeoutMs, 1),
      maxCommandTimeMs: safeInteger(limits.maxCommandTimeMs, 1),
    },
  };
}

function parseRead(value: unknown): SandboxReadResult {
  const body = record(value);
  if (typeof body.content !== 'string' || typeof body.truncated !== 'boolean') throw unavailable();
  const sizeBytes = safeInteger(body.sizeBytes);
  const offset = safeInteger(body.offset);
  const contentBytes = Buffer.byteLength(body.content);
  if (
    offset > sizeBytes ||
    contentBytes > 256 * 1024 ||
    offset + contentBytes > sizeBytes ||
    body.truncated !== offset + contentBytes < sizeBytes
  ) {
    throw unavailable();
  }
  return { content: body.content, sizeBytes, offset, truncated: body.truncated };
}

function parseWrite(value: unknown): SandboxWriteResult {
  const writtenBytes = safeInteger(record(value).writtenBytes);
  if (writtenBytes > 512 * 1024) throw unavailable();
  return { writtenBytes };
}

function parseEdit(value: unknown): SandboxEditResult {
  const replacements = safeInteger(record(value).replacements, 1);
  if (replacements > 512 * 1024) throw unavailable();
  return { replacements };
}

function parseCancelled(value: unknown): boolean {
  const cancelled = record(value).cancelled;
  if (typeof cancelled !== 'boolean') throw unavailable();
  return cancelled;
}

function errorCode(value: unknown): string | undefined {
  try {
    const error = record(record(value).error);
    return typeof error.code === 'string' ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw unavailable('沙箱命令流编码无效。');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw unavailable('沙箱命令流编码无效。');
  return decoded;
}

function isCommandFrame(value: unknown): value is SandboxWireCommandFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  if (typeof frame.type !== 'string' || typeof frame.commandId !== 'string') return false;
  if (frame.type === 'start') return true;
  if (frame.type === 'output') {
    return (
      (frame.stream === 'stdout' || frame.stream === 'stderr') &&
      frame.encoding === 'base64' &&
      typeof frame.data === 'string'
    );
  }
  if (frame.type === 'exit') {
    if (
      !Number.isSafeInteger(frame.exitCode) ||
      (frame.exitCode as number) < -1 ||
      (frame.exitCode as number) > 255
    ) {
      return false;
    }
    if (
      frame.signal !== undefined &&
      (typeof frame.signal !== 'string' || frame.signal.length > 64)
    ) {
      return false;
    }
    if (
      frame.durationMs !== undefined &&
      (!Number.isSafeInteger(frame.durationMs) || (frame.durationMs as number) < 0)
    ) {
      return false;
    }
    for (const field of ['timedOut', 'cancelled', 'truncated'] as const) {
      if (frame[field] !== undefined && typeof frame[field] !== 'boolean') return false;
    }
    return (
      frame.error === undefined ||
      frame.error === 'output_limit_exceeded' ||
      frame.error === 'timeout' ||
      frame.error === 'cancelled'
    );
  }
  if (frame.type === 'error') return typeof frame.error === 'string';
  return false;
}

export class SandboxClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly commandTransportTimeoutMs: number;

  constructor(private readonly options: SandboxClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.commandTransportTimeoutMs =
      options.commandTransportTimeoutMs ?? COMMAND_TRANSPORT_LIMIT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error('sandbox request timeout must be positive');
    }
    if (
      !Number.isSafeInteger(this.commandTransportTimeoutMs) ||
      this.commandTransportTimeoutMs <= 0
    ) {
      throw new Error('sandbox command transport timeout must be positive');
    }
  }

  private async headers(
    operation: SandboxOperation,
    requestId: string,
    body: Uint8Array,
    target?: string,
  ): Promise<Record<string, string>> {
    const token = await this.options.signer.sign({
      sessionId: this.options.sessionId,
      podUid: this.options.podUid,
      operation,
      requestId,
      body,
      ...(target ? { target } : {}),
    });
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
      'X-Sandbox-Session-Id': this.options.sessionId,
      'X-Sandbox-Pod-Uid': this.options.podUid,
    };
  }

  private async post<T>(
    operation: SandboxOperation,
    path: string,
    input: unknown,
    validate: (value: unknown) => T,
    signal?: AbortSignal,
    target?: string,
  ): Promise<T> {
    const body = new TextEncoder().encode(JSON.stringify(input));
    if (body.byteLength > JSON_REQUEST_LIMIT) {
      throw new SandboxBackendError('file_too_large', '沙箱文件或请求超过大小限制。');
    }
    const requestId = randomUUID();
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await settleWithSignal(
        this.fetchImpl(`${this.options.baseUrl}${path}`, {
          method: 'POST',
          headers: await this.headers(operation, requestId, body, target),
          body,
          signal: boundedSignal,
          redirect: 'error',
        }),
        boundedSignal,
        signal,
      );
    } catch (error) {
      if (error instanceof SandboxBackendError) throw error;
      if (signal?.aborted) {
        throw new SandboxBackendError('aborted', '沙箱操作已取消。');
      }
      throw new SandboxBackendError('unavailable', '无法连接沙箱服务，请稍后重试。');
    }
    const bytes = await settleWithSignal(
      readResponse(response, JSON_RESPONSE_LIMIT, signal),
      boundedSignal,
      signal,
    );
    const parsed = parseJson(bytes);
    if (!response.ok) throw toBackendError(errorCode(parsed), response.status);
    return validate(parsed);
  }

  describe(signal?: AbortSignal): Promise<SandboxDescribeResult> {
    return this.post(
      'describe',
      '/v1/describe',
      {},
      (value) => parseDescribe(value, this.options.sessionId, this.options.podUid),
      signal,
    );
  }

  read(input: SandboxReadInput, signal?: AbortSignal): Promise<SandboxReadResult> {
    return this.post('read', '/v1/files/read', input, parseRead, signal);
  }

  write(input: SandboxWriteInput, signal?: AbortSignal): Promise<SandboxWriteResult> {
    return this.post('write', '/v1/files/write', input, parseWrite, signal);
  }

  edit(input: SandboxEditInput, signal?: AbortSignal): Promise<SandboxEditResult> {
    return this.post('edit', '/v1/files/edit', input, parseEdit, signal);
  }

  async cancel(commandId: string, signal?: AbortSignal): Promise<boolean> {
    return this.post(
      'cancel',
      `/v1/commands/${encodeURIComponent(commandId)}/cancel`,
      { commandId },
      parseCancelled,
      signal,
      commandId,
    );
  }

  async command(
    input: { commandId: string; command: string; timeoutMs?: number },
    onFrame: (frame: SandboxCommandFrame) => void,
    signal?: AbortSignal,
  ): Promise<SandboxCommandResult> {
    const body = new TextEncoder().encode(JSON.stringify(input));
    if (body.byteLength > JSON_REQUEST_LIMIT) {
      throw new SandboxBackendError('file_too_large', '沙箱文件或请求超过大小限制。');
    }
    const requestId = randomUUID();
    if (signal?.aborted) {
      throw new SandboxBackendError('aborted', '沙箱命令已取消。');
    }
    const transportController = new AbortController();
    const transportSignal = AbortSignal.any([
      transportController.signal,
      AbortSignal.timeout(this.commandTransportTimeoutMs),
    ]);
    let cancellation: Promise<void> | undefined;
    const recycle = async (): Promise<void> => {
      if (!this.options.onCancelFailure) {
        throw unavailable('无法确认沙箱命令已清理。');
      }
      try {
        await this.options.onCancelFailure(input.commandId);
      } catch {
        throw unavailable('无法确认沙箱命令已清理。');
      }
    };
    const cancelRemotely = (): Promise<void> => {
      cancellation ??= (async () => {
        for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt += 1) {
          try {
            if (await this.cancel(input.commandId, AbortSignal.timeout(2_000))) return;
          } catch {
            await recycle();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, CANCEL_RETRY_DELAY_MS));
        }
        // A command request can be cancelled just before sandboxd registers its
        // ID. If no cancel attempt found it, recycling the exact Pod UID is the
        // only proof that no process can survive into the next Turn.
        await recycle();
      })().finally(() => transportController.abort());
      return cancellation;
    };
    const onAbort = (): void => {
      void cancelRemotely().catch(() => transportController.abort());
    };
    const waitForCancellation = async (): Promise<void> => {
      try {
        await cancelRemotely();
      } catch (error) {
        if (error instanceof SandboxBackendError) throw error;
        throw unavailable('无法确认沙箱命令已清理。');
      }
    };
    const cancelForProtocolFailure = async (): Promise<void> => {
      await waitForCancellation();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;
    try {
      response = await settleWithSignal(
        this.fetchImpl(`${this.options.baseUrl}/v1/commands`, {
          method: 'POST',
          headers: await this.headers('command', requestId, body),
          body,
          signal: transportSignal,
          redirect: 'error',
        }),
        transportSignal,
        signal,
      );
    } catch {
      if (signal?.aborted) {
        await waitForCancellation();
        throw new SandboxBackendError('aborted', '沙箱命令已取消。');
      }
      await cancelForProtocolFailure();
      throw new SandboxBackendError('unavailable', '无法连接沙箱服务，请稍后重试。');
    }

    if (!response.ok) {
      const bytes = await readResponse(response, JSON_RESPONSE_LIMIT, transportSignal);
      const parsed = parseJson(bytes);
      if (signal?.aborted) {
        await waitForCancellation();
        throw new SandboxBackendError('aborted', '沙箱命令已取消。');
      }
      signal?.removeEventListener('abort', onAbort);
      throw toBackendError(errorCode(parsed), response.status);
    }
    if (!response.body) {
      await cancelForProtocolFailure();
      signal?.removeEventListener('abort', onAbort);
      throw unavailable('沙箱命令响应为空。');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffered = '';
    let responseBytes = 0;
    let outputBytes = 0;
    let frameCount = 0;
    let started = false;
    const outputDecoders = {
      stdout: new TextDecoder('utf-8'),
      stderr: new TextDecoder('utf-8'),
    };
    let terminal: Extract<SandboxCommandFrame, { type: 'exit' }> | undefined;
    const emitDecodedOutput = (
      stream: 'stdout' | 'stderr',
      commandId: string,
      bytes?: Uint8Array,
    ): void => {
      const data =
        bytes === undefined
          ? outputDecoders[stream].decode()
          : outputDecoders[stream].decode(bytes, { stream: true });
      if (data) onFrame({ type: 'output', commandId, stream, data });
    };
    const acceptLine = (line: string): void => {
      if (!line) return;
      frameCount += 1;
      if (frameCount > COMMAND_FRAME_COUNT_LIMIT || Buffer.byteLength(line) > NDJSON_FRAME_LIMIT) {
        throw unavailable('沙箱命令帧超过安全上限。');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw unavailable('沙箱命令流格式无效。');
      }
      if (!isCommandFrame(parsed) || parsed.commandId !== input.commandId) {
        throw unavailable('沙箱命令流身份不匹配。');
      }
      if (terminal) throw unavailable('沙箱命令终态后仍有数据。');
      if (parsed.type === 'error') {
        throw unavailable('沙箱命令未能启动，请稍后重试。');
      }
      if (parsed.type === 'start') {
        if (started) throw unavailable('沙箱命令出现重复起始帧。');
        started = true;
      } else if (!started) {
        throw unavailable('沙箱命令流缺少起始帧。');
      }
      if (parsed.type === 'output') {
        const decoded = decodeBase64(parsed.data);
        outputBytes += decoded.byteLength;
        if (outputBytes > COMMAND_OUTPUT_LIMIT) {
          throw unavailable('沙箱命令输出超过安全上限。');
        }
        emitDecodedOutput(parsed.stream, parsed.commandId, decoded);
        return;
      }
      if (parsed.type === 'exit') {
        emitDecodedOutput('stdout', parsed.commandId);
        emitDecodedOutput('stderr', parsed.commandId);
        terminal = parsed;
      }
      onFrame(parsed);
    };

    try {
      for (;;) {
        const { done, value } = await settleWithSignal(reader.read(), transportSignal, signal);
        if (done) break;
        responseBytes += value.byteLength;
        if (responseBytes > NDJSON_RESPONSE_LIMIT) {
          throw unavailable('沙箱命令流超过安全上限。');
        }
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          acceptLine(line);
          newline = buffered.indexOf('\n');
        }
        if (Buffer.byteLength(buffered) > NDJSON_FRAME_LIMIT) {
          throw unavailable('沙箱命令帧超过安全上限。');
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) acceptLine(buffered.trim());
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await cancelForProtocolFailure();
      if (signal?.aborted) {
        await waitForCancellation();
        throw new SandboxBackendError('aborted', '沙箱命令已取消。');
      }
      throw error instanceof SandboxBackendError ? error : unavailable();
    } finally {
      signal?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }

    if (signal?.aborted) {
      await waitForCancellation();
      throw new SandboxBackendError('aborted', '沙箱命令已取消。');
    }
    if (!terminal) {
      await cancelForProtocolFailure();
      throw unavailable('沙箱命令流缺少终态。');
    }
    return {
      commandId: terminal.commandId,
      exitCode: terminal.exitCode,
      ...(terminal.signal ? { signal: terminal.signal } : {}),
      timedOut: terminal.timedOut ?? false,
      cancelled: terminal.cancelled ?? false,
      truncated: terminal.truncated ?? false,
      durationMs: terminal.durationMs ?? 0,
    };
  }
}
