// B-05 · ObjectStore 端口（70 §8.2）。MinIO/S3 四桶。domain 声明，infra/s3 实现。
import type { IsoDateTime } from '../core/ids.js';

/** 四桶（70 §8.2）。原文不落正式盘——导入处理完即弃（技术方案 1.2）。 */
export type Bucket = 'combo-raw' | 'combo-artifacts' | 'combo-exports' | 'combo-experience';

export const BUCKETS: readonly Bucket[] = [
  'combo-raw',
  'combo-artifacts',
  'combo-exports',
  'combo-experience',
];

export interface ObjectStorePort {
  /** 预签名直传（PG 只存 key，前端直传 S3）。 */
  presignPut(
    bucket: Bucket,
    key: string,
    opts?: { contentType?: string; expiresSec?: number },
  ): Promise<{ url: string; key: string }>;
  presignGet(bucket: Bucket, key: string, opts?: { expiresSec?: number }): Promise<{ url: string }>;
  /**
   * worker 拉原文文本（导入 B-19）。
   *   返回 utf-8 解码后的字符串（原文 JSONL 文本），不暴露底层流类型——
   *   消费方拿到的就是真值（string），不再有「声明 web ReadableStream、实际 Node Readable」的类型谎言。
   *   实现内部用 SDK/Node 流的正确读法（绝不用 web 流 getReader()，Node Readable 没有），见 infra/object-store.ts。
   */
  getObjectText(bucket: Bucket, key: string): Promise<string>;
  /**
   * worker 拉原文【字节】（打包 gzip 分片用，B-21）。返回原始字节，调用方自行 gunzip/解码。
   *   gzip 后的分片是二进制，不能走 getObjectText（utf-8 解码会损坏）；故单列字节读法。
   */
  getObject(bucket: Bucket, key: string): Promise<Uint8Array>;
  /**
   * 直写对象（本机助手 multipart 直传落加密临时桶，B-21 §3.3）。
   * 助手把原文经 api 转存到 combo-raw 桶（前端直传走 presignPut；助手没有预签名 URL，经 api 中转写桶）。
   */
  putObject(
    bucket: Bucket,
    key: string,
    body: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<{ key: string }>;
  /** Task pipeline 的对象生命周期管理：按前缀列举并按键删除。 */
  list(
    bucket: Bucket,
    prefix: string,
  ): Promise<Array<{ key: string; size: number; lastModified: IsoDateTime }>>;
  delete(bucket: Bucket, key: string): Promise<void>;
  head(bucket: Bucket, key: string): Promise<{ size: number; lastModified: IsoDateTime } | null>;
}

/** ObjectStore env 名（70 §8.2）。 */
export const OBJECT_STORE_ENV = {
  endpoint: 'S3_ENDPOINT',
  accessKey: 'S3_ACCESS_KEY',
  secretKey: 'S3_SECRET_KEY',
  region: 'S3_REGION',
} as const;
