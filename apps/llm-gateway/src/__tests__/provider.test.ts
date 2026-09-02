import { describe, expect, it, vi } from 'vitest';
import { ProviderUnavailableError, createFetchProviderClient } from '../provider.js';

function clientFor(response: Response) {
  return createFetchProviderClient({
    baseUrl: 'https://provider.invalid',
    apiKey: 'test-key',
    fetchImpl: vi.fn().mockResolvedValue(response),
  });
}

describe('provider success protocol', () => {
  it('accepts an object JSON success response', async () => {
    const client = clientFor(
      new Response(
        JSON.stringify({
          id: 'chat-1',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    await expect(client.chatCompletion({})).resolves.toEqual({
      status: 200,
      json: {
        id: 'chat-1',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      },
    });
  });

  it('rejects malformed, null, and array JSON success payloads', async () => {
    for (const response of [
      new Response('not-json', { status: 200 }),
      new Response('null', { status: 200 }),
      new Response('[]', { status: 200 }),
      new Response('{}', { status: 200 }),
      new Response('{"error":{"message":"failed"}}', { status: 200 }),
      new Response('{"choices":[{"message":[]}]}', { status: 200 }),
      new Response('{"choices":[{"message":{}}]}', { status: 200 }),
      new Response('{"choices":[{"message":{"role":"user","content":"wrong"}}]}', {
        status: 200,
      }),
    ]) {
      await expect(clientFor(response).chatCompletion({})).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    }
  });

  it('requires text/event-stream for a successful streaming response', async () => {
    const invalid = clientFor(
      new Response('{"error":"not an event stream"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(invalid.chatCompletionStream({})).resolves.toMatchObject({
      status: 502,
      stream: null,
      errorBody: 'provider stream invalid content type',
    });

    const valid = clientFor(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }),
    );
    const result = await valid.chatCompletionStream({});
    expect(result.status).toBe(200);
    expect(result.stream).not.toBeNull();
    await result.stream?.cancel();
  });
});
