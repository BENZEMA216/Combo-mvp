import { describe, expect, it, vi } from 'vitest';
import { startBillingReconciler } from '../modules/billing/reconcile.js';
import type { BillingRepository, LeasedRechargeOrder } from '../modules/billing/types.js';
import type { PaymentGateway } from '../platform/infra/leshouying/index.js';

const ORDER: LeasedRechargeOrder = {
  id: '00000000-0000-4000-8000-000000000001',
  orderNo: 'CBR-RECONCILE',
  ownerUserId: '00000000-0000-4000-8000-000000000002',
  clientIdempotencyKey: '00000000-0000-4000-8000-000000000003',
  packageId: 'starter',
  amountCents: 300n,
  paymentMethod: 'aggregate_qr',
  gatewayEnvironment: 'test',
  institutionNo: 'INST0001',
  merchantNo: 'MCH_TEST_001',
  payTraceNo: 'TRACE-RECONCILE',
  payTime: '20260728120000',
  paymentStatus: 'unknown',
  creditStatus: 'uncredited',
  attemptNo: 1,
  requestFingerprint: 'a'.repeat(64),
  createdAt: new Date('2026-07-28T04:00:00.000Z'),
  updatedAt: new Date('2026-07-28T04:00:00.000Z'),
  reconciliationActive: true,
  queryLeaseOwner: 'replaced-by-repository',
};

function dependencies() {
  const leaseDueRechargeOrders = vi.fn(async (input: { leaseOwner: string }) => [
    { ...ORDER, queryLeaseOwner: input.leaseOwner },
  ]);
  const applyQueryResult = vi.fn(async () => undefined);
  const clearExpiredPaymentActions = vi.fn(async () => 2);
  const retireExpiredReconciliations = vi.fn(async () => 1);
  const queryPayment = vi.fn(async () => ({ status: 'pending' as const }));
  const repository = {
    leaseDueRechargeOrders,
    applyQueryResult,
    clearExpiredPaymentActions,
    retireExpiredReconciliations,
  } as unknown as BillingRepository;
  const gateway = {
    configured: true,
    environment: 'test',
    institutionNo: 'INST0001',
    merchantNo: 'MCH_TEST_001',
    queryPayment,
  } as unknown as PaymentGateway;
  return {
    repository,
    gateway,
    leaseDueRechargeOrders,
    applyQueryResult,
    clearExpiredPaymentActions,
    retireExpiredReconciliations,
    queryPayment,
  };
}

const log = { info: vi.fn(), warn: vi.fn() };

describe('billing background reconciler lifecycle', () => {
  it('runs immediately, joins an overlapping run, and stops without further gateway calls', async () => {
    const deps = dependencies();
    const reconciler = startBillingReconciler({
      repository: deps.repository,
      gateway: deps.gateway,
      enabled: true,
      gatewayReconciliationEnabled: true,
      intervalMs: 300_000,
      leaseMs: 165_000,
      log,
    });
    await Promise.all([reconciler.runOnce(), reconciler.runOnce()]);
    expect(deps.leaseDueRechargeOrders).toHaveBeenCalledTimes(1);
    expect(deps.clearExpiredPaymentActions).toHaveBeenCalledTimes(1);
    expect(deps.retireExpiredReconciliations).toHaveBeenCalledTimes(1);
    expect(deps.queryPayment).toHaveBeenCalledTimes(1);
    expect(deps.applyQueryResult).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ count: 2 }, 'expired payment actions cleared');

    await reconciler.stop();
    await reconciler.runOnce();
    expect(deps.queryPayment).toHaveBeenCalledTimes(1);
  });

  it('does not touch the repository or gateway when disabled for tests/configuration', async () => {
    const deps = dependencies();
    const reconciler = startBillingReconciler({
      repository: deps.repository,
      gateway: deps.gateway,
      enabled: false,
      gatewayReconciliationEnabled: false,
      intervalMs: 15_000,
      leaseMs: 65_000,
      log,
    });
    await reconciler.runOnce();
    await reconciler.stop();
    expect(deps.leaseDueRechargeOrders).not.toHaveBeenCalled();
    expect(deps.clearExpiredPaymentActions).not.toHaveBeenCalled();
    expect(deps.retireExpiredReconciliations).not.toHaveBeenCalled();
    expect(deps.queryPayment).not.toHaveBeenCalled();
  });

  it('continues authoritative order queries when action cleanup fails', async () => {
    const deps = dependencies();
    deps.clearExpiredPaymentActions.mockRejectedValueOnce(new Error('test cleanup failure'));
    const reconciler = startBillingReconciler({
      repository: deps.repository,
      gateway: deps.gateway,
      enabled: true,
      gatewayReconciliationEnabled: true,
      intervalMs: 300_000,
      leaseMs: 165_000,
      log,
    });

    await reconciler.runOnce();
    expect(deps.queryPayment).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({}, 'expired payment action cleanup failed');
    await reconciler.stop();
  });

  it('clears expired actions while the gateway kill switch disables queryorder', async () => {
    const deps = dependencies();
    const reconciler = startBillingReconciler({
      repository: deps.repository,
      gateway: deps.gateway,
      enabled: true,
      gatewayReconciliationEnabled: false,
      intervalMs: 300_000,
      leaseMs: 165_000,
      log,
    });

    await reconciler.runOnce();
    expect(deps.clearExpiredPaymentActions).toHaveBeenCalledTimes(1);
    expect(deps.retireExpiredReconciliations).toHaveBeenCalledTimes(1);
    expect(deps.leaseDueRechargeOrders).not.toHaveBeenCalled();
    expect(deps.queryPayment).not.toHaveBeenCalled();
    await reconciler.stop();
  });
});
