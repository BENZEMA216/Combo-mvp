// 示例路由：验证网关注入的身份断言，然后把对话请求透传给平台模型网关。
// 对应 agent.yaml 声明的 llm 能力；entitlement 用法见 README。
import {
  AssertionVerificationError,
  createAssertionVerifier,
  createLlmClient,
  loadAgentSdkConfig,
} from '@cb/agent-sdk';

// Next.js 路由模块在构建期也可能被加载，配置解析放在首次请求时做，失败即启动即报错
// 交给 /api/healthz 之外的进程级检查（doctor）兜底。
const config = loadAgentSdkConfig();
const verifier = createAssertionVerifier({
  jwksUrl: config.jwksUrl,
  agentId: config.agentId,
});
const llm = createLlmClient({
  gatewayUrl: config.llmGatewayUrl,
  internalToken: config.internalToken,
  agentId: config.agentId,
  defaultModel: 'deepseek-chat',
});

export async function POST(request: Request): Promise<Response> {
  let userId: string;
  try {
    // 断言由 Traefik ForwardAuth 注入 x-combo-assertion 头；aud 不等于本 Agent 即拒绝。
    ({ userId } = await verifier.verifyRequest(request));
  } catch (error) {
    if (error instanceof AssertionVerificationError) {
      return Response.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }

  const body = (await request.json()) as { messages?: Array<{ role: string; content: string }> };
  if (!Array.isArray(body.messages)) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  // 流式透传：SDK 自动注入 x_combo（user_id / agent_id / 自动生成的 turn_id），
  // 字节流原样交还给前端，不整段缓冲。
  const stream = await llm.chatCompletionStream({ userId, messages: body.messages });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
}
