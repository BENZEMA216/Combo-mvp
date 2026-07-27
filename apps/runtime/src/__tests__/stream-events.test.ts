import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SSE_HEARTBEAT_INTERVAL_MS } from '@cb/shared';
import { compareStreamIds, normalizeStreamId } from '../modules/agent/event-log.js';
import { createTurnEmitter } from '../modules/agent/turn-emitter.js';
import { sessionStreamHandler } from '../modules/agent/stream.js';
import { createSession } from '../modules/session/repo.js';
import { createSessionEventBus, type PublishedStreamEvent } from '../platform/infra/event-bus.js';
import { FakeDb, FakeSessionEventLog, silentLog } from './fakes.js';

afterEach(() => vi.useRealTimers());

describe('Redis Stream 事件日志', () => {
  it('append 返回单调 id，并按 MAXLEN 修剪最早条目', async () => {
    const log = new FakeSessionEventLog(() => 1720000000000, 3);
    const ids = [];
    for (let n = 1; n <= 5; n += 1) ids.push(await log.append('a', { n }));
    expect(ids).toEqual([
      '1720000000000-0',
      '1720000000000-1',
      '1720000000000-2',
      '1720000000000-3',
      '1720000000000-4',
    ]);
    expect(log.entries('a').map((entry) => entry.event.n)).toEqual([3, 4, 5]);
  });

  it('同一 runId 的相同终态幂等，不同终态不能追加第二条', async () => {
    const log = new FakeSessionEventLog(() => 10);
    const finished = { type: 'RUN_FINISHED', runId: 'run-1' };
    const first = await log.appendTerminal('a', 'run-1', finished);
    expect(await log.appendTerminal('a', 'run-1', finished)).toBe(first);
    await expect(
      log.appendTerminal('a', 'run-1', { type: 'RUN_ERROR', runId: 'run-1' }),
    ).rejects.toThrow('TERMINAL_EVENT_CONFLICT');
    await expect(
      log.append('a', { type: 'TEXT_MESSAGE_CONTENT', runId: 'run-1', delta: 'late' }),
    ).rejects.toThrow('TERMINAL_ALREADY_APPENDED');
    expect(log.entries('a')).toHaveLength(1);
  });

  it('修复匹配终态时会越过同一 run 的迟到普通事件并重放到尾部', async () => {
    const log = new FakeSessionEventLog(() => 10);
    const runId = 'run-late';
    const terminal = { type: 'RUN_ERROR', runId, message: 'stopped' };
    await log.append('a', { type: 'RUN_STARTED', runId });
    const staleTerminalId = await log.appendTerminal('a', runId, terminal);
    const lateStateId = log.appendUnfencedForTest('a', { type: 'STATE_DELTA', runId });
    const lateTextId = log.appendUnfencedForTest('a', {
      type: 'TEXT_MESSAGE_CONTENT',
      runId,
      delta: 'late',
    });

    const repairedId = await log.repairTerminal('a', runId, terminal);
    expect(repairedId).not.toBe(staleTerminalId);
    expect(compareStreamIds(repairedId, lateTextId)).toBeGreaterThan(0);
    expect(compareStreamIds(lateTextId, lateStateId)).toBeGreaterThan(0);
    expect(log.entries('a').map((entry) => entry.event.type)).toEqual([
      'RUN_STARTED',
      'STATE_DELTA',
      'TEXT_MESSAGE_CONTENT',
      'RUN_ERROR',
    ]);
    await expect(
      log.append('a', { type: 'TEXT_MESSAGE_CONTENT', runId, delta: 'later' }),
    ).rejects.toThrow('TERMINAL_ALREADY_APPENDED');
  });

  it('rangeAfter 使用开区间并支持分批', async () => {
    const log = new FakeSessionEventLog(() => 10);
    for (let n = 1; n <= 4; n += 1) await log.append('a', { n });
    await log.append('b', { n: 99 });
    expect((await log.rangeAfter('a', '0-0', 2)).map((entry) => entry.event.n)).toEqual([1, 2]);
    expect((await log.rangeAfter('a', '10-1', 10)).map((entry) => entry.event.n)).toEqual([3, 4]);
    expect(await log.rangeAfter('a', '10-3', 10)).toEqual([]);
  });

  it('compareStreamIds 分别按毫秒与序列的数值比较', () => {
    expect(compareStreamIds('9-10', '10-0')).toBeLessThan(0);
    expect(compareStreamIds('100-2', '100-11')).toBeLessThan(0);
    expect(compareStreamIds('100-11', '100-2')).toBeGreaterThan(0);
    expect(compareStreamIds('100-2', '100-2')).toBe(0);
  });

  it('normalizeStreamId 只接受完整的数字-数字格式', () => {
    expect(normalizeStreamId('1720000000000-0')).toBe('1720000000000-0');
    for (const raw of [undefined, '', '12', '12-x', '-1-0', '1-2-tail']) {
      expect(normalizeStreamId(raw)).toBe('0-0');
    }
  });
});

describe('SSE Redis Stream 续传', () => {
  it('直播漏帧后由心跳补读，输出字符串 Stream id 且不重复', async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const capability = db.seedCapability({ owner_user_id: 'me' });
    const session = await createSession(db, { capabilityId: capability.id, ownerUserId: 'me' });
    const eventLog = new FakeSessionEventLog(() => 1720000000000);
    await eventLog.append(session.id, { type: 'RUN_STARTED', threadId: session.id, runId: 'r' });
    const bus = createSessionEventBus();
    const rawRequest = new EventEmitter();
    const writes: string[] = [];
    const rawReply = {
      writableEnded: false,
      writeHead: () => undefined,
      write: (chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      },
      end() {
        this.writableEnded = true;
      },
    };
    const request = {
      id: 'trace-test',
      auth: { userId: 'me' },
      params: { id: session.id },
      headers: {},
      raw: rawRequest,
      log: silentLog,
      server: { infra: { db, eventLog, bus } },
    };
    const reply = { raw: rawReply, hijack: () => undefined };

    await (sessionStreamHandler() as unknown as (req: unknown, res: unknown) => Promise<unknown>)(
      request,
      reply,
    );
    const missedId = await eventLog.append(session.id, {
      type: 'RUN_FINISHED',
      threadId: session.id,
      runId: 'r',
    });
    await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_INTERVAL_MS);
    const output = writes.join('');
    expect(output).toContain('id: 1720000000000-0\n');
    expect(output).toContain(`id: ${missedId}\n`);
    expect(output.match(new RegExp(`id: ${missedId}`, 'g'))).toHaveLength(1);
    rawRequest.emit('close');
  });
});

describe('turn emitter 双写', () => {
  it('每个事件先写日志再发总线，Stream id 与顺序一致', async () => {
    const eventLog = new FakeSessionEventLog(() => 20);
    const bus = createSessionEventBus();
    const received: PublishedStreamEvent[] = [];
    bus.subscribe('a', (event) => received.push(event));
    const emitter = createTurnEmitter({ eventLog, bus, sessionId: 'a', log: silentLog });
    emitter.emit({ type: 'RUN_STARTED' });
    emitter.emit({ type: 'TEXT_MESSAGE_CONTENT' });
    emitter.emit({ type: 'RUN_FINISHED' });
    await emitter.flush();
    expect(received).toEqual(eventLog.entries('a'));
    expect(received.map((entry) => entry.id)).toEqual(['20-0', '20-1', '20-2']);
  });

  it('无订阅者时事件仍写入日志', async () => {
    const eventLog = new FakeSessionEventLog();
    const emitter = createTurnEmitter({
      eventLog,
      bus: createSessionEventBus(),
      sessionId: 'a',
      log: silentLog,
    });
    emitter.emit({ type: 'RUN_STARTED' });
    await emitter.flush();
    expect(eventLog.entries('a')).toHaveLength(1);
  });
});
