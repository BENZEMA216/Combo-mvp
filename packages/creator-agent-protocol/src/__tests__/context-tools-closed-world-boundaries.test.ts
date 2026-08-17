import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';

import { AgentVersionManifestSchema, RuntimePolicySchema } from '../agent-version.js';
import { canonicalSha256 } from '../canonical.js';
import { ContextToolsClosedWorldBoundaryCorpusSchema } from '../context-tools-closed-world-boundaries.js';
import { CreateAgentVersionRequestSchema } from '../http.js';
import { SandboxSpecSchema } from '../sandbox.js';

const corpusUrl = new URL(
  '../../fixtures/context-tools-closed-world-boundaries.v1.json',
  import.meta.url,
);
const corpusFixturePath = 'context-tools-closed-world-boundaries.v1.json';
const fixtureDirectoryUrl = new URL('../../fixtures/', import.meta.url);
const fixtureIndexUrl = new URL('../../fixtures/index.json', import.meta.url);
const artifactUrls = {
  contractSchemas: new URL('../../schemas/contract-schemas.v1.json', import.meta.url),
  openApi: new URL('../../openapi/creator-agent-v1.openapi.json', import.meta.url),
} as const;
const VERIFIED_SNAPSHOT_ID = '0198f00d-6000-7000-8000-000000000001';

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function lookupPointer(document: unknown, pointer: string): Record<string, unknown> {
  let current = document;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`CONTEXT_TOOLS_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`CONTEXT_TOOLS_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
}

function pathFor(pointer: string): Array<string | number> {
  return pointerSegments(pointer).map((segment) =>
    /^\d+$/u.test(segment) ? Number(segment) : segment,
  );
}

describe('digest-bound closed-world context tools', () => {
  it('pins frozen authority, base fixtures, artifacts, owners, exclusions and 63 outcomes', async () => {
    const corpusBytes = await readFile(corpusUrl);
    const corpus = ContextToolsClosedWorldBoundaryCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')),
    );
    expect(corpus.authority).toEqual({
      technicalPlanSection: '技术方案 §7.8 Context 读取闭世界',
      decisionRegistryIds: ['ADR-VNEXT-013', 'ADR-VNEXT-031'],
      testPlanSection: '测试方案 §15.6 noexec 不是不执行 Project 代码',
      additiveRegistryCaseId: 'SCH-004',
    });
    expect(corpus.exclusions).toEqual([
      'real-linux-codex-tool-calls',
      'guest-tool-implementation',
      'root-fd-confinement',
      'path-and-symlink-escape',
      'g2-isolated-runtime',
      'e4-real-linux-codex',
      'e5-real-isolation',
      'does-not-complete-sch-004',
      'does-not-complete-sch-009',
      'does-not-complete-sch-010',
    ]);
    expect(corpus.outcomeCounts.total).toBe(
      corpus.outcomeCounts.runtime +
        corpus.outcomeCounts.advertised +
        corpus.outcomeCounts.buildAgentVersion,
    );

    const fixtureIndex = JSON.parse(await readFile(fixtureIndexUrl, 'utf8')) as {
      fixtures: Array<{ path: string; bytes: number; digest: string }>;
    };
    expect(fixtureIndex.fixtures.find(({ path }) => path === corpusFixturePath)).toEqual({
      path: corpusFixturePath,
      bytes: corpusBytes.byteLength,
      digest: sha256(corpusBytes),
    });
    for (const fixture of corpus.baseFixtures) {
      const bytes = await readFile(new URL(fixture.path, fixtureDirectoryUrl));
      expect(sha256(bytes), fixture.path).toBe(fixture.digest);
      expect(fixtureIndex.fixtures.find(({ path }) => path === fixture.path)).toEqual({
        path: fixture.path,
        bytes: bytes.byteLength,
        digest: fixture.digest,
      });
    }

    const documents = {
      contractSchemas: JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as unknown,
      openApi: JSON.parse(await readFile(artifactUrls.openApi, 'utf8')) as unknown,
    };
    expect(corpus.checkedArtifactDigests).toEqual({
      contractSchemas: sha256(await readFile(artifactUrls.contractSchemas)),
      openApi: sha256(await readFile(artifactUrls.openApi)),
    });
    for (const owner of corpus.advertisedOwners) {
      expect(lookupPointer(documents[owner.artifact], owner.artifactPointer)).toMatchObject({
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: expect.any(Array),
      });
    }
  });

  it('runs seven digest-identical variants through four runtime and four advertised owners', async () => {
    const corpus = ContextToolsClosedWorldBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const manifestBytes = await readFile(
      new URL('agent-version-manifest.v1.json', fixtureDirectoryUrl),
    );
    const sandboxBytes = await readFile(new URL('sandbox-spec.v1.json', fixtureDirectoryUrl));
    const manifest = AgentVersionManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
    const sandbox = SandboxSpecSchema.parse(JSON.parse(sandboxBytes.toString('utf8')));
    const contractSchemas = JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as {
      schemas: Record<string, AnySchema>;
    };
    const openApi = JSON.parse(await readFile(artifactUrls.openApi, 'utf8')) as {
      components: { schemas: Record<string, AnySchema> };
    };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const advertised: ReadonlyArray<{
      owner: (typeof corpus.advertisedOwners)[number];
      validate: ValidateFunction;
    }> = [
      {
        owner: corpus.advertisedOwners[0],
        validate: ajv.compile(contractSchemas.schemas.AgentVersionManifest!),
      },
      {
        owner: corpus.advertisedOwners[1],
        validate: ajv.compile(contractSchemas.schemas.CreateAgentVersionRequest!),
      },
      {
        owner: corpus.advertisedOwners[2],
        validate: ajv.compile(contractSchemas.schemas.SandboxSpec!),
      },
      {
        owner: corpus.advertisedOwners[3],
        validate: ajv.compile(openApi.components.schemas.CreateAgentVersionRequest!),
      },
    ];
    let runtimeOutcomes = 0;
    let advertisedOutcomes = 0;

    for (const variant of corpus.variants) {
      expect(`sha256:${canonicalSha256(variant.tools)}`, variant.id).toBe(
        variant.canonicalToolsDigest,
      );
      const runtimePolicy = { ...manifest.runtimePolicy, contextTools: variant.tools };
      const mutatedManifest = { ...manifest, runtimePolicy };
      const request = { verifiedSnapshotId: VERIFIED_SNAPSHOT_ID, manifest: mutatedManifest };
      const mutatedSandbox = {
        ...sandbox,
        runtimeCapabilities: { ...sandbox.runtimeCapabilities, contextTools: variant.tools },
      };
      const runtimeValues = [runtimePolicy, mutatedManifest, request, mutatedSandbox];
      const runtimeResults = [
        RuntimePolicySchema.safeParse(runtimeValues[0]),
        AgentVersionManifestSchema.safeParse(runtimeValues[1]),
        CreateAgentVersionRequestSchema.safeParse(runtimeValues[2]),
        SandboxSpecSchema.safeParse(runtimeValues[3]),
      ];
      const expected = variant.expected === 'accepted';

      runtimeResults.forEach((result, index) => {
        const owner = corpus.runtimeOwners[index]!;
        expect(result.success, `runtime:${owner.owner}:${variant.id}`).toBe(expected);
        if (!expected) {
          if (result.success || variant.expected !== 'rejected') {
            throw new Error(`CONTEXT_TOOLS_RUNTIME_ACCEPTED:${owner.owner}:${variant.id}`);
          }
          const expectedPath = [
            ...pathFor(owner.contextToolsPath),
            ...variant.runtimeIssue.relativePath,
          ];
          expect(result.error.issues, `${owner.owner}:${variant.id}`).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ code: variant.runtimeIssue.code, path: expectedPath }),
            ]),
          );
          expect(
            result.error.issues.map(({ message }) => message).join('\n'),
            `${owner.owner}:${variant.id}`,
          ).not.toContain(corpus.canary);
        }
        runtimeOutcomes += 1;
      });

      const advertisedValues = [mutatedManifest, request, mutatedSandbox, request];
      advertised.forEach(({ owner, validate }, index) => {
        expect(validate(advertisedValues[index]), `${owner.owner}:${variant.id}`).toBe(expected);
        if (!expected) {
          const keyword =
            owner.artifact === 'openApi'
              ? variant.advertisedIssue.openApiKeyword
              : variant.advertisedIssue.contractKeyword;
          const relativePath = variant.advertisedIssue.relativeInstancePath.replace(
            '/contextTools',
            '',
          );
          expect(validate.errors, `${owner.owner}:${variant.id}`).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                instancePath: `${owner.contextToolsInstancePath}${relativePath}`,
                keyword,
              }),
            ]),
          );
          expect(JSON.stringify(validate.errors), `${owner.owner}:${variant.id}`).not.toContain(
            corpus.canary,
          );
        }
        advertisedOutcomes += 1;
      });
    }

    expect(runtimeOutcomes).toBe(corpus.outcomeCounts.runtime);
    expect(advertisedOutcomes).toBe(corpus.outcomeCounts.advertised);
  });
});
