import { z } from 'zod';

import {
  MAX_HOST_RESULT_UTF8_BYTES,
  type HostThreadId,
  type HostTurnId,
} from '@cb/creator-agent-protocol/host';

const safePath = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => !/[\0\r\n]/u.test(value));
const safeText = z.string().refine((value) => !value.includes('\0'));
const hostThreadId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,256}$/u)
  .transform((value) => value as HostThreadId);
const hostTurnId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,256}$/u)
  .transform((value) => value as HostTurnId);

const initializeResponseSchema = z
  .object({
    userAgent: z.string().min(1).max(1_024),
    codexHome: safePath,
    platformFamily: z.literal('unix'),
    platformOs: z.literal('macos'),
  })
  .passthrough();

const threadStartResponseSchema = z
  .object({
    thread: z
      .object({
        id: hostThreadId,
        ephemeral: z.literal(true),
        cwd: safePath,
        cliVersion: z.string().min(1).max(128),
        canAcceptDirectInput: z.literal(true),
      })
      .passthrough(),
    cwd: safePath,
    runtimeWorkspaceRoots: z.array(safePath).max(16),
    instructionSources: z.array(safePath).max(32),
    approvalPolicy: z.literal('never'),
    sandbox: z
      .object({ type: z.literal('readOnly'), networkAccess: z.literal(false) })
      .passthrough(),
    activePermissionProfile: z
      .object({ id: z.literal(':read-only'), extends: z.null() })
      .passthrough(),
  })
  .passthrough();

const turnStatusSchema = z.enum(['completed', 'interrupted', 'failed', 'inProgress']);
const turnSchema = z
  .object({
    id: hostTurnId,
    status: turnStatusSchema,
    error: z.unknown().nullable(),
    completedAt: z.number().finite().nonnegative().nullable(),
  })
  .passthrough();

const turnStartResponseSchema = z.object({ turn: turnSchema }).passthrough();
const turnStartedNotificationSchema = z
  .object({ threadId: hostThreadId, turn: turnSchema })
  .strict();
const turnCompletedNotificationSchema = z
  .object({ threadId: hostThreadId, turn: turnSchema })
  .strict();

const agentMessageSchema = z
  .object({
    type: z.literal('agentMessage'),
    id: z.string().min(1).max(256),
    text: safeText,
    phase: z.enum(['commentary', 'final_answer']).nullable(),
  })
  .passthrough();

const itemCompletedNotificationSchema = z
  .object({
    threadId: hostThreadId,
    turnId: hostTurnId,
    completedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    item: z.object({ type: z.string().min(1).max(128) }).passthrough(),
  })
  .strict();

const errorNotificationSchema = z
  .object({
    threadId: hostThreadId,
    turnId: hostTurnId,
    willRetry: z.boolean(),
    error: z.object({ message: z.string() }).passthrough(),
  })
  .strict();

export type CodexInitializeResponse = z.infer<typeof initializeResponseSchema>;
export type CodexThreadStartResponse = z.infer<typeof threadStartResponseSchema>;
export type CodexTurn = z.infer<typeof turnSchema>;
export type CodexTurnStatus = z.infer<typeof turnStatusSchema>;
export type CodexCompletedItem =
  | Readonly<{
      kind: 'agent_message';
      id: string;
      text: string;
      phase: 'commentary' | 'final_answer' | null;
    }>
  | Readonly<{ kind: 'other' }>;

export function parseInitializeResponse(input: unknown): CodexInitializeResponse {
  return initializeResponseSchema.parse(input);
}

export function parseThreadStartResponse(input: unknown): CodexThreadStartResponse {
  return threadStartResponseSchema.parse(input);
}

export function parseTurnStartResponse(input: unknown): CodexTurn {
  return turnStartResponseSchema.parse(input).turn;
}

export function parseTurnStartedNotification(
  input: unknown,
): Readonly<{ threadId: HostThreadId; turn: CodexTurn }> {
  return turnStartedNotificationSchema.parse(input);
}

export function parseTurnCompletedNotification(
  input: unknown,
): Readonly<{ threadId: HostThreadId; turn: CodexTurn }> {
  return turnCompletedNotificationSchema.parse(input);
}

export function parseItemCompletedNotification(
  input: unknown,
): Readonly<{ threadId: HostThreadId; turnId: HostTurnId; item: CodexCompletedItem }> {
  const parsed = itemCompletedNotificationSchema.parse(input);
  if (parsed.item.type !== 'agentMessage') {
    return Object.freeze({
      threadId: parsed.threadId,
      turnId: parsed.turnId,
      item: { kind: 'other' },
    });
  }
  const message = agentMessageSchema.parse(parsed.item);
  return Object.freeze({
    threadId: parsed.threadId,
    turnId: parsed.turnId,
    item: Object.freeze({
      kind: 'agent_message',
      id: message.id,
      text: message.text,
      phase: message.phase,
    }),
  });
}

export function parseErrorNotification(
  input: unknown,
): Readonly<{ threadId: HostThreadId; turnId: HostTurnId; willRetry: boolean }> {
  const parsed = errorNotificationSchema.parse(input);
  return Object.freeze({
    threadId: parsed.threadId,
    turnId: parsed.turnId,
    willRetry: parsed.willRetry,
  });
}

export function normalizeCompletedAt(seconds: number): number {
  const milliseconds = Math.trunc(seconds * 1_000);
  return Math.min(Math.max(milliseconds, 0), Number.MAX_SAFE_INTEGER);
}

export function selectFinalAnswer(
  messages: readonly Readonly<{
    phase: 'commentary' | 'final_answer' | null;
    text: string;
  }>[],
): string | null {
  const selected =
    [...messages].reverse().find((message) => message.phase === 'final_answer') ??
    [...messages].reverse().find((message) => message.phase === null);
  if (selected === undefined) return null;
  const text = selected.text.trim();
  if (
    text.length === 0 ||
    Buffer.byteLength(text, 'utf8') > MAX_HOST_RESULT_UTF8_BYTES ||
    /[\uD800-\uDFFF]/u.test(text)
  ) {
    return null;
  }
  return text;
}
