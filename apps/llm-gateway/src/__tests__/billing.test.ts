import { describe, expect, it, vi } from 'vitest';
import { BillingProtocolError, createFetchBillingClient, type MeteringEvent } from '../billing.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const holdInput = {
  userId: '11111111-1111-4111-8111-111111111111',
  agentId: 'agent-a',
  turnId: 'turn-1',
  estimatedAmount: 3,
};
const HOLD_ID = '22222222-2222-4222-8222-222222222222';

describe('fetch billing client protocol', () => {
  it('distinguishes a new hold from an exact replay', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(201, { data: { hold_id: HOLD_ID, status: 'held', replayed: false } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { hold_id: HOLD_ID, status: 'held', replayed: true } }),
      );
    const client = createFetchBillingClient({
      baseUrl: 'http://billing.invalid',
      token: 'test-token',
      timeoutMs: 1000,
      fetchImpl,
    });

    await expect(client.createHold(holdInput)).resolves.toEqual({
      kind: 'held',
      holdId: HOLD_ID,
      replayed: false,
    });
    await expect(client.createHold(holdInput)).resolves.toEqual({
      kind: 'held',
      holdId: HOLD_ID,
      replayed: true,
    });
  });

  it('fails closed for 4xx conflicts and malformed success responses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(409, { error: { code: 'conflict' }, data: { reason: 'terminal_replay' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { hold_id: HOLD_ID, status: 'settled', replayed: true } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(201, { data: { hold_id: 123, status: 'held', replayed: false } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(201, { data: { hold_id: 'not-a-uuid', status: 'held', replayed: false } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, null))
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    const client = createFetchBillingClient({
      baseUrl: 'http://billing.invalid',
      token: 'test-token',
      timeoutMs: 1000,
      fetchImpl,
    });

    await expect(client.createHold(holdInput)).resolves.toMatchObject({
      kind: 'rejected',
      status: 409,
    });
    for (let index = 0; index < 5; index += 1) {
      await expect(client.createHold(holdInput)).rejects.toBeInstanceOf(BillingProtocolError);
    }
  });

  it('sends the stable metering key and accepts exact replay responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { replayed: true } }));
    const client = createFetchBillingClient({
      baseUrl: 'http://billing.invalid',
      token: 'test-token',
      timeoutMs: 1000,
      fetchImpl,
    });
    const event: MeteringEvent = {
      userId: holdInput.userId,
      agentId: holdInput.agentId,
      turnId: holdInput.turnId,
      holdId: '11111111-1111-4111-8111-111111111112',
      dimension: 'llm_token_in',
      quantity: 10,
      model: 'model-a',
      unitCost: 1,
      source: 'gateway',
      idempotencyKey: `meter:v1:${'a'.repeat(64)}`,
    };

    await expect(client.reportUsage([event])).resolves.toBeUndefined();
    const request = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      idempotency_key: event.idempotencyKey,
    });
  });
});
