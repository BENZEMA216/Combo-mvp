import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { RechargeRequired } from '../api/runtime.js';
import {
  useCreateRechargeOrder,
  useRechargeOrder,
  useRechargeOrderByIntent,
  useRefreshWallet,
  type RechargeOrderView,
  type RechargePayType,
} from '../api/billing.js';
import { ApiError } from '../api/client.js';

export interface RechargeDialogProps {
  requirement: RechargeRequired;
  activeRechargeIntentId: string;
  onClose: () => void;
  onActiveRechargeIntentChange: (rechargeIntentId: string) => void;
  onCredited: (creditedIntentId: string) => Promise<unknown>;
  onAbandon?: () => void;
}

function yuan(cents: string): string {
  const amount = BigInt(cents);
  return `¥${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

/** 把「元」输入（最多两位小数）转成分；非法或越界返回 null。 */
function yuanToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number.parseFloat(trimmed) * 100);
  return cents >= 1 && cents <= 99_999_999 ? cents : null;
}

const QUICK_AMOUNTS_YUAN = [1, 5, 10];

function minimumRechargeCents(requirement: RechargeRequired): bigint {
  const deficit = BigInt(requirement.requiredCents) - BigInt(requirement.balanceCents);
  return deficit > 1n ? deficit : 1n;
}

export function RechargeDialog({
  requirement,
  activeRechargeIntentId,
  onClose,
  onActiveRechargeIntentChange,
  onCredited,
  onAbandon,
}: RechargeDialogProps) {
  const createOrder = useCreateRechargeOrder();
  const refreshWallet = useRefreshWallet();
  const [amountYuan, setAmountYuan] = useState<string>('');
  const [payType, setPayType] = useState<RechargePayType>('alipay');
  const [createdOrder, setCreatedOrder] = useState<RechargeOrderView | null>(null);
  const recoveredOrderQ = useRechargeOrderByIntent(activeRechargeIntentId);
  const recoveredOrder = recoveredOrderQ.data ?? null;
  const recoveredIntentMismatch =
    recoveredOrder !== null && recoveredOrder.rechargeIntentId !== activeRechargeIntentId;
  const createdIntentMismatch =
    createdOrder !== null && createdOrder.rechargeIntentId !== activeRechargeIntentId;
  const trustedRecoveredOrder = recoveredIntentMismatch ? null : recoveredOrder;
  const trustedCreatedOrder = createdIntentMismatch ? null : createdOrder;
  const orderQ = useRechargeOrder(trustedCreatedOrder?.id ?? trustedRecoveredOrder?.id ?? null);
  const polledIntentMismatch =
    orderQ.data != null && orderQ.data.rechargeIntentId !== activeRechargeIntentId;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrRenderFailed, setQrRenderFailed] = useState(false);
  const [localSubmitError, setLocalSubmitError] = useState<string | null>(null);
  const [replacementCheckPending, setReplacementCheckPending] = useState(false);
  const [resumeState, setResumeState] = useState<'idle' | 'resuming' | 'failed' | 'completed'>(
    'idle',
  );
  const [resumeError, setResumeError] = useState<string | null>(null);
  const creditedReportedRef = useRef<string | null>(null);
  const resetForIntentRef = useRef(activeRechargeIntentId);
  const recoveryUnavailable =
    recoveredOrderQ.isError || recoveredIntentMismatch || polledIntentMismatch;
  const recoveryInProgress = recoveredOrderQ.isPending;
  const amountCents = yuanToCents(amountYuan);
  const minimumCents = minimumRechargeCents(requirement);
  const amountBelowMinimum = amountCents !== null && BigInt(amountCents) < minimumCents;

  useEffect(() => {
    if (resetForIntentRef.current === activeRechargeIntentId) return;
    resetForIntentRef.current = activeRechargeIntentId;
    setCreatedOrder(null);
    setLocalSubmitError(null);
    setResumeState('idle');
    setResumeError(null);
    creditedReportedRef.current = null;
  }, [activeRechargeIntentId]);

  // 轮询结果是内部订单真源。服务端会在支付动作过期后刻意省略它，不能用初次
  // 下单响应把已经撤销的二维码或跳转地址“补回来”。
  const order = useMemo(() => {
    const polledOrder = orderQ.data;
    if (polledOrder && polledOrder.rechargeIntentId !== activeRechargeIntentId) return null;
    return polledOrder ?? trustedCreatedOrder ?? trustedRecoveredOrder;
  }, [activeRechargeIntentId, orderQ.data, trustedCreatedOrder, trustedRecoveredOrder]);

  const resumeCreditedUsage = useCallback(
    (creditedIntentId: string): void => {
      if (
        creditedIntentId !== activeRechargeIntentId ||
        creditedReportedRef.current === creditedIntentId
      ) {
        return;
      }
      creditedReportedRef.current = creditedIntentId;
      setResumeState('resuming');
      setResumeError(null);
      refreshWallet();
      void onCredited(creditedIntentId)
        .then(() => setResumeState('completed'))
        .catch((cause: unknown) => {
          setResumeState('failed');
          setResumeError(cause instanceof Error ? cause.message : '原任务恢复失败，请重试。');
        });
    },
    [activeRechargeIntentId, onCredited, refreshWallet],
  );

  useEffect(() => {
    if (order?.status !== 'credited' || order.rechargeIntentId !== activeRechargeIntentId) {
      return;
    }
    resumeCreditedUsage(order.rechargeIntentId);
  }, [activeRechargeIntentId, order?.rechargeIntentId, order?.status, resumeCreditedUsage]);

  useEffect(() => {
    const value = order?.paymentAction?.kind === 'qr_code' ? order.paymentAction.url : null;
    let current = true;
    setQrDataUrl(null);
    setQrRenderFailed(false);
    if (!value) return undefined;
    void QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240,
    })
      .then((dataUrl) => {
        if (current) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        // 二维码内容仍保留在内部订单中供轮询；本地渲染失败不改变支付状态。
        if (current) setQrRenderFailed(true);
      });
    return () => {
      current = false;
    };
  }, [order?.paymentAction]);

  const submit = async (): Promise<void> => {
    if (
      amountCents === null ||
      amountBelowMinimum ||
      createOrder.isPending ||
      createdOrder ||
      recoveredOrder ||
      recoveryInProgress ||
      recoveryUnavailable
    ) {
      return;
    }
    setLocalSubmitError(null);
    try {
      const next = await createOrder.mutateAsync({
        rechargeIntentId: activeRechargeIntentId,
        amountCents,
        channel: 'qr',
        payType,
      });
      if (next.rechargeIntentId !== activeRechargeIntentId) {
        setLocalSubmitError('充值订单与当前恢复任务不匹配，请刷新页面后重试。');
        return;
      }
      setCreatedOrder(next);
    } catch (cause) {
      // React Query 已保存安全错误供当前对话框展示；阻止事件处理器产生未处理拒绝。
      setLocalSubmitError(
        cause instanceof ApiError ? cause.userMessage : '充值订单创建失败，请稍后重试。',
      );
    }
  };

  const amountError = amountBelowMinimum
    ? `本次至少需要充值 ${yuan(minimumCents.toString())}。`
    : null;
  const error =
    localSubmitError ??
    amountError ??
    (createOrder.error instanceof ApiError
      ? createOrder.error.userMessage
      : orderQ.error instanceof ApiError
        ? orderQ.error.userMessage
        : recoveredIntentMismatch || createdIntentMismatch || polledIntentMismatch
          ? '充值订单与当前恢复任务不匹配，请刷新页面后重试。'
          : recoveryUnavailable || createOrder.isError || orderQ.isError
            ? '充值状态暂时无法确认，请稍后重试查询。'
            : null);

  const retryWithFreshIntent = async (replaceCreditedOrder = false): Promise<void> => {
    if (replacementCheckPending) return;
    setReplacementCheckPending(true);
    setLocalSubmitError(null);
    try {
      // Narrow the late-callback race before offering another payment. The
      // backend remains authoritative; a credited refresh keeps the old order.
      const latest = await orderQ.refetch();
      if (latest.error) {
        setLocalSubmitError('充值状态暂时无法确认，请稍后重试查询。');
        return;
      }
      if (latest.data && latest.data.rechargeIntentId !== activeRechargeIntentId) {
        setLocalSubmitError('充值订单与当前恢复任务不匹配，请刷新页面后重试。');
        return;
      }
      if (latest.data?.status === 'credited' && !replaceCreditedOrder) return;
      const nextIntentId = crypto.randomUUID();
      // 父级先把 replacement intent 写入 PendingUsageV2；写失败时保持旧订单。
      onActiveRechargeIntentChange(nextIntentId);
      setCreatedOrder(null);
      createOrder.reset();
    } catch (cause) {
      setLocalSubmitError(
        cause instanceof Error ? cause.message : '无法保存新的充值订单，请稍后重试。',
      );
    } finally {
      setReplacementCheckPending(false);
    }
  };

  return (
    <div className="rt-recharge-layer" role="presentation">
      <section
        className="rt-recharge-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rt-recharge-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header>
          <div>
            <span className="rt-recharge-dialog__eyebrow">免费次数已用完</span>
            <h2 id="rt-recharge-title">充值余额，继续使用 Agent</h2>
          </div>
          <button type="button" className="rt-recharge-dialog__close" autoFocus onClick={onClose}>
            <span aria-hidden="true">×</span>
            <span className="rt-sr-only">关闭充值</span>
          </button>
        </header>

        <p className="rt-recharge-dialog__balance">
          当前可用 {yuan(requirement.balanceCents)}，本次需 {yuan(requirement.requiredCents)}
          ；至少充值 {yuan(minimumCents.toString())}。
        </p>

        {!order ? (
          <>
            <fieldset disabled={createOrder.isPending || recoveryInProgress || recoveryUnavailable}>
              <legend>充值金额</legend>
              <div className="rt-recharge-amount">
                <label className="rt-recharge-amount__field">
                  <span>金额（元）</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="如 1 或 0.01"
                    value={amountYuan}
                    onChange={(event) => setAmountYuan(event.target.value)}
                  />
                </label>
                <div className="rt-recharge-amount__quick">
                  {QUICK_AMOUNTS_YUAN.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setAmountYuan(value.toFixed(2))}
                    >
                      {value} 元
                    </button>
                  ))}
                </div>
              </div>
            </fieldset>

            <fieldset disabled={createOrder.isPending || recoveryInProgress || recoveryUnavailable}>
              <legend>支付方式</legend>
              <div className="rt-recharge-pay-types" aria-label="支付品牌">
                <label>
                  <input
                    type="radio"
                    name="recharge-pay-type"
                    checked={payType === 'wechat'}
                    onChange={() => setPayType('wechat')}
                  />
                  微信支付
                </label>
                <label>
                  <input
                    type="radio"
                    name="recharge-pay-type"
                    checked={payType === 'alipay'}
                    onChange={() => setPayType('alipay')}
                  />
                  支付宝
                </label>
              </div>
              <p className="rt-recharge-dialog__notice">下单后请用所选应用扫二维码完成付款。</p>
            </fieldset>

            {recoveryInProgress && (
              <p className="rt-recharge-dialog__notice" role="status">
                正在检查是否已有未完成的充值订单…
              </p>
            )}
            {error && (
              <p className="rt-recharge-dialog__error" role="alert">
                {error}
              </p>
            )}
            <button
              type="button"
              className="rt-recharge-dialog__primary"
              disabled={
                amountCents === null ||
                amountBelowMinimum ||
                recoveryInProgress ||
                recoveryUnavailable ||
                createOrder.isPending
              }
              onClick={() => void submit()}
            >
              {createOrder.isPending ? '正在创建安全订单…' : '创建充值订单'}
            </button>
            {!recoveryInProgress && (
              <button
                type="button"
                className="rt-toolbar-pill"
                onClick={() => {
                  onAbandon?.();
                  onClose();
                }}
              >
                放弃本次任务
              </button>
            )}
          </>
        ) : (
          <RechargeOrderProgress
            order={order}
            qrDataUrl={qrDataUrl}
            error={qrRenderFailed ? '付款二维码生成失败，请关闭窗口后重新打开订单。' : error}
            retrying={replacementCheckPending}
            resumeState={resumeState}
            resumeError={resumeError}
            onAbandon={() => {
              onAbandon?.();
              onClose();
            }}
            onRetry={() => {
              // 一个 intent/order 永远只对应一个不可变的网关流水。终态失败后必须
              // 新建 intent，不能改 trace 后盲目复用旧订单。
              void retryWithFreshIntent();
            }}
            onRetryResume={() => {
              creditedReportedRef.current = null;
              resumeCreditedUsage(activeRechargeIntentId);
            }}
            onRechargeAgain={() => void retryWithFreshIntent(true)}
          />
        )}

        <p className="rt-recharge-dialog__notice">
          支付页面的结果仅供展示。余额只会在服务端确认乐收赢回调或查单结果后到账。
        </p>
      </section>
    </div>
  );
}

function RechargeOrderProgress({
  order,
  qrDataUrl,
  error,
  retrying,
  resumeState,
  resumeError,
  onAbandon,
  onRetry,
  onRetryResume,
  onRechargeAgain,
}: {
  order: RechargeOrderView;
  qrDataUrl: string | null;
  error: string | null;
  retrying: boolean;
  resumeState: 'idle' | 'resuming' | 'failed' | 'completed';
  resumeError: string | null;
  onAbandon: () => void;
  onRetry: () => void;
  onRetryResume: () => void;
  onRechargeAgain: () => void;
}) {
  const amount = (
    <span className="rt-recharge-progress__amount">本笔充值 {yuan(order.amountCents)}</span>
  );
  if (order.status === 'credited') {
    return (
      <div className="rt-recharge-result is-success" role="status">
        <strong>充值已到账</strong>
        {amount}
        {resumeState === 'failed' ? (
          <>
            <span>{resumeError ?? '原任务恢复失败，请重试。'}</span>
            <button type="button" className="rt-recharge-dialog__primary" onClick={onRetryResume}>
              重试原任务
            </button>
            <button
              type="button"
              className="rt-toolbar-pill"
              disabled={retrying}
              onClick={onRechargeAgain}
            >
              余额仍不足？新建一笔充值
            </button>
          </>
        ) : (
          <span>
            {resumeState === 'completed' ? '原任务已恢复。' : '正在以原请求编号继续刚才的任务…'}
          </span>
        )}
      </div>
    );
  }

  if (order.status === 'failed' || order.status === 'closed') {
    return (
      <div className="rt-recharge-result is-error" role="alert">
        <strong>这笔充值没有完成</strong>
        {amount}
        <span>余额没有变化。关闭窗口后可以重新发起充值。</span>
        {error && <span>{error}</span>}
        <button
          type="button"
          className="rt-recharge-dialog__primary"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? '正在复核到账状态…' : '新建一笔充值'}
        </button>
        <button type="button" className="rt-toolbar-pill" onClick={onAbandon}>
          放弃原任务（充值订单仍保留）
        </button>
      </div>
    );
  }

  if (order.reconciliationActive === false) {
    return (
      <div className="rt-recharge-result is-error" role="alert">
        <strong>这笔订单已停止主动查单</strong>
        {amount}
        <span>余额暂未变化；若后续收到可信支付回调，到账仍会自动处理。</span>
        <button
          type="button"
          className="rt-recharge-dialog__primary"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? '正在复核到账状态…' : '新建一笔充值'}
        </button>
        <button type="button" className="rt-toolbar-pill" onClick={onAbandon}>
          放弃原任务（充值订单仍保留）
        </button>
      </div>
    );
  }

  const action = order.paymentAction;
  return (
    <div className="rt-recharge-progress" aria-live="polite">
      {amount}
      {action?.kind === 'qr_code' ? (
        <>
          <strong>
            {order.payType === 'wechat'
              ? '请使用微信扫码'
              : order.payType === 'alipay'
                ? '请使用支付宝扫码'
                : '请使用所选支付应用扫码'}
          </strong>
          {qrDataUrl ? (
            <img src={qrDataUrl} width={240} height={240} alt="乐收赢充值付款二维码" />
          ) : (
            <div className="rt-recharge-qr-placeholder">正在生成二维码…</div>
          )}
        </>
      ) : (
        <strong>正在获取支付入口…</strong>
      )}
      <span>订单状态：{order.status === 'unknown' ? '正在主动确认' : '等待支付确认'}</span>
      {error && (
        <p className="rt-recharge-dialog__error" role="alert">
          {error}
        </p>
      )}
      {!action && (
        <p className="rt-recharge-dialog__notice">
          当前支付入口不可用。旧订单仍会继续查账；若它之后确认成功，充值仍会到账。
        </p>
      )}
      <button type="button" className="rt-toolbar-pill" onClick={onAbandon}>
        放弃原任务（充值订单仍保留）
      </button>
    </div>
  );
}
