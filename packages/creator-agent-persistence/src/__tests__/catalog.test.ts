import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  CREATOR_AGENT_DEFINITION_PROTOCOL,
  CREATOR_AGENT_DEFINITION_V2_PROTOCOL,
  createCreatorAgentDefinitionV2,
  createCreatorAgentDraftHandoff,
  createCreatorAgentDraftHandoffV2,
  createCreatorAgentDraftSnapshot,
  createCreatorAgentDraftSnapshotV2,
  createCreatorAgentProjectSourceLedger,
  freezeCreatorAgentVersion,
  serializeCreatorAgentDraftSnapshot,
  serializeCreatorAgentDraftHandoff,
  serializeCreatorAgentDraftHandoffV2,
  serializeCreatorAgentVersion,
  type CreatorAgentDraftSnapshot,
  type CreatorAgentDraftSnapshotV1,
} from '@cb/creator-agent-protocol/agent';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createFreshCreatorAgentCatalog,
  openExistingCreatorAgentCatalog,
  type CreatorAgentCatalog,
  type CreatorAgentCatalogOptions,
} from '../index.js';

const roots: string[] = [];
const catalogs: CreatorAgentCatalog[] = [];

afterEach(() => {
  for (const catalog of catalogs.splice(0).reverse()) {
    try {
      catalog.close();
    } catch {
      // Individual tests assert close failures when relevant.
    }
  }
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('Creator Agent SQLite catalog', () => {
  it('imports, reviews, freezes, replays, and reopens one exact Version', () => {
    const fixture = catalogFixture();
    const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
    const first = draft(1, null);
    const handoff = handoffText(first);

    expect(catalog.importDraftHandoff(handoff)).toMatchObject({
      disposition: 'IMPORTED',
      draft: first,
    });
    expect(catalog.importDraftHandoff(handoff)).toMatchObject({
      disposition: 'EXACT_REPLAY',
      draft: first,
    });
    const review = catalog.createFreezeReview(ref(first));
    expect(review.draft).toEqual(first);
    expect(review.confirmationText).toContain(first.draftFingerprint);
    expect(review.confirmationText).toContain('draftRevision=1');
    expect(() =>
      catalog.freezeDraft({ ref: ref(first), confirmationText: `${review.confirmationText} ` }),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_CONFIRMATION_MISMATCH' }));

    const created = catalog.freezeDraft({
      ref: ref(first),
      confirmationText: review.confirmationText,
    });
    expect(created.disposition).toBe('CREATED');
    const replay = catalog.freezeDraft({
      ref: ref(first),
      confirmationText: review.confirmationText,
    });
    expect(replay).toEqual({ disposition: 'EXACT_REPLAY', version: created.version });
    expect(catalog.listAgents()).toEqual([
      expect.objectContaining({
        agentId: first.agentId,
        latestDraftRevision: 1,
        latestVersionNumber: 1,
      }),
    ]);

    catalog.close();
    const reopened = track(openExistingCreatorAgentCatalog(fixture.options));
    expect(reopened.importDraftHandoff(handoff)).toEqual({
      disposition: 'EXACT_REPLAY',
      draft: first,
    });
    expect(
      reopened.freezeDraft({ ref: ref(first), confirmationText: review.confirmationText }),
    ).toEqual({ disposition: 'EXACT_REPLAY', version: created.version });
    expect(reopened.readDraft(ref(first))).toEqual(first);
    expect(
      reopened.readVersion({ agentId: first.agentId, versionId: created.version.versionId }),
    ).toEqual(created.version);
    expect(reopened.listVersions(first.agentId)).toEqual([created.version]);
  });

  it('auto-freezes only one exact local unpublished Draft without claiming review', () => {
    const fixture = catalogFixture();
    const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
    const first = draft(1, null);
    catalog.importDraftHandoff(handoffText(first));

    expect(() =>
      catalog.freezeDraftForLocalExperience({
        ref: ref(first),
        draftFingerprint: `sha256:${'f'.repeat(64)}` as typeof first.draftFingerprint,
        authorization: 'LOCAL_UNPUBLISHED_AUTO_FREEZE_V1',
      }),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_CONFIRMATION_MISMATCH' }));
    expect(catalog.listVersions(first.agentId)).toEqual([]);

    const request = {
      ref: ref(first),
      draftFingerprint: first.draftFingerprint,
      authorization: 'LOCAL_UNPUBLISHED_AUTO_FREEZE_V1' as const,
    };
    const created = catalog.freezeDraftForLocalExperience(request);
    expect(created.disposition).toBe('CREATED');
    expect(catalog.freezeDraftForLocalExperience(request)).toEqual({
      disposition: 'EXACT_REPLAY',
      version: created.version,
    });

    catalog.close();
    const reopened = track(openExistingCreatorAgentCatalog(fixture.options));
    expect(reopened.freezeDraftForLocalExperience(request)).toEqual({
      disposition: 'EXACT_REPLAY',
      version: created.version,
    });
  });

  it('enforces a dense Draft lineage and exact base Version', () => {
    const fixture = catalogFixture();
    const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
    const first = draft(1, null);
    catalog.importDraftHandoff(handoffText(first));
    const firstReview = catalog.createFreezeReview(ref(first));
    const firstVersion = catalog.freezeDraft({
      ref: ref(first),
      confirmationText: firstReview.confirmationText,
    }).version;
    const second = draft(2, firstVersion.versionId, 'Second reviewed behavior.');
    expect(catalog.importDraftHandoff(handoffText(second)).disposition).toBe('IMPORTED');
    const secondReview = catalog.createFreezeReview(ref(second));
    const secondVersion = catalog.freezeDraft({
      ref: ref(second),
      confirmationText: secondReview.confirmationText,
    }).version;
    expect(secondVersion.versionNumber).toBe(2);
    expect(secondVersion.sourceDraft.draftRevision).toBe(2);

    expect(() =>
      catalog.importDraftHandoff(handoffText(draft(4, secondVersion.versionId))),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_DRAFT_CONFLICT' }));
    expect(() => catalog.importDraftHandoff(handoffText(draft(3, firstVersion.versionId)))).toThrow(
      expect.objectContaining({ code: 'CATALOG_DRAFT_CONFLICT' }),
    );
  });

  it('imports, freezes, and reopens V1 and V2 rows without a schema migration', () => {
    const fixture = catalogFixture();
    const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
    const v1 = draft(1, null);
    const v2 = projectDraft();
    catalog.importDraftHandoff(handoffText(v1));
    catalog.importDraftHandoff(projectHandoffText(v2));
    const v1Review = catalog.createFreezeReview(ref(v1));
    const v2Review = catalog.createFreezeReview(ref(v2));
    const v1Version = catalog.freezeDraft({
      ref: ref(v1),
      confirmationText: v1Review.confirmationText,
    }).version;
    const v2Version = catalog.freezeDraft({
      ref: ref(v2),
      confirmationText: v2Review.confirmationText,
    }).version;
    catalog.close();

    const reopened = track(openExistingCreatorAgentCatalog(fixture.options));
    expect(reopened.importDraftHandoff(projectHandoffText(v2))).toMatchObject({
      disposition: 'EXACT_REPLAY',
      draft: v2,
    });
    expect(reopened.readVersion({ agentId: v1.agentId, versionId: v1Version.versionId })).toEqual(
      v1Version,
    );
    expect(reopened.readVersion({ agentId: v2.agentId, versionId: v2Version.versionId })).toEqual(
      v2Version,
    );
  });

  it('invalidates an old review when a newer unfrozen Draft arrives', () => {
    const fixture = catalogFixture();
    const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
    const first = draft(1, null);
    catalog.importDraftHandoff(handoffText(first));
    const review = catalog.createFreezeReview(ref(first));
    const second = draft(2, null, 'New behavior before any freeze.');
    catalog.importDraftHandoff(handoffText(second));

    expect(() =>
      catalog.freezeDraft({ ref: ref(first), confirmationText: review.confirmationText }),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_DRAFT_NOT_CURRENT' }));
    expect(catalog.createFreezeReview(ref(second)).draft.draftRevision).toBe(2);
  });

  it('rejects accessor-backed public inputs without reading them', () => {
    const fixture = catalogFixture();
    let optionReads = 0;
    const unsafeOptions = { filename: fixture.options.filename } as Record<string, unknown>;
    Object.defineProperty(unsafeOptions, 'catalogIdentity', {
      enumerable: true,
      get() {
        optionReads += 1;
        return fixture.options.catalogIdentity;
      },
    });
    expect(() =>
      createFreshCreatorAgentCatalog(unsafeOptions as CreatorAgentCatalogOptions),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_PATH_INVALID' }));
    expect(optionReads).toBe(0);
    expect(existsSync(fixture.options.filename)).toBe(false);
    const revokedOptions = Proxy.revocable({}, {});
    revokedOptions.revoke();
    expect(() => createFreshCreatorAgentCatalog(revokedOptions.proxy as never)).toThrow(
      expect.objectContaining({ code: 'CATALOG_PATH_INVALID' }),
    );

    const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
    const first = draft(1, null);
    catalog.importDraftHandoff(handoffText(first));
    const review = catalog.createFreezeReview(ref(first));
    let confirmationReads = 0;
    const unsafeFreeze = { ref: ref(first) } as Record<string, unknown>;
    Object.defineProperty(unsafeFreeze, 'confirmationText', {
      enumerable: true,
      get() {
        confirmationReads += 1;
        return review.confirmationText;
      },
    });
    expect(() => catalog.freezeDraft(unsafeFreeze as never)).toThrow(
      expect.objectContaining({ code: 'CATALOG_CONFIRMATION_MISMATCH' }),
    );
    expect(confirmationReads).toBe(0);
    expect(catalog.listVersions(first.agentId)).toEqual([]);
    const revokedRef = Proxy.revocable({}, {});
    revokedRef.revoke();
    expect(() => catalog.readDraft(revokedRef.proxy as never)).toThrow(
      expect.objectContaining({ code: 'CATALOG_NOT_FOUND' }),
    );
    const revokedFreeze = Proxy.revocable({}, {});
    revokedFreeze.revoke();
    expect(() => catalog.freezeDraft(revokedFreeze.proxy as never)).toThrow(
      expect.objectContaining({ code: 'CATALOG_CONFIRMATION_MISMATCH' }),
    );
    let fingerprintReads = 0;
    const unsafeExperienceFreeze = {
      ref: ref(first),
      authorization: 'LOCAL_UNPUBLISHED_AUTO_FREEZE_V1',
    } as Record<string, unknown>;
    Object.defineProperty(unsafeExperienceFreeze, 'draftFingerprint', {
      enumerable: true,
      get() {
        fingerprintReads += 1;
        return first.draftFingerprint;
      },
    });
    expect(() => catalog.freezeDraftForLocalExperience(unsafeExperienceFreeze as never)).toThrow(
      expect.objectContaining({ code: 'CATALOG_CONFIRMATION_MISMATCH' }),
    );
    expect(fingerprintReads).toBe(0);
  });

  it('rejects noncanonical handoffs and conflicting Draft identity before writes', () => {
    const fixture = catalogFixture();
    const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
    const first = draft(1, null);
    const text = handoffText(first);
    expect(() => catalog.importDraftHandoff(`${text}\n`)).toThrow(
      expect.objectContaining({ code: 'CATALOG_HANDOFF_INVALID' }),
    );
    catalog.importDraftHandoff(text);
    const reusedDraftId = createCreatorAgentDraftSnapshot({
      agentId: 'agent.other',
      draftId: first.draftId,
      draftRevision: 1,
      baseVersionId: null,
      definition: first.definition,
    });
    expect(() => catalog.importDraftHandoff(handoffText(reusedDraftId))).toThrow(
      expect.objectContaining({ code: 'CATALOG_DRAFT_CONFLICT' }),
    );
    const conflicting = { ...first, draftFingerprint: `sha256:${'f'.repeat(64)}` };
    expect(() =>
      catalog.importDraftHandoff(
        JSON.stringify({
          protocol: 'combo.creator-agent-draft-handoff/1',
          intent: 'import_local_draft',
          draft: conflicting,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_HANDOFF_INVALID' }));
    expect(catalog.listDrafts(first.agentId)).toEqual([first]);
  });

  it('fails closed on identity mismatch, row tampering, and concurrent open', () => {
    const fixture = catalogFixture();
    const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
    const first = draft(1, null);
    catalog.importDraftHandoff(handoffText(first));
    expect(() => openExistingCreatorAgentCatalog(fixture.options)).toThrow(
      expect.objectContaining({ code: 'CATALOG_BUSY' }),
    );
    catalog.close();
    expect(() =>
      openExistingCreatorAgentCatalog({ ...fixture.options, catalogIdentity: 'catalog.other' }),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_SCHEMA_MISMATCH' }));

    const database = new DatabaseSync(fixture.options.filename);
    database.exec(
      `UPDATE agent_catalog_agents
          SET latest_draft_revision = 2
        WHERE agent_id = 'agent.release-review'`,
    );
    database.close();
    expect(() => openExistingCreatorAgentCatalog(fixture.options)).toThrow(
      expect.objectContaining({ code: 'CATALOG_CORRUPT' }),
    );
  });

  it('classifies malformed stored identifiers as corruption', () => {
    const fixture = catalogFixture();
    const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
    const first = draft(1, null);
    catalog.importDraftHandoff(handoffText(first));
    catalog.close();
    const database = new DatabaseSync(fixture.options.filename);
    database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
    database
      .prepare('UPDATE agent_catalog_drafts SET agent_id = ? WHERE agent_id = ?')
      .run('bad!', first.agentId);
    database
      .prepare('UPDATE agent_catalog_agents SET agent_id = ? WHERE agent_id = ?')
      .run('bad!', first.agentId);
    database.exec('COMMIT');
    database.close();

    expect(() => openExistingCreatorAgentCatalog(fixture.options)).toThrow(
      expect.objectContaining({ code: 'CATALOG_CORRUPT' }),
    );
  });

  it('rejects a validly fingerprinted Version chain whose source Drafts run backward', () => {
    const fixture = catalogFixture();
    const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
    catalog.close();
    const first = draft(1, null, 'First behavior.');
    const second = draft(2, 'version.two', 'Second behavior.');
    const versions = [
      freezeCreatorAgentVersion({
        versionId: 'version.one',
        versionNumber: 1,
        createdAtMs: 2,
        draft: second,
      }),
      freezeCreatorAgentVersion({
        versionId: 'version.two',
        versionNumber: 2,
        createdAtMs: 3,
        draft: first,
      }),
    ];
    const database = new DatabaseSync(fixture.options.filename);
    database.exec('BEGIN IMMEDIATE');
    database
      .prepare(
        `INSERT INTO agent_catalog_agents
           (agent_id, draft_id, latest_draft_revision, latest_version_number,
            latest_version_id, created_at_ms)
         VALUES (?, ?, 2, 2, ?, 1)`,
      )
      .run(first.agentId, first.draftId, versions[1]!.versionId);
    const draftInsert = database.prepare(
      `INSERT INTO agent_catalog_drafts
         (agent_id, draft_id, draft_revision, base_version_id, definition_fingerprint,
          draft_fingerprint, handoff_json, draft_json, imported_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const value of [first, second]) {
      draftInsert.run(
        value.agentId,
        value.draftId,
        value.draftRevision,
        value.baseVersionId,
        value.definitionFingerprint,
        value.draftFingerprint,
        handoffText(value),
        serializeCreatorAgentDraftSnapshot(value),
        value.draftRevision,
      );
    }
    const versionInsert = database.prepare(
      `INSERT INTO agent_catalog_versions
         (agent_id, version_id, version_number, source_draft_id, source_draft_revision,
          source_draft_fingerprint, definition_fingerprint, version_fingerprint,
          version_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const version of versions) {
      versionInsert.run(
        version.agentId,
        version.versionId,
        version.versionNumber,
        version.sourceDraft.draftId,
        version.sourceDraft.draftRevision,
        version.sourceDraft.draftFingerprint,
        version.definitionFingerprint,
        version.versionFingerprint,
        serializeCreatorAgentVersion(version),
        version.createdAtMs,
      );
    }
    database.exec('COMMIT');
    database.close();

    expect(() => openExistingCreatorAgentCatalog(fixture.options)).toThrow(
      expect.objectContaining({ code: 'CATALOG_CORRUPT' }),
    );
  });

  it('keeps the private file after close and rejects create-overwrite', () => {
    const fixture = catalogFixture();
    const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
    catalog.close();
    expect(() => createFreshCreatorAgentCatalog(fixture.options)).toThrow(
      expect.objectContaining({ code: 'CATALOG_EXISTS' }),
    );
    const reopened = track(openExistingCreatorAgentCatalog(fixture.options));
    reopened.close();
    expect(() => reopened.listAgents()).toThrow(
      expect.objectContaining({ code: 'CATALOG_CLOSED' }),
    );
  });

  it('rejects dangling SQLite sidecar symlinks before creating a fresh catalog', () => {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const fixture = catalogFixture();
      const sidecar = `${fixture.options.filename}${suffix}`;
      symlinkSync('missing-target', sidecar);
      expect(() => createFreshCreatorAgentCatalog(fixture.options)).toThrow(
        expect.objectContaining({ code: 'CATALOG_EXISTS' }),
      );
      expect(lstatSync(sidecar).isSymbolicLink()).toBe(true);
      expect(existsSync(fixture.options.filename)).toBe(false);
    }
    const existing = catalogFixture();
    const catalog = track(createFreshCreatorAgentCatalog(existing.options));
    catalog.close();
    symlinkSync('missing-target', `${existing.options.filename}-shm`);
    expect(() => openExistingCreatorAgentCatalog(existing.options)).toThrow(
      expect.objectContaining({ code: 'CATALOG_FILE_UNSAFE' }),
    );
  });

  it('classifies index, view, and trigger catalog drift as corruption', () => {
    for (const sql of [
      'CREATE INDEX catalog_drift ON agent_catalog_agents(created_at_ms)',
      'CREATE VIEW catalog_drift AS SELECT agent_id FROM agent_catalog_agents',
      `CREATE TRIGGER catalog_drift AFTER INSERT ON agent_catalog_agents
       BEGIN SELECT 1; END`,
    ]) {
      const fixture = catalogFixture();
      const catalog = track(createFreshCreatorAgentCatalog(fixture.options));
      catalog.close();
      const database = new DatabaseSync(fixture.options.filename);
      database.exec(sql);
      database.close();
      expect(() => openExistingCreatorAgentCatalog(fixture.options)).toThrow(
        expect.objectContaining({ code: 'CATALOG_CORRUPT' }),
      );
    }
  });
});

function catalogFixture(): Readonly<{ root: string; options: CreatorAgentCatalogOptions }> {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'combo-agent-catalog-')));
  roots.push(root);
  chmodSync(root, 0o700);
  return Object.freeze({
    root,
    options: Object.freeze({
      filename: join(root, 'catalog.sqlite'),
      catalogIdentity: 'catalog.creator-agent.test',
      busyTimeoutMs: 50,
    }),
  });
}

function track(catalog: CreatorAgentCatalog): CreatorAgentCatalog {
  catalogs.push(catalog);
  return catalog;
}

function draft(
  draftRevision: number,
  baseVersionId: string | null,
  instructions = 'Inspect evidence, separate facts from inference, and report blockers.',
): CreatorAgentDraftSnapshotV1 {
  return createCreatorAgentDraftSnapshot({
    agentId: 'agent.release-review',
    draftId: 'draft.release-review',
    draftRevision,
    baseVersionId,
    definition: {
      protocol: CREATOR_AGENT_DEFINITION_PROTOCOL,
      name: 'Release evidence reviewer',
      description: 'Reviews one release using the creator’s fixed evidence standard.',
      projectSnapshot: {
        kind: 'git',
        repositoryUrl: 'https://github.com/dangdang-tech/Combo.git',
        sourceRef: 'refs/heads/main',
        commitSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
      },
      behavior: { instructions, starterPrompts: ['Review this release candidate.'] },
      requirements: {
        codexVersion: '0.148.0-alpha.15',
        commands: [],
        plugins: [],
        environmentVariableNames: [],
      },
      authoringSource: { kind: 'codex_current_task', rawStored: false },
      runtime: {
        contextProfile: 'PROJECT_TREE_READ_ONLY_V1',
        permissionProfile: 'LOCAL_UNISOLATED_READ_ONLY_V1',
        skills: [],
        dynamicTools: [],
        toolNetworkAccess: false,
        output: { kind: 'text', description: 'A concise evidence-backed review.' },
        turnTimeoutMs: 300_000,
      },
    },
  });
}

function handoffText(value: CreatorAgentDraftSnapshotV1): string {
  return serializeCreatorAgentDraftHandoff(createCreatorAgentDraftHandoff({ draft: value }));
}

function projectDraft() {
  const sourceLedger = createCreatorAgentProjectSourceLedger({
    contextRootDigest: `sha256:${'c'.repeat(64)}`,
    coverage: {
      indexedEntryCount: 7,
      indexedFileCount: 5,
      indexedByteCount: 2048,
      hiddenEntryCount: 2,
      trackedEntryCount: 2,
      untrackedEntryCount: 1,
      ignoredEntryCount: 1,
      gitAdminEntryCount: 1,
      authoringOnlyEntryCount: 5,
    },
    citedSources: [
      {
        path: 'README.md',
        digest: `sha256:${'d'.repeat(64)}`,
        executionAvailability: 'FIXED_GIT_TREE',
      },
    ],
  });
  return createCreatorAgentDraftSnapshotV2({
    agentId: 'agent.project-context',
    draftId: 'draft.project-context',
    draftRevision: 1,
    baseVersionId: null,
    definition: createCreatorAgentDefinitionV2({
      ...draft(1, null).definition,
      protocol: CREATOR_AGENT_DEFINITION_V2_PROTOCOL,
      authoringSource: { kind: 'project_context_compiler', sourceLedger },
    }),
  });
}

function projectHandoffText(value: ReturnType<typeof projectDraft>): string {
  return serializeCreatorAgentDraftHandoffV2(createCreatorAgentDraftHandoffV2({ draft: value }));
}

function ref(value: CreatorAgentDraftSnapshot) {
  return Object.freeze({
    agentId: value.agentId,
    draftId: value.draftId,
    draftRevision: value.draftRevision,
  });
}
