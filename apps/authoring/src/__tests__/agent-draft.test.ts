import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCreatorAgentPackageDraftSnapshotV2 } from '@cb/creator-agent-protocol/agent-package-draft';
import { AgentDraftService, inspectAgentContextUpload } from '../modules/agent-draft/service.js';
import {
  assertDisposableDraftDatabase,
  contextUploadFixture,
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
    if (read?.protocol !== 'combo.agent-draft-record/1') throw new Error('wrong record protocol');
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

describe('private available-context synchronization', () => {
  it('dispatches the independent strict upload and returns the exact private record contract', async () => {
    const { service, repository, objects } = setup();
    const upload = contextUploadFixture();
    expect(inspectAgentContextUpload(upload)).toEqual({
      requestId: upload.requestId,
      name: '证据检查助手',
      draftFingerprint: JSON.parse(upload.draftText).draftFingerprint,
      packageDigest: upload.candidate.packageDigest,
    });
    const { record, created } = await service.save(owner, upload);
    expect(created).toBe(true);
    expect(record.protocol).toBe('combo.agent-context-record/1');
    expect(record.storage).toEqual({
      draftId: expect.stringMatching(/^draft\.agent-package\.[a-f0-9]{32}$/u),
      revision: 1,
    });
    expect(record.draft).toEqual({
      protocol: 'combo.agent-context-draft/1',
      fingerprint: JSON.parse(upload.draftText).draftFingerprint,
      text: upload.draftText,
    });
    expect(record.candidate).toEqual(upload.candidate);
    expect(record.candidate).not.toHaveProperty('compilationReceiptText');
    expect(record).not.toHaveProperty('release');
    expect(record.sourceVerification).toBe('not_verified');
    expect(record.visibility).toBe('private');
    expect(record.card.agent.name).toBe('证据检查助手');
    expect(record.card.agent.sourceSummary).toContain('覆盖可能不完整');
    expect(record.card.agent.compiled.files).toHaveLength(4);
    expect(record.card.agent.compiled.packageDigest).toBe(upload.candidate.packageDigest);
    expect(Object.values(record.card.actions)).toEqual(Array(6).fill(false));
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      owner_user_id: owner,
      draft_id: record.storage.draftId,
      revision: 1,
      parent_fingerprint: null,
      draft_fingerprint: record.draft.fingerprint,
      package_digest: record.candidate.packageDigest,
    });
    expect([...objects.values.keys()][0]).toContain(
      `private-agent-drafts/${owner}/${record.storage.draftId}/`,
    );
  });
  it.each([
    'owner',
    'requestId',
    'protocol',
    'noncanonical',
    'source',
    'fingerprint',
    'manifest',
    'digest',
    'file',
    'extra-file',
    'duplicate-file',
    'path',
    'receipt',
    'v2-draft',
  ])('rejects %s drift before object or metadata writes', async (kind) => {
    const { service, objects, repository } = setup();
    const upload = contextUploadFixture();
    const body = structuredClone(upload) as Record<string, unknown>;
    const draft = JSON.parse(upload.draftText);
    if (kind === 'owner') body.ownerUserId = randomUUID();
    if (kind === 'requestId') body.requestId = 'not-a-uuid';
    if (kind === 'protocol') body.protocol = 'combo.agent-draft-upload/1';
    if (kind === 'noncanonical') body.draftText = ` ${upload.draftText}`;
    if (kind === 'source') {
      draft.source.verification = 'verified';
      body.draftText = JSON.stringify(draft);
    }
    if (kind === 'fingerprint')
      body.draftText = upload.draftText.replace(draft.draftFingerprint, `sha256:${'0'.repeat(64)}`);
    if (kind === 'manifest')
      body.candidate = { ...upload.candidate, manifestText: `${upload.candidate.manifestText}\n` };
    if (kind === 'digest')
      body.candidate = { ...upload.candidate, packageDigest: `sha256:${'0'.repeat(64)}` };
    if (kind === 'file') upload.candidate.files[0]!.text += 'tamper';
    if (kind === 'extra-file') upload.candidate.files.push({ path: 'extra.txt', text: 'extra' });
    if (kind === 'duplicate-file') upload.candidate.files[1] = { ...upload.candidate.files[0]! };
    if (kind === 'path') upload.candidate.files[0]!.path = '../AGENT.md';
    if (['file', 'extra-file', 'duplicate-file', 'path'].includes(kind))
      body.candidate = upload.candidate;
    if (kind === 'receipt')
      body.candidate = { ...upload.candidate, compilationReceiptText: 'forged' };
    if (kind === 'v2-draft') body.draftText = uploadFixture().draftText;
    await expect(service.save(owner, body)).rejects.toMatchObject({ kind: 'validation' });
    expect(() => inspectAgentContextUpload(body)).toThrow('Agent Draft validation');
    expect(objects.writes).toBe(0);
    expect(repository.rows).toHaveLength(0);
  });
  it('keeps the explicit context-only entry mutually exclusive with V2', async () => {
    const { service, objects } = setup();
    await expect(service.saveContext(owner, uploadFixture())).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(
      service.saveContext('invalid-owner', contextUploadFixture()),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(objects.writes).toBe(0);
  });
  it('serializes reordered and mixed-case retries and reopens after rebuilding the service', async () => {
    const { service, objects, repository } = setup();
    const upload = contextUploadFixture();
    const reordered = {
      ...upload,
      requestId: upload.requestId.toUpperCase(),
      candidate: { ...upload.candidate, files: [...upload.candidate.files].reverse() },
    };
    const results = await Promise.all([
      service.saveContext(owner, upload),
      service.saveContext(owner.toUpperCase(), reordered),
      service.save(owner, upload),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(objects.writes).toBe(1);
    expect(repository.rows).toHaveLength(1);
    const restarted = new AgentDraftService(repository, objects);
    const record = results[0]!.record;
    expect(await restarted.read(owner.toUpperCase(), record.storage.draftId, 1)).toEqual(record);
    expect(await restarted.saveContext(owner, upload)).toEqual({ created: false, record });
    await expect(
      restarted.saveContext(owner, contextUploadFixture(upload.requestId, '另一项方法')),
    ).rejects.toMatchObject({ kind: 'idempotency_conflict' });
    expect(objects.writes).toBe(1);
  });
  it('keeps exact same content private to each owner and each independent upload', async () => {
    const { service, repository, objects } = setup();
    const secondOwner = randomUUID();
    const upload = contextUploadFixture();
    const first = await service.saveContext(owner, upload);
    expect(await service.read(secondOwner, first.record.storage.draftId, 1)).toBeNull();
    const second = await service.saveContext(secondOwner, upload);
    const separate = await service.saveContext(owner, { ...upload, requestId: randomUUID() });
    expect(second.record.storage.draftId).not.toBe(first.record.storage.draftId);
    expect(separate.record.storage.draftId).not.toBe(first.record.storage.draftId);
    expect(second.record.candidate).toEqual(first.record.candidate);
    expect(await service.read(owner, second.record.storage.draftId, 1)).toBeNull();
    expect(await service.read(owner, first.record.storage.draftId, 2)).toBeNull();
    expect(repository.rows).toHaveLength(3);
    expect(objects.values.size).toBe(3);
  });
  it('does not allow a V2 revision to turn a saved context into attested source', async () => {
    const { service, repository, objects } = setup();
    const first = await service.saveContext(owner, contextUploadFixture());
    const { draftFingerprint: _fingerprint, ...v2 } = draftFixture();
    const revision = createCreatorAgentPackageDraftSnapshotV2({
      ...v2,
      draftId: first.record.storage.draftId,
      revision: 2,
      parentDraftFingerprint: first.record.draft.fingerprint,
    });
    await expect(service.save(owner, uploadFixture(revision))).rejects.toMatchObject({
      kind: 'revision_conflict',
    });
    expect(objects.writes).toBe(1);
    expect(repository.rows).toHaveLength(1);
  });
  it.each(['commit', 'readback', 'lost-response'])(
    'recovers from %s failure without publishing or overwriting an object',
    async (mode) => {
      const { objects, repository } = setup();
      let reads = 0;
      const broken = new AgentDraftService(repository, {
        commit: async (input) => {
          if (mode === 'commit') throw new Error('private-failure');
          return objects.commit(input);
        },
        read: async (input) => {
          reads++;
          if (mode === 'readback' || (mode === 'lost-response' && reads === 2))
            throw new Error('private-failure');
          return objects.read(input);
        },
      });
      const upload = contextUploadFixture();
      await expect(broken.saveContext(owner, upload)).rejects.toMatchObject({
        kind: 'unavailable',
      });
      expect(repository.rows).toHaveLength(mode === 'lost-response' ? 1 : 0);
      const recovered = await new AgentDraftService(repository, objects).saveContext(owner, upload);
      expect(recovered.created).toBe(mode !== 'lost-response');
      expect(objects.values.size).toBe(1);
      expect(repository.rows).toHaveLength(1);
    },
  );
  it('fails closed on corrupted durable bytes and does not overwrite on replay', async () => {
    const { service, repository, objects } = setup();
    const upload = contextUploadFixture();
    const saved = await service.saveContext(owner, upload);
    for (const key of objects.values.keys()) objects.values.set(key, new Uint8Array([0]));
    await expect(service.read(owner, saved.record.storage.draftId, 1)).rejects.toMatchObject({
      kind: 'unavailable',
    });
    await expect(service.saveContext(owner, upload)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(objects.writes).toBe(1);
    expect(repository.rows).toHaveLength(1);
  });
});
