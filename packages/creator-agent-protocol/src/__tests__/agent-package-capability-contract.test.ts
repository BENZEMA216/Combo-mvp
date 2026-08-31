import { describe, expect, it } from 'vitest';

import {
  CREATOR_AGENT_PACKAGE_CAPABILITY_PROTOCOL,
  CREATOR_AGENT_PACKAGE_CAPABILITY_VERSION,
  createCreatorAgentPackageCapability,
  parseCreatorAgentPackageCapability,
  serializeCreatorAgentPackageCapability,
  verifyCreatorAgentPackageCapability,
} from '../agent-package-capability.js';
import { CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL } from '../agent-package-release.js';

const PACKAGE_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const RELEASE_ID = `release.agent-package.${'1'.repeat(32)}` as const;

function capability(): {
  version: number;
  protocol: string;
  release: { protocol: string; releaseId: string; packageDigest: string };
} {
  return {
    version: CREATOR_AGENT_PACKAGE_CAPABILITY_VERSION,
    protocol: CREATOR_AGENT_PACKAGE_CAPABILITY_PROTOCOL,
    release: {
      protocol: CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL,
      releaseId: RELEASE_ID,
      packageDigest: PACKAGE_DIGEST,
    },
  };
}

describe('Agent Package Capability projection contract', () => {
  it('creates one detached v2 pointer to an exact Release', () => {
    const input = capability();
    const value = createCreatorAgentPackageCapability(input);
    input.release.packageDigest = `sha256:${'b'.repeat(64)}`;

    const text = serializeCreatorAgentPackageCapability(value);
    expect(text).toBe(
      `{"protocol":"combo.agent-package-capability/2","release":{"packageDigest":"${PACKAGE_DIGEST}","protocol":"combo.agent-package-release/1","releaseId":"${RELEASE_ID}"},"version":2}`,
    );
    expect(parseCreatorAgentPackageCapability(text)).toEqual(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.release)).toBe(true);
    expect(value.release.packageDigest).toBe(PACKAGE_DIGEST);
  });

  it('rejects v1, copied product state, and non-canonical JSON', () => {
    for (const input of [
      { ...capability(), version: 1 },
      { ...capability(), instructions: 'Trust this copied prompt.' },
      { ...capability(), knowledgeBundleDigest: PACKAGE_DIGEST },
      { ...capability(), priceCents: 1 },
      {
        ...capability(),
        release: { ...capability().release, packageDigest: `sha256:${'z'.repeat(64)}` },
      },
    ]) {
      expect(() => createCreatorAgentPackageCapability(input)).toThrow();
    }

    const canonical = serializeCreatorAgentPackageCapability(capability());
    expect(() => parseCreatorAgentPackageCapability(`${canonical}\n`)).toThrow(/canonical/u);
    expect(() =>
      parseCreatorAgentPackageCapability(
        `{"version":2,"protocol":"combo.agent-package-capability/2","release":{"protocol":"combo.agent-package-release/1","releaseId":"${RELEASE_ID}","packageDigest":"${PACKAGE_DIGEST}"}}`,
      ),
    ).toThrow(/canonical/u);
    expect(() => parseCreatorAgentPackageCapability(' '.repeat(1_025))).toThrow(/byte limit/u);
  });

  it('does not execute accessors or Proxy traps while rejecting hostile envelopes', () => {
    let getterReads = 0;
    const accessor = {
      version: CREATOR_AGENT_PACKAGE_CAPABILITY_VERSION,
      protocol: CREATOR_AGENT_PACKAGE_CAPABILITY_PROTOCOL,
      get release() {
        getterReads += 1;
        return capability().release;
      },
    };
    expect(() => verifyCreatorAgentPackageCapability(accessor)).toThrow(/data properties/u);
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxy = new Proxy(capability(), {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => verifyCreatorAgentPackageCapability(proxy)).toThrow(/plain JSON/u);
    expect(proxyReads).toBe(0);

    let releaseProxyTraps = 0;
    const releaseProxy = new Proxy(capability().release, {
      ownKeys(target) {
        releaseProxyTraps += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() =>
      verifyCreatorAgentPackageCapability({ ...capability(), release: releaseProxy }),
    ).toThrow(/plain JSON/u);
    expect(releaseProxyTraps).toBe(0);

    expect(() =>
      verifyCreatorAgentPackageCapability(
        Object.assign(Object.create({ inherited: true }), capability()),
      ),
    ).toThrow(/plain JSON/u);
    expect(() =>
      verifyCreatorAgentPackageCapability({ ...capability(), [Symbol('hidden')]: true }),
    ).toThrow(/exact projection fields/u);
  });
});
