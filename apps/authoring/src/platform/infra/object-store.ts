// ObjectStore 实现（S3/MinIO，实现 shared ObjectStorePort）。
//   - presignPut/presignGet：前端直传，PG 只存 key（原文不落正式盘，技术方案 1.2）。
//   - list/delete/head：Task pipeline 的原文生命周期管理与对象探测。
// 骨架阶段：惰性建 S3Client（forcePathStyle = MinIO 必需），不在 import 期连。
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { Bucket, ObjectStorePort } from '@cb/shared';
import type { Env } from '../config/env.js';

let client: S3Client | undefined;
// 预签名专用客户端（端点 = S3_PUBLIC_ENDPOINT，浏览器可达）；仅用于 getSignedUrl 计算 URL，不发网络请求。
//   与内网操作客户端分离：API/worker 实际 get/put/list 走 minio:9000，浏览器拿到的 presigned URL 走 localhost:9000。
let presignClient: S3Client | undefined;

function getClient(env: Env): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: true, // MinIO 必需（非虚拟主机风格寻址）
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
      maxAttempts: 1, // 骨架阶段不重试（探针/调用连不上时快速失败，不裸挂）
      requestHandler: {
        // 连接/请求超时短，依赖宕机时 /ready 快速判 down。
        requestTimeout: 2_000,
        connectionTimeout: 2_000,
      },
    });
  }
  return client;
}

/**
 * 取预签名客户端（BUG-013）：端点 = S3_PUBLIC_ENDPOINT ?? S3_ENDPOINT。
 *   presigned URL 的 host 取自该客户端 endpoint；浏览器据此直传，故必须是宿主/公网可达地址。
 *   公网端点 == 内网端点（生产真实 S3）时与原行为完全一致，无副作用。
 */
function getPresignClient(env: Env): S3Client {
  const publicEndpoint = env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT;
  // 公网端点与内网相同 → 直接复用操作客户端，不多建一份。
  if (publicEndpoint === env.S3_ENDPOINT) return getClient(env);
  if (!presignClient) {
    presignClient = new S3Client({
      endpoint: publicEndpoint,
      region: env.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
      maxAttempts: 1,
    });
  }
  return presignClient;
}

const DEFAULT_EXPIRES_SEC = 900; // 15min 预签名默认有效期

/**
 * 把对象 Body（流/二进制）读成 utf-8 字符串——【统一正确读法】。所有 S3 对象文本读取走这里，杜绝读法分叉。
 *
 * 为什么不用 web 流 `getReader()`：S3 getObject 的 Body 在 Node 运行时实际是 **Node Readable**
 *   （AWS SDK v3 + Node：底层是 IncomingMessage/Readable，**无** .getReader）；旧实现把它 cast 成 web
 *   ReadableStream 再调 getReader() → `body.getReader is not a function`（P0：fetch_index 必败 → DEPENDENCY_UNAVAILABLE）。
 *
 * 兼容三种真实形态（同一函数，运行时按能力分派——绝不靠不真实的类型断言）：
 *   - Node Readable（生产真值，Node 下 S3 Body）：`for await...of` 逐块读（Readable 是 async-iterable）。
 *   - web ReadableStream（跨运行时/未来兼容）：getReader() 逐块读。
 *   - SdkStream（AWS SDK 经 sdkStreamMixin 注入 transformToString）：直接用 SDK 自带 transform（最稳）。
 *   - 已是 string / Uint8Array：直接归一（便于测试与边界）。
 */
export async function readStreamToString(
  body: unknown,
  encoding: 'utf-8' = 'utf-8',
): Promise<string> {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  // SdkStream：AWS SDK 自带 transformToString（SDK 跨运行时保证，最稳，优先）。
  if (typeof (body as { transformToString?: unknown }).transformToString === 'function') {
    return (body as { transformToString: (enc?: string) => Promise<string> }).transformToString(
      encoding,
    );
  }
  const decoder = new TextDecoder(encoding);
  const toChunk = (v: unknown): Uint8Array =>
    v instanceof Uint8Array
      ? v
      : typeof v === 'string'
        ? new TextEncoder().encode(v)
        : new Uint8Array(v as ArrayBuffer);
  // Node Readable（生产真值）/ 任意 async-iterable：for await...of 逐块读。
  if (
    body instanceof Readable ||
    typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  ) {
    let out = '';
    for await (const chunk of body as AsyncIterable<unknown>) {
      out += decoder.decode(toChunk(chunk), { stream: true });
    }
    out += decoder.decode();
    return out;
  }
  // web ReadableStream（跨运行时/未来兼容）：getReader() 逐块读。
  if (typeof (body as { getReader?: unknown }).getReader === 'function') {
    const reader = (body as ReadableStream<unknown>).getReader();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) out += decoder.decode(toChunk(value), { stream: true });
    }
    out += decoder.decode();
    return out;
  }
  // 已是字节数组等：一次性解码。
  return decoder.decode(toChunk(body));
}

/**
 * 把对象 Body 读成原始字节（gzip 分片用）。形态分派同 readStreamToString，但不解码、保留字节。
 */
export async function readStreamToBytes(body: unknown): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  // SdkStream：AWS SDK 自带 transformToByteArray（最稳，优先）。
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    return (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }
  const toChunk = (v: unknown): Uint8Array =>
    v instanceof Uint8Array
      ? v
      : typeof v === 'string'
        ? new TextEncoder().encode(v)
        : new Uint8Array(v as ArrayBuffer);
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

/** S3/MinIO 实现的 ObjectStorePort。 */
export function createS3ObjectStore(env: Env): ObjectStorePort {
  const s3 = getClient(env);
  // 预签名用「公网可达」客户端（BUG-013：浏览器直传 PUT/GET 的 URL host 必须宿主/公网可达）。
  const presignS3 = getPresignClient(env);
  return {
    async presignPut(bucket, key, opts) {
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
      });
      const url = await getSignedUrl(presignS3, cmd, {
        expiresIn: opts?.expiresSec ?? DEFAULT_EXPIRES_SEC,
      });
      return { url, key };
    },
    async presignGet(bucket, key, opts) {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      const url = await getSignedUrl(presignS3, cmd, {
        expiresIn: opts?.expiresSec ?? DEFAULT_EXPIRES_SEC,
      });
      return { url };
    },
    async getObject(bucket, key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return readStreamToBytes(res.Body);
    },
    async getObjectText(bucket, key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      // res.Body 在 Node 运行时是 SdkStream<IncomingMessage|Readable>（Node Readable + transformToString 混入），
      //   绝非 web ReadableStream——readStreamToString 按真实形态读（优先 SDK transform，否则 Node Readable 读法）。
      return readStreamToString(res.Body);
    },
    async putObject(bucket, key, body, opts) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
        }),
      );
      return { key };
    },
    async list(bucket, prefix) {
      const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
      return (res.Contents ?? []).map((o) => ({
        key: o.Key ?? '',
        size: o.Size ?? 0,
        lastModified: (o.LastModified ?? new Date()).toISOString(),
      }));
    },
    async delete(bucket, key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async head(bucket, key) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          size: res.ContentLength ?? 0,
          lastModified: (res.LastModified ?? new Date()).toISOString(),
        };
      } catch {
        return null;
      }
    },
  };
}

/** ready 探针：HEAD 一个桶（连不上/凭证错 → down）。骨架用 ListObjectsV2 限 1 条做轻探。 */
export async function pingObjectStore(env: Env, bucket: Bucket = 'combo-raw'): Promise<boolean> {
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
  presignClient?.destroy();
  presignClient = undefined;
}
