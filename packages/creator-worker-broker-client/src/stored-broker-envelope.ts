import {
  BrokerCommandSchema,
  BrokerEnvelopeSchema,
  canonicalSha256,
  canonicalizeJson,
  parseJsonNoDuplicateKeys,
  type BrokerCommand,
  type BrokerEnvelope,
} from '@cb/creator-agent-protocol';

const LEGACY_CONVERSATION_OPEN_BODY_KEYS = Object.freeze([
  'agentVersionDigest',
  'agentVersionId',
  'conversationId',
  'snapshotDigest',
  'visibleTranscriptDigest',
] as const);
const STORAGE_ONLY_INSTALLATION_PLACEHOLDER = '00000000-0000-7000-8000-000000000000';

export type StoredBrokerTransportAuthority = Readonly<{
  installationId: string;
  connectionId: string;
  deploymentId: string;
  workerSessionId: string;
  leaseId: string;
  fence: string;
}>;

export type StoredBrokerConversationAuthority = Readonly<{
  conversationId: string;
  installationId: string;
  deploymentId: string;
  workerSessionId: string;
  leaseId: string;
  fence: string;
  agentVersionId: string;
  agentVersionDigest: string;
  snapshotDigest: string;
  openCommandId: string;
  openConnectionId: string;
  openSequence: string;
}>;

type LegacyConversationOpenBody = Readonly<{
  conversationId: string;
  agentVersionId: string;
  agentVersionDigest: string;
  snapshotDigest: string;
  visibleTranscriptDigest: string;
}>;

type LegacyConversationOpenCommand = Omit<
  Extract<BrokerCommand, { type: 'conversation.open' }>,
  'body'
> &
  Readonly<{ body: LegacyConversationOpenBody }>;

export type DecodedStoredBrokerEnvelope =
  | Readonly<{
      format: 'current-v1';
      envelope: BrokerEnvelope;
      canonicalDigest: string;
      logicalDigest: string;
    }>
  | Readonly<{
      format: 'c687-conversation-open-v1';
      envelope: LegacyConversationOpenCommand;
      canonicalDigest: string;
      logicalDigest: string;
    }>;

/**
 * Storage-only compatibility for c687 Worker journals. Live Broker frames must continue to use
 * parseBrokerFrame/BrokerEnvelopeSchema and must never call this decoder.
 */
export function decodeStoredBrokerEnvelope(
  serialized: string,
  expectedDigest: string,
): DecodedStoredBrokerEnvelope {
  const raw = parseJsonNoDuplicateKeys(serialized);
  if (canonicalizeJson(raw) !== serialized || canonicalSha256(raw) !== expectedDigest) {
    throw new Error('stored-envelope-canonical-mismatch');
  }

  const current = BrokerEnvelopeSchema.safeParse(raw);
  if (current.success) {
    return Object.freeze({
      format: 'current-v1' as const,
      envelope: current.data,
      canonicalDigest: expectedDigest,
      logicalDigest: storedEnvelopeLogicalDigest(current.data),
    });
  }

  const legacy = parseLegacyConversationOpen(raw);
  return Object.freeze({
    format: 'c687-conversation-open-v1' as const,
    envelope: legacy,
    canonicalDigest: expectedDigest,
    logicalDigest: storedEnvelopeLogicalDigest(legacy),
  });
}

/**
 * Projects a validated legacy storage record into the current in-memory command shape only after
 * binding its exact outer transport authority and immutable local conversation authority.
 */
export function materializeStoredBrokerEnvelope(
  stored: DecodedStoredBrokerEnvelope,
  transport: StoredBrokerTransportAuthority,
  conversation?: StoredBrokerConversationAuthority,
  expectedLegacyLogicalDigest?: string,
): BrokerEnvelope {
  const outer = stored.envelope;
  if (
    outer.connectionId !== transport.connectionId ||
    outer.lease.deploymentId !== transport.deploymentId
  ) {
    throw new Error('stored-envelope-transport-authority-mismatch');
  }

  if (stored.format === 'current-v1') {
    const envelope = stored.envelope;
    if (envelope.type !== 'conversation.open') return envelope;
    const authority = envelope.body.openAuthority;
    if (authority.installationId !== transport.installationId) {
      throw new Error('stored-envelope-installation-mismatch');
    }
    if (conversation !== undefined) {
      assertConversationBinding(envelope, conversation);
    }
    return envelope;
  }

  const envelope = stored.envelope;
  if (
    conversation === undefined ||
    expectedLegacyLogicalDigest === undefined ||
    stored.logicalDigest !== expectedLegacyLogicalDigest ||
    conversation.installationId !== transport.installationId ||
    conversation.deploymentId !== transport.deploymentId
  ) {
    throw new Error('stored-envelope-legacy-authority-missing-or-mismatched');
  }
  const isOriginalFrame =
    conversation.openConnectionId === envelope.connectionId &&
    conversation.openSequence === envelope.sequence;
  if (
    isOriginalFrame &&
    (conversation.workerSessionId !== envelope.lease.workerSessionId ||
      conversation.leaseId !== envelope.lease.leaseId ||
      conversation.fence !== envelope.lease.fence)
  ) {
    throw new Error('stored-envelope-legacy-original-authority-mismatch');
  }
  const authority = Object.freeze({
    installationId: conversation.installationId,
    deploymentId: conversation.deploymentId,
    workerSessionId: conversation.workerSessionId,
    leaseId: conversation.leaseId,
    fence: conversation.fence,
  });
  const projected = BrokerCommandSchema.parse({
    ...envelope,
    body: { ...envelope.body, openAuthority: authority },
  });
  if (projected.type !== 'conversation.open') {
    throw new Error('stored-envelope-legacy-projection');
  }
  if (conversation !== undefined) assertConversationBinding(projected, conversation);
  return projected;
}

function parseLegacyConversationOpen(input: unknown): LegacyConversationOpenCommand {
  if (!isRecord(input) || input.kind !== 'command' || input.type !== 'conversation.open') {
    throw new Error('stored-envelope-unsupported');
  }
  if (!isRecord(input.body) || !hasExactKeys(input.body, LEGACY_CONVERSATION_OPEN_BODY_KEYS)) {
    throw new Error('stored-envelope-legacy-body-shape');
  }
  if (!isRecord(input.lease)) throw new Error('stored-envelope-legacy-lease');

  const injected = BrokerCommandSchema.parse({
    ...input,
    body: {
      ...input.body,
      openAuthority: {
        deploymentId: input.lease.deploymentId,
        installationId: STORAGE_ONLY_INSTALLATION_PLACEHOLDER,
        workerSessionId: input.lease.workerSessionId,
        leaseId: input.lease.leaseId,
        fence: input.lease.fence,
      },
    },
  });
  if (
    injected.type !== 'conversation.open' ||
    Date.parse(injected.expiresAt) <= Date.parse(injected.sentAt)
  ) {
    throw new Error('stored-envelope-legacy-refinement');
  }
  const { openAuthority: _storageOnly, ...body } = injected.body;
  return Object.freeze({ ...injected, body: Object.freeze(body) });
}

function assertConversationBinding(
  envelope: Extract<BrokerCommand, { type: 'conversation.open' }>,
  conversation: StoredBrokerConversationAuthority,
): void {
  if (
    envelope.messageId !== conversation.openCommandId ||
    envelope.body.conversationId !== conversation.conversationId ||
    envelope.body.agentVersionId !== conversation.agentVersionId ||
    envelope.body.agentVersionDigest !== conversation.agentVersionDigest ||
    envelope.body.snapshotDigest !== conversation.snapshotDigest ||
    envelope.body.openAuthority.installationId !== conversation.installationId ||
    envelope.body.openAuthority.deploymentId !== conversation.deploymentId ||
    envelope.body.openAuthority.workerSessionId !== conversation.workerSessionId ||
    envelope.body.openAuthority.leaseId !== conversation.leaseId ||
    envelope.body.openAuthority.fence !== conversation.fence
  ) {
    throw new Error('stored-envelope-conversation-authority-mismatch');
  }
}

function storedEnvelopeLogicalDigest(envelope: BrokerEnvelope | LegacyConversationOpenCommand) {
  const body =
    envelope.kind === 'command' && envelope.type === 'invocation.prepare'
      ? (({ userMessageCiphertext: _rewrapped, ...semanticBody }) => semanticBody)(envelope.body)
      : envelope.body;
  return canonicalSha256({
    protocol: envelope.protocol,
    schemaVersion: envelope.schemaVersion,
    kind: envelope.kind,
    type: envelope.type,
    messageId: envelope.messageId,
    correlationId: envelope.correlationId,
    body,
  });
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function hasExactKeys<const Key extends string>(
  input: Record<string, unknown>,
  expected: readonly Key[],
): input is Record<Key, unknown> {
  const actual = Object.keys(input).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
