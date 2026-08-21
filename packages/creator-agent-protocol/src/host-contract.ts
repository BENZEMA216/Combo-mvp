import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { canonicalFingerprint } from './canonical.js';
import {
  HostGenerationSchema,
  HostInterruptRequestIdSchema,
  HostMessageIdSchema,
  HostThreadIdSchema,
  HostTurnIdSchema,
  Sha256DigestSchema,
  containsLoneSurrogate,
  type HostTurnId,
} from './primitives.js';

export const HOST_TURN_TERMINAL_PROTOCOL = 'combo.creator-host-turn-terminal/1' as const;
export const HOST_INTERRUPT_REQUEST_PROTOCOL = 'combo.creator-host-interrupt-request/1' as const;
export const HOST_INTERRUPT_WRITE_LINEARIZED = 'HOST_INTERRUPT_WRITE_LINEARIZED' as const;
export const MAX_HOST_RESULT_UTF8_BYTES = 20_000;

const HOST_TURN_RESULT_FINGERPRINT_DOMAIN = 'combo.creator-host-turn-result/1' as const;

declare const terminalEvidenceTypeBrand: unique symbol;
declare const terminalOutcomeTypeBrand: unique symbol;
declare const interruptSentTypeBrand: unique symbol;

export const HostThreadSchema = z
  .object({
    id: HostThreadIdSchema,
    generation: HostGenerationSchema,
    workspaceRootsAcknowledged: z.literal(true),
  })
  .strict()
  .brand<'HostThread'>()
  .readonly();
export type HostThread = z.infer<typeof HostThreadSchema>;

const HostPromptSchema = z
  .string()
  .min(1)
  .refine((value) => !containsLoneSurrogate(value), 'Host prompt contains a lone surrogate')
  .brand<'HostPrompt'>();

export const HostStartTurnInputSchema = z
  .object({
    thread: HostThreadSchema,
    messageId: HostMessageIdSchema,
    text: HostPromptSchema,
    timeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .brand<'HostStartTurnInput'>()
  .readonly();
export type HostStartTurnInput = z.infer<typeof HostStartTurnInputSchema>;

const HostResultTextSchema = z
  .string()
  .max(MAX_HOST_RESULT_UTF8_BYTES)
  .refine((value) => value.trim().length > 0, 'Host result must contain non-whitespace text')
  .refine((value) => !containsLoneSurrogate(value), 'Host result contains a lone surrogate')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_HOST_RESULT_UTF8_BYTES,
    `Host result exceeds ${MAX_HOST_RESULT_UTF8_BYTES} UTF-8 bytes`,
  )
  .brand<'HostResultText'>();

export const HostTurnResultSchema = z
  .object({ text: HostResultTextSchema })
  .strict()
  .brand<'HostTurnResult'>()
  .readonly();
export type HostTurnResult = z.infer<typeof HostTurnResultSchema>;

const terminalBase = {
  thread: HostThreadSchema,
  turnId: HostTurnIdSchema,
  completedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
} as const;

export const HostSettledTerminalObservationSchema = z
  .union([
    z
      .object({
        ...terminalBase,
        terminalStatus: z.literal('completed'),
        terminalError: z.literal('NONE'),
        outputState: z.literal('USABLE'),
      })
      .strict(),
    z
      .object({
        ...terminalBase,
        terminalStatus: z.literal('completed'),
        terminalError: z.literal('NONE'),
        outputState: z.literal('UNUSABLE'),
      })
      .strict(),
    z
      .object({
        ...terminalBase,
        terminalStatus: z.literal('failed'),
        terminalError: z.literal('PRESENT'),
        outputState: z.literal('NOT_APPLICABLE'),
      })
      .strict(),
  ])
  .readonly();
export type HostSettledTerminalObservation = z.infer<typeof HostSettledTerminalObservationSchema>;

export const HostInterruptedTerminalObservationSchema = z
  .object({
    ...terminalBase,
    terminalStatus: z.literal('interrupted'),
    terminalError: z.literal('NONE'),
    outputState: z.literal('NOT_APPLICABLE'),
  })
  .strict()
  .readonly();
export type HostInterruptedTerminalObservation = z.infer<
  typeof HostInterruptedTerminalObservationSchema
>;

export const HostInterruptReasonSchema = z.enum(['USER_CANCEL', 'TIMEOUT']);
export type HostInterruptReason = z.infer<typeof HostInterruptReasonSchema>;

const interruptWriteRequestSchema = z
  .object({
    protocol: z.literal(HOST_INTERRUPT_REQUEST_PROTOCOL),
    requestId: HostInterruptRequestIdSchema,
    reason: HostInterruptReasonSchema,
    thread: HostThreadSchema,
    turnId: HostTurnIdSchema,
  })
  .strict()
  .readonly();
export type HostInterruptWriteRequest = z.infer<typeof interruptWriteRequestSchema>;

const interruptRequestPayloadSchema = interruptWriteRequestSchema.unwrap().extend({
  disposition: z.literal('SENT'),
});
type HostInterruptRequestPayload = z.infer<typeof interruptRequestPayloadSchema>;

export type HostInterruptSentReceipt = Readonly<
  HostInterruptRequestPayload & { readonly [interruptSentTypeBrand]: never }
>;

export type HostInterruptDisposition =
  | HostInterruptSentReceipt
  | Readonly<{
      disposition: 'TERMINAL_ALREADY_OBSERVED';
      thread: HostThread;
      turnId: HostTurnId;
    }>;

const terminalEvidenceBase = {
  protocol: z.literal(HOST_TURN_TERMINAL_PROTOCOL),
  thread: HostThreadSchema,
  turnId: HostTurnIdSchema,
  completedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
} as const;

const succeededEvidencePreimageSchema = z
  .object({
    ...terminalEvidenceBase,
    outcome: z.literal('SUCCEEDED'),
    errorCode: z.null(),
    terminalStatus: z.literal('completed'),
    terminalError: z.literal('NONE'),
    outputState: z.literal('USABLE'),
    resultFingerprint: Sha256DigestSchema,
    interruptRequest: z.null(),
  })
  .strict();

const failedOutputEvidencePreimageSchema = z
  .object({
    ...terminalEvidenceBase,
    outcome: z.literal('FAILED'),
    errorCode: z.literal('TURN_FAILED'),
    terminalStatus: z.literal('completed'),
    terminalError: z.literal('NONE'),
    outputState: z.literal('UNUSABLE'),
    resultFingerprint: z.null(),
    interruptRequest: z.null(),
  })
  .strict();

const failedRuntimeEvidencePreimageSchema = z
  .object({
    ...terminalEvidenceBase,
    outcome: z.literal('FAILED'),
    errorCode: z.literal('TURN_FAILED'),
    terminalStatus: z.literal('failed'),
    terminalError: z.literal('PRESENT'),
    outputState: z.literal('NOT_APPLICABLE'),
    resultFingerprint: z.null(),
    interruptRequest: z.null(),
  })
  .strict();

const failedTimeoutEvidencePreimageSchema = z
  .object({
    ...terminalEvidenceBase,
    outcome: z.literal('FAILED'),
    errorCode: z.literal('TURN_TIMEOUT'),
    terminalStatus: z.literal('interrupted'),
    terminalError: z.literal('NONE'),
    outputState: z.literal('NOT_APPLICABLE'),
    resultFingerprint: z.null(),
    interruptRequest: interruptRequestPayloadSchema.extend({ reason: z.literal('TIMEOUT') }),
  })
  .strict();

const failedEvidencePreimageSchema = z.union([
  failedOutputEvidencePreimageSchema,
  failedRuntimeEvidencePreimageSchema,
  failedTimeoutEvidencePreimageSchema,
]);

const cancelledEvidencePreimageSchema = z
  .object({
    ...terminalEvidenceBase,
    outcome: z.literal('CANCELLED'),
    errorCode: z.null(),
    terminalStatus: z.literal('interrupted'),
    terminalError: z.literal('NONE'),
    outputState: z.literal('NOT_APPLICABLE'),
    resultFingerprint: z.null(),
    interruptRequest: interruptRequestPayloadSchema.extend({ reason: z.literal('USER_CANCEL') }),
  })
  .strict();

const hostTurnTerminalEvidencePreimageSchema = z.union([
  succeededEvidencePreimageSchema,
  failedEvidencePreimageSchema,
  cancelledEvidencePreimageSchema,
]);
type HostTurnTerminalEvidencePreimage = z.infer<typeof hostTurnTerminalEvidencePreimageSchema>;

const succeededEvidenceSchema = succeededEvidencePreimageSchema.extend({
  terminalFingerprint: Sha256DigestSchema,
});
const failedEvidenceSchema = z.union([
  failedOutputEvidencePreimageSchema.extend({ terminalFingerprint: Sha256DigestSchema }),
  failedRuntimeEvidencePreimageSchema.extend({ terminalFingerprint: Sha256DigestSchema }),
  failedTimeoutEvidencePreimageSchema.extend({ terminalFingerprint: Sha256DigestSchema }),
]);
const cancelledEvidenceSchema = cancelledEvidencePreimageSchema.extend({
  terminalFingerprint: Sha256DigestSchema,
});

const hostTurnTerminalEvidenceIntegritySchema = z
  .union([succeededEvidenceSchema, failedEvidenceSchema, cancelledEvidenceSchema])
  .superRefine((evidence, context) => {
    if (
      evidence.interruptRequest !== null &&
      (!sameHostThread(evidence.thread, evidence.interruptRequest.thread) ||
        evidence.turnId !== evidence.interruptRequest.turnId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['interruptRequest'],
        message: 'interrupt request does not bind this Host turn',
      });
    }
    if (
      fingerprintTerminalPreimage(withoutTerminalFingerprint(evidence)) !==
      evidence.terminalFingerprint
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terminalFingerprint'],
        message: 'Host terminal fingerprint mismatch',
      });
    }
  });

type HostTurnTerminalEvidencePayload = z.infer<typeof hostTurnTerminalEvidenceIntegritySchema>;
type EvidenceTypeBrand = { readonly [terminalEvidenceTypeBrand]: never };

type HostTurnTerminalEvidence = Readonly<HostTurnTerminalEvidencePayload & EvidenceTypeBrand>;
type HostSucceededTerminalEvidence = Readonly<
  Extract<HostTurnTerminalEvidencePayload, { outcome: 'SUCCEEDED' }> & EvidenceTypeBrand
>;
type HostFailedTerminalEvidence = Readonly<
  Extract<HostTurnTerminalEvidencePayload, { outcome: 'FAILED' }> & EvidenceTypeBrand
>;
type HostCancelledTerminalEvidence = Readonly<
  Extract<HostTurnTerminalEvidencePayload, { outcome: 'CANCELLED' }> & EvidenceTypeBrand
>;

type OutcomeTypeBrand = { readonly [terminalOutcomeTypeBrand]: never };
export type HostTurnOutcome =
  | Readonly<
      {
        terminal: HostSucceededTerminalEvidence;
        result: HostTurnResult;
      } & OutcomeTypeBrand
    >
  | Readonly<
      {
        terminal: HostFailedTerminalEvidence | HostCancelledTerminalEvidence;
        result: null;
      } & OutcomeTypeBrand
    >;

export const HostTurnEvidenceLostReasonSchema = z.enum([
  'HOST_PROTOCOL_ERROR',
  'HOST_SESSION_LOST',
  'HOST_TERMINAL_MISSING',
]);
export type HostTurnEvidenceLostReason = z.infer<typeof HostTurnEvidenceLostReasonSchema>;

export class HostTurnEvidenceLostError extends Error {
  public readonly code = 'HOST_TURN_EVIDENCE_LOST' as const;
  public readonly reason: HostTurnEvidenceLostReason;

  public constructor(reason: HostTurnEvidenceLostReason) {
    super('Host turn terminal evidence was lost.');
    this.name = 'HostTurnEvidenceLostError';
    this.reason = HostTurnEvidenceLostReasonSchema.parse(reason);
  }
}

export class HostTurnNotStartedError extends Error {
  public readonly code = 'HOST_TURN_NOT_STARTED' as const;

  public constructor() {
    super('The Host adapter proved that no Host turn was started.');
    this.name = 'HostTurnNotStartedError';
  }
}

export class HostInterruptNotSentError extends Error {
  public readonly code = 'HOST_INTERRUPT_NOT_SENT' as const;

  public constructor() {
    super('The Host adapter proved that no interrupt request was sent.');
    this.name = 'HostInterruptNotSentError';
  }
}

export interface HostTurnHandle {
  readonly thread: HostThread;
  readonly turnId: HostTurnId;
  /** The only terminal authority. A rejection must be HostTurnEvidenceLostError. */
  readonly outcome: Promise<HostTurnOutcome>;
  /** Verify an outcome against this exact handle's private authority and return a frozen clone. */
  verifyOutcome(input: unknown): HostTurnOutcome;
  /**
   * The first successfully linearized write is latched. Later calls return that same receipt;
   * terminal-first calls return TERMINAL_ALREADY_OBSERVED without writing. The method never
   * returns a second terminal authority.
   */
  interrupt(reason: HostInterruptReason): Promise<HostInterruptDisposition>;
}

export interface CreatorHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  createThread(): Promise<HostThread>;
  /**
   * Resolves only after the adapter has an exact thread-generation/turn binding. Rejection must
   * be HostTurnNotStartedError when zero Host call is proved, otherwise HostTurnEvidenceLostError.
   */
  startTurn(input: HostStartTurnInput): Promise<HostTurnHandle>;
}

export type HostInterruptWriter = (
  request: HostInterruptWriteRequest,
) => typeof HOST_INTERRUPT_WRITE_LINEARIZED;

export interface HostTurnAdapterController {
  readonly handle: HostTurnHandle;
  settle(rawObservation: unknown, rawResult: unknown): HostTurnOutcome;
  settleInterrupted(rawObservation: unknown): HostTurnOutcome;
  markEvidenceLost(reason: HostTurnEvidenceLostReason): void;
}

export function sameHostThread(left: HostThread, right: HostThread): boolean {
  return (
    left.id === right.id &&
    left.generation === right.generation &&
    left.workspaceRootsAcknowledged === right.workspaceRootsAcknowledged
  );
}

/**
 * Creates one handle-private authority. The writer must synchronously return only at its exact
 * Host IPC write-linearization point and must not re-enter this controller.
 */
export function createHostTurnAdapterController(
  input: Readonly<{
    thread: HostThread;
    turnId: HostTurnId;
    writeInterrupt: HostInterruptWriter;
  }>,
): HostTurnAdapterController {
  const thread = HostThreadSchema.parse(input.thread);
  const turnId = HostTurnIdSchema.parse(input.turnId);
  const writeInterrupt = input.writeInterrupt;
  if (typeof writeInterrupt !== 'function') {
    throw new TypeError('Host interrupt writer must be a function.');
  }
  const trustedTerminalEvidence = new WeakSet<object>();
  const trustedTerminalOutcomes = new WeakSet<object>();
  const trustedInterruptReceipts = new WeakSet<object>();

  let state: 'OPEN' | 'SETTLED' | 'EVIDENCE_LOST' = 'OPEN';
  let sentReceipt: HostInterruptSentReceipt | undefined;
  let evidenceLostError: HostTurnEvidenceLostError | undefined;
  let interruptWriteInProgress = false;
  let resolveOutcome!: (outcome: HostTurnOutcome) => void;
  let rejectOutcome!: (error: HostTurnEvidenceLostError) => void;
  const outcomePromise = new Promise<HostTurnOutcome>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  void outcomePromise.catch(() => undefined);

  const markEvidenceLost = (reason: HostTurnEvidenceLostReason): void => {
    if (state !== 'OPEN') return;
    evidenceLostError = new HostTurnEvidenceLostError(reason);
    state = 'EVIDENCE_LOST';
    rejectOutcome(evidenceLostError);
  };
  const currentState = (): typeof state => state;

  const assertTerminalMaySettle = (): void => {
    if (interruptWriteInProgress) {
      markEvidenceLost('HOST_PROTOCOL_ERROR');
      throw evidenceLostError;
    }
    if (state === 'SETTLED') throw new TypeError('Host turn terminal was already settled.');
    if (currentState() === 'EVIDENCE_LOST') throw evidenceLostError;
  };

  const latchOutcome = (outcome: HostTurnOutcome): HostTurnOutcome => {
    state = 'SETTLED';
    resolveOutcome(outcome);
    return outcome;
  };

  const settle = (rawObservation: unknown, rawResult: unknown): HostTurnOutcome => {
    assertTerminalMaySettle();
    try {
      return latchOutcome(
        createSettledOutcome(
          rawObservation,
          { thread, turnId },
          rawResult,
          trustedTerminalEvidence,
          trustedTerminalOutcomes,
        ),
      );
    } catch {
      markEvidenceLost('HOST_PROTOCOL_ERROR');
      throw evidenceLostError;
    }
  };

  const settleInterrupted = (rawObservation: unknown): HostTurnOutcome => {
    assertTerminalMaySettle();
    if (sentReceipt === undefined) {
      markEvidenceLost('HOST_PROTOCOL_ERROR');
      throw evidenceLostError;
    }
    try {
      return latchOutcome(
        createInterruptedOutcome(
          rawObservation,
          { thread, turnId },
          sentReceipt,
          trustedTerminalEvidence,
          trustedTerminalOutcomes,
        ),
      );
    } catch {
      markEvidenceLost('HOST_PROTOCOL_ERROR');
      throw evidenceLostError;
    }
  };

  const verifyOutcome = (candidate: unknown): HostTurnOutcome =>
    verifyTurnOutcome(
      candidate,
      { thread, turnId },
      sentReceipt,
      trustedTerminalEvidence,
      trustedTerminalOutcomes,
    );

  const interrupt = async (rawReason: HostInterruptReason): Promise<HostInterruptDisposition> => {
    const reason = HostInterruptReasonSchema.parse(rawReason);
    if (sentReceipt !== undefined) return sentReceipt;
    if (state === 'SETTLED') return terminalAlreadyObserved(thread, turnId);
    if (currentState() === 'EVIDENCE_LOST') throw evidenceLostError;
    if (interruptWriteInProgress) {
      markEvidenceLost('HOST_PROTOCOL_ERROR');
      throw evidenceLostError;
    }

    const request = interruptWriteRequestSchema.parse({
      protocol: HOST_INTERRUPT_REQUEST_PROTOCOL,
      requestId: HostInterruptRequestIdSchema.parse(randomUUID()),
      reason,
      thread,
      turnId,
    });
    interruptWriteInProgress = true;
    let writeResult: unknown;
    try {
      writeResult = writeInterrupt(request);
    } catch (error) {
      interruptWriteInProgress = false;
      if (currentState() === 'EVIDENCE_LOST') throw evidenceLostError;
      if (error instanceof HostInterruptNotSentError) throw error;
      const lost =
        error instanceof HostTurnEvidenceLostError
          ? error
          : new HostTurnEvidenceLostError('HOST_PROTOCOL_ERROR');
      markEvidenceLost(lost.reason);
      throw evidenceLostError;
    }
    interruptWriteInProgress = false;
    if (currentState() === 'EVIDENCE_LOST') throw evidenceLostError;
    if (writeResult !== HOST_INTERRUPT_WRITE_LINEARIZED) {
      markEvidenceLost('HOST_PROTOCOL_ERROR');
      throw evidenceLostError;
    }
    const receipt = interruptRequestPayloadSchema.parse({ ...request, disposition: 'SENT' });
    sentReceipt = markTrusted(receipt, trustedInterruptReceipts) as HostInterruptSentReceipt;
    return sentReceipt;
  };

  const handle: HostTurnHandle = Object.freeze({
    thread,
    turnId,
    outcome: outcomePromise,
    verifyOutcome,
    interrupt,
  });
  return Object.freeze({ handle, settle, settleInterrupted, markEvidenceLost });
}

function verifyTurnOutcome(
  input: unknown,
  expected: Readonly<{ thread: HostThread; turnId: HostTurnId }>,
  sentReceipt: HostInterruptSentReceipt | undefined,
  terminalAuthority: WeakSet<object>,
  outcomeAuthority: WeakSet<object>,
): HostTurnOutcome {
  assertTrusted(input, outcomeAuthority, 'Host turn outcome');
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Host turn outcome must be an object.');
  }
  const candidate = input as Readonly<{ terminal?: unknown; result?: unknown }>;
  const terminal = verifyTerminalEvidence(
    candidate.terminal,
    expected,
    sentReceipt,
    terminalAuthority,
  );
  if (terminal.outcome === 'SUCCEEDED') {
    const result = HostTurnResultSchema.parse(candidate.result);
    if (fingerprintResult(result) !== terminal.resultFingerprint) {
      throw new TypeError('Host result fingerprint mismatch.');
    }
    return markOutcome(
      { terminal: terminal as HostSucceededTerminalEvidence, result },
      outcomeAuthority,
    );
  }
  if (candidate.result !== null) {
    throw new TypeError('Non-success Host outcome must not carry result text.');
  }
  return markOutcome(
    {
      terminal: terminal as HostFailedTerminalEvidence | HostCancelledTerminalEvidence,
      result: null,
    },
    outcomeAuthority,
  );
}

function verifyTerminalEvidence(
  input: unknown,
  expected: Readonly<{ thread: HostThread; turnId: HostTurnId }>,
  sentReceipt: HostInterruptSentReceipt | undefined,
  authority: WeakSet<object>,
): HostTurnTerminalEvidence {
  assertTrusted(input, authority, 'Host terminal evidence');
  const evidence = hostTurnTerminalEvidenceIntegritySchema.parse(input);
  assertObservationBinding(evidence, expected);
  if (
    evidence.interruptRequest !== null &&
    (sentReceipt === undefined || !sameInterruptRequest(evidence.interruptRequest, sentReceipt))
  ) {
    throw new TypeError('Host terminal evidence does not bind this handle interrupt receipt.');
  }
  return markEvidence(evidence, authority);
}

function createSettledOutcome(
  rawObservation: unknown,
  expected: Readonly<{ thread: HostThread; turnId: HostTurnId }>,
  rawResult: unknown,
  terminalAuthority: WeakSet<object>,
  outcomeAuthority: WeakSet<object>,
): HostTurnOutcome {
  const observation = HostSettledTerminalObservationSchema.parse(rawObservation);
  assertObservationBinding(observation, expected);
  if (observation.outputState === 'USABLE') {
    const result = HostTurnResultSchema.parse(rawResult);
    const terminal = markEvidence(
      evidenceWithFingerprint({
        protocol: HOST_TURN_TERMINAL_PROTOCOL,
        ...observation,
        outcome: 'SUCCEEDED',
        errorCode: null,
        resultFingerprint: fingerprintResult(result),
        interruptRequest: null,
      }),
      terminalAuthority,
    ) as HostSucceededTerminalEvidence;
    return markOutcome({ terminal, result }, outcomeAuthority);
  }
  if (rawResult !== null) {
    throw new TypeError('Failed Host outcome must not carry result text.');
  }
  const terminal = markEvidence(
    evidenceWithFingerprint({
      protocol: HOST_TURN_TERMINAL_PROTOCOL,
      ...observation,
      outcome: 'FAILED',
      errorCode: 'TURN_FAILED',
      resultFingerprint: null,
      interruptRequest: null,
    }),
    terminalAuthority,
  ) as HostFailedTerminalEvidence;
  return markOutcome({ terminal, result: null }, outcomeAuthority);
}

function createInterruptedOutcome(
  rawObservation: unknown,
  expected: Readonly<{ thread: HostThread; turnId: HostTurnId }>,
  receipt: HostInterruptSentReceipt,
  terminalAuthority: WeakSet<object>,
  outcomeAuthority: WeakSet<object>,
): HostTurnOutcome {
  const observation = HostInterruptedTerminalObservationSchema.parse(rawObservation);
  assertObservationBinding(observation, expected);
  if (!sameHostThread(receipt.thread, expected.thread) || receipt.turnId !== expected.turnId) {
    throw new TypeError('Sent interrupt receipt does not bind the observed Host turn.');
  }
  const terminal = markEvidence(
    evidenceWithFingerprint({
      protocol: HOST_TURN_TERMINAL_PROTOCOL,
      ...observation,
      outcome: receipt.reason === 'USER_CANCEL' ? 'CANCELLED' : 'FAILED',
      errorCode: receipt.reason === 'USER_CANCEL' ? null : 'TURN_TIMEOUT',
      resultFingerprint: null,
      interruptRequest: receiptPayload(receipt),
    }),
    terminalAuthority,
  );
  if (terminal.outcome === 'CANCELLED') {
    return markOutcome(
      { terminal: terminal as HostCancelledTerminalEvidence, result: null },
      outcomeAuthority,
    );
  }
  return markOutcome(
    { terminal: terminal as HostFailedTerminalEvidence, result: null },
    outcomeAuthority,
  );
}

function evidenceWithFingerprint(input: unknown): HostTurnTerminalEvidencePayload {
  const preimage = hostTurnTerminalEvidencePreimageSchema.parse(input);
  return hostTurnTerminalEvidenceIntegritySchema.parse({
    ...preimage,
    terminalFingerprint: fingerprintTerminalPreimage(preimage),
  });
}

function withoutTerminalFingerprint(
  evidence: HostTurnTerminalEvidencePayload,
): HostTurnTerminalEvidencePreimage {
  const { terminalFingerprint: _fingerprint, ...preimage } = evidence;
  return hostTurnTerminalEvidencePreimageSchema.parse(preimage);
}

function fingerprintTerminalPreimage(preimage: HostTurnTerminalEvidencePreimage) {
  return canonicalFingerprint(HOST_TURN_TERMINAL_PROTOCOL, preimage);
}

function fingerprintResult(result: HostTurnResult) {
  return canonicalFingerprint(HOST_TURN_RESULT_FINGERPRINT_DOMAIN, result);
}

function receiptPayload(receipt: HostInterruptSentReceipt): HostInterruptRequestPayload {
  return interruptRequestPayloadSchema.parse(receipt);
}

function sameInterruptRequest(
  left: HostInterruptRequestPayload,
  right: HostInterruptRequestPayload,
): boolean {
  return (
    left.protocol === right.protocol &&
    left.disposition === right.disposition &&
    left.requestId === right.requestId &&
    left.reason === right.reason &&
    sameHostThread(left.thread, right.thread) &&
    left.turnId === right.turnId
  );
}

function terminalAlreadyObserved(thread: HostThread, turnId: HostTurnId): HostInterruptDisposition {
  return Object.freeze({ disposition: 'TERMINAL_ALREADY_OBSERVED', thread, turnId });
}

function assertObservationBinding(
  observation: Readonly<{ thread: HostThread; turnId: HostTurnId }>,
  expected: Readonly<{ thread: HostThread; turnId: HostTurnId }>,
): void {
  if (
    !sameHostThread(observation.thread, expected.thread) ||
    observation.turnId !== expected.turnId
  ) {
    throw new TypeError('Host terminal observation binding mismatch.');
  }
}

function markEvidence(
  input: HostTurnTerminalEvidencePayload,
  authority: WeakSet<object>,
): HostTurnTerminalEvidence {
  const parsed = hostTurnTerminalEvidenceIntegritySchema.parse(input);
  const interruptRequest =
    parsed.interruptRequest === null ? null : Object.freeze({ ...parsed.interruptRequest });
  return markTrusted(
    { ...parsed, thread: parsed.thread, interruptRequest },
    authority,
  ) as HostTurnTerminalEvidence;
}

function markOutcome(
  input:
    | Readonly<{ terminal: HostSucceededTerminalEvidence; result: HostTurnResult }>
    | Readonly<{
        terminal: HostFailedTerminalEvidence | HostCancelledTerminalEvidence;
        result: null;
      }>,
  authority: WeakSet<object>,
): HostTurnOutcome {
  return markTrusted(input, authority) as HostTurnOutcome;
}

function markTrusted<T extends object>(input: T, authority: WeakSet<object>): T {
  authority.add(input);
  return Object.freeze(input);
}

function assertTrusted(
  input: unknown,
  authority: WeakSet<object>,
  name: string,
): asserts input is object {
  if (typeof input !== 'object' || input === null || !authority.has(input)) {
    throw new TypeError(`${name} did not originate from this Host turn authority.`);
  }
}
