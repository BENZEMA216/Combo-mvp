// 轮次事件双写 emitter：每个 AG-UI 事件先追加 Redis Stream，再发布直播通知。
//   promise 链串行化保证条目 id 顺序与事件顺序一致。
//   单条写失败：记日志、跳过该事件继续（推流尽力而为，不让观测面故障翻掉生成主流程）。
import type { SessionEventBus } from '../../platform/infra/event-bus.js';
import type { SessionEventLog } from './event-log.js';

export interface TurnLogger {
  error: (obj: unknown, msg?: string) => void;
}

export interface TurnEmitter {
  /** 双写一个 AG-UI 事件（异步入链，调用点不等待）。 */
  emit(event: Record<string, unknown>): void;
  /** 等待链上所有事件写完（轮次收尾时调用，保证终态事件先于函数返回写入日志）。 */
  flush(): Promise<void>;
}

export function createTurnEmitter(deps: {
  eventLog: SessionEventLog;
  bus: SessionEventBus;
  sessionId: string;
  log: TurnLogger;
  /** 返回 null 表示 Turn 已被终态事务栅栏，当前非终态事件必须丢弃。 */
  append?: (event: Record<string, unknown>) => Promise<string | null>;
}): TurnEmitter {
  let chain = Promise.resolve();

  return {
    emit(event) {
      chain = chain.then(async () => {
        try {
          const id = await (deps.append
            ? deps.append(event)
            : deps.eventLog.append(deps.sessionId, event));
          if (id !== null) deps.bus.publish(deps.sessionId, { id, event });
        } catch (err) {
          deps.log.error({ err, event: event.type }, 'stream event write failed (skipped)');
        }
      });
    },
    flush: () => chain,
  };
}
