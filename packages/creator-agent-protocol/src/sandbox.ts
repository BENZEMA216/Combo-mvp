import { z } from 'zod';
import { canonicalizeJson } from './canonical.js';
import {
  Base64UrlSchema,
  IsoDateTimeSchema,
  P256P1363SignatureSchema,
  Sha256DigestSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  Utf8TextSchema,
  UuidSchema,
} from './primitives.js';
import { verifyP256P1363Signature, type P256PublicKeyInput } from './signatures.js';

export const SANDBOX_SPEC_PROTOCOL = 'combo.sandbox-spec/1' as const;
export const SANDBOX_ATTESTATION_PROTOCOL = 'combo.sandbox-attestation/1' as const;

export const SandboxAdapterSchema = z.enum(['apple-container', 'lima-vz']);
export type SandboxAdapter = z.infer<typeof SandboxAdapterSchema>;

export const SandboxSpecSchema = z
  .object({
    protocol: z.literal(SANDBOX_SPEC_PROTOCOL),
    schemaVersion: z.literal(1),
    adapter: SandboxAdapterSchema,
    adapterVersion: Utf8TextSchema(128),
    imageDigest: Sha256DigestSchema,
    codexArtifactDigest: Sha256DigestSchema,
    codexProtocolSchemaDigest: Sha256DigestSchema,
    platform: z.literal('linux-arm64'),
    lifecycle: z
      .object({
        isolationUnit: z.literal('conversation'),
        idleTtlSeconds: z.literal(600),
        writableStateReuse: z.literal('forbidden'),
        reconstruction: z.literal('visible-transcript-only'),
      })
      .strict(),
    resources: z
      .object({
        vcpu: z.literal(2),
        memoryBytes: z.literal(2_147_483_648),
        scratchBytes: z.literal(268_435_456),
        pids: z.literal(256),
        fileDescriptors: z.literal(256),
        turnDeadlineSeconds: z.literal(120),
      })
      .strict(),
    mounts: z
      .object({
        context: z.literal('/agent/context:ro,noexec'),
        scratch: z.literal('/agent/scratch:rw,conversation-only'),
        temporary: z.literal('/tmp:rw,conversation-only'),
        hostMounts: z.literal('none'),
      })
      .strict(),
    runtimeCapabilities: z
      .object({
        contextTools: z.tuple([
          z.literal('read_context'),
          z.literal('list_context'),
          z.literal('search_context'),
        ]),
        shell: z.literal(false),
        interpreters: z.literal(false),
        compilers: z.literal(false),
        dynamicLoaders: z.literal(false),
        externalTools: z.literal(false),
      })
      .strict(),
    network: z
      .object({
        ingress: z.literal('deny-all'),
        egress: z.literal('model-proxy-only'),
        dns: z.literal('disabled'),
        proxyTransport: z.enum(['vsock', 'protected-ipc']),
      })
      .strict(),
  })
  .strict();
export type SandboxSpec = z.infer<typeof SandboxSpecSchema>;

const SandboxAttestationUnsignedShape = {
  protocol: z.literal(SANDBOX_ATTESTATION_PROTOCOL),
  schemaVersion: z.literal(1),
  adapter: SandboxAdapterSchema,
  adapterVersion: Utf8TextSchema(128),
  sandboxInstanceId: UuidSchema,
  conversationId: UuidSchema,
  invocationId: UuidSchema,
  workerSessionId: UuidSchema,
  leaseId: UuidSchema,
  fencingToken: Uint63StringSchema,
  bootNonce: Base64UrlSchema.min(22).max(128),
  sandboxImageDigest: Sha256DigestSchema,
  codexImageDigest: Sha256DigestSchema,
  codexVersion: Utf8TextSchema(128),
  protocolSchemaDigest: Sha256DigestSchema,
  agentVersionDigest: Sha256HexSchema,
  snapshotDigest: Sha256HexSchema,
  behaviorDigest: Sha256HexSchema,
  runtimePolicyDigest: Sha256HexSchema,
  ioContractDigest: Sha256HexSchema,
  noHostHomeMount: z.literal(true),
  contextReadOnly: z.literal(true),
  contextNoExec: z.literal(true),
  noLongLivedCredential: z.literal(true),
  projectExecution: z.literal('closed-world-context-tools-only'),
  egressMode: z.literal('model-proxy-only'),
  proxyTransportBinding: Base64UrlSchema.min(22).max(256),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  destroyed: z.literal(false),
  signatureAlgorithm: z.literal('P-256-ECDSA-SHA256'),
  signatureEncoding: z.literal('ieee-p1363'),
};

function refineAttestationWindow(
  attestation: { createdAt: string; expiresAt: string },
  context: z.RefinementCtx,
): void {
  if (Date.parse(attestation.expiresAt) <= Date.parse(attestation.createdAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'expiresAt 必须晚于 createdAt',
    });
  }
}

const SandboxAttestationUnsignedObjectSchema = z.object(SandboxAttestationUnsignedShape).strict();

export const SandboxAttestationUnsignedSchema =
  SandboxAttestationUnsignedObjectSchema.superRefine(refineAttestationWindow);
export type SandboxAttestationUnsigned = z.infer<typeof SandboxAttestationUnsignedSchema>;

export const SandboxAttestationSchema = z
  .object({
    ...SandboxAttestationUnsignedShape,
    supervisorSignature: P256P1363SignatureSchema,
  })
  .strict()
  .superRefine(refineAttestationWindow);
export type SandboxAttestation = z.infer<typeof SandboxAttestationSchema>;

export function sandboxAttestationSigningBytes(
  attestation: SandboxAttestation | SandboxAttestationUnsigned,
): Buffer {
  const { supervisorSignature: _signature, ...unsigned } = attestation as SandboxAttestation;
  return Buffer.from(canonicalizeJson(SandboxAttestationUnsignedSchema.parse(unsigned)), 'utf8');
}

const ATTESTATION_BOUND_FIELDS = [
  'adapter',
  'adapterVersion',
  'sandboxInstanceId',
  'conversationId',
  'invocationId',
  'workerSessionId',
  'leaseId',
  'fencingToken',
  'bootNonce',
  'sandboxImageDigest',
  'codexImageDigest',
  'codexVersion',
  'protocolSchemaDigest',
  'agentVersionDigest',
  'snapshotDigest',
  'behaviorDigest',
  'runtimePolicyDigest',
  'ioContractDigest',
  'proxyTransportBinding',
] as const satisfies readonly (keyof SandboxAttestation)[];

export type ExpectedAttestationBinding = Pick<
  SandboxAttestation,
  (typeof ATTESTATION_BOUND_FIELDS)[number]
>;

const ExpectedAttestationBindingSchema = SandboxAttestationUnsignedObjectSchema.pick(
  Object.fromEntries(ATTESTATION_BOUND_FIELDS.map((key) => [key, true])) as Record<
    (typeof ATTESTATION_BOUND_FIELDS)[number],
    true
  >,
);

export function attestationBindingFrom(
  attestation: SandboxAttestation,
): ExpectedAttestationBinding {
  return Object.fromEntries(
    ATTESTATION_BOUND_FIELDS.map((key) => [key, attestation[key]]),
  ) as ExpectedAttestationBinding;
}

export type AttestationBindingResult =
  | { ok: true; attestation: SandboxAttestation }
  | { ok: false; code: 'SANDBOX_ATTESTATION_FAILED'; reasons: string[] };

export function validateAttestationBinding(
  input: unknown,
  expected: ExpectedAttestationBinding,
  now: Date,
  activeInstances: ReadonlySet<string>,
  registeredSupervisorPublicKey: P256PublicKeyInput,
): AttestationBindingResult {
  const expectedBinding = ExpectedAttestationBindingSchema.safeParse(expected);
  if (!expectedBinding.success) {
    return { ok: false, code: 'SANDBOX_ATTESTATION_FAILED', reasons: ['expected-binding'] };
  }
  const parsed = SandboxAttestationSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'SANDBOX_ATTESTATION_FAILED', reasons: ['schema'] };
  }

  if (
    !verifyP256P1363Signature(
      sandboxAttestationSigningBytes(parsed.data),
      parsed.data.supervisorSignature,
      registeredSupervisorPublicKey,
    )
  ) {
    return { ok: false, code: 'SANDBOX_ATTESTATION_FAILED', reasons: ['signature'] };
  }

  const reasons: string[] = [];
  for (const key of ATTESTATION_BOUND_FIELDS) {
    if (parsed.data[key] !== expectedBinding.data[key]) reasons.push(`binding:${key}`);
  }
  if (!activeInstances.has(`${parsed.data.sandboxInstanceId}:${parsed.data.bootNonce}`)) {
    reasons.push('instance-not-active');
  }
  if (Date.parse(parsed.data.createdAt) > now.getTime()) reasons.push('not-yet-valid');
  if (Date.parse(parsed.data.expiresAt) <= now.getTime()) reasons.push('expired');

  return reasons.length === 0
    ? { ok: true, attestation: parsed.data }
    : { ok: false, code: 'SANDBOX_ATTESTATION_FAILED', reasons };
}
