import { randomBytes } from 'node:crypto';
import type { PaymentGateway } from '../../platform/infra/leshouying/index.js';
import { reconcileDueRechargeOrders } from './service.js';
import type { BillingRepository } from './types.js';

export interface BillingReconciler {
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

export interface BillingReconcilerOptions {
  repository: BillingRepository;
  gateway: PaymentGateway;
  enabled: boolean;
  gatewayReconciliationEnabled: boolean;
  intervalMs: number;
  leaseMs: number;
  log: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
}

/**
 * API 进程内的支付查单调度器。数据库租约允许多个 API 副本同时运行，进程内 fence
 * 防止上一轮尚未结束时重叠。测试进程由组装层强制关闭此调度器。
 */
export function startBillingReconciler(options: BillingReconcilerOptions): BillingReconciler {
  const leaseOwner = `authoring-api:${process.pid}:${randomBytes(6).toString('hex')}`;
  let stopped = !options.enabled;
  let activeRun: Promise<void> | undefined;

  const runOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (activeRun) return activeRun;
    activeRun = (async () => {
      try {
        const cleared = await options.repository.clearExpiredPaymentActions({ limit: 100 });
        if (cleared > 0) {
          options.log.info({ count: cleared }, 'expired payment actions cleared');
        }
      } catch {
        options.log.warn({}, 'expired payment action cleanup failed');
      }
      try {
        const retired = await options.repository.retireExpiredReconciliations({ limit: 100 });
        if (retired > 0) {
          options.log.info({ count: retired }, 'exhausted payment reconciliations retired');
        }
      } catch {
        options.log.warn({}, 'payment reconciliation retirement failed');
      }
      if (options.gatewayReconciliationEnabled) {
        try {
          const result = await reconcileDueRechargeOrders(options.repository, options.gateway, {
            leaseOwner,
            limit: 10,
            leaseMs: options.leaseMs,
          });
          if (result.leased > 0) {
            options.log.info(
              {
                leased: result.leased,
                succeeded: result.succeeded,
                pending: result.pending,
                failed: result.failed,
                unknown: result.unknown,
              },
              'billing reconciliation completed',
            );
          }
        } catch {
          options.log.warn({}, 'billing reconciliation failed');
        }
      }
    })().finally(() => {
      activeRun = undefined;
    });
    return activeRun;
  };

  const timer = options.enabled
    ? setInterval(() => {
        void runOnce();
      }, options.intervalMs)
    : undefined;
  timer?.unref();
  if (options.enabled) void runOnce();

  return {
    runOnce,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await activeRun;
    },
  };
}
