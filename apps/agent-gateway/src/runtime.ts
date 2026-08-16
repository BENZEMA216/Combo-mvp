import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http';

import { currentBrokerContractDigest } from '@cb/creator-agent-protocol';
import { Pool, type PoolClient } from 'pg';

import type { AgentGatewayProcessConfig } from './config.js';
import { AgentGateway, type AgentGatewayAddress, type AgentGatewayOptions } from './gateway.js';
import {
  PostgresAgentGatewayAuthority,
  toGatewayPool,
  type GatewayPool,
} from './postgres-authority.js';
import { PostgresGatewayBusinessEventProjector } from './postgres-business-event-projector.js';

const READY_SCHEMA_COLUMNS = Object.freeze([
  ['worker_gateway_outbound_frames', 'wire_sent_at'],
  ['worker_gateway_outbound_frames', 'wire_expires_at'],
  ['worker_gateway_frame_receipts', 'broker_acknowledged_message_id'],
  ['worker_gateway_frame_receipts', 'broker_ack_level'],
  ['worker_gateway_frame_receipts', 'broker_ack_decision'],
] as const);

export interface RuntimeGateway {
  start(): Promise<AgentGatewayAddress>;
  stop(): Promise<void>;
}

export interface AgentGatewayRuntimeDependencies {
  gateway: RuntimeGateway;
  checkDatabaseReady(signal: AbortSignal): Promise<void>;
  closeDatabase(): Promise<void>;
}

export type AgentGatewayRuntimeAddress = Readonly<{
  transport: AgentGatewayAddress;
  health: Readonly<{ host: string; port: number }>;
}>;

/**
 * Executable lifecycle boundary for the Test-only Gateway process.
 *
 * Readiness is dynamic and includes the exact least-privilege PostgreSQL role/schema contract.
 * Stop flips readiness first, then drains WebSockets, closes the health listener, and finally
 * closes the database pool. The process wrapper supplies the final hard shutdown deadline.
 */
export class AgentGatewayRuntime {
  readonly #config: AgentGatewayProcessConfig;
  readonly #dependencies: AgentGatewayRuntimeDependencies;

  #healthServer?: HttpServer;
  #address?: AgentGatewayRuntimeAddress;
  #starting?: Promise<AgentGatewayRuntimeAddress>;
  #stopping?: Promise<void>;
  #ready = false;

  public constructor(
    config: AgentGatewayProcessConfig,
    dependencies: AgentGatewayRuntimeDependencies,
  ) {
    this.#config = config;
    this.#dependencies = dependencies;
  }

  public get address(): AgentGatewayRuntimeAddress | undefined {
    return this.#address;
  }

  public async start(): Promise<AgentGatewayRuntimeAddress> {
    if (this.#stopping !== undefined) throw new Error('AGENT_GATEWAY_RUNTIME_STOPPING');
    if (this.#address !== undefined) return this.#address;
    if (this.#starting !== undefined) return this.#starting;
    this.#starting = this.#startOnce();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  public async stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping;
    const starting = this.#starting;
    this.#ready = false;
    this.#stopping = (async () => {
      await starting?.catch(() => undefined);
      const transportResults = await Promise.allSettled([
        this.#dependencies.gateway.stop(),
        closeServer(this.#healthServer),
      ]);
      this.#healthServer = undefined;
      this.#address = undefined;
      const databaseResult = await Promise.allSettled([this.#dependencies.closeDatabase()]);
      if ([...transportResults, ...databaseResult].some((result) => result.status === 'rejected')) {
        throw new Error('AGENT_GATEWAY_RUNTIME_STOP_FAILED');
      }
    })();
    return this.#stopping;
  }

  async #startOnce(): Promise<AgentGatewayRuntimeAddress> {
    const readinessSignal = AbortSignal.timeout(2_000);
    await this.#dependencies.checkDatabaseReady(readinessSignal);

    let transport: AgentGatewayAddress | undefined;
    try {
      transport = await this.#dependencies.gateway.start();
      const healthServer = createServer((request, response) => {
        void this.#handleHealthRequest(request.method, request.url, response).catch(() => {
          response.destroy();
        });
      });
      healthServer.headersTimeout = 2_000;
      healthServer.requestTimeout = 2_000;
      healthServer.keepAliveTimeout = 1_000;
      healthServer.on('clientError', (_error, socket) => socket.destroy());
      this.#healthServer = healthServer;
      await listen(healthServer, this.#config.healthPort, this.#config.healthHost);
      const rawAddress = healthServer.address();
      if (rawAddress === null || typeof rawAddress === 'string') {
        throw new Error('INVALID_HEALTH_LISTENER');
      }
      this.#ready = true;
      this.#address = Object.freeze({
        transport,
        health: Object.freeze({ host: this.#config.healthHost, port: rawAddress.port }),
      });
      return this.#address;
    } catch (error) {
      this.#ready = false;
      await Promise.allSettled([
        transport === undefined ? Promise.resolve() : this.#dependencies.gateway.stop(),
        closeServer(this.#healthServer),
      ]);
      this.#healthServer = undefined;
      throw error;
    }
  }

  async #handleHealthRequest(
    method: string | undefined,
    url: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    if (method !== 'GET') {
      writeJson(response, 405, { status: 'error', code: 'METHOD_NOT_ALLOWED' });
      return;
    }
    if (url === '/health') {
      writeJson(response, 200, this.#healthPayload('ok'));
      return;
    }
    if (url !== '/ready') {
      writeJson(response, 404, { status: 'error', code: 'NOT_FOUND' });
      return;
    }
    if (!this.#ready) {
      writeJson(response, 503, this.#healthPayload('down'));
      return;
    }
    try {
      await this.#dependencies.checkDatabaseReady(AbortSignal.timeout(1_500));
      if (!this.#ready) throw new Error('DRAINING');
      writeJson(response, 200, this.#healthPayload('ok'));
    } catch {
      writeJson(response, 503, this.#healthPayload('down'));
    }
  }

  #healthPayload(status: 'ok' | 'down') {
    return {
      status,
      service: 'agent-gateway',
      environment: this.#config.environment,
      sourceSha: this.#config.sourceSha,
      releaseId: this.#config.releaseId,
      releaseManifestDigest: this.#config.releaseManifestDigest,
      brokerContractDigest: currentBrokerContractDigest(),
      capability: 'conversation.open-ready/test-v1',
    } as const;
  }
}

export function createPostgresAgentGatewayRuntime(
  config: AgentGatewayProcessConfig,
  options: Pick<AgentGatewayOptions, 'diagnosticSink'> = {},
): AgentGatewayRuntime {
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    password: config.database.password,
    application_name: `combo-agent-gateway-${config.sourceSha.slice(0, 12)}`,
    max: Math.max(4, config.maxConnections + 2),
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    maxUses: 10_000,
  });
  attachBrokerPoolErrorBoundary(pool, options.diagnosticSink);
  const broker = toGatewayPool(pool);
  const authority = new PostgresAgentGatewayAuthority(
    { api: unavailableApiPool(), broker },
    config.policy,
    // This bootstrap intentionally supports only conversation.open/ready. Invocation events fail
    // closed until a real session-key/KMS terminal sealer and complete lifecycle projector exist.
    new PostgresGatewayBusinessEventProjector(),
  );
  const gateway = new AgentGateway({
    authority,
    host: config.host,
    port: config.port,
    maxConnections: config.maxConnections,
    publisherEnabled: config.publisherEnabled,
    publisherPollIntervalMs: config.publisherPollIntervalMs,
    stopTimeoutMs: Math.min(config.shutdownTimeoutMs, 5_000),
    diagnosticSink: options.diagnosticSink,
  });
  return new AgentGatewayRuntime(config, {
    gateway,
    checkDatabaseReady: (signal) => checkBrokerDatabaseReady(pool, signal),
    closeDatabase: () => pool.end(),
  });
}

export function attachBrokerPoolErrorBoundary(
  pool: Pool,
  diagnosticSink?: AgentGatewayOptions['diagnosticSink'],
): void {
  pool.on('error', () => {
    // node-postgres emits idle-client network failures on the Pool EventEmitter. Always consume
    // them so a database restart cannot crash the process or print the raw driver error. The
    // optional event is a fixed enum and the sink is isolated from this mandatory error boundary.
    try {
      diagnosticSink?.('database_idle_client_error');
    } catch {
      // A diagnostic consumer is never allowed to rethrow an idle database error.
    }
  });
}

export async function checkBrokerDatabaseReady(pool: Pool, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  const pendingClient = pool.connect();
  let client: PoolClient;
  try {
    client = await raceWithSignal(pendingClient, signal);
  } catch (error) {
    // Abort does not cancel pg.Pool.connect(). If the pool hands out a client after the probe has
    // already timed out, destroy that late client instead of leaking one slot on every readiness
    // request until the process becomes permanently unavailable.
    if (signal.aborted) {
      void pendingClient.then(
        (lateClient) => lateClient.release(true),
        () => undefined,
      );
    }
    throw error;
  }
  let destroy = false;
  try {
    const result = await raceWithSignal(
      client.query<{
        role_name: string;
        least_privilege: boolean;
        schema_ready: boolean;
      }>(
        `SELECT current_user AS role_name,
                COALESCE((
                  SELECT NOT role.rolsuper AND NOT role.rolbypassrls
                    FROM pg_catalog.pg_roles AS role
                   WHERE role.rolname = current_user
                ), false) AS least_privilege,
                to_regclass('public.worker_gateway_sessions') IS NOT NULL
                AND to_regclass('public.worker_gateway_outbound_frames') IS NOT NULL
                AND to_regclass('public.worker_gateway_frame_receipts') IS NOT NULL
                AND to_regclass('public.worker_gateway_operation_receipts') IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                    FROM (VALUES
                      ${READY_SCHEMA_COLUMNS.map(
                        (_column, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::text)`,
                      ).join(', ')}
                    ) AS required(table_name, column_name)
                   WHERE NOT EXISTS (
                     SELECT 1
                       FROM information_schema.columns AS column_definition
                      WHERE column_definition.table_schema = 'public'
                        AND column_definition.table_name = required.table_name
                        AND column_definition.column_name = required.column_name
                   )
                ) AS schema_ready`,
        READY_SCHEMA_COLUMNS.flatMap(([table, column]) => [table, column]),
      ),
      signal,
    );
    const row = result.rows[0];
    if (
      result.rowCount !== 1 ||
      row?.role_name !== 'combo_agent_broker' ||
      row.least_privilege !== true ||
      row.schema_ready !== true
    ) {
      throw new Error('AGENT_GATEWAY_DATABASE_NOT_READY');
    }
  } catch (error) {
    destroy = signal.aborted;
    throw error;
  } finally {
    client.release(destroy);
  }
}

function unavailableApiPool(): GatewayPool {
  return Object.freeze({
    connect: async () => {
      throw new Error('AGENT_GATEWAY_API_POOL_UNAVAILABLE');
    },
  });
}

async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: HttpServer | undefined): Promise<void> {
  if (server === undefined || !server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function abortError(): DOMException {
  return new DOMException('gateway readiness aborted', 'AbortError');
}
