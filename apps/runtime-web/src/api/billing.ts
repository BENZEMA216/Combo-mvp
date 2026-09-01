// 消费端充值 API。乐收赢结果只用于展示支付动作；余额是否到账只读 Combo 内部订单。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RecoveryRechargeOrderViewSchema, type RecoveryRechargeOrderView } from '@cb/shared';
import { apiGet, apiPost } from './client.js';

export type RechargeChannel = 'qr';
export type RechargePayType = 'wechat' | 'alipay';
export type RechargeOrderStatus =
  | 'created'
  | 'pending'
  | 'unknown'
  | 'succeeded'
  | 'failed'
  | 'closed'
  | 'credited';

export interface WalletView {
  availableCents: string;
  reservedCents: string;
  currency: 'CNY';
}

export interface PaymentAction {
  kind: 'redirect' | 'qr_code';
  url: string;
}

export interface RechargeOrderView {
  id: string;
  rechargeIntentId: string;
  amountCents: string;
  channel: RechargeChannel;
  payType?: RechargePayType;
  status: RechargeOrderStatus;
  reconciliationActive?: boolean;
  paymentAction?: PaymentAction;
}

export interface CreateRechargeOrderInput {
  rechargeIntentId: string;
  amountCents: number;
  channel: RechargeChannel;
  payType: RechargePayType;
}

export interface CreateRecoveryRechargeOrderInput extends CreateRechargeOrderInput {
  recoveryUsageId: string;
}

export function useWallet(enabled = true) {
  return useQuery({
    queryKey: ['billing', 'wallet'],
    queryFn: () => apiGet<WalletView>('/billing/wallet'),
    enabled,
  });
}

export function useCreateRechargeOrder() {
  return useMutation({
    mutationFn: (input: CreateRechargeOrderInput) =>
      apiPost<RechargeOrderView>('/billing/recharge-orders', input),
  });
}

export function useCreateRecoveryRechargeOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateRecoveryRechargeOrderInput) =>
      RecoveryRechargeOrderViewSchema.parse(
        await apiPost<unknown>('/billing/recharge-orders', input),
      ),
    onSuccess: (_order, input) => {
      void queryClient.invalidateQueries({
        queryKey: ['billing', 'recharge-order-by-recovery', input.recoveryUsageId],
      });
    },
  });
}

export function useRechargeOrderByIntent(rechargeIntentId: string) {
  return useQuery({
    queryKey: ['billing', 'recharge-order-by-intent', rechargeIntentId],
    queryFn: () =>
      apiGet<RechargeOrderView | null>(
        `/billing/recharge-orders/by-intent/${encodeURIComponent(rechargeIntentId)}`,
      ),
    retry: false,
  });
}

export async function getRechargeOrderByRecovery(
  recoveryUsageId: string,
): Promise<RecoveryRechargeOrderView | null> {
  const value = await apiGet<unknown>(
    `/billing/recharge-orders/by-recovery/${encodeURIComponent(recoveryUsageId)}`,
  );
  if (value === null) return null;
  return RecoveryRechargeOrderViewSchema.parse(value);
}

export function useRechargeOrderByRecovery(recoveryUsageId: string) {
  return useQuery({
    queryKey: ['billing', 'recharge-order-by-recovery', recoveryUsageId],
    queryFn: () => getRechargeOrderByRecovery(recoveryUsageId),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return rechargeOrderRefetchInterval(status, query.state.data?.reconciliationActive);
    },
  });
}

export type { RecoveryRechargeOrderView };

export function useRechargeOrder(orderId: string | null) {
  return useQuery({
    queryKey: ['billing', 'recharge-order', orderId],
    queryFn: () => apiGet<RechargeOrderView>(`/billing/recharge-orders/${orderId}`),
    enabled: orderId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return rechargeOrderRefetchInterval(status, query.state.data?.reconciliationActive);
    },
  });
}

export function rechargeOrderRefetchInterval(
  status: RechargeOrderStatus | undefined,
  reconciliationActive?: boolean,
): number | false {
  if (status === 'credited') return false;
  // Active compensation gets responsive polling. Once server-side queryorder is
  // exhausted, retain a low-frequency watch for a trustworthy late callback.
  return status === 'failed' || status === 'closed' || reconciliationActive === false
    ? 30_000
    : 2_500;
}

export function useRefreshWallet() {
  const queryClient = useQueryClient();
  return (): void => {
    void queryClient.invalidateQueries({ queryKey: ['billing', 'wallet'] });
  };
}
