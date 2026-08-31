import { createHash, randomBytes } from 'node:crypto';

import {
  CREATOR_AGENT_PACKAGE_FILENAME,
  CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES,
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  parseCreatorAgentPackageManifest,
  type CreatorAgentPackageDigest,
} from '@cb/creator-agent-protocol/agent-package';
import {
  CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL,
  createCreatorAgentPackageRelease,
  type CreatorAgentPackageRelease,
} from '@cb/creator-agent-protocol/agent-package-release';
import {
  CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES,
  CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
  CREATOR_KNOWLEDGE_SKILL_PATH,
  parseCreatorKnowledgeBundle,
  resolveCreatorKnowledgeBundleResource,
} from '@cb/creator-agent-protocol/knowledge-bundle';
import { z } from 'zod';

import { toIso, type Queryable } from '../../platform/infra/db.js';
import { withTransaction, type QueryableDb, type TxPool } from '../../platform/infra/db-tx.js';
import {
  ImmutableObjectStoreError,
  type ImmutableObjectStore,
} from '../../platform/infra/object-store.js';

export const AGENT_PACKAGE_RELEASE_SCOPE = 'controlled_test' as const;
export const AGENT_PACKAGE_OBJECT_BUCKET = 'combo-artifacts' as const;

const MAX_MARKDOWN_BYTES = 65_536;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const PACKAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PACKAGE_OBJECT_PATHS = new Set<string>([
  'AGENT.md',
  CREATOR_KNOWLEDGE_SKILL_PATH,
  CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
  CREATOR_AGENT_PACKAGE_FILENAME,
]);

function maximumBase64Characters(maximumBytes: number): number {
  return Math.ceil(maximumBytes / 3) * 4;
}

export const ControlledTestAgentPackageReleaseRequestSchema = z
  .object({
    idempotencyKey: z.string().regex(CANONICAL_UUID_PATTERN),
    agentJsonBase64: z
      .string()
      .min(4)
      .max(maximumBase64Characters(CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES)),
    agentMarkdownBase64: z.string().min(4).max(maximumBase64Characters(MAX_MARKDOWN_BYTES)),
    knowledgeSkillBase64: z.string().min(4).max(maximumBase64Characters(MAX_MARKDOWN_BYTES)),
    knowledgeBundleBase64: z
      .string()
      .min(4)
      .max(maximumBase64Characters(CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES)),
  })
  .strict();

export type AgentPackageReleaseFailureKind =
  | 'validation'
  | 'idempotency_conflict'
  | 'state_conflict'
  | 'unavailable';

const SAFE_FAILURE_MESSAGES: Record<AgentPackageReleaseFailureKind, string> = {
  validation: 'Agent Package release request is invalid',
  idempotency_conflict: 'Agent Package release idempotency conflict',
  state_conflict: 'Agent Package immutable state conflict',
  unavailable: 'Agent Package release dependency is unavailable',
};

export class AgentPackageReleaseFailure extends Error {
  readonly kind: AgentPackageReleaseFailureKind;

  constructor(kind: AgentPackageReleaseFailureKind) {
    super(SAFE_FAILURE_MESSAGES[kind]);
    this.name = 'AgentPackageReleaseFailure';
    this.kind = kind;
  }
}

interface ExactPackageObject {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface PreparedControlledTestPackage {
  idempotencyKey: string;
  packageDigest: CreatorAgentPackageDigest;
  objects: readonly ExactPackageObject[];
}

export interface StoredAgentPackageRelease {
  release: CreatorAgentPackageRelease;
  createdAt: string;
}

export interface AgentPackageReleaseRepository {
  createOrRead(input: {
    ownerUserId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    release: CreatorAgentPackageRelease;
  }): Promise<{ stored: StoredAgentPackageRelease; created: boolean }>;
  read(ownerUserId: string, releaseId: string): Promise<StoredAgentPackageRelease | null>;
}

interface ReleaseRow {
  release_id: string;
  package_digest: string;
  protocol: string;
  release_scope: string;
  request_sha256?: string;
  created_at: string | Date;
}

interface PackageMarkerRow {
  owner_user_id: string;
  protocol: string;
}

function storedReleaseFromRow(row: ReleaseRow): StoredAgentPackageRelease {
  if (row.release_scope !== AGENT_PACKAGE_RELEASE_SCOPE) {
    throw new AgentPackageReleaseFailure('unavailable');
  }
  try {
    return {
      release: createCreatorAgentPackageRelease({
        protocol: row.protocol,
        releaseId: row.release_id,
        packageDigest: row.package_digest,
      }),
      createdAt: toIso(row.created_at),
    };
  } catch {
    throw new AgentPackageReleaseFailure('unavailable');
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** PostgreSQL 0017 Registry 仓储；部署前必须先合入并应用该迁移。 */
export class PgAgentPackageReleaseRepository implements AgentPackageReleaseRepository {
  constructor(
    private readonly pool: TxPool,
    private readonly db: Queryable,
  ) {}

  async createOrRead(input: {
    ownerUserId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    release: CreatorAgentPackageRelease;
  }): Promise<{ stored: StoredAgentPackageRelease; created: boolean }> {
    return withTransaction(this.pool, async (tx: QueryableDb) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${input.ownerUserId}/${input.idempotencyKey}`,
      ]);

      const existing = await tx.query<ReleaseRow>(
        `SELECT release_id, package_digest, protocol, release_scope, request_sha256, created_at
           FROM agent_package_releases
          WHERE owner_user_id = $1 AND idempotency_key = $2::uuid`,
        [input.ownerUserId, input.idempotencyKey],
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        if (
          existingRow.request_sha256 !== input.requestFingerprint ||
          existingRow.package_digest !== input.release.packageDigest
        ) {
          throw new AgentPackageReleaseFailure('idempotency_conflict');
        }
        return { stored: storedReleaseFromRow(existingRow), created: false };
      }

      await tx.query(
        `INSERT INTO agent_packages (package_digest, protocol, owner_user_id)
         VALUES ($1, $2, $3::uuid)
         ON CONFLICT (package_digest) DO NOTHING`,
        [input.release.packageDigest, CREATOR_AGENT_PACKAGE_PROTOCOL, input.ownerUserId],
      );
      const marker = await tx.query<PackageMarkerRow>(
        `SELECT owner_user_id, protocol
           FROM agent_packages
          WHERE package_digest = $1`,
        [input.release.packageDigest],
      );
      const markerRow = marker.rows[0];
      if (
        markerRow === undefined ||
        markerRow.owner_user_id !== input.ownerUserId ||
        markerRow.protocol !== CREATOR_AGENT_PACKAGE_PROTOCOL
      ) {
        throw new AgentPackageReleaseFailure('state_conflict');
      }

      let inserted;
      try {
        inserted = await tx.query<ReleaseRow>(
          `INSERT INTO agent_package_releases
             (release_id, package_digest, owner_user_id, protocol, release_scope,
              idempotency_key, request_sha256)
           VALUES ($1, $2, $3::uuid, $4, $5, $6::uuid, $7)
           RETURNING release_id, package_digest, protocol, release_scope, created_at`,
          [
            input.release.releaseId,
            input.release.packageDigest,
            input.ownerUserId,
            CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL,
            AGENT_PACKAGE_RELEASE_SCOPE,
            input.idempotencyKey,
            input.requestFingerprint,
          ],
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new AgentPackageReleaseFailure('state_conflict');
        throw error;
      }
      const row = inserted.rows[0];
      if (row === undefined) throw new AgentPackageReleaseFailure('unavailable');
      return { stored: storedReleaseFromRow(row), created: true };
    });
  }

  async read(ownerUserId: string, releaseId: string): Promise<StoredAgentPackageRelease | null> {
    const result = await this.db.query<ReleaseRow>(
      `SELECT release_id, package_digest, protocol, release_scope, created_at
         FROM agent_package_releases
        WHERE release_id = $1 AND owner_user_id = $2::uuid`,
      [releaseId, ownerUserId],
    );
    const row = result.rows[0];
    return row === undefined ? null : storedReleaseFromRow(row);
  }
}

function decodeCanonicalBase64(value: string, maximumBytes: number): Uint8Array {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new AgentPackageReleaseFailure('validation');
  }
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes ||
    bytes.toString('base64') !== value
  ) {
    throw new AgentPackageReleaseFailure('validation');
  }
  return Uint8Array.from(bytes);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AgentPackageReleaseFailure('validation');
  }
}

function exactBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
    Buffer.from(right.buffer, right.byteOffset, right.byteLength),
  );
}

/** 严格解析 fixed Test profile；请求不能携带路径、owner、digest、Release 或 latest 选择器。 */
export function prepareControlledTestPackage(body: unknown): PreparedControlledTestPackage {
  const parsed = ControlledTestAgentPackageReleaseRequestSchema.safeParse(body);
  if (!parsed.success) throw new AgentPackageReleaseFailure('validation');

  const agentJson = decodeCanonicalBase64(
    parsed.data.agentJsonBase64,
    CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES,
  );
  const agentMarkdown = decodeCanonicalBase64(parsed.data.agentMarkdownBase64, MAX_MARKDOWN_BYTES);
  const knowledgeSkill = decodeCanonicalBase64(
    parsed.data.knowledgeSkillBase64,
    MAX_MARKDOWN_BYTES,
  );
  const knowledgeBundle = decodeCanonicalBase64(
    parsed.data.knowledgeBundleBase64,
    CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES,
  );

  let manifest;
  try {
    manifest = parseCreatorAgentPackageManifest(decodeUtf8(agentJson));
    resolveCreatorKnowledgeBundleResource(manifest);
    parseCreatorKnowledgeBundle(decodeUtf8(knowledgeBundle));
  } catch {
    throw new AgentPackageReleaseFailure('validation');
  }

  const exactFiles = new Map<string, Uint8Array>([
    ['AGENT.md', agentMarkdown],
    [CREATOR_KNOWLEDGE_SKILL_PATH, knowledgeSkill],
    [CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH, knowledgeBundle],
  ]);
  for (const file of manifest.files) {
    const bytes = exactFiles.get(file.path);
    if (
      bytes === undefined ||
      bytes.byteLength !== file.byteLength ||
      digestCreatorAgentPackageFile(bytes) !== file.digest
    ) {
      throw new AgentPackageReleaseFailure('validation');
    }
  }

  return {
    idempotencyKey: parsed.data.idempotencyKey,
    packageDigest: digestCreatorAgentPackage(manifest),
    objects: Object.freeze([
      { path: 'AGENT.md', bytes: agentMarkdown, contentType: 'text/markdown; charset=utf-8' },
      {
        path: CREATOR_KNOWLEDGE_SKILL_PATH,
        bytes: knowledgeSkill,
        contentType: 'text/markdown; charset=utf-8',
      },
      {
        path: CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
        bytes: knowledgeBundle,
        contentType: 'application/json',
      },
      { path: CREATOR_AGENT_PACKAGE_FILENAME, bytes: agentJson, contentType: 'application/json' },
    ]),
  };
}

export function agentPackageObjectKey(packageDigest: string, manifestPath: string): string {
  if (!PACKAGE_DIGEST_PATTERN.test(packageDigest) || !PACKAGE_OBJECT_PATHS.has(manifestPath)) {
    throw new AgentPackageReleaseFailure('validation');
  }
  return `agent-packages/sha256/${packageDigest.slice('sha256:'.length)}/${manifestPath}`;
}

export function agentPackageReleaseRequestFingerprint(input: {
  ownerUserId: string;
  idempotencyKey: string;
  packageDigest: string;
}): string {
  return createHash('sha256')
    .update('combo.agent-package-release-request/1\0', 'utf8')
    .update(input.ownerUserId, 'utf8')
    .update('\0', 'utf8')
    .update(input.idempotencyKey, 'utf8')
    .update('\0', 'utf8')
    .update(input.packageDigest, 'utf8')
    .digest('hex');
}

async function commitAndVerify(
  objectStore: ImmutableObjectStore,
  packageDigest: string,
  object: ExactPackageObject,
  signal?: AbortSignal,
): Promise<void> {
  const input = {
    bucket: AGENT_PACKAGE_OBJECT_BUCKET,
    key: agentPackageObjectKey(packageDigest, object.path),
    bytes: object.bytes,
    maxBytes: object.bytes.byteLength,
    contentType: object.contentType,
    ...(signal ? { signal } : {}),
  };
  try {
    await objectStore.commit(input);
    const readback = await objectStore.read(input);
    if (!exactBytesEqual(readback, object.bytes)) {
      throw new AgentPackageReleaseFailure('state_conflict');
    }
  } catch (error) {
    if (error instanceof AgentPackageReleaseFailure) throw error;
    if (error instanceof ImmutableObjectStoreError && error.failure === 'conflict') {
      throw new AgentPackageReleaseFailure('state_conflict');
    }
    throw new AgentPackageReleaseFailure('unavailable');
  }
}

export async function publishControlledTestAgentPackage(
  dependencies: {
    objectStore: ImmutableObjectStore;
    repository: AgentPackageReleaseRepository;
  },
  input: {
    ownerUserId: string;
    expectedPackageDigest: string;
    body: unknown;
    signal?: AbortSignal;
  },
): Promise<{ stored: StoredAgentPackageRelease; created: boolean }> {
  const prepared = prepareControlledTestPackage(input.body);
  if (prepared.packageDigest !== input.expectedPackageDigest) {
    throw new AgentPackageReleaseFailure('validation');
  }

  for (const object of prepared.objects) {
    await commitAndVerify(dependencies.objectStore, prepared.packageDigest, object, input.signal);
  }

  const requestFingerprint = agentPackageReleaseRequestFingerprint({
    ownerUserId: input.ownerUserId,
    idempotencyKey: prepared.idempotencyKey,
    packageDigest: prepared.packageDigest,
  });
  const release = createCreatorAgentPackageRelease({
    protocol: CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL,
    releaseId: `release.agent-package.${randomBytes(16).toString('hex')}`,
    packageDigest: prepared.packageDigest,
  });
  try {
    return await dependencies.repository.createOrRead({
      ownerUserId: input.ownerUserId,
      idempotencyKey: prepared.idempotencyKey,
      requestFingerprint,
      release,
    });
  } catch (error) {
    if (error instanceof AgentPackageReleaseFailure) throw error;
    throw new AgentPackageReleaseFailure('unavailable');
  }
}

export async function readControlledTestAgentPackageRelease(
  repository: AgentPackageReleaseRepository,
  ownerUserId: string,
  releaseId: string,
): Promise<StoredAgentPackageRelease | null> {
  try {
    return await repository.read(ownerUserId, releaseId);
  } catch (error) {
    if (error instanceof AgentPackageReleaseFailure) throw error;
    throw new AgentPackageReleaseFailure('unavailable');
  }
}
