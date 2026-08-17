import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const CONTEXT_TOOLS_CLOSED_WORLD_BOUNDARY_CORPUS =
  'combo.context-tools-closed-world-boundaries/1' as const;

const ContextToolSchema = z.enum(['read_context', 'list_context', 'search_context']);
const ProbeToolSchema = z.union([ContextToolSchema, z.literal('CTX_TOOL_CANARY_DO_NOT_ECHO')]);

const RejectedVariantCommonSchema = z
  .object({
    id: z.enum([
      'empty',
      'missing-one',
      'reordered',
      'duplicate',
      'unknown-replacement',
      'unknown-extra',
    ]),
    tools: z.array(ProbeToolSchema).max(4),
    canonicalToolsDigest: Sha256DigestSchema,
    expected: z.literal('rejected'),
    runtimeIssue: z
      .object({
        code: z.enum(['too_small', 'too_big', 'invalid_literal']),
        relativePath: z.array(z.number().int().nonnegative()).max(1),
      })
      .strict(),
    advertisedIssue: z
      .object({
        contractKeyword: z.enum(['minItems', 'maxItems', 'const']),
        openApiKeyword: z.enum(['minItems', 'maxItems', 'enum']),
        relativeInstancePath: z.string().regex(/^\/(?:contextTools|contextTools\/\d+)$/u),
      })
      .strict(),
  })
  .strict();

const RuntimeOwnerSchema = z
  .object({
    owner: z.enum([
      'RuntimePolicySchema',
      'AgentVersionManifestSchema',
      'CreateAgentVersionRequestSchema',
      'SandboxSpecSchema',
    ]),
    contextToolsPath: z.enum([
      '/contextTools',
      '/runtimePolicy/contextTools',
      '/manifest/runtimePolicy/contextTools',
      '/runtimeCapabilities/contextTools',
    ]),
  })
  .strict();

const AdvertisedOwnerSchema = z
  .object({
    artifact: z.enum(['contractSchemas', 'openApi']),
    owner: z.enum(['AgentVersionManifest', 'CreateAgentVersionRequest', 'SandboxSpec']),
    contextToolsInstancePath: z.enum([
      '/runtimePolicy/contextTools',
      '/manifest/runtimePolicy/contextTools',
      '/runtimeCapabilities/contextTools',
    ]),
    artifactPointer: z.string().startsWith('/').max(2_048),
  })
  .strict();

/**
 * Digest-bound P0 sub-evidence for the exact three-tool closed world.
 * It proves shared parsers, generated artifacts and local AgentVersion build
 * behavior only; real Guest tool implementations and isolation remain external gates.
 */
export const ContextToolsClosedWorldBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(CONTEXT_TOOLS_CLOSED_WORLD_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('context-tools-exact-closed-world-only'),
    evidenceClass: z.literal('schema-contract-and-local-build-owner-only'),
    authority: z
      .object({
        technicalPlanSection: z.literal('技术方案 §7.8 Context 读取闭世界'),
        decisionRegistryIds: z.tuple([z.literal('ADR-VNEXT-013'), z.literal('ADR-VNEXT-031')]),
        testPlanSection: z.literal('测试方案 §15.6 noexec 不是不执行 Project 代码'),
        additiveRegistryCaseId: z.literal('SCH-004'),
      })
      .strict(),
    checkedArtifactDigests: z
      .object({
        contractSchemas: z.literal(
          'sha256:ebbd5e475380de98a17e29f4ae2c0d6af3ad6ceaabc7e02bbc335eddc4ed24eb',
        ),
        openApi: z.literal(
          'sha256:4b7b30dd948c96a3d37e32670eec16970faca5154a4ff0a130b3d01b265d0fce',
        ),
      })
      .strict(),
    baseFixtures: z.tuple([
      z
        .object({
          owner: z.literal('AgentVersionManifestSchema'),
          path: z.literal('agent-version-manifest.v1.json'),
          digest: z.literal(
            'sha256:63d55f5ad38df489c1bdae9146b69aa7712ee34e85fe5895607afe8c700106e4',
          ),
        })
        .strict(),
      z
        .object({
          owner: z.literal('SandboxSpecSchema'),
          path: z.literal('sandbox-spec.v1.json'),
          digest: z.literal(
            'sha256:e4b9749843a479a2669950a6c33cd9be4f90ddea8dd00c2436bf7dbdc6fb9a0a',
          ),
        })
        .strict(),
    ]),
    canary: z.literal('CTX_TOOL_CANARY_DO_NOT_ECHO'),
    exactTools: z.tuple([
      z.literal('read_context'),
      z.literal('list_context'),
      z.literal('search_context'),
    ]),
    runtimeOwners: z.tuple([
      RuntimeOwnerSchema.extend({
        owner: z.literal('RuntimePolicySchema'),
        contextToolsPath: z.literal('/contextTools'),
      }).strict(),
      RuntimeOwnerSchema.extend({
        owner: z.literal('AgentVersionManifestSchema'),
        contextToolsPath: z.literal('/runtimePolicy/contextTools'),
      }).strict(),
      RuntimeOwnerSchema.extend({
        owner: z.literal('CreateAgentVersionRequestSchema'),
        contextToolsPath: z.literal('/manifest/runtimePolicy/contextTools'),
      }).strict(),
      RuntimeOwnerSchema.extend({
        owner: z.literal('SandboxSpecSchema'),
        contextToolsPath: z.literal('/runtimeCapabilities/contextTools'),
      }).strict(),
    ]),
    advertisedOwners: z.tuple([
      AdvertisedOwnerSchema.extend({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('AgentVersionManifest'),
        contextToolsInstancePath: z.literal('/runtimePolicy/contextTools'),
        artifactPointer: z.literal(
          '/schemas/AgentVersionManifest/definitions/AgentVersionManifest/properties/runtimePolicy/properties/contextTools',
        ),
      }).strict(),
      AdvertisedOwnerSchema.extend({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('CreateAgentVersionRequest'),
        contextToolsInstancePath: z.literal('/manifest/runtimePolicy/contextTools'),
        artifactPointer: z.literal(
          '/schemas/CreateAgentVersionRequest/definitions/CreateAgentVersionRequest/properties/manifest/properties/runtimePolicy/properties/contextTools',
        ),
      }).strict(),
      AdvertisedOwnerSchema.extend({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('SandboxSpec'),
        contextToolsInstancePath: z.literal('/runtimeCapabilities/contextTools'),
        artifactPointer: z.literal(
          '/schemas/SandboxSpec/definitions/SandboxSpec/properties/runtimeCapabilities/properties/contextTools',
        ),
      }).strict(),
      AdvertisedOwnerSchema.extend({
        artifact: z.literal('openApi'),
        owner: z.literal('CreateAgentVersionRequest'),
        contextToolsInstancePath: z.literal('/manifest/runtimePolicy/contextTools'),
        artifactPointer: z.literal(
          '/components/schemas/CreateAgentVersionRequest/properties/manifest/properties/runtimePolicy/properties/contextTools',
        ),
      }).strict(),
    ]),
    actualOwner: z
      .object({
        owner: z.literal('buildAgentVersion'),
        contextToolsPath: z.literal('/runtimePolicy/contextTools'),
      })
      .strict(),
    outcomeCounts: z
      .object({
        runtime: z.literal(28),
        advertised: z.literal(28),
        buildAgentVersion: z.literal(7),
        total: z.literal(63),
      })
      .strict(),
    exclusions: z.tuple([
      z.literal('real-linux-codex-tool-calls'),
      z.literal('guest-tool-implementation'),
      z.literal('root-fd-confinement'),
      z.literal('path-and-symlink-escape'),
      z.literal('g2-isolated-runtime'),
      z.literal('e4-real-linux-codex'),
      z.literal('e5-real-isolation'),
      z.literal('does-not-complete-sch-004'),
      z.literal('does-not-complete-sch-009'),
      z.literal('does-not-complete-sch-010'),
    ]),
    variants: z.tuple([
      z
        .object({
          id: z.literal('exact'),
          tools: z.tuple([
            z.literal('read_context'),
            z.literal('list_context'),
            z.literal('search_context'),
          ]),
          canonicalToolsDigest: z.literal(
            'sha256:54dd3ddd694ed6a397215a0a776a17d7b9f502585c486c13b4def40c579935c7',
          ),
          expected: z.literal('accepted'),
        })
        .strict(),
      RejectedVariantCommonSchema.extend({
        id: z.literal('empty'),
        tools: z.tuple([]),
        canonicalToolsDigest: z.literal(
          'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        ),
        runtimeIssue: z
          .object({ code: z.literal('too_small'), relativePath: z.tuple([]) })
          .strict(),
        advertisedIssue: z
          .object({
            contractKeyword: z.literal('minItems'),
            openApiKeyword: z.literal('minItems'),
            relativeInstancePath: z.literal('/contextTools'),
          })
          .strict(),
      }).strict(),
      RejectedVariantCommonSchema.extend({
        id: z.literal('missing-one'),
        tools: z.tuple([z.literal('read_context'), z.literal('list_context')]),
        canonicalToolsDigest: z.literal(
          'sha256:a7247f1a5466a17bc6e2d9823d17d0570f79cc6bac140f2e70895dccfeaedcb0',
        ),
        runtimeIssue: z
          .object({ code: z.literal('too_small'), relativePath: z.tuple([]) })
          .strict(),
        advertisedIssue: z
          .object({
            contractKeyword: z.literal('minItems'),
            openApiKeyword: z.literal('minItems'),
            relativeInstancePath: z.literal('/contextTools'),
          })
          .strict(),
      }).strict(),
      RejectedVariantCommonSchema.extend({
        id: z.literal('reordered'),
        tools: z.tuple([
          z.literal('list_context'),
          z.literal('read_context'),
          z.literal('search_context'),
        ]),
        canonicalToolsDigest: z.literal(
          'sha256:de6744080e053d3797bd71b1fd7f74458d49553b99beccdd43c7b2dc3e4cf98d',
        ),
        runtimeIssue: z
          .object({ code: z.literal('invalid_literal'), relativePath: z.tuple([z.literal(0)]) })
          .strict(),
        advertisedIssue: z
          .object({
            contractKeyword: z.literal('const'),
            openApiKeyword: z.literal('enum'),
            relativeInstancePath: z.literal('/contextTools/0'),
          })
          .strict(),
      }).strict(),
      RejectedVariantCommonSchema.extend({
        id: z.literal('duplicate'),
        tools: z.tuple([
          z.literal('read_context'),
          z.literal('read_context'),
          z.literal('search_context'),
        ]),
        canonicalToolsDigest: z.literal(
          'sha256:fe904b616edae82de10d8acb602e7a06aafb534c6120ec83c3ec184fdaeff400',
        ),
        runtimeIssue: z
          .object({ code: z.literal('invalid_literal'), relativePath: z.tuple([z.literal(1)]) })
          .strict(),
        advertisedIssue: z
          .object({
            contractKeyword: z.literal('const'),
            openApiKeyword: z.literal('enum'),
            relativeInstancePath: z.literal('/contextTools/1'),
          })
          .strict(),
      }).strict(),
      RejectedVariantCommonSchema.extend({
        id: z.literal('unknown-replacement'),
        tools: z.tuple([
          z.literal('read_context'),
          z.literal('list_context'),
          z.literal('CTX_TOOL_CANARY_DO_NOT_ECHO'),
        ]),
        canonicalToolsDigest: z.literal(
          'sha256:e2c85f28ca0274ce4f464c28131ed3bc8a8a351a6dd1063193c2f283dae6176f',
        ),
        runtimeIssue: z
          .object({ code: z.literal('invalid_literal'), relativePath: z.tuple([z.literal(2)]) })
          .strict(),
        advertisedIssue: z
          .object({
            contractKeyword: z.literal('const'),
            openApiKeyword: z.literal('enum'),
            relativeInstancePath: z.literal('/contextTools/2'),
          })
          .strict(),
      }).strict(),
      RejectedVariantCommonSchema.extend({
        id: z.literal('unknown-extra'),
        tools: z.tuple([
          z.literal('read_context'),
          z.literal('list_context'),
          z.literal('search_context'),
          z.literal('CTX_TOOL_CANARY_DO_NOT_ECHO'),
        ]),
        canonicalToolsDigest: z.literal(
          'sha256:889028323155028acc12ca21c085485d720142c1552ae66b99d74d1981ebaf69',
        ),
        runtimeIssue: z.object({ code: z.literal('too_big'), relativePath: z.tuple([]) }).strict(),
        advertisedIssue: z
          .object({
            contractKeyword: z.literal('maxItems'),
            openApiKeyword: z.literal('maxItems'),
            relativeInstancePath: z.literal('/contextTools'),
          })
          .strict(),
      }).strict(),
    ]),
  })
  .strict();

export type ContextToolsClosedWorldBoundaryCorpus = z.infer<
  typeof ContextToolsClosedWorldBoundaryCorpusSchema
>;
