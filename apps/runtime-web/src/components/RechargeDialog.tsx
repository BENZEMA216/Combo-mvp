import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { RechargeRequired } from '../api/runtime.js';
import {
  useCreateRechargeOrder,
  useRechargeOrder,
  useRechargeOrderByIntent,
  useRechargePackages,
  useRefreshWallet,
  type RechargeChannel,
  type RechargeOrderView,
  type RechargePayType,
} from '../api/billing.js';
import { ApiError } from '../api/client.js';

export interface RechargeDialogProps {
  requirement: RechargeRequired;
  onClose: () => void;
  onCredited: () => void;
  onAbandon?: () => void;
}

function yuan(cents: string): string {
  const amount = BigInt(cents);
  return `¥${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

function defaultChannel(): RechargeChannel {
  return window.matchMedia?.('(max-width: 720px)').matches ? 'h5' : 'qr';
}

export function RechargeDialog({
  requirement,
  onClose,
  onCredited,
  onAbandon,
}: RechargeDialogProps) {
  const packagesQ = useRechargePackages();
  const createOrder = useCreateRechargeOrder();
  const refreshWallet = useRefreshWallet();
  const [packageId, setPackageId] = useState<string>('');
  const [channel, setChannel] = useState<RechargeChannel>(defaultChannel);
  const [payType, setPayType] = useState<RechargePayType>('alipay');
  const [rechargeIntentId, setRechargeIntentId] = useState(requirement.rechargeIntentId);
  const [createdOrder, setCreatedOrder] = useState<RechargeOrderView | null>(null);
  const recoveredOrderQ = useRechargeOrderByIntent(rechargeIntentId);
  const recoveredOrder = recoveredOrderQ.data ?? null;
  const orderQ = useRechargeOrder(createdOrder?.id ?? recoveredOrder?.id ?? null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrRenderFailed, setQrRenderFailed] = useState(false);
  const [localSubmitError, setLocalSubmitError] = useState<string | null>(null);
  const [replacementCheckPending, setReplacementCheckPending] = useState(false);
  const creditedReportedRef = useRef(false);
  const rechargeUnavailable =
    !packagesQ.isPending && !packagesQ.isError && packagesQ.data?.length === 0;
  const recoveryUnavailable = recoveredOrderQ.isError;
  const recoveryInProgress = recoveredOrderQ.isPending;

  useEffect(() => {
    setRechargeIntentId(requirement.rechargeIntentId);
    setCreatedOrder(null);
    creditedReportedRef.current = false;
  }, [requirement.rechargeIntentId]);

  useEffect(() => {
    const first = packagesQ.data?.[0];
    if (!packageId && first) setPackageId(first.id);
  }, [packageId, packagesQ.data]);

  // 轮询结果是内部订单真源。服务端会在支付动作过期后刻意省略它，不能用初次
  // 下单响应把已经撤销的二维码或跳转地址“补回来”。
  const order = useMemo(
    () => orderQ.data ?? createdOrder ?? recoveredOrder,
    [createdOrder, orderQ.data, recoveredOrder],
  );

  useEffect(() => {
    if (order?.status !== 'credited' || creditedReportedRef.current) return;
    creditedReportedRef.current = true;
    refreshWallet();
    onCredited();
  }, [onCredited, order?.status, refreshWallet]);

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
      !packageId ||
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
        rechargeIntentId,
        packageId,
        channel,
        payType,
      });
      setCreatedOrder(next);
    } catch (cause) {
      // React Query 已保存安全错误供当前对话框展示；阻止事件处理器产生未处理拒绝。
      setLocalSubmitError(
        cause instanceof ApiError ? cause.userMessage : '充值订单创建失败，请稍后重试。',
      );
    }
  };

  const error =
    localSubmitError ??
    (createOrder.error instanceof ApiError
      ? createOrder.error.userMessage
      : orderQ.error instanceof ApiError
        ? orderQ.error.userMessage
        : recoveryUnavailable || createOrder.isError || orderQ.isError
          ? '充值状态暂时无法确认，请稍后重试查询。'
          : null);

  const retryWithFreshIntent = async (): Promise<void> => {
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
      if (latest.data?.status === 'credited') return;
      setRechargeIntentId(crypto.randomUUID());
      setCreatedOrder(null);
      createOrder.reset();
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
          当前可用 {yuan(requirement.balanceCents)}，本次至少需要 {yuan(requirement.requiredCents)}
          。
        </p>

        {!order ? (
          <>
            <fieldset
              disabled={
                packagesQ.isPending ||
                createOrder.isPending ||
                rechargeUnavailable ||
                recoveryInProgress ||
                recoveryUnavailable
              }
            >
              <legend>选择充值金额</legend>
              <div className="rt-recharge-options">
                {packagesQ.data?.map((item) => (
                  <label key={item.id} className={packageId === item.id ? 'is-selected' : ''}>
                    <input
                      type="radio"
                      name="recharge-package"
                      value={item.id}
                      checked={packageId === item.id}
                      onChange={() => setPackageId(item.id)}
                    />
                    <strong>{item.label}</strong>
                    <span>{yuan(item.amountCents)}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset
              disabled={
                createOrder.isPending ||
                rechargeUnavailable ||
                recoveryInProgress ||
                recoveryUnavailable
              }
            >
              <legend>支付方式</legend>
              <div className="rt-recharge-methods">
                <label>
                  <input
                    type="radio"
                    name="recharge-channel"
                    checked={channel === 'qr'}
                    onChange={() => setChannel('qr')}
                  />
                  扫码支付
                </label>
                <label>
                  <input
                    type="radio"
                    name="recharge-channel"
                    checked={channel === 'h5'}
                    onChange={() => setChannel('h5')}
                  />
                  手机收银台
                </label>
              </div>
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
            </fieldset>

            {packagesQ.isError && (
              <p className="rt-recharge-dialog__error" role="alert">
                充值套餐暂时加载失败，请稍后重试。
              </p>
            )}
            {rechargeUnavailable && (
              <p className="rt-recharge-dialog__error" role="alert">
                充值服务暂未开放，请稍后再试或联系支持。
              </p>
            )}
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
                !packageId ||
                rechargeUnavailable ||
                recoveryInProgress ||
                recoveryUnavailable ||
                packagesQ.isPending ||
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
            onAbandon={() => {
              onAbandon?.();
              onClose();
            }}
            onRetry={() => {
              // 一个 intent/order 永远只对应一个不可变的网关流水。终态失败后必须
              // 新建 intent，不能改 trace 后盲目复用旧订单。
              void retryWithFreshIntent();
            }}
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
  onAbandon,
  onRetry,
}: {
  order: RechargeOrderView;
  qrDataUrl: string | null;
  error: string | null;
  retrying: boolean;
  onAbandon: () => void;
  onRetry: () => void;
}) {
  const amount = (
    <span className="rt-recharge-progress__amount">本笔充值 {yuan(order.amountCents)}</span>
  );
  if (order.status === 'credited') {
    return (
      <div className="rt-recharge-result is-success" role="status">
        <strong>充值已到账</strong>
        {amount}
        <span>现在可以关闭窗口，再次发送刚才的任务。</span>
      </div>
    );
  }

  if (order.status === 'failed' || order.status === 'closed') {
    return (
      <div className="rt-recharge-result is-error" role="alert">
        <strong>这笔充值没有完成</strong>
        {amount}
        <span>余额没有变化。关闭窗口后可以重新发起充值。</span>
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
      ) : action?.kind === 'redirect' ? (
        <>
          <strong>充值订单已创建</strong>
          <a
            className="rt-recharge-dialog__primary"
            href={action.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            在新页面打开安全收银台
          </a>
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
