import { describe, expect, it } from 'vitest';
import {
  ReleaseMetadataSchema,
  releaseMetadataFromEnv,
  type ReleaseMetadata,
  type ReleaseMetadataEnvironment,
} from '../index.js';

const SOURCE_SHA = 'a'.repeat(40);
const RELEASE_MANIFEST_DIGEST = `sha256:${'b'.repeat(64)}`;
const WEB_ASSET_MANIFEST = `sha256:${'c'.repeat(64)}`;

const environment: ReleaseMetadataEnvironment = {
  COMBO_ENVIRONMENT: 'test',
  COMBO_SOURCE_SHA: SOURCE_SHA,
  COMBO_RELEASE_ID: `release-${SOURCE_SHA}`,
  COMBO_BUILT_AT: '2026-07-24T08:00:00.000Z',
  COMBO_RELEASE_MANIFEST_DIGEST: RELEASE_MANIFEST_DIGEST,
  COMBO_WEB_ASSET_MANIFEST: WEB_ASSET_MANIFEST,
};

const metadata: ReleaseMetadata = {
  schemaVersion: 1,
  environment: 'test',
  sourceSha: SOURCE_SHA,
  releaseId: `release-${SOURCE_SHA}`,
  builtAt: '2026-07-24T08:00:00.000Z',
  releaseManifestDigest: RELEASE_MANIFEST_DIGEST,
  webAssetManifest: WEB_ASSET_MANIFEST,
};

describe('release metadata contract', () => {
  it('maps the exact combo-release ConfigMap keys to the public version object', () => {
    expect(releaseMetadataFromEnv(environment)).toEqual(metadata);
  });

  it('rejects extra public fields and a release ID from another source revision', () => {
    expect(() => ReleaseMetadataSchema.parse({ ...metadata, unexpected: true })).toThrow();
    expect(() =>
      ReleaseMetadataSchema.parse({ ...metadata, releaseId: `release-${'d'.repeat(40)}` }),
    ).toThrow(/release-<sourceSha>/);
  });

  it('rejects malformed timestamps, uppercase digests, and non-development placeholders', () => {
    expect(() =>
      ReleaseMetadataSchema.parse({ ...metadata, builtAt: '2026-02-30T08:00:00.000Z' }),
    ).toThrow(/real canonical timestamp/);
    expect(() =>
      ReleaseMetadataSchema.parse({
        ...metadata,
        releaseManifestDigest: `sha256:${'A'.repeat(64)}`,
      }),
    ).toThrow(/lowercase sha256/);
    expect(() =>
      releaseMetadataFromEnv({
        ...environment,
        COMBO_SOURCE_SHA: '0'.repeat(40),
        COMBO_RELEASE_ID: `release-${'0'.repeat(40)}`,
      }),
    ).toThrow(/placeholder sourceSha/);
  });
});
