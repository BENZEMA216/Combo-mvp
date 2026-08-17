import { z } from 'zod';

import { RequiredUnicodeScalarNoControlStringSchema, Sha256DigestSchema } from './primitives.js';

export const PROTOCOL_UTF8_BOUNDARY_CORPUS = 'combo.protocol-utf8-boundaries/1' as const;

const CheckedArtifactSchema = z.enum(['contract-schemas', 'broker-contract', 'openapi']);

const Utf8ArtifactPointerSchema = z
  .object({
    artifact: CheckedArtifactSchema,
    pointer: RequiredUnicodeScalarNoControlStringSchema.min(1)
      .max(2_048)
      .regex(/^\/(?:[^~]|~[01])*$/u),
  })
  .strict();

const Utf8BoundarySchema = z
  .object({
    maxBytes: z.number().int().positive(),
    generators: z.tuple([z.literal('ascii'), z.literal('cjk'), z.literal('emoji')]),
    artifactPointers: z.array(Utf8ArtifactPointerSchema).min(1),
  })
  .strict();

const Utf8OwnerBoundarySchema = z
  .object({
    id: z.literal('snapshot-manifest-path'),
    maxBytes: z.literal(512),
    runtimeParser: z.literal('SnapshotManifestSchema'),
    fixturePath: z.literal('snapshot-manifest.v1.json'),
    fixtureDigest: Sha256DigestSchema,
    instancePointer: z.literal('/files/0/path'),
    artifactPointer: z.literal(
      '/schemas/SnapshotManifest/definitions/SnapshotManifest/properties/files/items/properties/path',
    ),
    generators: z.tuple([z.literal('ascii'), z.literal('cjk'), z.literal('emoji')]),
  })
  .strict();

const ScalarControlProbeSchema = z
  .object({
    id: z.string().min(1).max(64),
    codeUnits: z.array(z.number().int().min(0).max(0xffff)).min(1).max(2),
    expected: z.enum(['accepted', 'rejected']),
  })
  .strict();

const ScalarControlRuntimeOwnerSchema = z
  .object({
    id: z.string().min(1).max(96),
    source: z.string().min(1).max(160),
    runtimeParser: z.string().min(1).max(96),
    instancePointer: z.string().regex(/^(?:|\/(?:[^~]|~[01])*)$/u),
    maxBytes: z.number().int().positive(),
  })
  .strict();

const StrictStructuralProbeSchema = z
  .object({
    id: z.string().min(1).max(64),
    codeUnits: z.array(z.number().int().min(0).max(0xffff)).min(1).max(2),
    expected: z.enum(['accepted', 'rejected']),
  })
  .strict();

/**
 * Independent, digest-bound evidence inventory for the UTF-8-byte subset of SCH-004.
 * It deliberately does not claim array, decoded-byte, whole-wire, or canonical-byte coverage.
 */
export const ProtocolUtf8BoundaryCorpusSchema = z
  .object({
    protocol: z.literal(PROTOCOL_UTF8_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('utf8-byte-limits-only'),
    checkedArtifactDigests: z
      .object({
        contractSchemas: Sha256DigestSchema,
        brokerContract: Sha256DigestSchema,
        openApi: Sha256DigestSchema,
      })
      .strict(),
    scalarControlParity: z
      .object({
        canaryPrefix: z.literal('UTF8_SCALAR_CONTROL_CANARY_'),
        portablePatternSource: z.literal(
          '^(?:[\\u0009\\u000A\\u000D]|[^\\u0000-\\u001F\\u007F-\\u009F\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$',
        ),
        runtimeOwners: z.tuple([
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('behavior-role'),
            source: z.literal('src/agent-version.ts:BehaviorContractSchema.role'),
            runtimeParser: z.literal('BehaviorContractSchema'),
            instancePointer: z.literal('/role'),
            maxBytes: z.literal(512),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('behavior-objective'),
            source: z.literal('src/agent-version.ts:BehaviorContractSchema.objective'),
            runtimeParser: z.literal('BehaviorContractSchema'),
            instancePointer: z.literal('/objective'),
            maxBytes: z.literal(2_048),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('behavior-developer-instruction'),
            source: z.literal(
              'src/agent-version.ts:BehaviorContractSchema.developerInstructions.items',
            ),
            runtimeParser: z.literal('BehaviorContractSchema'),
            instancePointer: z.literal('/developerInstructions/0'),
            maxBytes: z.literal(2_048),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('runtime-resolved-model'),
            source: z.literal('src/agent-version.ts:RuntimePolicySchema.resolvedModel'),
            runtimeParser: z.literal('RuntimePolicySchema'),
            instancePointer: z.literal('/resolvedModel'),
            maxBytes: z.literal(128),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('model-policy-model'),
            source: z.literal('src/agent-version.ts:ModelPolicySchema.model'),
            runtimeParser: z.literal('ModelPolicySchema'),
            instancePointer: z.literal('/model'),
            maxBytes: z.literal(128),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('codex-runtime-version'),
            source: z.literal(
              'src/agent-version.ts:AgentVersionManifestSchema.codexRuntime.version',
            ),
            runtimeParser: z.literal('AgentVersionManifestSchema'),
            instancePointer: z.literal('/codexRuntime/version'),
            maxBytes: z.literal(128),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('sandbox-spec-adapter-version'),
            source: z.literal('src/sandbox.ts:SandboxSpecSchema.adapterVersion'),
            runtimeParser: z.literal('SandboxSpecSchema'),
            instancePointer: z.literal('/adapterVersion'),
            maxBytes: z.literal(128),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('sandbox-attestation-adapter-version'),
            source: z.literal('src/sandbox.ts:SandboxAttestationUnsignedSchema.adapterVersion'),
            runtimeParser: z.literal('SandboxAttestationUnsignedSchema'),
            instancePointer: z.literal('/adapterVersion'),
            maxBytes: z.literal(128),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('sandbox-attestation-codex-version'),
            source: z.literal('src/sandbox.ts:SandboxAttestationUnsignedSchema.codexVersion'),
            runtimeParser: z.literal('SandboxAttestationUnsignedSchema'),
            instancePointer: z.literal('/codexVersion'),
            maxBytes: z.literal(128),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('create-agent-name'),
            source: z.literal('src/http.ts:CreateAgentRequestSchema.name'),
            runtimeParser: z.literal('CreateAgentRequestSchema'),
            instancePointer: z.literal('/name'),
            maxBytes: z.literal(120),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('create-agent-description'),
            source: z.literal('src/http.ts:CreateAgentRequestSchema.description'),
            runtimeParser: z.literal('CreateAgentRequestSchema'),
            instancePointer: z.literal('/description'),
            maxBytes: z.literal(1_024),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('agent-view-name'),
            source: z.literal('src/http.ts:AgentViewSchema.name'),
            runtimeParser: z.literal('AgentViewSchema'),
            instancePointer: z.literal('/name'),
            maxBytes: z.literal(120),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('agent-view-description'),
            source: z.literal('src/http.ts:AgentViewSchema.description'),
            runtimeParser: z.literal('AgentViewSchema'),
            instancePointer: z.literal('/description'),
            maxBytes: z.literal(1_024),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('send-conversation-message-text'),
            source: z.literal('src/http.ts:SendConversationMessageRequestSchema.text'),
            runtimeParser: z.literal('SendConversationMessageRequestSchema'),
            instancePointer: z.literal('/text'),
            maxBytes: z.literal(16_384),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('consumer-message-text'),
            source: z.literal('src/http.ts:ConsumerMessageSchema.text'),
            runtimeParser: z.literal('ConsumerMessageSchema'),
            instancePointer: z.literal('/text'),
            maxBytes: z.literal(32_768),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('consumer-delta-text'),
            source: z.literal('src/http.ts:ConsumerEventSchema.invocation.delta.text'),
            runtimeParser: z.literal('ConsumerEventSchema'),
            instancePointer: z.literal('/text'),
            maxBytes: z.literal(8_192),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('broker-handshake-worker-version'),
            source: z.literal('src/broker.ts:BrokerHandshakeUnsignedSchema.workerVersion'),
            runtimeParser: z.literal('BrokerHandshakeUnsignedSchema'),
            instancePointer: z.literal('/workerVersion'),
            maxBytes: z.literal(128),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('execution-capability-model'),
            source: z.literal('src/broker.ts:ExecutionCapabilityUnsignedSchema.model'),
            runtimeParser: z.literal('ExecutionCapabilityUnsignedSchema'),
            instancePointer: z.literal('/model'),
            maxBytes: z.literal(128),
          }),
          ScalarControlRuntimeOwnerSchema.extend({
            id: z.literal('version-rejected-error-code'),
            source: z.literal('src/broker.ts:BrokerEventSchema.version.rejected.errorCode'),
            runtimeParser: z.literal('BrokerEventSchema'),
            instancePointer: z.literal('/body/errorCode'),
            maxBytes: z.literal(128),
          }),
        ]),
        artifactCoverage: z
          .object({
            excludedPointers: z.tuple([
              z
                .object({
                  artifact: z.literal('contract-schemas'),
                  pointer: z.literal(
                    '/schemas/SnapshotManifest/definitions/SnapshotManifest/properties/files/items/properties/path',
                  ),
                  reason: z.literal('SnapshotPathSchema-has-independent-strict-pattern'),
                })
                .strict(),
            ]),
            expectedCounts: z
              .object({
                contractSchemas: z.literal(30),
                brokerContract: z.literal(3),
                openApi: z.literal(14),
                total: z.literal(47),
              })
              .strict(),
          })
          .strict(),
        probes: z.tuple([
          ScalarControlProbeSchema.extend({
            id: z.literal('tab'),
            codeUnits: z.tuple([z.literal(0x09)]),
            expected: z.literal('accepted'),
          }),
          ScalarControlProbeSchema.extend({
            id: z.literal('lf'),
            codeUnits: z.tuple([z.literal(0x0a)]),
            expected: z.literal('accepted'),
          }),
          ScalarControlProbeSchema.extend({
            id: z.literal('cr'),
            codeUnits: z.tuple([z.literal(0x0d)]),
            expected: z.literal('accepted'),
          }),
          ScalarControlProbeSchema.extend({
            id: z.literal('astral'),
            codeUnits: z.tuple([z.literal(0xd83d), z.literal(0xde00)]),
            expected: z.literal('accepted'),
          }),
          ScalarControlProbeSchema.extend({
            id: z.literal('high-surrogate'),
            codeUnits: z.tuple([z.literal(0xd800)]),
            expected: z.literal('rejected'),
          }),
          ScalarControlProbeSchema.extend({
            id: z.literal('low-surrogate'),
            codeUnits: z.tuple([z.literal(0xdc00)]),
            expected: z.literal('rejected'),
          }),
          ScalarControlProbeSchema.extend({
            id: z.literal('nul'),
            codeUnits: z.tuple([z.literal(0x00)]),
            expected: z.literal('rejected'),
          }),
          ScalarControlProbeSchema.extend({
            id: z.literal('other-c0'),
            codeUnits: z.tuple([z.literal(0x1f)]),
            expected: z.literal('rejected'),
          }),
          ScalarControlProbeSchema.extend({
            id: z.literal('del'),
            codeUnits: z.tuple([z.literal(0x7f)]),
            expected: z.literal('rejected'),
          }),
          ScalarControlProbeSchema.extend({
            id: z.literal('c1'),
            codeUnits: z.tuple([z.literal(0x9f)]),
            expected: z.literal('rejected'),
          }),
        ]),
      })
      .strict(),
    strictStructuralParity: z
      .object({
        canaryPrefix: z.literal('SIGNED_PUT_URL_CANARY_'),
        patternSource: z.literal(
          '^(?:[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$',
        ),
        runtimeTargetOwners: z.tuple([
          z
            .object({
              id: z.literal('archive-signed-put-target'),
              runtimeParser: z.literal('SnapshotArchiveSignedPutTargetSchema'),
              responseInstancePointer: z.literal('/uploads/archive/putUrl'),
            })
            .strict(),
          z
            .object({
              id: z.literal('manifest-signed-put-target'),
              runtimeParser: z.literal('SnapshotManifestSignedPutTargetSchema'),
              responseInstancePointer: z.literal('/uploads/manifest/putUrl'),
            })
            .strict(),
        ]),
        physicalPublicNodes: z.tuple([
          z
            .object({
              artifact: z.literal('contract-schemas'),
              pointer: z.literal(
                '/schemas/SnapshotUploadCreateResponse/definitions/SnapshotUploadCreateResponse/properties/uploads/properties/archive/properties/putUrl',
              ),
            })
            .strict(),
          z
            .object({
              artifact: z.literal('openapi'),
              pointer: z.literal(
                '/components/schemas/SnapshotUploadCreateResponse/properties/uploads/properties/archive/properties/putUrl',
              ),
            })
            .strict(),
          z
            .object({
              artifact: z.literal('openapi'),
              pointer: z.literal(
                '/components/schemas/SnapshotUploadCreateResponse/properties/uploads/properties/manifest/properties/putUrl',
              ),
            })
            .strict(),
        ]),
        semanticResponseOwners: z.tuple([
          z
            .object({
              id: z.literal('contract-archive-put-url'),
              artifact: z.literal('contract-schemas'),
              semanticPointer: z.literal(
                '/schemas/SnapshotUploadCreateResponse/definitions/SnapshotUploadCreateResponse/properties/uploads/properties/archive/properties/putUrl',
              ),
              responseInstancePointer: z.literal('/uploads/archive/putUrl'),
              physicalPointer: z.literal(
                '/schemas/SnapshotUploadCreateResponse/definitions/SnapshotUploadCreateResponse/properties/uploads/properties/archive/properties/putUrl',
              ),
            })
            .strict(),
          z
            .object({
              id: z.literal('contract-manifest-put-url'),
              artifact: z.literal('contract-schemas'),
              semanticPointer: z.literal(
                '/schemas/SnapshotUploadCreateResponse/definitions/SnapshotUploadCreateResponse/properties/uploads/properties/manifest/properties/putUrl',
              ),
              responseInstancePointer: z.literal('/uploads/manifest/putUrl'),
              physicalPointer: z.literal(
                '/schemas/SnapshotUploadCreateResponse/definitions/SnapshotUploadCreateResponse/properties/uploads/properties/archive/properties/putUrl',
              ),
            })
            .strict(),
          z
            .object({
              id: z.literal('openapi-archive-put-url'),
              artifact: z.literal('openapi'),
              semanticPointer: z.literal(
                '/components/schemas/SnapshotUploadCreateResponse/properties/uploads/properties/archive/properties/putUrl',
              ),
              responseInstancePointer: z.literal('/uploads/archive/putUrl'),
              physicalPointer: z.literal(
                '/components/schemas/SnapshotUploadCreateResponse/properties/uploads/properties/archive/properties/putUrl',
              ),
            })
            .strict(),
          z
            .object({
              id: z.literal('openapi-manifest-put-url'),
              artifact: z.literal('openapi'),
              semanticPointer: z.literal(
                '/components/schemas/SnapshotUploadCreateResponse/properties/uploads/properties/manifest/properties/putUrl',
              ),
              responseInstancePointer: z.literal('/uploads/manifest/putUrl'),
              physicalPointer: z.literal(
                '/components/schemas/SnapshotUploadCreateResponse/properties/uploads/properties/manifest/properties/putUrl',
              ),
            })
            .strict(),
        ]),
        probes: z.tuple([
          StrictStructuralProbeSchema.extend({
            id: z.literal('ascii'),
            codeUnits: z.tuple([z.literal(0x41)]),
            expected: z.literal('accepted'),
          }),
          StrictStructuralProbeSchema.extend({
            id: z.literal('cjk'),
            codeUnits: z.tuple([z.literal(0x754c)]),
            expected: z.literal('accepted'),
          }),
          StrictStructuralProbeSchema.extend({
            id: z.literal('astral'),
            codeUnits: z.tuple([z.literal(0xd83d), z.literal(0xde00)]),
            expected: z.literal('accepted'),
          }),
          StrictStructuralProbeSchema.extend({
            id: z.literal('high-surrogate'),
            codeUnits: z.tuple([z.literal(0xd800)]),
            expected: z.literal('rejected'),
          }),
          StrictStructuralProbeSchema.extend({
            id: z.literal('low-surrogate'),
            codeUnits: z.tuple([z.literal(0xdc00)]),
            expected: z.literal('rejected'),
          }),
          StrictStructuralProbeSchema.extend({
            id: z.literal('nul'),
            codeUnits: z.tuple([z.literal(0x00)]),
            expected: z.literal('rejected'),
          }),
          StrictStructuralProbeSchema.extend({
            id: z.literal('tab'),
            codeUnits: z.tuple([z.literal(0x09)]),
            expected: z.literal('rejected'),
          }),
          StrictStructuralProbeSchema.extend({
            id: z.literal('lf'),
            codeUnits: z.tuple([z.literal(0x0a)]),
            expected: z.literal('rejected'),
          }),
          StrictStructuralProbeSchema.extend({
            id: z.literal('cr'),
            codeUnits: z.tuple([z.literal(0x0d)]),
            expected: z.literal('rejected'),
          }),
          StrictStructuralProbeSchema.extend({
            id: z.literal('other-c0'),
            codeUnits: z.tuple([z.literal(0x1f)]),
            expected: z.literal('rejected'),
          }),
          StrictStructuralProbeSchema.extend({
            id: z.literal('del'),
            codeUnits: z.tuple([z.literal(0x7f)]),
            expected: z.literal('rejected'),
          }),
          StrictStructuralProbeSchema.extend({
            id: z.literal('c1'),
            codeUnits: z.tuple([z.literal(0x9f)]),
            expected: z.literal('rejected'),
          }),
        ]),
      })
      .strict(),
    boundaries: z.array(Utf8BoundarySchema).min(1),
    ownerCases: z.tuple([Utf8OwnerBoundarySchema]),
    remainingBoundaryClasses: z.tuple([
      z.literal('structural-string-length'),
      z.literal('array-count'),
      z.literal('decoded-bytes'),
      z.literal('wire-bytes'),
      z.literal('canonical-json-bytes'),
      z.literal('numeric-bytes'),
    ]),
  })
  .strict()
  .superRefine((corpus, context) => {
    const maxima = corpus.boundaries.map(({ maxBytes }) => maxBytes);
    if (new Set(maxima).size !== maxima.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boundaries'],
        message: 'UTF-8 boundary maxima must be unique',
      });
    }
    const pointers = corpus.boundaries.flatMap(({ artifactPointers }) =>
      artifactPointers.map(({ artifact, pointer }) => `${artifact}:${pointer}`),
    );
    if (new Set(pointers).size !== pointers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boundaries'],
        message: 'UTF-8 artifact pointers must be unique',
      });
    }
    const excluded = new Set(
      corpus.scalarControlParity.artifactCoverage.excludedPointers.map(
        ({ artifact, pointer }) => `${artifact}:${pointer}`,
      ),
    );
    const parityPointers = pointers.filter((pointer) => !excluded.has(pointer));
    const counts = parityPointers.reduce(
      (output, pointer) => {
        const artifact = pointer.slice(0, pointer.indexOf(':'));
        if (artifact === 'contract-schemas') output.contractSchemas += 1;
        if (artifact === 'broker-contract') output.brokerContract += 1;
        if (artifact === 'openapi') output.openApi += 1;
        return output;
      },
      { contractSchemas: 0, brokerContract: 0, openApi: 0 },
    );
    const expected = corpus.scalarControlParity.artifactCoverage.expectedCounts;
    if (
      parityPointers.length !== expected.total ||
      counts.contractSchemas !== expected.contractSchemas ||
      counts.brokerContract !== expected.brokerContract ||
      counts.openApi !== expected.openApi
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scalarControlParity', 'artifactCoverage'],
        message: 'UTF-8 scalar-control artifact coverage counts must remain exact',
      });
    }
  });

export type ProtocolUtf8BoundaryCorpus = z.infer<typeof ProtocolUtf8BoundaryCorpusSchema>;
