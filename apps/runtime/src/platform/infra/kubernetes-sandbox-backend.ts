import { createHash, randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import {
  CoreV1Api,
  IsomorphicFetchHttpLibrary,
  KubeConfig,
  type HttpLibrary,
  type RequestContext,
  type V1DeleteOptions,
  type V1PersistentVolumeClaim,
  type V1Pod,
  type V1PodList,
  type V1Probe,
  type V1Status,
} from '@kubernetes/client-node';
import type { Env } from '../config/env.js';
import { withTransaction, type Queryable, type RuntimeDb } from './db.js';
import {
  type SandboxBackend,
  SandboxBackendError,
  type SandboxCommandFrame,
  type SandboxCommandInput,
  type SandboxCommandResult,
  type SandboxDescribeResult,
  type SandboxEditInput,
  type SandboxEditResult,
  type SandboxReadInput,
  type SandboxReadResult,
  type SandboxTurnContext,
  type SandboxWriteInput,
  type SandboxWriteResult,
} from './sandbox-backend.js';
import {
  createSandboxCapabilitySigner,
  SANDBOX_CAPABILITY_AUDIENCE,
  SANDBOX_CAPABILITY_ISSUER,
  type SandboxCapabilitySigner,
} from './sandbox-capability.js';
import { SandboxClient, type SandboxClientOptions } from './sandbox-client.js';

const APP_LABEL = 'combo-sandboxd';
const MANAGED_BY_LABEL = 'combo-runtime';
const SESSION_ANNOTATION = 'sandbox.combo.dev/session-id';
const CONFIG_ANNOTATION = 'sandbox.combo.dev/config-fingerprint';
const CONFIG_REVISION_ANNOTATION = 'sandbox.combo.dev/config-revision';
const ALLOCATION_ANNOTATION = 'sandbox.combo.dev/allocation-id';
const SLOT_STATE_ANNOTATION = 'sandbox.combo.dev/slot-state';
const SLOT_POD_UID_ANNOTATION = 'sandbox.combo.dev/pod-uid';
const SLOT_FINALIZER = 'sandbox.combo.dev/await-node-termination';
const SLOT_LABEL = 'sandbox.combo.dev/slot';
const SLOT_AVAILABLE = 'available';
const SLOT_RESERVED = 'reserved';
const SLOT_ACTIVE = 'active';
const SLOT_QUARANTINED = 'quarantined';
const SANDBOX_PORT = 8080;
const MAX_SANDBOX_SLOTS = 5;
const SANDBOX_CPU_REQUEST = '100m';
const SANDBOX_CPU_LIMIT = '500m';
const SANDBOX_MEMORY_REQUEST = '384Mi';
const SANDBOX_MEMORY_LIMIT = '384Mi';
const SANDBOX_EPHEMERAL_STORAGE = '128Mi';
const SANDBOX_TMP_SIZE = '256Mi';
const SANDBOX_WORKSPACE_CLAIM_PREFIX = 'combo-sandbox-workspace-slot-';
const WORKSPACE_WIPE_COMMAND = '/usr/local/bin/wipe-workspace';
const DEFAULT_KUBERNETES_REQUEST_TIMEOUT_MS = 5_000;
const POD_DELETE_GRACE_SECONDS = 2;
const DELETE_CONFLICT_RETRIES = 3;

const unsafePodAddresses = new BlockList();
unsafePodAddresses.addSubnet('0.0.0.0', 8, 'ipv4');
unsafePodAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
unsafePodAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
unsafePodAddresses.addSubnet('224.0.0.0', 4, 'ipv4');
unsafePodAddresses.addAddress('::', 'ipv6');
unsafePodAddresses.addAddress('::1', 'ipv6');
unsafePodAddresses.addSubnet('fe80::', 10, 'ipv6');
unsafePodAddresses.addSubnet('ff00::', 8, 'ipv6');

export interface SandboxLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export type SandboxClientFactory = (options: SandboxClientOptions) => SandboxClient;

export interface KubernetesSandboxBackendOptions {
  api?: SandboxPodApi;
  log?: SandboxLogger;
  signer?: SandboxCapabilitySigner;
  clientFactory?: SandboxClientFactory;
  now?: () => number;
  apiRequestTimeoutMs?: number;
}

const quietLogger: SandboxLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface SandboxPodApi {
  readNamespacedPersistentVolumeClaim(input: {
    name: string;
    namespace: string;
    signal?: AbortSignal;
  }): Promise<V1PersistentVolumeClaim>;
  patchNamespacedPersistentVolumeClaim(input: {
    name: string;
    namespace: string;
    body: unknown;
    signal?: AbortSignal;
  }): Promise<V1PersistentVolumeClaim>;
  readNamespacedPod(input: {
    name: string;
    namespace: string;
    signal?: AbortSignal;
  }): Promise<V1Pod>;
  createNamespacedPod(input: {
    namespace: string;
    body: V1Pod;
    signal?: AbortSignal;
  }): Promise<V1Pod>;
  deleteNamespacedPod(input: {
    name: string;
    namespace: string;
    gracePeriodSeconds?: number;
    body?: V1DeleteOptions;
    signal?: AbortSignal;
  }): Promise<V1Pod | V1Status>;
  patchNamespacedPod(input: {
    name: string;
    namespace: string;
    body: unknown;
    signal?: AbortSignal;
  }): Promise<V1Pod>;
  listNamespacedPod(input: {
    namespace: string;
    labelSelector?: string;
    signal?: AbortSignal;
  }): Promise<V1PodList>;
}

interface SlotClaim {
  claim: V1PersistentVolumeClaim;
  slot: number;
  state:
    | typeof SLOT_AVAILABLE
    | typeof SLOT_RESERVED
    | typeof SLOT_ACTIVE
    | typeof SLOT_QUARANTINED;
  sessionId?: string;
  allocationId?: string;
  podUid?: string;
}

interface PodHandle {
  pod: V1Pod;
  name: string;
  uid: string;
  ip: string;
  client: SandboxClient;
}

interface ActiveCommand {
  commandId: string;
  podName: string;
  podUid: string;
  abort: () => void;
  completion: Promise<SandboxCommandResult>;
}

function apiStatus(error: unknown): number | undefined {
  const value = error as {
    code?: unknown;
    statusCode?: unknown;
    response?: { statusCode?: unknown };
  };
  if (typeof value.code === 'number') return value.code;
  if (typeof value.statusCode === 'number') return value.statusCode;
  if (typeof value.response?.statusCode === 'number') return value.response.statusCode;
  return undefined;
}

function isPatchConflict(error: unknown): boolean {
  const status = apiStatus(error);
  return status === 409 || status === 422;
}

function isReady(pod: V1Pod): boolean {
  return (
    pod.metadata?.deletionTimestamp === undefined &&
    pod.status?.phase === 'Running' &&
    pod.status.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    ) === true &&
    typeof pod.status.podIP === 'string' &&
    pod.status.podIP.length > 0
  );
}

function isTerminal(pod: V1Pod): boolean {
  return pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded';
}

function nodeConfirmedContainersTerminated(pod: V1Pod): boolean {
  const mainNames = new Set(pod.spec?.containers.map((container) => container.name) ?? []);
  const initNames = new Set(pod.spec?.initContainers?.map((container) => container.name) ?? []);
  const mainStatuses = pod.status?.containerStatuses ?? [];
  const initStatuses = pod.status?.initContainerStatuses ?? [];
  return (
    mainNames.size > 0 &&
    mainStatuses.length === mainNames.size &&
    initStatuses.length === initNames.size &&
    mainStatuses.every(
      (status) => mainNames.has(status.name) && status.state?.terminated !== undefined,
    ) &&
    initStatuses.every(
      (status) => initNames.has(status.name) && status.state?.terminated !== undefined,
    )
  );
}

function podSession(pod: V1Pod): string | undefined {
  return pod.metadata?.annotations?.[SESSION_ANNOTATION];
}

function podFingerprint(pod: V1Pod): string | undefined {
  return pod.metadata?.annotations?.[CONFIG_ANNOTATION];
}

function podAllocationId(pod: V1Pod): string | undefined {
  return pod.metadata?.annotations?.[ALLOCATION_ANNOTATION];
}

function normalizeProbe(probe: V1Probe | undefined): V1Probe | undefined {
  if (!probe) return undefined;
  return {
    ...probe,
    initialDelaySeconds: probe.initialDelaySeconds ?? 0,
    timeoutSeconds: probe.timeoutSeconds ?? 1,
    periodSeconds: probe.periodSeconds ?? 10,
    successThreshold: probe.successThreshold ?? 1,
    failureThreshold: probe.failureThreshold ?? 3,
    ...(probe.httpGet
      ? { httpGet: { ...probe.httpGet, scheme: probe.httpGet.scheme ?? 'HTTP' } }
      : {}),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function semanticEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function podConfigurationRevision(pod: V1Pod): number {
  const raw = pod.metadata?.annotations?.[CONFIG_REVISION_ANNOTATION];
  if (!raw || !/^[1-9]\d*$/.test(raw)) return 0;
  const revision = Number(raw);
  return Number.isSafeInteger(revision) ? revision : 0;
}

function podIdentity(pod: V1Pod): { name: string; uid: string } | null {
  const name = pod.metadata?.name;
  const uid = pod.metadata?.uid;
  return name && uid ? { name, uid } : null;
}

function slotClaimName(slot: number): string {
  return `${SANDBOX_WORKSPACE_CLAIM_PREFIX}${slot}`;
}

function annotationPath(name: string): string {
  return `/metadata/annotations/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function managedClaim(claim: V1PersistentVolumeClaim, namespace: string): SlotClaim | null {
  const name = claim.metadata?.name ?? '';
  const match = /^combo-sandbox-workspace-slot-(\d+)$/.exec(name);
  if (!match || claim.metadata?.namespace !== namespace) return null;
  const slot = Number(match[1]);
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= MAX_SANDBOX_SLOTS) return null;
  const labels = claim.metadata?.labels;
  const annotations = claim.metadata?.annotations;
  const storedState = annotations?.[SLOT_STATE_ANNOTATION];
  const state = storedState ?? SLOT_AVAILABLE;
  if (
    labels?.['app.kubernetes.io/part-of'] !== 'combo' ||
    labels['app.kubernetes.io/component'] !== 'model-sandbox-workspace' ||
    labels[SLOT_LABEL] !== String(slot) ||
    claim.spec?.volumeName !== name ||
    claim.spec.storageClassName !== 'combo-sandbox-loopback' ||
    claim.spec.volumeMode !== 'Filesystem' ||
    !semanticEqual(claim.spec.accessModes, ['ReadWriteOnce']) ||
    claim.spec.resources?.requests?.storage !== '1Gi' ||
    ![SLOT_AVAILABLE, SLOT_RESERVED, SLOT_ACTIVE, SLOT_QUARANTINED].includes(state)
  ) {
    return null;
  }
  const sessionId = annotations?.[SESSION_ANNOTATION];
  const allocationId = annotations?.[ALLOCATION_ANNOTATION];
  const podUid = annotations?.[SLOT_POD_UID_ANNOTATION];
  if (state === SLOT_AVAILABLE && (sessionId || allocationId || podUid)) return null;
  if (state !== SLOT_AVAILABLE && (!sessionId || !allocationId)) return null;
  if ((state === SLOT_ACTIVE || state === SLOT_QUARANTINED) && !podUid) return null;
  return {
    claim,
    slot,
    state: state as SlotClaim['state'],
    ...(sessionId ? { sessionId } : {}),
    ...(allocationId ? { allocationId } : {}),
    ...(podUid ? { podUid } : {}),
  };
}

function claimMatchesPod(claim: SlotClaim, pod: V1Pod): boolean {
  return (
    claim.slot === managedPodSlot(pod) &&
    claim.sessionId === podSession(pod) &&
    claim.allocationId === podAllocationId(pod) &&
    (claim.podUid === undefined || claim.podUid === pod.metadata?.uid)
  );
}

function managedPodSlot(pod: V1Pod): number | null {
  const name = pod.metadata?.name ?? '';
  const match = /^combo-sandbox-slot-(\d+)$/.exec(name);
  if (!match) return null;
  const slot = Number(match[1]);
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= MAX_SANDBOX_SLOTS) return null;
  const labels = pod.metadata?.labels;
  if (
    labels?.app !== APP_LABEL ||
    labels['app.kubernetes.io/name'] !== 'sandboxd' ||
    labels['app.kubernetes.io/instance'] !== name ||
    labels['app.kubernetes.io/component'] !== 'model-sandbox' ||
    labels['app.kubernetes.io/part-of'] !== 'combo' ||
    labels['app.kubernetes.io/managed-by'] !== MANAGED_BY_LABEL ||
    labels[SLOT_LABEL] !== String(slot)
  ) {
    return null;
  }
  return slot;
}

function safePodIp(value: string): boolean {
  const family = isIP(value);
  if (family === 4) return !unsafePodAddresses.check(value, 'ipv4');
  if (family === 6) {
    if (value.toLowerCase().startsWith('::ffff:')) return false;
    return !unsafePodAddresses.check(value, 'ipv6');
  }
  return false;
}

function podMatchesConfiguration(
  pod: V1Pod,
  env: Env,
  publicKey: string,
  expectedFingerprint: string,
): boolean {
  const slot = managedPodSlot(pod);
  const sessionId = podSession(pod);
  const allocationId = podAllocationId(pod);
  if (
    slot === null ||
    !sessionId ||
    !allocationId ||
    podFingerprint(pod) !== expectedFingerprint ||
    podConfigurationRevision(pod) !== env.SANDBOX_CONFIGURATION_REVISION
  ) {
    return false;
  }
  const expected = buildSandboxPod({
    env,
    slot,
    sessionId,
    publicKey,
    fingerprint: expectedFingerprint,
    allocationId,
  });
  const actualSpec = pod.spec;
  const expectedSpec = expected.spec;
  const actualContainer = actualSpec?.containers[0];
  const expectedContainer = expectedSpec?.containers[0];
  const actualInit = actualSpec?.initContainers?.[0];
  const expectedInit = expectedSpec?.initContainers?.[0];
  return (
    actualSpec !== undefined &&
    expectedSpec !== undefined &&
    pod.metadata?.finalizers?.includes(SLOT_FINALIZER) === true &&
    actualSpec.containers.length === 1 &&
    actualSpec.initContainers?.length === 1 &&
    actualSpec.runtimeClassName === expectedSpec.runtimeClassName &&
    actualSpec.automountServiceAccountToken === false &&
    actualSpec.enableServiceLinks === false &&
    actualSpec.hostIPC !== true &&
    actualSpec.hostNetwork !== true &&
    actualSpec.hostPID !== true &&
    actualSpec.shareProcessNamespace !== true &&
    actualSpec.restartPolicy === 'Never' &&
    actualSpec.activeDeadlineSeconds === expectedSpec.activeDeadlineSeconds &&
    actualSpec.terminationGracePeriodSeconds === expectedSpec.terminationGracePeriodSeconds &&
    semanticEqual(actualSpec.imagePullSecrets, expectedSpec.imagePullSecrets) &&
    semanticEqual(actualSpec.securityContext, expectedSpec.securityContext) &&
    semanticEqual(actualSpec.volumes, expectedSpec.volumes) &&
    semanticEqual(actualContainer?.securityContext, expectedContainer?.securityContext) &&
    semanticEqual(actualContainer?.resources, expectedContainer?.resources) &&
    actualContainer?.name === expectedContainer?.name &&
    actualContainer?.imagePullPolicy === expectedContainer?.imagePullPolicy &&
    actualContainer?.workingDir === expectedContainer?.workingDir &&
    actualContainer?.terminationMessagePath === expectedContainer?.terminationMessagePath &&
    actualContainer?.terminationMessagePolicy === expectedContainer?.terminationMessagePolicy &&
    semanticEqual(actualContainer?.command, expectedContainer?.command) &&
    semanticEqual(actualContainer?.args, expectedContainer?.args) &&
    semanticEqual(actualContainer?.env, expectedContainer?.env) &&
    semanticEqual(actualContainer?.envFrom, expectedContainer?.envFrom) &&
    semanticEqual(actualContainer?.ports, expectedContainer?.ports) &&
    semanticEqual(
      normalizeProbe(actualContainer?.startupProbe),
      normalizeProbe(expectedContainer?.startupProbe),
    ) &&
    semanticEqual(
      normalizeProbe(actualContainer?.readinessProbe),
      normalizeProbe(expectedContainer?.readinessProbe),
    ) &&
    semanticEqual(
      normalizeProbe(actualContainer?.livenessProbe),
      normalizeProbe(expectedContainer?.livenessProbe),
    ) &&
    semanticEqual(actualContainer?.volumeMounts, expectedContainer?.volumeMounts) &&
    semanticEqual(actualContainer?.volumeDevices, expectedContainer?.volumeDevices) &&
    actualContainer?.stdin !== true &&
    actualContainer?.tty !== true &&
    actualContainer?.image === env.SANDBOX_IMAGE &&
    actualInit?.name === expectedInit?.name &&
    actualInit?.imagePullPolicy === expectedInit?.imagePullPolicy &&
    actualInit?.terminationMessagePath === expectedInit?.terminationMessagePath &&
    actualInit?.terminationMessagePolicy === expectedInit?.terminationMessagePolicy &&
    semanticEqual(actualInit?.securityContext, expectedInit?.securityContext) &&
    semanticEqual(actualInit?.resources, expectedInit?.resources) &&
    semanticEqual(actualInit?.volumeMounts, expectedInit?.volumeMounts) &&
    semanticEqual(actualInit?.env, expectedInit?.env) &&
    semanticEqual(actualInit?.envFrom, expectedInit?.envFrom) &&
    semanticEqual(actualInit?.args, expectedInit?.args) &&
    actualInit?.image === env.SANDBOX_IMAGE &&
    semanticEqual(actualInit?.command, expectedInit?.command)
  );
}

function podCreationTime(pod: V1Pod): number | null {
  const value = pod.metadata?.creationTimestamp;
  if (value === undefined || value === null) return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function settleBeforeSignal(promises: Promise<unknown>[], signal: AbortSignal): Promise<void> {
  if (promises.length === 0 || signal.aborted) return Promise.resolve();
  const settled = Promise.allSettled(promises).then(() => undefined);
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    void settled.finally(finish);
  });
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new SandboxBackendError('aborted', '沙箱操作已取消。'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new SandboxBackendError('aborted', '沙箱操作已取消。'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function fingerprint(env: Env, publicKey: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        protocol: '1',
        image: env.SANDBOX_IMAGE,
        publicKey,
        configurationRevision: env.SANDBOX_CONFIGURATION_REVISION,
        capacity: env.SANDBOX_CAPACITY,
        runtimeClass: env.SANDBOX_RUNTIME_CLASS,
        commandTimeoutMs: env.SANDBOX_COMMAND_TIMEOUT_MS,
        cpuRequest: SANDBOX_CPU_REQUEST,
        cpuLimit: SANDBOX_CPU_LIMIT,
        memoryRequest: SANDBOX_MEMORY_REQUEST,
        memoryLimit: SANDBOX_MEMORY_LIMIT,
        ephemeralStorage: SANDBOX_EPHEMERAL_STORAGE,
        tmp: SANDBOX_TMP_SIZE,
        workspace: '1Gi-loopback-local-pvc-v1',
        processLimit: 256,
        activeDeadlineSeconds: Math.floor(env.SANDBOX_ABSOLUTE_TTL_MS / 1_000),
        workspaceWipe: 'v2-root-mode-and-lost-found',
        commandWriteBoundary: 'landlock-abi3-v1',
        slotReuseProof: 'pvc-assignment-pod-finalizer-node-termination-v2',
      }),
    )
    .digest('hex');
}

/** Exported for focused security-spec tests; production still creates Pods lazily. */
export function buildSandboxPod(input: {
  env: Env;
  slot: number;
  sessionId: string;
  publicKey: string;
  fingerprint: string;
  allocationId: string;
}): V1Pod {
  const name = `combo-sandbox-slot-${input.slot}`;
  const uid = 10_000 + input.slot;
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      finalizers: [SLOT_FINALIZER],
      labels: {
        app: APP_LABEL,
        'app.kubernetes.io/name': 'sandboxd',
        'app.kubernetes.io/instance': name,
        'app.kubernetes.io/component': 'model-sandbox',
        'app.kubernetes.io/part-of': 'combo',
        'app.kubernetes.io/managed-by': MANAGED_BY_LABEL,
        [SLOT_LABEL]: String(input.slot),
      },
      annotations: {
        [SESSION_ANNOTATION]: input.sessionId,
        [CONFIG_ANNOTATION]: input.fingerprint,
        [CONFIG_REVISION_ANNOTATION]: String(input.env.SANDBOX_CONFIGURATION_REVISION),
        [ALLOCATION_ANNOTATION]: input.allocationId,
      },
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostIPC: false,
      hostNetwork: false,
      hostPID: false,
      restartPolicy: 'Never',
      activeDeadlineSeconds: Math.floor(input.env.SANDBOX_ABSOLUTE_TTL_MS / 1_000),
      runtimeClassName: input.env.SANDBOX_RUNTIME_CLASS,
      terminationGracePeriodSeconds: 2,
      imagePullSecrets: [{ name: 'ghcr-pull' }],
      securityContext: {
        runAsNonRoot: true,
        runAsUser: uid,
        runAsGroup: uid,
        fsGroup: uid,
        fsGroupChangePolicy: 'OnRootMismatch',
        seccompProfile: { type: 'RuntimeDefault' },
      },
      initContainers: [
        {
          name: 'wipe-workspace',
          image: input.env.SANDBOX_IMAGE,
          imagePullPolicy: 'IfNotPresent',
          command: [WORKSPACE_WIPE_COMMAND],
          terminationMessagePath: '/dev/termination-log',
          terminationMessagePolicy: 'File',
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            runAsUser: uid,
            runAsGroup: uid,
            capabilities: { drop: ['ALL'] },
            seccompProfile: { type: 'RuntimeDefault' },
          },
          resources: {
            requests: {
              cpu: SANDBOX_CPU_REQUEST,
              memory: SANDBOX_MEMORY_REQUEST,
              'ephemeral-storage': SANDBOX_EPHEMERAL_STORAGE,
            },
            limits: {
              cpu: SANDBOX_CPU_LIMIT,
              memory: SANDBOX_MEMORY_LIMIT,
              'ephemeral-storage': SANDBOX_EPHEMERAL_STORAGE,
            },
          },
          volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
        },
      ],
      containers: [
        {
          name: 'sandboxd',
          image: input.env.SANDBOX_IMAGE,
          imagePullPolicy: 'IfNotPresent',
          workingDir: '/workspace',
          terminationMessagePath: '/dev/termination-log',
          terminationMessagePolicy: 'File',
          env: [
            { name: 'SANDBOX_SESSION_ID', value: input.sessionId },
            {
              name: 'SANDBOX_POD_UID',
              valueFrom: { fieldRef: { fieldPath: 'metadata.uid', apiVersion: 'v1' } },
            },
            { name: 'SANDBOX_CAPABILITY_PUBLIC_KEY', value: input.publicKey },
            { name: 'SANDBOX_CAPABILITY_ISSUER', value: SANDBOX_CAPABILITY_ISSUER },
            { name: 'SANDBOX_CAPABILITY_AUDIENCE', value: SANDBOX_CAPABILITY_AUDIENCE },
            {
              name: 'SANDBOX_COMMAND_TIMEOUT_MS',
              value: String(input.env.SANDBOX_COMMAND_TIMEOUT_MS),
            },
          ],
          ports: [{ name: 'http', containerPort: SANDBOX_PORT, protocol: 'TCP' }],
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            runAsUser: uid,
            runAsGroup: uid,
            capabilities: { drop: ['ALL'] },
            seccompProfile: { type: 'RuntimeDefault' },
          },
          resources: {
            requests: {
              cpu: SANDBOX_CPU_REQUEST,
              memory: SANDBOX_MEMORY_REQUEST,
              'ephemeral-storage': SANDBOX_EPHEMERAL_STORAGE,
            },
            limits: {
              cpu: SANDBOX_CPU_LIMIT,
              memory: SANDBOX_MEMORY_LIMIT,
              'ephemeral-storage': SANDBOX_EPHEMERAL_STORAGE,
            },
          },
          volumeMounts: [
            { name: 'workspace', mountPath: '/workspace' },
            { name: 'tmp', mountPath: '/tmp' },
          ],
          startupProbe: {
            httpGet: { path: '/health', port: SANDBOX_PORT, scheme: 'HTTP' },
            periodSeconds: 1,
            timeoutSeconds: 1,
            failureThreshold: 30,
          },
          readinessProbe: {
            httpGet: { path: '/health', port: SANDBOX_PORT, scheme: 'HTTP' },
            periodSeconds: 2,
            timeoutSeconds: 1,
            failureThreshold: 3,
          },
          livenessProbe: {
            httpGet: { path: '/health', port: SANDBOX_PORT, scheme: 'HTTP' },
            periodSeconds: 10,
            timeoutSeconds: 2,
            failureThreshold: 3,
          },
        },
      ],
      volumes: [
        {
          name: 'workspace',
          persistentVolumeClaim: {
            claimName: `${SANDBOX_WORKSPACE_CLAIM_PREFIX}${input.slot}`,
          },
        },
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: SANDBOX_TMP_SIZE } },
      ],
    },
  };
}

class AbortableKubernetesHttp implements HttpLibrary {
  private readonly delegate = new IsomorphicFetchHttpLibrary();

  constructor(private readonly signal: AbortSignal) {}

  send(request: RequestContext) {
    request.setSignal(this.signal);
    return this.delegate.send(request);
  }
}

function apiOptions(signal: AbortSignal): { httpApi: HttpLibrary } {
  return { httpApi: new AbortableKubernetesHttp(signal) };
}

function createPodApi(): SandboxPodApi {
  const kubeConfig = new KubeConfig();
  // This function is called only when SANDBOX_TOOLS_ENABLED=true.
  kubeConfig.loadFromCluster();
  const api = kubeConfig.makeApiClient(CoreV1Api);
  return {
    readNamespacedPersistentVolumeClaim: ({ signal, ...input }) =>
      api.readNamespacedPersistentVolumeClaim(input, signal ? apiOptions(signal) : undefined),
    patchNamespacedPersistentVolumeClaim: ({ signal, ...input }) =>
      api.patchNamespacedPersistentVolumeClaim(input, signal ? apiOptions(signal) : undefined),
    readNamespacedPod: ({ signal, ...input }) =>
      api.readNamespacedPod(input, signal ? apiOptions(signal) : undefined),
    createNamespacedPod: ({ signal, ...input }) =>
      api.createNamespacedPod(input, signal ? apiOptions(signal) : undefined),
    deleteNamespacedPod: ({ signal, ...input }) =>
      api.deleteNamespacedPod(input, signal ? apiOptions(signal) : undefined),
    patchNamespacedPod: ({ signal, ...input }) =>
      api.patchNamespacedPod(input, signal ? apiOptions(signal) : undefined),
    listNamespacedPod: ({ signal, ...input }) =>
      api.listNamespacedPod(input, signal ? apiOptions(signal) : undefined),
  };
}

export class KubernetesSandboxBackend implements SandboxBackend {
  readonly enabled = true;
  private readonly signer: SandboxCapabilitySigner;
  private readonly publicKey: string;
  private readonly configFingerprint: string;
  private readonly allocations = new Map<string, Promise<PodHandle>>();
  private readonly uncertainCreates = new Map<string, Promise<void>>();
  private readonly activeCommands = new Map<string, ActiveCommand>();
  private readonly api: SandboxPodApi;
  private readonly log: SandboxLogger;
  private readonly clientFactory: SandboxClientFactory;
  private readonly now: () => number;
  private readonly apiRequestTimeoutMs: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly shutdown = new AbortController();
  private reapInFlight: Promise<void> | undefined;
  private disposePromise: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly env: Env,
    private readonly db: RuntimeDb,
    options: KubernetesSandboxBackendOptions = {},
  ) {
    // Parse signing material before loading in-cluster credentials so an invalid
    // enabled configuration fails with the stable key error at startup.
    this.signer =
      options.signer ?? createSandboxCapabilitySigner(this.env.SANDBOX_CAPABILITY_PRIVATE_KEY);
    this.publicKey = this.signer.publicKeyBase64();
    this.api = options.api ?? createPodApi();
    this.log = options.log ?? quietLogger;
    this.clientFactory = options.clientFactory ?? ((input) => new SandboxClient(input));
    this.now = options.now ?? Date.now;
    this.apiRequestTimeoutMs = options.apiRequestTimeoutMs ?? DEFAULT_KUBERNETES_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.apiRequestTimeoutMs) || this.apiRequestTimeoutMs <= 0) {
      throw new Error('sandbox Kubernetes request timeout must be positive');
    }
    this.configFingerprint = fingerprint(this.env, this.publicKey);
    this.sweepTimer = setInterval(() => this.scheduleReap(), this.env.SANDBOX_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  private scheduleReap(): void {
    if (this.disposed || this.reapInFlight) return;
    const run = this.reap()
      .catch((error) =>
        this.log.error(
          { error: error instanceof Error ? error.name : 'unknown' },
          'sandbox reap failed',
        ),
      )
      .finally(() => {
        if (this.reapInFlight === run) this.reapInFlight = undefined;
      });
    this.reapInFlight = run;
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new SandboxBackendError('unavailable', '沙箱服务正在关闭，请重试。');
    }
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
  }

  private async authorize(
    context: SandboxTurnContext,
    db: Queryable = this.db,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await db.query<{ turn_id: string }>(
      `SELECT t.id AS turn_id
         FROM sessions s
         JOIN turns t ON t.session_id = s.id
        WHERE s.id = $1
          AND s.owner_user_id = $2
          AND s.status = 'active'
          AND t.id = $3
          AND t.status = 'running'
        FOR KEY SHARE OF s`,
      [context.sessionId, context.ownerUserId, context.turnId],
      signal,
    );
    if (!result.rows[0]) {
      throw new SandboxBackendError('unauthorized', '当前轮次无权访问沙箱。');
    }
  }

  private async apiCall<T>(
    signal: AbortSignal | undefined,
    call: (boundedSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new SandboxBackendError('aborted', '沙箱操作已取消。');
    }
    const timeout = AbortSignal.timeout(this.apiRequestTimeoutMs);
    const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        boundedSignal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => {
        finish(() =>
          reject(
            signal?.aborted
              ? new SandboxBackendError('aborted', '沙箱操作已取消。')
              : new SandboxBackendError('unavailable', 'Kubernetes 控制面请求超时。'),
          ),
        );
      };
      boundedSignal.addEventListener('abort', onAbort, { once: true });
      void Promise.resolve()
        .then(() => call(boundedSignal))
        .then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
    });
  }

  private async readOptionalSlotClaim(
    slot: number,
    signal?: AbortSignal,
  ): Promise<SlotClaim | null> {
    let claim: V1PersistentVolumeClaim;
    try {
      claim = await this.apiCall(signal, (boundedSignal) =>
        this.api.readNamespacedPersistentVolumeClaim({
          name: slotClaimName(slot),
          namespace: this.env.SANDBOX_NAMESPACE,
          signal: boundedSignal,
        }),
      );
    } catch (error) {
      if (apiStatus(error) === 404) return null;
      if (signal?.aborted) {
        throw new SandboxBackendError('aborted', '沙箱操作已取消。');
      }
      throw new SandboxBackendError('unavailable', '无法读取沙箱工作区状态。');
    }
    const parsed = managedClaim(claim, this.env.SANDBOX_NAMESPACE);
    if (
      !parsed ||
      parsed.slot !== slot ||
      !claim.metadata?.uid ||
      !claim.metadata.resourceVersion
    ) {
      throw new SandboxBackendError('unavailable', '沙箱固定工作区身份无效。');
    }
    return parsed;
  }

  private async readSlotClaim(slot: number, signal?: AbortSignal): Promise<SlotClaim> {
    const claim = await this.readOptionalSlotClaim(slot, signal);
    if (!claim) throw new SandboxBackendError('unavailable', '沙箱固定工作区不存在。');
    return claim;
  }

  private async patchSlotClaim(
    current: SlotClaim,
    operations: unknown[],
    signal?: AbortSignal,
  ): Promise<SlotClaim> {
    const patched = await this.apiCall(signal, (boundedSignal) =>
      this.api.patchNamespacedPersistentVolumeClaim({
        name: slotClaimName(current.slot),
        namespace: this.env.SANDBOX_NAMESPACE,
        body: [
          { op: 'test', path: '/metadata/uid', value: current.claim.metadata?.uid },
          {
            op: 'test',
            path: '/metadata/resourceVersion',
            value: current.claim.metadata?.resourceVersion,
          },
          ...operations,
        ],
        signal: boundedSignal,
      }),
    );
    const parsed = managedClaim(patched, this.env.SANDBOX_NAMESPACE);
    if (!parsed || parsed.slot !== current.slot) {
      throw new SandboxBackendError('cleanup_unconfirmed', '沙箱固定工作区状态发生变化。');
    }
    return parsed;
  }

  private async reserveSlot(
    slot: number,
    sessionId: string,
    allocationId: string,
    signal?: AbortSignal,
  ): Promise<{ claim: SlotClaim; acquired: boolean }> {
    for (let attempt = 0; attempt < DELETE_CONFLICT_RETRIES; attempt += 1) {
      const current = await this.readSlotClaim(slot, signal);
      if (current.state !== SLOT_AVAILABLE) return { claim: current, acquired: false };
      try {
        const claim = await this.patchSlotClaim(
          current,
          [
            ...(current.claim.metadata?.annotations?.[SLOT_STATE_ANNOTATION] === undefined
              ? [
                  {
                    op: 'add',
                    path: annotationPath(SLOT_STATE_ANNOTATION),
                    value: SLOT_RESERVED,
                  },
                ]
              : [
                  {
                    op: 'test',
                    path: annotationPath(SLOT_STATE_ANNOTATION),
                    value: SLOT_AVAILABLE,
                  },
                  {
                    op: 'replace',
                    path: annotationPath(SLOT_STATE_ANNOTATION),
                    value: SLOT_RESERVED,
                  },
                ]),
            { op: 'add', path: annotationPath(SESSION_ANNOTATION), value: sessionId },
            { op: 'add', path: annotationPath(ALLOCATION_ANNOTATION), value: allocationId },
          ],
          signal,
        );
        return { claim, acquired: true };
      } catch (error) {
        if (!isPatchConflict(error)) throw error;
      }
    }
    throw new SandboxBackendError('unavailable', '无法竞争沙箱固定工作区。');
  }

  private async activateSlotForPod(pod: V1Pod, signal?: AbortSignal): Promise<SlotClaim> {
    const slot = managedPodSlot(pod);
    const sessionId = podSession(pod);
    const allocationId = podAllocationId(pod);
    const podUid = pod.metadata?.uid;
    if (slot === null || !sessionId || !allocationId || !podUid) {
      throw new SandboxBackendError('cleanup_unconfirmed', '沙箱 Pod 缺少固定工作区身份。');
    }
    for (let attempt = 0; attempt < DELETE_CONFLICT_RETRIES; attempt += 1) {
      const current = await this.readSlotClaim(slot, signal);
      if (
        current.state === SLOT_ACTIVE &&
        current.sessionId === sessionId &&
        current.allocationId === allocationId &&
        current.podUid === podUid
      ) {
        return current;
      }
      if (
        current.state !== SLOT_RESERVED ||
        current.sessionId !== sessionId ||
        current.allocationId !== allocationId
      ) {
        throw new SandboxBackendError(
          'cleanup_unconfirmed',
          '沙箱 Pod 与固定工作区预留身份不一致。',
        );
      }
      try {
        return await this.patchSlotClaim(
          current,
          [
            { op: 'test', path: annotationPath(SLOT_STATE_ANNOTATION), value: SLOT_RESERVED },
            { op: 'test', path: annotationPath(SESSION_ANNOTATION), value: sessionId },
            { op: 'test', path: annotationPath(ALLOCATION_ANNOTATION), value: allocationId },
            { op: 'add', path: annotationPath(SLOT_POD_UID_ANNOTATION), value: podUid },
            {
              op: 'replace',
              path: annotationPath(SLOT_STATE_ANNOTATION),
              value: SLOT_ACTIVE,
            },
          ],
          signal,
        );
      } catch (error) {
        if (!isPatchConflict(error)) throw error;
      }
    }
    throw new SandboxBackendError('cleanup_unconfirmed', '无法绑定沙箱固定工作区。');
  }

  private async quarantineSlotForPod(pod: V1Pod, signal?: AbortSignal): Promise<SlotClaim> {
    const slot = managedPodSlot(pod);
    const sessionId = podSession(pod);
    const allocationId = podAllocationId(pod);
    const podUid = pod.metadata?.uid;
    if (slot === null || !sessionId || !allocationId || !podUid) {
      throw new SandboxBackendError('cleanup_unconfirmed', '沙箱 Pod 缺少可隔离的工作区身份。');
    }
    for (let attempt = 0; attempt < DELETE_CONFLICT_RETRIES; attempt += 1) {
      const current = await this.readSlotClaim(slot, signal);
      if (
        current.state === SLOT_QUARANTINED &&
        current.sessionId === sessionId &&
        current.allocationId === allocationId &&
        current.podUid === podUid
      ) {
        return current;
      }
      if (
        ![SLOT_RESERVED, SLOT_ACTIVE].includes(current.state) ||
        current.sessionId !== sessionId ||
        current.allocationId !== allocationId ||
        (current.podUid !== undefined && current.podUid !== podUid)
      ) {
        throw new SandboxBackendError(
          'cleanup_unconfirmed',
          '沙箱固定工作区不能证明属于待删除 Pod。',
        );
      }
      try {
        return await this.patchSlotClaim(
          current,
          [
            { op: 'test', path: annotationPath(SESSION_ANNOTATION), value: sessionId },
            { op: 'test', path: annotationPath(ALLOCATION_ANNOTATION), value: allocationId },
            ...(current.podUid
              ? [
                  {
                    op: 'test',
                    path: annotationPath(SLOT_POD_UID_ANNOTATION),
                    value: podUid,
                  },
                ]
              : [
                  {
                    op: 'add',
                    path: annotationPath(SLOT_POD_UID_ANNOTATION),
                    value: podUid,
                  },
                ]),
            {
              op: 'replace',
              path: annotationPath(SLOT_STATE_ANNOTATION),
              value: SLOT_QUARANTINED,
            },
          ],
          signal,
        );
      } catch (error) {
        if (!isPatchConflict(error)) throw error;
      }
    }
    throw new SandboxBackendError('cleanup_unconfirmed', '无法隔离沙箱固定工作区。');
  }

  private async releaseQuarantinedSlot(
    quarantined: SlotClaim,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      quarantined.state !== SLOT_QUARANTINED ||
      !quarantined.sessionId ||
      !quarantined.allocationId ||
      !quarantined.podUid
    ) {
      throw new SandboxBackendError('cleanup_unconfirmed', '沙箱固定工作区未处于隔离状态。');
    }
    for (let attempt = 0; attempt < DELETE_CONFLICT_RETRIES; attempt += 1) {
      const current = await this.readSlotClaim(quarantined.slot, signal);
      if (
        current.state !== SLOT_QUARANTINED ||
        current.sessionId !== quarantined.sessionId ||
        current.allocationId !== quarantined.allocationId ||
        current.podUid !== quarantined.podUid
      ) {
        throw new SandboxBackendError('cleanup_unconfirmed', '沙箱固定工作区隔离身份已变化。');
      }
      try {
        const released = await this.patchSlotClaim(
          current,
          [
            { op: 'remove', path: annotationPath(SLOT_STATE_ANNOTATION) },
            { op: 'remove', path: annotationPath(SESSION_ANNOTATION) },
            { op: 'remove', path: annotationPath(ALLOCATION_ANNOTATION) },
            { op: 'remove', path: annotationPath(SLOT_POD_UID_ANNOTATION) },
          ],
          signal,
        );
        if (released.state !== SLOT_AVAILABLE) {
          throw new SandboxBackendError('cleanup_unconfirmed', '沙箱固定工作区释放失败。');
        }
        return;
      } catch (error) {
        if (!isPatchConflict(error)) throw error;
      }
    }
    throw new SandboxBackendError('cleanup_unconfirmed', '无法释放沙箱固定工作区。');
  }

  private async readPod(name: string, signal?: AbortSignal): Promise<V1Pod | null> {
    try {
      return await this.apiCall(signal, (boundedSignal) =>
        this.api.readNamespacedPod({
          name,
          namespace: this.env.SANDBOX_NAMESPACE,
          signal: boundedSignal,
        }),
      );
    } catch (error) {
      if (apiStatus(error) === 404) return null;
      if (signal?.aborted) {
        throw new SandboxBackendError('aborted', '沙箱操作已取消。');
      }
      throw new SandboxBackendError('unavailable', '无法读取沙箱状态，请稍后重试。');
    }
  }

  private async waitForPodUidGone(name: string, uid: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      const current = await this.readPod(name, signal);
      if (!current) return;
      if (current.metadata?.uid !== uid) {
        throw new SandboxBackendError(
          'cleanup_unconfirmed',
          '固定名称在工作区释放前出现了不同 Pod UID。',
        );
      }
      await abortableDelay(50, signal);
    }
  }

  private async ensureSlotFinalizer(pod: V1Pod, signal: AbortSignal): Promise<V1Pod> {
    if (pod.metadata?.finalizers?.includes(SLOT_FINALIZER)) return pod;
    const identity = podIdentity(pod);
    const resourceVersion = pod.metadata?.resourceVersion;
    if (!identity || !resourceVersion) {
      throw new SandboxBackendError('cleanup_unconfirmed', '沙箱槽位缺少可确认的删除身份。');
    }
    const finalizers = pod.metadata?.finalizers ?? [];
    try {
      return await this.apiCall(signal, (boundedSignal) =>
        this.api.patchNamespacedPod({
          name: identity.name,
          namespace: this.env.SANDBOX_NAMESPACE,
          body: [
            { op: 'test', path: '/metadata/uid', value: identity.uid },
            { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
            ...(finalizers.length === 0
              ? [{ op: 'add', path: '/metadata/finalizers', value: [SLOT_FINALIZER] }]
              : [{ op: 'add', path: '/metadata/finalizers/-', value: SLOT_FINALIZER }]),
          ],
          signal: boundedSignal,
        }),
      );
    } catch {
      throw new SandboxBackendError('cleanup_unconfirmed', '无法隔离待回收的沙箱槽位。');
    }
  }

  private async waitForNodeTermination(
    name: string,
    uid: string,
    signal: AbortSignal,
  ): Promise<V1Pod> {
    for (;;) {
      const current = await this.readPod(name, signal);
      if (!current || current.metadata?.uid !== uid) {
        // API disappearance alone is not node-side proof. A force deletion or node
        // partition can leave the old process and Local-PV mount alive.
        throw new SandboxBackendError(
          'cleanup_unconfirmed',
          '沙箱对象在节点确认容器终止前消失，槽位必须保持隔离。',
        );
      }
      if (nodeConfirmedContainersTerminated(current)) return current;
      await abortableDelay(50, signal);
    }
  }

  private async removeSlotFinalizer(pod: V1Pod, signal: AbortSignal): Promise<void> {
    const identity = podIdentity(pod);
    const resourceVersion = pod.metadata?.resourceVersion;
    const index = pod.metadata?.finalizers?.indexOf(SLOT_FINALIZER) ?? -1;
    if (!identity || !resourceVersion || index < 0) {
      throw new SandboxBackendError('cleanup_unconfirmed', '沙箱槽位终止确认缺少 finalizer。');
    }
    try {
      await this.apiCall(signal, (boundedSignal) =>
        this.api.patchNamespacedPod({
          name: identity.name,
          namespace: this.env.SANDBOX_NAMESPACE,
          body: [
            { op: 'test', path: '/metadata/uid', value: identity.uid },
            { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
            { op: 'test', path: `/metadata/finalizers/${index}`, value: SLOT_FINALIZER },
            { op: 'remove', path: `/metadata/finalizers/${index}` },
          ],
          signal: boundedSignal,
        }),
      );
    } catch (error) {
      if (apiStatus(error) !== 404) {
        throw new SandboxBackendError('cleanup_unconfirmed', '无法释放已终止的沙箱槽位。');
      }
    }
  }

  private async deletePod(pod: V1Pod, signal?: AbortSignal): Promise<void> {
    const initialIdentity = podIdentity(pod);
    if (!initialIdentity || managedPodSlot(pod) === null) return;
    const deadline = AbortSignal.timeout(this.apiRequestTimeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    // Reserve the PVC itself before touching Pod deletion. If the API object is
    // force-removed or the node disappears, this durable marker keeps every
    // Runtime replica from mounting the fixed slot for a different Session.
    const quarantined = await this.quarantineSlotForPod(pod, bounded);
    let current = await this.ensureSlotFinalizer(pod, bounded);
    let deletionAccepted = current.metadata?.deletionTimestamp !== undefined;
    for (let attempt = 0; attempt < DELETE_CONFLICT_RETRIES && !deletionAccepted; attempt += 1) {
      const identity = podIdentity(current);
      if (
        !identity ||
        identity.name !== initialIdentity.name ||
        identity.uid !== initialIdentity.uid
      ) {
        throw new SandboxBackendError('cleanup_unconfirmed', '沙箱槽位身份在回收期间变化。');
      }
      try {
        await this.apiCall(bounded, (boundedSignal) =>
          this.api.deleteNamespacedPod({
            name: identity.name,
            namespace: this.env.SANDBOX_NAMESPACE,
            gracePeriodSeconds: POD_DELETE_GRACE_SECONDS,
            body: {
              apiVersion: 'v1',
              kind: 'DeleteOptions',
              gracePeriodSeconds: POD_DELETE_GRACE_SECONDS,
              preconditions: {
                uid: identity.uid,
                ...(current.metadata?.resourceVersion
                  ? { resourceVersion: current.metadata.resourceVersion }
                  : {}),
              },
            },
            signal: boundedSignal,
          }),
        );
        deletionAccepted = true;
      } catch (error) {
        const reread = await this.readPod(identity.name, bounded).catch(() => null);
        if (!reread || reread.metadata?.uid !== initialIdentity.uid) {
          throw new SandboxBackendError('cleanup_unconfirmed', '无法确认沙箱容器已在节点终止。');
        }
        current = reread;
        if (current.metadata?.deletionTimestamp !== undefined) {
          deletionAccepted = true;
        } else if (apiStatus(error) !== 409) {
          throw new SandboxBackendError('unavailable', '无法回收沙箱，请稍后重试。');
        }
      }
    }
    if (!deletionAccepted) {
      throw new SandboxBackendError('unavailable', '无法回收沙箱，请稍后重试。');
    }
    const terminated = await this.waitForNodeTermination(
      initialIdentity.name,
      initialIdentity.uid,
      bounded,
    );
    await this.removeSlotFinalizer(terminated, bounded);
    await this.waitForPodUidGone(initialIdentity.name, initialIdentity.uid, bounded);
    await this.releaseQuarantinedSlot(quarantined, bounded);
  }

  private async deletePodIfCurrent(name: string, uid: string, signal?: AbortSignal): Promise<void> {
    const current = await this.readPod(name, signal);
    if (!current || current.metadata?.uid !== uid) {
      throw new SandboxBackendError(
        'cleanup_unconfirmed',
        '无法从节点状态确认原沙箱容器已经终止。',
      );
    }
    await this.deletePod(current, signal);
  }

  private isAbsoluteExpired(pod: V1Pod): boolean {
    const createdAt = podCreationTime(pod);
    return createdAt === null || createdAt <= this.now() - this.env.SANDBOX_ABSOLUTE_TTL_MS;
  }

  private makeClient(pod: V1Pod): PodHandle {
    const identity = podIdentity(pod);
    const ip = pod.status?.podIP;
    if (
      !identity ||
      !ip ||
      !safePodIp(ip) ||
      managedPodSlot(pod) === null ||
      !podMatchesConfiguration(pod, this.env, this.publicKey, this.configFingerprint)
    ) {
      throw new SandboxBackendError('unavailable', '沙箱尚未就绪，请稍后重试。');
    }
    const host = ip.includes(':') ? `[${ip}]` : ip;
    const client = this.clientFactory({
      baseUrl: `http://${host}:${SANDBOX_PORT}`,
      sessionId: podSession(pod) ?? '',
      podUid: identity.uid,
      signer: this.signer,
      onCancelFailure: async () => this.deletePodIfCurrent(identity.name, identity.uid),
    });
    return { pod, name: identity.name, uid: identity.uid, ip, client };
  }

  private async waitReady(
    pod: V1Pod,
    signal?: AbortSignal,
    cleanupOwnedPod = false,
  ): Promise<PodHandle> {
    const identity = podIdentity(pod);
    if (!identity || managedPodSlot(pod) === null) {
      throw new SandboxBackendError('unavailable', '沙箱身份缺失。');
    }
    const deadline = this.now() + this.env.SANDBOX_STARTUP_TIMEOUT_MS;
    let current = pod;
    try {
      while (this.now() < deadline) {
        if (signal?.aborted) {
          throw new SandboxBackendError('aborted', '沙箱操作已取消。');
        }
        if (
          managedPodSlot(current) === null ||
          podSession(current) !== podSession(pod) ||
          current.metadata?.uid !== identity.uid ||
          !podMatchesConfiguration(current, this.env, this.publicKey, this.configFingerprint)
        ) {
          throw new SandboxBackendError('unavailable', '沙箱身份在启动期间发生变化。');
        }
        if (isReady(current)) return this.makeClient(current);
        if (isTerminal(current)) break;
        await abortableDelay(250, signal);
        const reread = await this.readPod(identity.name, signal);
        if (!reread) break;
        current = reread;
      }
    } catch (error) {
      if (cleanupOwnedPod) {
        await this.deletePodIfCurrent(identity.name, identity.uid).catch(() => undefined);
      }
      throw error;
    }
    // A real startup timeout or terminal phase is globally stale, even when this
    // replica did not create the Pod. Abort only cleans a Pod owned by this call.
    await this.deletePodIfCurrent(identity.name, identity.uid).catch(() => undefined);
    throw new SandboxBackendError('unavailable', '沙箱启动超时，请稍后重试。');
  }

  private async confirmProtocol(
    handle: PodHandle,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PodHandle> {
    const description = await handle.client.describe(signal);
    if (
      description.protocolVersion !== '1' ||
      description.sessionId !== sessionId ||
      description.podUid !== handle.uid
    ) {
      await this.deletePodIfCurrent(handle.name, handle.uid).catch(() => undefined);
      throw new SandboxBackendError('unavailable', '沙箱协议身份校验失败。');
    }
    return handle;
  }

  private assertConfigurationCanBeReplaced(pod: V1Pod): void {
    const podRevision = podConfigurationRevision(pod);
    const currentRevision = this.env.SANDBOX_CONFIGURATION_REVISION;
    const sameRevisionDifferentConfiguration =
      podRevision === currentRevision && podFingerprint(pod) !== this.configFingerprint;
    if (podRevision > currentRevision || sameRevisionDifferentConfiguration) {
      // A stale Runtime replica must never roll a newer Pod back. Equal revisions
      // with different fingerprints mean an operator forgot to bump the revision;
      // fail closed instead of letting two replicas delete each other forever.
      throw new SandboxBackendError('unavailable', '当前 Runtime 的沙箱配置已过期，请稍后重试。');
    }
  }

  private async replaceConfigurationForTurn(
    pod: V1Pod,
    context: SandboxTurnContext,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertConfigurationCanBeReplaced(pod);
    await withTransaction(
      this.db,
      async (transaction) => {
        const session = await transaction.query<{ id: string }>(
          `SELECT id FROM sessions WHERE id = $1 FOR UPDATE`,
          [context.sessionId],
        );
        if (!session.rows[0]) {
          throw new SandboxBackendError('unauthorized', '当前轮次无权访问沙箱。');
        }
        await this.authorize(context, transaction, signal);
        await this.deletePod(pod, signal);
      },
      { signal, timeoutMs: this.apiRequestTimeoutMs },
    );
  }

  private async findReusable(
    context: SandboxTurnContext,
    signal?: AbortSignal,
  ): Promise<PodHandle | null> {
    for (let slot = 0; slot < this.env.SANDBOX_CAPACITY; slot += 1) {
      const pod = await this.readPod(`combo-sandbox-slot-${slot}`, signal);
      if (!pod || podSession(pod) !== context.sessionId || managedPodSlot(pod) !== slot) continue;
      let claim = await this.readSlotClaim(slot, signal);
      if (!claimMatchesPod(claim, pod)) {
        throw new SandboxBackendError(
          'cleanup_unconfirmed',
          '沙箱 Pod 与固定工作区身份不一致，槽位拒绝复用。',
        );
      }
      if (claim.state === SLOT_RESERVED) claim = await this.activateSlotForPod(pod, signal);
      if (![SLOT_ACTIVE, SLOT_QUARANTINED].includes(claim.state)) {
        throw new SandboxBackendError('cleanup_unconfirmed', '沙箱固定工作区状态无效。');
      }
      if (claim.state === SLOT_QUARANTINED) {
        await this.deletePod(pod, signal);
        continue;
      }
      if (!podMatchesConfiguration(pod, this.env, this.publicKey, this.configFingerprint)) {
        await this.replaceConfigurationForTurn(pod, context, signal);
        continue;
      }
      if (pod.metadata?.deletionTimestamp !== undefined || isTerminal(pod)) {
        await this.deletePod(pod, signal).catch(() => undefined);
        continue;
      }
      if (this.isAbsoluteExpired(pod)) {
        await this.deletePod(pod, signal);
        continue;
      }
      return isReady(pod) ? this.makeClient(pod) : this.waitReady(pod, signal);
    }
    return null;
  }

  private async allocate(
    context: SandboxTurnContext,
    signal?: AbortSignal,
    reaped = false,
  ): Promise<PodHandle> {
    const sessionId = context.sessionId;
    const reusable = await this.findReusable(context, signal);
    if (reusable) return reusable;

    for (let slot = 0; slot < this.env.SANDBOX_CAPACITY; slot += 1) {
      const name = `combo-sandbox-slot-${slot}`;
      if (this.uncertainCreates.has(name)) continue;
      const existing = await this.readPod(name, signal);
      if (existing) {
        if (managedPodSlot(existing) === slot && podSession(existing) === sessionId) {
          const wonForSession = await this.findReusable(context, signal);
          if (wonForSession) return wonForSession;
        }
        if (managedPodSlot(existing) === slot && isTerminal(existing)) {
          try {
            this.assertConfigurationCanBeReplaced(existing);
            await this.deletePod(existing);
          } catch {
            // A mismatched or unconfirmed PVC assignment keeps this fixed slot
            // occupied. Only the replica that can prove the identity may release it.
          }
        }
        continue;
      }

      const allocationId = randomUUID();
      const reservation = await withTransaction(
        this.db,
        async (transaction) => {
          // Linearize the durable PVC reservation with Turn terminalization. A
          // terminal transaction either wins before this point, or later observes
          // the reservation and cannot falsely certify that no sandbox exists.
          await this.authorize(context, transaction, signal);
          return this.reserveSlot(slot, sessionId, allocationId, signal);
        },
        { signal, timeoutMs: this.apiRequestTimeoutMs },
      );
      if (!reservation.acquired) {
        if (
          reservation.claim.sessionId !== sessionId ||
          ![SLOT_RESERVED, SLOT_ACTIVE].includes(reservation.claim.state)
        ) {
          continue;
        }
        if (reservation.claim.state === SLOT_ACTIVE) {
          throw new SandboxBackendError(
            'cleanup_unconfirmed',
            '沙箱 Pod 已消失但固定工作区仍被占用。',
          );
        }
        // Another replica reserved this Session's slot before issuing CREATE.
        // Wait for that exact allocation instead of consuming a second slot.
        const waitDeadline = Date.now() + Math.min(this.env.SANDBOX_STARTUP_TIMEOUT_MS, 5_000);
        let winner: V1Pod | null = null;
        while (!winner && Date.now() < waitDeadline) {
          winner = await this.readPod(name, signal);
          if (!winner) await abortableDelay(50, signal);
        }
        if (!winner || !claimMatchesPod(reservation.claim, winner)) {
          throw new SandboxBackendError(
            'cleanup_unconfirmed',
            '沙箱固定工作区预留没有可确认的 Pod。',
          );
        }
        await this.activateSlotForPod(winner, signal);
        if (!podMatchesConfiguration(winner, this.env, this.publicKey, this.configFingerprint)) {
          await this.replaceConfigurationForTurn(winner, context, signal);
          return this.allocate(context, signal, reaped);
        }
        if (
          winner.metadata?.deletionTimestamp !== undefined ||
          isTerminal(winner) ||
          this.isAbsoluteExpired(winner)
        ) {
          await this.deletePod(winner, signal);
          return this.allocate(context, signal, reaped);
        }
        const ready = isReady(winner)
          ? this.makeClient(winner)
          : await this.waitReady(winner, signal);
        return this.confirmProtocol(ready, sessionId, signal);
      }

      const body = buildSandboxPod({
        env: this.env,
        slot,
        sessionId,
        publicKey: this.publicKey,
        fingerprint: this.configFingerprint,
        allocationId,
      });
      let createOperation: Promise<V1Pod> | undefined;
      try {
        // Re-read after the atomic PVC reservation. An object here belongs to a
        // legacy or corrupted allocator and must not share this fixed volume.
        if (await this.readPod(name, signal)) {
          throw new SandboxBackendError(
            'cleanup_unconfirmed',
            '固定工作区预留后出现了身份不明的沙箱 Pod。',
          );
        }
        const created = await this.apiCall(signal, (boundedSignal) => {
          createOperation = this.api.createNamespacedPod({
            namespace: this.env.SANDBOX_NAMESPACE,
            body,
            signal: boundedSignal,
          });
          return createOperation;
        });
        await this.activateSlotForPod(created, signal);
        this.log.info({ slot, sessionId }, 'sandbox slot allocated');
        const ready = await this.waitReady(created, signal, true);
        return this.confirmProtocol(ready, sessionId, signal);
      } catch (error) {
        if (apiStatus(error) === 409) {
          const winner = await this.readPod(name, signal);
          if (
            winner &&
            managedPodSlot(winner) === slot &&
            podSession(winner) === sessionId &&
            podAllocationId(winner) === allocationId
          ) {
            await this.activateSlotForPod(winner, signal);
            const ready = isReady(winner)
              ? this.makeClient(winner)
              : await this.waitReady(winner, signal, true);
            return this.confirmProtocol(ready, sessionId, signal);
          }
          throw new SandboxBackendError(
            'cleanup_unconfirmed',
            '沙箱 Pod 创建冲突无法与固定工作区预留对应。',
          );
        }
        // A locally timed-out CREATE may still commit later. The PVC reservation
        // remains durable across replicas and process restarts until that exact
        // allocation is reconciled and node termination is proven.
        if (createOperation) this.trackUncertainCreate(name, allocationId, createOperation);
        if (error instanceof SandboxBackendError) throw error;
        throw new SandboxBackendError('unavailable', '无法分配沙箱，请稍后重试。');
      }
    }

    if (!reaped) {
      await this.reap();
      return this.allocate(context, signal, true);
    }
    throw new SandboxBackendError('capacity', '当前沙箱容量已满，请稍后重试。');
  }

  private trackUncertainCreate(
    name: string,
    allocationId: string,
    operation: Promise<V1Pod>,
  ): void {
    if (this.uncertainCreates.has(name)) return;
    const reconcile = operation
      .then(async (created) => {
        const current =
          created.metadata?.name === name ? created : await this.readPod(name).catch(() => null);
        if (current && podAllocationId(current) === allocationId) {
          await this.deletePod(current);
        }
      })
      .catch(async () => {
        // A rejected client response can still follow a committed CREATE. Once the
        // original operation has definitively settled, reconcile the allocation id.
        const current = await this.readPod(name).catch(() => null);
        if (current && podAllocationId(current) === allocationId) {
          await this.deletePod(current);
        }
      })
      .catch((error) => {
        this.log.error(
          { name, allocationId, error: error instanceof Error ? error.name : 'unknown' },
          'uncertain sandbox CREATE remains quarantined',
        );
      })
      .finally(() => {
        if (this.uncertainCreates.get(name) === reconcile) this.uncertainCreates.delete(name);
      });
    this.uncertainCreates.set(name, reconcile);
  }

  private async handleFor(
    context: SandboxTurnContext,
    signal?: AbortSignal,
    recycled = false,
  ): Promise<PodHandle> {
    this.assertOpen();
    await this.authorize(context, this.db, signal);
    let pending = this.allocations.get(context.sessionId);
    if (!pending) {
      pending = this.allocate(context, signal).finally(() => {
        if (this.allocations.get(context.sessionId) === pending) {
          this.allocations.delete(context.sessionId);
        }
      });
      this.allocations.set(context.sessionId, pending);
    }
    const handle = await pending;
    this.assertOpen();
    // Pod identity is a capability boundary, so every operation re-reads it instead of trusting cache.
    const current = await this.readPod(handle.name, signal);
    const currentSlot = current ? managedPodSlot(current) : null;
    if (
      !current ||
      current.metadata?.uid !== handle.uid ||
      currentSlot === null ||
      podSession(current) !== context.sessionId ||
      !podMatchesConfiguration(current, this.env, this.publicKey, this.configFingerprint) ||
      !isReady(current)
    ) {
      throw new SandboxBackendError('unavailable', '沙箱身份已变化，请重试。');
    }
    const claim = await this.readSlotClaim(currentSlot, signal);
    if (claim.state !== SLOT_ACTIVE || !claimMatchesPod(claim, current)) {
      throw new SandboxBackendError('cleanup_unconfirmed', '沙箱固定工作区已进入隔离状态。');
    }
    if (this.isAbsoluteExpired(current)) {
      await this.deletePod(current, signal);
      if (!recycled) return this.handleFor(context, signal, true);
      throw new SandboxBackendError('unavailable', '沙箱已到生命周期上限，请重试。');
    }
    // Pod 启动可能耗时；真正发请求前再次确认 Turn 仍为 running。
    // The row lock also waits for a cross-replica interrupt transaction. A Pod
    // created from an earlier authorization can never start a command afterward.
    try {
      await this.authorize(context, this.db, signal);
    } catch (error) {
      await this.deletePodIfCurrent(handle.name, handle.uid).catch(() => undefined);
      throw error;
    }
    return this.makeClient(current);
  }

  private withAuthorizedTurn<T>(
    context: SandboxTurnContext,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withTransaction(
      this.db,
      async (transaction) => {
        // Hold the Session key-share lock until the sandbox has finished a bounded
        // file operation (or acknowledged command start). Terminalization takes
        // FOR UPDATE on the same row, closing the authorize-then-side-effect race.
        await this.authorize(context, transaction, signal);
        return operation();
      },
      { signal, timeoutMs: this.apiRequestTimeoutMs },
    );
  }

  async describe(
    context: SandboxTurnContext,
    signal?: AbortSignal,
  ): Promise<SandboxDescribeResult> {
    const operationSignal = this.operationSignal(signal);
    const handle = await this.handleFor(context, operationSignal);
    return this.withAuthorizedTurn(context, operationSignal, () =>
      handle.client.describe(operationSignal),
    );
  }

  async read(
    context: SandboxTurnContext,
    input: SandboxReadInput,
    signal?: AbortSignal,
  ): Promise<SandboxReadResult> {
    const operationSignal = this.operationSignal(signal);
    const handle = await this.handleFor(context, operationSignal);
    return this.withAuthorizedTurn(context, operationSignal, () =>
      handle.client.read(input, operationSignal),
    );
  }

  async write(
    context: SandboxTurnContext,
    input: SandboxWriteInput,
    signal?: AbortSignal,
  ): Promise<SandboxWriteResult> {
    const operationSignal = this.operationSignal(signal);
    const handle = await this.handleFor(context, operationSignal);
    return this.withAuthorizedTurn(context, operationSignal, () =>
      handle.client.write(input, operationSignal),
    );
  }

  async edit(
    context: SandboxTurnContext,
    input: SandboxEditInput,
    signal?: AbortSignal,
  ): Promise<SandboxEditResult> {
    const operationSignal = this.operationSignal(signal);
    const handle = await this.handleFor(context, operationSignal);
    return this.withAuthorizedTurn(context, operationSignal, () =>
      handle.client.edit(input, operationSignal),
    );
  }

  async command(
    context: SandboxTurnContext,
    input: SandboxCommandInput,
    onFrame: (frame: SandboxCommandFrame) => void,
    signal?: AbortSignal,
  ): Promise<SandboxCommandResult> {
    const operationSignal = this.operationSignal(signal);
    const handle = await this.handleFor(context, operationSignal);
    if (this.activeCommands.has(context.sessionId)) {
      throw new SandboxBackendError('unavailable', '当前沙箱已有命令正在执行。');
    }
    const commandId = randomUUID();
    const commandController = new AbortController();
    const commandSignal = AbortSignal.any([operationSignal, commandController.signal]);
    let acknowledgeStart!: () => void;
    const started = new Promise<void>((resolve) => {
      acknowledgeStart = resolve;
    });
    let commandCompletion: Promise<SandboxCommandResult> | undefined;
    const startGuard = this.withAuthorizedTurn(context, commandSignal, async () => {
      commandCompletion = handle.client.command(
        {
          commandId,
          command: input.command,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        },
        (frame) => {
          if (frame.type === 'start') acknowledgeStart();
          onFrame(frame);
        },
        commandSignal,
      );
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          started,
          commandCompletion.then(
            () => {
              throw new SandboxBackendError('unavailable', '沙箱命令未确认启动。');
            },
            (error: unknown) => {
              throw error;
            },
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              commandController.abort();
              reject(new SandboxBackendError('unavailable', '沙箱命令启动确认超时。'));
            }, this.apiRequestTimeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
    const completion = startGuard.then(() => {
      if (!commandCompletion) {
        throw new SandboxBackendError('unavailable', '沙箱命令未能启动。');
      }
      return commandCompletion;
    });
    this.activeCommands.set(context.sessionId, {
      commandId,
      podName: handle.name,
      podUid: handle.uid,
      abort: () => commandController.abort(),
      completion,
    });
    try {
      return await completion;
    } catch (error) {
      if (!(error instanceof SandboxBackendError && error.code === 'aborted')) {
        try {
          // Any non-abort command transport/protocol failure gets one final
          // UID-conditioned recycle check before control returns to Pi.
          await this.deletePodIfCurrent(handle.name, handle.uid);
        } catch {
          throw new SandboxBackendError('cleanup_unconfirmed', '无法确认沙箱命令后代已经清理。');
        }
      }
      throw error;
    } finally {
      const current = this.activeCommands.get(context.sessionId);
      if (current?.commandId === commandId) this.activeCommands.delete(context.sessionId);
    }
  }

  private async deleteSessionPods(sessionId: string): Promise<void> {
    const deadline = AbortSignal.timeout(this.apiRequestTimeoutMs);
    await Promise.all(
      Array.from({ length: MAX_SANDBOX_SLOTS }, async (_unused, slot) => {
        const [pod, claim] = await Promise.all([
          this.readPod(`combo-sandbox-slot-${slot}`, deadline),
          this.readOptionalSlotClaim(slot, deadline),
        ]);
        const podBelongs =
          pod !== null && managedPodSlot(pod) === slot && podSession(pod) === sessionId;
        const claimBelongs = claim?.sessionId === sessionId;
        if (!podBelongs && !claimBelongs) return;
        if (!pod || !claim || !podBelongs || !claimBelongs || !claimMatchesPod(claim, pod)) {
          // In particular, a force-deleted Pod leaves its PVC assignment behind.
          // That durable quarantine is not cleanup proof and must keep the Turn running.
          throw new SandboxBackendError(
            'cleanup_unconfirmed',
            '沙箱 Pod 与固定工作区不能共同证明清理完成。',
          );
        }
        await this.deletePod(pod, deadline);
      }),
    );
  }

  async interruptSession(sessionId: string): Promise<void> {
    const active = this.activeCommands.get(sessionId);
    if (!active) {
      // The HTTP interrupt may land on the other Runtime replica. Without a
      // local command id, deleting and observing the Session Pod UID disappear
      // is the only synchronous proof that a remote descendant cannot survive.
      await this.deleteSessionPods(sessionId);
      return;
    }
    active.abort();
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      active.completion.then(
        () => ({ settled: true as const }),
        (error: unknown) => ({ settled: true as const, error }),
      ),
      new Promise<{ settled: false }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), 3_000);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (
      outcome.settled &&
      (!('error' in outcome) ||
        (outcome.error instanceof SandboxBackendError && outcome.error.code === 'aborted'))
    ) {
      return;
    }
    // A timeout or any non-abort client failure is not proof of cleanup. Delete
    // and wait until this exact UID disappears; propagate failure to the caller.
    await this.deletePodIfCurrent(active.podName, active.podUid);
  }

  async releaseSession(sessionId: string): Promise<void> {
    await this.deleteSessionPods(sessionId);
  }

  private async reapPod(pod: V1Pod, idleCutoff: number): Promise<void> {
    const slot = managedPodSlot(pod);
    if (slot === null) return;
    if (pod.metadata?.deletionTimestamp !== undefined) {
      // A finalizer intentionally quarantines this fixed Local-PV slot until the
      // kubelet reports every container terminated. Reapers keep retrying that proof.
      await this.deletePod(pod);
      return;
    }
    const podRevision = podConfigurationRevision(pod);
    const currentRevision = this.env.SANDBOX_CONFIGURATION_REVISION;
    if (
      podRevision > currentRevision ||
      (podRevision === currentRevision && podFingerprint(pod) !== this.configFingerprint)
    ) {
      // A previous ReplicaSet can remain alive during a rolling update. It may
      // observe newer or ambiguously equal-revision Pods, but must not reap them.
      return;
    }
    if (isTerminal(pod) || this.isAbsoluteExpired(pod)) {
      await this.deletePod(pod);
      return;
    }
    const sessionId = podSession(pod);
    if (!sessionId) {
      await this.deletePod(pod);
      return;
    }
    const configurationStale =
      slot >= this.env.SANDBOX_CAPACITY ||
      !podMatchesConfiguration(pod, this.env, this.publicKey, this.configFingerprint);
    await withTransaction(
      this.db,
      async (transaction) => {
        const session = await transaction.query<{
          status: 'active' | 'closed';
          updated_at: string | Date;
        }>(`SELECT status, updated_at FROM sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
        const row = session.rows[0];
        if (
          row?.status === 'active' &&
          !configurationStale &&
          new Date(row.updated_at).getTime() >= idleCutoff
        ) {
          return;
        }
        if (row?.status === 'active') {
          const running = await transaction.query<{ exists: boolean }>(
            `SELECT EXISTS (
             SELECT 1 FROM turns WHERE session_id = $1 AND status = 'running'
           ) AS exists`,
            [sessionId],
          );
          if (running.rows[0]?.exists) return;
        }
        // Kubernetes calls carry a real AbortSignal and a hard deadline, so the
        // Session row lock cannot be held by a black-holed control plane forever.
        await this.deletePod(pod, this.shutdown.signal);
      },
      { signal: this.shutdown.signal, timeoutMs: this.apiRequestTimeoutMs },
    );
  }

  /** Runs one idempotent cross-replica lifecycle pass. Exposed for deterministic tests. */
  async reap(): Promise<void> {
    if (this.disposed) return;
    let listed: V1PodList;
    try {
      listed = await this.apiCall(this.shutdown.signal, (boundedSignal) =>
        this.api.listNamespacedPod({
          namespace: this.env.SANDBOX_NAMESPACE,
          labelSelector: `app=${APP_LABEL}`,
          signal: boundedSignal,
        }),
      );
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'sandbox Pod list skipped',
      );
      return;
    }
    const idleCutoff = this.now() - this.env.SANDBOX_IDLE_TTL_MS;
    for (const pod of listed.items) {
      await this.reapPod(pod, idleCutoff).catch((error) =>
        this.log.warn(
          {
            podName: pod.metadata?.name,
            error: error instanceof Error ? error.name : 'unknown',
          },
          'sandbox Pod reap skipped',
        ),
      );
    }
  }

  dispose(signal?: AbortSignal): Promise<void> {
    const deadline = signal ?? AbortSignal.timeout(this.apiRequestTimeoutMs);
    this.disposePromise ??= this.disposeOnce(deadline);
    return this.disposePromise;
  }

  private async disposeOnce(signal: AbortSignal): Promise<void> {
    this.disposed = true;
    clearInterval(this.sweepTimer);
    this.shutdown.abort();
    const commands = [...this.activeCommands.keys()].map((sessionId) =>
      this.interruptSession(sessionId),
    );
    const allocations = [...this.allocations.values()];
    const uncertainCreates = [...this.uncertainCreates.values()];
    const reaping = this.reapInFlight ? [this.reapInFlight] : [];
    await settleBeforeSignal(
      [...commands, ...allocations, ...uncertainCreates, ...reaping],
      signal,
    );
  }
}

export function createKubernetesSandboxBackend(
  env: Env,
  db: RuntimeDb,
  options: KubernetesSandboxBackendOptions = {},
): SandboxBackend {
  return new KubernetesSandboxBackend(env, db, options);
}
