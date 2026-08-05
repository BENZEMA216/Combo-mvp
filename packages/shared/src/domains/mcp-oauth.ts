// Combo 远程 MCP 的 OAuth 2.1 发现、动态注册和令牌响应契约。
// 浏览器 Session Cookie 与 MCP Bearer Token 是两条独立凭据边界；本文件只描述后者。
import { z } from 'zod';

export const EXTERNAL_MCP_PATH = '/api/external-mcp/mcp' as const;
export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource' as const;
export const OAUTH_MCP_PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource/api/external-mcp/mcp' as const;
export const OAUTH_AUTHORIZATION_SERVER_METADATA_PATH =
  '/.well-known/oauth-authorization-server' as const;
export const OAUTH_AUTHORIZE_PATH = '/api/external-mcp/oauth/authorize' as const;
export const OAUTH_TOKEN_PATH = '/api/external-mcp/oauth/token' as const;
export const OAUTH_REGISTRATION_PATH = '/api/external-mcp/oauth/register' as const;
export const CODEX_PLUGIN_GUIDE_PATH = '/codex-plugin' as const;

export const MCP_OAUTH_SCOPES = ['combo.agent:read', 'combo.agent:write'] as const;
export const McpOAuthScopeSchema = z.enum(MCP_OAUTH_SCOPES);
export type McpOAuthScope = z.infer<typeof McpOAuthScopeSchema>;

export const MCP_OAUTH_DEFAULT_SCOPE = MCP_OAUTH_SCOPES.join(' ');
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MCP_AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60;
export const MCP_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;

export const MCP_CLIENT_ID_PATTERN = /^mcp_client_[A-Za-z0-9_-]{43}$/;
export const MCP_AUTHORIZATION_REQUEST_PATTERN = /^mar1\.[A-Za-z0-9_-]{43}$/;
export const MCP_AUTHORIZATION_CODE_PATTERN = /^mac1\.[A-Za-z0-9_-]{43}$/;
export const MCP_ACCESS_TOKEN_PATTERN = /^mat1\.[A-Za-z0-9_-]{43}$/;
export const MCP_REFRESH_TOKEN_PATTERN = /^mrt1\.[A-Za-z0-9_-]{43}$/;
export const PKCE_S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

const AbsoluteHttpUrlSchema = z.string().url().max(2_048);

export const OAuthProtectedResourceMetadataSchema = z
  .object({
    resource: AbsoluteHttpUrlSchema,
    authorization_servers: z.array(AbsoluteHttpUrlSchema).min(1),
    scopes_supported: z.array(McpOAuthScopeSchema).min(1),
    bearer_methods_supported: z.array(z.literal('header')).length(1),
  })
  .strict();
export type OAuthProtectedResourceMetadata = z.infer<typeof OAuthProtectedResourceMetadataSchema>;

export const OAuthAuthorizationServerMetadataSchema = z
  .object({
    issuer: AbsoluteHttpUrlSchema,
    authorization_endpoint: AbsoluteHttpUrlSchema,
    token_endpoint: AbsoluteHttpUrlSchema,
    registration_endpoint: AbsoluteHttpUrlSchema,
    response_types_supported: z.array(z.literal('code')).length(1),
    grant_types_supported: z.array(z.enum(['authorization_code', 'refresh_token'])).length(2),
    token_endpoint_auth_methods_supported: z.array(z.literal('none')).length(1),
    code_challenge_methods_supported: z.array(z.literal('S256')).length(1),
    scopes_supported: z.array(McpOAuthScopeSchema).min(1),
  })
  .strict();
export type OAuthAuthorizationServerMetadata = z.infer<
  typeof OAuthAuthorizationServerMetadataSchema
>;

export const OAuthDynamicClientRegistrationRequestSchema = z
  .object({
    redirect_uris: z.array(AbsoluteHttpUrlSchema).min(1).max(8),
    client_name: z.string().trim().min(1).max(120).optional(),
    client_uri: AbsoluteHttpUrlSchema.optional(),
    logo_uri: AbsoluteHttpUrlSchema.optional(),
    scope: z.string().max(200).optional(),
    grant_types: z
      .array(z.enum(['authorization_code', 'refresh_token']))
      .min(1)
      .max(2)
      .optional(),
    response_types: z.array(z.literal('code')).length(1).optional(),
    token_endpoint_auth_method: z.literal('none').optional(),
    software_id: z.string().max(200).optional(),
    software_version: z.string().max(100).optional(),
  })
  .passthrough();
export type OAuthDynamicClientRegistrationRequest = z.infer<
  typeof OAuthDynamicClientRegistrationRequestSchema
>;

export const OAuthDynamicClientRegistrationResponseSchema = z
  .object({
    client_id: z.string().regex(MCP_CLIENT_ID_PATTERN),
    client_id_issued_at: z.number().int().nonnegative(),
    redirect_uris: z.array(AbsoluteHttpUrlSchema).min(1),
    client_name: z.string().min(1),
    grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).min(1),
    response_types: z.array(z.literal('code')).length(1),
    token_endpoint_auth_method: z.literal('none'),
  })
  .passthrough();
export type OAuthDynamicClientRegistrationResponse = z.infer<
  typeof OAuthDynamicClientRegistrationResponseSchema
>;

export const OAuthTokenResponseSchema = z
  .object({
    access_token: z.string().regex(MCP_ACCESS_TOKEN_PATTERN),
    token_type: z.literal('Bearer'),
    expires_in: z.literal(MCP_ACCESS_TOKEN_TTL_SECONDS),
    refresh_token: z.string().regex(MCP_REFRESH_TOKEN_PATTERN),
    scope: z.string().min(1),
  })
  .strict();
export type OAuthTokenResponse = z.infer<typeof OAuthTokenResponseSchema>;

export const OAuthErrorResponseSchema = z
  .object({
    error: z.enum([
      'invalid_request',
      'invalid_client',
      'invalid_grant',
      'unauthorized_client',
      'unsupported_grant_type',
      'invalid_scope',
      'access_denied',
      'server_error',
      'temporarily_unavailable',
    ]),
    error_description: z.string().min(1).max(300).optional(),
  })
  .strict();
export type OAuthErrorResponse = z.infer<typeof OAuthErrorResponseSchema>;

export const McpJsonRpcIdSchema = z.union([z.string(), z.number().finite().int(), z.null()]);
export const McpJsonRpcMessageSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: McpJsonRpcIdSchema.optional(),
    method: z.string().min(1).max(200),
    params: z.unknown().optional(),
  })
  .passthrough();
export type McpJsonRpcMessage = z.infer<typeof McpJsonRpcMessageSchema>;

export const McpInitializeParamsSchema = z
  .object({
    protocolVersion: z.string().min(1).max(50),
    capabilities: z.record(z.string(), z.unknown()),
    clientInfo: z
      .object({
        name: z.string().min(1).max(200),
        version: z.string().min(1).max(100),
        title: z.string().min(1).max(200).optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type McpInitializeParams = z.infer<typeof McpInitializeParamsSchema>;
