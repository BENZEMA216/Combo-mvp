// loader 权限闸与定义校验：本人未发布可试 / 他人未发布拒 / published 放行 / 坏 version 拒。
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { serializeCreatorAgentPackageCapability } from '@cb/creator-agent-protocol/agent-package-capability';
import {
  CAPABILITY_BUCKET,
  listTrialCapabilities,
  loadCapability,
} from '../modules/capability/loader.js';
import { FakeDb, FakeObjectStore } from './fakes.js';
import {
  BoundedObjectReadError,
  createBoundedObjectReader,
  type RuntimeObjectCommandSender,
} from '../platform/infra/object-store.js';

const ME = 'user-me';
const OTHER = 'user-other';
const PACKAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE_ID = `release.agent-package.${'1'.repeat(32)}`;

function seedDefinition(
  store: FakeObjectStore,
  storageKey: string,
  overrides: Record<string, unknown> = {},
): void {
  store.seedText(
    CAPABILITY_BUCKET,
    storageKey,
    JSON.stringify({
      version: 1,
      name: '会议纪要生成',
      summary: '把速记变成结构化纪要',
      kind: 'writing',
      instructions: '你是一名会议纪要专家。',
      meta: {},
      ...overrides,
    }),
  );
}

describe('loadCapability 权限闸', () => {
  it('本人的未发布能力可加载', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME, published: false });
    seedDefinition(store, cap.storage_key);

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.definition.version).toBe(1);
      if (result.definition.version !== 1) return;
      expect(result.capability.id).toBe(cap.id);
      expect(result.definition.instructions).toContain('会议纪要');
    }
  });

  it('他人的未发布能力 → not_found（不暴露存在性）', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: OTHER, published: false });
    seedDefinition(store, cap.storage_key);

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('not_found');
  });

  it('他人的已发布能力放行', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: OTHER, published: true });
    seedDefinition(store, cap.storage_key);

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('ok');
  });

  it('不存在的能力 → not_found', async () => {
    const db = new FakeDb();
    const result = await loadCapability(db, new FakeObjectStore(), 'cap-nope', ME);
    expect(result.kind).toBe('not_found');
  });

  it('loads only the exact canonical Agent Package Capability v2 projection', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
    store.seedText(
      CAPABILITY_BUCKET,
      cap.storage_key,
      serializeCreatorAgentPackageCapability({
        version: 2,
        protocol: 'combo.agent-package-capability/2',
        release: {
          protocol: 'combo.agent-package-release/1',
          releaseId: RELEASE_ID,
          packageDigest: PACKAGE_DIGEST,
        },
      }),
    );

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.definition).toMatchObject({
        version: 2,
        protocol: 'combo.agent-package-capability/2',
        release: { releaseId: RELEASE_ID, packageDigest: PACKAGE_DIGEST },
      });
    }
  });

  it('rejects a semantically valid but non-canonical v2 projection', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
    store.seedText(
      CAPABILITY_BUCKET,
      cap.storage_key,
      JSON.stringify({
        version: 2,
        protocol: 'combo.agent-package-capability/2',
        release: {
          protocol: 'combo.agent-package-release/1',
          releaseId: RELEASE_ID,
          packageDigest: PACKAGE_DIGEST,
        },
      }),
    );

    await expect(loadCapability(db, store, cap.id, ME)).resolves.toEqual({
      kind: 'unsupported_version',
    });
  });

  it.each([
    ['protocol only', { protocol: 'combo.agent-package-capability/2' }],
    [
      'release only',
      {
        release: {
          protocol: 'combo.agent-package-release/1',
          releaseId: RELEASE_ID,
          packageDigest: PACKAGE_DIGEST,
        },
      },
    ],
    [
      'protocol and release',
      {
        protocol: 'combo.agent-package-capability/2',
        release: {
          protocol: 'combo.agent-package-release/1',
          releaseId: RELEASE_ID,
          packageDigest: PACKAGE_DIGEST,
        },
      },
    ],
  ])(
    'version 1 混入 Agent Package reserved field（%s）→ invalid_definition，不执行 legacy 提示词',
    async (_caseName, reservedFields) => {
      const db = new FakeDb();
      const store = new FakeObjectStore();
      const cap = db.seedCapability({ owner_user_id: ME });
      seedDefinition(store, cap.storage_key, reservedFields);

      const result = await loadCapability(db, store, cap.id, ME);
      expect(result.kind).toBe('invalid_definition');
    },
  );

  it('定义结构坏了（version 对但缺 instructions）→ invalid_definition', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
    seedDefinition(store, cap.storage_key, { instructions: '' });

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('invalid_definition');
  });

  it('MinIO 里不是合法 JSON → invalid_definition', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
    store.seedText(CAPABILITY_BUCKET, cap.storage_key, 'not-json');

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('invalid_definition');
  });
});

describe('listTrialCapabilities（试用入口）', () => {
  it('返回我的全部 + 他人已发布的；他人未发布的不可见', async () => {
    const db = new FakeDb();
    const mineUnpublished = db.seedCapability({ owner_user_id: ME, published: false });
    const minePublished = db.seedCapability({ owner_user_id: ME, published: true });
    const otherPublished = db.seedCapability({ owner_user_id: OTHER, published: true });
    db.seedCapability({ owner_user_id: OTHER, published: false }); // 不可见

    const items = await listTrialCapabilities(db, ME);
    const ids = items.map((i) => i.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(
      expect.arrayContaining([mineUnpublished.id, minePublished.id, otherPublished.id]),
    );
    expect(items.find((i) => i.id === otherPublished.id)?.owned).toBe(false);
    expect(items.find((i) => i.id === mineUnpublished.id)?.owned).toBe(true);
  });
});

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

function streamed(chunks: Uint8Array[], returned: () => void): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield* chunks;
      } finally {
        returned();
      }
    },
  };
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
    const returned = vi.fn();
    const read = createBoundedObjectReader(
      sender(async () => ({ Body: streamed([new Uint8Array()], returned) })),
    );

    await expect(read(BUCKET, KEY, 0)).rejects.toMatchObject({ failure: 'invalid_response' });
    expect(returned).toHaveBeenCalledOnce();
  });

  it('stops an async body at the accumulated hard limit', async () => {
    const returned = vi.fn();
    const read = createBoundedObjectReader(
      sender(async () => ({
        Body: streamed([new Uint8Array([1]), new Uint8Array([2])], returned),
      })),
    );

    await expect(read(BUCKET, KEY, 1)).rejects.toMatchObject({ failure: 'too_large' });
    expect(returned).toHaveBeenCalledOnce();
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

describe('Runtime production dependency closure', () => {
  it('builds creator protocol before shared and Runtime PostgreSQL imports in Release CI', () => {
    const workflow = readFileSync(
      new URL('../../../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    const integration = workflow.indexOf('name: integration (database migration + dual Redis)');
    const protocol = workflow.indexOf('pnpm -F @cb/creator-agent-protocol build', integration);
    const shared = workflow.indexOf('pnpm -F @cb/shared build', protocol);
    const runtimePg = workflow.indexOf('name: Runtime billing PostgreSQL invariants', shared);
    expect(integration).toBeGreaterThanOrEqual(0);
    expect(protocol).toBeGreaterThan(integration);
    expect(shared).toBeGreaterThan(protocol);
    expect(runtimePg).toBeGreaterThan(shared);
  });
});
