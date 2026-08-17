import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  AgentVersionManifestSchema,
  AgentVersionResourceBoundaryCorpusSchema,
  type AgentVersionManifest,
} from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import { buildAgentVersion, isSnapshotError, type AgentVersionExecutionInput } from '../index.js';

const corpusUrl = new URL(
  '../../../creator-agent-protocol/fixtures/agent-version-resource-boundaries.v1.json',
  import.meta.url,
);
const fixtureDirectoryUrl = new URL('../../../creator-agent-protocol/fixtures/', import.meta.url);
const TARGET_CANARY = 'AGENT_VERSION_BOUNDARY_CANARY_DO_NOT_ECHO';

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function lookupPointer(document: unknown, pointer: string): unknown {
  let current = document;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`AGENT_VERSION_BUILD_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function replacePointer(document: AgentVersionManifest, pointer: string, replacement: unknown) {
  const clone = structuredClone(document) as unknown;
  const segments = pointerSegments(pointer);
  let current = clone;
  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`AGENT_VERSION_BUILD_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`AGENT_VERSION_BUILD_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  (current as Record<string, unknown>)[segments.at(-1)!] = replacement;
  return clone as AgentVersionManifest;
}

function executionInput(manifest: AgentVersionManifest): AgentVersionExecutionInput {
  const { protocol: _protocol, schemaVersion: _schemaVersion, ...execution } = manifest;
  return execution;
}

describe('production AgentVersion variable resource boundaries', () => {
  it('runs all four corpus cases at N-1/N/N+1 through buildAgentVersion', async () => {
    const corpus = AgentVersionResourceBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const baseBytes = await readFile(new URL(corpus.baseFixture.path, fixtureDirectoryUrl));
    expect(sha256(baseBytes)).toBe(corpus.baseFixture.digest);
    const baseManifest = AgentVersionManifestSchema.parse(JSON.parse(baseBytes.toString('utf8')));
    let outcomes = 0;

    for (const boundary of corpus.cases) {
      for (const delta of [-1, 0, 1] as const) {
        const size = boundary.maximum + delta;
        const replacement =
          boundary.valueKind === 'array-cardinality'
            ? Array.from({ length: size }, (_, index) =>
                index === size - 1 && delta === 1 ? TARGET_CANARY : `instruction-${index + 1}`,
              )
            : size;
        const manifest = replacePointer(baseManifest, boundary.manifestInstancePath, replacement);
        const input = executionInput(manifest);
        let built: ReturnType<typeof buildAgentVersion> | undefined;
        let rejection: unknown;
        try {
          built = buildAgentVersion(input);
        } catch (error) {
          rejection = error;
        }

        if (delta <= 0) {
          expect(rejection, `${boundary.id}:${delta}`).toBeUndefined();
          expect(lookupPointer(built?.manifest, boundary.manifestInstancePath)).toEqual(
            replacement,
          );
          const replay = buildAgentVersion(input);
          expect({
            versionDigest: replay.versionDigest,
            behaviorContractDigest: replay.behaviorContractDigest,
            runtimePolicyDigest: replay.runtimePolicyDigest,
            ioContractDigest: replay.ioContractDigest,
            modelPolicyDigest: replay.modelPolicyDigest,
          }).toEqual({
            versionDigest: built?.versionDigest,
            behaviorContractDigest: built?.behaviorContractDigest,
            runtimePolicyDigest: built?.runtimePolicyDigest,
            ioContractDigest: built?.ioContractDigest,
            modelPolicyDigest: built?.modelPolicyDigest,
          });
          for (const digest of [
            built?.versionDigest,
            built?.behaviorContractDigest,
            built?.runtimePolicyDigest,
            built?.ioContractDigest,
            built?.modelPolicyDigest,
          ]) {
            expect(digest, `${boundary.id}:${delta}`).toMatch(/^[a-f0-9]{64}$/u);
          }
          expect(built?.manifestBytes.byteLength, `${boundary.id}:${delta}`).toBeGreaterThan(0);
          expect(Object.isFrozen(built?.manifest), `${boundary.id}:${delta}`).toBe(true);
          expect(Object.isFrozen(built?.manifest.behaviorContract), `${boundary.id}:${delta}`).toBe(
            true,
          );
          expect(Object.isFrozen(built?.manifest.runtimePolicy), `${boundary.id}:${delta}`).toBe(
            true,
          );
          if (Array.isArray(replacement)) {
            expect(
              Object.isFrozen(lookupPointer(built?.manifest, boundary.manifestInstancePath)),
              `${boundary.id}:${delta}`,
            ).toBe(true);
          }
        } else {
          expect(built, boundary.id).toBeUndefined();
          expect(isSnapshotError(rejection, 'AGENT_VERSION_INVALID'), boundary.id).toBe(true);
          const publicError = rejection as Error & { code?: string; cause?: unknown };
          const publicSurface = JSON.stringify({
            name: publicError.name,
            message: publicError.message,
            code: publicError.code,
            cause: publicError.cause,
          });
          expect(publicSurface, boundary.id).not.toContain(
            Array.isArray(replacement) ? TARGET_CANARY : JSON.stringify(replacement),
          );
        }
        outcomes += 1;
      }
    }

    expect(outcomes).toBe(12);
  });
});
