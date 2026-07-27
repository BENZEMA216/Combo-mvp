import { generateKeyPairSync } from 'node:crypto';
import type {
  V1DeleteOptions,
  V1PersistentVolumeClaim,
  V1Pod,
  V1PodList,
  V1Status,
} from '@kubernetes/client-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../platform/config/env.js';
import { loadEnv } from '../platform/config/env.js';
import type { QueryResultLike, RuntimeDb, TxConn } from '../platform/infra/db.js';
import {
  buildSandboxPod,
  KubernetesSandboxBackend,
  type SandboxPodApi,
} from '../platform/infra/kubernetes-sandbox-backend.js';
import type { SandboxCapabilitySigner } from '../platform/infra/sandbox-capability.js';
import { SandboxClient } from '../platform/infra/sandbox-client.js';

const SANDBOX_IMAGE_A = `registry.invalid/combo-sandboxd@sha256:${'a'.repeat(64)}`;
const SANDBOX_IMAGE_B = `registry.invalid/combo-sandboxd@sha256:${'b'.repeat(64)}`;

function sandboxEnv(overrides: Partial<Env> = {}): Env {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    ...loadEnv(),
    SANDBOX_TOOLS_ENABLED: true,
    SANDBOX_NAMESPACE: 'combo-sandbox',
    SANDBOX_CONFIGURATION_REVISION: 1,
    SANDBOX_IMAGE: SANDBOX_IMAGE_A,
    SANDBOX_CAPABILITY_PRIVATE_KEY: privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    SANDBOX_CAPACITY: 4,
    SANDBOX_FIFTH_SLOT_VALIDATED: false,
    SANDBOX_RUNTIME_CLASS: 'gvisor',
    SANDBOX_COMMAND_TIMEOUT_MS: 120_000,
    SANDBOX_STARTUP_TIMEOUT_MS: 2_000,
    SANDBOX_IDLE_TTL_MS: 900_000,
    SANDBOX_ABSOLUTE_TTL_MS: 1_800_000,
    SANDBOX_SWEEP_INTERVAL_MS: 60_000,
    ...overrides,
  };
}

interface RuntimeDbFixture {
  ownerMatches: boolean;
  turnMatches: boolean;
  sessionStatus: 'active' | 'closed' | 'missing';
  sessionUpdatedAt: string | Date;
  runningTurn: boolean;
  authorizationRunningTurn: boolean;
  authorizationResults?: boolean[];
  transactionLog?: string[];
  queryLog?: string[];
}

function runtimeDb(input: boolean | Partial<RuntimeDbFixture> = true): RuntimeDb {
  const fixture: RuntimeDbFixture = {
    ownerMatches: typeof input === 'boolean' ? input : (input.ownerMatches ?? true),
    turnMatches: typeof input === 'boolean' ? input : (input.turnMatches ?? true),
    sessionStatus: typeof input === 'boolean' ? 'active' : (input.sessionStatus ?? 'active'),
    sessionUpdatedAt:
      typeof input === 'boolean'
        ? new Date().toISOString()
        : (input.sessionUpdatedAt ?? new Date().toISOString()),
    runningTurn: typeof input === 'boolean' ? true : (input.runningTurn ?? true),
    authorizationRunningTurn:
      typeof input === 'boolean'
        ? true
        : (input.authorizationRunningTurn ?? input.runningTurn ?? true),
    ...(typeof input !== 'boolean' && input.authorizationResults
      ? { authorizationResults: [...input.authorizationResults] }
      : {}),
    ...(typeof input !== 'boolean' && input.transactionLog
      ? { transactionLog: input.transactionLog }
      : {}),
    ...(typeof input !== 'boolean' && input.queryLog ? { queryLog: input.queryLog } : {}),
  };
  const query = async <R = Record<string, unknown>>(sql: string): Promise<QueryResultLike<R>> => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    fixture.queryLog?.push(normalized);
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      fixture.transactionLog?.push(normalized);
      return { rows: [], rowCount: null };
    }
    if (normalized.startsWith("SELECT set_config('lock_timeout'")) {
      return { rows: [{}] as R[], rowCount: 1 };
    }
    if (normalized.includes('JOIN turns t ON')) {
      const authorizationRunningTurn =
        fixture.authorizationResults?.shift() ?? fixture.authorizationRunningTurn;
      const allowed =
        fixture.ownerMatches &&
        fixture.turnMatches &&
        fixture.sessionStatus === 'active' &&
        authorizationRunningTurn;
      return allowed
        ? { rows: [{ turn_id: 'turn' }] as R[], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized === 'SELECT id FROM sessions WHERE id = $1 FOR UPDATE') {
      return fixture.sessionStatus === 'missing'
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: 'session' }] as R[], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT status, updated_at FROM sessions')) {
      if (fixture.sessionStatus === 'missing') return { rows: [], rowCount: 0 };
      return {
        rows: [{ status: fixture.sessionStatus, updated_at: fixture.sessionUpdatedAt }] as R[],
        rowCount: 1,
      };
    }
    if (normalized.startsWith('SELECT EXISTS') && normalized.includes('FROM turns')) {
      return { rows: [{ exists: fixture.runningTurn }] as R[], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${normalized}`);
  };
  return {
    query,
    async connect(): Promise<TxConn> {
      return { query, release: () => undefined };
    },
  };
}

class FakePodApi implements SandboxPodApi {
  readonly pods = new Map<string, V1Pod>();
  readonly claims = new Map<string, V1PersistentVolumeClaim>();
  readonly deletes: Array<{ name: string; body?: V1DeleteOptions }> = [];
  readonly patches: Array<{ name: string; body: unknown }> = [];
  readonly claimPatches: Array<{ name: string; body: unknown }> = [];
  private sequence = 0;

  constructor() {
    for (let slot = 0; slot < 5; slot += 1) {
      const name = `combo-sandbox-workspace-slot-${slot}`;
      this.claims.set(name, {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name,
          namespace: 'combo-sandbox',
          uid: `claim-uid-${slot}`,
          resourceVersion: `claim-rv-${slot}`,
          labels: {
            'app.kubernetes.io/part-of': 'combo',
            'app.kubernetes.io/component': 'model-sandbox-workspace',
            'sandbox.combo.dev/slot': String(slot),
          },
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: 'combo-sandbox-loopback',
          volumeMode: 'Filesystem',
          volumeName: name,
          resources: { requests: { storage: '1Gi' } },
        },
        status: { phase: 'Bound' },
      });
    }
  }

  async readNamespacedPersistentVolumeClaim(input: {
    name: string;
  }): Promise<V1PersistentVolumeClaim> {
    const claim = this.claims.get(input.name);
    if (!claim) throw Object.assign(new Error('not found'), { code: 404 });
    return structuredClone(claim);
  }

  async patchNamespacedPersistentVolumeClaim(input: {
    name: string;
    body: unknown;
  }): Promise<V1PersistentVolumeClaim> {
    this.claimPatches.push({ name: input.name, body: input.body });
    const claim = this.claims.get(input.name);
    if (!claim) throw Object.assign(new Error('not found'), { code: 404 });
    const operations = input.body as Array<{
      op: 'test' | 'add' | 'replace' | 'remove';
      path: string;
      value?: unknown;
    }>;
    for (const operation of operations) {
      if (operation.path === '/metadata/uid') {
        if (operation.op === 'test' && claim.metadata?.uid !== operation.value) {
          throw Object.assign(new Error('json patch test failed'), { code: 422 });
        }
        continue;
      }
      if (operation.path === '/metadata/resourceVersion') {
        if (operation.op === 'test' && claim.metadata?.resourceVersion !== operation.value) {
          throw Object.assign(new Error('json patch test failed'), { code: 422 });
        }
        continue;
      }
      const prefix = '/metadata/annotations/';
      if (!operation.path.startsWith(prefix)) continue;
      const key = operation.path.slice(prefix.length).replaceAll('~1', '/').replaceAll('~0', '~');
      const annotations = (claim.metadata!.annotations ??= {});
      if (operation.op === 'test' && annotations[key] !== operation.value) {
        throw Object.assign(new Error('json patch test failed'), { code: 422 });
      }
      if (operation.op === 'add' || operation.op === 'replace') {
        annotations[key] = operation.value as string;
      }
      if (operation.op === 'remove') delete annotations[key];
    }
    this.sequence += 1;
    claim.metadata!.resourceVersion = `claim-rv-${this.sequence}`;
    return structuredClone(claim);
  }

  async readNamespacedPod(input: { name: string }): Promise<V1Pod> {
    const pod = this.pods.get(input.name);
    if (!pod) throw Object.assign(new Error('not found'), { code: 404 });
    return structuredClone(pod);
  }

  async createNamespacedPod(input: { body: V1Pod }): Promise<V1Pod> {
    const name = input.body.metadata?.name;
    if (!name) throw new Error('pod name missing');
    if (this.pods.has(name)) throw Object.assign(new Error('conflict'), { code: 409 });
    this.sequence += 1;
    const pod = structuredClone(input.body);
    pod.metadata = {
      ...pod.metadata,
      uid: `pod-uid-${this.sequence}`,
      resourceVersion: String(this.sequence),
      creationTimestamp: new Date(),
    };
    for (const container of pod.spec?.containers ?? []) {
      for (const probe of [
        container.startupProbe,
        container.readinessProbe,
        container.livenessProbe,
      ]) {
        if (!probe) continue;
        probe.initialDelaySeconds ??= 0;
        probe.successThreshold ??= 1;
        if (probe.httpGet) probe.httpGet.scheme ??= 'HTTP';
      }
      container.terminationMessagePath ??= '/dev/termination-log';
      container.terminationMessagePolicy ??= 'File';
    }
    pod.status = {
      phase: 'Running',
      podIP: `10.0.0.${this.sequence}`,
      conditions: [{ type: 'Ready', status: 'True' }],
      initContainerStatuses: (pod.spec?.initContainers ?? []).map((container) => ({
        name: container.name,
        image: container.image ?? '',
        imageID: 'image',
        ready: true,
        restartCount: 0,
        state: { terminated: { exitCode: 0 } },
      })),
      containerStatuses: (pod.spec?.containers ?? []).map((container) => ({
        name: container.name,
        image: container.image ?? '',
        imageID: 'image',
        ready: true,
        restartCount: 0,
        state: { running: { startedAt: new Date() } },
      })),
    };
    this.pods.set(name, pod);
    return structuredClone(pod);
  }

  async deleteNamespacedPod(input: {
    name: string;
    body?: V1DeleteOptions;
  }): Promise<V1Pod | V1Status> {
    this.deletes.push({ name: input.name, body: input.body });
    const pod = this.pods.get(input.name);
    if (!pod) throw Object.assign(new Error('not found'), { code: 404 });
    if (
      input.body?.preconditions?.uid !== pod.metadata?.uid ||
      (input.body?.preconditions?.resourceVersion !== undefined &&
        input.body.preconditions.resourceVersion !== pod.metadata?.resourceVersion)
    ) {
      throw Object.assign(new Error('conflict'), { code: 409 });
    }
    this.sequence += 1;
    pod.metadata = {
      ...pod.metadata,
      deletionTimestamp: new Date(),
      resourceVersion: String(this.sequence),
    };
    pod.status = {
      ...pod.status,
      phase: 'Failed',
      containerStatuses: (pod.spec?.containers ?? []).map((container) => ({
        name: container.name,
        image: container.image ?? '',
        imageID: 'image',
        ready: false,
        restartCount: 0,
        state: { terminated: { exitCode: 143 } },
      })),
    };
    if ((pod.metadata.finalizers ?? []).length === 0) this.pods.delete(input.name);
    return structuredClone(pod);
  }

  async patchNamespacedPod(input: { name: string; body: unknown }): Promise<V1Pod> {
    this.patches.push({ name: input.name, body: input.body });
    const pod = this.pods.get(input.name);
    if (!pod) throw Object.assign(new Error('not found'), { code: 404 });
    const operations = input.body as Array<{
      op: 'test' | 'add' | 'remove';
      path: string;
      value?: unknown;
    }>;
    for (const operation of operations) {
      if (operation.op === 'test' && operation.path === '/metadata/uid') {
        if (pod.metadata?.uid !== operation.value)
          throw Object.assign(new Error('conflict'), { code: 409 });
      } else if (operation.op === 'test' && operation.path === '/metadata/resourceVersion') {
        if (pod.metadata?.resourceVersion !== operation.value)
          throw Object.assign(new Error('conflict'), { code: 409 });
      } else if (operation.op === 'add' && operation.path === '/metadata/finalizers') {
        pod.metadata!.finalizers = [...(operation.value as string[])];
      } else if (operation.op === 'add' && operation.path === '/metadata/finalizers/-') {
        pod.metadata!.finalizers = [...(pod.metadata?.finalizers ?? []), operation.value as string];
      } else {
        const match = /^\/metadata\/finalizers\/(\d+)$/.exec(operation.path);
        if (!match) continue;
        const index = Number(match[1]);
        const finalizers = pod.metadata?.finalizers ?? [];
        if (operation.op === 'test' && finalizers[index] !== operation.value) {
          throw Object.assign(new Error('conflict'), { code: 409 });
        }
        if (operation.op === 'remove') finalizers.splice(index, 1);
      }
    }
    this.sequence += 1;
    pod.metadata!.resourceVersion = String(this.sequence);
    const response = structuredClone(pod);
    if (pod.metadata?.deletionTimestamp && (pod.metadata.finalizers ?? []).length === 0) {
      this.pods.delete(input.name);
    }
    return response;
  }

  async listNamespacedPod(): Promise<V1PodList> {
    return { apiVersion: 'v1', kind: 'PodList', metadata: {}, items: [...this.pods.values()] };
  }
}

const signer: SandboxCapabilitySigner = {
  sign: async () => 'signed',
  publicKeyBase64: () => 'public-spki',
};

function context(index: number) {
  return {
    sessionId: `session-${index}`,
    turnId: `turn-${index}`,
    ownerUserId: `owner-${index}`,
  };
}

function describeResponse(init?: RequestInit): Response {
  const headers = new Headers(init?.headers);
  return new Response(
    JSON.stringify({
      protocolVersion: '1',
      sessionId: headers.get('X-Sandbox-Session-Id'),
      podUid: headers.get('X-Sandbox-Pod-Uid'),
      workspace: '/workspace',
      commandOutputEncoding: 'base64',
      operations: ['describe', 'read', 'write', 'edit', 'command', 'cancel'],
      limits: {
        maxRequestBytes: 1,
        maxReadBytes: 1,
        maxFileBytes: 1,
        maxOutputBytes: 1,
        maxOutputFrames: 1,
        maxFrameBytes: 1,
        commandTimeoutMs: 1,
        maxCommandTimeMs: 1,
      },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Kubernetes sandbox backend', () => {
  it('builds a plain gVisor Pod with no credentials, no network identity and hard resource bounds', () => {
    const pod = buildSandboxPod({
      env: sandboxEnv(),
      slot: 2,
      sessionId: 'session-1',
      publicKey: 'public-only',
      fingerprint: 'fingerprint',
      allocationId: 'allocation-1',
    });
    expect(pod.kind).toBe('Pod');
    expect(pod.metadata?.annotations).toMatchObject({
      'sandbox.combo.dev/session-id': 'session-1',
      'sandbox.combo.dev/config-revision': '1',
      'sandbox.combo.dev/allocation-id': 'allocation-1',
    });
    expect(pod.metadata?.finalizers).toEqual(['sandbox.combo.dev/await-node-termination']);
    expect(pod.metadata?.labels).toEqual({
      app: 'combo-sandboxd',
      'app.kubernetes.io/name': 'sandboxd',
      'app.kubernetes.io/instance': 'combo-sandbox-slot-2',
      'app.kubernetes.io/component': 'model-sandbox',
      'app.kubernetes.io/part-of': 'combo',
      'app.kubernetes.io/managed-by': 'combo-runtime',
      'sandbox.combo.dev/slot': '2',
    });
    expect(pod.spec).toMatchObject({
      runtimeClassName: 'gvisor',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostIPC: false,
      hostNetwork: false,
      hostPID: false,
      restartPolicy: 'Never',
      activeDeadlineSeconds: 1_800,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10002,
        runAsGroup: 10002,
        fsGroup: 10002,
        fsGroupChangePolicy: 'OnRootMismatch',
        seccompProfile: { type: 'RuntimeDefault' },
      },
    });
    const resources = {
      requests: { cpu: '100m', memory: '384Mi', 'ephemeral-storage': '128Mi' },
      limits: { cpu: '500m', memory: '384Mi', 'ephemeral-storage': '128Mi' },
    };
    const wipe = pod.spec!.initContainers?.[0];
    expect(wipe).toMatchObject({
      name: 'wipe-workspace',
      command: ['/usr/local/bin/wipe-workspace'],
      resources,
      volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        runAsNonRoot: true,
        runAsUser: 10002,
        runAsGroup: 10002,
        capabilities: { drop: ['ALL'] },
        seccompProfile: { type: 'RuntimeDefault' },
      },
    });
    const container = pod.spec!.containers[0]!;
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 10002,
      runAsGroup: 10002,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(container.resources).toEqual(resources);
    expect(container.terminationMessagePath).toBe('/dev/termination-log');
    expect(container.terminationMessagePolicy).toBe('File');
    expect(pod.spec?.volumes).toEqual([
      {
        name: 'workspace',
        persistentVolumeClaim: {
          claimName: 'combo-sandbox-workspace-slot-2',
        },
      },
      { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } },
    ]);
    const envNames = container.env?.map((entry) => entry.name) ?? [];
    expect(envNames).toContain('SANDBOX_CAPABILITY_PUBLIC_KEY');
    expect(envNames).not.toEqual(
      expect.arrayContaining([
        'SANDBOX_CAPABILITY_PRIVATE_KEY',
        'ANTHROPIC_API_KEY',
        'OPENROUTER_API_KEY',
        'DATABASE_URL',
      ]),
    );
  });

  it.each(
    (['read', 'write', 'edit', 'command'] as const).flatMap((operation) =>
      (
        [
          ['non-owner', { ownerMatches: false }],
          ['inactive Session', { sessionStatus: 'closed' as const }],
          ['wrong Turn', { turnMatches: false }],
          ['non-running Turn', { authorizationRunningTurn: false }],
        ] as const
      ).map(([name, fixture]) => [name, operation, fixture] as const),
    ),
  )('rejects %s before Kubernetes for the %s operation', async (_name, operation, fixture) => {
    const api = new FakePodApi();
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(fixture), {
      api,
      signer,
    });
    const actions = {
      read: () => backend.read(context(1), { path: 'a.txt' }),
      write: () => backend.write(context(1), { path: 'a.txt', content: 'x' }),
      edit: () => backend.edit(context(1), { path: 'a.txt', oldText: 'x', newText: 'y' }),
      command: () => backend.command(context(1), { command: 'true' }, () => undefined),
    };
    try {
      await expect(actions[operation]()).rejects.toMatchObject({ code: 'unauthorized' });
      expect(api.pods.size).toBe(0);
    } finally {
      await backend.dispose();
    }
  });

  it('takes a database key-share lock before any Kubernetes allocation', async () => {
    const api = new FakePodApi();
    const queryLog: string[] = [];
    const backend = new KubernetesSandboxBackend(
      sandboxEnv(),
      runtimeDb({ ownerMatches: false, queryLog }),
      { api, signer },
    );
    try {
      await expect(backend.read(context(1), { path: 'a.txt' })).rejects.toMatchObject({
        code: 'unauthorized',
      });
      expect(queryLog[0]).toContain('FOR KEY SHARE OF s');
      expect(api.pods.size).toBe(0);
    } finally {
      await backend.dispose();
    }
  });

  it('does not reserve a PVC when terminalization wins after initial authorization', async () => {
    const api = new FakePodApi();
    const backend = new KubernetesSandboxBackend(
      sandboxEnv(),
      runtimeDb({ authorizationResults: [true, false] }),
      { api, signer },
    );
    try {
      await expect(backend.describe(context(1))).rejects.toMatchObject({
        code: 'unauthorized',
      });
      expect(api.claimPatches).toHaveLength(0);
      expect(api.pods.size).toBe(0);
    } finally {
      await backend.dispose();
    }
  });

  it('revalidates inside the side-effect transaction and never sends a write after a terminal race', async () => {
    const api = new FakePodApi();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/describe')) return describeResponse(init);
      if (String(url).endsWith('/v1/files/write')) {
        return new Response(JSON.stringify({ writtenBytes: 1 }));
      }
      throw new Error('unexpected sandbox URL');
    });
    const backend = new KubernetesSandboxBackend(
      sandboxEnv(),
      runtimeDb({ authorizationResults: [true, true, true, false] }),
      {
        api,
        signer,
        clientFactory: (options) =>
          new SandboxClient({ ...options, fetch: fetch as typeof globalThis.fetch }),
      },
    );
    try {
      await expect(
        backend.write(context(1), { path: 'a.txt', content: 'x' }),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      expect(
        fetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/files/write')),
      ).toHaveLength(0);
    } finally {
      await backend.dispose();
    }
  });

  it('holds the Session key-share transaction until a bounded file write settles', async () => {
    const api = new FakePodApi();
    const transactionLog: string[] = [];
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/describe')) return describeResponse(init);
      if (String(url).endsWith('/v1/files/write')) {
        markWriteStarted();
        await writeReleased;
        return new Response(JSON.stringify({ writtenBytes: 1 }));
      }
      throw new Error('unexpected sandbox URL');
    });
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb({ transactionLog }), {
      api,
      signer,
      clientFactory: (options) =>
        new SandboxClient({ ...options, fetch: fetch as typeof globalThis.fetch }),
    });
    try {
      const writing = backend.write(context(1), { path: 'a.txt', content: 'x' });
      await writeStarted;
      expect(transactionLog.filter((entry) => entry === 'BEGIN').length).toBe(
        transactionLog.filter((entry) => entry === 'COMMIT').length + 1,
      );
      releaseWrite();
      await expect(writing).resolves.toEqual({ writtenBytes: 1 });
      expect(transactionLog.filter((entry) => entry === 'BEGIN').length).toBe(
        transactionLog.filter((entry) => entry === 'COMMIT').length,
      );
    } finally {
      releaseWrite?.();
      await backend.dispose();
    }
  });

  it('deletes a Pod allocated from stale authorization when the final authorization is terminal', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(
      sandboxEnv(),
      runtimeDb({ authorizationResults: [true, true, false] }),
      { api, signer },
    );
    try {
      await expect(backend.describe(context(1))).rejects.toMatchObject({
        code: 'unauthorized',
      });
      expect(api.pods.size).toBe(0);
      expect(api.deletes).toHaveLength(1);
    } finally {
      await backend.dispose();
    }
  });

  it('retries an atomic PVC reservation when Kubernetes reports a JSON Patch conflict', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const patch = api.patchNamespacedPersistentVolumeClaim.bind(api);
    let conflicted = false;
    api.patchNamespacedPersistentVolumeClaim = async (input) => {
      if (!conflicted) {
        conflicted = true;
        throw Object.assign(new Error('json patch test failed'), { code: 422 });
      }
      return patch(input);
    };
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await backend.describe(context(1));
      expect(conflicted).toBe(true);
      expect(api.claims.get('combo-sandbox-workspace-slot-0')?.metadata?.annotations).toMatchObject(
        {
          'sandbox.combo.dev/slot-state': 'active',
          'sandbox.combo.dev/session-id': 'session-1',
        },
      );
    } finally {
      await backend.dispose();
    }
  });

  it('reuses one atomic slot when two Runtime replicas race for the same Session', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            protocolVersion: '1',
            sessionId: headers.get('X-Sandbox-Session-Id'),
            podUid: headers.get('X-Sandbox-Pod-Uid'),
            workspace: '/workspace',
            commandOutputEncoding: 'base64',
            operations: ['describe', 'read', 'write', 'edit', 'command', 'cancel'],
            limits: {
              maxRequestBytes: 1,
              maxReadBytes: 1,
              maxFileBytes: 1,
              maxOutputBytes: 1,
              maxOutputFrames: 1,
              maxFrameBytes: 1,
              commandTimeoutMs: 1,
              maxCommandTimeMs: 1,
            },
          }),
        );
      }),
    );
    const env = sandboxEnv();
    const first = new KubernetesSandboxBackend(env, runtimeDb(), { api, signer });
    const second = new KubernetesSandboxBackend(env, runtimeDb(), { api, signer });
    try {
      await Promise.all([first.describe(context(1)), second.describe(context(1))]);
      expect(api.pods.size).toBe(1);
      expect([...api.pods.values()][0]?.metadata?.annotations).toMatchObject({
        'sandbox.combo.dev/session-id': 'session-1',
      });
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('lets two Runtime instances atomically compete for four fixed names, reuses Session, and rejects a fifth', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            protocolVersion: '1',
            sessionId: headers.get('X-Sandbox-Session-Id'),
            podUid: headers.get('X-Sandbox-Pod-Uid'),
            workspace: '/workspace',
            commandOutputEncoding: 'base64',
            operations: ['describe', 'read', 'write', 'edit', 'command', 'cancel'],
            limits: {
              maxRequestBytes: 1,
              maxReadBytes: 1,
              maxFileBytes: 1,
              maxOutputBytes: 1,
              maxOutputFrames: 1,
              maxFrameBytes: 1,
              commandTimeoutMs: 1,
              maxCommandTimeMs: 1,
            },
          }),
          { status: 200 },
        );
      }),
    );
    const env = sandboxEnv();
    const first = new KubernetesSandboxBackend(env, runtimeDb(), { api, signer });
    const second = new KubernetesSandboxBackend(env, runtimeDb(), { api, signer });
    try {
      await Promise.all([
        first.describe(context(1)),
        second.describe(context(2)),
        first.describe(context(3)),
        second.describe(context(4)),
      ]);
      expect([...api.pods.keys()].sort()).toEqual([
        'combo-sandbox-slot-0',
        'combo-sandbox-slot-1',
        'combo-sandbox-slot-2',
        'combo-sandbox-slot-3',
      ]);
      const beforeReuse = [...api.pods.values()].find(
        (pod) => pod.metadata?.annotations?.['sandbox.combo.dev/session-id'] === 'session-1',
      )?.metadata?.uid;
      await second.describe(context(1));
      const afterReuse = [...api.pods.values()].find(
        (pod) => pod.metadata?.annotations?.['sandbox.combo.dev/session-id'] === 'session-1',
      )?.metadata?.uid;
      expect(afterReuse).toBe(beforeReuse);
      await expect(first.describe(context(5))).rejects.toMatchObject({ code: 'capacity' });
      expect(api.pods.size).toBe(4);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('does not let an old four-slot replica reap even an idle validated fifth slot', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const five = new KubernetesSandboxBackend(
      sandboxEnv({
        SANDBOX_CONFIGURATION_REVISION: 2,
        SANDBOX_CAPACITY: 5,
        SANDBOX_FIFTH_SLOT_VALIDATED: true,
      }),
      runtimeDb(),
      { api, signer },
    );
    const four = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb({ runningTurn: false }), {
      api,
      signer,
    });
    try {
      await Promise.all(
        Array.from({ length: 5 }, (_unused, index) => five.describe(context(index))),
      );
      expect(api.pods.has('combo-sandbox-slot-4')).toBe(true);
      await four.reap();
      expect(api.pods.has('combo-sandbox-slot-4')).toBe(true);
      expect(api.deletes.some(({ name }) => name === 'combo-sandbox-slot-4')).toBe(false);
    } finally {
      await five.dispose();
      await four.dispose();
    }
  });

  it('replaces an old replica Pod created after the new replica started once the current Turn owns the Session lock', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const newer = new KubernetesSandboxBackend(
      sandboxEnv({
        SANDBOX_CONFIGURATION_REVISION: 2,
        SANDBOX_IMAGE: SANDBOX_IMAGE_A,
      }),
      runtimeDb(),
      {
        api,
        signer,
      },
    );
    const older = new KubernetesSandboxBackend(
      sandboxEnv({
        SANDBOX_CONFIGURATION_REVISION: 1,
        SANDBOX_IMAGE: SANDBOX_IMAGE_B,
      }),
      runtimeDb(),
      {
        api,
        signer,
      },
    );
    try {
      await older.describe(context(1));
      const oldUid = [...api.pods.values()][0]?.metadata?.uid;
      await newer.describe(context(1));
      const replacement = [...api.pods.values()][0]!;
      expect(replacement.metadata?.uid).not.toBe(oldUid);
      expect(replacement.spec?.containers[0]?.image).toBe(SANDBOX_IMAGE_A);
      const replacementUid = replacement.metadata?.uid;
      await expect(older.describe(context(1))).rejects.toMatchObject({ code: 'unavailable' });
      expect([...api.pods.values()][0]?.metadata?.uid).toBe(replacementUid);
    } finally {
      await newer.dispose();
      await older.dispose();
    }
  });

  it('fails closed instead of thrashing when operators rotate config without bumping revision', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const first = new KubernetesSandboxBackend(
      sandboxEnv({ SANDBOX_CONFIGURATION_REVISION: 7, SANDBOX_IMAGE: SANDBOX_IMAGE_A }),
      runtimeDb(),
      { api, signer },
    );
    const conflicting = new KubernetesSandboxBackend(
      sandboxEnv({ SANDBOX_CONFIGURATION_REVISION: 7, SANDBOX_IMAGE: SANDBOX_IMAGE_B }),
      runtimeDb(),
      { api, signer },
    );
    try {
      await first.describe(context(1));
      const uid = [...api.pods.values()][0]?.metadata?.uid;
      await expect(conflicting.describe(context(1))).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect([...api.pods.values()][0]?.metadata?.uid).toBe(uid);
      expect(api.deletes).toHaveLength(0);
    } finally {
      await first.dispose();
      await conflicting.dispose();
    }
  });

  it('replaces a late Pod signed by the old key during a two-replica key rotation', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const newerSigner: SandboxCapabilitySigner = {
      sign: async () => 'new-signed',
      publicKeyBase64: () => 'new-public-spki',
    };
    const olderSigner: SandboxCapabilitySigner = {
      sign: async () => 'old-signed',
      publicKeyBase64: () => 'old-public-spki',
    };
    const newer = new KubernetesSandboxBackend(
      sandboxEnv({ SANDBOX_CONFIGURATION_REVISION: 2 }),
      runtimeDb(),
      {
        api,
        signer: newerSigner,
      },
    );
    const older = new KubernetesSandboxBackend(
      sandboxEnv({ SANDBOX_CONFIGURATION_REVISION: 1 }),
      runtimeDb(),
      {
        api,
        signer: olderSigner,
      },
    );
    try {
      await older.describe(context(1));
      const oldUid = [...api.pods.values()][0]?.metadata?.uid;
      await newer.describe(context(1));
      const replacement = [...api.pods.values()][0]!;
      expect(replacement.metadata?.uid).not.toBe(oldUid);
      expect(
        replacement.spec?.containers[0]?.env?.find(
          (entry) => entry.name === 'SANDBOX_CAPABILITY_PUBLIC_KEY',
        )?.value,
      ).toBe('new-public-spki');
    } finally {
      await newer.dispose();
      await older.dispose();
    }
  });

  it('accepts Kubernetes-omitted false host namespace fields without weakening the boundary', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await backend.describe(context(1));
      const pod = [...api.pods.values()][0]!;
      const uid = pod.metadata?.uid;
      delete pod.spec!.hostIPC;
      delete pod.spec!.hostNetwork;
      delete pod.spec!.hostPID;
      await backend.describe(context(1));
      expect([...api.pods.values()][0]?.metadata?.uid).toBe(uid);
    } finally {
      await backend.dispose();
    }
  });

  it('accepts Kubernetes-defaulted probe fields by semantic value instead of JSON field order', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await backend.describe(context(1));
      const pod = [...api.pods.values()][0]!;
      expect(pod.spec?.containers[0]?.startupProbe?.successThreshold).toBe(1);
      const uid = pod.metadata?.uid;
      await backend.describe(context(1));
      expect([...api.pods.values()][0]?.metadata?.uid).toBe(uid);
      expect(api.deletes).toHaveLength(0);
    } finally {
      await backend.dispose();
    }
  });

  it('does not trust a matching fingerprint when the live Pod security boundary was mutated', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await backend.describe(context(1));
      const oldPod = [...api.pods.values()][0]!;
      const oldUid = oldPod.metadata?.uid;
      oldPod.spec!.hostNetwork = true;
      await backend.describe(context(1));
      const replacement = [...api.pods.values()][0]!;
      expect(replacement.metadata?.uid).not.toBe(oldUid);
      expect(replacement.spec?.hostNetwork).toBe(false);
      const replacementUid = replacement.metadata?.uid;
      replacement.spec!.containers[0]!.command = ['/bin/bash'];
      await backend.describe(context(1));
      expect([...api.pods.values()][0]?.metadata?.uid).not.toBe(replacementUid);
    } finally {
      await backend.dispose();
    }
  });

  it('rejects loopback Pod IPs instead of constructing a sandbox client URL', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await backend.describe(context(1));
      [...api.pods.values()][0]!.status!.podIP = '127.0.0.1';
      await expect(backend.describe(context(1))).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      await backend.dispose();
    }
  });

  it('reaps an idle Pod only after confirming that no Turn is running', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const now = Date.now();
    const env = sandboxEnv();
    const backend = new KubernetesSandboxBackend(
      env,
      runtimeDb({
        sessionUpdatedAt: new Date(now - env.SANDBOX_IDLE_TTL_MS - 1),
        runningTurn: false,
        authorizationRunningTurn: true,
      }),
      { api, signer, now: () => now },
    );
    try {
      await backend.describe(context(1));
      expect(api.pods.size).toBe(1);
      await backend.reap();
      expect(api.pods.size).toBe(0);
    } finally {
      await backend.dispose();
    }
  });

  it('enforces the absolute Pod lifetime even when the Session is recent and a Turn is running', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const now = Date.now();
    const env = sandboxEnv();
    const backend = new KubernetesSandboxBackend(env, runtimeDb(), {
      api,
      signer,
      now: () => now,
    });
    try {
      await backend.describe(context(1));
      const pod = [...api.pods.values()][0]!;
      pod.metadata!.creationTimestamp = new Date(now - env.SANDBOX_ABSOLUTE_TTL_MS - 1);
      await backend.reap();
      expect(api.pods.size).toBe(0);
    } finally {
      await backend.dispose();
    }
  });

  it('cleans a same-Session Pod when CREATE succeeded but its response failed', async () => {
    const api = new FakePodApi();
    const create = api.createNamespacedPod.bind(api);
    api.createNamespacedPod = async (input) => {
      await create(input);
      throw new Error('create response lost');
    };
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await expect(backend.describe(context(1))).rejects.toMatchObject({
        code: 'unavailable',
      });
      await vi.waitFor(() => expect(api.pods.size).toBe(0));
      expect(api.deletes).toHaveLength(1);
    } finally {
      await backend.dispose();
    }
  });

  it('tracks and deletes a CREATE that commits after the local request timeout', async () => {
    const api = new FakePodApi();
    const create = api.createNamespacedPod.bind(api);
    api.createNamespacedPod = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return create(input);
    };
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), {
      api,
      signer,
      apiRequestTimeoutMs: 10,
    });
    try {
      await expect(backend.describe(context(1))).rejects.toMatchObject({ code: 'unavailable' });
      await vi.waitFor(() => expect(api.deletes).toHaveLength(1), { timeout: 1_000 });
      expect(api.pods.size).toBe(0);
    } finally {
      await backend.dispose();
    }
  });

  it('does not delete a newer-revision winner while reconciling a lost CREATE response', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const newer = new KubernetesSandboxBackend(
      sandboxEnv({ SANDBOX_CONFIGURATION_REVISION: 2 }),
      runtimeDb(),
      { api, signer },
    );
    const older = new KubernetesSandboxBackend(
      sandboxEnv({ SANDBOX_CONFIGURATION_REVISION: 1 }),
      runtimeDb(),
      { api, signer },
    );
    const create = api.createNamespacedPod.bind(api);
    let interceptOldCreate = true;
    api.createNamespacedPod = async (input) => {
      const created = await create(input);
      if (interceptOldCreate) {
        interceptOldCreate = false;
        await newer.describe(context(1));
        throw new Error('old create response lost after replacement');
      }
      return created;
    };
    try {
      await expect(older.describe(context(1))).rejects.toMatchObject({ code: 'unavailable' });
      const winner = [...api.pods.values()][0]!;
      expect(winner.metadata?.annotations?.['sandbox.combo.dev/config-revision']).toBe('2');
      expect(api.pods.size).toBe(1);
    } finally {
      await newer.dispose();
      await older.dispose();
    }
  });

  it.each(['read', 'create', 'list'] as const)(
    'hard-times-out a black-holed Kubernetes %s call even when the API ignores AbortSignal',
    async (operation) => {
      const api = new FakePodApi();
      if (operation === 'read') {
        api.readNamespacedPod = async () => new Promise<V1Pod>(() => undefined);
      } else if (operation === 'create') {
        api.createNamespacedPod = async () => new Promise<V1Pod>(() => undefined);
      } else {
        api.listNamespacedPod = async () => new Promise<V1PodList>(() => undefined);
      }
      const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), {
        api,
        signer,
        apiRequestTimeoutMs: 25,
      });
      const started = Date.now();
      try {
        if (operation === 'list') {
          await backend.reap();
        } else {
          await expect(backend.describe(context(1))).rejects.toMatchObject({
            code: 'unavailable',
          });
        }
        expect(Date.now() - started).toBeLessThan(1_000);
      } finally {
        await backend.dispose();
      }
    },
  );

  it('aborts and waits for a Pod allocation that is still in flight during shutdown', async () => {
    const api = new FakePodApi();
    let createStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    api.createNamespacedPod = async () => {
      createStarted();
      // Deliberately ignore AbortSignal. The backend's hard deadline must settle
      // independently of a client or transport implementation that never does.
      return new Promise<V1Pod>(() => undefined);
    };
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), {
      api,
      signer,
      apiRequestTimeoutMs: 100,
    });
    const allocation = backend.describe(context(1)).catch((error: unknown) => error);
    await started;
    await backend.dispose();
    await expect(allocation).resolves.toMatchObject({ code: 'aborted' });
  });

  it('cancels this replica active command during shutdown without deleting reusable idle Pods', async () => {
    const api = new FakePodApi();
    let markStarted!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let cancelCalls = 0;
    let commandId = '';
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/describe')) return describeResponse(init);
      if (String(url).endsWith('/v1/commands')) {
        const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
          commandId: string;
        };
        commandId = body.commandId;
        markStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      if (String(url).endsWith('/cancel')) {
        cancelCalls += 1;
        return new Response(JSON.stringify({ cancelled: true }));
      }
      throw new Error('unexpected sandbox URL');
    });
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), {
      api,
      signer,
      clientFactory: (options) =>
        new SandboxClient({ ...options, fetch: fetch as typeof globalThis.fetch }),
    });
    const running = backend.command(context(1), { command: 'sleep 30' }, () => undefined);
    const outcome = running.catch((error: unknown) => error);
    await commandStarted;
    await backend.dispose();
    expect(cancelCalls).toBe(1);
    expect(api.pods.size).toBe(1);
    expect(await outcome).toMatchObject({ code: 'aborted' });
    expect(commandId).not.toBe('');
  });

  it('surfaces cleanup_unconfirmed when command failure and UID recycle both fail', async () => {
    const api = new FakePodApi();
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), {
      api,
      signer,
      clientFactory: (options) =>
        ({
          describe: async () => ({
            protocolVersion: '1',
            sessionId: options.sessionId,
            podUid: options.podUid,
            workspace: '/workspace',
            commandOutputEncoding: 'base64',
            operations: ['describe', 'read', 'write', 'edit', 'command', 'cancel'],
            limits: {
              maxRequestBytes: 1,
              maxReadBytes: 1,
              maxFileBytes: 1,
              maxOutputBytes: 1,
              maxOutputFrames: 1,
              maxFrameBytes: 1,
              commandTimeoutMs: 1,
              maxCommandTimeMs: 1,
            },
          }),
          command: async () => {
            throw new Error('protocol failed');
          },
        }) as unknown as SandboxClient,
    });
    try {
      await backend.describe(context(1));
      api.deleteNamespacedPod = async () => {
        throw Object.assign(new Error('control plane conflict'), { code: 409 });
      };
      await expect(
        backend.command(context(1), { command: 'sleep 30' }, () => undefined),
      ).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
      expect(api.pods.size).toBe(1);
    } finally {
      await backend.dispose();
    }
  });

  it('falls back to deleting and observing the exact Pod UID when authenticated cancel fails', async () => {
    const api = new FakePodApi();
    let markStarted!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/describe')) return describeResponse(init);
      if (String(url).endsWith('/v1/commands')) {
        markStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      if (String(url).endsWith('/cancel')) throw new Error('cancel transport failed');
      throw new Error('unexpected sandbox URL');
    });
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), {
      api,
      signer,
      clientFactory: (options) =>
        new SandboxClient({ ...options, fetch: fetch as typeof globalThis.fetch }),
    });
    const outcome = backend
      .command(context(1), { command: 'sleep 30' }, () => undefined)
      .catch((error: unknown) => error);
    await commandStarted;
    const pod = [...api.pods.values()][0]!;
    await backend.interruptSession('session-1');
    expect(await outcome).toMatchObject({ code: 'aborted' });
    expect(api.pods.size).toBe(0);
    expect(api.deletes.at(-1)?.body?.preconditions?.uid).toBe(pod.metadata?.uid);
    await backend.dispose();
  });

  it('retries a delete conflict when the same Pod UID only changed resourceVersion', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await backend.describe(context(1));
      const originalDelete = api.deleteNamespacedPod.bind(api);
      let attempts = 0;
      api.deleteNamespacedPod = async (input) => {
        attempts += 1;
        if (attempts === 1) {
          const pod = api.pods.get(input.name)!;
          pod.metadata!.resourceVersion = 'new-resource-version';
          throw Object.assign(new Error('resource version conflict'), { code: 409 });
        }
        return originalDelete(input);
      };
      await backend.releaseSession('session-1');
      expect(attempts).toBe(2);
      expect(api.pods.size).toBe(0);
    } finally {
      await backend.dispose();
    }
  });

  it('stops retrying a delete conflict when the fixed name now has a different UID', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await backend.describe(context(1));
      const original = [...api.pods.values()][0]!;
      let attempts = 0;
      api.deleteNamespacedPod = async (input) => {
        attempts += 1;
        const replacement = structuredClone(original);
        replacement.metadata!.uid = 'replacement-uid';
        replacement.metadata!.resourceVersion = 'replacement-rv';
        api.pods.set(input.name, replacement);
        throw Object.assign(new Error('uid precondition conflict'), { code: 409 });
      };
      await expect(backend.releaseSession('session-1')).rejects.toMatchObject({
        code: 'cleanup_unconfirmed',
      });
      expect(attempts).toBe(1);
      expect(api.pods.get('combo-sandbox-slot-0')?.metadata?.uid).toBe('replacement-uid');
    } finally {
      await backend.dispose();
    }
  });

  it('keeps the PVC quarantined if the fixed name gets a new UID before release', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await backend.describe(context(1));
      const originalPatch = api.patchNamespacedPod.bind(api);
      api.patchNamespacedPod = async (input) => {
        const previous = structuredClone(api.pods.get(input.name)!);
        const response = await originalPatch(input);
        const removesFinalizer = (input.body as Array<{ op: string; path: string }>).some(
          (operation) =>
            operation.op === 'remove' && operation.path.startsWith('/metadata/finalizers/'),
        );
        if (removesFinalizer) {
          previous.metadata = {
            ...previous.metadata,
            uid: 'replacement-after-finalizer',
            resourceVersion: 'replacement-after-finalizer-rv',
            deletionTimestamp: undefined,
          };
          previous.status = {
            ...previous.status,
            phase: 'Running',
            conditions: [{ type: 'Ready', status: 'True' }],
            containerStatuses: (previous.spec?.containers ?? []).map((container) => ({
              name: container.name,
              image: container.image ?? '',
              imageID: 'replacement-image',
              ready: true,
              restartCount: 0,
              state: { running: { startedAt: new Date() } },
            })),
          };
          api.pods.set(input.name, previous);
        }
        return response;
      };

      await expect(backend.releaseSession('session-1')).rejects.toMatchObject({
        code: 'cleanup_unconfirmed',
      });
      expect(api.claims.get('combo-sandbox-workspace-slot-0')?.metadata?.annotations).toMatchObject(
        { 'sandbox.combo.dev/slot-state': 'quarantined' },
      );
    } finally {
      await backend.dispose();
    }
  });

  it('propagates a persistent same-UID delete conflict instead of reporting false success', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await backend.describe(context(1));
      api.deleteNamespacedPod = async () => {
        throw Object.assign(new Error('persistent conflict'), { code: 409 });
      };
      await expect(backend.releaseSession('session-1')).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect(api.pods.size).toBe(1);
    } finally {
      await backend.dispose();
    }
  });

  it('cancels a black-holed Kubernetes delete and releases the Session transaction lock', async () => {
    const api = new FakePodApi();
    const transactionLog: string[] = [];
    const now = Date.now();
    const env = sandboxEnv();
    const db = runtimeDb({
      sessionUpdatedAt: new Date(now - env.SANDBOX_IDLE_TTL_MS - 1),
      runningTurn: false,
      authorizationRunningTurn: true,
      transactionLog,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(env, db, {
      api,
      signer,
      now: () => now,
      apiRequestTimeoutMs: 25,
    });
    try {
      await backend.describe(context(1));
      api.deleteNamespacedPod = async () =>
        // A black-holed transport may ignore AbortSignal. apiCall still has to
        // reject on its own deadline so the transaction releases its row lock.
        new Promise<V1Pod | V1Status>(() => undefined);
      const started = Date.now();
      await backend.reap();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(transactionLog).toContain('ROLLBACK');
    } finally {
      await backend.dispose();
    }
  });

  it('keeps the PVC durably quarantined when a force deletion removes the Pod before node proof', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), {
      api,
      signer,
      apiRequestTimeoutMs: 50,
    });
    try {
      await backend.describe(context(1));
      api.deleteNamespacedPod = async (input) => {
        const pod = api.pods.get(input.name);
        if (!pod) throw Object.assign(new Error('not found'), { code: 404 });
        api.pods.delete(input.name);
        return structuredClone(pod);
      };

      await expect(backend.releaseSession('session-1')).rejects.toMatchObject({
        code: 'cleanup_unconfirmed',
      });
      expect(api.claims.get('combo-sandbox-workspace-slot-0')?.metadata?.annotations).toMatchObject(
        {
          'sandbox.combo.dev/slot-state': 'quarantined',
          'sandbox.combo.dev/session-id': 'session-1',
        },
      );

      await backend.describe(context(2));
      expect(api.pods.has('combo-sandbox-slot-0')).toBe(false);
      expect(api.pods.get('combo-sandbox-slot-1')?.metadata?.annotations).toMatchObject({
        'sandbox.combo.dev/session-id': 'session-2',
      });
    } finally {
      await backend.dispose();
    }
  });

  it('quarantines a Local-PV slot when the API accepts deletion but the node never reports termination', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), {
      api,
      signer,
      apiRequestTimeoutMs: 25,
    });
    try {
      await backend.describe(context(1));
      api.deleteNamespacedPod = async (input) => {
        const pod = api.pods.get(input.name)!;
        pod.metadata!.deletionTimestamp = new Date();
        return structuredClone(pod);
      };
      await expect(backend.releaseSession('session-1')).rejects.toBeInstanceOf(Error);
      const quarantined = api.pods.get('combo-sandbox-slot-0');
      expect(quarantined?.metadata?.deletionTimestamp).toBeTruthy();
      expect(quarantined?.metadata?.finalizers).toContain(
        'sandbox.combo.dev/await-node-termination',
      );
    } finally {
      await backend.dispose();
    }
  });

  it('deletes and observes the Session Pod when an interrupt lands on a replica without the command id', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => describeResponse(init)),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await backend.describe(context(1));
      const pod = [...api.pods.values()][0]!;
      const identity = {
        uid: pod.metadata?.uid,
        resourceVersion: pod.metadata?.resourceVersion,
      };
      await backend.interruptSession('session-1');
      expect(api.pods.size).toBe(0);
      expect(api.deletes[0]?.body?.preconditions).toMatchObject(identity);
    } finally {
      await backend.dispose();
    }
  });

  it('deletes an archived Session Pod with UID and resourceVersion preconditions', async () => {
    const api = new FakePodApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            protocolVersion: '1',
            sessionId: headers.get('X-Sandbox-Session-Id'),
            podUid: headers.get('X-Sandbox-Pod-Uid'),
            workspace: '/workspace',
            commandOutputEncoding: 'base64',
            operations: ['describe', 'read', 'write', 'edit', 'command', 'cancel'],
            limits: {
              maxRequestBytes: 1,
              maxReadBytes: 1,
              maxFileBytes: 1,
              maxOutputBytes: 1,
              maxOutputFrames: 1,
              maxFrameBytes: 1,
              commandTimeoutMs: 1,
              maxCommandTimeMs: 1,
            },
          }),
        );
      }),
    );
    const backend = new KubernetesSandboxBackend(sandboxEnv(), runtimeDb(), { api, signer });
    try {
      await backend.describe(context(1));
      const pod = [...api.pods.values()][0]!;
      const identity = {
        name: pod.metadata?.name,
        uid: pod.metadata?.uid,
        resourceVersion: pod.metadata?.resourceVersion,
      };
      await backend.releaseSession('session-1');
      expect(api.pods.size).toBe(0);
      expect(api.deletes[0]).toMatchObject({
        name: identity.name,
        body: {
          gracePeriodSeconds: 2,
          preconditions: {
            uid: identity.uid,
            resourceVersion: identity.resourceVersion,
          },
        },
      });
    } finally {
      await backend.dispose();
    }
  });
});
