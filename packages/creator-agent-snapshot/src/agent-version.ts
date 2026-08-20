import {
  AGENT_VERSION_PROTOCOL,
  AgentVersionManifestSchema,
  canonicalSha256,
  canonicalizeJson as protocolCanonicalizeJson,
  computeAgentVersionDigests,
  type AgentVersionManifest,
  type BehaviorContract,
  type CanonicalJson,
  type IOContract,
  type RuntimePolicy,
} from '@cb/creator-agent-protocol';

import { SHA256_HEX_PATTERN } from './digest.js';
import { fail } from './errors.js';

export type AgentVersionExecutionInput = Omit<AgentVersionManifest, 'protocol' | 'schemaVersion'>;

export type BuiltAgentVersion = Readonly<{
  manifest: AgentVersionManifest;
  manifestBytes: Buffer;
  versionDigest: string;
  behaviorContractDigest: string;
  runtimePolicyDigest: string;
  ioContractDigest: string;
  modelPolicyDigest: string;
}>;

function cloneManifest(manifest: AgentVersionManifest): AgentVersionManifest {
  const parsed = AgentVersionManifestSchema.parse(JSON.parse(protocolCanonicalizeJson(manifest)));
  return Object.freeze({
    ...parsed,
    behaviorContract: Object.freeze({
      ...parsed.behaviorContract,
      developerInstructions: Object.freeze([...parsed.behaviorContract.developerInstructions]),
    }),
    runtimePolicy: Object.freeze({
      ...parsed.runtimePolicy,
      filesystem: Object.freeze({ ...parsed.runtimePolicy.filesystem }),
      contextTools: Object.freeze([...parsed.runtimePolicy.contextTools]),
    }),
    ioContract: Object.freeze({
      ...parsed.ioContract,
      input: Object.freeze({ ...parsed.ioContract.input }),
      output: Object.freeze({ ...parsed.ioContract.output }),
    }),
    codexRuntime: Object.freeze({ ...parsed.codexRuntime }),
    modelPolicy: Object.freeze({ ...parsed.modelPolicy }),
  }) as AgentVersionManifest;
}

export function contractDigest(contract: CanonicalJson): string {
  try {
    return canonicalSha256(contract);
  } catch (error) {
    fail('AGENT_VERSION_INVALID', error);
  }
}

export function buildAgentVersion(input: AgentVersionExecutionInput): BuiltAgentVersion {
  let manifest: AgentVersionManifest;
  try {
    manifest = AgentVersionManifestSchema.parse({
      protocol: AGENT_VERSION_PROTOCOL,
      schemaVersion: 1,
      ...input,
    });
  } catch (error) {
    fail('AGENT_VERSION_INVALID', error);
  }
  const digests = computeAgentVersionDigests(manifest);
  return Object.freeze({
    manifest: cloneManifest(manifest),
    manifestBytes: Buffer.from(protocolCanonicalizeJson(manifest), 'utf8'),
    versionDigest: digests.versionDigest,
    behaviorContractDigest: digests.behaviorContractDigest,
    runtimePolicyDigest: digests.runtimePolicyDigest,
    ioContractDigest: digests.ioContractDigest,
    modelPolicyDigest: digests.modelPolicyDigest,
  });
}

export type PublishedAgentVersion = Readonly<{
  id: string;
  agentId: string;
  creatorId: string;
  ordinal: number;
  versionDigest: string;
  manifest: AgentVersionManifest;
  behaviorContract: BehaviorContract;
  runtimePolicy: RuntimePolicy;
  ioContract: IOContract;
  displayName: string;
  description: string;
}>;

export type PublishAgentVersionInput = Readonly<{
  id: string;
  agentId: string;
  creatorId: string;
  ordinal: number;
  execution: AgentVersionExecutionInput;
  displayName?: string;
  description?: string;
}>;

export type AgentVersionControl = Readonly<{
  availability: 'ACTIVE' | 'DEPRECATED' | 'REVOKED';
  severity: 'NORMAL' | 'SECURITY';
  reasonCode: string;
}>;

function cloneVersion(version: PublishedAgentVersion): PublishedAgentVersion {
  const manifest = cloneManifest(version.manifest);
  return Object.freeze({
    ...version,
    manifest,
    behaviorContract: manifest.behaviorContract,
    runtimePolicy: manifest.runtimePolicy,
    ioContract: manifest.ioContract,
  });
}

export class InMemoryImmutableAgentVersionRepository {
  readonly #byId = new Map<string, PublishedAgentVersion>();
  readonly #byAgentDigest = new Map<string, PublishedAgentVersion>();
  readonly #byAgentOrdinal = new Map<string, PublishedAgentVersion>();
  readonly #controls = new Map<string, AgentVersionControl>();

  publish(input: PublishAgentVersionInput): PublishedAgentVersion {
    if (
      input.id.length === 0 ||
      input.agentId.length === 0 ||
      input.creatorId.length === 0 ||
      !Number.isSafeInteger(input.ordinal) ||
      input.ordinal <= 0
    ) {
      fail('AGENT_VERSION_INVALID');
    }
    const built = buildAgentVersion(input.execution);
    const idOwner = this.#byId.get(input.id);
    const ordinalOwner = this.#byAgentOrdinal.get(`${input.agentId}\u0000${input.ordinal}`);
    if (
      (idOwner !== undefined && idOwner.versionDigest !== built.versionDigest) ||
      (ordinalOwner !== undefined && ordinalOwner.versionDigest !== built.versionDigest)
    ) {
      fail('AGENT_VERSION_IMMUTABLE_CONFLICT');
    }
    const existingDigest = this.#byAgentDigest.get(`${input.agentId}\u0000${built.versionDigest}`);
    if (existingDigest !== undefined) {
      if (existingDigest.creatorId !== input.creatorId) fail('AGENT_VERSION_IMMUTABLE_CONFLICT');
      return cloneVersion(existingDigest);
    }
    if (idOwner !== undefined || ordinalOwner !== undefined) {
      fail('AGENT_VERSION_IMMUTABLE_CONFLICT');
    }

    const manifest = cloneManifest(built.manifest);
    const version = cloneVersion({
      id: input.id,
      agentId: input.agentId,
      creatorId: input.creatorId,
      ordinal: input.ordinal,
      versionDigest: built.versionDigest,
      manifest,
      behaviorContract: manifest.behaviorContract,
      runtimePolicy: manifest.runtimePolicy,
      ioContract: manifest.ioContract,
      displayName: input.displayName ?? '',
      description: input.description ?? '',
    });
    this.#byId.set(version.id, version);
    this.#byAgentDigest.set(`${version.agentId}\u0000${version.versionDigest}`, version);
    this.#byAgentOrdinal.set(`${version.agentId}\u0000${version.ordinal}`, version);
    this.#controls.set(
      version.id,
      Object.freeze({ availability: 'ACTIVE', severity: 'NORMAL', reasonCode: 'PUBLISHED' }),
    );
    return cloneVersion(version);
  }

  get(id: string): PublishedAgentVersion | undefined {
    const version = this.#byId.get(id);
    return version === undefined ? undefined : cloneVersion(version);
  }

  setControl(id: string, control: AgentVersionControl): AgentVersionControl {
    if (!this.#byId.has(id) || control.reasonCode.length === 0) fail('AGENT_VERSION_INVALID');
    const stored = Object.freeze({ ...control });
    this.#controls.set(id, stored);
    return Object.freeze({ ...stored });
  }

  getControl(id: string): AgentVersionControl | undefined {
    const control = this.#controls.get(id);
    return control === undefined ? undefined : Object.freeze({ ...control });
  }
}

export type ConversationVersionPin = Readonly<{
  conversationId: string;
  agentId: string;
  agentVersionId: string;
  versionDigest: string;
}>;

export class InMemoryConversationPinRepository {
  readonly #pins = new Map<string, ConversationVersionPin>();

  createOrGet(pin: ConversationVersionPin): ConversationVersionPin {
    if (
      pin.conversationId.length === 0 ||
      pin.agentId.length === 0 ||
      pin.agentVersionId.length === 0 ||
      !SHA256_HEX_PATTERN.test(pin.versionDigest)
    ) {
      fail('AGENT_VERSION_INVALID');
    }
    const existing = this.#pins.get(pin.conversationId);
    if (existing !== undefined) {
      if (
        existing.agentId !== pin.agentId ||
        existing.agentVersionId !== pin.agentVersionId ||
        existing.versionDigest !== pin.versionDigest
      ) {
        fail('CONVERSATION_VERSION_PIN_CONFLICT');
      }
      return Object.freeze({ ...existing });
    }
    const stored = Object.freeze({ ...pin });
    this.#pins.set(pin.conversationId, stored);
    return Object.freeze({ ...stored });
  }

  assertPinned(conversationId: string, agentVersionId: string, versionDigest: string): void {
    const existing = this.#pins.get(conversationId);
    if (
      existing === undefined ||
      existing.agentVersionId !== agentVersionId ||
      existing.versionDigest !== versionDigest
    ) {
      fail('CONVERSATION_VERSION_PIN_CONFLICT');
    }
  }
}
