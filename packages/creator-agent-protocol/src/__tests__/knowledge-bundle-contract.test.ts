import { describe, expect, it } from 'vitest';

import {
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackageFile,
} from '../agent-package.js';
import {
  CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES,
  CREATOR_KNOWLEDGE_BUNDLE_MAX_CHUNKS,
  CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
  CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
  CREATOR_KNOWLEDGE_CHUNK_MAX_BYTES,
  CREATOR_KNOWLEDGE_SKILL_PATH,
  createCreatorKnowledgeBundle,
  digestCreatorKnowledgeBundle,
  parseCreatorKnowledgeBundle,
  resolveCreatorKnowledgeBundleResource,
  serializeCreatorKnowledgeBundle,
  verifyCreatorKnowledgeBundle,
} from '../knowledge-bundle.js';
import * as knowledgeBundleExports from '../knowledge-bundle.js';

const CONTENT = 'Combo 使用 exact Agent Package 作为唯一运行真相。';
const CONTENT_DIGEST = digestCreatorAgentPackageFile(Buffer.from(CONTENT, 'utf8'));

function chunk(index: number, content = CONTENT) {
  return {
    id: `chunk.knowledge.${index.toString(16).padStart(32, '0')}`,
    source: {
      sourceId: `source.knowledge.${index.toString(16).padStart(32, '0')}`,
      displayLabel: `Combo 产品基线 ${index}`,
    },
    content,
    contentDigest: digestCreatorAgentPackageFile(Buffer.from(content, 'utf8')),
  };
}

function bundle(): {
  protocol: string;
  chunks: Array<{
    id: string;
    source: { sourceId: string; displayLabel: string };
    content: string;
    contentDigest: string;
  }>;
} {
  return {
    protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
    chunks: [
      {
        id: `chunk.knowledge.${'1'.repeat(32)}`,
        source: {
          sourceId: `source.knowledge.${'1'.repeat(32)}`,
          displayLabel: 'Combo 产品基线',
        },
        content: CONTENT,
        contentDigest: CONTENT_DIGEST,
      },
    ],
  };
}

describe('Knowledge Bundle contract', () => {
  it('canonicalizes, digests, parses, and deeply freezes exact evidence chunks', () => {
    const input = bundle();
    const value = createCreatorKnowledgeBundle(input);
    input.chunks[0]!.content = 'mutated';

    const text = serializeCreatorKnowledgeBundle(value);
    expect(parseCreatorKnowledgeBundle(text)).toEqual(value);
    expect(digestCreatorKnowledgeBundle(value)).toBe(
      digestCreatorAgentPackageFile(Buffer.from(text, 'utf8')),
    );
    expect(value.chunks[0]!.content).toBe(CONTENT);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.chunks)).toBe(true);
    expect(Object.isFrozen(value.chunks[0])).toBe(true);
    expect(Object.isFrozen(value.chunks[0]!.source)).toBe(true);
  });

  it('rejects digest drift, unordered IDs, unsafe text, extra fields, and non-canonical JSON', () => {
    const second = {
      ...bundle().chunks[0]!,
      id: `chunk.knowledge.${'0'.repeat(32)}`,
    };
    for (const input of [
      {
        ...bundle(),
        chunks: [{ ...bundle().chunks[0]!, contentDigest: `sha256:${'0'.repeat(64)}` }],
      },
      { ...bundle(), chunks: [bundle().chunks[0]!, second] },
      { ...bundle(), chunks: [{ ...bundle().chunks[0]!, content: `${CONTENT}\runsafe` }] },
      {
        ...bundle(),
        chunks: [
          {
            ...bundle().chunks[0]!,
            source: {
              sourceId: `source.knowledge.${'2'.repeat(32)}`,
              displayLabel: 'private/customer.md',
            },
          },
        ],
      },
      {
        ...bundle(),
        chunks: [
          chunk(0),
          {
            ...chunk(1),
            source: {
              sourceId: chunk(0).source.sourceId,
              displayLabel: '另一份显示声明',
            },
          },
        ],
      },
      {
        ...bundle(),
        chunks: [
          {
            ...bundle().chunks[0]!,
            source: {
              ...bundle().chunks[0]!.source,
              displayLabel: 'Combo  产品基线',
            },
          },
        ],
      },
      {
        ...bundle(),
        chunks: [{ ...bundle().chunks[0]!, content: `${CONTENT}\u200b` }],
      },
      {
        ...bundle(),
        chunks: [
          {
            ...bundle().chunks[0]!,
            content: '\n\t ',
            contentDigest: digestCreatorAgentPackageFile(Buffer.from('\n\t ', 'utf8')),
          },
        ],
      },
      { ...bundle(), storageKey: 'knowledge-bundles/mutable.json' },
    ]) {
      expect(() => createCreatorKnowledgeBundle(input)).toThrow();
    }

    const canonical = serializeCreatorKnowledgeBundle(bundle());
    expect(() => parseCreatorKnowledgeBundle(`${canonical}\n`)).toThrow(/canonical/u);
    expect(() =>
      parseCreatorKnowledgeBundle(' '.repeat(CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES + 1)),
    ).toThrow(/byte limit/u);
  });

  it('locks exact chunk-count, UTF-8 chunk-size, and canonical bundle-size boundaries', () => {
    const maximumChunks = Array.from({ length: CREATOR_KNOWLEDGE_BUNDLE_MAX_CHUNKS }, (_, index) =>
      chunk(index),
    );
    expect(
      createCreatorKnowledgeBundle({
        protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
        chunks: maximumChunks,
      }).chunks,
    ).toHaveLength(CREATOR_KNOWLEDGE_BUNDLE_MAX_CHUNKS);
    expect(() =>
      createCreatorKnowledgeBundle({
        protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
        chunks: [...maximumChunks, chunk(CREATOR_KNOWLEDGE_BUNDLE_MAX_CHUNKS)],
      }),
    ).toThrow();

    const exactChunkContent = `${'界'.repeat(10_922)}ab`;
    expect(Buffer.byteLength(exactChunkContent, 'utf8')).toBe(CREATOR_KNOWLEDGE_CHUNK_MAX_BYTES);
    expect(
      createCreatorKnowledgeBundle({
        protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
        chunks: [chunk(0, exactChunkContent)],
      }).chunks[0]!.content,
    ).toBe(exactChunkContent);
    expect(() =>
      createCreatorKnowledgeBundle({
        protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
        chunks: [chunk(0, `${exactChunkContent}a`)],
      }),
    ).toThrow(/UTF-8 byte limit/u);

    const almostMaximumBundle = {
      protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
      chunks: [
        ...Array.from({ length: 63 }, (_, index) =>
          chunk(index, 'x'.repeat(CREATOR_KNOWLEDGE_CHUNK_MAX_BYTES)),
        ),
        chunk(63, 'x'),
      ],
    };
    const almostMaximumBytes = Buffer.byteLength(
      serializeCreatorKnowledgeBundle(almostMaximumBundle),
      'utf8',
    );
    const finalContentLength = 1 + CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES - almostMaximumBytes;
    expect(finalContentLength).toBeLessThanOrEqual(CREATOR_KNOWLEDGE_CHUNK_MAX_BYTES);
    const exactMaximumBundle = {
      ...almostMaximumBundle,
      chunks: [
        ...almostMaximumBundle.chunks.slice(0, -1),
        chunk(63, 'x'.repeat(finalContentLength)),
      ],
    };
    const exactMaximumText = serializeCreatorKnowledgeBundle(exactMaximumBundle);
    expect(Buffer.byteLength(exactMaximumText, 'utf8')).toBe(CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES);
    expect(parseCreatorKnowledgeBundle(exactMaximumText)).toEqual(
      createCreatorKnowledgeBundle(exactMaximumBundle),
    );
    expect(() =>
      createCreatorKnowledgeBundle({
        ...exactMaximumBundle,
        chunks: [
          ...exactMaximumBundle.chunks.slice(0, -1),
          chunk(63, 'x'.repeat(finalContentLength + 1)),
        ],
      }),
    ).toThrow(/canonical byte limit/u);
  });

  it('does not invoke accessors or Proxy traps while rejecting hostile values', () => {
    expect(Reflect.has(knowledgeBundleExports, 'CreatorKnowledgeBundleSchema')).toBe(false);

    let getterReads = 0;
    const accessor = {
      protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
      get chunks() {
        getterReads += 1;
        return bundle().chunks;
      },
    };
    expect(() => verifyCreatorKnowledgeBundle(accessor)).toThrow(/data properties/u);
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxy = new Proxy(bundle(), {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => verifyCreatorKnowledgeBundle(proxy)).toThrow(/plain JSON/u);
    expect(proxyReads).toBe(0);
  });

  it('resolves knowledge only from the fixed resource inventoried by the exact Package', () => {
    const knowledgeBytes = Buffer.from(serializeCreatorKnowledgeBundle(bundle()), 'utf8');
    const skillBytes = Buffer.from('# Knowledge\n', 'utf8');
    const agentBytes = Buffer.from('# Agent\n', 'utf8');
    const manifest = createCreatorAgentPackageManifest({
      protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
      name: 'Combo Knowledge',
      description: 'Answers from one exact packaged knowledge source.',
      instructions: 'AGENT.md',
      skills: [CREATOR_KNOWLEDGE_SKILL_PATH],
      files: [
        {
          path: 'AGENT.md',
          byteLength: agentBytes.byteLength,
          digest: digestCreatorAgentPackageFile(agentBytes),
        },
        {
          path: CREATOR_KNOWLEDGE_SKILL_PATH,
          byteLength: skillBytes.byteLength,
          digest: digestCreatorAgentPackageFile(skillBytes),
        },
        {
          path: CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
          byteLength: knowledgeBytes.byteLength,
          digest: digestCreatorAgentPackageFile(knowledgeBytes),
        },
      ],
    });

    const resolved = resolveCreatorKnowledgeBundleResource(manifest);
    expect(resolved.resource).toEqual(manifest.files[2]);
    expect(resolved.resource.digest).toBe(digestCreatorKnowledgeBundle(bundle()));
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(() =>
      resolveCreatorKnowledgeBundleResource({
        ...manifest,
        files: manifest.files.filter(
          (file) => file.path !== CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
        ),
      }),
    ).toThrow(/fixed Test profile/u);
    expect(() =>
      resolveCreatorKnowledgeBundleResource({
        ...manifest,
        files: [
          ...manifest.files,
          {
            path: 'skills/knowledge/references/other.json',
            byteLength: 2,
            digest: digestCreatorAgentPackageFile(Buffer.from('{}', 'utf8')),
          },
        ],
      }),
    ).toThrow(/fixed Test profile/u);
  });
});
