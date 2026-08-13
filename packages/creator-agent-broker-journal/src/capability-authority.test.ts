import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ExecutionCapabilityAuthorityError,
  ExecutionCapabilityUseJournal,
  RegisteredExecutionCapabilityAuthority,
  SqliteExecutionCapabilityUseStore,
} from './capability-authority.js';
import { NOW_MS, createSignedCapabilityFixture, signCapability } from './reference-fixture.js';

describe('frozen Execution Capability adapter', () => {
  it('verifies signature, exact binding, time and revocation without a caller validity boolean', () => {
    const fixture = createSignedCapabilityFixture();
    expect(
      fixture.authority.verify(fixture.capability, fixture.expected, new Date(NOW_MS)),
    ).toMatchObject({ capabilityDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });

    const changed = signCapability(
      { ...fixture.capability, model: 'different-model' },
      fixture.privateKey,
    );
    expect(() =>
      fixture.authority.verify(changed, fixture.expected, new Date(NOW_MS)),
    ).toThrowError(ExecutionCapabilityAuthorityError);
    expect(() =>
      fixture.authority.verify(
        fixture.capability,
        fixture.expected,
        new Date(fixture.capability.expiresAt),
      ),
    ).toThrowError(expect.objectContaining({ reasons: ['expired'] }));

    const revoked = new RegisteredExecutionCapabilityAuthority(
      fixture.publicKey,
      new Set([fixture.capability.capabilityId]),
    );
    expect(() =>
      revoked.verify(fixture.capability, fixture.expected, new Date(NOW_MS)),
    ).toThrowError(expect.objectContaining({ reasons: ['revoked'] }));
  });

  it('uses the frozen one-use reducer across durable reconstruction', () => {
    const fixture = createSignedCapabilityFixture();
    let journal = new ExecutionCapabilityUseJournal();
    expect(journal.authorize(fixture.capability).action).toBe('DISPATCH_ONCE');
    expect(journal.authorize(fixture.capability).action).toBe('RETURN_IN_PROGRESS');
    journal = ExecutionCapabilityUseJournal.restore(journal.serialize());
    expect(journal.authorize(fixture.capability).action).toBe('RETURN_IN_PROGRESS');
    const resultDigest = `hmac-sha256:${'3'.repeat(64)}`;
    journal.markDurableResult(fixture.capability, resultDigest);
    expect(journal.authorize(fixture.capability)).toMatchObject({
      action: 'RETURN_DURABLE_RESULT',
      record: { providerUpstreamRequestCount: 1, resultDigest },
    });

    const reused = signCapability(
      { ...fixture.capability, providerRequestId: '0198f00d-0000-7000-8000-0000000000ff' },
      fixture.privateKey,
    );
    expect(journal.authorize(reused)).toMatchObject({
      action: 'SECURITY_BLOCK',
      code: 'CAPABILITY_REUSE_CONFLICT',
    });
    expect(journal.get(fixture.capability.capabilityId)?.providerUpstreamRequestCount).toBe(1);
  });

  it('commits one-use state to SQLite before returning DISPATCH_ONCE', () => {
    const directory = mkdtempSync(join(tmpdir(), 'combo-capability-ledger-'));
    const filename = join(directory, 'provider-attempts.sqlite');
    const fixture = createSignedCapabilityFixture();
    const firstStore = new SqliteExecutionCapabilityUseStore(filename);
    const first = new ExecutionCapabilityUseJournal(firstStore);
    expect(first.authorize(fixture.capability).action).toBe('DISPATCH_ONCE');

    const competingStore = new SqliteExecutionCapabilityUseStore(filename);
    const competing = new ExecutionCapabilityUseJournal(competingStore);
    expect(competing.authorize(fixture.capability)).toMatchObject({
      action: 'RETURN_IN_PROGRESS',
      record: { providerUpstreamRequestCount: 1 },
    });
    const resultDigest = `hmac-sha256:${'3'.repeat(64)}`;
    competing.markDurableResult(fixture.capability, resultDigest);
    firstStore.close();
    competingStore.close();

    const restartedStore = new SqliteExecutionCapabilityUseStore(filename);
    const restarted = new ExecutionCapabilityUseJournal(restartedStore);
    expect(restarted.authorize(fixture.capability)).toMatchObject({
      action: 'RETURN_DURABLE_RESULT',
      record: { resultDigest, providerUpstreamRequestCount: 1 },
    });
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    restartedStore.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('bounds durable capability rows and refuses an in-memory SQLite target', () => {
    expect(() => new SqliteExecutionCapabilityUseStore(':memory:')).toThrowError(
      expect.objectContaining({ reasons: ['capability-ledger-not-durable'] }),
    );
    const directory = mkdtempSync(join(tmpdir(), 'combo-capability-capacity-'));
    const filename = join(directory, 'provider-attempts.sqlite');
    const store = new SqliteExecutionCapabilityUseStore(filename, 1);
    const first = createSignedCapabilityFixture();
    new ExecutionCapabilityUseJournal(store).authorize(first.capability);
    const second = createSignedCapabilityFixture({
      capabilityId: '0198f00d-0000-7000-8000-000000000099',
      providerRequestId: '0198f00d-0000-7000-8000-000000000098',
      nonce: 'MDE5OGYwMGQtY2FwYWNpdHktbm9uY2UtMg',
    });
    expect(() =>
      new ExecutionCapabilityUseJournal(store).authorize(second.capability),
    ).toThrowError(expect.objectContaining({ reasons: ['capability-ledger-capacity'] }));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
