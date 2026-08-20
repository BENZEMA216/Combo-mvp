import {
  BrokerEnvelopeSchema,
  BrokerSensitiveMessageSchema,
  ClientIdempotencyKeySchema,
  ExecutionCapabilitySchema,
  HmacSha256DigestSchema,
  IsoDateTimeSchema,
  LeaseBindingSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  UuidSchema,
  executionCapabilityDigest,
  type BrokerEnvelope,
  type BrokerSensitiveMessage,
} from '@cb/creator-agent-protocol';
import type { EncryptedMessage, MessageAad } from '@cb/creator-agent-persistence';
import { z } from 'zod';

export const BROKER_LIFECYCLE_PAYLOAD_CONTRACT_VERSION = 2 as const;

const LifecycleAuthoritySchema = z
  .object({
    deploymentId: UuidSchema,
    installationId: UuidSchema,
    leaseId: UuidSchema,
    fence: Uint63StringSchema,
  })
  .strict();

const LifecycleSourceShape = {
  payloadContractVersion: z.literal(BROKER_LIFECYCLE_PAYLOAD_CONTRACT_VERSION),
  commandId: UuidSchema,
  invocationId: UuidSchema,
  executionAuthority: LifecycleAuthoritySchema,
} as const;

const InvocationPrepareSourceSchema = z
  .object({
    ...LifecycleSourceShape,
    type: z.literal('invocation.prepare'),
    conversationId: UuidSchema,
    clientMessageId: ClientIdempotencyKeySchema,
    requestDigest: HmacSha256DigestSchema,
    agentVersionId: UuidSchema,
    agentVersionDigest: Sha256HexSchema,
    snapshotDigest: Sha256HexSchema,
    deadlineAt: IsoDateTimeSchema,
    executionCapability: ExecutionCapabilitySchema,
    executionCapabilityDigest: Sha256HexSchema,
  })
  .strict();

const InvocationStartSourceSchema = z
  .object({
    ...LifecycleSourceShape,
    type: z.literal('invocation.start'),
    conversationId: UuidSchema,
    requestDigest: HmacSha256DigestSchema,
    agentVersionId: UuidSchema,
    agentVersionDigest: Sha256HexSchema,
    prepareCommandId: UuidSchema,
    executionCapabilityId: UuidSchema,
    executionCapability: ExecutionCapabilitySchema,
    executionCapabilityDigest: Sha256HexSchema,
  })
  .strict();

export const BrokerLifecycleCommandSourceV2Schema = z.discriminatedUnion('type', [
  InvocationPrepareSourceSchema,
  InvocationStartSourceSchema,
]);
export type BrokerLifecycleCommandSourceV2 = z.infer<typeof BrokerLifecycleCommandSourceV2Schema>;

export const BrokerLifecycleDeliveryAuthoritySchema = z
  .object({
    connectionId: UuidSchema,
    sequence: Uint63StringSchema,
    sentAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    lease: LeaseBindingSchema,
  })
  .strict();
export type BrokerLifecycleDeliveryAuthority = z.infer<
  typeof BrokerLifecycleDeliveryAuthoritySchema
>;

export type BrokerLifecycleCommand = Extract<
  BrokerEnvelope,
  { type: 'invocation.prepare' | 'invocation.start' }
>;

/** Product boundary used to re-seal one durable USER message for one exact Worker transport. */
export type GatewayUserMessageSealInput = Readonly<{
  creatorId: string;
  installationId: string;
  durableMessage: EncryptedMessage;
  durableAad: MessageAad;
  command: Readonly<{
    messageId: string;
    conversationId: string;
    invocationId: string;
    workerSessionId: string;
  }>;
  signal: AbortSignal;
}>;

export type GatewayUserMessageSealer = (
  input: GatewayUserMessageSealInput,
) => Promise<BrokerSensitiveMessage>;

/**
 * Converts an immutable Cloud payload-v2 source into the existing Broker wire-v1 command.
 *
 * This boundary deliberately accepts no v0/v1 lifecycle source and no future command variant.
 * The outer Lease may be a replacement transport Lease, while executionAuthority remains the
 * immutable Invocation assignment bound by the signed capability.
 */
export function materializeBrokerLifecycleCommandV2(
  rawSource: unknown,
  rawDelivery: unknown,
  rawPreparedUserMessage?: unknown,
): BrokerLifecycleCommand {
  const source = BrokerLifecycleCommandSourceV2Schema.parse(rawSource);
  const delivery = BrokerLifecycleDeliveryAuthoritySchema.parse(rawDelivery);
  if (delivery.lease.deploymentId !== source.executionAuthority.deploymentId) {
    throw new TypeError('LIFECYCLE_DELIVERY_DEPLOYMENT_MISMATCH');
  }
  if (Date.parse(delivery.expiresAt) <= Date.parse(delivery.sentAt)) {
    throw new TypeError('LIFECYCLE_DELIVERY_WINDOW_INVALID');
  }
  if (source.type === 'invocation.start' && rawPreparedUserMessage !== undefined) {
    throw new TypeError('LIFECYCLE_UNEXPECTED_SENSITIVE_PAYLOAD');
  }

  let body: Record<string, unknown>;
  if (source.type === 'invocation.prepare') {
    const userMessageCiphertext = BrokerSensitiveMessageSchema.parse(rawPreparedUserMessage);
    if (
      userMessageCiphertext.aad.envelopeType !== 'invocation.prepare' ||
      userMessageCiphertext.aad.messageId !== source.commandId ||
      userMessageCiphertext.aad.conversationId !== source.conversationId ||
      userMessageCiphertext.aad.invocationId !== source.invocationId ||
      userMessageCiphertext.aad.workerSessionId !== delivery.lease.workerSessionId ||
      userMessageCiphertext.aad.role !== 'USER'
    ) {
      throw new TypeError('LIFECYCLE_PREPARE_AAD_MISMATCH');
    }
    const capability = source.executionCapability;
    if (
      executionCapabilityDigest(capability) !== source.executionCapabilityDigest ||
      capability.invocationId !== source.invocationId ||
      capability.conversationId !== source.conversationId ||
      capability.deploymentId !== source.executionAuthority.deploymentId ||
      capability.workerInstallationId !== source.executionAuthority.installationId ||
      capability.leaseId !== source.executionAuthority.leaseId ||
      capability.fence !== source.executionAuthority.fence ||
      capability.requestDigest !== source.requestDigest ||
      capability.agentVersionId !== source.agentVersionId ||
      capability.agentVersionDigest !== source.agentVersionDigest ||
      Date.parse(source.deadlineAt) > Date.parse(capability.expiresAt) ||
      Date.parse(delivery.sentAt) < Date.parse(capability.notBefore) ||
      Date.parse(delivery.expiresAt) > Date.parse(source.deadlineAt) ||
      Date.parse(delivery.expiresAt) > Date.parse(capability.expiresAt)
    ) {
      throw new TypeError('LIFECYCLE_PREPARE_AUTHORITY_MISMATCH');
    }
    body = {
      invocationId: source.invocationId,
      conversationId: source.conversationId,
      clientMessageId: source.clientMessageId,
      requestDigest: source.requestDigest,
      userMessageCiphertext,
      agentVersionId: source.agentVersionId,
      agentVersionDigest: source.agentVersionDigest,
      snapshotDigest: source.snapshotDigest,
      deadlineAt: source.deadlineAt,
      executionCapability: capability,
    };
  } else {
    const capability = source.executionCapability;
    if (
      executionCapabilityDigest(capability) !== source.executionCapabilityDigest ||
      capability.capabilityId !== source.executionCapabilityId ||
      capability.invocationId !== source.invocationId ||
      capability.conversationId !== source.conversationId ||
      capability.deploymentId !== source.executionAuthority.deploymentId ||
      capability.workerInstallationId !== source.executionAuthority.installationId ||
      capability.leaseId !== source.executionAuthority.leaseId ||
      capability.fence !== source.executionAuthority.fence ||
      capability.requestDigest !== source.requestDigest ||
      capability.agentVersionId !== source.agentVersionId ||
      capability.agentVersionDigest !== source.agentVersionDigest ||
      Date.parse(delivery.sentAt) < Date.parse(capability.notBefore) ||
      Date.parse(delivery.expiresAt) > Date.parse(capability.expiresAt)
    ) {
      throw new TypeError('LIFECYCLE_START_AUTHORITY_MISMATCH');
    }
    body = {
      invocationId: source.invocationId,
      prepareCommandId: source.prepareCommandId,
      executionCapabilityId: source.executionCapabilityId,
    };
  }

  const envelope = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: source.type,
    messageId: source.commandId,
    correlationId: source.invocationId,
    connectionId: delivery.connectionId,
    sequence: delivery.sequence,
    sentAt: delivery.sentAt,
    expiresAt: delivery.expiresAt,
    lease: delivery.lease,
    body,
  });
  if (envelope.type !== 'invocation.prepare' && envelope.type !== 'invocation.start') {
    throw new TypeError('LIFECYCLE_COMMAND_VARIANT_INVALID');
  }
  return envelope;
}
