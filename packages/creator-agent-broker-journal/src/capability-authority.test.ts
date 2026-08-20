import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ExecutionCapabilityAuthorityError,
  ExecutionCapabilityUseJournal,
  RegisteredExecutionCapabilityAuthority,
  SqliteVerifiedExecutionCapabilityGate,
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
    const first = new SqliteVerifiedExecutionCapabilityGate(filename, fixture.publicKey);
    expect(
      first.authorize(fixture.capability, fixture.expected, new Date(NOW_MS)).decision.action,
    ).toBe('DISPATCH_ONCE');

    const competing = new SqliteVerifiedExecutionCapabilityGate(filename, fixture.publicKey);
    expect(
      competing.authorize(fixture.capability, fixture.expected, new Date(NOW_MS)).decision,
    ).toMatchObject({
      action: 'RETURN_IN_PROGRESS',
      record: { providerUpstreamRequestCount: 1 },
    });
    const resultDigest = `hmac-sha256:${'3'.repeat(64)}`;
    competing.markDurableResult(
      fixture.capability,
      fixture.expected,
      new Date(NOW_MS),
      resultDigest,
    );
    first.close();
    competing.close();

    const restarted = new SqliteVerifiedExecutionCapabilityGate(filename, fixture.publicKey);
    expect(
      restarted.authorize(fixture.capability, fixture.expected, new Date(NOW_MS)).decision,
    ).toMatchObject({
      action: 'RETURN_DURABLE_RESULT',
      record: { resultDigest, providerUpstreamRequestCount: 1 },
    });
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    restarted.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects a tampered signature before the public durable gate can consume its CAS', () => {
    const directory = mkdtempSync(join(tmpdir(), 'combo-capability-signature-'));
    const filename = join(directory, 'provider-attempts.sqlite');
    const fixture = createSignedCapabilityFixture();
    const gate = new SqliteVerifiedExecutionCapabilityGate(filename, fixture.publicKey);
    const tampered = {
      ...fixture.capability,
      signature: `${fixture.capability.signature[0] === 'A' ? 'B' : 'A'}${fixture.capability.signature.slice(1)}`,
    };
    expect(() => gate.authorize(tampered, fixture.expected, new Date(NOW_MS))).toThrowError(
      expect.objectContaining({ reasons: ['signature'] }),
    );
    expect(gate.getUseRecord(fixture.capability.capabilityId)).toBeUndefined();
    expect(
      gate.authorize(fixture.capability, fixture.expected, new Date(NOW_MS)).decision.action,
    ).toBe('DISPATCH_ONCE');
    gate.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('bounds durable capability rows and refuses an in-memory SQLite target', () => {
    const fixture = createSignedCapabilityFixture();
    expect(
      () => new SqliteVerifiedExecutionCapabilityGate(':memory:', fixture.publicKey),
    ).toThrowError(expect.objectContaining({ reasons: ['capability-ledger-not-durable'] }));
    const directory = mkdtempSync(join(tmpdir(), 'combo-capability-capacity-'));
    const filename = join(directory, 'provider-attempts.sqlite');
    const first = createSignedCapabilityFixture();
    const gate = new SqliteVerifiedExecutionCapabilityGate(filename, first.publicKey, new Set(), 1);
    gate.authorize(first.capability, first.expected, new Date(NOW_MS));
    const second = createSignedCapabilityFixture({
      capabilityId: '0198f00d-0000-7000-8000-000000000099',
      providerRequestId: '0198f00d-0000-7000-8000-000000000098',
      nonce: 'MDE5OGYwMGQtY2FwYWNpdHktbm9uY2UtMg',
    });
    const secondSignedByFirstKey = signCapability(second.capability, first.privateKey);
    expect(() =>
      gate.authorize(secondSignedByFirstKey, second.expected, new Date(NOW_MS)),
    ).toThrowError(expect.objectContaining({ reasons: ['capability-ledger-capacity'] }));
    gate.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('does not expose verifier or CAS halves as separate package-public entrypoints', async () => {
    const publicEntry = await import('./index.js');
    expect(publicEntry).toHaveProperty('SqliteVerifiedExecutionCapabilityGate');
    expect(publicEntry).not.toHaveProperty('RegisteredExecutionCapabilityAuthority');
    expect(publicEntry).not.toHaveProperty('SqliteExecutionCapabilityUseStore');
    expect(publicEntry).not.toHaveProperty('ExecutionCapabilityUseJournal');
  });
});
