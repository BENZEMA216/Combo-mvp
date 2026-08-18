// SDK 配置：全部来自环境变量，启动时一次性解析校验，缺失即报错（契约检查的一部分）。
// SDK 不硬编码任何地址与密钥；内部 token 由 Agent 部署环境注入。

export interface AgentSdkConfig {
  /** 本 Agent 的平台标识，断言验签强制 audience 等于它。 */
  agentId: string;
  /** 平台内部 token：调模型网关与计费服务的 Bearer 凭据。 */
  internalToken: string;
  /** 模型网关地址（OpenAI 兼容子集）。 */
  llmGatewayUrl: string;
  /** 计费服务地址（钱包读模型）。 */
  billingUrl: string;
  /** authz 的 JWKS 端点。 */
  jwksUrl: string;
  /** 配置后验签同时强制 issuer。 */
  assertionIssuer?: string;
}

export class AgentSdkConfigError extends Error {
  constructor(
    message: string,
    readonly missing: readonly string[] = [],
  ) {
    super(message);
    this.name = 'AgentSdkConfigError';
  }
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const REQUIRED_VARS = [
  'COMBO_AGENT_ID',
  'COMBO_PLATFORM_INTERNAL_TOKEN',
  'COMBO_LLM_GATEWAY_URL',
  'COMBO_BILLING_URL',
  'COMBO_JWKS_URL',
] as const;

type EnvLike = Record<string, string | undefined>;

/** 从环境变量解析 SDK 配置；所有缺失项一次性报出，不把第一个错误留给启动后才发现。 */
export function loadAgentSdkConfig(env: EnvLike = process.env): AgentSdkConfig {
  const missing = REQUIRED_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new AgentSdkConfigError(
      `agent sdk configuration is incomplete: ${missing.join(', ')}`,
      missing,
    );
  }

  const agentId = env.COMBO_AGENT_ID!;
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new AgentSdkConfigError('COMBO_AGENT_ID must match ^[a-z0-9][a-z0-9-]{0,62}$');
  }
  const internalToken = env.COMBO_PLATFORM_INTERNAL_TOKEN!;
  if (internalToken.length < 16) {
    throw new AgentSdkConfigError('COMBO_PLATFORM_INTERNAL_TOKEN must be at least 16 characters');
  }

  return {
    agentId,
    internalToken,
    llmGatewayUrl: stripTrailingSlash(env.COMBO_LLM_GATEWAY_URL!, 'COMBO_LLM_GATEWAY_URL'),
    billingUrl: stripTrailingSlash(env.COMBO_BILLING_URL!, 'COMBO_BILLING_URL'),
    jwksUrl: env.COMBO_JWKS_URL!,
    ...(env.COMBO_ASSERTION_ISSUER ? { assertionIssuer: env.COMBO_ASSERTION_ISSUER } : {}),
  };
}

function stripTrailingSlash(value: string, name: string): string {
  if (!/^https?:\/\//.test(value)) {
    throw new AgentSdkConfigError(`${name} must be an http(s) URL`);
  }
  return value.replace(/\/+$/, '');
}
