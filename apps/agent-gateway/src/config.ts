import {
  Sha256DigestSchema,
  UuidSchema,
  currentBrokerContractDigest,
} from '@cb/creator-agent-protocol';
import { z } from 'zod';

import type { GatewayCompatibilityPolicy } from './postgres-authority.js';

const HostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|::|[0-9.]+)$/u);
const DatabaseNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/u);
const PasswordSchema = z
  .string()
  .min(16)
  .max(1_024)
  .refine((value) => !containsControlCharacter(value), 'database password contains control bytes');
const WorkerVersionSchema = z.string().min(1).max(128);
const IsolationModeSchema = z.enum(['apple-container-v1', 'lima-vz-v1']);

function integerString(minimum: number, maximum: number) {
  return z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/u)
    .transform((value) => Number(value))
    .refine(
      (value) => Number.isSafeInteger(value) && value >= minimum && value <= maximum,
      `integer must be between ${minimum} and ${maximum}`,
    );
}

function jsonArray<T extends z.ZodTypeAny>(item: T, minimum: number, maximum: number) {
  return z
    .string()
    .min(2)
    .max(16_384)
    .transform((source, context): unknown => {
      try {
        return JSON.parse(source) as unknown;
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be canonical JSON array' });
        return z.NEVER;
      }
    })
    .pipe(
      z
        .array(item)
        .min(minimum)
        .max(maximum)
        .refine((values) => new Set(values).size === values.length, 'array values must be unique'),
    );
}

const ProcessEnvironmentSchema = z
  .object({
    COMBO_ENVIRONMENT: z.literal('test'),
    COMBO_SOURCE_SHA: z.string().regex(/^[a-f0-9]{40}$/u),
    COMBO_RELEASE_ID: z.string().regex(/^release-[a-f0-9]{40}$/u),
    COMBO_RELEASE_MANIFEST_DIGEST: Sha256DigestSchema,
    AGENT_GATEWAY_ENABLED: z.literal('true'),
    AGENT_GATEWAY_PUBLISHER_ENABLED: z.enum(['true', 'false']).default('false'),
    AGENT_GATEWAY_HOST: HostSchema.default('0.0.0.0'),
    AGENT_GATEWAY_PORT: integerString(1, 65_535).default('3300'),
    AGENT_GATEWAY_HEALTH_HOST: HostSchema.default('0.0.0.0'),
    AGENT_GATEWAY_HEALTH_PORT: integerString(1, 65_535).default('3301'),
    AGENT_GATEWAY_MAX_CONNECTIONS: integerString(1, 10).default('10'),
    AGENT_GATEWAY_PUBLISHER_POLL_INTERVAL_MS: integerString(10, 30_000).default('1000'),
    AGENT_GATEWAY_SHUTDOWN_TIMEOUT_MS: integerString(100, 30_000).default('5000'),
    AGENT_GATEWAY_ACCEPTED_WORKER_VERSIONS: jsonArray(WorkerVersionSchema, 1, 16),
    AGENT_GATEWAY_ACCEPTED_CODEX_RUNTIME_ARTIFACTS: jsonArray(Sha256DigestSchema, 1, 32),
    AGENT_GATEWAY_ACCEPTED_CODEX_PROTOCOL_SCHEMA_DIGESTS: jsonArray(Sha256DigestSchema, 1, 32),
    AGENT_GATEWAY_ACCEPTED_ISOLATION_MODES: jsonArray(IsolationModeSchema, 1, 2),
    AGENT_GATEWAY_PUBLISHER_DEPLOYMENT_ALLOWLIST: jsonArray(UuidSchema, 0, 32).default('[]'),
    PGHOST: HostSchema,
    PGPORT: integerString(1, 65_535).default('5432'),
    PGDATABASE: DatabaseNameSchema,
    PGUSER: z.literal('combo_agent_broker').default('combo_agent_broker'),
    POSTGRES_AGENT_BROKER_PASSWORD: PasswordSchema,
  })
  .passthrough()
  .superRefine((environment, context) => {
    if (environment.COMBO_RELEASE_ID !== `release-${environment.COMBO_SOURCE_SHA}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COMBO_RELEASE_ID'],
        message: 'release id must bind the exact source SHA',
      });
    }
    if (
      environment.AGENT_GATEWAY_PUBLISHER_ENABLED === 'true' &&
      environment.AGENT_GATEWAY_PUBLISHER_DEPLOYMENT_ALLOWLIST.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AGENT_GATEWAY_PUBLISHER_DEPLOYMENT_ALLOWLIST'],
        message: 'publisher requires a non-empty exact Deployment allowlist',
      });
    }
    if (environment.AGENT_GATEWAY_PORT === environment.AGENT_GATEWAY_HEALTH_PORT) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AGENT_GATEWAY_HEALTH_PORT'],
        message: 'health and transport ports must differ',
      });
    }
  });

export type AgentGatewayProcessConfig = Readonly<{
  environment: 'test';
  sourceSha: string;
  releaseId: string;
  releaseManifestDigest: string;
  host: string;
  port: number;
  healthHost: string;
  healthPort: number;
  maxConnections: number;
  publisherEnabled: boolean;
  publisherPollIntervalMs: number;
  shutdownTimeoutMs: number;
  database: Readonly<{
    host: string;
    port: number;
    database: string;
    user: 'combo_agent_broker';
    password: string;
  }>;
  policy: GatewayCompatibilityPolicy;
}>;

export function parseAgentGatewayProcessConfig(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AgentGatewayProcessConfig {
  const environment = ProcessEnvironmentSchema.parse(source);
  return Object.freeze({
    environment: environment.COMBO_ENVIRONMENT,
    sourceSha: environment.COMBO_SOURCE_SHA,
    releaseId: environment.COMBO_RELEASE_ID,
    releaseManifestDigest: environment.COMBO_RELEASE_MANIFEST_DIGEST,
    host: environment.AGENT_GATEWAY_HOST,
    port: environment.AGENT_GATEWAY_PORT,
    healthHost: environment.AGENT_GATEWAY_HEALTH_HOST,
    healthPort: environment.AGENT_GATEWAY_HEALTH_PORT,
    maxConnections: environment.AGENT_GATEWAY_MAX_CONNECTIONS,
    publisherEnabled: environment.AGENT_GATEWAY_PUBLISHER_ENABLED === 'true',
    publisherPollIntervalMs: environment.AGENT_GATEWAY_PUBLISHER_POLL_INTERVAL_MS,
    shutdownTimeoutMs: environment.AGENT_GATEWAY_SHUTDOWN_TIMEOUT_MS,
    database: Object.freeze({
      host: environment.PGHOST,
      port: environment.PGPORT,
      database: environment.PGDATABASE,
      user: environment.PGUSER,
      password: environment.POSTGRES_AGENT_BROKER_PASSWORD,
    }),
    policy: Object.freeze({
      acceptedWorkerVersions: [...environment.AGENT_GATEWAY_ACCEPTED_WORKER_VERSIONS],
      acceptedCodexRuntimeArtifacts: [
        ...environment.AGENT_GATEWAY_ACCEPTED_CODEX_RUNTIME_ARTIFACTS,
      ],
      acceptedCodexProtocolSchemaDigests: [
        ...environment.AGENT_GATEWAY_ACCEPTED_CODEX_PROTOCOL_SCHEMA_DIGESTS,
      ],
      acceptedIsolationModes: [...environment.AGENT_GATEWAY_ACCEPTED_ISOLATION_MODES],
      acceptedBrokerContractDigests: [currentBrokerContractDigest()],
      publisherDeploymentAllowlist:
        environment.AGENT_GATEWAY_PUBLISHER_DEPLOYMENT_ALLOWLIST.length === 0
          ? undefined
          : [...environment.AGENT_GATEWAY_PUBLISHER_DEPLOYMENT_ALLOWLIST],
      transactionTimeoutMs: 2_000,
      sessionTtlMs: 15 * 60_000,
      leaseTtlMs: 30_000,
      responseTtlMs: 30_000,
    }),
  });
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return true;
  }
  return false;
}
