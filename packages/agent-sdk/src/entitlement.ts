// entitlement：读计费服务的钱包读模型（余额 + 冻结），权益判定下沉 Agent 的落点。
// SDK 不缓存读模型；调用方自行决定缓存策略。

export class EntitlementError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EntitlementError';
  }
}

export interface WalletView {
  userId: string;
  principalBalance: number;
  bonusBalance: number;
  heldAmount: number;
  availableBalance: number;
}

export interface EntitlementClient {
  /** 查询用户钱包；用户没有任何计费动作时计费服务返回全零视图。 */
  check(userId: string): Promise<WalletView>;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export function createEntitlementClient(options: {
  billingUrl: string;
  internalToken: string;
  fetchImpl?: FetchLike;
}): EntitlementClient {
  // 缺省走调用时的全局 fetch（惰性查找），长生命周期进程里测试桩与运行时装配都生效。
  const fetchImpl =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));

  return {
    async check(userId) {
      const response = await fetchImpl(
        `${options.billingUrl}/billing/wallets/${encodeURIComponent(userId)}`,
        { headers: { authorization: `Bearer ${options.internalToken}` } },
      );
      if (response.status !== 200) {
        throw new EntitlementError(response.status, `wallet read failed: ${response.status}`);
      }
      const body = (await response.json()) as { data?: Record<string, unknown> };
      const data = body.data;
      if (!data) throw new EntitlementError(200, 'wallet response missing data');
      return {
        userId: String(data.userId),
        principalBalance: Number(data.principalBalance),
        bonusBalance: Number(data.bonusBalance),
        heldAmount: Number(data.heldAmount),
        availableBalance: Number(data.availableBalance),
      };
    },
  };
}
