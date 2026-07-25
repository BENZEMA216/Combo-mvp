import { z } from 'zod';

export const RELEASE_METADATA_SCHEMA_VERSION = 1 as const;

export const RELEASE_METADATA_ENV_KEYS = [
  'COMBO_ENVIRONMENT',
  'COMBO_SOURCE_SHA',
  'COMBO_RELEASE_ID',
  'COMBO_BUILT_AT',
  'COMBO_RELEASE_MANIFEST_DIGEST',
  'COMBO_WEB_ASSET_MANIFEST',
] as const;

export type ReleaseMetadataEnvKey = (typeof RELEASE_METADATA_ENV_KEYS)[number];
export type ReleaseMetadataEnvironment = Partial<Record<ReleaseMetadataEnvKey, unknown>>;

const ZERO_SOURCE_SHA = '0'.repeat(40);
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export const DEVELOPMENT_RELEASE_METADATA_ENV = Object.freeze({
  COMBO_ENVIRONMENT: 'development',
  COMBO_SOURCE_SHA: ZERO_SOURCE_SHA,
  COMBO_RELEASE_ID: `release-${ZERO_SOURCE_SHA}`,
  COMBO_BUILT_AT: '1970-01-01T00:00:00.000Z',
  COMBO_RELEASE_MANIFEST_DIGEST: ZERO_DIGEST,
  COMBO_WEB_ASSET_MANIFEST: ZERO_DIGEST,
});

const CanonicalTimestampSchema = z
  .string()
  .regex(UTC_TIMESTAMP_PATTERN, 'builtAt must be a canonical UTC timestamp with milliseconds')
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  }, 'builtAt must be a real canonical timestamp');

export const ReleaseMetadataSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_METADATA_SCHEMA_VERSION),
    environment: z.enum(['development', 'test', 'preview', 'production']),
    sourceSha: z
      .string()
      .regex(SOURCE_SHA_PATTERN, 'sourceSha must be a complete lowercase commit SHA'),
    releaseId: z.string(),
    builtAt: CanonicalTimestampSchema,
    releaseManifestDigest: z
      .string()
      .regex(DIGEST_PATTERN, 'releaseManifestDigest must be a lowercase sha256 digest'),
    webAssetManifest: z
      .string()
      .regex(DIGEST_PATTERN, 'webAssetManifest must be a lowercase sha256 digest'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.releaseId !== `release-${value.sourceSha}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['releaseId'],
        message: 'releaseId must be the deterministic release-<sourceSha> identity',
      });
    }
    if (value.environment === 'development') return;
    if (value.sourceSha === ZERO_SOURCE_SHA) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceSha'],
        message: 'non-development release metadata must not use the placeholder sourceSha',
      });
    }
    for (const field of ['releaseManifestDigest', 'webAssetManifest'] as const) {
      if (value[field] === ZERO_DIGEST) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `non-development release metadata must not use the placeholder ${field}`,
        });
      }
    }
  });

export type ReleaseMetadata = z.infer<typeof ReleaseMetadataSchema>;

export function releaseMetadataFromEnv(environment: ReleaseMetadataEnvironment): ReleaseMetadata {
  return ReleaseMetadataSchema.parse({
    schemaVersion: RELEASE_METADATA_SCHEMA_VERSION,
    environment: environment.COMBO_ENVIRONMENT,
    sourceSha: environment.COMBO_SOURCE_SHA,
    releaseId: environment.COMBO_RELEASE_ID,
    builtAt: environment.COMBO_BUILT_AT,
    releaseManifestDigest: environment.COMBO_RELEASE_MANIFEST_DIGEST,
    webAssetManifest: environment.COMBO_WEB_ASSET_MANIFEST,
  });
}

export interface ReleaseMetadataFetchInit {
  cache: 'no-store';
  credentials: 'same-origin';
  headers: Readonly<Record<string, string>>;
}

export interface ReleaseMetadataFetchResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

export type ReleaseMetadataFetch = (
  url: string,
  init: ReleaseMetadataFetchInit,
) => Promise<ReleaseMetadataFetchResponse>;

export type ReleaseMetadataLoadFailure = 'unavailable' | 'http' | 'invalid';

/**
 * 对外只暴露稳定的失败分类，不把响应正文、解析细节或部署内部信息带进界面。
 */
export class ReleaseMetadataLoadError extends Error {
  readonly failure: ReleaseMetadataLoadFailure;

  constructor(failure: ReleaseMetadataLoadFailure) {
    super('Release metadata is unavailable or invalid');
    this.name = 'ReleaseMetadataLoadError';
    this.failure = failure;
  }
}

function runtimeFetch(): ReleaseMetadataFetch {
  const candidate = (globalThis as { fetch?: ReleaseMetadataFetch }).fetch;
  if (!candidate) throw new ReleaseMetadataLoadError('unavailable');
  return candidate;
}

/**
 * 从 Web 容器在运行时生成的 JSON 读取发布身份。
 *
 * 该函数刻意不接受构建期环境变量作为退路；调用端只能在明确的本地开发模式下选择
 * DEVELOPMENT_RELEASE_METADATA_ENV。Test、Preview 和 Production 必须拿到完整且通过 schema
 * 校验的运行时身份。
 */
export async function loadReleaseMetadata(
  url = '/runtime-config.json',
  fetchMetadata: ReleaseMetadataFetch = runtimeFetch(),
): Promise<ReleaseMetadata> {
  let response: ReleaseMetadataFetchResponse;
  try {
    response = await fetchMetadata(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch (cause) {
    if (cause instanceof ReleaseMetadataLoadError) throw cause;
    throw new ReleaseMetadataLoadError('unavailable');
  }

  if (!response.ok) throw new ReleaseMetadataLoadError('http');

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ReleaseMetadataLoadError('invalid');
  }

  const parsed = ReleaseMetadataSchema.safeParse(payload);
  if (!parsed.success) throw new ReleaseMetadataLoadError('invalid');
  return parsed.data;
}
