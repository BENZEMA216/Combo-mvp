import { describe, expect, it } from 'vitest';

import { ProtocolVersionCorpusSchema } from '../compatibility.js';
import { ProtocolDecodedBoundaryCorpusSchema } from '../decoded-boundaries.js';
import { AgentVersionResourceBoundaryCorpusSchema } from '../resource-boundaries.js';
import { ProtocolStructuralBoundaryCorpusSchema } from '../structural-boundaries.js';
import { ProtocolUtf8BoundaryCorpusSchema } from '../utf8-boundaries.js';
import { readFixture } from './fixture-helpers.js';

type PathSegment = string | number;

interface PlainIngressOwner {
  readonly id: string;
  readonly fixture: unknown;
  readonly path: readonly PathSegment[];
  readonly schema: {
    safeParse(
      input: unknown,
    ): { readonly success: true } | { readonly success: false; readonly error: unknown };
  };
  readonly rootPointer?: boolean;
}

const CANARY = 'INTERNAL_PLAIN_INGRESS_CANARY_';
const FORBIDDEN_PROBES = [
  { id: 'lone-high-surrogate', value: String.fromCharCode(0xd800) },
  { id: 'nul', value: String.fromCharCode(0x00) },
  { id: 'c1', value: String.fromCharCode(0x9f) },
] as const;

function replaceAtPath(input: unknown, path: readonly PathSegment[], value: string): unknown {
  const clone = structuredClone(input);
  let cursor = clone;
  for (const segment of path.slice(0, -1)) {
    if (cursor === null || typeof cursor !== 'object') throw new TypeError('fixture path 无效');
    cursor = (cursor as Record<PathSegment, unknown>)[segment];
  }
  if (cursor === null || typeof cursor !== 'object') throw new TypeError('fixture path 无效');
  (cursor as Record<PathSegment, unknown>)[path.at(-1)!] = value;
  return clone;
}

function stringAtPath(input: unknown, path: readonly PathSegment[]): string {
  let cursor = input;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') throw new TypeError('fixture path 无效');
    cursor = (cursor as Record<PathSegment, unknown>)[segment];
  }
  if (typeof cursor !== 'string') throw new TypeError('fixture owner 不是 string');
  return cursor;
}

function candidate(owner: PlainIngressOwner, suffix: string): unknown {
  const original = stringAtPath(owner.fixture, owner.path);
  const prefix = owner.rootPointer && original === '' ? '/' : original;
  return replaceAtPath(owner.fixture, owner.path, `${prefix}${suffix}`);
}

async function loadOwners(): Promise<PlainIngressOwner[]> {
  const compatibility = await readFixture('protocol-compatibility.v1.json');
  const decoded = await readFixture('protocol-decoded-boundaries.v1.json');
  const utf8 = await readFixture('protocol-utf8-boundaries.v1.json');
  const structural = await readFixture('protocol-structural-boundaries.v1.json');
  const resource = await readFixture('agent-version-resource-boundaries.v1.json');

  return [
    {
      id: 'compatibility.current.wireProtocol',
      fixture: compatibility,
      path: ['current', 'wireProtocol'],
      schema: ProtocolVersionCorpusSchema,
    },
    {
      id: 'compatibility.current.handshakeFixture',
      fixture: compatibility,
      path: ['current', 'handshakeFixture'],
      schema: ProtocolVersionCorpusSchema,
    },
    {
      id: 'compatibility.rejectedRegistrations.advertisedValue',
      fixture: compatibility,
      path: ['rejectedRegistrations', 1, 'advertisedValue'],
      schema: ProtocolVersionCorpusSchema,
    },
    {
      id: 'decoded.boundaries.artifactPointers.pointer',
      fixture: decoded,
      path: ['boundaries', 0, 'artifactPointers', 0, 'pointer'],
      schema: ProtocolDecodedBoundaryCorpusSchema,
    },
    {
      id: 'decoded.ownerCases.ownerPointer',
      fixture: decoded,
      path: ['ownerCases', 0, 'ownerPointer'],
      schema: ProtocolDecodedBoundaryCorpusSchema,
      rootPointer: true,
    },
    {
      id: 'decoded.ownerCases.valuePointer',
      fixture: decoded,
      path: ['ownerCases', 0, 'valuePointer'],
      schema: ProtocolDecodedBoundaryCorpusSchema,
    },
    {
      id: 'utf8.boundaries.artifactPointers.pointer',
      fixture: utf8,
      path: ['boundaries', 0, 'artifactPointers', 0, 'pointer'],
      schema: ProtocolUtf8BoundaryCorpusSchema,
    },
    {
      id: 'structural.unicodeBoundaries.artifactPointers.pointer',
      fixture: structural,
      path: ['unicodeBoundaries', 0, 'artifactPointers', 0, 'pointer'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
    },
    {
      id: 'structural.unicodeScalarParity.runtimeOwners.source',
      fixture: structural,
      path: ['unicodeScalarParity', 'runtimeOwners', 0, 'source'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
    },
    {
      id: 'structural.unicodeScalarParity.runtimeOwners.runtimeParser',
      fixture: structural,
      path: ['unicodeScalarParity', 'runtimeOwners', 0, 'runtimeParser'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
    },
    {
      id: 'structural.unicodeScalarParity.runtimeOwners.fixtureSource',
      fixture: structural,
      path: ['unicodeScalarParity', 'runtimeOwners', 0, 'fixtureSource'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
    },
    {
      id: 'structural.unicodeScalarParity.runtimeOwners.ownerPointer',
      fixture: structural,
      path: ['unicodeScalarParity', 'runtimeOwners', 0, 'ownerPointer'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
      rootPointer: true,
    },
    {
      id: 'structural.unicodeScalarParity.runtimeOwners.instancePointer',
      fixture: structural,
      path: ['unicodeScalarParity', 'runtimeOwners', 0, 'instancePointer'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
    },
    {
      id: 'structural.serverIdBoundary.ownerFixture.path',
      fixture: structural,
      path: ['serverIdBoundary', 'ownerFixture', 'path'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
    },
    {
      id: 'structural.serverIdBoundary.ownerFixture.valuePointer',
      fixture: structural,
      path: ['serverIdBoundary', 'ownerFixture', 'valuePointer'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
    },
    {
      id: 'structural.serverIdBoundary.pathParameterPointers.pointer',
      fixture: structural,
      path: ['serverIdBoundary', 'pathParameterPointers', 0, 'pointer'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
    },
    {
      id: 'structural.gateSetBoundaries.ownerFixture.path',
      fixture: structural,
      path: ['gateSetBoundaries', 0, 'ownerFixture', 'path'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
    },
    {
      id: 'structural.gateSetBoundaries.ownerFixture.valuePointer',
      fixture: structural,
      path: ['gateSetBoundaries', 0, 'ownerFixture', 'valuePointer'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
    },
    {
      id: 'structural.gateSetBoundaries.contractPointer',
      fixture: structural,
      path: ['gateSetBoundaries', 0, 'contractPointer'],
      schema: ProtocolStructuralBoundaryCorpusSchema,
    },
    {
      id: 'resource.artifactPointers.contractAgentVersionManifest',
      fixture: resource,
      path: ['cases', 0, 'artifactPointers', 'contractAgentVersionManifest'],
      schema: AgentVersionResourceBoundaryCorpusSchema,
    },
    {
      id: 'resource.artifactPointers.contractCreateAgentVersionRequest',
      fixture: resource,
      path: ['cases', 0, 'artifactPointers', 'contractCreateAgentVersionRequest'],
      schema: AgentVersionResourceBoundaryCorpusSchema,
    },
    {
      id: 'resource.artifactPointers.openApiCreateAgentVersionRequest',
      fixture: resource,
      path: ['cases', 0, 'artifactPointers', 'openApiCreateAgentVersionRequest'],
      schema: AgentVersionResourceBoundaryCorpusSchema,
    },
  ];
}

describe('internal fixture/corpus plain string ingress', () => {
  it('所有实际 owner 对 legal Unicode scalar 保持兼容', async () => {
    const owners = await loadOwners();
    expect(owners).toHaveLength(22);
    expect(new Set(owners.map(({ id }) => id)).size).toBe(22);
    for (const owner of owners) {
      expect(owner.schema.safeParse(candidate(owner, '合法😀')).success, owner.id).toBe(true);
    }
  });

  it('所有实际 owner 拒绝 lone surrogate、NUL 与 C1 且错误不回显正文', async () => {
    const owners = await loadOwners();
    for (const owner of owners) {
      for (const probe of FORBIDDEN_PROBES) {
        const parsed = owner.schema.safeParse(candidate(owner, `${CANARY}${probe.value}`));
        expect(parsed.success, `${owner.id}:${probe.id}`).toBe(false);
        if (!parsed.success) {
          expect(JSON.stringify(parsed.error), `${owner.id}:${probe.id}:redaction`).not.toContain(
            CANARY,
          );
        }
      }
    }
  });

  it('optional root ownerPointer 仍接受空字符串', async () => {
    const owners = await loadOwners();
    for (const owner of owners.filter(({ rootPointer }) => rootPointer === true)) {
      expect(
        owner.schema.safeParse(replaceAtPath(owner.fixture, owner.path, '')).success,
        owner.id,
      ).toBe(true);
    }
  });
});
