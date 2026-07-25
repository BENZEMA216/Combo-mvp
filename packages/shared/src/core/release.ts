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
