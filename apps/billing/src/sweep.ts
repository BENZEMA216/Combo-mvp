// hold 超时清扫：把 expires_at 已过且仍 held 的预授权置 expired 并解冻。
// 防网关崩溃导致永久冻结（spec 八对账任务第 1 条、spec 二十上线前必须补）。
import type { BillingStore } from './service.js';
import type { PaymentStore } from './payment-service.js';

interface SweepLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface HoldSweeper {
  stop(): void;
}

/** 周期任务失败只记日志不中断；下一轮继续。返回的 stop 用于优雅停机。 */
export function startHoldSweeper(options: {
  store: BillingStore;
  paymentStore?: Pick<PaymentStore, 'releaseExpiredFunds'>;
  intervalSeconds: number;
  batchSize: number;
  log?: SweepLogger;
}): HoldSweeper {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    options.store
      .sweepExpiredHolds({ limit: options.batchSize })
      .then(async (count) => {
        if (count > 0) options.log?.info({ expiredHolds: count }, 'expired holds swept');
        const released = await options.paymentStore?.releaseExpiredFunds(options.batchSize);
        if (released)
          options.log?.info(
            { releasedPaymentReservations: released },
            'expired payment reservations released',
          );
      })
      .catch(() => {
        options.log?.warn({}, 'hold or payment reservation sweep failed');
      })
      .finally(() => {
        running = false;
      });
  }, options.intervalSeconds * 1000);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
