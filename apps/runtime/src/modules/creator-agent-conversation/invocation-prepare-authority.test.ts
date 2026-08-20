import { generateKeyPairSync, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executionCapabilityDigest,
  executionCapabilitySigningBytes,
} from '@cb/creator-agent-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InvocationPrepareAuthorityError,
  loadTestInvocationPrepareAuthority,
} from './invocation-prepare-authority.js';

const signal = new AbortController().signal;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'combo-runtime-execution-authority-'));
  roots.push(root);
  return root;
}

function p256Keys(): ReturnType<typeof generateKeyPairSync> {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function fixture(
  privateKeyPkcs8Pem: string,
  budget: Record<string, number> = {
    maxInputTokens: 12_000,
    maxOutputTokens: 2_000,
    maxCostMicros: 1_000_000,
  },
): Record<string, unknown> {
  return {
    protocol: 'combo.runtime-test-execution-authority/1',
    schemaVersion: 1,
    privateKeyPkcs8Pem,
    budget,
  };
}

function privatePem(keys = p256Keys()): string {
  return keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function writeFixture(
  root: string,
  value: Record<string, unknown> | Buffer | string,
  mode = 0o600,
): string {
  const path = join(root, 'execution-authority.json');
  const bytes = Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value);
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
  return path;
}

function prepareInput() {
  return {
    capabilityId: '01900000-0000-7000-8000-000000000301',
    providerRequestId: '01900000-0000-7000-8000-000000000302',
    invocationId: '01900000-0000-7000-8000-000000000303',
    conversationId: '01900000-0000-7000-8000-000000000304',
    deploymentId: '01900000-0000-7000-8000-000000000305',
    agentVersionId: '01900000-0000-7000-8000-000000000306',
    agentVersionDigest: 'a'.repeat(64),
    installationId: '01900000-0000-7000-8000-000000000307',
    leaseId: '01900000-0000-7000-8000-000000000308',
    fence: '7',
    requestDigest: `hmac-sha256:${'b'.repeat(64)}`,
    model: 'gpt-5.6-sol/test:latest',
    reasoningEffort: 'medium' as const,
    notBefore: '2026-08-20T01:02:03.004Z',
    expiresAt: '2026-08-20T01:03:03.004Z',
    signal,
  };
}

describe('mounted Test InvocationPrepareAuthority', () => {
  it('emits a real P-256 ES256 p1363 capability and exact digest', async () => {
    const keys = p256Keys();
    const path = writeFixture(createRoot(), fixture(privatePem(keys)));
    const authority = loadTestInvocationPrepareAuthority(path);
    const input = prepareInput();
    const prepared = await authority.prepare(input);
    const { signal: _signal, installationId, ...expectedCapability } = input;

    expect(prepared.capability).toMatchObject({
      ...expectedCapability,
      workerInstallationId: installationId,
      signatureAlgorithm: 'ES256',
      signatureEncoding: 'ieee-p1363',
      budget: {
        maxInputTokens: 12_000,
        maxOutputTokens: 2_000,
        maxCostMicros: 1_000_000,
      },
    });
    expect(Buffer.from(prepared.capability.signature, 'base64url')).toHaveLength(64);
    expect(
      verify(
        'sha256',
        executionCapabilitySigningBytes(prepared.capability),
        { key: keys.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(prepared.capability.signature, 'base64url'),
      ),
    ).toBe(true);
    expect(prepared.capabilityDigest).toBe(executionCapabilityDigest(prepared.capability));
  });

  it.each([
    ['zero input', { maxInputTokens: 0, maxOutputTokens: 1, maxCostMicros: 1 }],
    ['fractional output', { maxInputTokens: 1, maxOutputTokens: 1.5, maxCostMicros: 1 }],
    ['excess output', { maxInputTokens: 1, maxOutputTokens: 32_769, maxCostMicros: 1 }],
    ['excess cost', { maxInputTokens: 1, maxOutputTokens: 1, maxCostMicros: 100_000_001 }],
  ])('rejects mounted budget outside the product bounds: %s', (_name, budget) => {
    const path = writeFixture(createRoot(), fixture(privatePem(), budget));
    expect(() => loadTestInvocationPrepareAuthority(path)).toThrowError(
      InvocationPrepareAuthorityError,
    );
  });

  it('rejects the wrong EC curve and a public-only key', () => {
    const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const wrongCurvePem = wrongCurve.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() =>
      loadTestInvocationPrepareAuthority(writeFixture(createRoot(), fixture(wrongCurvePem))),
    ).toThrowError(InvocationPrepareAuthorityError);

    const keys = p256Keys();
    const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() =>
      loadTestInvocationPrepareAuthority(writeFixture(createRoot(), fixture(publicPem))),
    ).toThrowError(InvocationPrepareAuthorityError);
  });

  it('rejects non-0600, non-regular, wrong-owner, symlink, duplicate-key and invalid UTF-8 mounts', () => {
    const pem = privatePem();
    expect(() =>
      loadTestInvocationPrepareAuthority(writeFixture(createRoot(), fixture(pem), 0o644)),
    ).toThrowError(InvocationPrepareAuthorityError);

    const directoryRoot = createRoot();
    const directoryPath = join(directoryRoot, 'authority-directory');
    mkdirSync(directoryPath);
    expect(() => loadTestInvocationPrepareAuthority(directoryPath)).toThrowError(
      InvocationPrepareAuthorityError,
    );

    const symlinkRoot = createRoot();
    const sourcePath = writeFixture(symlinkRoot, fixture(pem));
    const symlinkPath = join(symlinkRoot, 'authority-link.json');
    symlinkSync(sourcePath, symlinkPath);
    expect(() => loadTestInvocationPrepareAuthority(symlinkPath)).toThrowError(
      InvocationPrepareAuthorityError,
    );

    const ownerPath = writeFixture(createRoot(), fixture(pem));
    const realUid = process.getuid?.() ?? 0;
    vi.spyOn(process as unknown as { getuid(): number }, 'getuid').mockReturnValue(realUid + 1);
    expect(() => loadTestInvocationPrepareAuthority(ownerPath)).toThrowError(
      InvocationPrepareAuthorityError,
    );
    vi.restoreAllMocks();

    const duplicate = JSON.stringify(fixture(pem)).replace(
      '{"protocol":',
      '{"protocol":"combo.runtime-test-execution-authority/1","protocol":',
    );
    expect(() =>
      loadTestInvocationPrepareAuthority(writeFixture(createRoot(), duplicate)),
    ).toThrowError(InvocationPrepareAuthorityError);
    expect(() =>
      loadTestInvocationPrepareAuthority(writeFixture(createRoot(), Buffer.from([0xff, 0xfe]))),
    ).toThrowError(InvocationPrepareAuthorityError);
  });
});
