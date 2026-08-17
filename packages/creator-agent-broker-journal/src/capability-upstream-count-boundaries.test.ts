import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  BrokerEnvelopeSchema,
  ExecutionCapabilityUpstreamCountBoundaryCorpusSchema,
  canonicalSha256,
  executionCapabilityBindingFrom,
  executionCapabilityDigest,
  type ExecutionCapability,
  type ExecutionCapabilityUseRecord,
} from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import {
  SqliteExecutionCapabilityUseStore,
  SqliteVerifiedExecutionCapabilityGate,
} from './capability-authority.js';
import { signCapability } from './reference-fixture.js';

interface NodeSqliteModule {
  readonly DatabaseSync: typeof DatabaseSync;
}

const loadNodeSqlite = (): NodeSqliteModule =>
  createRequire(import.meta.url)('node:sqlite') as NodeSqliteModule;

const corpusPath = new URL(
  '../../creator-agent-protocol/fixtures/execution-capability-upstream-count-boundaries.v1.json',
  import.meta.url,
);
const prepareFixturePath = new URL(
  '../../creator-agent-protocol/fixtures/broker-invocation-prepare.v1.json',
  import.meta.url,
);
const NOW = new Date('2026-08-13T08:01:00.000Z');

function pinnedCapability(): ExecutionCapability {
  const envelope = BrokerEnvelopeSchema.parse(JSON.parse(readFileSync(prepareFixturePath, 'utf8')));
  if (envelope.type !== 'invocation.prepare') {
    throw new Error('UPSTREAM_COUNT_SQLITE_EXPECTED_PREPARE');
  }
  return envelope.body.executionCapability;
}

function recordFor(
  capability: ExecutionCapability,
  probe: { state: 'UNUSED' | 'DISPATCHED'; providerUpstreamRequestCount: 0 | 1 | 2 },
): ExecutionCapabilityUseRecord {
  return {
    capabilityId: capability.capabilityId,
    capabilityDigest: executionCapabilityDigest(capability),
    providerRequestId: capability.providerRequestId,
    requestDigest: capability.requestDigest,
    state: probe.state,
    providerUpstreamRequestCount: probe.providerUpstreamRequestCount as 0 | 1,
    resultDigest: null,
  };
}

describe('real-file SQLite Execution Capability upstream-count boundary', () => {
  it('accepts and reopens 0/1, commits public authorize at 1, and rejects direct 2 atomically', () => {
    const corpus = ExecutionCapabilityUpstreamCountBoundaryCorpusSchema.parse(
      JSON.parse(readFileSync(corpusPath, 'utf8')),
    );
    const capability = pinnedCapability();
    const directory = mkdtempSync(join(tmpdir(), 'combo-upstream-count-boundary-'));
    const zeroFilename = join(directory, 'zero.sqlite');
    const oneFilename = join(directory, 'one.sqlite');
    const publicFilename = join(directory, 'public.sqlite');
    let outcomes = 0;

    try {
      const zeroProbe = corpus.probes[0];
      expect(zeroProbe.sqliteExpected).toBe('accepted');
      const zeroRecord = recordFor(capability, zeroProbe);
      expect(`sha256:${canonicalSha256(zeroRecord)}`).toBe(zeroProbe.canonicalRecordDigest);
      const zeroStore = new SqliteExecutionCapabilityUseStore(zeroFilename);
      zeroStore.transact(capability.capabilityId, () => ({
        value: undefined,
        nextRecord: zeroRecord,
      }));
      expect(zeroStore.get(capability.capabilityId)).toEqual(zeroRecord);
      zeroStore.close();
      const reopenedZero = new SqliteExecutionCapabilityUseStore(zeroFilename);
      expect(reopenedZero.get(capability.capabilityId)).toEqual(zeroRecord);
      reopenedZero.close();
      expect(statSync(zeroFilename).mode & 0o777).toBe(0o600);
      outcomes += 1;

      const oneProbe = corpus.probes[1];
      expect(oneProbe.sqliteExpected).toBe('accepted');
      const oneRecord = recordFor(capability, oneProbe);
      expect(`sha256:${canonicalSha256(oneRecord)}`).toBe(oneProbe.canonicalRecordDigest);
      const oneStore = new SqliteExecutionCapabilityUseStore(oneFilename);
      oneStore.transact(capability.capabilityId, () => ({
        value: undefined,
        nextRecord: oneRecord,
      }));
      oneStore.close();
      const reopenedOne = new SqliteExecutionCapabilityUseStore(oneFilename);
      expect(reopenedOne.get(capability.capabilityId)).toEqual(oneRecord);
      reopenedOne.close();
      expect(statSync(oneFilename).mode & 0o777).toBe(0o600);

      const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const signedCapability = signCapability(capability, keyPair.privateKey);
      const expected = executionCapabilityBindingFrom(signedCapability);
      const publicGate = new SqliteVerifiedExecutionCapabilityGate(
        publicFilename,
        keyPair.publicKey,
      );
      expect(publicGate.authorize(signedCapability, expected, NOW).decision).toMatchObject({
        action: 'DISPATCH_ONCE',
        nextRecord: { providerUpstreamRequestCount: 1 },
      });
      publicGate.close();
      const reopenedPublicGate = new SqliteVerifiedExecutionCapabilityGate(
        publicFilename,
        keyPair.publicKey,
      );
      expect(reopenedPublicGate.authorize(signedCapability, expected, NOW).decision).toMatchObject({
        action: 'RETURN_IN_PROGRESS',
        record: { providerUpstreamRequestCount: 1 },
      });
      reopenedPublicGate.close();
      expect(statSync(publicFilename).mode & 0o777).toBe(0o600);
      outcomes += 1;

      const { DatabaseSync } = loadNodeSqlite();
      const database = new DatabaseSync(oneFilename);
      const table = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(corpus.durableOwner.table) as { sql?: string } | undefined;
      expect(table?.sql).toContain(corpus.durableOwner.check);
      const before = database
        .prepare(
          `SELECT provider_upstream_request_count, record_json
             FROM execution_capability_uses
            WHERE capability_id = ?`,
        )
        .get(capability.capabilityId);
      const twoProbe = corpus.probes[2];
      expect(twoProbe.sqliteExpected).toBe('rejected');
      expect(() =>
        database
          .prepare(
            `UPDATE execution_capability_uses
                SET provider_upstream_request_count = ?
              WHERE capability_id = ?`,
          )
          .run(twoProbe.providerUpstreamRequestCount, capability.capabilityId),
      ).toThrow(/CHECK constraint failed/u);
      const after = database
        .prepare(
          `SELECT provider_upstream_request_count, record_json
             FROM execution_capability_uses
            WHERE capability_id = ?`,
        )
        .get(capability.capabilityId);
      expect(after).toEqual(before);
      database.close();
      const afterRejectedTwo = new SqliteExecutionCapabilityUseStore(oneFilename);
      expect(afterRejectedTwo.get(capability.capabilityId)).toEqual(oneRecord);
      afterRejectedTwo.close();
      outcomes += 1;

      expect(outcomes).toBe(corpus.outcomeCounts.realFileSqlite);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
