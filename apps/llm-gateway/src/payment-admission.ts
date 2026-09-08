import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PaymentApiErrorResponseSchema,
  PaymentRequiredResponseSchema,
  PaymentTraceIdSchema,
} from '@cb/payment-protocol';
import { estimateHoldAmount, type ModelPrice } from './pricing.js';
import type { HoldOutcome, ParsedChatRequest } from './service.js';

export interface PaymentAdmissionInput {
  userId: string;
  agentId: string;
  operationId: string;
  callId: string;
  requestFingerprint: string;
  pricingPolicyId: string;
  estimatedAmount: number;
}
export type PaymentAdmissionResult =
  | { kind: 'admitted'; holdId: string; replayed: boolean; executionId?: string }
  | { kind: 'rejected'; status: number; body: unknown };
export interface PaymentAdmissionClient {
  admit(input: PaymentAdmissionInput): Promise<PaymentAdmissionResult>;
  finish?(input: {
    holdId: string;
    outcome: 'succeeded' | 'failed_no_charge' | 'unknown';
    failureReason?: 'invalid_response' | 'provider_rejected';
  }): Promise<void>;
}
const AdmittedSchema = z
  .object({
    data: z
      .object({
        holdId: z.string().uuid(),
        replayed: z.boolean(),
        executionId: z
          .string()
          .regex(/^[A-Za-z0-9]([A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/)
          .optional(),
      })
      .strict(),
    meta: z.object({ traceId: PaymentTraceIdSchema }).strict(),
  })
  .strict();

/** Canonical JSON makes request identity independent of object property insertion order. */
export function paymentRequestFingerprint(value: unknown): string {
  function canonical(value: unknown, depth: number): string {
    if (depth > 48) throw new Error('request nesting exceeds the admission limit');
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
      return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`,
        )
        .join(',')}}`;
    }
    throw new Error('request is not JSON');
  }
  return createHash('sha256').update(canonical(value, 0)).digest('hex');
}

export async function admitPaymentCall(
  client: PaymentAdmissionClient,
  request: ParsedChatRequest,
  price: ModelPrice,
  fixedCostCents: number,
): Promise<HoldOutcome> {
  try {
    const estimatedAmount = estimateHoldAmount({
      price,
      maxTokens: request.maxTokens,
      fixedCostCents,
    });
    if (estimatedAmount > 999_999_999_999_999)
      throw new Error('payment estimate outside public range');
    const operationId =
      request.platform.operationId ??
      `legacy-${paymentRequestFingerprint([request.platform.agentId, request.platform.turnId])}`;
    const result = await client.admit({
      userId: request.platform.userId,
      agentId: request.platform.agentId,
      operationId,
      callId: request.platform.turnId,
      requestFingerprint: paymentRequestFingerprint(request.forwardBody),
      pricingPolicyId: `price-${paymentRequestFingerprint([request.model, price, fixedCostCents])}`,
      estimatedAmount,
    });
    if (result.kind === 'rejected') {
      if (result.status === 402 && !PaymentRequiredResponseSchema.safeParse(result.body).success)
        throw new Error('invalid payment requirement');
      return result;
    }
    const hold = AdmittedSchema.parse({
      data: {
        holdId: result.holdId,
        replayed: result.replayed,
        ...(result.executionId ? { executionId: result.executionId } : {}),
      },
      meta: { traceId: 'internal-check' },
    });
    if (hold.data.replayed) return { kind: 'rejected', status: 409, body: null };
    return {
      kind: 'held',
      holdId: hold.data.holdId,
      estimatedAmount,
      ...(hold.data.executionId ? { executionId: hold.data.executionId } : {}),
    };
  } catch {
    return { kind: 'rejected', status: 503, body: null };
  }
}

export function createPaymentAdmissionClient(options: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): PaymentAdmissionClient {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)
    throw new Error('invalid admission timeout');
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/billing/call-admissions`;
  return {
    async finish(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await boundedResponse(
          fetchImpl(`${options.baseUrl.replace(/\/+$/, '')}/billing/call-attempt-results`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.token}`,
              'content-type': 'application/json',
            },
            redirect: 'error',
            signal: controller.signal,
            body: JSON.stringify(input),
          }),
          controller.signal,
        );
        const body = await readAdmissionJson(response, controller.signal);
        if (response.status !== 200) throw new Error();
        z.object({
          data: z.object({ recorded: z.literal(true) }).strict(),
          meta: z.object({ traceId: PaymentTraceIdSchema }).strict(),
        })
          .strict()
          .parse(body);
      } catch {
        throw new Error('call outcome could not be confirmed');
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
    async admit(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await boundedResponse(
          fetchImpl(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.token}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            redirect: 'error',
            signal: controller.signal,
            body: JSON.stringify(input),
          }),
          controller.signal,
        );
        if (response.status >= 500) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error('billing admission unavailable');
        }
        const body = await readAdmissionJson(response, controller.signal);
        if (response.status === 402)
          return { kind: 'rejected', status: 402, body: PaymentRequiredResponseSchema.parse(body) };
        if (response.status >= 400 && response.status < 500) {
          PaymentApiErrorResponseSchema.parse(body);
          return { kind: 'rejected', status: response.status, body: null };
        }
        if (response.status !== 200 && response.status !== 201)
          throw new Error('unexpected admission status');
        const admitted = AdmittedSchema.parse(body).data;
        if ((response.status === 200) !== admitted.replayed)
          throw new Error('inconsistent admission replay');
        return { kind: 'admitted', ...admitted };
      } catch {
        throw new Error('billing admission could not be confirmed');
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  };
}

async function boundedResponse(pending: Promise<Response>, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('admission request timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    pending.then(
      (response) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          onAbort();
        } else resolve(response);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('admission request failed'));
      },
    );
  });
}

async function readAdmissionJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (
    response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
      'application/json' ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('invalid admission content type');
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const bytes = new Uint8Array(64 * 1024);
  let length = 0;
  try {
    for (;;) {
      if (signal.aborted) {
        onAbort();
        throw new Error('admission read aborted');
      }
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('admission read aborted');
      if (done) break;
      if (length + value.byteLength > bytes.length) {
        onAbort();
        throw new Error('admission response too large');
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)),
    ) as unknown;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
