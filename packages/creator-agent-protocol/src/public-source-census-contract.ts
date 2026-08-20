import { z } from 'zod';

export const PUBLIC_SOURCE_AST_CENSUS_PROTOCOL = 'combo.public-source-ast-census/1' as const;

export const PublicSourceAstFamilySchema = z.enum([
  'boundary-helper-call',
  'derived-byte-invariant',
  'dynamic-byte-bound',
  'manual-byte-cap',
  'resource-literal',
  'runtime-byte-cap-exclusion',
  'yaml-alias-cap',
  'zod-length-call',
  'zod-max-call',
  'zod-format-call',
  'zod-regex-call',
  'zod-tuple-call',
]);
export type PublicSourceAstFamily = z.infer<typeof PublicSourceAstFamilySchema>;

export const PUBLIC_SOURCE_AST_PROBE_IDS = Object.freeze([
  'ast-row-classified',
  'runtime-row-linked',
  'manual-cap-linked',
] as const);

export const PublicSourceAstMachineRowSchema = z
  .object({
    id: z.string().min(1),
    file: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    family: PublicSourceAstFamilySchema,
    expression: z.string().min(1),
    disposition: z.enum([
      'derived-invariant',
      'dynamic-bound',
      'explicit-exclusion',
      'helper-delegation',
      'manual-cap',
      'runtime-zod',
    ]),
    ownerIds: z.array(z.string().min(1)).min(1),
    probeIds: z.array(z.enum(PUBLIC_SOURCE_AST_PROBE_IDS)).min(1),
  })
  .strict();
export type PublicSourceAstMachineRow = z.infer<typeof PublicSourceAstMachineRowSchema>;

export const PUBLIC_CORE_SOURCE_FILES = Object.freeze([
  'packages/creator-agent-protocol/src/primitives.ts',
  'packages/creator-agent-protocol/src/artifacts.ts',
  'packages/creator-agent-protocol/src/agent-version.ts',
  'packages/creator-agent-protocol/src/snapshot.ts',
  'packages/creator-agent-protocol/src/broker.ts',
  'packages/creator-agent-protocol/src/invocation.ts',
  'packages/creator-agent-protocol/src/invocation-facts.ts',
  'packages/creator-agent-protocol/src/interrupt-receipt.ts',
  'packages/creator-agent-protocol/src/conversation-ready-facts.ts',
  'packages/creator-agent-protocol/src/consumer-events.ts',
  'packages/creator-agent-protocol/src/http.ts',
  'packages/creator-agent-protocol/src/evidence.ts',
  'packages/creator-agent-protocol/src/registry.ts',
  'packages/creator-agent-protocol/src/sandbox.ts',
  'packages/creator-agent-protocol/src/canonical.ts',
  'apps/runtime/src/platform/http/vnext-json-body.ts',
  'packages/creator-agent-snapshot/src/manifest.ts',
  'packages/creator-agent-snapshot/src/policy.ts',
] as const);

export const PUBLIC_BOUNDARY_HELPER_NAMES = Object.freeze([
  'CanonicalBase64UrlBytesSchema',
  'EvidenceTokenSchema',
  'StrictUnicodeCodePointStringSchema',
  'StrictUtf8TextSchema',
  'UnicodeCodePointStringSchema',
  'Utf8TextSchema',
  'boundedRecordSchema',
  'createSnapshotSignedPutTargetSchema',
  'unicodeCodePointStringSchema',
  'utf8TextSchema',
] as const);

export const PublicSourceManualBindingSchema = z
  .object({
    expression: z.string().min(1),
    disposition: z.enum(['manual-cap', 'runtime-zod', 'explicit-exclusion']),
    ownerId: z.string().min(1),
    offset: z.number().int(),
  })
  .strict();
export type PublicSourceManualBinding = z.infer<typeof PublicSourceManualBindingSchema>;

export const PUBLIC_SOURCE_MANUAL_BINDINGS: readonly PublicSourceManualBinding[] = Object.freeze([
  {
    expression: 'BROKER_MAX_FRAME_BYTES',
    disposition: 'manual-cap',
    ownerId: 'broker-frame-bytes',
    offset: 0,
  },
  {
    expression: 'EVIDENCE_MAX_STRUCTURED_JSON_BYTES',
    disposition: 'manual-cap',
    ownerId: 'evidence-structured-json-bytes',
    offset: 0,
  },
  {
    expression: 'SNAPSHOT_MANIFEST_MAX_BYTES',
    disposition: 'manual-cap',
    ownerId: 'snapshot-manifest-canonical-bytes',
    offset: 0,
  },
  {
    expression: 'SNAPSHOT_MAX_MANIFEST_BYTES',
    disposition: 'manual-cap',
    ownerId: 'snapshot-manifest-raw-defense-bytes',
    offset: 0,
  },
  {
    expression: 'SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES',
    disposition: 'manual-cap',
    ownerId: 'snapshot-manifest-raw-defense-bytes',
    offset: 0,
  },
  {
    expression: 'SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES',
    disposition: 'manual-cap',
    ownerId: 'snapshot-manifest-canonical-bytes',
    offset: 0,
  },
  {
    expression: 'SNAPSHOT_MAX_PUBLICATION_PREPARATION_MARKER_BYTES',
    disposition: 'manual-cap',
    ownerId: 'snapshot-publication-preparation-canonical-bytes',
    offset: 0,
  },
  {
    expression: 'SNAPSHOT_EXACT_PUBLICATION_COMMIT_MARKER_BYTES',
    disposition: 'manual-cap',
    ownerId: 'snapshot-publication-commit-canonical-bytes',
    offset: 0,
  },
  {
    expression: 'VNEXT_REGISTRY_YAML_LIBRARY_MAX_ALIAS_COUNT',
    disposition: 'manual-cap',
    ownerId: 'registry-yaml-alias-expansions',
    offset: 1,
  },
  {
    expression: 'RUNTIME_HTTP_BODY_LIMIT_BYTES',
    disposition: 'explicit-exclusion',
    ownerId: 'runtime-http-inherited-body-limit-not-vnext-product-policy',
    offset: 0,
  },
  {
    expression: 'ALPHA_SNAPSHOT_POLICY.maxMediaTypeBytes',
    disposition: 'runtime-zod',
    ownerId: 'source:SnapshotManifest:/files/items/mediaType:string-max-0',
    offset: 0,
  },
  {
    expression: 'SNAPSHOT_MAX_PATH_BYTES',
    disposition: 'runtime-zod',
    ownerId: 'source:SnapshotManifest:/files/items/path:string-max-1',
    offset: 0,
  },
]);

export const PUBLIC_SOURCE_AST_CENSUS_DIGEST =
  'sha256:bf548bf61d2d5af094acfe447683abe27fd9601aa5a77c0e32437bd7accbc2a7' as const;

export const PUBLIC_SOURCE_AST_CENSUS_ROW_COUNT = 233 as const;

export const PUBLIC_SOURCE_AST_CENSUS_FAMILY_COUNTS = Object.freeze({
  'boundary-helper-call': 77,
  'derived-byte-invariant': 9,
  'dynamic-byte-bound': 10,
  'manual-byte-cap': 10,
  'resource-literal': 12,
  'runtime-byte-cap-exclusion': 1,
  'yaml-alias-cap': 1,
  'zod-format-call': 4,
  'zod-length-call': 6,
  'zod-max-call': 50,
  'zod-regex-call': 47,
  'zod-tuple-call': 6,
} as const satisfies Record<PublicSourceAstFamily, number>);

export const PUBLIC_SOURCE_AST_CENSUS_EXCLUSIONS = Object.freeze([
  'runtime-http-body-limit-remains-explicit-non-product-policy',
  'derived-byte-equalities-are-invariants-not-independent-product-caps',
] as const);
