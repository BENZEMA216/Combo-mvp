import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  BoundedObjectReadError,
  createBoundedObjectReader,
  type RuntimeObjectCommandSender,
} from '../platform/infra/object-store.js';

const BUCKET = 'combo-artifacts' as const;
const KEY = 'agent-packages/sha256/private-package/agent.json';

function sender(
  implementation: RuntimeObjectCommandSender['send'],
): RuntimeObjectCommandSender & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(implementation) };
}

function expectRedacted(error: unknown, failure: BoundedObjectReadError['failure']): void {
  expect(error).toBeInstanceOf(BoundedObjectReadError);
  expect(error).toMatchObject({ failure });
  expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(KEY);
  expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('AKIA_TEST_CREDENTIAL');
}

describe('bounded Runtime object reads', () => {
  it('rejects a declared oversize before consuming and destroys the Node body', async () => {
    let reads = 0;
    const body = new Readable({
      read() {
        reads += 1;
        this.push(new Uint8Array([1]));
        this.push(null);
      },
    });
    const fake = sender(async (command) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      return { ContentLength: 2, Body: body };
    });
    const read = createBoundedObjectReader(fake);

    await expect(read(BUCKET, KEY, 1)).rejects.toMatchObject({ failure: 'too_large' });
    expect(body.destroyed).toBe(true);
    expect(reads).toBe(0);
  });

  it('copies branded backing bytes without executing an expanding iterator', async () => {
    let iteratorCalls = 0;
    const body = new Uint8Array([7]);
    Object.defineProperty(body, Symbol.iterator, {
      value: function* () {
        iteratorCalls += 1;
        yield 7;
        yield 8;
      },
    });
    const read = createBoundedObjectReader(sender(async () => ({ ContentLength: 1, Body: body })));

    await expect(read(BUCKET, KEY, 1)).resolves.toEqual(new Uint8Array([7]));
    expect(iteratorCalls).toBe(0);
  });

  it('rejects an oversized string before asking TextEncoder to allocate its bytes', async () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    const read = createBoundedObjectReader(
      sender(async () => ({ Body: 'x'.repeat(16 * 1024 * 1024) })),
    );

    await expect(read(BUCKET, KEY, 1)).rejects.toMatchObject({ failure: 'too_large' });
    expect(encode).not.toHaveBeenCalled();
    encode.mockRestore();
  });

  it('rejects and closes an empty streamed chunk instead of retaining unbounded empties', async () => {
    let reads = 0;
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            reads += 1;
            return { done: false as const, value: new Uint8Array() };
          },
          async return() {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const read = createBoundedObjectReader(sender(async () => ({ Body: body })));

    await expect(read(BUCKET, KEY, 0)).rejects.toMatchObject({ failure: 'invalid_response' });
    expect(reads).toBe(1);
    expect(returned).toBe(true);
  });

  it('stops an async body at the accumulated hard limit', async () => {
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            index += 1;
            return {
              done: false as const,
              value: index === 1 ? new Uint8Array([1]) : new Uint8Array([2]),
            };
          },
          async return() {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const read = createBoundedObjectReader(sender(async () => ({ Body: body })));

    await expect(read(BUCKET, KEY, 1)).rejects.toMatchObject({ failure: 'too_large' });
    expect(returned).toBe(true);
  });

  it('aborts a stalled stream, passes the signal to S3, and closes the iterator', async () => {
    const controller = new AbortController();
    let secondReadStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      secondReadStarted = resolve;
    });
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let first = true;
        return {
          next() {
            if (first) {
              first = false;
              return Promise.resolve({ done: false as const, value: new Uint8Array([1]) });
            }
            secondReadStarted?.();
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          async return() {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const fake = sender(async (_command, options) => {
      expect(options?.abortSignal).toBe(controller.signal);
      return { Body: body };
    });
    const read = createBoundedObjectReader(fake);
    const pending = read(BUCKET, KEY, 2, { abortSignal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ failure: 'aborted' });
    expect(returned).toBe(true);
  });

  it('destroys an unread body when the signal aborts as S3 returns it', async () => {
    const controller = new AbortController();
    let reads = 0;
    const body = new Readable({
      read() {
        reads += 1;
        this.push(new Uint8Array([1]));
        this.push(null);
      },
    });
    const read = createBoundedObjectReader(
      sender(async () => {
        controller.abort();
        return { ContentLength: 1, Body: body };
      }),
    );

    await expect(read(BUCKET, KEY, 1, { abortSignal: controller.signal })).rejects.toMatchObject({
      failure: 'aborted',
    });
    expect(body.destroyed).toBe(true);
    expect(reads).toBe(0);
  });

  it('cancels a Web body whose declared length exceeds the limit', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const read = createBoundedObjectReader(sender(async () => ({ ContentLength: 2, Body: body })));

    await expect(read(BUCKET, KEY, 1)).rejects.toMatchObject({ failure: 'too_large' });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(0);
  });

  it('redacts provider and hostile stream failures', async () => {
    for (const fake of [
      sender(async () => {
        throw new Error(`${KEY} AKIA_TEST_CREDENTIAL provider diagnostic`);
      }),
      sender(async () => ({
        Body: {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<Uint8Array>> {
                throw new Error(`${KEY} AKIA_TEST_CREDENTIAL stream diagnostic`);
              },
            };
          },
        },
      })),
    ]) {
      try {
        await createBoundedObjectReader(fake)(BUCKET, KEY, 8);
        expect.fail('hostile storage must fail closed');
      } catch (error) {
        expectRedacted(error, 'unavailable');
      }
    }
  });
});
