import { describe, expect, it } from 'vitest';

import {
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  parseCreatorAgentPackageManifest,
  serializeCreatorAgentPackageManifest,
  verifyCreatorAgentPackageManifest,
} from '../agent-package.js';

const AGENT_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SKILL_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const REFERENCE_DIGEST = `sha256:${'c'.repeat(64)}` as const;

function manifest() {
  return {
    protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
    name: 'Release Reviewer',
    description: 'Reviews a release with an evidence-first method.',
    instructions: 'AGENT.md' as const,
    skills: ['skills/release-review/SKILL.md'],
    files: [
      { path: 'AGENT.md', byteLength: 320, digest: AGENT_DIGEST },
      {
        path: 'skills/release-review/SKILL.md',
        byteLength: 640,
        digest: SKILL_DIGEST,
      },
      {
        path: 'skills/release-review/references/rubric.md',
        byteLength: 128,
        digest: REFERENCE_DIGEST,
      },
    ],
  };
}

describe('Creator Agent Package contract', () => {
  it('produces one canonical content-addressed manifest and detached frozen values', () => {
    const input = manifest();
    const value = createCreatorAgentPackageManifest(input);
    input.description = 'changed after creation';
    input.files[0]!.byteLength = 999;

    const text = serializeCreatorAgentPackageManifest(value);
    expect(text).toBe(
      '{"description":"Reviews a release with an evidence-first method.","files":[{"byteLength":320,"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","path":"AGENT.md"},{"byteLength":640,"digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","path":"skills/release-review/SKILL.md"},{"byteLength":128,"digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","path":"skills/release-review/references/rubric.md"}],"instructions":"AGENT.md","name":"Release Reviewer","protocol":"combo.agent-package/1","skills":["skills/release-review/SKILL.md"]}',
    );
    expect(digestCreatorAgentPackage(value)).toBe(
      'sha256:32c5e65d8e21a36c8c4d279123ed605ee554b2582a791eb256e956bfbbc38b56',
    );
    expect(parseCreatorAgentPackageManifest(text)).toEqual(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.files)).toBe(true);
    expect(Object.isFrozen(value.files[0])).toBe(true);
  });

  it('binds raw file bytes and every package resource through the package digest', () => {
    expect(digestCreatorAgentPackageFile(Buffer.from('exact bytes\n'))).toBe(
      'sha256:6a77ce4ad94636f6120bb985066c1d75ce65b73f264a35f9d5ac910e252f0355',
    );
    expect(
      digestCreatorAgentPackage({ ...manifest(), description: 'A different package.' }),
    ).not.toBe(digestCreatorAgentPackage(manifest()));
    expect(
      digestCreatorAgentPackage({
        ...manifest(),
        files: manifest().files.map((file, index) =>
          index === 2 ? { ...file, digest: `sha256:${'d'.repeat(64)}` } : file,
        ),
      }),
    ).not.toBe(digestCreatorAgentPackage(manifest()));
  });

  it('accepts the declared maximum file inventory within the canonical byte budget', () => {
    const files = [manifest().files[0]!, manifest().files[1]!];
    for (let index = 0; index < 254; index += 1) {
      files.push({
        path: `skills/release-review/references/reference-${String(index).padStart(3, '0')}.txt`,
        byteLength: 1,
        digest: REFERENCE_DIGEST,
      });
    }
    const value = createCreatorAgentPackageManifest({ ...manifest(), files });
    expect(value.files).toHaveLength(256);
    expect(parseCreatorAgentPackageManifest(serializeCreatorAgentPackageManifest(value))).toEqual(
      value,
    );
  });

  it('rejects incomplete, ambiguous, unsafe, or non-canonical manifests', () => {
    expect(() =>
      createCreatorAgentPackageManifest({ ...manifest(), files: manifest().files.slice(1) }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({ ...manifest(), skills: ['skills/missing/SKILL.md'] }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({
        ...manifest(),
        files: [...manifest().files].reverse(),
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({
        ...manifest(),
        skills: ['skills/release--review/SKILL.md'],
        files: [
          manifest().files[0],
          {
            ...manifest().files[1],
            path: 'skills/release--review/SKILL.md',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({
        ...manifest(),
        files: [
          ...manifest().files,
          { path: 'skills/release-review/SKILL.md', byteLength: 1, digest: SKILL_DIGEST },
        ],
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({
        ...manifest(),
        files: [
          manifest().files[0],
          manifest().files[1],
          {
            path: 'skills/Release-review/asset.txt',
            byteLength: 1,
            digest: REFERENCE_DIGEST,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({
        ...manifest(),
        files: [
          manifest().files[0],
          manifest().files[1],
          {
            path: 'skills/release-review/SKILL.md/asset.txt',
            byteLength: 1,
            digest: REFERENCE_DIGEST,
          },
          manifest().files[2],
        ],
      }),
    ).toThrow(/ancestors/u);

    const canonical = serializeCreatorAgentPackageManifest(manifest());
    expect(() => parseCreatorAgentPackageManifest(`${canonical}\n`)).toThrow(
      /not exact canonical/u,
    );
    expect(() =>
      parseCreatorAgentPackageManifest(canonical.replace('"name":', '"extra":true,"name":')),
    ).toThrow();
  });

  it('does not execute accessors or Proxy traps and rejects legacy Version values', () => {
    let reads = 0;
    const accessor = {
      ...manifest(),
      get name() {
        reads += 1;
        return 'Release Reviewer';
      },
    };
    expect(() => verifyCreatorAgentPackageManifest(accessor)).toThrow(/data properties/u);
    expect(reads).toBe(0);

    const proxied = new Proxy(manifest(), {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => verifyCreatorAgentPackageManifest(proxied)).toThrow(/plain JSON/u);
    expect(reads).toBe(0);

    expect(() =>
      parseCreatorAgentPackageManifest('{"protocol":"combo.creator-agent-version/1"}'),
    ).toThrow();
  });
});
