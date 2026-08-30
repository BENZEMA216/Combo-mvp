// ObjectStore（S3/MinIO）。runtime 只用三个动作：读能力定义文本、写产物、读产物文本；
//   RuntimeObjectStore 即 shared ObjectStorePort 的这三方法子集（不实现 presign/list 等无关面）。
//   惰性建 S3Client（forcePathStyle = MinIO 必需），不在 import 期连。
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import type { Bucket } from '@cb/shared';
import type { Env } from '../config/env.js';

/** Runtime 消费的对象存储最小面；写入额外支持 AbortSignal。 */
export interface RuntimeObjectStore {
  getObjectText(bucket: Bucket, key: string): Promise<string>;
  getObject(bucket: Bucket, key: string): Promise<Uint8Array>;
  getObjectBounded(
    bucket: Bucket,
    key: string,
    maxBytes: number,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<Uint8Array>;
  putObject(
    bucket: Bucket,
    key: string,
    body: Uint8Array,
    opts?: { contentType?: string; abortSignal?: AbortSignal },
  ): Promise<{ key: string }>;
}

export type BoundedObjectReadFailure =
  | 'invalid_limit'
  | 'too_large'
  | 'aborted'
  | 'invalid_response'
  | 'unavailable';

const BOUNDED_OBJECT_ERROR_MESSAGES: Readonly<Record<BoundedObjectReadFailure, string>> = {
  invalid_limit: 'bounded object byte limit is invalid',
  too_large: 'bounded object exceeds the byte limit',
  aborted: 'bounded object read was aborted',
  invalid_response: 'bounded object storage returned an invalid response',
  unavailable: 'bounded object storage is unavailable',
};

/** Stable and redacted failure surface for untrusted Package bytes. */
export class BoundedObjectReadError extends Error {
  constructor(readonly failure: BoundedObjectReadFailure) {
    super(BOUNDED_OBJECT_ERROR_MESSAGES[failure]);
    this.name = 'BoundedObjectReadError';
  }
}

export interface RuntimeObjectCommandSender {
  send(command: GetObjectCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

let client: S3Client | undefined;

function getClient(env: Env): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: true, // MinIO 必需（非虚拟主机风格寻址）
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
      maxAttempts: 1, // 不重试：探针/调用连不上时快速失败，不裸挂
      requestHandler: { requestTimeout: 2_000, connectionTimeout: 2_000 },
    });
  }
  return client;
}

const toChunk = (v: unknown): Uint8Array =>
  v instanceof Uint8Array
    ? v
    : typeof v === 'string'
      ? new TextEncoder().encode(v)
      : new Uint8Array(v as ArrayBuffer);

/**
 * 把 S3 Body 读成原始字节。Node 运行时 Body 是 SdkStream<Readable>（非 web ReadableStream）：
 * 优先 SDK 自带 transformToByteArray，否则按 Node Readable/web 流的真实形态分派读取。
 */
async function readBodyToBytes(body: unknown): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    return (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }
  const chunks: Uint8Array[] = [];
  if (
    body instanceof Readable ||
    typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  ) {
    for await (const chunk of body as AsyncIterable<unknown>) chunks.push(toChunk(chunk));
  } else if (typeof (body as { getReader?: unknown }).getReader === 'function') {
    const reader = (body as ReadableStream<unknown>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) chunks.push(toChunk(value));
    }
  } else {
    chunks.push(toChunk(body));
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BoundedObjectReadError('aborted');
}

function isAbortFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function ignoreRejectedCleanup(result: unknown): void {
  if (typeof (result as { catch?: unknown } | null)?.catch === 'function') {
    void (result as Promise<unknown>).catch(() => undefined);
  }
}

function cancelUnreadBody(body: unknown): void {
  try {
    const destroy = (body as { destroy?: unknown } | null)?.destroy;
    if (typeof destroy === 'function') destroy.call(body);
  } catch {
    // Cleanup must not replace the stable failure category.
  }
  try {
    const cancel = (body as { cancel?: unknown } | null)?.cancel;
    if (typeof cancel === 'function') ignoreRejectedCleanup(cancel.call(body));
  } catch {
    // Cleanup must not replace the stable failure category.
  }
}

function cancelAsyncBody(body: unknown, iterator: AsyncIterator<unknown>): void {
  cancelUnreadBody(body);
  try {
    if (typeof iterator.return === 'function') ignoreRejectedCleanup(iterator.return());
  } catch {
    // Cleanup must not replace the stable failure category.
  }
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new BoundedObjectReadError('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function normalizeBodyChunk(value: unknown, maxBytes: number): Uint8Array | null {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      throw new BoundedObjectReadError('too_large');
    }
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const GET_TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get as ((this: Uint8Array) => number) | undefined;
const GET_TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteOffset',
)?.get as ((this: Uint8Array) => number) | undefined;
const GET_TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer')
  ?.get as ((this: Uint8Array) => ArrayBufferLike) | undefined;

/** Copy exact backing bytes without invoking a caller-controlled iterator. */
function snapshotBoundedBytes(input: unknown, maxBytes: number): Uint8Array {
  try {
    if (!GET_TYPED_ARRAY_BYTE_LENGTH || !GET_TYPED_ARRAY_BYTE_OFFSET || !GET_TYPED_ARRAY_BUFFER) {
      throw new BoundedObjectReadError('invalid_response');
    }
    const bytes = input as Uint8Array;
    const byteLength = GET_TYPED_ARRAY_BYTE_LENGTH.call(bytes);
    if (byteLength > maxBytes) throw new BoundedObjectReadError('too_large');
    const byteOffset = GET_TYPED_ARRAY_BYTE_OFFSET.call(bytes);
    const buffer = GET_TYPED_ARRAY_BUFFER.call(bytes);
    const source = new Uint8Array(buffer, byteOffset, byteLength);
    const snapshot = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) snapshot[index] = source[index] as number;
    if (GET_TYPED_ARRAY_BYTE_LENGTH.call(snapshot) !== byteLength) {
      throw new BoundedObjectReadError('invalid_response');
    }
    return snapshot;
  } catch (error) {
    if (error instanceof BoundedObjectReadError) throw error;
    throw new BoundedObjectReadError('invalid_response');
  }
}

function concatenateChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readAsyncBodyBounded(
  body: AsyncIterable<unknown>,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const step = await awaitWithAbort(Promise.resolve(iterator.next()), signal);
      if (step.done) {
        complete = true;
        break;
      }
      throwIfAborted(signal);
      const chunk = normalizeBodyChunk(step.value, maxBytes - total);
      if (!chunk) throw new BoundedObjectReadError('invalid_response');
      const snapshot = snapshotBoundedBytes(chunk, maxBytes - total);
      if (snapshot.byteLength === 0) throw new BoundedObjectReadError('invalid_response');
      chunks.push(snapshot);
      total += snapshot.byteLength;
    }
  } finally {
    if (!complete) cancelAsyncBody(body, iterator);
  }
  return concatenateChunks(chunks, total);
}

async function readWebBodyBounded(
  body: ReadableStream<unknown>,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const step = await awaitWithAbort(reader.read(), signal);
      if (step.done) {
        complete = true;
        break;
      }
      throwIfAborted(signal);
      const chunk = normalizeBodyChunk(step.value, maxBytes - total);
      if (!chunk) throw new BoundedObjectReadError('invalid_response');
      const snapshot = snapshotBoundedBytes(chunk, maxBytes - total);
      if (snapshot.byteLength === 0) throw new BoundedObjectReadError('invalid_response');
      chunks.push(snapshot);
      total += snapshot.byteLength;
    }
  } finally {
    if (!complete) {
      try {
        ignoreRejectedCleanup(reader.cancel());
      } catch {
        // Cleanup must not replace the stable failure category.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Cleanup must not replace the stable failure category.
    }
  }
  return concatenateChunks(chunks, total);
}

async function readBodyBounded(
  body: unknown,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (signal?.aborted) {
    cancelUnreadBody(body);
    throw new BoundedObjectReadError('aborted');
  }
  const direct = normalizeBodyChunk(body, maxBytes);
  if (direct) return snapshotBoundedBytes(direct, maxBytes);
  if (
    typeof (body as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] ===
    'function'
  ) {
    return readAsyncBodyBounded(body as AsyncIterable<unknown>, maxBytes, signal);
  }
  if (typeof (body as { getReader?: unknown } | null)?.getReader === 'function') {
    return readWebBodyBounded(body as ReadableStream<unknown>, maxBytes, signal);
  }
  throw new BoundedObjectReadError('invalid_response');
}

/** Builds the fail-closed bounded GET primitive independently from the production S3 client. */
export function createBoundedObjectReader(sender: RuntimeObjectCommandSender) {
  return async function read(
    bucket: Bucket,
    key: string,
    maxBytes: number,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new BoundedObjectReadError('invalid_limit');
    }
    const signal = opts?.abortSignal;
    throwIfAborted(signal);
    try {
      const rawResponse = await sender.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        signal ? { abortSignal: signal } : undefined,
      );
      if (typeof rawResponse !== 'object' || rawResponse === null) {
        throw new BoundedObjectReadError('invalid_response');
      }
      const response = rawResponse as { Body?: unknown; ContentLength?: unknown };
      const body = response.Body;
      const declaredLength = response.ContentLength;
      if (
        declaredLength !== undefined &&
        (!Number.isSafeInteger(declaredLength) || (declaredLength as number) < 0)
      ) {
        cancelUnreadBody(body);
        throw new BoundedObjectReadError('invalid_response');
      }
      if (typeof declaredLength === 'number' && declaredLength > maxBytes) {
        cancelUnreadBody(body);
        throw new BoundedObjectReadError('too_large');
      }
      if (body == null) {
        if (declaredLength === 0) return new Uint8Array();
        throw new BoundedObjectReadError('invalid_response');
      }
      const bytes = await readBodyBounded(body, maxBytes, signal);
      if (typeof declaredLength === 'number' && declaredLength !== bytes.byteLength) {
        throw new BoundedObjectReadError('invalid_response');
      }
      return bytes;
    } catch (error) {
      if (error instanceof BoundedObjectReadError) throw error;
      if (isAbortFailure(error, signal)) throw new BoundedObjectReadError('aborted');
      throw new BoundedObjectReadError('unavailable');
    }
  };
}

/** S3/MinIO 实现的 RuntimeObjectStore。 */
export function createS3ObjectStore(env: Env): RuntimeObjectStore {
  const s3 = getClient(env);
  const getObjectBounded = createBoundedObjectReader({
    send(command, options) {
      return s3.send(command, options);
    },
  });
  return {
    async getObjectText(bucket, key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return new TextDecoder().decode(await readBodyToBytes(res.Body));
    },
    async getObject(bucket, key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return readBodyToBytes(res.Body);
    },
    getObjectBounded,
    async putObject(bucket, key, body, opts) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
        }),
        opts?.abortSignal ? { abortSignal: opts.abortSignal } : undefined,
      );
      return { key };
    },
  };
}

/** ready 探针：ListObjectsV2 限 1 条轻探（连不上/凭证错 → down）。 */
export async function pingObjectStore(
  env: Env,
  bucket: Bucket = 'combo-artifacts',
): Promise<boolean> {
  try {
    await getClient(env).send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    return true;
  } catch {
    return false;
  }
}

/** 优雅关闭。 */
export function closeObjectStore(): void {
  client?.destroy();
  client = undefined;
}
