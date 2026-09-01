import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingUsageRecoveryView, RecoveryRechargeOrderView } from '@cb/shared';
import type { RechargeOrderView } from '../api/billing.js';
import { ApiError } from '../api/client.js';
import {
  RechargeDialog as RuntimeRechargeDialog,
  RecoveryRechargeDialog,
  type RechargeDialogProps,
} from './RechargeDialog.js';

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  createRecoveryOrder: vi.fn(),
  recoverByIntent: vi.fn(),
  recoveredOrder: null as RechargeOrderView | null,
  recoveryPending: false,
  recoveryError: false,
  polledOrder: null as RechargeOrderView | null,
  refetchOrder: vi.fn(),
  recoveryOrder: null as RecoveryRechargeOrderView | null,
  recoveryOrderPending: false,
  recoveryOrderError: false,
  refetchRecoveryOrder: vi.fn(),
  refreshWallet: vi.fn(),
  resetCreateOrder: vi.fn(),
  toDataUrl: vi.fn(async () => 'data:image/png;base64,cXItY29kZQ=='),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: mocks.toDataUrl },
}));

vi.mock('../api/billing.js', () => ({
  useCreateRechargeOrder: () => ({
    mutateAsync: mocks.createOrder,
    isPending: false,
    isError: false,
    error: null,
    reset: mocks.resetCreateOrder,
  }),
  useCreateRecoveryRechargeOrder: () => ({
    mutateAsync: mocks.createRecoveryOrder,
    isPending: false,
    isError: false,
    error: null,
  }),
  useRechargeOrderByIntent: (rechargeIntentId: string) => {
    mocks.recoverByIntent(rechargeIntentId);
    return {
      data: mocks.recoveredOrder,
      isPending: mocks.recoveryPending,
      isError: mocks.recoveryError,
      error: null,
    };
  },
  useRechargeOrder: () => ({
    data: mocks.polledOrder,
    isError: false,
    error: null,
    refetch: mocks.refetchOrder,
  }),
  useRechargeOrderByRecovery: () => ({
    data: mocks.recoveryOrder,
    isPending: mocks.recoveryOrderPending,
    isError: mocks.recoveryOrderError,
    error: null,
    refetch: mocks.refetchRecoveryOrder,
  }),
  useRefreshWallet: () => mocks.refreshWallet,
}));

const requirement = {
  rechargeRequired: true,
  rechargeIntentId: '11111111-1111-4111-8111-111111111111',
  balanceCents: '0',
  requiredCents: '100',
} as const;

type TestRechargeDialogProps = Omit<
  RechargeDialogProps,
  'activeRechargeIntentId' | 'onActiveRechargeIntentChange' | 'onCredited'
> & {
  activeRechargeIntentId?: string;
  onActiveRechargeIntentChange?: (rechargeIntentId: string) => void;
  onCredited?: (creditedIntentId: string) => unknown;
};

/** Existing cases get a controlled V2 intent; focused tests can still observe/override transitions. */
function RechargeDialog({
  activeRechargeIntentId: requestedIntentId,
  onActiveRechargeIntentChange,
  onCredited = vi.fn(),
  ...props
}: TestRechargeDialogProps) {
  const [activeIntentId, setActiveIntentId] = useState(
    requestedIntentId ?? props.requirement.rechargeIntentId,
  );
  useEffect(() => {
    setActiveIntentId(requestedIntentId ?? props.requirement.rechargeIntentId);
  }, [props.requirement.rechargeIntentId, requestedIntentId]);
  return (
    <RuntimeRechargeDialog
      {...props}
      activeRechargeIntentId={activeIntentId}
      onActiveRechargeIntentChange={(nextIntentId) => {
        onActiveRechargeIntentChange?.(nextIntentId);
        setActiveIntentId(nextIntentId);
      }}
      onCredited={(creditedIntentId) => Promise.resolve(onCredited(creditedIntentId))}
    />
  );
}

function enterAmount(value: string): void {
  fireEvent.change(screen.getByPlaceholderText('如 1 或 0.01'), { target: { value } });
}

const createButton = () => screen.getByRole('button', { name: '创建充值订单' });

beforeEach(() => {
  mocks.polledOrder = null;
  mocks.recoveredOrder = null;
  mocks.recoveryPending = false;
  mocks.recoveryError = false;
  mocks.recoveryOrder = null;
  mocks.recoveryOrderPending = false;
  mocks.recoveryOrderError = false;
  mocks.createOrder.mockReset();
  mocks.createRecoveryOrder.mockReset();
  mocks.recoverByIntent.mockReset();
  mocks.recoverByIntent.mockReturnValue({});
  mocks.refetchOrder.mockReset();
  mocks.refetchOrder.mockImplementation(async () => ({
    data: mocks.polledOrder ?? mocks.recoveredOrder,
    error: null,
  }));
  mocks.refetchRecoveryOrder.mockReset();
  mocks.refetchRecoveryOrder.mockImplementation(async () => ({
    data: mocks.recoveryOrder,
    error: null,
  }));
  mocks.refreshWallet.mockReset();
  mocks.resetCreateOrder.mockReset();
  mocks.toDataUrl.mockClear();
});

describe('RechargeDialog', () => {
  it('can abandon a 402 task before any payment order exists', async () => {
    const onAbandon = vi.fn();
    const onClose = vi.fn();
    render(
      <RechargeDialog
        requirement={requirement}
        onClose={onClose}
        onCredited={vi.fn()}
        onAbandon={onAbandon}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '放弃本次任务' }));
    expect(onAbandon).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it('requires a valid manual amount before allowing order creation', async () => {
    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);

    expect(createButton()).toBeDisabled();
    enterAmount('0');
    expect(createButton()).toBeDisabled();
    enterAmount('3');
    expect(createButton()).toBeEnabled();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it('requires only the authoritative balance deficit and accepts the exact cent boundary', async () => {
    const deficitRequirement = {
      ...requirement,
      balanceCents: '25',
      requiredCents: '100',
    };
    mocks.createOrder.mockResolvedValue({
      id: '23232323-2323-4232-8232-232323232323',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '75',
      channel: 'qr',
      status: 'pending',
    } satisfies RechargeOrderView);
    render(
      <RechargeDialog requirement={deficitRequirement} onClose={vi.fn()} onCredited={vi.fn()} />,
    );

    expect(screen.getByText(/至少充值 ¥0\.75/u)).toBeInTheDocument();
    enterAmount('0.74');
    expect(createButton()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('本次至少需要充值 ¥0.75');
    enterAmount('0.75');
    expect(createButton()).toBeEnabled();
    fireEvent.click(createButton());

    await waitFor(() =>
      expect(mocks.createOrder).toHaveBeenCalledWith({
        rechargeIntentId: requirement.rechargeIntentId,
        amountCents: 75,
        channel: 'qr',
        payType: 'alipay',
      }),
    );
  });

  it('recovers the persisted replacement intent instead of the original task usageId', async () => {
    render(
      <RechargeDialog
        requirement={requirement}
        activeRechargeIntentId="77777777-7777-4777-8777-777777777777"
        onClose={vi.fn()}
        onCredited={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(mocks.recoverByIntent).toHaveBeenCalledWith('77777777-7777-4777-8777-777777777777'),
    );
    expect(mocks.recoverByIntent).not.toHaveBeenCalledWith(requirement.rechargeIntentId);
  });

  it('fills the amount from a quick amount button', async () => {
    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '5 元' }));
    const input = screen.getByPlaceholderText('如 1 或 0.01') as HTMLInputElement;
    expect(input.value).toBe('5.00');
    expect(createButton()).toBeEnabled();
  });

  it('rejects an out-of-range manual amount', async () => {
    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);

    enterAmount('1000000');
    expect(createButton()).toBeDisabled();
    enterAmount('not-a-number');
    expect(createButton()).toBeDisabled();
  });

  it('recovers an existing order by intent before allowing another gateway POST', async () => {
    mocks.recoveredOrder = {
      id: '29292929-2929-4292-8292-292929292929',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'weixin://wxpay/recovered' },
    };

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);

    expect(await screen.findByRole('img', { name: '乐收赢充值付款二维码' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '创建充值订单' })).not.toBeInTheDocument();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it('shows the persisted brand for a recovered QR order', async () => {
    mocks.recoveredOrder = {
      id: '29292929-2929-4292-8292-292929292929',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      payType: 'wechat',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'weixin://wxpay/recovered' },
    };

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);

    expect(await screen.findByText('请使用微信扫码')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '创建充值订单' })).not.toBeInTheDocument();
  });

  it('fails closed but still lets the user abandon the task when intent recovery fails', async () => {
    mocks.recoveryError = true;
    const onAbandon = vi.fn();
    const onClose = vi.fn();
    render(
      <RechargeDialog
        requirement={requirement}
        onClose={onClose}
        onCredited={vi.fn()}
        onAbandon={onAbandon}
      />,
    );

    expect(await screen.findByText('充值状态暂时无法确认，请稍后重试查询。')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '放弃本次任务' }));
    expect(onAbandon).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it('creates a QR order from a manually entered amount and renders only a QR image', async () => {
    mocks.createOrder.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'https://cashier.test/opaque' },
    } satisfies RechargeOrderView);

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);
    enterAmount('3');
    fireEvent.click(createButton());

    await waitFor(() =>
      expect(mocks.createOrder).toHaveBeenCalledWith({
        rechargeIntentId: requirement.rechargeIntentId,
        amountCents: 300,
        channel: 'qr',
        payType: 'alipay',
      }),
    );
    expect(await screen.findByRole('img', { name: '乐收赢充值付款二维码' })).toHaveAttribute(
      'src',
      'data:image/png;base64,cXItY29kZQ==',
    );
    expect(screen.getByText('本笔充值 ¥3.00')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('switches the QR brand to WeChat and sends payType wechat', async () => {
    mocks.createOrder.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'https://cashier.test/wechat' },
    } satisfies RechargeOrderView);

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);
    enterAmount('3');
    fireEvent.click(screen.getByRole('radio', { name: '微信支付' }));
    fireEvent.click(createButton());

    await waitFor(() =>
      expect(mocks.createOrder).toHaveBeenCalledWith({
        rechargeIntentId: requirement.rechargeIntentId,
        amountCents: 300,
        channel: 'qr',
        payType: 'wechat',
      }),
    );
  });

  it('shows a safe failure when order creation rejects without leaking an unhandled promise', async () => {
    mocks.createOrder.mockRejectedValue(
      new Error('test-only provider response that must not be displayed'),
    );

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);
    enterAmount('3');
    fireEvent.click(createButton());

    expect(await screen.findByText('充值订单创建失败，请稍后重试。')).toBeInTheDocument();
    expect(screen.queryByText(/test-only provider response/u)).not.toBeInTheDocument();
  });

  it('turns a local QR rendering rejection into a visible retry message', async () => {
    mocks.toDataUrl.mockRejectedValueOnce(new Error('test renderer failure'));
    mocks.createOrder.mockResolvedValue({
      id: '38383838-3838-4383-8383-383838383838',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'weixin://wxpay/opaque' },
    } satisfies RechargeOrderView);

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);
    enterAmount('3');
    fireEvent.click(createButton());

    expect(
      await screen.findByText('付款二维码生成失败，请关闭窗口后重新打开订单。'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '乐收赢充值付款二维码' })).not.toBeInTheDocument();
  });

  it('announces credit only after the polled internal order becomes credited', async () => {
    const pending = {
      id: '44444444-4444-4444-8444-444444444444',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'https://cashier.test/opaque' },
    } satisfies RechargeOrderView;
    mocks.createOrder.mockResolvedValue(pending);
    const onCredited = vi.fn();
    const view = render(
      <RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={onCredited} />,
    );
    enterAmount('3');
    fireEvent.click(createButton());
    await screen.findByRole('img', { name: '乐收赢充值付款二维码' });
    expect(onCredited).not.toHaveBeenCalled();

    mocks.polledOrder = { ...pending, status: 'credited', paymentAction: undefined };
    view.rerender(
      <RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={onCredited} />,
    );

    expect(await screen.findByText('充值已到账')).toBeInTheDocument();
    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
    expect(mocks.refreshWallet).toHaveBeenCalledTimes(1);
  });

  it('does not accept a credited order returned for a different active intent', async () => {
    mocks.recoveredOrder = {
      id: '45454545-4545-4454-8454-454545454545',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '100',
      channel: 'qr',
      status: 'credited',
    };
    const onCredited = vi.fn();

    render(
      <RechargeDialog
        requirement={requirement}
        activeRechargeIntentId="77777777-7777-4777-8777-777777777777"
        onClose={vi.fn()}
        onCredited={onCredited}
      />,
    );

    expect(
      await screen.findByText('充值订单与当前恢复任务不匹配，请刷新页面后重试。'),
    ).toBeInTheDocument();
    expect(onCredited).not.toHaveBeenCalled();
    expect(mocks.refreshWallet).not.toHaveBeenCalled();
  });

  it('reports one exact credited intent under React StrictMode', async () => {
    mocks.recoveredOrder = {
      id: '46464646-4646-4464-8464-464646464646',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '100',
      channel: 'qr',
      status: 'credited',
    };
    const onCredited = vi.fn(async () => undefined);

    render(
      <StrictMode>
        <RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={onCredited} />
      </StrictMode>,
    );

    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
    expect(onCredited).toHaveBeenCalledWith(requirement.rechargeIntentId);
  });

  it('keeps the credited order visible and retries the exact original task after a resume error', async () => {
    mocks.recoveredOrder = {
      id: '47474747-4747-4474-8474-474747474747',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '100',
      channel: 'qr',
      status: 'credited',
    };
    const onCredited = vi
      .fn()
      .mockRejectedValueOnce(new Error('原任务仍在确认，请重试。'))
      .mockResolvedValueOnce(undefined);
    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={onCredited} />);

    expect(await screen.findByText('原任务仍在确认，请重试。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试原任务' }));
    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(2));
    expect(onCredited).toHaveBeenNthCalledWith(1, requirement.rechargeIntentId);
    expect(onCredited).toHaveBeenNthCalledWith(2, requirement.rechargeIntentId);
  });

  it('changes a credited intent only after the user explicitly asks for another recharge', async () => {
    mocks.recoveredOrder = {
      id: '49494949-4949-4494-8494-494949494949',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '100',
      channel: 'qr',
      status: 'credited',
    };
    const onIntentChange = vi.fn<(rechargeIntentId: string) => void>();
    render(
      <RechargeDialog
        requirement={requirement}
        onClose={vi.fn()}
        onActiveRechargeIntentChange={onIntentChange}
        onCredited={vi.fn().mockRejectedValue(new Error('余额仍不足。'))}
      />,
    );

    const replace = await screen.findByRole('button', {
      name: '余额仍不足？新建一笔充值',
    });
    expect(onIntentChange).not.toHaveBeenCalled();
    fireEvent.click(replace);

    await waitFor(() => expect(onIntentChange).toHaveBeenCalledOnce());
    expect(onIntentChange.mock.calls[0]?.[0]).not.toBe(requirement.rechargeIntentId);
    expect(mocks.resetCreateOrder).toHaveBeenCalledOnce();
  });

  it('removes an expired payment action when the internal order stops returning it', async () => {
    const pending = {
      id: '48484848-4848-4484-8484-484848484848',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'weixin://wxpay/opaque' },
    } satisfies RechargeOrderView;
    mocks.createOrder.mockResolvedValue(pending);
    const view = render(
      <RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />,
    );
    enterAmount('3');
    fireEvent.click(createButton());
    expect(await screen.findByRole('img', { name: '乐收赢充值付款二维码' })).toBeInTheDocument();

    mocks.polledOrder = { ...pending, paymentAction: undefined };
    view.rerender(
      <RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />,
    );

    await waitFor(() =>
      expect(screen.queryByRole('img', { name: '乐收赢充值付款二维码' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('正在获取支付入口…')).toBeInTheDocument();
  });

  it('can abandon the original task when a recovered payment order has no usable action', async () => {
    mocks.recoveredOrder = {
      id: '58585858-5858-4585-8585-585858585858',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      status: 'unknown',
    };
    const onAbandon = vi.fn();
    const onClose = vi.fn();

    render(
      <RechargeDialog
        requirement={requirement}
        onClose={onClose}
        onCredited={vi.fn()}
        onAbandon={onAbandon}
      />,
    );

    expect(await screen.findByText('正在获取支付入口…')).toBeInTheDocument();
    expect(
      screen.getByText(/旧订单仍会继续查账；若它之后确认成功，充值仍会到账/u),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '放弃原任务（充值订单仍保留）' }));
    expect(onAbandon).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it('stops presenting an exhausted order as actively confirming and offers a new order', async () => {
    mocks.recoveredOrder = {
      id: '59595959-5959-4595-8595-595959595959',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      status: 'unknown',
      reconciliationActive: false,
    };

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);

    expect(await screen.findByText('这笔订单已停止主动查单')).toBeInTheDocument();
    expect(screen.getByText(/若后续收到可信支付回调，到账仍会自动处理/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建一笔充值' })).toBeInTheDocument();
    expect(screen.queryByText('正在主动确认')).not.toBeInTheDocument();
  });

  it('rechecks an exhausted order and does not replace it when a late callback credited it', async () => {
    const retired = {
      id: '60606060-6060-4606-8606-606060606060',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      status: 'unknown',
      reconciliationActive: false,
    } satisfies RechargeOrderView;
    mocks.recoveredOrder = retired;
    mocks.refetchOrder.mockResolvedValueOnce({
      data: { ...retired, status: 'credited' },
      error: null,
    });

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '新建一笔充值' }));

    await waitFor(() => expect(mocks.refetchOrder).toHaveBeenCalledOnce());
    expect(mocks.resetCreateOrder).not.toHaveBeenCalled();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it('uses a new intent after a terminal failure instead of mutating the old gateway trace', async () => {
    const failed = {
      id: '55555555-5555-4555-8555-555555555555',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      status: 'failed',
    } satisfies RechargeOrderView;
    mocks.createOrder.mockResolvedValueOnce(failed).mockResolvedValueOnce({
      ...failed,
      id: '66666666-6666-4666-8666-666666666666',
      rechargeIntentId: '77777777-7777-4777-8777-777777777777',
      status: 'pending',
    } satisfies RechargeOrderView);

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);
    enterAmount('3');
    fireEvent.click(createButton());
    fireEvent.click(await screen.findByRole('button', { name: '新建一笔充值' }));
    const freshInput = await screen.findByPlaceholderText('如 1 或 0.01');
    fireEvent.change(freshInput, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '创建充值订单' }));

    await waitFor(() => expect(mocks.createOrder).toHaveBeenCalledTimes(2));
    const firstIntent = (
      mocks.createOrder.mock.calls[0]?.[0] as { rechargeIntentId: string } | undefined
    )?.rechargeIntentId;
    const secondIntent = (
      mocks.createOrder.mock.calls[1]?.[0] as { rechargeIntentId: string } | undefined
    )?.rechargeIntentId;
    expect(firstIntent).toBe(requirement.rechargeIntentId);
    expect(secondIntent).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(secondIntent).not.toBe(firstIntent);
    expect(mocks.resetCreateOrder).toHaveBeenCalledOnce();
  });

  it('does not switch a terminal order when persisting its replacement intent fails', async () => {
    mocks.recoveredOrder = {
      id: '67676767-6767-4676-8676-676767676767',
      rechargeIntentId: requirement.rechargeIntentId,
      amountCents: '300',
      channel: 'qr',
      status: 'failed',
    };
    const onIntentChange = vi.fn<(rechargeIntentId: string) => void>(() => {
      throw new Error('无法保存充值恢复状态，请检查浏览器存储设置后重试。');
    });
    render(
      <RechargeDialog
        requirement={requirement}
        onClose={vi.fn()}
        onActiveRechargeIntentChange={onIntentChange}
        onCredited={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '新建一笔充值' }));
    await waitFor(() => expect(onIntentChange).toHaveBeenCalledOnce());
    expect(onIntentChange.mock.calls[0]?.[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(mocks.resetCreateOrder).not.toHaveBeenCalled();
    expect(mocks.recoverByIntent).not.toHaveBeenCalledWith(onIntentChange.mock.calls[0]?.[0]);
  });
});

describe('RecoveryRechargeDialog', () => {
  it('creates an exact order at the shared recovery amount maximum', async () => {
    const recovery = pendingRecovery({
      billing: { ...pendingRecovery().billing, unitPriceCents: '99999999' },
    });
    mocks.createRecoveryOrder.mockResolvedValue(
      recoveryOrder(recovery, recovery.activeRechargeIntentId, 'pending'),
    );
    const onRefreshRecovery = vi.fn(async () => recovery);
    render(
      <RecoveryRechargeDialog
        recovery={recovery}
        onClose={vi.fn()}
        onCredited={vi.fn(async () => undefined)}
        onRefreshRecovery={onRefreshRecovery}
        onAbandon={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '按冻结价格创建充值订单' }));
    await waitFor(() =>
      expect(mocks.createRecoveryOrder).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 99_999_999 }),
      ),
    );
    expect(onRefreshRecovery).toHaveBeenCalledOnce();
  });

  it('fails closed above the shared recovery amount maximum without creating an order', () => {
    const recovery = pendingRecovery({
      billing: { ...pendingRecovery().billing, unitPriceCents: '100000000' },
    });
    const onRefreshRecovery = vi.fn(async () => recovery);
    render(
      <RecoveryRechargeDialog
        recovery={recovery}
        onClose={vi.fn()}
        onCredited={vi.fn(async () => undefined)}
        onRefreshRecovery={onRefreshRecovery}
        onAbandon={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('超出安全订单范围，已停止付款');
    expect(screen.getByRole('button', { name: '按冻结价格创建充值订单' })).toBeDisabled();
    expect(mocks.createRecoveryOrder).not.toHaveBeenCalled();
    expect(onRefreshRecovery).not.toHaveBeenCalled();
  });

  it('creates only the exact frozen-price order with explicit recovery and current intent', async () => {
    const recovery = pendingRecovery();
    const nextOrder = recoveryOrder(recovery, recovery.activeRechargeIntentId, 'pending', {
      paymentAction: { kind: 'qr_code', url: 'https://cashier.test/recovery' },
    });
    mocks.createRecoveryOrder.mockResolvedValue(nextOrder);
    const onRefreshRecovery = vi.fn(async () => recovery);

    render(
      <RecoveryRechargeDialog
        recovery={recovery}
        onClose={vi.fn()}
        onCredited={vi.fn(async () => undefined)}
        onRefreshRecovery={onRefreshRecovery}
        onAbandon={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByText(/本次固定充值 ¥1\.00/u)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('如 1 或 0.01')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '按冻结价格创建充值订单' }));

    await waitFor(() =>
      expect(mocks.createRecoveryOrder).toHaveBeenCalledWith({
        recoveryUsageId: recovery.usageId,
        rechargeIntentId: recovery.activeRechargeIntentId,
        amountCents: 100,
        channel: 'qr',
        payType: 'alipay',
      }),
    );
    expect(onRefreshRecovery).toHaveBeenCalledOnce();
    expect(await screen.findByRole('img', { name: '乐收赢充值付款二维码' })).toBeInTheDocument();
  });

  it('shows a replacement only after its order CAS and exact recovery refresh both succeed', async () => {
    const initial = pendingRecovery();
    const failed = recoveryOrder(initial, initial.activeRechargeIntentId, 'failed');
    mocks.recoveryOrder = failed;
    mocks.refetchRecoveryOrder.mockResolvedValue({ data: failed, error: null });
    const replacementIntent = '77777777-7777-4777-8777-777777777777';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(replacementIntent);
    mocks.createRecoveryOrder.mockResolvedValue(
      recoveryOrder(initial, replacementIntent, 'pending', {
        paymentAction: { kind: 'qr_code', url: 'https://cashier.test/replacement' },
      }),
    );
    const onRefresh = vi.fn();

    function Harness() {
      const [recovery, setRecovery] = useState(initial);
      return (
        <RecoveryRechargeDialog
          recovery={recovery}
          onClose={vi.fn()}
          onCredited={vi.fn(async () => undefined)}
          onRefreshRecovery={async () => {
            onRefresh();
            const refreshed = { ...initial, activeRechargeIntentId: replacementIntent };
            setRecovery(refreshed);
            return refreshed;
          }}
          onAbandon={vi.fn(async () => undefined)}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: '新建一笔充值' }));

    await waitFor(() =>
      expect(mocks.createRecoveryOrder).toHaveBeenCalledWith({
        recoveryUsageId: initial.usageId,
        rechargeIntentId: replacementIntent,
        amountCents: 100,
        channel: 'qr',
        payType: 'alipay',
      }),
    );
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(mocks.createRecoveryOrder.mock.invocationCallOrder[0]).toBeLessThan(
      onRefresh.mock.invocationCallOrder[0]!,
    );
    expect(await screen.findByRole('img', { name: '乐收赢充值付款二维码' })).toBeInTheDocument();
  });

  it('resumes the credited old intent once even when the server points at a replacement', async () => {
    const recovery = pendingRecovery({
      activeRechargeIntentId: '77777777-7777-4777-8777-777777777777',
    });
    const creditedOldIntent = '88888888-8888-4888-8888-888888888888';
    mocks.recoveryOrder = recoveryOrder(recovery, creditedOldIntent, 'credited');
    const onCredited = vi.fn(async () => undefined);

    render(
      <StrictMode>
        <RecoveryRechargeDialog
          recovery={recovery}
          onClose={vi.fn()}
          onCredited={onCredited}
          onRefreshRecovery={vi.fn(async () => recovery)}
          onAbandon={vi.fn(async () => undefined)}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
    expect(onCredited).toHaveBeenCalledWith(creditedOldIntent);
    expect(mocks.createRecoveryOrder).not.toHaveBeenCalled();
  });

  it('keeps the dialog on server abandon 409 and closes only after a successful abandon', async () => {
    const recovery = pendingRecovery();
    const onClose = vi.fn();
    const onAbandon = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('任务正在恢复，不能放弃。', 409))
      .mockResolvedValueOnce(undefined);
    render(
      <RecoveryRechargeDialog
        recovery={recovery}
        onClose={onClose}
        onCredited={vi.fn(async () => undefined)}
        onRefreshRecovery={vi.fn(async () => recovery)}
        onAbandon={onAbandon}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '放弃原任务' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('任务正在恢复，不能放弃。');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '放弃原任务' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('rejects a mismatched order response without refreshing or showing a payment action', async () => {
    const recovery = pendingRecovery();
    mocks.createRecoveryOrder.mockResolvedValue({
      ...recoveryOrder(recovery, recovery.activeRechargeIntentId, 'pending'),
      amountCents: '200',
      paymentAction: { kind: 'qr_code', url: 'https://cashier.test/wrong-price' },
    });
    const onRefreshRecovery = vi.fn(async () => recovery);
    render(
      <RecoveryRechargeDialog
        recovery={recovery}
        onClose={vi.fn()}
        onCredited={vi.fn(async () => undefined)}
        onRefreshRecovery={onRefreshRecovery}
        onAbandon={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '按冻结价格创建充值订单' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('未能与服务端待恢复任务绑定');
    expect(onRefreshRecovery).not.toHaveBeenCalled();
    expect(screen.queryByRole('img', { name: '乐收赢充值付款二维码' })).not.toBeInTheDocument();
  });
});

function pendingRecovery(
  overrides: Partial<PendingUsageRecoveryView> = {},
): PendingUsageRecoveryView {
  return {
    usageId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    capabilityId: '33333333-3333-4333-8333-333333333333',
    requestText: '前三次免费额度用完以后会怎样？',
    requestFingerprint: '4'.repeat(64),
    binding: {
      productKind: 'knowledge_agent_test',
      capability: {
        id: '33333333-3333-4333-8333-333333333333',
        protocol: 'combo.agent-package-capability/2',
      },
      release: {
        protocol: 'combo.agent-package-release/1',
        releaseId: `release.agent-package.${'5'.repeat(32)}`,
        packageDigest: `sha256:${'6'.repeat(64)}`,
      },
      releaseScope: 'controlled_test',
      knowledge: {
        protocol: 'combo.knowledge-bundle/1',
        resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
        resourceDigest: `sha256:${'7'.repeat(64)}`,
      },
    },
    billing: {
      currency: 'CNY',
      policyVersion: 'runtime-usage-v1',
      validatorPolicyVersion: 'knowledge-agent-grounded-validator-v2',
      unitPriceCents: '100',
      freeLimitSnapshot: 3,
    },
    status: 'active',
    activeRechargeIntentId: '11111111-1111-4111-8111-111111111111',
    expiresAt: '2026-09-03T00:00:00.000Z',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:01:00.000Z',
    ...overrides,
  };
}

function recoveryOrder(
  recovery: PendingUsageRecoveryView,
  rechargeIntentId: string,
  status: RecoveryRechargeOrderView['status'],
  overrides: Partial<RecoveryRechargeOrderView> = {},
): RecoveryRechargeOrderView {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    recoveryUsageId: recovery.usageId,
    rechargeIntentId,
    amountCents: recovery.billing.unitPriceCents,
    channel: 'qr',
    payType: 'alipay',
    status,
    reconciliationActive: status === 'pending',
    createdAt: '2026-09-02T00:02:00.000Z',
    updatedAt: '2026-09-02T00:03:00.000Z',
    ...overrides,
  };
}
