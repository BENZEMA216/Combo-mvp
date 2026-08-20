import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

import {
  BrokerEnvelopeSchema,
  ExecutionCapabilitySchema,
  WorkerInterruptReceiptSchema,
  WorkerInvocationCancelledFactSchema,
  brokerSensitiveMessageAadBytes,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  canonicalSha256,
  canonicalizeJson,
  createHostInterruptedTerminalEvidence,
  createHostTurnTerminalEvidence,
  executionCapabilitySigningBytes,
  validateExecutionCapabilityBinding,
  workerInterruptReceiptDigest,
  workerInvocationFactDigest,
  type BrokerEnvelope,
  type BrokerSensitiveMessage,
  type ExecutionCapability,
  type ExpectedExecutionCapabilityBinding,
  type HostInterruptedTerminalEvidence,
} from '@cb/creator-agent-protocol';
import {
  consumeSequence,
  initialSequenceCursor,
  restoreSequenceCursor,
  serializeSequenceCursor,
} from '@cb/creator-agent-broker-journal';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SqliteWorkerBrokerDurableTransport,
  type DurableInboundCommandCandidate,
  type NewWorkerJournalAuthorization,
} from './sqlite-durable-transport.js';
import {
  type BrokerResultReencryptAuthorityPort,
  type CloudInvocationAckAuthorityPort,
  type HostDispatchExpectedBinding,
  type HostDispatchReceiptAuthorityPort,
  type LocalInvocationPromptAad,
  type LocalInvocationPromptCiphertext,
  type LocalPromptAeadAuthorityPort,
  type LocalResultAeadSealerPort,
  type LocalResultAeadAuthorityPort,
  type LocalInvocationResultCiphertext,
  type OpaqueHostDispatchPermit,
  type ReadyConversationAuthorityPort,
  type TrustedHostDispatchPort,
  localInvocationPromptAadBytes,
  localInvocationPromptAadDigest,
  localInvocationPromptCipherDigest,
  localInvocationResultAadBytes,
  type WorkerInvocationCapabilityAuthorityPort,
  type SqliteWorkerInvocationJournal,
} from './sqlite-invocation-journal.js';
import type { DurableBrokerConnection } from './worker-broker-client.js';
import {
  HOST_DISPATCH_RECEIPT_PROTOCOL,
  HostTurnRegistry,
  createHostDispatchPort,
  createHostDispatchReceiptAuthority,
  createHostInterruptPort,
  createHostInterruptReceiptAuthority,
  observeHostTerminal,
  sealHostTerminalResult,
  type HostTurnHandleLike,
} from './host-composition.js';

const { DatabaseSync: SqliteDatabase } = createRequire(import.meta.url)('node:sqlite') as {
  readonly DatabaseSync: typeof DatabaseSync;
};

const OWNER = 'invocation-owner-token-0123456789';
const SHA = (character: string) => character.repeat(64);
const HMAC = (character: string) => `hmac-sha256:${character.repeat(64)}`;
const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  temporaryDirectories.clear();
});

function uuid(seed: number): string {
  return `00000000-0000-7000-8000-${String(seed).padStart(12, '0')}`;
}

function clientUuid(seed: number): string {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

function hostPermit(
  seed: number,
  conversationId: string,
  runtimeThreadId: string,
): OpaqueHostDispatchPermit {
  return Object.freeze({
    installationId: uuid(seed),
    deploymentId: uuid(seed + 1),
    leaseId: uuid(seed + 2),
    workerSessionId: uuid(seed + 3),
    fence: String(seed),
    invocationId: uuid(seed + 4),
    conversationId,
    startCommandId: uuid(seed + 5),
    dispatchNonce: uuid(seed + 6),
    agentVersionId: uuid(seed + 7),
    agentVersionDigest: SHA('a'),
    snapshotDigest: SHA('b'),
    requestDigest: HMAC('c'),
    executionCapabilityDigest: SHA('d'),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    sandboxInstanceId: uuid(seed + 8),
    runtimeThreadId,
  });
}

function authorization(installationId: string): NewWorkerJournalAuthorization {
  return {
    installationId,
    journalGeneration: uuid(999_998),
    authorizationDigest: createHash('sha256').update(`journal:${installationId}`).digest('hex'),
  };
}

function signedCapability(input: ExecutionCapability, privateKey: KeyObject): ExecutionCapability {
  const signature = sign('sha256', executionCapabilitySigningBytes(input), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return ExecutionCapabilitySchema.parse({ ...input, signature });
}

function verifyCapability(
  input: unknown,
  expected: ExpectedExecutionCapabilityBinding,
  now: Date,
  publicKey: KeyObject,
  revoked: ReadonlySet<string>,
) {
  const result = validateExecutionCapabilityBinding(input, expected, now, revoked, publicKey);
  if (!result.ok) throw new Error(result.reasons.join(','));
  return result;
}

function encryptSensitive(
  plaintext: string,
  key: Buffer,
  aad: BrokerSensitiveMessage['aad'],
): BrokerSensitiveMessage {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(brokerSensitiveMessageAadBytes(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  return {
    algorithm: 'aes-256-gcm/v1',
    keyScope: 'worker-session',
    keyId: aad.keyId,
    nonce: nonceText,
    ciphertext: ciphertextText,
    authTag: authTagText,
    cipherDigest: brokerSensitiveMessageCipherDigest(nonceText, ciphertextText, authTagText),
    aad,
    aadDigest: brokerSensitiveMessageAadDigest(aad),
    aadVersion: 1,
  };
}

function resultDomainDigest(plaintext: Buffer, key: Buffer): string {
  return `hmac-sha256:${createHmac('sha256', key)
    .update('combo:vnext:result:v1\0', 'utf8')
    .update(plaintext)
    .digest('hex')}`;
}

function requestDomainDigest(plaintext: Buffer, key: Buffer): string {
  return `hmac-sha256:${createHmac('sha256', key)
    .update('combo:vnext:request:v1\0', 'utf8')
    .update(plaintext)
    .digest('hex')}`;
}

function encryptLocalPrompt(
  plaintext: Uint8Array,
  key: Buffer,
  requestHmacKey: Buffer,
  keyId: string,
  aad: LocalInvocationPromptAad,
): LocalInvocationPromptCiphertext {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(localInvocationPromptAadBytes(aad));
  const plaintextBytes = Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  return {
    algorithm: 'aes-256-gcm/v1',
    keyScope: 'worker-keychain',
    keyId,
    nonce: nonceText,
    ciphertext: ciphertextText,
    authTag: authTagText,
    cipherDigest: localInvocationPromptCipherDigest(nonceText, ciphertextText, authTagText),
    requestDigest: requestDomainDigest(plaintextBytes, requestHmacKey),
    aad,
    aadDigest: localInvocationPromptAadDigest(aad),
    aadVersion: 1,
  };
}

interface VerticalFixture {
  adapter: SqliteWorkerBrokerDurableTransport;
  filename: string;
  installationId: string;
  conversationId: string;
  invocationId: string;
  state: DurableBrokerConnection;
  keyId: string;
  contentKey: Buffer;
  localResultKey: Buffer;
  resultHmacKey: Buffer;
  keyPair: ReturnType<typeof generateKeyPairSync>;
  host: FakeCodexHost;
  registry: HostTurnRegistry;
  journal: SqliteWorkerInvocationJournal;
}

/**
 * Fake app-server: starts turns and produces interrupt evidence exactly like the real
 * `HostTurnHandle.interrupt()` path. The evidence producer is programmable per test so we
 * can exercise ACK-only responses, wrong-turn terminals and process restarts.
 */
class FakeCodexHost {
  readonly registry = new HostTurnRegistry();
  readonly producers = new Map<string, () => unknown>();
  readonly dispatchedTexts: string[] = [];
  abortAfterStart?: AbortController;
  dispatchCount = 0;

  private key(threadId: string, turnId: string): string {
    return `${threadId}\u0000${turnId}`;
  }

  /** CodexHostLike.createThread: the fake has one fixed ready thread. */
  async createThread(): Promise<{
    id: string;
    generation: number;
    workspaceRootsAcknowledged: boolean;
  }> {
    return { id: 'thread-ready-001', generation: 1, workspaceRootsAcknowledged: true };
  }

  /** CodexHostLike.startTurn: resolves the turn id on dispatch and wires the programmable interrupt producer. */
  startTurn(input: {
    thread: { id: string; generation: number; workspaceRootsAcknowledged: boolean };
    messageId: string;
    text: string;
    timeoutMs: number;
  }): HostTurnHandleLike {
    this.dispatchCount += 1;
    const turnId = `turn-host-${this.dispatchCount}`;
    const threadId = input.thread.id;
    this.dispatchedTexts.push(input.text);
    if (!this.producers.has(this.key(threadId, turnId))) {
      this.producers.set(this.key(threadId, turnId), defaultEvidenceProducer(threadId, turnId));
    }
    this.abortAfterStart?.abort();
    return {
      turnId: Promise.resolve(turnId),
      result: new Promise(() => undefined),
      terminal: new Promise(() => undefined),
      interrupt: async (): Promise<HostInterruptedTerminalEvidence> => {
        const produced = this.producers.get(this.key(threadId, turnId));
        if (produced === undefined) throw new Error('host-turn-not-alive');
        return produced() as HostInterruptedTerminalEvidence;
      },
    } satisfies HostTurnHandleLike;
  }

  /** Replaces the evidence producer for an already registered turn (host misbehaviour tests). */
  replaceProducer(threadId: string, turnId: string, producer: () => unknown): void {
    if (!this.producers.has(this.key(threadId, turnId))) {
      throw new Error('turn-not-registered');
    }
    this.producers.set(this.key(threadId, turnId), producer);
  }

  /** Simulates process restart: every live handle, producer and thread binding dies with the generation. */
  restart(): void {
    this.registry.clear();
    this.producers.clear();
  }
}
function defaultEvidenceProducer(threadId: string, turnId: string): () => unknown {
  return () =>
    createHostInterruptedTerminalEvidence({
      threadId,
      turnId,
      status: 'interrupted',
      error: null,
      completedAt: Date.now(),
    });
}

function createAuthorities(args: {
  publicKey: KeyObject;
  brokerContentKey: Buffer;
  localResultKeys: Map<string, Buffer>;
  resultHmacKey: Buffer;
  host: FakeCodexHost;
}) {
  const hostReceiptCalls = { count: 0 };
  const cloudAckCalls = { count: 0 };
  const revokedCapabilityIds = new Set<string>();
  const cloudNow = { value: Date.now() };
  const capabilityAuthority: WorkerInvocationCapabilityAuthorityPort = {
    verify(input, expected, now) {
      return verifyCapability(input, expected, now, args.publicKey, revokedCapabilityIds);
    },
    verifyPreviouslyCommitted(input, expected, digest, committedAt) {
      const verified = verifyCapability(
        input,
        expected,
        committedAt,
        args.publicKey,
        new Set<string>(),
      );
      if (verified.capabilityDigest !== digest) throw new Error('digest-conflict');
      return verified;
    },
  };
  const readyConversationAuthority: ReadyConversationAuthorityPort = {
    verify(input) {
      if ((input as { token?: string }).token !== 'sandbox-ready') throw new Error('not-ready');
      return {
        sandboxInstanceId: uuid(900_001),
        runtimeThreadId: 'thread-ready-001',
        evidenceDigest: `sha256:${SHA('7')}`,
        readyAt: new Date(),
      };
    },
  };
  const hostDispatchPort: TrustedHostDispatchPort = createHostDispatchPort({
    registry: args.host.registry,
    host: args.host,
  });
  const hostDispatchReceiptAuthority: HostDispatchReceiptAuthorityPort =
    createHostDispatchReceiptAuthority({
      registry: args.host.registry,
      sandboxAttestationDigest: (_binding) => `sha256:${SHA('9')}`,
    });
  const localPromptAeadAuthority: LocalPromptAeadAuthorityPort = {
    rewrap({ brokerCiphertext, brokerAad, localAad, expectedRequestDigest }) {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        args.brokerContentKey,
        Buffer.from(brokerCiphertext.nonce, 'base64url'),
      );
      decipher.setAAD(brokerSensitiveMessageAadBytes(brokerAad));
      decipher.setAuthTag(Buffer.from(brokerCiphertext.authTag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(brokerCiphertext.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      const requestDigest = requestDomainDigest(plaintext, args.resultHmacKey);
      if (requestDigest !== expectedRequestDigest) throw new Error('request-digest-mismatch');
      const local = args.localResultKeys.entries().next().value as [string, Buffer] | undefined;
      if (local === undefined) throw new Error('missing-local-key');
      return {
        ciphertext: encryptLocalPrompt(plaintext, local[1], args.resultHmacKey, local[0], localAad),
        requestDigest,
      };
    },
    open({ ciphertext, expectedAad, expectedRequestDigest }) {
      const key = args.localResultKeys.get(ciphertext.keyId);
      if (key === undefined) throw new Error('unknown-local-key');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(ciphertext.nonce, 'base64url'),
      );
      decipher.setAAD(localInvocationPromptAadBytes(expectedAad));
      decipher.setAuthTag(Buffer.from(ciphertext.authTag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      const requestDigest = requestDomainDigest(plaintext, args.resultHmacKey);
      if (requestDigest !== expectedRequestDigest) throw new Error('request-digest-mismatch');
      return { plaintext, requestDigest };
    },
  };
  const localResultAeadAuthority: LocalResultAeadAuthorityPort = {
    verify(ciphertext, expectedAad) {
      const key = args.localResultKeys.get(ciphertext.keyId);
      if (key === undefined) throw new Error('unknown-local-key');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(ciphertext.nonce, 'base64url'),
      );
      decipher.setAAD(localInvocationResultAadBytes(expectedAad));
      decipher.setAuthTag(Buffer.from(ciphertext.authTag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      return { resultDigest: resultDomainDigest(plaintext, args.resultHmacKey) };
    },
  };
  const brokerResultReencryptAuthority: BrokerResultReencryptAuthorityPort = {
    reencrypt({ localCiphertext, localAad, brokerAad }) {
      const key = args.localResultKeys.get(localCiphertext.keyId);
      if (key === undefined) throw new Error('unknown-local-key');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(localCiphertext.nonce, 'base64url'),
      );
      decipher.setAAD(localInvocationResultAadBytes(localAad));
      decipher.setAuthTag(Buffer.from(localCiphertext.authTag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(localCiphertext.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      return {
        ciphertext: encryptSensitive(plaintext.toString('utf8'), args.brokerContentKey, brokerAad),
        resultDigest: resultDomainDigest(plaintext, args.resultHmacKey),
      };
    },
  };
  const cloudAckAuthority: CloudInvocationAckAuthorityPort = {
    verify(input) {
      if ((input as { token?: string }).token !== 'cloud-committed') throw new Error('bad-ack');
      cloudAckCalls.count += 1;
      return { evidenceDigest: `sha256:${SHA('6')}` };
    },
  };
  return {
    hostReceiptCalls,
    cloudAckCalls,
    revokedCapabilityIds,
    cloudNow,
    options: {
      capabilityAuthority,
      readyConversationAuthority,
      hostDispatchPort,
      hostDispatchReceiptAuthority,
      hostInterruptPort: createHostInterruptPort(args.host.registry),
      hostInterruptReceiptAuthority: createHostInterruptReceiptAuthority(),
      localPromptAeadAuthority,
      localResultAeadAuthority,
      brokerResultReencryptAuthority,
      cloudAckAuthority,
      cloudClock: { now: () => new Date(cloudNow.value) },
    },
  };
}

async function commitCommand(
  adapter: SqliteWorkerBrokerDurableTransport,
  installationId: string,
  state: DurableBrokerConnection,
  rawEnvelope: unknown,
): Promise<DurableBrokerConnection> {
  const envelope = BrokerEnvelopeSchema.parse(rawEnvelope);
  const digest = canonicalSha256(envelope);
  const decision = consumeSequence(
    restoreSequenceCursor(state.inboundCursor),
    envelope,
    digest,
    Date.parse(envelope.sentAt),
  );
  if (decision.type !== 'ACCEPT') throw new Error('invalid-command-sequence');
  return adapter.commitInbound({
    installationId,
    ownerToken: OWNER,
    connectionId: state.connectionId,
    expectedInboundCursor: state.inboundCursor,
    nextInboundCursor: serializeSequenceCursor(decision.cursor),
    envelope,
    canonicalDigest: digest,
    signal: new AbortController().signal,
  });
}

async function commandReference(
  adapter: SqliteWorkerBrokerDurableTransport,
  installationId: string,
  state: DurableBrokerConnection,
  type: DurableInboundCommandCandidate['type'],
): Promise<DurableInboundCommandCandidate> {
  const rows = await adapter.readPendingCommands({
    installationId,
    ownerToken: OWNER,
    connectionId: state.connectionId,
    limit: 64,
    signal: new AbortController().signal,
  });
  const row = rows.find((candidate) => candidate.type === type);
  if (row === undefined) throw new Error(`missing-command:${type}`);
  return row;
}

function nextSequence(state: DurableBrokerConnection): string {
  return restoreSequenceCursor(state.inboundCursor).nextExpected.toString(10);
}

async function createVerticalFixture(seed: number): Promise<VerticalFixture> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'combo-host-composition-')));
  temporaryDirectories.add(directory);
  const filename = join(directory, 'journal-v1.sqlite');
  const nowMs = Date.now();
  const installationId = uuid(seed * 100 + 1);
  const deploymentId = uuid(seed * 100 + 2);
  const connectionId = uuid(seed * 100 + 3);
  const leaseId = uuid(seed * 100 + 4);
  const workerSessionId = uuid(seed * 100 + 5);
  const conversationId = uuid(seed * 100 + 6);
  const invocationId = uuid(seed * 100 + 7);
  const agentVersionId = uuid(seed * 100 + 8);
  const keyId = `worker-session-${seed}`;
  const contentKey = randomBytes(32);
  const localResultKey = randomBytes(32);
  const resultHmacKey = randomBytes(32);
  const localResultKeys = new Map([[`worker-keychain-v1-${seed}`, localResultKey]]);
  const requestDigest = requestDomainDigest(Buffer.from('secret prompt', 'utf8'), resultHmacKey);
  const lease = { deploymentId, leaseId, workerSessionId, fence: String(seed + 1) };
  const sentAt = new Date(nowMs - 1_000).toISOString();
  const expiresAt = new Date(nowMs + 60_000).toISOString();
  const adapter = new SqliteWorkerBrokerDurableTransport({
    filename,
    newJournalAuthorization: authorization(installationId),
  });
  const signal = new AbortController().signal;
  await adapter.acquireInstallation({ installationId, ownerToken: OWNER, signal });
  const grant = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'lease.grant',
    messageId: uuid(seed * 100 + 9),
    correlationId: deploymentId,
    connectionId,
    sequence: '0',
    sentAt,
    expiresAt,
    lease,
    body: { leaseExpiresAt: expiresAt, workerSessionId, generation: '1' },
  }) as Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  const grantDigest = canonicalSha256(grant);
  const grantDecision = consumeSequence(
    initialSequenceCursor(connectionId),
    grant,
    grantDigest,
    Date.parse(sentAt),
  );
  if (grantDecision.type !== 'ACCEPT') throw new Error('invalid-grant');
  let state = await adapter.activateConnection({
    installationId,
    ownerToken: OWNER,
    envelope: grant,
    canonicalDigest: grantDigest,
    inboundCursor: serializeSequenceCursor(grantDecision.cursor),
    signal,
  });
  const openEnvelope = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'conversation.open',
    messageId: uuid(seed * 100 + 10),
    correlationId: conversationId,
    connectionId,
    sequence: nextSequence(state),
    sentAt,
    expiresAt,
    lease,
    body: {
      conversationId,
      agentVersionId,
      agentVersionDigest: SHA('a'),
      snapshotDigest: SHA('b'),
      visibleTranscriptDigest: HMAC('c'),
      openAuthority: {
        deploymentId,
        installationId,
        workerSessionId,
        leaseId,
        fence: lease.fence,
      },
    },
  }) as Extract<BrokerEnvelope, { type: 'conversation.open' }>;
  state = await commitCommand(adapter, installationId, state, openEnvelope);
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const capability = signedCapability(
    {
      protocol: 'combo.execution-capability/1',
      schemaVersion: 1,
      capabilityId: uuid(seed * 100 + 11),
      invocationId,
      conversationId,
      deploymentId,
      agentVersionId,
      agentVersionDigest: SHA('a'),
      workerInstallationId: installationId,
      leaseId,
      fence: lease.fence,
      providerRequestId: uuid(seed * 100 + 12),
      requestDigest,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      budget: { maxInputTokens: 4096, maxOutputTokens: 1024, maxCostMicros: 1_000_000 },
      notBefore: new Date(nowMs - 2_000).toISOString(),
      expiresAt: new Date(nowMs + 55_000).toISOString(),
      nonce: Buffer.from(`capability-nonce-${seed}`, 'utf8').toString('base64url'),
      signatureAlgorithm: 'ES256',
      signatureEncoding: 'ieee-p1363',
      signature: 'A'.repeat(86),
    },
    keyPair.privateKey,
  );
  const prepareMessageId = uuid(seed * 100 + 13);
  const userCiphertext = encryptSensitive('secret prompt', contentKey, {
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    envelopeType: 'invocation.prepare',
    messageId: prepareMessageId,
    conversationId,
    invocationId,
    workerSessionId,
    role: 'USER',
    keyId,
  });
  const prepareEnvelope = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'invocation.prepare',
    messageId: prepareMessageId,
    correlationId: invocationId,
    connectionId,
    sequence: nextSequence(state),
    sentAt,
    expiresAt,
    lease,
    body: {
      invocationId,
      conversationId,
      clientMessageId: clientUuid(seed * 100 + 14),
      requestDigest,
      userMessageCiphertext: userCiphertext,
      agentVersionId,
      agentVersionDigest: SHA('a'),
      snapshotDigest: SHA('b'),
      deadlineAt: new Date(nowMs + 50_000).toISOString(),
      executionCapability: capability,
    },
  }) as Extract<BrokerEnvelope, { type: 'invocation.prepare' }>;
  state = await commitCommand(adapter, installationId, state, prepareEnvelope);
  const startEnvelope = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'invocation.start',
    messageId: uuid(seed * 100 + 15),
    correlationId: invocationId,
    connectionId,
    sequence: nextSequence(state),
    sentAt,
    expiresAt,
    lease,
    body: {
      invocationId,
      prepareCommandId: prepareMessageId,
      executionCapabilityId: capability.capabilityId,
    },
  }) as Extract<BrokerEnvelope, { type: 'invocation.start' }>;
  state = await commitCommand(adapter, installationId, state, startEnvelope);
  const host = new FakeCodexHost();
  host.registry.bindThread(conversationId, {
    id: 'thread-ready-001',
    generation: 1,
    workspaceRootsAcknowledged: true,
  });
  const authorities = createAuthorities({
    publicKey: keyPair.publicKey,
    brokerContentKey: contentKey,
    localResultKeys,
    resultHmacKey,
    host,
  });
  const journal = adapter.createInvocationJournal(authorities.options);
  const openReference = await commandReference(adapter, installationId, state, 'conversation.open');
  await journal.bindReadyConversation({
    installationId,
    ownerToken: OWNER,
    command: openReference,
    evidence: { token: 'sandbox-ready' },
    signal,
  });
  const [pending] = await journal.readPendingConversationReadyFacts({
    installationId,
    ownerToken: OWNER,
    limit: 1,
    signal,
  });
  if (pending === undefined) throw new Error('missing-pending-ready-fact');
  const delivery = await journal.enqueuePendingConversationReadyFact({
    installationId,
    ownerToken: OWNER,
    reference: pending,
    connectionId: state.connectionId,
    deliveryMessageId: uuid(seed * 100 + 16),
    signal,
  });
  const readyAck = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'ack',
    type: 'message.ack',
    messageId: uuid(seed * 100 + 17),
    correlationId: delivery.deliveryMessageId,
    connectionId: state.connectionId,
    sequence: nextSequence(state),
    sentAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lease: state.lease,
    body: {
      acknowledgedMessageId: delivery.deliveryMessageId,
      level: 'CLOUD_COMMITTED',
      decision: 'APPLIED',
    },
  });
  state = await commitCommand(adapter, installationId, state, readyAck);
  return {
    adapter,
    filename,
    installationId,
    conversationId,
    invocationId,
    state,
    keyId,
    contentKey,
    localResultKey,
    resultHmacKey,
    keyPair,
    host,
    registry: host.registry,
    journal,
  };
}

async function driveToCancelRequested(fixture: VerticalFixture): Promise<{
  cancelPermit: Extract<
    Awaited<ReturnType<SqliteWorkerInvocationJournal['cancel']>>,
    { action: 'INTERRUPT_ONCE' }
  >['permit'];
}> {
  const signal = new AbortController().signal;
  await driveToRunning(fixture, signal);
  const cancelEnvelope = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'invocation.cancel',
    messageId: uuid(999_900 + fixture.host.dispatchCount),
    correlationId: fixture.invocationId,
    connectionId: fixture.state.connectionId,
    sequence: nextSequence(fixture.state),
    sentAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lease: fixture.state.lease,
    body: { invocationId: fixture.invocationId, reason: 'CONSUMER_REQUEST' },
  }) as Extract<BrokerEnvelope, { type: 'invocation.cancel' }>;
  fixture.state = await commitCommand(
    fixture.adapter,
    fixture.installationId,
    fixture.state,
    cancelEnvelope,
  );
  const cancel = await fixture.journal.cancel({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    command: await commandReference(
      fixture.adapter,
      fixture.installationId,
      fixture.state,
      'invocation.cancel',
    ),
    signal,
  });
  if (cancel.action !== 'INTERRUPT_ONCE') throw new Error('missing-interrupt-permit');
  return { cancelPermit: cancel.permit };
}

async function driveToRunning(
  fixture: VerticalFixture,
  signal: AbortSignal = new AbortController().signal,
): Promise<Readonly<{ sourceEventId: string; factDigest: string; runtimeTurnId: string }>> {
  await fixture.journal.prepare({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    command: await commandReference(
      fixture.adapter,
      fixture.installationId,
      fixture.state,
      'invocation.prepare',
    ),
    signal,
  });
  const start = await fixture.journal.start({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    command: await commandReference(
      fixture.adapter,
      fixture.installationId,
      fixture.state,
      'invocation.start',
    ),
    signal,
  });
  if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-dispatch-permit');
  return fixture.journal.dispatchOnce({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    permit: start.permit,
    signal,
  });
}

function queryScalar(fixture: VerticalFixture, column: string): string | number | null {
  const database = new SqliteDatabase(fixture.filename, { readOnly: true });
  try {
    const row = database
      .prepare(`SELECT ${column} AS value FROM local_invocations WHERE invocation_id = ?`)
      .get(fixture.invocationId) as { value: string | number | null } | undefined;
    return row === undefined ? null : row.value;
  } finally {
    database.close();
  }
}

describe('Host composition vertical: real SQLite journal + composition ports + fake app-server', () => {
  it('cancels a RUNNING invocation with real HostTurnHandle interrupt evidence and persists the receipt', async () => {
    const fixture = await createVerticalFixture(401);
    const { cancelPermit } = await driveToCancelRequested(fixture);
    const signal = new AbortController().signal;
    // Dispatch lifecycle: the composition port registered the live handle under the
    // exact ready thread/turn, and the conversation thread binding is visible.
    expect(fixture.registry.lookup('thread-ready-001', 'turn-host-1')).toBeDefined();
    expect(fixture.registry.threadIdFor(fixture.conversationId)).toBe('thread-ready-001');
    // The authenticated prompt plaintext reached the Host and was never returned to callers.
    expect(fixture.host.dispatchedTexts).toEqual(['secret prompt']);
    const cancelled = await fixture.journal.interruptOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: cancelPermit,
      signal,
    });
    expect(cancelled).toMatchObject({ action: 'CANCELLED', replayed: false });
    expect(queryScalar(fixture, 'state')).toBe('CANCELLED');
    expect(queryScalar(fixture, 'interrupt_attempt_count')).toBe(1);
    expect(queryScalar(fixture, 'interrupt_confirmed_count')).toBe(1);
    const digest = queryScalar(fixture, 'interrupt_receipt_digest');
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const database = new SqliteDatabase(fixture.filename, { readOnly: true });
    let receiptJson: string | null = null;
    try {
      const row = database
        .prepare('SELECT receipt_json AS value FROM local_invocation_interrupt_receipts LIMIT 1')
        .get() as { value: string } | undefined;
      receiptJson = row === undefined ? null : row.value;
    } finally {
      database.close();
    }
    expect(receiptJson).not.toBeNull();
    const receipt = WorkerInterruptReceiptSchema.parse(JSON.parse(receiptJson!));
    expect(receipt).toMatchObject({
      outcome: 'INTERRUPTED',
      evidenceAuthority: 'HOST',
      runtimeThreadId: 'thread-ready-001',
      runtimeTurnId: 'turn-host-1',
      dispatchAttemptCount: 1,
    });
    expect(receipt.hostTerminalDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    // The durable digest covers the canonical receipt bytes; recompute and compare.
    expect(workerInterruptReceiptDigest(receipt)).toBe(digest);
    // Replaying the same permit returns the committed CANCELLED decision without a second Host call.
    const replay = await fixture.journal.interruptOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: cancelPermit,
      signal: new AbortController().signal,
    });
    expect(replay).toEqual({ ...cancelled, replayed: true });
    expect(queryScalar(fixture, 'interrupt_attempt_count')).toBe(1);
    expect(queryScalar(fixture, 'interrupt_confirmed_count')).toBe(1);
    fixture.adapter.close();
  });

  it('rejects an ACK-only Host response: no cancellation is fabricated and the invocation becomes UNCERTAIN', async () => {
    const fixture = await createVerticalFixture(402);
    const { cancelPermit } = await driveToCancelRequested(fixture);
    fixture.host.replaceProducer('thread-ready-001', 'turn-host-1', () => ({ token: 'ack-only' }));
    await expect(
      fixture.journal.interruptOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: cancelPermit,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('INTERRUPT_RECEIPT_INVALID');
    // The attempt is durable even though the receipt was rejected; the terminal is UNCERTAIN.
    expect(queryScalar(fixture, 'state')).toBe('UNCERTAIN');
    expect(queryScalar(fixture, 'interrupt_attempt_count')).toBe(1);
    expect(queryScalar(fixture, 'interrupt_confirmed_count')).toBe(0);
    expect(queryScalar(fixture, 'interrupt_receipt_digest')).toBeNull();
    fixture.adapter.close();
  });

  it('rejects a terminal raced from the wrong turn (binding mismatch) and never confirms it', async () => {
    const fixture = await createVerticalFixture(403);
    const { cancelPermit } = await driveToCancelRequested(fixture);
    // The fake host misbehaves and returns the terminal of a DIFFERENT turn.
    fixture.host.replaceProducer('thread-ready-001', 'turn-host-1', () =>
      createHostInterruptedTerminalEvidence({
        threadId: 'thread-ready-001',
        turnId: 'turn-host-2',
        status: 'interrupted',
        error: null,
        completedAt: Date.now(),
      }),
    );
    await expect(
      fixture.journal.interruptOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: cancelPermit,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('INTERRUPT_RECEIPT_INVALID');
    expect(queryScalar(fixture, 'state')).toBe('UNCERTAIN');
    expect(queryScalar(fixture, 'interrupt_confirmed_count')).toBe(0);
    expect(queryScalar(fixture, 'interrupt_receipt_digest')).toBeNull();
    fixture.adapter.close();
  });

  it('after process restart a recovered permit can never resolve a Host handle and converges to UNCERTAIN', async () => {
    const fixture = await createVerticalFixture(404);
    const { cancelPermit } = await driveToCancelRequested(fixture);
    const generationBefore = fixture.registry.generation;
    fixture.host.restart();
    expect(fixture.registry.generation).toBe(generationBefore + 1);
    expect(fixture.registry.lookup('thread-ready-001', 'turn-host-1')).toBeUndefined();
    await expect(
      fixture.journal.interruptOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: cancelPermit,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'HOST_TURN_NOT_IN_GENERATION' });
    expect(queryScalar(fixture, 'state')).toBe('UNCERTAIN');
    expect(queryScalar(fixture, 'interrupt_attempt_count')).toBe(1);
    expect(queryScalar(fixture, 'interrupt_confirmed_count')).toBe(0);
    fixture.adapter.close();
  });

  it('an aborted interrupt signal never reaches the Host handle', async () => {
    const fixture = await createVerticalFixture(405);
    const { cancelPermit } = await driveToCancelRequested(fixture);
    let hostCalls = 0;
    fixture.host.replaceProducer('thread-ready-001', 'turn-host-1', () => {
      hostCalls += 1;
      return createHostInterruptedTerminalEvidence({
        threadId: 'thread-ready-001',
        turnId: 'turn-host-1',
        status: 'interrupted',
        error: null,
        completedAt: Date.now(),
      });
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      fixture.journal.interruptOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: cancelPermit,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(hostCalls).toBe(0);
    fixture.adapter.close();
  });

  it('after restart a recovered dispatch permit can never start a turn (no ready thread) and converges to UNCERTAIN', async () => {
    const fixture = await createVerticalFixture(406);
    const signal = new AbortController().signal;
    await fixture.journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: await commandReference(
        fixture.adapter,
        fixture.installationId,
        fixture.state,
        'invocation.prepare',
      ),
      signal,
    });
    const start = await fixture.journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: await commandReference(
        fixture.adapter,
        fixture.installationId,
        fixture.state,
        'invocation.start',
      ),
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-dispatch-permit');
    // Process restart: the thread binding dies with the generation.
    fixture.host.restart();
    expect(fixture.registry.threadIdFor(fixture.conversationId)).toBeUndefined();
    await expect(
      fixture.journal.dispatchOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: start.permit,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'HOST_CONVERSATION_NOT_READY' });
    // No Host turn was ever started and the invocation honestly converges to UNCERTAIN.
    expect(fixture.host.dispatchedTexts).toHaveLength(0);
    expect(queryScalar(fixture, 'state')).toBe('UNCERTAIN');
    fixture.adapter.close();
  });

  it('durably confirms a Host dispatch when caller abort races after the Host accepted the turn', async () => {
    const fixture = await createVerticalFixture(407);
    const controller = new AbortController();
    fixture.host.abortAfterStart = controller;

    await expect(driveToRunning(fixture, controller.signal)).resolves.toMatchObject({
      runtimeTurnId: 'turn-host-1',
    });

    expect(controller.signal.aborted).toBe(true);
    expect(fixture.host.dispatchCount).toBe(1);
    expect(queryScalar(fixture, 'state')).toBe('RUNNING');
    expect(fixture.registry.bindingForInvocation(fixture.invocationId)).toMatchObject({
      invocationId: fixture.invocationId,
      turnId: 'turn-host-1',
    });
  });

  it('rejects malformed UTF-8 before starting a Host turn', async () => {
    const permit: OpaqueHostDispatchPermit = {
      installationId: uuid(405_001),
      deploymentId: uuid(405_002),
      leaseId: uuid(405_003),
      workerSessionId: uuid(405_004),
      fence: '405',
      invocationId: uuid(405_005),
      conversationId: uuid(405_006),
      startCommandId: uuid(405_007),
      dispatchNonce: uuid(405_008),
      agentVersionId: uuid(405_009),
      agentVersionDigest: SHA('a'),
      snapshotDigest: SHA('b'),
      requestDigest: HMAC('c'),
      executionCapabilityDigest: SHA('d'),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      sandboxInstanceId: uuid(405_010),
      runtimeThreadId: 'thread-ready-001',
    };
    const registry = new HostTurnRegistry();
    registry.bindThread(permit.conversationId, {
      id: permit.runtimeThreadId,
      generation: 1,
      workspaceRootsAcknowledged: true,
    });
    const host = new FakeCodexHost();
    const dispatch = createHostDispatchPort({ registry, host });

    await expect(
      dispatch.dispatchOnce(
        { permit, userMessage: Uint8Array.from([0xc3, 0x28]) },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'HOST_PROMPT_INVALID' });
    expect(host.dispatchCount).toBe(0);
  });

  it('dispatch receipt authority rejects malformed or misbound receipts and produces canonical digests', async () => {
    const expected: HostDispatchExpectedBinding = {
      installationId: uuid(406_001),
      deploymentId: uuid(406_008),
      leaseId: uuid(406_009),
      workerSessionId: uuid(406_010),
      fence: '406',
      invocationId: uuid(406_002),
      conversationId: uuid(406_003),
      startCommandId: uuid(406_004),
      dispatchNonce: uuid(406_005),
      agentVersionId: uuid(406_006),
      agentVersionDigest: SHA('a'),
      snapshotDigest: SHA('b'),
      requestDigest: HMAC('c'),
      executionCapabilityDigest: SHA('d'),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      sandboxInstanceId: uuid(406_007),
      runtimeThreadId: 'thread-ready-001',
    };
    const registry = new HostTurnRegistry();
    const thread = {
      id: expected.runtimeThreadId,
      generation: 1,
      workspaceRootsAcknowledged: true,
    } as const;
    const handle: HostTurnHandleLike = {
      turnId: Promise.resolve('turn-host-1'),
      result: Promise.resolve({ text: 'done' }),
      terminal: Promise.resolve(
        createHostTurnTerminalEvidence({
          threadId: thread.id,
          turnId: 'turn-host-1',
          outcome: 'SUCCEEDED',
          errorCode: null,
          terminalStatus: 'completed',
          terminalError: 'NONE',
          outputState: 'USABLE',
          completedAt: Date.now(),
        }),
      ),
      interrupt: async () => {
        throw new Error('never-called');
      },
    };
    registry.bindThread(expected.conversationId, thread);
    registry.register({
      permit: expected,
      thread,
      turnId: 'turn-host-1',
      handle,
    });
    const authority = createHostDispatchReceiptAuthority({
      registry,
      sandboxAttestationDigest: (binding) =>
        `sha256:${createHash('sha256')
          .update(
            `${binding.sandboxInstanceId}/${binding.runtimeThreadId}/${binding.runtimeTurnId}/${binding.hostGeneration}`,
          )
          .digest('hex')}`,
    });
    const receipt = {
      protocol: HOST_DISPATCH_RECEIPT_PROTOCOL,
      schemaVersion: 1,
      ...expected,
      runtimeTurnId: 'turn-host-1',
      hostGeneration: 1,
      workspaceRootsAcknowledged: true,
    } as const;
    const verified = authority.verify(receipt, expected, new Date());
    expect(verified.runtimeTurnId).toBe('turn-host-1');
    expect(verified.sandboxAttestationDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(verified.dispatchReceiptDigest).toBe(
      `sha256:${createHash('sha256')
        .update(
          canonicalizeJson({
            receipt,
            sandboxAttestationDigest: `sha256:${createHash('sha256')
              .update(`${expected.sandboxInstanceId}/thread-ready-001/turn-host-1/1`)
              .digest('hex')}`,
          }),
          'utf8',
        )
        .digest('hex')}`,
    );
    for (const candidate of [
      null,
      { token: 'ack-only' },
      { ...receipt, runtimeThreadId: 42 },
      { ...receipt, runtimeTurnId: undefined },
    ]) {
      let thrown: unknown;
      try {
        authority.verify(candidate, expected, new Date());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        name: 'HostCompositionError',
        code: 'HOST_DISPATCH_RECEIPT_INVALID',
      });
    }
    // A receipt for a different ready thread is a binding mismatch and must be rejected.
    let mismatched: unknown;
    try {
      authority.verify({ ...receipt, runtimeThreadId: 'thread-ready-002' }, expected, new Date());
    } catch (error) {
      mismatched = error;
    }
    expect(mismatched).toMatchObject({
      name: 'HostCompositionError',
      code: 'HOST_DISPATCH_BINDING_MISMATCH',
    });
    for (const key of [
      'installationId',
      'deploymentId',
      'leaseId',
      'workerSessionId',
      'fence',
      'invocationId',
      'conversationId',
      'startCommandId',
      'dispatchNonce',
      'agentVersionId',
      'agentVersionDigest',
      'snapshotDigest',
      'requestDigest',
      'executionCapabilityDigest',
      'deadlineAt',
      'sandboxInstanceId',
    ] as const) {
      expect(() =>
        authority.verify({ ...receipt, [key]: `changed-${key}` }, expected, new Date()),
      ).toThrowError(expect.objectContaining({ code: 'HOST_DISPATCH_BINDING_MISMATCH' }));
    }
    expect(() =>
      authority.verify({ ...receipt, hostGeneration: 2 }, expected, new Date()),
    ).toThrowError(expect.objectContaining({ code: 'HOST_DISPATCH_BINDING_MISMATCH' }));
    expect(() =>
      authority.verify({ ...receipt, workspaceRootsAcknowledged: false }, expected, new Date()),
    ).toThrowError(expect.objectContaining({ code: 'HOST_DISPATCH_RECEIPT_INVALID' }));
    registry.clear();
    expect(() => authority.verify(receipt, expected, new Date())).toThrowError(
      expect.objectContaining({ code: 'HOST_DISPATCH_BINDING_MISMATCH' }),
    );
  });

  it('emits a canonical invocation.cancelled fact bound to the durable interrupt receipt', async () => {
    const fixture = await createVerticalFixture(407);
    const { cancelPermit } = await driveToCancelRequested(fixture);
    await fixture.journal.interruptOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: cancelPermit,
      signal: new AbortController().signal,
    });
    const pending = await fixture.journal.readPendingFacts({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      limit: 8,
      signal: new AbortController().signal,
    });
    const cancelled = pending.find((fact) => fact.eventType === 'invocation.cancelled');
    expect(cancelled).toBeDefined();
    if (cancelled === undefined) throw new Error('missing-cancelled-outbox-fact');
    const database = new SqliteDatabase(fixture.filename, { readOnly: true });
    let factJson: string | null = null;
    let factDigest: string | null = null;
    let receiptDigest: string | null = null;
    let receiptJson: string | null = null;
    try {
      const row = database
        .prepare(
          'SELECT fact_json, fact_digest FROM local_invocation_outbox WHERE source_event_id = ?',
        )
        .get(cancelled.sourceEventId) as { fact_json: string; fact_digest: string } | undefined;
      factJson = row === undefined ? null : row.fact_json;
      factDigest = row === undefined ? null : row.fact_digest;
      const receiptRow = database
        .prepare(
          'SELECT receipt_json, receipt_digest FROM local_invocation_interrupt_receipts WHERE invocation_id = ?',
        )
        .get(fixture.invocationId) as { receipt_json: string; receipt_digest: string } | undefined;
      receiptJson = receiptRow === undefined ? null : receiptRow.receipt_json;
      receiptDigest = receiptRow === undefined ? null : receiptRow.receipt_digest;
    } finally {
      database.close();
    }
    expect(factJson).not.toBeNull();
    expect(factDigest).toMatch(/^[a-f0-9]{64}$/u);
    const fact = WorkerInvocationCancelledFactSchema.parse(JSON.parse(factJson!));
    expect(fact).toMatchObject({
      type: 'invocation.cancelled',
      sourceEventId: fixture.invocationId,
      invocationId: fixture.invocationId,
    });
    // The outbound fact digest is the canonical Worker fact digest computed over the fact object.
    expect(workerInvocationFactDigest(fact)).toBe(factDigest);
    expect(cancelled.factDigest).toBe(factDigest);
    // The fact's interruptReceiptDigest is the durable receipt digest (sha256: prefixed), so the
    // Cloud DB authority can recompute the canonical fact digest and the receipt stays bound.
    expect(receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(fact.interruptReceiptDigest).toBe(receiptDigest);
    expect(receiptJson).not.toBeNull();
    const receipt = WorkerInterruptReceiptSchema.parse(JSON.parse(receiptJson!));
    expect(workerInterruptReceiptDigest(receipt)).toBe(receiptDigest);
    fixture.adapter.close();
  });

  it('classifies Host terminal results conservatively and keeps the binding until durable commit', async () => {
    const registry = new HostTurnRegistry();
    const thread = {
      id: 'thread-terminal',
      generation: 1,
      workspaceRootsAcknowledged: true,
    } as const;
    const conversationId = uuid(409_001);
    const permit = hostPermit(409_010, conversationId, thread.id);
    registry.bindThread(conversationId, thread);
    const successHandle: HostTurnHandleLike = {
      turnId: Promise.resolve('turn-success'),
      result: Promise.resolve({ text: 'sealed answer' }),
      terminal: Promise.resolve(
        createHostTurnTerminalEvidence({
          threadId: thread.id,
          turnId: 'turn-success',
          outcome: 'SUCCEEDED',
          errorCode: null,
          terminalStatus: 'completed',
          terminalError: 'NONE',
          outputState: 'USABLE',
          completedAt: Date.now(),
        }),
      ),
      interrupt: async () => {
        throw new Error('never-called');
      },
    };
    const successBinding = registry.register({
      permit,
      thread,
      turnId: 'turn-success',
      handle: successHandle,
    });
    const success = await observeHostTerminal(registry, permit.invocationId);
    expect(success).toMatchObject({ outcome: 'SUCCEEDED', result: { text: 'sealed answer' } });
    expect(registry.bindingForInvocation(permit.invocationId)).toBe(successBinding);
    if (success.outcome !== 'SUCCEEDED') throw new Error('missing-success');
    let sealedPlaintext = '';
    let sealedAad: unknown;
    const sealedCiphertext = {
      token: 'sealed-result',
    } as unknown as LocalInvocationResultCiphertext;
    const sealer: LocalResultAeadSealerPort = {
      seal(plaintext, expectedAad) {
        sealedPlaintext = Buffer.from(plaintext).toString('utf8');
        sealedAad = expectedAad;
        return sealedCiphertext;
      },
    };
    expect(sealHostTerminalResult(success, sealer)).toBe(sealedCiphertext);
    expect(sealedPlaintext).toBe('sealed answer');
    expect(sealedAad).toEqual({
      schemaVersion: 1,
      installationId: permit.installationId,
      invocationId: permit.invocationId,
      conversationId: permit.conversationId,
      agentVersionDigest: permit.agentVersionDigest,
      role: 'ASSISTANT',
    });

    const failedPermit = hostPermit(409_100, uuid(409_101), 'thread-terminal-failed');
    const failedThread = { ...thread, id: failedPermit.runtimeThreadId };
    registry.bindThread(failedPermit.conversationId, failedThread);
    registry.register({
      permit: failedPermit,
      thread: failedThread,
      turnId: 'turn-failed',
      handle: {
        turnId: Promise.resolve('turn-failed'),
        result: new Promise(() => undefined),
        terminal: Promise.resolve(
          createHostTurnTerminalEvidence({
            threadId: failedThread.id,
            turnId: 'turn-failed',
            outcome: 'FAILED',
            errorCode: 'TURN_FAILED',
            terminalStatus: 'failed',
            terminalError: 'PRESENT',
            outputState: 'NOT_APPLICABLE',
            completedAt: Date.now(),
          }),
        ),
        interrupt: async () =>
          createHostInterruptedTerminalEvidence({
            threadId: failedThread.id,
            turnId: 'turn-failed',
            status: 'interrupted',
            error: null,
            completedAt: Date.now(),
          }),
      },
    });
    await expect(observeHostTerminal(registry, failedPermit.invocationId)).resolves.toMatchObject({
      outcome: 'FAILED',
      errorCode: 'TURN_FAILED',
    });

    const lostPermit = hostPermit(409_200, uuid(409_201), 'thread-terminal-lost');
    const lostThread = { ...thread, id: lostPermit.runtimeThreadId };
    registry.bindThread(lostPermit.conversationId, lostThread);
    registry.register({
      permit: lostPermit,
      thread: lostThread,
      turnId: 'turn-lost',
      handle: {
        turnId: Promise.resolve('turn-lost'),
        result: new Promise(() => undefined),
        terminal: Promise.reject(new Error('host terminal evidence lost')),
        interrupt: async () => {
          throw new Error('never-called');
        },
      },
    });
    await expect(observeHostTerminal(registry, lostPermit.invocationId)).resolves.toMatchObject({
      outcome: 'UNCERTAIN',
      reason: 'HOST_EVIDENCE_LOST',
    });
  });

  it('the registry is process-generation bound: entries die with clear() and IDs can be reused only in a new generation', () => {
    const registry = new HostTurnRegistry();
    const thread = {
      id: 'thread-a',
      generation: 1,
      workspaceRootsAcknowledged: true,
    } as const;
    const permit = {
      installationId: uuid(410_010),
      deploymentId: uuid(410_011),
      leaseId: uuid(410_012),
      workerSessionId: uuid(410_013),
      fence: '410',
      invocationId: uuid(410_002),
      conversationId: uuid(410_001),
      startCommandId: uuid(410_014),
      dispatchNonce: uuid(410_015),
      agentVersionId: uuid(410_016),
      agentVersionDigest: SHA('a'),
      snapshotDigest: SHA('b'),
      requestDigest: HMAC('c'),
      executionCapabilityDigest: SHA('d'),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      sandboxInstanceId: uuid(410_017),
      runtimeThreadId: thread.id,
    } as const;
    registry.bindThread(uuid(410_001), thread);
    const first: HostTurnHandleLike = {
      turnId: Promise.resolve('turn-1'),
      result: Promise.resolve({ text: 'done' }),
      terminal: Promise.resolve(
        createHostTurnTerminalEvidence({
          threadId: thread.id,
          turnId: 'turn-1',
          outcome: 'SUCCEEDED',
          errorCode: null,
          terminalStatus: 'completed',
          terminalError: 'NONE',
          outputState: 'USABLE',
          completedAt: Date.now(),
        }),
      ),
      interrupt: async () => {
        throw new Error('never-called');
      },
    };
    expect(registry.generation).toBe(0);
    const firstBinding = registry.register({
      permit,
      thread,
      turnId: 'turn-1',
      handle: first,
    });
    expect(registry.lookup('thread-a', 'turn-1')).toBe(first);
    expect(registry.lookup('thread-a', 'turn-2')).toBeUndefined();
    expect(registry.unregister({ ...firstBinding })).toBe(false);
    expect(registry.lookup('thread-a', 'turn-1')).toBe(first);
    expect(registry.unregister(firstBinding)).toBe(true);
    expect(registry.lookup('thread-a', 'turn-1')).toBeUndefined();
    registry.register({
      permit,
      thread,
      turnId: 'turn-1',
      handle: first,
    });
    registry.clear();
    expect(registry.generation).toBe(1);
    expect(registry.lookup('thread-a', 'turn-1')).toBeUndefined();
    // Same IDs in a new generation are distinct entries.
    const second: HostTurnHandleLike = {
      turnId: Promise.resolve('turn-1'),
      result: Promise.resolve({ text: 'done again' }),
      terminal: Promise.resolve(
        createHostTurnTerminalEvidence({
          threadId: thread.id,
          turnId: 'turn-1',
          outcome: 'SUCCEEDED',
          errorCode: null,
          terminalStatus: 'completed',
          terminalError: 'NONE',
          outputState: 'USABLE',
          completedAt: Date.now(),
        }),
      ),
      interrupt: async () => {
        throw new Error('never-called');
      },
    };
    registry.bindThread(uuid(410_001), thread);
    registry.register({
      permit,
      thread,
      turnId: 'turn-1',
      handle: second,
    });
    expect(registry.lookup('thread-a', 'turn-1')).toBe(second);
    expect(() =>
      registry.bindThread(uuid(410_003), {
        id: 'thread-b',
        generation: 2,
        workspaceRootsAcknowledged: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'HOST_CONVERSATION_BINDING_CONFLICT' }));
    expect(() =>
      registry.bindThread(uuid(410_004), {
        id: 'thread-c',
        generation: 1,
        workspaceRootsAcknowledged: false,
      }),
    ).toThrowError(expect.objectContaining({ code: 'HOST_THREAD_INVALID' }));
    expect(() =>
      registry.bindThread(uuid(410_005), {
        id: 'thread\u0000collision',
        generation: 1,
        workspaceRootsAcknowledged: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'HOST_THREAD_INVALID' }));
    expect(() =>
      registry.register({
        permit: { ...permit, invocationId: uuid(410_006) },
        thread,
        turnId: 'turn\u0000collision',
        handle: second,
      }),
    ).toThrowError(expect.objectContaining({ code: 'HOST_TURN_INVALID' }));
  });
});
