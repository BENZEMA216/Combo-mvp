// Test 演示服务：幂等复用 Studio，并在没有当前 UI 时安装固定、可真实运行的 Miniapp。
import { createHash } from 'node:crypto';
import type { RuntimeDb } from '../../platform/infra/db.js';
import { withTransaction } from '../../platform/infra/db.js';
import type { RuntimeObjectStore } from '../../platform/infra/object-store.js';
import {
  ARTIFACT_BUCKET,
  artifactStorageKey,
  bindCapabilitySeedUiArtifactIfEmpty,
  contentTypeFor,
  readCapabilityUiArtifact,
  readLatestHtmlArtifactInSession,
  seedCapabilityUiArtifact,
  upsertArtifact,
} from '../artifact/repo.js';
import { validateStudioHtml } from '../artifact/studio-contract.js';
import { getOrCreateStudioSession } from '../session/repo.js';
import { COMBO_MINIAPP_DEMO_HTML, COMBO_MINIAPP_FIXTURE } from './fixture.js';
import { readActiveDemoStudioSession } from './repo.js';

export interface ComboMiniappDemoStudioResult {
  studioSessionId: string;
  reused: boolean;
}

function fixtureArtifactId(studioSessionId: string): string {
  const digest = createHash('sha256')
    .update(`combo-miniapp:${COMBO_MINIAPP_FIXTURE.fixtureVersion}:${studioSessionId}`)
    .digest('hex');
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function isComboMiniappFixtureMeta(meta: Record<string, unknown>): boolean {
  return (
    meta.source === COMBO_MINIAPP_FIXTURE.source &&
    meta.fixture === COMBO_MINIAPP_FIXTURE.fixture &&
    meta.fixtureVersion === COMBO_MINIAPP_FIXTURE.fixtureVersion
  );
}

async function installComboMiniappFixture(
  db: RuntimeDb,
  objectStore: RuntimeObjectStore,
  input: { capabilityId: string; ownerUserId: string; studioSessionId: string },
): Promise<void> {
  const validation = validateStudioHtml(COMBO_MINIAPP_DEMO_HTML);
  if (!validation.ok) {
    throw new Error(`Combo Miniapp fixture contract invalid: ${validation.errors.join('; ')}`);
  }

  const artifactId = fixtureArtifactId(input.studioSessionId);
  const storageKey = artifactStorageKey(input.studioSessionId, artifactId);
  const content = new TextEncoder().encode(COMBO_MINIAPP_DEMO_HTML);

  await withTransaction(db, async (tx) => {
    const target = await tx.query<{ id: string }>(
      `SELECT id
         FROM sessions
        WHERE id = $1
          AND capability_id = $2
          AND owner_user_id = $3
          AND mode = $4
          AND status = 'active'
        FOR UPDATE`,
      [input.studioSessionId, input.capabilityId, input.ownerUserId, 'studio'],
    );
    if (!target.rows[0]) {
      throw new Error('installComboMiniappFixture: target session identity mismatch');
    }

    // 任何已经晋升的真实 UI 都优先；Test 补种不能覆盖用户后续修改。
    if (await readCapabilityUiArtifact(tx, input.capabilityId)) return;

    const existing = await readLatestHtmlArtifactInSession(tx, input.studioSessionId);
    if (existing) {
      if (existing.turnId === null && isComboMiniappFixtureMeta(existing.meta)) {
        const rebound = await bindCapabilitySeedUiArtifactIfEmpty(tx, {
          capabilityId: input.capabilityId,
          artifactId: existing.id,
          studioSessionId: input.studioSessionId,
        });
        if (rebound || (await readCapabilityUiArtifact(tx, input.capabilityId))) return;
      }
      throw new Error('installComboMiniappFixture: studio already contains an unbound UI');
    }

    // 对象键由 Session 与 fixture 版本确定；数据库失败后的重试只会覆盖同一个孤儿键。
    await objectStore.putObject(ARTIFACT_BUCKET, storageKey, content, {
      contentType: contentTypeFor('html'),
    });
    await upsertArtifact(tx, {
      id: artifactId,
      sessionId: input.studioSessionId,
      kind: 'html',
      title: 'Combo Miniapp 设计助手',
      storageKey,
      meta: { ...COMBO_MINIAPP_FIXTURE, seed: true },
    });
    const bound = await bindCapabilitySeedUiArtifactIfEmpty(tx, {
      capabilityId: input.capabilityId,
      artifactId,
      studioSessionId: input.studioSessionId,
    });
    if (!bound && !(await readCapabilityUiArtifact(tx, input.capabilityId))) {
      throw new Error('installComboMiniappFixture: current UI pointer was not bound');
    }
  });
}

/** 返回可立即打开的 Studio；重复请求复用同一 Session 和同一固定 Artifact。 */
export async function getOrCreateComboMiniappDemoStudio(
  db: RuntimeDb,
  objectStore: RuntimeObjectStore,
  input: { capabilityId: string; ownerUserId: string },
): Promise<ComboMiniappDemoStudioResult> {
  const previous = await readActiveDemoStudioSession(db, input.capabilityId, input.ownerUserId);
  const session = await getOrCreateStudioSession(db, input);

  // 若 Capability 已有当前 UI，沿用生产路径恢复会话快照；没有时再安装固定 Test 页面。
  const seeded = await seedCapabilityUiArtifact(db, objectStore, {
    capabilityId: input.capabilityId,
    targetSessionId: session.id,
    targetOwnerUserId: input.ownerUserId,
    targetMode: 'studio',
  });
  if (!seeded || !(await readCapabilityUiArtifact(db, input.capabilityId))) {
    await installComboMiniappFixture(db, objectStore, {
      ...input,
      studioSessionId: session.id,
    });
  }

  return {
    studioSessionId: session.id,
    reused: previous?.id === session.id,
  };
}
