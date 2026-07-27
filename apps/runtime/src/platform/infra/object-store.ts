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
  putObject(
    bucket: Bucket,
    key: string,
    body: Uint8Array,
    opts?: { contentType?: string; abortSignal?: AbortSignal },
  ): Promise<{ key: string }>;
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

/** S3/MinIO 实现的 RuntimeObjectStore。 */
export function createS3ObjectStore(env: Env): RuntimeObjectStore {
  const s3 = getClient(env);
  return {
    async getObjectText(bucket, key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return new TextDecoder().decode(await readBodyToBytes(res.Body));
    },
    async getObject(bucket, key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return readBodyToBytes(res.Body);
    },
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
