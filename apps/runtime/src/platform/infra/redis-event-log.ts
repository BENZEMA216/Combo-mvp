import type { Redis } from 'ioredis';
import {
  EVENT_STREAM_MAXLEN,
  EVENT_STREAM_TTL_MS,
  type SessionEventLog,
  type StreamEventEntry,
} from '../../modules/agent/event-log.js';
import type { Env } from '../config/env.js';
import { getRedis } from './redis.js';

const eventKey = (sessionId: string): string => `rt:sess:evt:${sessionId}`;
const terminalKey = (sessionId: string, runId: string): string =>
  `rt:sess:terminal:${sessionId}:${runId}`;

// A normal event records the last open Stream id in the same script as XADD.
// A plain OPEN marker comes from an older replica and is intentionally treated
// as ambiguous: the script scans retained history before trusting it.
const APPEND_EVENT_SCRIPT = `
local eventRaw = ARGV[1]
local runId = ARGV[4]

local function decodeEvent(raw)
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' then
    return nil
  end
  return value
end

local function fieldValue(fields, name)
  for index = 1, #fields, 2 do
    if fields[index] == name then
      return fields[index + 1]
    end
  end
  return nil
end

local function appendOpen()
  local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[2], '*', 'event', eventRaw)
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  redis.call('SET', KEYS[2], 'OPEN|' .. id, 'PX', ARGV[3])
  return id
end

local requested = decodeEvent(eventRaw)
if not requested or requested['runId'] ~= runId then
  return redis.error_reply('EVENT_INVALID')
end

local existing = redis.call('GET', KEYS[2])
if existing and string.sub(existing, 1, 5) == 'OPEN|' then
  return appendOpen()
end
if existing and existing ~= 'OPEN' then
  return redis.error_reply('TERMINAL_ALREADY_APPENDED')
end

-- A missing marker can coexist with a retained terminal when newer runs keep the
-- Session Stream alive. A legacy plain OPEN can represent the same bad state.
local cursor = '+'
while true do
  local rows = redis.call('XREVRANGE', KEYS[1], cursor, '-', 'COUNT', 128)
  if #rows == 0 then
    break
  end
  local reachedStart = false
  for _, row in ipairs(rows) do
    local raw = fieldValue(row[2], 'event')
    local decoded = decodeEvent(raw)
    if decoded and decoded['runId'] == runId then
      if decoded['type'] == 'RUN_FINISHED' or decoded['type'] == 'RUN_ERROR' then
        redis.call('PEXPIRE', KEYS[1], ARGV[3])
        redis.call('SET', KEYS[2], row[1] .. '|' .. raw, 'PX', ARGV[3])
        return redis.error_reply('TERMINAL_ALREADY_APPENDED')
      end
      if decoded['type'] == 'RUN_STARTED' then
        reachedStart = true
        break
      end
    end
  end
  if reachedStart or #rows < 128 then
    break
  end
  cursor = '(' .. rows[#rows][1]
end

return appendOpen()
`;

// Strict appends reject competing terminals. The repair mode is reserved for a
// caller holding the Session row lock with an already-committed PostgreSQL truth;
// it removes retained legacy conflicts and appends that truth as the newest event.
const APPEND_TERMINAL_SCRIPT = `
local requestedRaw = ARGV[1]
local runId = ARGV[4]
local mode = ARGV[5]

local function decodeEvent(raw)
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' then
    return nil
  end
  return value
end

local requested = decodeEvent(requestedRaw)
if not requested or requested['runId'] ~= runId or
   (requested['type'] ~= 'RUN_FINISHED' and requested['type'] ~= 'RUN_ERROR') then
  return redis.error_reply('TERMINAL_EVENT_INVALID')
end
if mode ~= 'strict' and mode ~= 'repair' then
  return redis.error_reply('TERMINAL_MODE_INVALID')
end

local function sameTerminal(candidate, raw)
  return raw == requestedRaw and candidate and
    candidate['type'] == requested['type'] and
    candidate['runId'] == requested['runId'] and
    candidate['threadId'] == requested['threadId'] and
    candidate['message'] == requested['message']
end

local function fieldValue(fields, name)
  for index = 1, #fields, 2 do
    if fields[index] == name then
      return fields[index + 1]
    end
  end
  return nil
end

local function rememberRaw(id, raw)
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  redis.call('SET', KEYS[2], id .. '|' .. raw, 'PX', ARGV[3])
  return id
end

local function rememberRequested(id)
  return rememberRaw(id, requestedRaw)
end

local function appendNew()
  local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[2], '*', 'event', requestedRaw)
  return rememberRequested(id)
end

local function scanTerminals()
  local terminals = {}
  local cursor = '+'
  local ordinarySeen = false
  while true do
    local rows = redis.call('XREVRANGE', KEYS[1], cursor, '-', 'COUNT', 128)
    if #rows == 0 then
      break
    end
    local reachedStart = false
    for _, row in ipairs(rows) do
      local raw = fieldValue(row[2], 'event')
      local decoded = decodeEvent(raw)
      if decoded and decoded['runId'] == runId then
        if decoded['type'] == 'RUN_FINISHED' or decoded['type'] == 'RUN_ERROR' then
          -- Reverse scanning means ordinarySeen records whether this terminal has
          -- a newer ordinary event for the same run. Repair must then move the
          -- PostgreSQL-authoritative terminal behind that event.
          table.insert(terminals, { row[1], raw, sameTerminal(decoded, raw), ordinarySeen })
        elseif decoded['type'] == 'RUN_STARTED' then
          reachedStart = true
          break
        else
          ordinarySeen = true
        end
      end
    end
    if reachedStart or #rows < 128 then
      break
    end
    cursor = '(' .. rows[#rows][1]
  end
  return terminals
end

local existing = redis.call('GET', KEYS[2])
if existing and string.sub(existing, 1, 5) == 'OPEN|' then
  return appendNew()
end
if existing and existing ~= 'OPEN' then
  local separator = string.find(existing, '|', 1, true)
  if not separator then
    if mode == 'strict' then
      return redis.error_reply('TERMINAL_MARKER_INVALID')
    end
  else
    local previousId = string.sub(existing, 1, separator - 1)
    local previousRaw = string.sub(existing, separator + 1)
    if not sameTerminal(decodeEvent(previousRaw), previousRaw) then
      if mode == 'strict' then
        return redis.error_reply('TERMINAL_EVENT_CONFLICT')
      end
    else
      local rows = redis.call('XRANGE', KEYS[1], previousId, previousId)
      if #rows > 0 then
        local retainedRaw = fieldValue(rows[1][2], 'event')
        if sameTerminal(decodeEvent(retainedRaw), retainedRaw) then
          if mode == 'strict' then
            return rememberRequested(previousId)
          end
          -- Repair cannot trust a matching marker alone: an old replica may have
          -- appended ordinary events after this terminal while PostgreSQL rolled
          -- back. Continue into the full run scan before deciding which id to keep.
        elseif mode == 'strict' then
          return redis.error_reply('TERMINAL_MARKER_INVALID')
        end
      end
    end
  end
end

local terminals = scanTerminals()
if mode == 'repair' then
  local mustReplay = false
  for _, terminal in ipairs(terminals) do
    if not terminal[3] then
      mustReplay = true
      break
    end
  end
  -- terminals[1] is the newest terminal. If a same-run ordinary event is newer,
  -- delete every stale terminal and replay the database truth at the Stream tail.
  if #terminals > 0 and terminals[1][4] then
    mustReplay = true
  end
  if mustReplay then
    for _, terminal in ipairs(terminals) do
      redis.call('XDEL', KEYS[1], terminal[1])
    end
    return appendNew()
  end
  if #terminals > 0 then
    -- Keep only the newest byte-compatible terminal when an old replica had
    -- duplicated the same event after losing its marker.
    for index = 2, #terminals do
      redis.call('XDEL', KEYS[1], terminals[index][1])
    end
    return rememberRequested(terminals[1][1])
  end
  return appendNew()
end

if #terminals > 0 then
  for _, terminal in ipairs(terminals) do
    if not terminal[3] then
      rememberRaw(terminals[1][1], terminals[1][2])
      return redis.error_reply('TERMINAL_EVENT_CONFLICT')
    end
  end
  return rememberRequested(terminals[1][1])
end

return appendNew()
`;

export interface RedisSessionEventLogOptions {
  maxlen?: number;
  ttlMs?: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

/** 依赖注入入口供真实 Redis 集成测试使用；生产仍通过 Env 取得共享连接。 */
export function createRedisSessionEventLogForClient(
  redis: Redis,
  options: RedisSessionEventLogOptions = {},
): SessionEventLog {
  const maxlen = positiveInteger(options.maxlen ?? EVENT_STREAM_MAXLEN, 'event stream maxlen');
  const ttlMs = positiveInteger(options.ttlMs ?? EVENT_STREAM_TTL_MS, 'event stream ttl');

  return {
    async append(sessionId, event) {
      const encoded = JSON.stringify(event);
      const runId = typeof event.runId === 'string' && event.runId ? event.runId : undefined;
      if (runId) {
        const result = await redis.eval(
          APPEND_EVENT_SCRIPT,
          2,
          eventKey(sessionId),
          terminalKey(sessionId, runId),
          encoded,
          String(maxlen),
          String(ttlMs),
          runId,
        );
        if (typeof result !== 'string') throw new Error('XADD failed');
        return result;
      }

      const pipeline = redis.pipeline();
      pipeline.xadd(eventKey(sessionId), 'MAXLEN', '~', maxlen, '*', 'event', encoded);
      pipeline.pexpire(eventKey(sessionId), ttlMs);
      const results = await pipeline.exec();
      const first = results?.[0];
      if (!first || first[0] || typeof first[1] !== 'string')
        throw first?.[0] ?? new Error('XADD failed');
      return first[1];
    },
    async appendTerminal(sessionId, runId, event) {
      const result = await redis.eval(
        APPEND_TERMINAL_SCRIPT,
        2,
        eventKey(sessionId),
        terminalKey(sessionId, runId),
        JSON.stringify(event),
        String(maxlen),
        String(ttlMs),
        runId,
        'strict',
      );
      if (typeof result !== 'string') throw new Error('terminal XADD failed');
      return result;
    },
    async repairTerminal(sessionId, runId, event) {
      const result = await redis.eval(
        APPEND_TERMINAL_SCRIPT,
        2,
        eventKey(sessionId),
        terminalKey(sessionId, runId),
        JSON.stringify(event),
        String(maxlen),
        String(ttlMs),
        runId,
        'repair',
      );
      if (typeof result !== 'string') throw new Error('terminal repair XADD failed');
      return result;
    },
    async rangeAfter(sessionId, afterId, count) {
      const start = afterId === '0-0' ? '-' : `(${afterId}`;
      const rows = await redis.xrange(eventKey(sessionId), start, '+', 'COUNT', count);
      return rows.flatMap(([id, fields]): StreamEventEntry[] => {
        const eventIndex = fields.indexOf('event');
        const rawEvent = fields[eventIndex + 1];
        if (eventIndex < 0 || rawEvent === undefined) return [];
        const event = JSON.parse(rawEvent) as Record<string, unknown>;
        return [{ id, event }];
      });
    },
  };
}

export function createRedisSessionEventLog(env: Env): SessionEventLog {
  return createRedisSessionEventLogForClient(getRedis(env));
}
