import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  CODEX_AGENT_CREATOR_SHARE_ACTION_WIRE_TEMPLATE,
  CODEX_PLUGIN_GUIDE_PATH,
  EXTERNAL_MCP_PATH,
  McpInitializeParamsSchema,
  MCP_OAUTH_SCOPES,
  McpJsonRpcMessageSchema,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
  OAUTH_MCP_PROTECTED_RESOURCE_METADATA_PATH,
  OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  OAUTH_REGISTRATION_PATH,
  OAUTH_TOKEN_PATH,
  releaseMetadataFromEnv,
  type OAuthAuthorizationServerMetadata,
  type OAuthErrorResponse,
  type OAuthProtectedResourceMetadata,
} from '@cb/shared';
import { asTxPool } from '../../platform/infra/db-tx.js';
import { authSessionCookieName } from '@cb/shared';
import { externalMcpPublicOrigin, mcpRuntimeInternalBaseUrl } from '../../platform/config/env.js';
import { resolveAuthSession } from '../../platform/infra/auth-session.js';
import { isTrustedMutationRequest } from '../../platform/http/browser-origin.js';
import {
  beginAuthorization,
  createOAuthCleanupScheduler,
  decideAuthorization,
  externalMcpResourceUri,
  getPendingAuthorization,
  issueTokens,
  registerDynamicClient,
  resolveMcpBearer,
} from './service.js';
import { EXTERNAL_MCP_TOOLS, executeExternalMcpTool, toolTxPool } from './tools.js';
import {
  AGENT_BUILDER_APP_RESOURCE,
  AGENT_BUILDER_APP_URI,
  agentBuilderAppResourceContents,
} from './agent-builder-app.js';
import { McpRuntimeClient } from './runtime-client.js';
import {
  PROJECT_HISTORY_EXTERNAL_MCP_RESOURCES,
  PROJECT_HISTORY_EXTERNAL_MCP_TOOLS,
  maybeExecuteProjectHistoryExternalMcpTool,
  readProjectHistoryExternalMcpResource,
} from './project-history-composition.js';

const NO_STORE = 'no-store';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const MCP_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const LATEST_MCP_PROTOCOL_VERSION = '2025-11-25';
const maybeCleanupOAuthArtifacts = createOAuthCleanupScheduler();

/** `/codex-plugin` 页面供普通用户唯一复制的安装请求。 */
export const PROJECT_HISTORY_INSTALL_PROMPT =
  '阅读 https://test.43-160-242-46.sslip.io/codex-plugin ，帮我安装或升级 Combo 插件；完成后只创建一个安装续接任务，不要直接开始制作 Agent。' as const;

async function runScheduledOAuthCleanup(req: FastifyRequest): Promise<void> {
  try {
    await maybeCleanupOAuthArtifacts(req.server.infra.db);
  } catch {
    // 清理是有界的流量驱动维护；失败不能改变 OAuth/MCP 主请求语义，下个时间窗再试。
    req.log.warn({ traceId: req.id }, 'bounded external MCP cleanup unavailable');
  }
}

function publicOrigin(req: FastifyRequest): string {
  return externalMcpPublicOrigin(req.server.infra.env);
}

function resourceUri(req: FastifyRequest): string {
  return externalMcpResourceUri(publicOrigin(req));
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', NO_STORE);
  reply.header('pragma', 'no-cache');
}

function htmlSecurityHeaders(
  reply: FastifyReply,
  options: {
    referrerPolicy?: 'no-referrer' | 'strict-origin';
    formActionOrigin?: string;
  } = {},
): void {
  const formAction = [
    "'self'",
    ...(options.formActionOrigin ? [options.formActionOrigin] : []),
  ].join(' ');
  noStore(reply);
  reply.header(
    'content-security-policy',
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
  );
  reply.header('referrer-policy', options.referrerPolicy ?? 'no-referrer');
  reply.header('x-content-type-options', 'nosniff');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{margin:0;background:#f6f7f9;color:#172033;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}.card{max-width:680px;margin:8vh auto;padding:32px;background:#fff;border:1px solid #dde2ea;border-radius:18px;box-shadow:0 12px 40px #16203314}h1{margin:0 0 12px;font-size:28px}p{color:#4b5567}.scope{padding:12px 16px;background:#f1f5f9;border-radius:10px}button,.button{display:inline-block;border:0;border-radius:10px;padding:11px 18px;font:inherit;font-weight:650;text-decoration:none;cursor:pointer}.primary{background:#171e2c;color:#fff}.secondary{background:#e8edf4;color:#172033;margin-left:8px}code,textarea{font-family:ui-monospace,SFMono-Regular,monospace}textarea{box-sizing:border-box;width:100%;min-height:120px;padding:12px;border:1px solid #ccd4df;border-radius:10px;resize:vertical}ol{padding-left:22px}
</style></head><body><main class="card">${body}</main></body></html>`;
}

function oauthError(
  reply: FastifyReply,
  status: number,
  error: OAuthErrorResponse['error'],
  description: string,
): FastifyReply {
  noStore(reply);
  const body: OAuthErrorResponse = { error, error_description: description };
  return reply.code(status).type(JSON_CONTENT_TYPE).send(body);
}

function authorizationFailurePage(
  reply: FastifyReply,
  status: number,
  message: string,
): FastifyReply {
  htmlSecurityHeaders(reply);
  return reply
    .code(status)
    .type(HTML_CONTENT_TYPE)
    .send(page('Combo 授权未完成', `<h1>授权未完成</h1><p>${escapeHtml(message)}</p>`));
}

export function protectedResourceMetadataHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    const origin = publicOrigin(req);
    const body: OAuthProtectedResourceMetadata = {
      resource: externalMcpResourceUri(origin),
      authorization_servers: [origin],
      scopes_supported: [...MCP_OAUTH_SCOPES],
      bearer_methods_supported: ['header'],
    };
    return reply.code(200).type(JSON_CONTENT_TYPE).send(body);
  };
}

export function authorizationServerMetadataHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    const origin = publicOrigin(req);
    const body: OAuthAuthorizationServerMetadata = {
      issuer: origin,
      authorization_endpoint: `${origin}${OAUTH_AUTHORIZE_PATH}`,
      token_endpoint: `${origin}${OAUTH_TOKEN_PATH}`,
      registration_endpoint: `${origin}${OAUTH_REGISTRATION_PATH}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [...MCP_OAUTH_SCOPES],
    };
    return reply.code(200).type(JSON_CONTENT_TYPE).send(body);
  };
}

export function dynamicClientRegistrationHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    if (req.headers.authorization !== undefined) {
      return oauthError(
        reply,
        400,
        'invalid_request',
        'Public clients must register without credentials.',
      );
    }
    try {
      const outcome = await registerDynamicClient(req.server.infra.db, req.body);
      if (outcome.kind === 'invalid_request') {
        return oauthError(reply, 400, 'invalid_request', 'Dynamic client metadata is invalid.');
      }
      if (outcome.kind === 'capacity_exceeded') {
        return oauthError(
          reply,
          503,
          'temporarily_unavailable',
          'Registration capacity is temporarily unavailable.',
        );
      }
      return reply.code(201).type(JSON_CONTENT_TYPE).send(outcome.response);
    } catch {
      req.log.warn({ traceId: req.id }, 'oauth dynamic registration unavailable');
      return oauthError(
        reply,
        503,
        'temporarily_unavailable',
        'Registration is temporarily unavailable.',
      );
    }
  };
}

function authorizationResumePath(requestToken: string): string {
  return `${OAUTH_AUTHORIZE_PATH}?request=${encodeURIComponent(requestToken)}`;
}

function authorizationCallbackPresentation(redirectUri: string): {
  label: string;
  origin: string;
} {
  const callback = new URL(redirectUri);
  return {
    label: `${callback.hostname}${callback.pathname}`,
    origin: callback.origin,
  };
}

function queryValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// RFC 8707 allows resource to occur more than once. Codex can send the same single resource from
// both the Plugin's oauth_resource and protected-resource discovery; accept only identical values.
function queryResourceValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  return typeof first === 'string' && value.every((item) => item === first) ? first : undefined;
}

export function authorizationGetHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const requestToken = queryValue(query.request);
    if (!requestToken) {
      let outcome;
      try {
        outcome = await beginAuthorization(
          req.server.infra.db,
          {
            responseType: queryValue(query.response_type),
            clientId: queryValue(query.client_id),
            redirectUri: queryValue(query.redirect_uri),
            scope: queryValue(query.scope),
            state: queryValue(query.state),
            codeChallenge: queryValue(query.code_challenge),
            codeChallengeMethod: queryValue(query.code_challenge_method),
            resource: queryResourceValue(query.resource),
          },
          resourceUri(req),
        );
      } catch {
        return authorizationFailurePage(reply, 503, '授权服务暂时不可用，请回到 Codex 重试。');
      }
      if (outcome.kind !== 'created') {
        return authorizationFailurePage(
          reply,
          400,
          outcome.kind === 'invalid_scope'
            ? 'Codex 请求的授权范围不受支持。'
            : 'Codex 发来的授权请求无效，请重新运行登录命令。',
        );
      }
      return reply.redirect(authorizationResumePath(outcome.requestToken), 303);
    }

    let pending;
    try {
      pending = await getPendingAuthorization(req.server.infra.db, requestToken);
    } catch {
      return authorizationFailurePage(reply, 503, '授权服务暂时不可用，请稍后重试。');
    }
    if (!pending)
      return authorizationFailurePage(reply, 400, '授权请求已失效，请回到 Codex 重试。');

    let session;
    try {
      const cookieName = authSessionCookieName(req.server.infra.env.SESSION_COOKIE_SECURE);
      session = await resolveAuthSession(req.server.infra.db, req.cookies?.[cookieName]);
    } catch {
      return authorizationFailurePage(reply, 503, '暂时无法确认登录状态，请稍后重试。');
    }
    if (session.kind === 'disabled') {
      return authorizationFailurePage(reply, 403, '当前 Combo 账号已停用。');
    }
    if (session.kind !== 'valid') {
      const returnTo = authorizationResumePath(requestToken);
      return reply.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`, 303);
    }

    const callback = authorizationCallbackPresentation(pending.redirectUri);
    // The same-origin POST is guarded by exact Origin. Its redirect remains a form navigation,
    // so CSP must also admit only this already-validated loopback origin for the Codex callback.
    htmlSecurityHeaders(reply, {
      referrerPolicy: 'strict-origin',
      formActionOrigin: callback.origin,
    });
    const scopes = pending.scope
      .split(' ')
      .map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
      .join('');
    const body = `<h1>授权 Codex 使用 Combo</h1>
<p><strong>${escapeHtml(pending.clientName)}</strong> 请求以账号 <code>${escapeHtml(session.context.account)}</code> 使用你的 Combo Agent Builder。</p>
<p>授权结果只会返回到本机回调 <code>${escapeHtml(callback.label)}</code>。</p>
<div class="scope"><strong>授权范围</strong><ul>${scopes}</ul></div>
<p>授权后，Codex 只获得绑定 Combo MCP 地址的短期 Bearer Token；浏览器 Session Cookie 不会交给 Codex。</p>
<form method="post" action="${OAUTH_AUTHORIZE_PATH}">
<input type="hidden" name="request" value="${escapeHtml(requestToken)}">
<button class="primary" type="submit" name="decision" value="approve">允许</button>
<button class="secondary" type="submit" name="decision" value="deny">取消</button>
</form>`;
    return reply.code(200).type(HTML_CONTENT_TYPE).send(page('授权 Codex 使用 Combo', body));
  };
}

function formBody(body: unknown): URLSearchParams | null {
  if (typeof body !== 'string' || body.length === 0) return null;
  try {
    return new URLSearchParams(body);
  } catch {
    return null;
  }
}

export function authorizationPostHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    if (!isTrustedMutationRequest(req)) {
      return authorizationFailurePage(reply, 403, '授权确认来源无效，请回到 Codex 重试。');
    }
    const form = formBody(req.body);
    const requestValues = form?.getAll('request') ?? [];
    const decisionValues = form?.getAll('decision') ?? [];
    const requestToken = requestValues[0];
    const decision = decisionValues[0];
    if (
      requestValues.length !== 1 ||
      decisionValues.length !== 1 ||
      !requestToken ||
      (decision !== 'approve' && decision !== 'deny')
    ) {
      return authorizationFailurePage(reply, 400, '授权确认内容无效。');
    }

    let session;
    try {
      const cookieName = authSessionCookieName(req.server.infra.env.SESSION_COOKIE_SECURE);
      session = await resolveAuthSession(req.server.infra.db, req.cookies?.[cookieName]);
    } catch {
      return authorizationFailurePage(reply, 503, '暂时无法确认登录状态，请稍后重试。');
    }
    if (session.kind !== 'valid') {
      return reply.redirect(
        `/login?returnTo=${encodeURIComponent(authorizationResumePath(requestToken))}`,
        303,
      );
    }
    try {
      const outcome = await decideAuthorization(asTxPool(req.server.infra.db), {
        requestToken,
        decision,
        ownerUserId: session.context.userId,
      });
      if (outcome.kind === 'invalid') {
        return authorizationFailurePage(reply, 400, '授权请求已失效，请回到 Codex 重试。');
      }
      return reply.redirect(outcome.redirectUrl, 303);
    } catch {
      return authorizationFailurePage(reply, 503, '授权服务暂时不可用，请稍后重试。');
    }
  };
}

export function tokenHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    if (req.headers.authorization !== undefined) {
      return oauthError(reply, 401, 'invalid_client', 'This endpoint accepts public clients only.');
    }
    const form = formBody(req.body);
    if (!form) return oauthError(reply, 400, 'invalid_request', 'The token request is invalid.');
    try {
      const outcome = await issueTokens(asTxPool(req.server.infra.db), form, resourceUri(req));
      if (outcome.kind === 'issued') {
        return reply.code(200).type(JSON_CONTENT_TYPE).send(outcome.response);
      }
      const status = outcome.kind === 'invalid_client' ? 401 : 400;
      return oauthError(
        reply,
        status,
        outcome.kind,
        outcome.kind === 'invalid_grant'
          ? 'The authorization grant is invalid, expired, or already used.'
          : outcome.kind === 'invalid_scope'
            ? 'The requested scope exceeds the originally granted scope.'
            : 'The token request is invalid.',
      );
    } catch {
      req.log.warn({ traceId: req.id }, 'oauth token exchange unavailable');
      return oauthError(
        reply,
        503,
        'temporarily_unavailable',
        'Token issuance is temporarily unavailable.',
      );
    }
  };
}

function bearerChallenge(req: FastifyRequest, reply: FastifyReply): void {
  const metadata = `${publicOrigin(req)}${OAUTH_MCP_PROTECTED_RESOURCE_METADATA_PATH}`;
  reply.header(
    'www-authenticate',
    `Bearer resource_metadata="${metadata}", scope="${MCP_OAUTH_SCOPES.join(' ')}"`,
  );
  reply.header('access-control-expose-headers', 'WWW-Authenticate');
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

function jsonRpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function acceptsMcpResponse(req: FastifyRequest): boolean {
  const accept = req.headers.accept;
  if (typeof accept !== 'string') return false;
  const accepted = new Set<string>();
  for (const rawRange of accept.split(',')) {
    const [rawType, ...rawParameters] = rawRange.split(';');
    const mediaType = rawType?.trim().toLowerCase();
    if (mediaType !== 'application/json' && mediaType !== 'text/event-stream') continue;

    let quality = 1;
    let valid = true;
    let qualitySeen = false;
    for (const rawParameter of rawParameters) {
      const [rawName, ...rawValueParts] = rawParameter.trim().split('=');
      if (rawName?.toLowerCase() !== 'q') continue;
      if (qualitySeen || rawValueParts.length !== 1) {
        valid = false;
        break;
      }
      qualitySeen = true;
      const rawValue = rawValueParts[0]?.trim() ?? '';
      if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(rawValue)) {
        valid = false;
        break;
      }
      quality = Number(rawValue);
    }
    if (valid && quality > 0) accepted.add(mediaType);
  }
  return accepted.has('application/json') && accepted.has('text/event-stream');
}

async function authenticateMcp(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authorization =
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    const resolution = await resolveMcpBearer(req.server.infra.db, authorization, resourceUri(req));
    if (resolution.kind === 'valid') return resolution.principal;
    bearerChallenge(req, reply);
    reply
      .code(resolution.kind === 'disabled' ? 403 : 401)
      .type(JSON_CONTENT_TYPE)
      .send({
        error: resolution.kind === 'disabled' ? 'account_disabled' : 'invalid_token',
      });
    return null;
  } catch {
    reply.code(503).type(JSON_CONTENT_TYPE).send({ error: 'temporarily_unavailable' });
    return null;
  }
}

function trustedMcpOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === publicOrigin(req);
}

export function mcpGetHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    if (!trustedMcpOrigin(req)) return reply.code(403).send();
    const principal = await authenticateMcp(req, reply);
    if (!principal) return reply;
    reply.header('allow', 'POST');
    return reply.code(405).send();
  };
}

export function mcpPostHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    await runScheduledOAuthCleanup(req);
    if (!trustedMcpOrigin(req)) return reply.code(403).send();
    const principal = await authenticateMcp(req, reply);
    if (!principal) return reply;
    if (!acceptsMcpResponse(req)) {
      return reply
        .code(406)
        .type(JSON_CONTENT_TYPE)
        .send(
          jsonRpcError(null, -32600, 'Accept must include application/json and text/event-stream.'),
        );
    }
    if (Array.isArray(req.body)) {
      return reply
        .code(400)
        .type(JSON_CONTENT_TYPE)
        .send(jsonRpcError(null, -32600, 'JSON-RPC batching is not supported.'));
    }
    const parsed = McpJsonRpcMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .type(JSON_CONTENT_TYPE)
        .send(jsonRpcError(null, -32600, 'Invalid JSON-RPC request.'));
    }
    const message = parsed.data;
    const id = message.id ?? null;
    const headerVersion = req.headers['mcp-protocol-version'];
    if (typeof headerVersion === 'string' && !MCP_PROTOCOL_VERSIONS.has(headerVersion)) {
      return reply
        .code(400)
        .type(JSON_CONTENT_TYPE)
        .send(jsonRpcError(id, -32600, 'Unsupported MCP-Protocol-Version.'));
    }

    if (message.method === 'notifications/initialized') return reply.code(202).send();
    if (message.id === undefined) return reply.code(202).send();

    if (message.method === 'initialize') {
      const params = McpInitializeParamsSchema.safeParse(message.params);
      if (!params.success) {
        return reply
          .code(200)
          .type(JSON_CONTENT_TYPE)
          .send(jsonRpcError(id, -32602, 'Invalid initialize params.'));
      }
      const negotiatedProtocolVersion = MCP_PROTOCOL_VERSIONS.has(params.data.protocolVersion)
        ? params.data.protocolVersion
        : LATEST_MCP_PROTOCOL_VERSION;
      return reply
        .code(200)
        .type(JSON_CONTENT_TYPE)
        .send(
          jsonRpcResult(id, {
            protocolVersion: negotiatedProtocolVersion,
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false },
            },
            serverInfo: { name: 'combo', title: 'Combo Agent Builder', version: '0.8.4' },
            instructions:
              'When the user explicitly chooses a saved Project-history extraction, use the formal Host saved-Project picker and bounded reduced-history reads, then send Combo only the strict candidate and fixed source counts/truth: user_selected_saved_project, best_effort, completeness/host attestation/source projection not_proven, rawStored=false. Never use Hooks, trust prompts, Terminal session files, raw transcripts, Project paths, or Project/task/thread/session IDs. Persist with create_agent_package_draft, render that exact Draft, wait for the fixed whole-message confirmation, then create_agent_package_share and immediately read_agent_package_share using the returned canonical link alone. That high-entropy link is public-by-link, nonexpiring and nonrevocable; read returns the authoritative Package digest, while prepare_agent_package_run still requires that exact digest and starter for anti-mixup verification. For the default current-task Agent creation/share flow, derive a sanitized definition only from user-expressed requirements visible in the current top-level Codex task; Host wrappers are not user requirements. Show every public manifest field and use the fixed Creator confirmation action that binds only commitSha and treeSha; never insert name, description, instructions or guidance into its user-role message. Wait for explicit confirmation, then use create_codex_agent_share and immediately read back the same URL. For /agent links, call render_agent_builder with exactly {stage:"codex_agent_restore",shareUrl,manifestSha256}; Combo rereads the public share, verifies the digest fail-closed, and server-renders the complete ordered card. Only after the user confirms restore-and-run by 1-based ordinal call prepare_codex_agent_run with starterOrdinal and the exact manifest starter. Use its authoritative runEnvelope verbatim before any local restore. Do not call extraction, Capability, legacy Agent Project, or Project Agent share tools in this flow. Those legacy tools remain available only when the user explicitly requests their legacy workflow. Never pass threadId, messages, session paths, raw transcripts or secrets to Combo.',
          }),
        );
    }
    if (message.method === 'ping') {
      return reply.code(200).type(JSON_CONTENT_TYPE).send(jsonRpcResult(id, {}));
    }
    if (message.method === 'tools/list') {
      return reply
        .code(200)
        .type(JSON_CONTENT_TYPE)
        .send(
          jsonRpcResult(id, {
            tools: [
              ...EXTERNAL_MCP_TOOLS.map(({ requiredScope: _requiredScope, ...tool }) => tool),
              ...PROJECT_HISTORY_EXTERNAL_MCP_TOOLS.map(({ definition }) => definition),
            ],
          }),
        );
    }
    if (message.method === 'resources/list') {
      return reply
        .code(200)
        .type(JSON_CONTENT_TYPE)
        .send(
          jsonRpcResult(id, {
            resources: [AGENT_BUILDER_APP_RESOURCE, ...PROJECT_HISTORY_EXTERNAL_MCP_RESOURCES],
          }),
        );
    }
    if (message.method === 'resources/read') {
      const params = message.params as { uri?: unknown } | undefined;
      if (!params || typeof params.uri !== 'string') {
        return reply
          .code(200)
          .type(JSON_CONTENT_TYPE)
          .send(jsonRpcError(id, -32602, 'Unknown Combo UI resource.'));
      }
      if (params.uri !== AGENT_BUILDER_APP_URI) {
        const resource = readProjectHistoryExternalMcpResource(params.uri);
        if (!resource) {
          return reply
            .code(200)
            .type(JSON_CONTENT_TYPE)
            .send(jsonRpcError(id, -32602, 'Unknown Combo UI resource.'));
        }
        return reply.code(200).type(JSON_CONTENT_TYPE).send(jsonRpcResult(id, resource));
      }
      return reply
        .code(200)
        .type(JSON_CONTENT_TYPE)
        .send(jsonRpcResult(id, agentBuilderAppResourceContents()));
    }
    if (message.method === 'tools/call') {
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      if (!params || typeof params.name !== 'string') {
        return reply
          .code(200)
          .type(JSON_CONTENT_TYPE)
          .send(jsonRpcError(id, -32602, 'Tool name is required.'));
      }
      const projectHistoryResult = await maybeExecuteProjectHistoryExternalMcpTool({
        db: req.server.infra.db,
        principal,
        env: req.server.infra.env,
        traceId: req.id,
        reportInternalFailure: (fields) => {
          req.log.error(fields, 'project-history Agent MCP request failed');
        },
        name: params.name,
        rawArguments: params.arguments,
      });
      const result =
        projectHistoryResult ??
        (await executeExternalMcpTool(
          {
            db: req.server.infra.db,
            txPool: toolTxPool(req.server.infra.db),
            objectStore: req.server.infra.objectStore,
            principal,
            comboEnvironment: req.server.infra.env.COMBO_ENVIRONMENT,
            publicOrigin: publicOrigin(req),
            runtime: new McpRuntimeClient({
              baseUrl: mcpRuntimeInternalBaseUrl(req.server.infra.env),
              authorization: req.headers.authorization!,
            }),
            traceId: req.id,
          },
          params.name,
          params.arguments,
        ));
      return reply.code(200).type(JSON_CONTENT_TYPE).send(jsonRpcResult(id, result));
    }
    return reply
      .code(200)
      .type(JSON_CONTENT_TYPE)
      .send(jsonRpcError(id, -32601, 'Method not found.'));
  };
}

export function codexPluginGuideHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    htmlSecurityHeaders(reply);
    const environment = req.server.infra.env.COMBO_ENVIRONMENT;
    if (environment !== 'test') {
      const explanation =
        environment === 'preview'
          ? 'Preview 环境不提供 Codex Plugin 安装。插件内的 MCP 地址是静态配置，不能用 Test 分支跨环境连接 Preview。'
          : environment === 'production'
            ? 'Production 安装尚未开放。只有独立插件版本把 MCP 地址切到 Production、合并 main 并完成验收后，这里才会提供稳定安装命令。'
            : '当前开发环境不提供可复制的 Codex Plugin 安装命令。';
      const body = `<h1>Combo Codex 插件暂不可安装</h1><p>${escapeHtml(explanation)}</p>
<p>Test 候选只有在合并、部署并验证后才可作为安装入口；当前环境不得复制或运行 Test 安装命令。</p>
<p>此页面不会提供指向其他环境的命令，也不要求 Cookie、验证码或访问令牌。</p>`;
      return reply.code(200).type(HTML_CONTENT_TYPE).send(page('Combo Codex 插件', body));
    }

    const releaseMetadata = releaseMetadataFromEnv(req.server.infra.env);
    const codex = '"/Applications/ChatGPT.app/Contents/Resources/codex"';
    const projectHistoryPrompt = PROJECT_HISTORY_INSTALL_PROMPT;
    const prompt = [
      '请在当前 macOS Codex Desktop 顶层任务中完成“从当前 task 建立并分享 Codex Agent”。',
      '检测或安装前只依据本任务中用户实际表达且对用户可见的需求、约束和结论，在本地提炼 sanitized draft={name,description,agent.instructions（不超过 8000 字符）,1–5 条唯一 starterPrompts,requirements}；此阶段对 Plugin helper、本地文件、tracked guidance、Git 与 Git network 的调用数都为 0，也不读取 repositoryUrl/sourceRef/commitSha/treeSha。recommended_plugins、in-app-browser-context、heartbeat、app-context、codex_delegation、source_thread_id 等 Host 注入 wrapper 不是用户需求，不得进入草稿、handoff 或 manifest。创建者必须自行声明这些公开文本已从当前 task 派生并完成必要去敏，但服务端不能证明 instructions 已脱敏或不含原文。',
      'schema 不接收独立的 raw task、threadId、messages、session、路径、transcript、Cookie、验证码、令牌、秘密或环境变量值；rawStored=false 只表示没有独立 raw task blob。',
      '先只读检查当前任务是否同时可调用既有 render_agent_builder、create_codex_agent_share、read_codex_agent_share、prepare_codex_agent_run 与新 create_agent_package_draft、render_agent_package_draft、create_agent_package_share、read_agent_package_share、prepare_agent_package_run，并按下述 Desktop CLI 检查 official source、installed/enabled semver>=0.8.4 与精确 Test MCP。任一工具或 metadata 缺失、过旧或不合时，才冻结独立 combo.creator-bootstrap-handoff/1：固定字段顺序为 {schemaVersion:"combo.creator-bootstrap-handoff/1",continueIntent:"create_codex_agent_share",sameSavedProjectRequired:true,draft:{name,description,agent:{instructions,starterPrompts},requirements},behaviorMarker:"COMBO_CREATOR_HANDOFF_READY"}。requirements 内若有 codexVersion 必须排第一且无值时省略，随后固定为 commands、plugins、environmentVariableNames，后三项即使为空也显式写 []。它只含公开派生草稿与续跑意图，不含 source Git facts、路径、Project ID、原始会话或 Host wrapper；JSON.stringify 后必须把实际 <、>、&、U+2028、U+2029 分别转成小写 \\u003c、\\u003e、\\u0026、\\u2028、\\u2029，作为 Host-safe compact JSON。',
      '每次 CLI 调用都直接使用绝对路径 "/Applications/ChatGPT.app/Contents/Resources/codex"；不得依赖环境变量在不同 exec 调用间持久，也不依赖 PATH；不要求用户手动打开 shell 或二次粘贴。',
      '先分别执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace list --json 与 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin list --marketplace dangdang-tech-combo --available --json，记录 marketplaceInitiallyPresent 与 upgradePerformed=false；Plugin metadata 每次都必须使用这个 Marketplace-filtered 短 JSON 命令，禁止改回可能被 Host 输出截断的全量 plugin list --json。若 name=dangdang-tech-combo 已存在，必须确认 marketplaceSource.sourceType=git 且 marketplaceSource.source 精确等于 https://github.com/dangdang-tech/combo-plugin.git；同名错源、Plugin 已安装但 Marketplace 缺失、无效语义版本等异常组合立即 STOP，不 remove、不覆盖。',
      '若 Marketplace 与 Plugin 初始都缺失，执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace add https://github.com/dangdang-tech/combo-plugin.git --ref codex/combo-plugin-v2-ui --json，再重新执行 marketplace list 与 plugin list 并验证官方 source。若 marketplaceInitiallyPresent=true 且官方 Marketplace 已存在、Plugin 缺失或有效 version<0.8.4，则先精确验证官方 source，再恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace upgrade dangdang-tech-combo --json，设置 upgradePerformed=true，并重新读取两份 metadata。无论 marketplaceInitiallyPresent 初值为何，只要此时已确认 official Marketplace 且 Plugin 仍缺失，就恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin add combo@dangdang-tech-combo --json，并再次读取 plugin list；同一状态机内 plugin add 最多一次。fresh install 的固定顺序必须是 marketplace add→重新读取并确认 official source→plugin add→最终检查。',
      '若 Plugin add 或刷新后得到有效 version<0.8.4 且 upgradePerformed=false，必须重新验证 official Marketplace source，恰好再执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace upgrade dangdang-tech-combo --json，设置 upgradePerformed=true，并重新读取 marketplace list 与 plugin list；若升级后仍低于 0.8.4，或 upgradePerformed=true 时仍低于 0.8.4，立即 STOP。整个状态机 marketplace upgrade 最多执行一次。',
      '最后再次执行 "/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace list --json、"/Applications/ChatGPT.app/Contents/Resources/codex" plugin list --marketplace dangdang-tech-combo --available --json 与 "/Applications/ChatGPT.app/Contents/Resources/codex" mcp get combo --json；新 Project-history 流程门要求 Plugin 是有效语义版本且 version>=0.8.4、installed=true、enabled=true、marketplaceSource 精确匹配，MCP 必须得到 name=combo、enabled=true、disabled_reason=null、transport.type=streamable_http，且 transport.url 精确等于 https://test.43-160-242-46.sslip.io/api/external-mcp/mcp；当前 Test 候选验收另要求 exact version=0.8.4。不符立即 STOP，不 remove、不 mcp add。既有四工具的 legacy share 接收仍兼容 Plugin >=0.7.0。',
      '只有初始检查既有四工具、新五工具与全部 metadata 已同时满足时才留在当前任务，并跳过安装变更、creatorHandoff 与 create_thread；此 stay-current 分支在首次 Combo 工具调用前主动 mcp login combo 的调用数必须为 0。否则完成安全安装/升级与最终 metadata 校验后、任何 create_thread 之前，必须用绝对 bundled CLI 恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" mcp login combo 完成 Codex-managed OAuth；失败或用户取消立即 STOP，create_thread 调用数必须为 0。OAuth 成功后才依靠正式 Host 已保存的 target 绑定，用 list_projects 精确且唯一定位当前 saved Project；把上述 Host-safe compact JSON 逐字指定为 creatorHandoff，再精确调用 create_thread({prompt:creatorHandoff,target:{type:"project",projectId,environment:{type:"local"}}})。creatorHandoff 必须是唯一 prompt，且不算用户确认。子任务必须先 parse handoff、完成 readiness，再由已安装 Skill/helper 只读获取 source Git facts 与 tracked guidance，综合后完整重显草稿，并在这些证据之后输出目标 assistant agentMessage；其 text.trim() 必须逐字只等于 COMBO_CREATOR_HANDOFF_READY，phase 可为 "final_answer"，或仅在同一唯一 status=completed、error=null turn 的 ordered lifecycle 齐全且 marker 是最后 behavior 时允许 phase null/absent legacy fallback；phase="commentary" 必须拒绝；说明只能放在更早 commentary；到此 create_codex_agent_share 调用数必须为 0。只返回 clientThreadId 时立即失败关闭，不能把它传给 wait_threads/read_thread，也不能重建任务；只有同时返回 ready threadId 与 hostId 才调用 wait_threads，再用 list_threads 按该 threadId 核对 documented project context 的 projectId 精确匹配，并用 read_thread({threadId,hostId,includeOutputs:true,maxOutputCharsPerItem:20000,turnLimit:10}) 要求同一个 status=completed、error=null 的首轮中、marker 前以下 proof signature 各恰好一次且按序：server=combo、tool=render_agent_builder、arguments 深度等于固定 readiness payload 且 status=completed；verified Plugin scripts workdir 下以固定相对命令 ./project-agent-git.sh inspect-source 调用 packaged helper，参数逐项绑定当前 Project root、repositoryUrl、sourceRef、commitSha 与 treeSha，commandExecution status=completed 且 exitCode=0；同一 helper 的 list-manifest-inputs 恰好一次；对该次选择返回的每个 unique readable objectId，read-manifest-input 必须恰好调用一次且最多 8 次，只有 readable 数为 0 时才允许 0 次，hint、omitted 与 duplicate-object 条目一律不得读取；随后 server=combo、tool=render_agent_builder、stage=project_share 且 arguments 深度等于包含完整 name、description、source、instructions、全部 starterPrompts、requirements、authoringSource、公开边界以及唯一固定 commitSha+treeSha 安全 action 的公开草稿卡，action user-role message 不得包含 name/description/instructions/guidance 自由文本，status=completed；最后才是 assistant marker。Creator marker 前 fileChange 必须为 0；除隔离的只读 Git facts 与上述 packaged guidance 读取命令外，不允许其他 commandExecution；不得重复 render/inspect，也不得调用 create_codex_agent_share、read_codex_agent_share、prepare_codex_agent_run、restore、codex app、create_thread 或 navigate_to_codex_page；已暴露的 known forbidden dynamicToolCall 同样必须为 0。mcpToolCall 只暴露 server/tool/arguments/status，不含 result、structuredContent 或 error；completed 只证明调用结束，不能证明业务结果。commandExecution 也不能靠 output 冒充 Git 结论；子任务仍须内部核验，完整草稿由子任务卡片供用户直接审查并由真实 UI/Service/Git 验收。只接受这些调用记录之后、assistant agentMessage 的 text.trim() 逐字只等于 COMBO_CREATOR_HANDOFF_READY；phase 可为 "final_answer"，或仅在同一唯一 completed/error-null turn、ordered lifecycle 齐全且 marker 是最后 behavior 时允许 phase null/absent legacy fallback；phase="commentary" 必须拒绝；绝不能匹配 userMessage、codexDelegation、tool input、echo、代码围栏或 creatorHandoff 输入中已有的 marker 字面量。父任务看到合格的 assistant agentMessage 后必须立即只调用一次 navigate_to_codex_page(threadId) 显示该续跑任务，不得留在父任务等待确认或要求子任务先创建。Host 注入的 source thread 标识属于 harness metadata，不得写入 Combo manifest。',
      '工具可用的当前任务或续跑任务必须同时发现 render_agent_builder、create_codex_agent_share、read_codex_agent_share、prepare_codex_agent_run，并实际成功调用 render_agent_builder({stage:"readiness",title:"Combo Codex Agent 就绪检查",summary:"仅验证 Combo MCP 展示与授权是否可用。",progress:[],items:[],actions:[]})；随后由已安装 Skill/helper 只读获取 source Git facts 与 tracked guidance，综合后完整重显草稿，不能把 creatorHandoff 当作确认。全程零重启，任一工具缺失或 readiness 调用失败就准确报告 Plugin tool catalog 阻断并停止；continuation 分支禁止再次 mcp login combo，也禁止再创建续跑任务。',
      '仅 stay-current 分支在可调用 Combo 工具明确返回 authorization 错误时，才可恰好执行一次 "/Applications/ChatGPT.app/Contents/Resources/codex" mcp login combo；登录成功后只重试原工具，失败或取消就 STOP，不得重建任务。',
      `readiness 通过后，用 render_agent_builder 展示将公开的全部字段：完整 instructions 放在一个 fact.value，starterPrompts 逐条展示，并披露任何持链接者都可匿名读取、当前 V1 不支持撤销或过期；它不是账户授权或 OAuth token，但它是未列出的公开定位链接，持有即匿名可读，请按公开内容处理。Creator project_share 卡上的 name 仍完整显示，但唯一确认 action 的 user-role message 不得插入 name、description、instructions、guidance 或任何其他自由文本，只绑定安全 commitSha+treeSha 并精确渲染为：${CODEX_AGENT_CREATOR_SHARE_ACTION_WIRE_TEMPLATE}当前完整显示卡或任一摘要变化都必须 STOP。明确确认前不调用写工具。`,
      'V1 sourceRef 必须是以字母或数字起始、只含 ASCII 字母数字及 ._/- 的完整 refs/heads/... 或 refs/tags/...，并满足无 ..、//、隐藏 component、.lock component 或尾部点/斜杠；任一不符立即 STOP，不能传给 helper 或创建工具。V0 ref 契约不在本流程内改写。',
      '得到明确确认并确认 worktree clean、HEAD 已 committed 后，由已安装 Skill 按参数契约调用 Plugin 内置 helper 的 verify-source mode 核验当前 root、sourceRef、commitSha、treeSha 与远端 ref；不得内嵌 shell 实现。',
      '验证通过才调用 create_codex_agent_share；成功后立即用服务返回的同一 shareUrl 调用 read_codex_agent_share，逐字段确认 manifest、manifestSha256 与 copyPrompt 和 create 结果完全一致，任何不一致都停止且不得重建。新链路对 create_extraction_task、list_capabilities、create_agent_project、commit_agent_revision、create_project_agent_share 等旧工具的调用数必须为 0。',
    ]
      .join('')
      // Legacy current-task 语义保持不变；只与本页共用当前 Test Plugin 安装门槛。
      .replaceAll('0.8.4', '0.8.7');
    const inspectionCommands =
      `${codex} plugin marketplace list --json\n` +
      `${codex} plugin list --marketplace dangdang-tech-combo --available --json\n` +
      `${codex} mcp get combo --json`;
    const upgradeCommands = `${codex} plugin marketplace upgrade dangdang-tech-combo --json`;
    const marketplaceInstallCommand = `${codex} plugin marketplace add https://github.com/dangdang-tech/combo-plugin.git --ref codex/combo-plugin-v2-ui --json`;
    const pluginInstallCommand = `${codex} plugin add combo@dangdang-tech-combo --json`;
    const loginCommand = `${codex} mcp login combo`;
    const body = `<h1>在 Codex 中安装 Combo Test</h1><p>当前指南对应 Project-history Agent 与 Combo Plugin 0.8.7 Test。</p><p><strong>Test 运行身份：</strong><code>TEST_RUNTIME</code> / <code>environment=${escapeHtml(releaseMetadata.environment)}</code> / <code>sourceSha=${escapeHtml(releaseMetadata.sourceSha)}</code> / <code>releaseId=${escapeHtml(releaseMetadata.releaseId)}</code> / <code>UAT_STATUS=EXTERNAL_EVIDENCE_REQUIRED</code>。本页由当前 Test Authoring runtime 生成；同源 <a href="/version.json">/version.json</a> 是部署身份权威。只有它返回 <code>environment=test</code>，且 <code>sourceSha</code> 与 <code>releaseId</code> 与本页运行身份逐字一致时，才继续安装；不一致立即停止。本页不声称普通用户 UAT 已通过，UAT 结论必须由独立验收证据证明。</p>
<h2>唯一需要复制的请求</h2><p>把下面这一整段原样发给 Codex Desktop：</p><textarea readonly>${escapeHtml(projectHistoryPrompt)}</textarea><p>这段请求保持短且固定；安装、升级、授权、校验和续跑规则都由本页承担，不塞进用户请求。</p>
<h2>安装边界</h2><p>Combo Plugin 安装在 Codex Host，不是安装到当前 Project，也不会读写任何 Project 文件。执行此请求的 Codex 代为完成操作；不得要求普通用户手动打开 Terminal、输入命令、提供路径或内部 ID。安装或升级不会让已经运行的任务热加载新 Plugin catalog，不得伪造已加载状态。</p>
<h2>三种初始状态</h2><ol><li><strong>新安装：</strong>official Marketplace 与 Combo Plugin 都缺失。按固定顺序完成 Marketplace add、重读并核对 official source、Plugin add、最终 metadata 与 OAuth 校验。</li><li><strong>旧版：</strong>official Marketplace 已存在，Combo Plugin 缺失或为可安全升级的有效旧版。核对 official source 后最多 upgrade 一次，必要时 add Plugin 一次，再完成最终 metadata 与 OAuth 校验。</li><li><strong>当前版：</strong>Combo Plugin 已安装启用，且 official stable 有效 semver 为 exact 0.8.7，Marketplace source、Test MCP 与 OAuth 都精确匹配。不得执行安装或升级 mutation。</li></ol><p>新安装、旧版和已是当前版三类初始状态只决定前置安装动作；三类最终都必须消费 Plugin bundled typed controller 的 recovery-only 结果，都不得直接创建 Project-history business。安装或升级不会让已经运行的任务热加载新 catalog，表面工具快照不得改写这个分支。</p>
<h2>唯一后续：recovery-only</h2><p>安装与核对完成后只调用 Plugin 0.8.7 自带的 Plugin bundled typed controller；controller 的 typed result 是唯一路由权威，并记为 <code>controllerResult</code>。无论当前任务是旧 Skill snapshot 还是新项目内没有 Combo，都必须先用 bundled Codex CLI 精确执行 <code>plugin list --marketplace dangdang-tech-combo --available --json</code>；只接受 <code>installed</code> 数组中恰好一行同时满足 <code>pluginId=combo@dangdang-tech-combo</code>、<code>marketplaceSource.sourceType=git</code>、<code>marketplaceSource.source=https://github.com/dangdang-tech/combo-plugin.git</code>、<code>installed=true</code>、<code>enabled=true</code> 与 <code>version=0.8.7</code>。</p>
<p>只能从上述同一已过滤官方行取 <code>source.path</code>，并要求 <code>source.source=local</code>且该 path 为非空绝对路径。以 <code>realpath(source.path)</code> 作为 canonical installed root，controller 只能是该 root 内的固定相对路径 <code>scripts/project-history-bootstrap-controller.mjs</code>；controller 的 realpath 必须仍在 root 加 path separator 的范围内，并且是 regular file 且 mode 精确为 0755，必须以完整 mode mask <code>(mode &amp; 0o7777) === 0o755</code> 验证，setuid/setgid/sticky 任一存在都拒绝。Plugin 0.8.7 中该 tracked controller bundle 精确为 14,507 UTF-8 bytes，SHA-256 <code>0f57fd11fc2a45f4cd23f5718fa676e0b607b5c1a3dd10f3073acd444e2b7ca0</code>；这是发布产物身份，不授权从其他路径查找替代文件。解析出的 root、path 和内部 ID 只可用于 Host 内部定位，零进入用户 prose、child prompt 或 Combo 参数；禁止扫描 Plugin cache、本地 Skill、记忆、任意路径或开发 checkout，也不得依赖 <code>PLUGIN_ROOT</code>、<code>PLUGIN_DATA</code>、Hook、PATH Node 或浏览器。</p>
<p>trusted outer parser 必须以固定 <code>/usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u NODE_V8_COVERAGE -u NODE_COMPILE_CACHE -u NODE_REDIRECT_WARNINGS</code> 前缀启动 <code>/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node</code>，先移除这五个 Node 注入、coverage、cache 和 warning 变量。inner controller 固定 cwd 为 <code>&lt;verified-root&gt;/scripts</code>，固定 executable 为同一绝对 <code>process.execPath</code>，argv 只能是 <code>[&quot;./project-history-bootstrap-controller.mjs&quot;,&quot;setup&quot;]</code>，零 stdin、零 model-supplied state、empty environment，固定 5,000 ms timeout 并以 <code>SIGKILL</code> 终止，调用次数恰好为 1。只接受 exit code 0、无 signal、stderr 精确为空、stdout 为 fatal UTF-8 且只含一个非空 strict JSON line，恰好一个 LF 结尾、无 CR 或其他空白，总长度不超过 8,192 bytes。strict JSON 的 top-level keys 必须恰好为 <code>schemaVersion</code>、<code>action</code>、<code>target</code>、<code>childCreateBudget</code>、<code>soleFirstPrompt</code>；值必须恰好为 <code>schemaVersion=combo.project-history-bootstrap-controller/1</code>、<code>action=create-recovery</code>、唯一 target key <code>target={type:&quot;projectless&quot;}</code>、整数 <code>childCreateBudget=1</code>，且 <code>soleFirstPrompt</code> 必须为 2,000 UTF-8 bytes、SHA-256 <code>33d94d776e9d4eb0cf2238358857c8e4b33427de655be6a52d33e834d460146d</code> 的 Plugin 固定续接段落。本页和 initial setup 都不得自行拼接、猜测、替换或显示该 <code>soleFirstPrompt</code>。</p>
<p>任一 locator、mode、exec 或 envelope 不符时，只报告 <code>PROJECT_HISTORY_BOOTSTRAP_CONTROLLER_EXEC_FAILED</code>，零 child、零 fallback、零 scan、零 retry，不回显 raw output、path、ID、stack 或其他内部错误。setup 不得再根据 final metadata、tool visibility、remembered mutation flag 或旧 Skill locator 改判 business。有效结果只允许唯一一次 recovery create_thread：<code>create_thread({prompt:controllerResult.soleFirstPrompt,target:{type:&quot;projectless&quot;}})</code>。setup 入口最多创建一个 recovery 任务，initial setup 的 business create 调用数始终为 0；recovery 入口创建 recovery 任务的预算为 0，任何失败都不得继续链式创建。Plugin 固定 business prompt 的不可见指纹为 1,074 UTF-8 bytes / SHA-256 <code>7df7bced005edd481e8eaa3169a8cac3dfa278d459942a15ef31bf595fd101fc</code>；页面只锁定这个指纹，不提供、复述、拼接或允许复制 business 正文，也不存在当前版直通 business 分支。</p><p><code>INITIAL_CONTINUATION_ENFORCEMENT=CODE_INTEGRATED</code>：installed controller 只在 initial setup 到安装续接这一跳提供代码级强制，不宣称它技术上强制 continuation 到 business。<code>RECOVERY_BUSINESS_GATE=HOST_TRACE_REQUIRED</code>：continuation 只能依据自包含 prompt 与真实五 V3/OAuth Host trace 判断能否进入 business；未取得该 trace 就停止。</p>
<h2>安装续接任务和其后业务任务的边界</h2><p>安装续接任务和其后业务任务都只使用当前任务已经显示的 Codex Host 工具和 Combo 远程工具，不得使用 Terminal、子智能体或浏览器，不得读取本地文件、Skill、记忆、缓存或路径，不得使用 legacy 回退。路径或内部 ID 不得进入用户消息、Combo 参数或可见说明；这不是对 Host 工具内部实现的阻断，Host 工具内部绑定和结果处理仍可使用其自身返回的标识。</p><p>续接任务必须先确认 <code>create_agent_package_draft</code>、<code>render_agent_package_draft</code>、<code>create_agent_package_share</code>、<code>read_agent_package_share</code>、<code>prepare_agent_package_run</code> 五个 V3 工具全部可用。任一缺失就在读取任何 Project 前停止，只报告 <code>PROJECT_HISTORY_AGENT_MCP=NOT_AVAILABLE</code>；不得创建 business，也不得创建第二个安装续接任务。</p>
<h2>recovery create_thread 的 Host 返回门禁</h2><p>不得重复调用 create_thread。唯一一次 recovery create_thread 调用失败或返回畸形结构时，固定报告 <code>PROJECT_HISTORY_BOOTSTRAP_CREATE_FAILED</code>，零重试、零 recreate，不暴露 raw error、路径、ID、用户内容或秘密；create_thread 能力不可用也使用该 marker。</p><p>只返回一个非空 clientThreadId 时分类为 QUEUED：在 final 中独立一行只向 Host 交付机器指令 <code>::created-thread{clientThreadId=&quot;...&quot;}</code>，用户 prose 不显示、重复或解释 ID；不得把 clientThreadId 传给 wait_threads、read_thread 或 navigate_to_codex_page，也不得声称 READY、已打开或业务已就绪。</p><p>READY 只接受同一次 create_thread 恰好返回非空 threadId 与 hostId、且不含 clientThreadId。只有同一次 create_thread 同时返回 ready threadId 与 hostId 才进入 READY；同时混入 clientThreadId、threadId 与 hostId 的 mixed 返回必须分类为 FAILED，并固定报告 <code>PROJECT_HISTORY_BOOTSTRAP_CREATE_FAILED</code>，mixed 返回的 wait、navigate 与 recreate 调用数都为 0。READY 在 final 中独立一行只向 Host 交付 <code>::created-thread{threadId=&quot;...&quot;}</code>；用户 prose 不显示、重复或解释 ID，该指令不能代替 ready/open 验证。</p><p>create 返回 READY 时不得预发 navigate budget。仅 READY 分支恰好调用一次 <code>wait_threads({targets:[{threadId,hostId}],timeoutMs:0})</code>；只有 wait snapshot 成功后才允许最多一次 navigate，具体调用 <code>navigate_to_codex_page(threadId)</code>，wait 失败时 navigate 调用数为 0。即使随后的 snapshot 或 navigation 失败，也必须保留 threadId 机器指令这一独立最终行；用户 prose 只报告唯一固定 marker <code>PROJECT_HISTORY_BOOTSTRAP_OPEN_FAILED</code>，不得丢弃指令后只返回 marker。失败不重试、不回滚或重建已创建任务；wait_threads 或 navigate_to_codex_page 能力不可用也使用 OPEN_FAILED。</p>
<details><summary>仅供 initial setup 自动安装时使用的命令 fallback</summary><p>以下命令只供执行安装请求的 Codex 代为使用，不是要求普通用户手动执行；安装续接与业务任务不得使用这些命令或任何 Terminal fallback。</p><h3>只读精确检查</h3><textarea readonly>${escapeHtml(inspectionCommands)}</textarea><p>Marketplace name 必须对应官方 Git source；同名错源、Plugin 已安装但 Marketplace 缺失、无效或不兼容版本等异常组合立即 BLOCK，不删除、覆盖、盲目升级或替换现有配置。Test MCP 的明确 mismatch 或 disabled 也立即 BLOCK。</p><h3>已有 official Marketplace 但 Plugin 缺失或版本过旧</h3><textarea readonly>${escapeHtml(upgradeCommands)}</textarea><p>核对 official source 后最多执行一次 Marketplace upgrade，再重读 metadata。</p><h3>Marketplace 与 Combo Plugin 都缺失</h3><textarea readonly>${escapeHtml(marketplaceInstallCommand)}</textarea><p>重读并确认 official source 后，Plugin 仍缺失才恰好执行一次：</p><textarea readonly>${escapeHtml(pluginInstallCommand)}</textarea><p>fresh install 的固定顺序必须是 marketplace add→重新读取并确认 official source→plugin add→最终检查。Plugin add 和 marketplace upgrade 各至多一次。最终要求 installed=true、enabled=true、official stable 有效 semver exact 0.8.7 与精确 Test MCP。</p><h3>Codex-managed OAuth</h3><p>完成最终 metadata 与 Test MCP 核对后按 Plugin 0.8.7 controller contract 执行：</p><textarea readonly>${escapeHtml(loginCommand)}</textarea><p>成功后仍只能消费 controllerResult 创建唯一 recovery；失败或用户取消立即 STOP，零 child。</p></details>
<details><summary>Legacy current-task Codex Agent 流程（兼容，不用于 Project-history 短入口）</summary><textarea readonly>${escapeHtml(prompt)}</textarea></details><p>Legacy 兼容不变：Plugin 0.7.0 的既有四工具和 <code>read_project_agent_share</code> 仍可接收旧 share。Combo 不要求你在聊天中粘贴 Cookie、验证码或访问令牌。</p>`;
    return reply.code(200).type(HTML_CONTENT_TYPE).send(page('Combo Codex 插件安装', body));
  };
}

export const EXTERNAL_MCP_PUBLIC_PATHS = {
  protectedResource: OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceForMcp: OAUTH_MCP_PROTECTED_RESOURCE_METADATA_PATH,
  authorizationServer: OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
  authorize: OAUTH_AUTHORIZE_PATH,
  token: OAUTH_TOKEN_PATH,
  registration: OAUTH_REGISTRATION_PATH,
  mcp: EXTERNAL_MCP_PATH,
  guide: CODEX_PLUGIN_GUIDE_PATH,
} as const;
