import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createImmutableObjectStore,
  ImmutableObjectStoreError,
  type ImmutableObjectCommandSender,
} from '../platform/infra/object-store.js';

const BUCKET = 'combo-artifacts' as const;
const KEY = 'agent-packages/sha256/secret-package-key/agent.json';

function sender(
  implementation: ImmutableObjectCommandSender['send'],
): ImmutableObjectCommandSender & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(implementation) };
}

function conditionalConflict(shape: 'name' | 'status' | 'code' = 'name'): Error {
  const error = new Error('provider response must stay private');
  if (shape === 'name') return Object.assign(error, { name: 'PreconditionFailed' });
  if (shape === 'status') return Object.assign(error, { $metadata: { httpStatusCode: 412 } });
  return Object.assign(error, { Code: 'PreconditionFailed' });
}

function expectSafeFailure(error: unknown, failure: ImmutableObjectStoreError['failure']): void {
  expect(error).toBeInstanceOf(ImmutableObjectStoreError);
  expect(error).toMatchObject({ failure });
  const serialized = JSON.stringify(error);
  expect(`${(error as Error).name} ${(error as Error).message} ${serialized}`).not.toContain(KEY);
  expect(`${(error as Error).name} ${(error as Error).message} ${serialized}`).not.toContain(
    'AKIA_TEST_CREDENTIAL',
  );
}

describe('immutable Agent Package object storage', () => {
  it('creates an object with a conditional exact-byte PUT', async () => {
    const fake = sender(async (command) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      return { ETag: 'first-write' };
    });
    const store = createImmutableObjectStore(fake);
    const bytes = new Uint8Array([0, 1, 2, 255]);

    await expect(
      store.commit({
        bucket: BUCKET,
        key: KEY,
        bytes,
        maxBytes: bytes.byteLength,
        contentType: 'application/json',
      }),
    ).resolves.toEqual({ outcome: 'created', size: 4 });

    expect(fake.send).toHaveBeenCalledTimes(1);
    const command = fake.send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command.input).toMatchObject({
      Bucket: BUCKET,
      Key: KEY,
      ContentLength: 4,
      ContentType: 'application/json',
      IfNoneMatch: '*',
    });
    expect(command.input.Body).toEqual(bytes);
    expect(command.input.Body).not.toBe(bytes);
  });

  it('snapshots branded Uint8Array bytes without executing an expanding iterator', async () => {
    const bytes = new Uint8Array([7]);
    Object.defineProperty(bytes, Symbol.iterator, {
      value: function* () {
        yield 7;
        yield 8;
      },
    });
    const fake = sender(async () => ({ ETag: 'bounded-write' }));
    const store = createImmutableObjectStore(fake);

    await expect(store.commit({ bucket: BUCKET, key: KEY, bytes, maxBytes: 1 })).resolves.toEqual({
      outcome: 'created',
      size: 1,
    });

    expect(fake.send).toHaveBeenCalledTimes(1);
    const command = fake.send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command.input.ContentLength).toBe(1);
    expect(command.input.Body).toEqual(new Uint8Array([7]));
  });

  it.each(['name', 'status', 'code'] as const)(
    'accepts an identical retry for a %s-only 412 shape after bounded byte comparison',
    async (shape) => {
      const bytes = new Uint8Array([10, 20, 30, 40]);
      const fake = sender(async (command) => {
        if (command instanceof PutObjectCommand) throw conditionalConflict(shape);
        expect(command).toBeInstanceOf(GetObjectCommand);
        return {
          ContentLength: bytes.byteLength,
          Body: {
            async *[Symbol.asyncIterator]() {
              yield bytes.subarray(0, 1);
              yield bytes.subarray(1);
            },
          },
        };
      });
      const store = createImmutableObjectStore(fake);

      await expect(
        store.commit({ bucket: BUCKET, key: KEY, bytes, maxBytes: bytes.byteLength }),
      ).resolves.toEqual({ outcome: 'already_committed', size: bytes.byteLength });

      expect(fake.send).toHaveBeenCalledTimes(2);
      expect(fake.send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
      expect(fake.send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
    },
  );

  it('rejects an existing object whose bytes differ', async () => {
    const fake = sender(async (command) => {
      if (command instanceof PutObjectCommand) throw conditionalConflict();
      return { ContentLength: 3, Body: new Uint8Array([1, 2, 4]) };
    });
    const store = createImmutableObjectStore(fake);

    try {
      await store.commit({
        bucket: BUCKET,
        key: KEY,
        bytes: new Uint8Array([1, 2, 3]),
        maxBytes: 3,
      });
      expect.fail('different immutable bytes must fail');
    } catch (error) {
      expectSafeFailure(error, 'conflict');
    }
  });

  it('maps an oversized declared existing object to an immutable conflict', async () => {
    const fake = sender(async (command) => {
      if (command instanceof PutObjectCommand) throw conditionalConflict();
      return { ContentLength: 2, Body: new Uint8Array([1, 2]) };
    });
    const store = createImmutableObjectStore(fake);

    await expect(
      store.commit({
        bucket: BUCKET,
        key: KEY,
        bytes: new Uint8Array([1]),
        maxBytes: 1,
      }),
    ).rejects.toMatchObject({ failure: 'conflict' });
    expect(fake.send).toHaveBeenCalledTimes(2);
  });

  it('maps an existing object that crosses the streaming limit to an immutable conflict', async () => {
    let returned = false;
    const fake = sender(async (command) => {
      if (command instanceof PutObjectCommand) throw conditionalConflict();
      return {
        ContentLength: 1,
        Body: {
          [Symbol.asyncIterator]() {
            let index = 0;
            return {
              async next() {
                index += 1;
                if (index === 1) return { done: false as const, value: new Uint8Array([1]) };
                return { done: false as const, value: new Uint8Array([2]) };
              },
              async return() {
                returned = true;
                return { done: true as const, value: undefined };
              },
            };
          },
        },
      };
    });
    const store = createImmutableObjectStore(fake);

    await expect(
      store.commit({
        bucket: BUCKET,
        key: KEY,
        bytes: new Uint8Array([1]),
        maxBytes: 1,
      }),
    ).rejects.toMatchObject({ failure: 'conflict' });
    expect(fake.send).toHaveBeenCalledTimes(2);
    expect(returned).toBe(true);
  });

  it('destroys an unconsumed Node Readable when ContentLength is invalid', async () => {
    let readCount = 0;
    const body = new Readable({
      read() {
        readCount += 1;
        this.push(new Uint8Array([1]));
        this.push(null);
      },
    });
    const fake = sender(async () => ({
      ContentLength: Number.NaN,
      Body: body,
    }));
    const store = createImmutableObjectStore(fake);

    await expect(store.read({ bucket: BUCKET, key: KEY, maxBytes: 4 })).rejects.toMatchObject({
      failure: 'invalid_response',
    });
    expect(body.destroyed).toBe(true);
    expect(readCount).toBe(0);
  });

  it('cancels an unconsumed Web stream when ContentLength exceeds maxBytes', async () => {
    let pullCount = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pullCount += 1;
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fake = sender(async () => ({ ContentLength: 5, Body: body }));
    const store = createImmutableObjectStore(fake);

    await expect(store.read({ bucket: BUCKET, key: KEY, maxBytes: 4 })).rejects.toMatchObject({
      failure: 'too_large',
    });
    expect(cancelled).toBe(true);
    expect(pullCount).toBe(0);
    const reader = body.getReader();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();
  });

  it('stops a hostile stream when accumulated bytes exceed maxBytes', async () => {
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            index += 1;
            if (index === 1) return { done: false as const, value: new Uint8Array([1, 2, 3]) };
            if (index === 2) return { done: false as const, value: new Uint8Array([4, 5]) };
            throw new Error('reader consumed beyond the safety boundary');
          },
          async return() {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const fake = sender(async () => ({ ContentLength: 4, Body: body }));
    const store = createImmutableObjectStore(fake);

    await expect(store.read({ bucket: BUCKET, key: KEY, maxBytes: 4 })).rejects.toMatchObject({
      failure: 'too_large',
    });
    expect(returned).toBe(true);
  });

  it('aborts a stalled hostile stream and passes the signal to the SDK sender', async () => {
    const controller = new AbortController();
    let unblockSecondRead: (() => void) | undefined;
    const secondReadStarted = new Promise<void>((resolve) => {
      unblockSecondRead = resolve;
    });
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next() {
            index += 1;
            if (index === 1) {
              return Promise.resolve({ done: false as const, value: new Uint8Array([1]) });
            }
            unblockSecondRead?.();
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
    const store = createImmutableObjectStore(fake);

    const pending = store.read({
      bucket: BUCKET,
      key: KEY,
      maxBytes: 2,
      signal: controller.signal,
    });
    await secondReadStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ failure: 'aborted' });
    expect(returned).toBe(true);
  });

  it('rejects oversized commit bytes before copying or calling PUT/GET', async () => {
    const bytes = new Uint8Array([1, 2]);
    Object.defineProperty(bytes, Symbol.iterator, {
      value() {
        throw new Error('oversized bytes must not be copied');
      },
    });
    const fake = sender(async () => {
      throw new Error('object storage must not be called');
    });
    const store = createImmutableObjectStore(fake);

    await expect(
      store.commit({ bucket: BUCKET, key: KEY, bytes, maxBytes: 1 }),
    ).rejects.toMatchObject({ failure: 'too_large' });
    expect(fake.send).not.toHaveBeenCalled();
  });

  it.each([
    [
      '409',
      Object.assign(new Error(`${KEY} AKIA_TEST_CREDENTIAL provider diagnostic`), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 409 },
      }),
    ],
    [
      '500',
      Object.assign(new Error(`${KEY} AKIA_TEST_CREDENTIAL provider diagnostic`), {
        name: 'InternalError',
        Code: 'PreconditionFailed',
        $metadata: { httpStatusCode: 500 },
      }),
    ],
  ])('maps a %s PUT failure without issuing a speculative GET', async (_label, failure) => {
    const fake = sender(async (command) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      throw failure;
    });
    const store = createImmutableObjectStore(fake);

    try {
      await store.commit({
        bucket: BUCKET,
        key: KEY,
        bytes: new Uint8Array([1]),
        maxBytes: 1,
      });
      expect.fail('non-412 PUT failure must fail closed');
    } catch (error) {
      expectSafeFailure(error, 'unavailable');
    }
    expect(fake.send).toHaveBeenCalledTimes(1);
  });

  it('redacts a hostile stream rejection and closes its iterator', async () => {
    let returned = false;
    const fake = sender(async () => ({
      Body: {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<Uint8Array>> {
              throw new Error(`${KEY} AKIA_TEST_CREDENTIAL stream diagnostic`);
            },
            async return() {
              returned = true;
              return { done: true as const, value: undefined };
            },
          };
        },
      },
    }));
    const store = createImmutableObjectStore(fake);

    try {
      await store.read({ bucket: BUCKET, key: KEY, maxBytes: 1024 });
      expect.fail('stream failure must fail closed');
    } catch (error) {
      expectSafeFailure(error, 'unavailable');
    }
    expect(returned).toBe(true);
  });

  it('maps SDK failures to a stable error without leaking keys or credentials', async () => {
    const fake = sender(async () => {
      throw new Error(`${KEY} AKIA_TEST_CREDENTIAL provider diagnostic`);
    });
    const store = createImmutableObjectStore(fake);

    try {
      await store.read({ bucket: BUCKET, key: KEY, maxBytes: 1024 });
      expect.fail('SDK failure must fail closed');
    } catch (error) {
      expectSafeFailure(error, 'unavailable');
    }
  });
});
