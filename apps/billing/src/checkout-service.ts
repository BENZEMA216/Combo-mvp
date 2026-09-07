import type { PaymentView } from '@cb/payment-protocol';
import type { PaymentStore } from './payment-service.js';
import type { ChannelOrderStore, createPaymentChannelService } from './channel-service.js';

export type PaymentChannelService = ReturnType<typeof createPaymentChannelService>;

/** Public payment state also reflects a definitively failed original channel order. */
export function withChannelPaymentState(
  base: PaymentStore,
  channels: ChannelOrderStore,
): PaymentStore {
  async function view(payment: PaymentView | null, userId: string): Promise<PaymentView | null> {
    if (!payment || payment.status !== 'waiting') return payment;
    const channel = await channels.get(payment.paymentRequestId, userId);
    if (channel?.state !== 'failed' || channel.completed) return payment;
    const { action: _action, ...closed } = payment;
    return { ...closed, status: 'closed' };
  }
  return {
    ...base,
    async createPayment(input) {
      const result = await base.createPayment(input);
      return result.kind === 'payment'
        ? { ...result, payment: (await view(result.payment, input.userId))! }
        : result;
    },
    async getPayment(input) {
      return view(await base.getPayment(input), input.userId);
    },
    async findPayment(input) {
      return view(await base.findPayment(input), input.userId);
    },
  };
}

export function startChannelReconciler(options: {
  channel: Pick<PaymentChannelService, 'reconcile'>;
  intervalMs?: number;
  purge?(): Promise<unknown>;
  log?: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
}) {
  const interval = options.intervalMs ?? 30_000;
  if (!Number.isSafeInteger(interval) || interval < 1000)
    throw new Error('invalid reconciliation interval');
  let active: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || active) return;
    active = Promise.resolve()
      .then(() => options.purge?.())
      .then(() => options.channel.reconcile(20))
      .then((result) => {
        if (result.queried) options.log?.info(result, 'payment channel query batch completed');
      })
      .catch(() => {
        options.log?.warn({}, 'payment channel query batch unavailable');
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, interval);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
