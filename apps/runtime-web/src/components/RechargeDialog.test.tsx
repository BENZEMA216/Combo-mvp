import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RechargeOrderView } from '../api/billing.js';
import { RechargeDialog } from './RechargeDialog.js';

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  packages: [{ id: 'sandbox-300', amountCents: '300', label: '测试充值' }],
  recoveredOrder: null as RechargeOrderView | null,
  recoveryPending: false,
  recoveryError: false,
  polledOrder: null as RechargeOrderView | null,
  refetchOrder: vi.fn(),
  refreshWallet: vi.fn(),
  resetCreateOrder: vi.fn(),
  toDataUrl: vi.fn(async () => 'data:image/png;base64,cXItY29kZQ=='),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: mocks.toDataUrl },
}));

vi.mock('../api/billing.js', () => ({
  useRechargePackages: () => ({
    data: mocks.packages,
    isPending: false,
    isError: false,
  }),
  useCreateRechargeOrder: () => ({
    mutateAsync: mocks.createOrder,
    isPending: false,
    isError: false,
    error: null,
    reset: mocks.resetCreateOrder,
  }),
  useRechargeOrderByIntent: () => ({
    data: mocks.recoveredOrder,
    isPending: mocks.recoveryPending,
    isError: mocks.recoveryError,
    error: null,
  }),
  useRechargeOrder: () => ({
    data: mocks.polledOrder,
    isError: false,
    error: null,
    refetch: mocks.refetchOrder,
  }),
  useRefreshWallet: () => mocks.refreshWallet,
}));

const requirement = {
  rechargeRequired: true,
  rechargeIntentId: '11111111-1111-4111-8111-111111111111',
  balanceCents: '0',
  requiredCents: '100',
} as const;

beforeEach(() => {
  mocks.packages = [{ id: 'sandbox-300', amountCents: '300', label: '测试充值' }];
  mocks.polledOrder = null;
  mocks.recoveredOrder = null;
  mocks.recoveryPending = false;
  mocks.recoveryError = false;
  mocks.createOrder.mockReset();
  mocks.refetchOrder.mockReset();
  mocks.refetchOrder.mockImplementation(async () => ({
    data: mocks.polledOrder ?? mocks.recoveredOrder,
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

  it('recovers an existing order by intent before allowing another gateway POST', async () => {
    mocks.recoveredOrder = {
      id: '29292929-2929-4292-8292-292929292929',
      rechargeIntentId: requirement.rechargeIntentId,
      packageId: 'sandbox-300',
      amountCents: '300',
      channel: 'aggregate_qr',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'weixin://wxpay/recovered' },
    };

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);

    expect(await screen.findByRole('img', { name: '乐收赢充值付款二维码' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '创建充值订单' })).not.toBeInTheDocument();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it('fails closed with an explicit message when no recharge package is configured', async () => {
    mocks.packages = [];
    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);

    expect(await screen.findByText('充值服务暂未开放，请稍后再试或联系支持。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建充值订单' })).toBeDisabled();
    expect(mocks.createOrder).not.toHaveBeenCalled();
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
    expect(screen.getByRole('button', { name: '创建充值订单' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '放弃本次任务' }));
    expect(onAbandon).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it('creates an aggregate QR order from a configured package and renders only a QR image', async () => {
    mocks.createOrder.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      rechargeIntentId: requirement.rechargeIntentId,
      packageId: 'sandbox-300',
      amountCents: '300',
      channel: 'aggregate_qr',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'https://cashier.test/opaque' },
    } satisfies RechargeOrderView);

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: /测试充值/ })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: '创建充值订单' }));

    await waitFor(() =>
      expect(mocks.createOrder).toHaveBeenCalledWith({
        rechargeIntentId: requirement.rechargeIntentId,
        packageId: 'sandbox-300',
        channel: 'aggregate_qr',
      }),
    );
    expect(await screen.findByRole('img', { name: '乐收赢充值付款二维码' })).toHaveAttribute(
      'src',
      'data:image/png;base64,cXItY29kZQ==',
    );
    expect(screen.getByText('本笔充值 ¥3.00')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('requires a constrained payment brand for H5 and never treats the redirect as success', async () => {
    mocks.createOrder.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      rechargeIntentId: requirement.rechargeIntentId,
      packageId: 'sandbox-300',
      amountCents: '300',
      channel: 'h5',
      status: 'pending',
      paymentAction: { kind: 'redirect', url: 'https://cashier.test/h5' },
    } satisfies RechargeOrderView);

    const onCredited = vi.fn();
    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={onCredited} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: /测试充值/ })).toBeChecked());
    fireEvent.click(screen.getByRole('radio', { name: '手机收银台' }));
    fireEvent.click(screen.getByRole('radio', { name: '支付宝' }));
    fireEvent.click(screen.getByRole('button', { name: '创建充值订单' }));

    await waitFor(() =>
      expect(mocks.createOrder).toHaveBeenCalledWith({
        rechargeIntentId: requirement.rechargeIntentId,
        packageId: 'sandbox-300',
        channel: 'h5',
        payType: 'alipay',
      }),
    );
    expect(await screen.findByRole('link', { name: '在新页面打开安全收银台' })).toHaveAttribute(
      'href',
      'https://cashier.test/h5',
    );
    expect(onCredited).not.toHaveBeenCalled();
  });

  it('shows a safe failure when order creation rejects without leaking an unhandled promise', async () => {
    mocks.createOrder.mockRejectedValue(
      new Error('test-only provider response that must not be displayed'),
    );

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: /测试充值/ })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: '创建充值订单' }));

    expect(await screen.findByText('充值订单创建失败，请稍后重试。')).toBeInTheDocument();
    expect(screen.queryByText(/test-only provider response/u)).not.toBeInTheDocument();
  });

  it('turns a local QR rendering rejection into a visible retry message', async () => {
    mocks.toDataUrl.mockRejectedValueOnce(new Error('test renderer failure'));
    mocks.createOrder.mockResolvedValue({
      id: '38383838-3838-4383-8383-383838383838',
      rechargeIntentId: requirement.rechargeIntentId,
      packageId: 'sandbox-300',
      amountCents: '300',
      channel: 'aggregate_qr',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'weixin://wxpay/opaque' },
    } satisfies RechargeOrderView);

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: /测试充值/ })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: '创建充值订单' }));

    expect(
      await screen.findByText('付款二维码生成失败，请关闭窗口后重新打开订单。'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '乐收赢充值付款二维码' })).not.toBeInTheDocument();
  });

  it('announces credit only after the polled internal order becomes credited', async () => {
    const pending = {
      id: '44444444-4444-4444-8444-444444444444',
      rechargeIntentId: requirement.rechargeIntentId,
      packageId: 'sandbox-300',
      amountCents: '300',
      channel: 'aggregate_qr',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'https://cashier.test/opaque' },
    } satisfies RechargeOrderView;
    mocks.createOrder.mockResolvedValue(pending);
    const onCredited = vi.fn();
    const view = render(
      <RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={onCredited} />,
    );
    await waitFor(() => expect(screen.getByRole('radio', { name: /测试充值/ })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: '创建充值订单' }));
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

  it('removes an expired payment action when the internal order stops returning it', async () => {
    const pending = {
      id: '48484848-4848-4484-8484-484848484848',
      rechargeIntentId: requirement.rechargeIntentId,
      packageId: 'sandbox-300',
      amountCents: '300',
      channel: 'aggregate_qr',
      status: 'pending',
      paymentAction: { kind: 'qr_code', url: 'weixin://wxpay/opaque' },
    } satisfies RechargeOrderView;
    mocks.createOrder.mockResolvedValue(pending);
    const view = render(
      <RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByRole('radio', { name: /测试充值/ })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: '创建充值订单' }));
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
      packageId: 'sandbox-300',
      amountCents: '300',
      channel: 'aggregate_qr',
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
      packageId: 'sandbox-300',
      amountCents: '300',
      channel: 'aggregate_qr',
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
      packageId: 'sandbox-300',
      amountCents: '300',
      channel: 'aggregate_qr',
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
      packageId: 'sandbox-300',
      amountCents: '300',
      channel: 'aggregate_qr',
      status: 'failed',
    } satisfies RechargeOrderView;
    mocks.createOrder.mockResolvedValueOnce(failed).mockResolvedValueOnce({
      ...failed,
      id: '66666666-6666-4666-8666-666666666666',
      rechargeIntentId: '77777777-7777-4777-8777-777777777777',
      status: 'pending',
    } satisfies RechargeOrderView);

    render(<RechargeDialog requirement={requirement} onClose={vi.fn()} onCredited={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: /测试充值/ })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: '创建充值订单' }));
    fireEvent.click(await screen.findByRole('button', { name: '新建一笔充值' }));
    fireEvent.click(await screen.findByRole('button', { name: '创建充值订单' }));

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
});
