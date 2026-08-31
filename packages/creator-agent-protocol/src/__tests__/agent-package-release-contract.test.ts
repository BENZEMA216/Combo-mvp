import { describe, expect, it } from 'vitest';

import {
  CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL,
  CreatorAgentPackageReleaseIdSchema,
  createCreatorAgentPackageRelease,
  parseCreatorAgentPackageRelease,
  serializeCreatorAgentPackageRelease,
  verifyCreatorAgentPackageRelease,
} from '../agent-package-release.js';

const PACKAGE_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const RELEASE_ID = `release.agent-package.${'1'.repeat(32)}` as const;

function release(): {
  protocol: typeof CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL;
  releaseId: string;
  packageDigest: string;
} {
  return {
    protocol: CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL,
    releaseId: RELEASE_ID,
    packageDigest: PACKAGE_DIGEST,
  };
}

describe('Agent Package Release contract', () => {
  it('creates one detached canonical Release reference', () => {
    const input = release();
    const value = createCreatorAgentPackageRelease(input);
    input.packageDigest = `sha256:${'b'.repeat(64)}`;

    const text = serializeCreatorAgentPackageRelease(value);
    expect(text).toBe(
      `{"packageDigest":"${PACKAGE_DIGEST}","protocol":"combo.agent-package-release/1","releaseId":"${RELEASE_ID}"}`,
    );
    expect(parseCreatorAgentPackageRelease(text)).toEqual(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(CreatorAgentPackageReleaseIdSchema.parse(RELEASE_ID)).toBe(RELEASE_ID);

    const otherPackage = createCreatorAgentPackageRelease({
      ...release(),
      packageDigest: `sha256:${'b'.repeat(64)}`,
    });
    expect(serializeCreatorAgentPackageRelease(otherPackage)).not.toBe(text);
    expect(otherPackage.releaseId).toBe(value.releaseId);
  });

  it('rejects invalid identities, extra product state, and non-canonical JSON', () => {
    for (const input of [
      { ...release(), releaseId: `release.agent-package.${'A'.repeat(32)}` },
      { ...release(), packageDigest: `sha256:${'z'.repeat(64)}` },
      { ...release(), packageDigest: `sha256:${'b'.repeat(64)}`, projectPath: '/tmp/source' },
      { ...release(), prompt: 'Copy this Agent.' },
      { ...release(), protocol: 'combo.creator-agent-version/3' },
    ]) {
      expect(() => createCreatorAgentPackageRelease(input)).toThrow();
    }

    const canonical = serializeCreatorAgentPackageRelease(release());
    expect(() => parseCreatorAgentPackageRelease(`${canonical}\n`)).toThrow(/canonical/u);
    expect(() =>
      parseCreatorAgentPackageRelease(
        `{"protocol":"combo.agent-package-release/1","releaseId":"${RELEASE_ID}","packageDigest":"${PACKAGE_DIGEST}"}`,
      ),
    ).toThrow(/canonical/u);
    expect(() => parseCreatorAgentPackageRelease(`${' '.repeat(513)}`)).toThrow(/byte limit/u);
    expect(() =>
      verifyCreatorAgentPackageRelease({ ...release(), releaseId: 'x'.repeat(513) }),
    ).toThrow(/byte limit/u);
    expect(() =>
      parseCreatorAgentPackageRelease(
        `{"packageDigest":"${PACKAGE_DIGEST}","packageDigest":"sha256:${'b'.repeat(64)}","protocol":"combo.agent-package-release/1","releaseId":"${RELEASE_ID}"}`,
      ),
    ).toThrow(/canonical/u);
  });

  it('does not execute accessors or Proxy traps while rejecting hostile envelopes', () => {
    let getterReads = 0;
    const accessor = {
      protocol: CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL,
      releaseId: RELEASE_ID,
      get packageDigest() {
        getterReads += 1;
        return PACKAGE_DIGEST;
      },
    };
    expect(() => verifyCreatorAgentPackageRelease(accessor)).toThrow(/data properties/u);
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxy = new Proxy(release(), {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => verifyCreatorAgentPackageRelease(proxy)).toThrow(/plain JSON/u);
    expect(proxyReads).toBe(0);

    let nestedProxyTraps = 0;
    const nestedProxy = new Proxy(
      {},
      {
        ownKeys() {
          nestedProxyTraps += 1;
          return [];
        },
        getOwnPropertyDescriptor() {
          nestedProxyTraps += 1;
          return undefined;
        },
      },
    );
    expect(() =>
      verifyCreatorAgentPackageRelease({ ...release(), packageDigest: nestedProxy }),
    ).toThrow(/string data/u);
    expect(nestedProxyTraps).toBe(0);

    expect(() =>
      verifyCreatorAgentPackageRelease(
        Object.assign(Object.create({ inherited: true }), release()),
      ),
    ).toThrow(/plain JSON/u);
    expect(() =>
      verifyCreatorAgentPackageRelease({ ...release(), [Symbol('hidden')]: 'value' }),
    ).toThrow(/exact protocol fields/u);
  });
});
