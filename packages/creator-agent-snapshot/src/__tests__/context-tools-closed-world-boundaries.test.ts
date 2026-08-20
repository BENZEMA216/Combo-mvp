import { readFile } from 'node:fs/promises';

import {
  AgentVersionManifestSchema,
  ContextToolsClosedWorldBoundaryCorpusSchema,
  canonicalSha256,
} from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import { buildAgentVersion, isSnapshotError, type AgentVersionExecutionInput } from '../index.js';

const corpusUrl = new URL(
  '../../../creator-agent-protocol/fixtures/context-tools-closed-world-boundaries.v1.json',
  import.meta.url,
);
const manifestUrl = new URL(
  '../../../creator-agent-protocol/fixtures/agent-version-manifest.v1.json',
  import.meta.url,
);

describe('production AgentVersion context-tools closed world', () => {
  it('runs the same seven digest-bound variants through buildAgentVersion', async () => {
    const corpus = ContextToolsClosedWorldBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const manifest = AgentVersionManifestSchema.parse(
      JSON.parse(await readFile(manifestUrl, 'utf8')),
    );
    const { protocol: _protocol, schemaVersion: _schemaVersion, ...execution } = manifest;
    let outcomes = 0;

    for (const variant of corpus.variants) {
      expect(`sha256:${canonicalSha256(variant.tools)}`, variant.id).toBe(
        variant.canonicalToolsDigest,
      );
      const mutated = {
        ...execution,
        runtimePolicy: { ...execution.runtimePolicy, contextTools: variant.tools },
      } as unknown as AgentVersionExecutionInput;
      let built: ReturnType<typeof buildAgentVersion> | undefined;
      let rejection: unknown;
      try {
        built = buildAgentVersion(mutated);
      } catch (error) {
        rejection = error;
      }

      if (variant.expected === 'accepted') {
        expect(built?.manifest.runtimePolicy.contextTools, variant.id).toEqual(corpus.exactTools);
        expect(rejection, variant.id).toBeUndefined();
      } else {
        expect(built, variant.id).toBeUndefined();
        expect(isSnapshotError(rejection, 'AGENT_VERSION_INVALID'), variant.id).toBe(true);
        const publicError = rejection as Error & { code?: string; cause?: unknown };
        expect(
          JSON.stringify({
            name: publicError.name,
            message: publicError.message,
            code: publicError.code,
            cause: publicError.cause,
          }),
          variant.id,
        ).not.toContain(corpus.canary);
      }
      outcomes += 1;
    }

    expect(outcomes).toBe(corpus.outcomeCounts.buildAgentVersion);
  });
});
