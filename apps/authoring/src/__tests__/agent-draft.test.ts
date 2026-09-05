import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCreatorAgentPackageDraftSnapshotV2 } from '@cb/creator-agent-protocol/agent-package-draft';
import { AgentDraftService } from '../modules/agent-draft/service.js';
import {
  assertDisposableDraftDatabase,
  draftFixture,
  TestDraftRepository,
  TestObjects,
  uploadFixture,
} from './agent-draft-fixture.js';

const owner = randomUUID();
function setup() {
  const repository = new TestDraftRepository();
  const objects = new TestObjects();
  return { repository, objects, service: new AgentDraftService(repository, objects) };
}
describe('private Agent Draft synchronization', () => {
  it('rejects persistent databases and connection-target query overrides before connecting', () => {
    for (const url of [
      'postgres://localhost/agora',
      'postgres://localhost/combo_draft_test_review?host=remote.example.invalid',
      'postgres://localhost/combo_draft_test_abcdef?host=/tmp/combo-draft-pg.Safe123&host=remote.example.invalid',
      'postgres://localhost/combo_draft_test_review?dbname=production',
      'postgres://remote.example.invalid/combo_draft_test_review',
    ])
      expect(() => assertDisposableDraftDatabase(url)).toThrow();
    expect(() =>
      assertDisposableDraftDatabase('postgres://localhost/combo_draft_test_123abc'),
    ).not.toThrow();
    expect(() => assertDisposableDraftDatabase('postgres://localhost/agora', true)).not.toThrow();
  });
  it('saves and reads exact Draft, Package and receipt, projecting actual files without publishing', async () => {
    const { service, repository } = setup();
    const upload = uploadFixture();
    const saved = await service.save(owner, upload);
    const read = await service.read(owner, saved.record.draft.draftId, 1);
    expect(read).toEqual(saved.record);
    expect(read?.draft.text).toBe(upload.draftText);
    expect(read?.candidate.packageDigest).toBe(upload.candidate.packageDigest);
    expect(read?.candidate.compilationReceiptText).toBe(upload.candidate.compilationReceiptText);
    expect(read?.card.agent.compiled.files).toHaveLength(4);
    expect(Object.values(read?.card.actions ?? {})).toEqual(Array(6).fill(false));
    expect(read?.sourceVerification).toBe('not_verified');
    expect(read?.visibility).toBe('private');
    expect(read).not.toHaveProperty('release');
    expect(repository.rows).toHaveLength(1);
  });
  it.each(['unknown', 'noncanonical', 'digest', 'file', 'receipt', 'owner'])(
    'rejects %s tampering before any storage write',
    async (kind) => {
      const { service, objects, repository } = setup();
      const upload = uploadFixture();
      const raw = { ...upload } as Record<string, unknown>;
      if (kind === 'unknown') raw.extra = true;
      if (kind === 'owner') raw.owner = randomUUID();
      if (kind === 'noncanonical') raw.draftText = ` ${upload.draftText}`;
      if (kind === 'digest')
        raw.candidate = { ...upload.candidate, packageDigest: `sha256:${'0'.repeat(64)}` };
      if (kind === 'file') upload.candidate.files[0]!.text += 'tampered';
      if (kind === 'receipt') upload.candidate.compilationReceiptText += ' ';
      await expect(service.save(owner, raw)).rejects.toMatchObject({ kind: 'validation' });
      expect(objects.writes).toBe(0);
      expect(repository.rows).toHaveLength(0);
    },
  );
  it('serializes retries and preserves the original request result after newer revisions', async () => {
    const { service, objects } = setup();
    const first = uploadFixture();
    const results = await Promise.all(Array.from({ length: 5 }, () => service.save(owner, first)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(objects.writes).toBe(1);
    await expect(
      service.save(owner, uploadFixture(draftFixture(), first.requestId)),
    ).rejects.toMatchObject({ kind: 'idempotency_conflict' });
  });
  it('rejects stale revisions; A to B to A preserves exact package identity and one card', async () => {
    const { service } = setup();
    const first = draftFixture();
    const saved = await service.save(owner, uploadFixture(first));
    const { draftFingerprint: firstFingerprint, ...firstInput } = first;
    const next = createCreatorAgentPackageDraftSnapshotV2({
      ...firstInput,
      revision: 2,
      parentDraftFingerprint: firstFingerprint,
      content: { ...first.content, name: '修改后的助手' },
    });
    const middle = await service.save(owner, uploadFixture(next));
    await expect(service.save(owner, uploadFixture(next))).rejects.toMatchObject({
      kind: 'revision_conflict',
    });
    const { draftFingerprint: nextFingerprint, ...nextInput } = next;
    const restored = createCreatorAgentPackageDraftSnapshotV2({
      ...nextInput,
      revision: 3,
      parentDraftFingerprint: nextFingerprint,
      content: first.content,
    });
    const last = await service.save(owner, uploadFixture(restored));
    expect(last.record.candidate.packageDigest).toBe(saved.record.candidate.packageDigest);
    expect(middle.record.candidate.packageDigest).not.toBe(saved.record.candidate.packageDigest);
    expect(last.record.card.viewId).toBe(saved.record.card.viewId);
    expect(last.record.card.sequence).toBe(3);
  });
  it('returns no other owner data and rejects corrupted stored bytes', async () => {
    const { service, objects } = setup();
    const saved = await service.save(owner, uploadFixture());
    expect(await service.read(randomUUID(), saved.record.draft.draftId, 1)).toBeNull();
    for (const key of objects.values.keys()) objects.values.set(key, new Uint8Array([0]));
    await expect(service.read(owner, saved.record.draft.draftId, 1)).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
  it.each(['source', 'creatorRequest', 'no-op'])(
    'rejects a revision changing %s before new storage writes',
    async (kind) => {
      const { service, repository, objects } = setup();
      const first = draftFixture();
      await service.save(owner, uploadFixture(first));
      const { draftFingerprint, ...input } = first;
      const next = createCreatorAgentPackageDraftSnapshotV2({
        ...input,
        revision: 2,
        parentDraftFingerprint: draftFingerprint,
        source:
          kind === 'source'
            ? { ...input.source, snapshotCommitment: `sha256:${'b'.repeat(64)}` }
            : input.source,
        creatorRequest:
          kind === 'creatorRequest'
            ? { ...input.creatorRequest, request: '另一项制作要求' }
            : input.creatorRequest,
        content: kind === 'no-op' ? input.content : { ...input.content, name: '修改后的名称' },
      });
      await expect(service.save(owner, uploadFixture(next))).rejects.toMatchObject({
        kind: 'revision_conflict',
      });
      expect(objects.writes).toBe(1);
      expect(repository.rows).toHaveLength(1);
    },
  );
  it('does not insert metadata when object commit succeeds but readback differs', async () => {
    const { repository, objects } = setup();
    const service = new AgentDraftService(repository, {
      commit: (input) => objects.commit(input),
      read: async () => new Uint8Array([0]),
    });
    await expect(service.save(owner, uploadFixture())).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(objects.writes).toBe(1);
    expect(repository.rows).toHaveLength(0);
  });
  it('does not commit a revision after object storage failure', async () => {
    const { service, objects, repository } = setup();
    objects.fail = true;
    await expect(service.save(owner, uploadFixture())).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(repository.rows).toHaveLength(0);
  });
  it('normalizes UUID spelling before locking and constructing private object keys', async () => {
    const { service, repository, objects } = setup();
    const upload = uploadFixture();
    await service.save(owner.toUpperCase(), {
      ...upload,
      requestId: upload.requestId.toUpperCase(),
    });
    await service.save(owner, upload);
    expect(repository.rows).toHaveLength(1);
    expect(objects.writes).toBe(1);
  });
});
