import { describe, expect, it, vi } from 'vitest';
import {
  InvalidPaymentNotificationError,
  LeshouyingPaymentGateway,
  PaymentGatewayUncertainError,
  signPaymentParameters,
  verifyPaymentSignature,
} from '../platform/infra/leshouying/index.js';

const KEY = 'test-only-institution-key';
const CONFIG = {
  environment: 'TEST' as const,
  institutionNo: 'INST0001',
  merchantNo: 'MCH_TEST_001',
  institutionKey: KEY,
  notifyUrl: 'https://api.example.test/api/v1/billing/leshouying/payment-notify',
  frontUrl: 'https://app.example.test/billing',
  timeoutMs: 1_000,
};

function signedResponse(fields: Record<string, string | null>): Response {
  const body = { ...fields, sign: signPaymentParameters(fields, KEY) };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Leshouying payment gateway', () => {
  it('creates a signed H5 request and only returns a safe HTTPS redirect', async () => {
    const fetchPort = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://test.gdyfsk.com/yfpay/v3/h5pay');
      expect(init.redirect).toBe('error');
      const request = JSON.parse(String(init.body)) as Record<string, string>;
      expect(request).toMatchObject({
        inst_no: 'INST0001',
        mch_no: 'MCH_TEST_001',
        pay_type: '400',
        total_amount: '300',
        attach: 'CBR-1',
        notify_url: CONFIG.notifyUrl,
      });
      expect(verifyPaymentSignature(request, KEY)).toBe(true);
      return signedResponse({
        return_code: 'SUCCESS',
        result_code: 'PAY_SUCCESS',
        return_msg: '下单成功',
        pay_type: '400',
        mch_no: 'MCH_TEST_001',
        pay_trace_no: 'TRACE-1',
        pay_time: '20260728120000',
        total_amount: '300',
        trade_no: 'TRADE-1',
        code_url: 'https://cashier.example.test/pay?id=opaque',
      });
    });
    const gateway = new LeshouyingPaymentGateway(CONFIG, fetchPort);

    await expect(
      gateway.createPayment({
        orderNo: 'CBR-1',
        payTraceNo: 'TRACE-1',
        payTime: '20260728120000',
        amountCents: 300n,
        channel: 'h5',
        payType: 'wechat',
      }),
    ).resolves.toEqual({
      status: 'pending',
      gatewayResultCode: 'PAY_SUCCESS',
      platformTradeNo: 'TRADE-1',
      action: {
        kind: 'redirect_url',
        value: 'https://cashier.example.test/pay?id=opaque',
        expiresAt: expect.any(Date),
      },
    });
    expect(fetchPort).toHaveBeenCalledTimes(1);
  });

  it('accepts length-bounded opaque aggregate QR content but rejects unsafe H5 URLs', async () => {
    const qrGateway = new LeshouyingPaymentGateway(
      CONFIG,
      vi.fn(async () =>
        signedResponse({
          return_code: 'SUCCESS',
          result_code: 'PAY_SUCCESS',
          return_msg: '预支付成功',
          mch_no: 'MCH_TEST_001',
          pay_trace_no: 'TRACE-QR',
          pay_time: '20260728120000',
          total_amount: '100',
          code_url: 'weixin://wxpay/bizpayurl?pr=opaque',
        }),
      ),
    );
    await expect(
      qrGateway.createPayment({
        orderNo: 'CBR-QR',
        payTraceNo: 'TRACE-QR',
        payTime: '20260728120000',
        amountCents: 100n,
        channel: 'aggregate_qr',
      }),
    ).resolves.toMatchObject({
      action: {
        kind: 'code_url',
        value: 'weixin://wxpay/bizpayurl?pr=opaque',
        expiresAt: expect.any(Date),
      },
    });

    const h5Gateway = new LeshouyingPaymentGateway(
      CONFIG,
      vi.fn(async () =>
        signedResponse({
          return_code: 'SUCCESS',
          result_code: 'PAY_SUCCESS',
          return_msg: '下单成功',
          pay_type: '300',
          mch_no: 'MCH_TEST_001',
          pay_trace_no: 'TRACE-H5',
          pay_time: '20260728120000',
          total_amount: '100',
          code_url: 'javascript:alert(1)',
        }),
      ),
    );
    await expect(
      h5Gateway.createPayment({
        orderNo: 'CBR-H5',
        payTraceNo: 'TRACE-H5',
        payTime: '20260728120000',
        amountCents: 100n,
        channel: 'h5',
        payType: 'alipay',
      }),
    ).rejects.toBeInstanceOf(PaymentGatewayUncertainError);
  });

  it('does not retry a timed-out POST and treats an invalid response signature as uncertain', async () => {
    const failedFetch = vi.fn(async () => {
      throw new Error('test transport failure');
    });
    const gateway = new LeshouyingPaymentGateway(CONFIG, failedFetch);
    await expect(
      gateway.createPayment({
        orderNo: 'CBR-2',
        payTraceNo: 'TRACE-2',
        payTime: '20260728120000',
        amountCents: 100n,
        channel: 'aggregate_qr',
      }),
    ).rejects.toBeInstanceOf(PaymentGatewayUncertainError);
    expect(failedFetch).toHaveBeenCalledTimes(1);

    const invalidSignatureGateway = new LeshouyingPaymentGateway(
      CONFIG,
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              return_code: 'SUCCESS',
              result_code: 'PAY_SUCCESS',
              mch_no: 'MCH_TEST_001',
              pay_trace_no: 'TRACE-3',
              pay_time: '20260728120000',
              total_amount: '100',
              code_url: 'https://cashier.example.test/pay',
              sign: '00000000000000000000000000000000',
            }),
          ),
      ),
    );
    await expect(
      invalidSignatureGateway.createPayment({
        orderNo: 'CBR-3',
        payTraceNo: 'TRACE-3',
        payTime: '20260728120000',
        amountCents: 100n,
        channel: 'aggregate_qr',
      }),
    ).rejects.toBeInstanceOf(PaymentGatewayUncertainError);
  });

  it('cancels a chunked response once its body exceeds 64 KiB without Content-Length', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(40 * 1_024));
          controller.enqueue(new Uint8Array(40 * 1_024));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    expect(response.headers.get('content-length')).toBeNull();
    const gateway = new LeshouyingPaymentGateway(
      CONFIG,
      vi.fn(async () => response),
    );

    await expect(
      gateway.createPayment({
        orderNo: 'CBR-CHUNKED-LIMIT',
        payTraceNo: 'TRACE-CHUNKED-LIMIT',
        payTime: '20260728120000',
        amountCents: 100n,
        channel: 'aggregate_qr',
      }),
    ).rejects.toBeInstanceOf(PaymentGatewayUncertainError);
    expect(cancelled).toBe(true);
  });

  it('signs queryorder with a fresh query trace and normalizes signed success and pending states', async () => {
    const seenQueryTraces: string[] = [];
    const fetchPort = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://test.gdyfsk.com/yfpay/v3/queryorder');
      const request = JSON.parse(String(init.body)) as Record<string, string>;
      expect(verifyPaymentSignature(request, KEY)).toBe(true);
      expect(request.query_trace_no).toMatch(/^[0-9a-f]{32}$/u);
      seenQueryTraces.push(request.query_trace_no!);
      if (request.trade_no) {
        expect(request).not.toHaveProperty('pay_trace_no');
        return signedResponse({
          return_code: 'SUCCESS',
          return_msg: '支付中',
          result_code: 'PAY_IN_PROCESS',
          mch_no: 'MCH_TEST_001',
          query_trace_no: request.query_trace_no!,
          pay_trace_no: 'TRACE-Q2',
          pay_time: '20260728120001',
          total_amount: '300',
          trade_no: 'TRADE-Q2',
        });
      }
      expect(request).toMatchObject({
        pay_trace_no: 'TRACE-Q1',
        pay_time: '20260728120000',
      });
      return signedResponse({
        return_code: 'SUCCESS',
        return_msg: '支付成功',
        result_code: 'PAY_SUCCESS',
        mch_no: 'MCH_TEST_001',
        query_trace_no: request.query_trace_no!,
        pay_trace_no: 'TRACE-Q1',
        pay_time: '20260728120000',
        total_amount: '300',
        trade_no: 'TRADE-Q1',
        end_time: '20260728120500',
      });
    });
    const gateway = new LeshouyingPaymentGateway(CONFIG, fetchPort);
    await expect(
      gateway.queryPayment({
        payTraceNo: 'TRACE-Q1',
        payTime: '20260728120000',
        amountCents: 300n,
      }),
    ).resolves.toMatchObject({
      status: 'succeeded',
      gatewayResultCode: 'PAY_SUCCESS',
      platformTradeNo: 'TRADE-Q1',
    });
    await expect(
      gateway.queryPayment({
        payTraceNo: 'TRACE-Q2',
        payTime: '20260728120001',
        amountCents: 300n,
        platformTradeNo: 'TRADE-Q2',
      }),
    ).resolves.toEqual({
      status: 'pending',
      gatewayResultCode: 'PAY_IN_PROCESS',
      platformTradeNo: 'TRADE-Q2',
    });
    expect(seenQueryTraces).toHaveLength(2);
    expect(seenQueryTraces[0]).not.toBe(seenQueryTraces[1]);
  });

  it.each(['amount', 'merchant', 'query trace', 'signature'] as const)(
    'rejects a query response with the wrong %s',
    async (mismatch) => {
      const gateway = new LeshouyingPaymentGateway(
        CONFIG,
        vi.fn(async (_url: string, init: RequestInit) => {
          const request = JSON.parse(String(init.body)) as Record<string, string>;
          const fields = {
            return_code: 'SUCCESS',
            return_msg: '支付成功',
            result_code: 'PAY_SUCCESS',
            mch_no: mismatch === 'merchant' ? 'OTHER_MERCHANT' : 'MCH_TEST_001',
            query_trace_no:
              mismatch === 'query trace' ? 'wrong-query-trace' : request.query_trace_no!,
            pay_trace_no: 'TRACE-MISMATCH',
            pay_time: '20260728120000',
            total_amount: mismatch === 'amount' ? '301' : '300',
            trade_no: 'TRADE-MISMATCH',
          };
          const response = {
            ...fields,
            sign:
              mismatch === 'signature'
                ? '00000000000000000000000000000000'
                : signPaymentParameters(fields, KEY),
          };
          return new Response(JSON.stringify(response));
        }),
      );
      await expect(
        gateway.queryPayment({
          payTraceNo: 'TRACE-MISMATCH',
          payTime: '20260728120000',
          amountCents: 300n,
        }),
      ).rejects.toBeInstanceOf(PaymentGatewayUncertainError);
    },
  );

  it('verifies every callback field before returning normalized facts', () => {
    const gateway = new LeshouyingPaymentGateway(CONFIG, vi.fn());
    const fields = {
      return_code: 'SUCCESS',
      result_code: 'PAY_SUCCESS',
      inst_no: 'INST0001',
      mch_no: 'MCH_TEST_001',
      pay_trace_no: 'TRACE-CB',
      pay_time: '20260728120000',
      total_amount: '300',
      trade_no: 'TRADE-CB',
      trade_type: '1',
      attach: 'CBR-CB',
      end_time: '2019-07-20 12:36:27.0',
      extra_future_field: '',
    };
    const callback = { ...fields, sign: signPaymentParameters(fields, KEY) };
    expect(gateway.verifyPaymentNotification(callback)).toMatchObject({
      institutionNo: 'INST0001',
      merchantNo: 'MCH_TEST_001',
      amountCents: 300n,
      platformTradeNo: 'TRADE-CB',
      attach: 'CBR-CB',
      paidAt: new Date('2019-07-20T04:36:27.000Z'),
    });
    expect(() => gateway.verifyPaymentNotification({ ...callback, total_amount: '301' })).toThrow(
      InvalidPaymentNotificationError,
    );

    const invalidPayload = { ...fields, trade_no: '' };
    try {
      gateway.verifyPaymentNotification({
        ...invalidPayload,
        sign: signPaymentParameters(invalidPayload, KEY),
      });
      throw new Error('expected invalid callback payload');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPaymentNotificationError);
      expect(error).toMatchObject({
        reason: 'invalid_payload',
        signatureValid: true,
      });
    }
  });

  it('maps unsigned callbacks and illegal parameter names to typed safe rejections', () => {
    const gateway = new LeshouyingPaymentGateway(CONFIG, vi.fn());
    const cases = [
      {
        input: { return_code: 'SUCCESS' },
        reason: 'invalid_signature',
      },
      {
        input: {
          return_code: 'SUCCESS',
          'bad&key': 'must-not-enter-canonical-signing',
          sign: '0'.repeat(32),
        },
        reason: 'invalid_payload',
      },
    ] as const;

    for (const sample of cases) {
      try {
        gateway.verifyPaymentNotification(sample.input);
        throw new Error('expected callback rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidPaymentNotificationError);
        expect(error).toMatchObject({
          reason: sample.reason,
          signatureValid: false,
        });
      }
    }
  });
});
