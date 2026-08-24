import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  serializeCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import { afterEach, describe, expect, it } from 'vitest';

import { loadCreatorAgentPackage } from '../infrastructure/agent-package-loader.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Agent Package loader', () => {
  it('pins one exact package into a private read-only runtime snapshot', () => {
    const fixture = packageFixture();
    const loaded = loadCreatorAgentPackage(fixture.root);
    try {
      expect(loaded.root).not.toBe(fixture.root);
      expect(loaded.packageDigest).toBe(digestCreatorAgentPackage(fixture.manifest));
      expect(loaded.instructions).toBe(fixture.agent.toString('utf8'));
      expect(loaded.skillsRoot).toBe(join(loaded.root, 'skills'));
      expect(loaded.skills).toEqual([
        {
          name: 'release-review',
          path: join(loaded.root, 'skills', 'release-review', 'SKILL.md'),
        },
      ]);
      const runtimeSkill = loaded.skills[0]!.path;
      const exactRuntimeBytes = readFileSync(runtimeSkill);
      writeFileSync(
        join(fixture.root, 'skills', 'release-review', 'SKILL.md'),
        '# source changed after validation\n',
      );
      expect(readFileSync(runtimeSkill)).toEqual(exactRuntimeBytes);
      expect(statSync(runtimeSkill).mode & 0o777).toBe(0o400);
      expect(statSync(loaded.root).mode & 0o777).toBe(0o500);
      expect(Object.isFrozen(loaded)).toBe(true);
      expect(Object.isFrozen(loaded.skills)).toBe(true);
    } finally {
      const runtimeRoot = loaded.root;
      loaded.release();
      loaded.release();
      expect(existsSync(runtimeRoot)).toBe(false);
    }
  });

  it('rejects tampered, missing, and undeclared resources', () => {
    const tampered = packageFixture();
    writeFileSync(join(tampered.root, 'AGENT.md'), '# changed\n');
    expect(() => loadCreatorAgentPackage(tampered.root)).toThrow(
      expect.objectContaining({ code: 'AGENT_PACKAGE_INVALID' }),
    );

    const missing = packageFixture();
    rmSync(join(missing.root, 'skills', 'release-review', 'references', 'rubric.md'));
    expect(() => loadCreatorAgentPackage(missing.root)).toThrow(
      expect.objectContaining({ code: 'AGENT_PACKAGE_INVALID' }),
    );

    const extra = packageFixture();
    writeFileSync(join(extra.root, 'skills', 'release-review', 'extra.txt'), 'extra');
    expect(() => loadCreatorAgentPackage(extra.root)).toThrow(
      expect.objectContaining({ code: 'AGENT_PACKAGE_INVALID' }),
    );
  });

  it('rejects symbolic links, malformed Markdown, and non-absolute roots before Host use', () => {
    const linked = packageFixture();
    const agentPath = join(linked.root, 'AGENT.md');
    rmSync(agentPath);
    symlinkSync('/etc/hosts', agentPath);
    expect(() => loadCreatorAgentPackage(linked.root)).toThrow(
      expect.objectContaining({ code: 'AGENT_PACKAGE_INVALID' }),
    );

    const malformed = packageFixture();
    const skillPath = join(malformed.root, 'skills', 'release-review', 'SKILL.md');
    const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
    writeFileSync(skillPath, bytes);
    const manifest = createCreatorAgentPackageManifest({
      ...malformed.manifest,
      files: malformed.manifest.files.map((file) =>
        file.path.endsWith('/SKILL.md')
          ? {
              ...file,
              byteLength: bytes.byteLength,
              digest: digestCreatorAgentPackageFile(bytes),
            }
          : file,
      ),
    });
    writeFileSync(
      join(malformed.root, 'agent.json'),
      serializeCreatorAgentPackageManifest(manifest),
    );
    expect(() => loadCreatorAgentPackage(malformed.root)).toThrow(
      expect.objectContaining({ code: 'AGENT_PACKAGE_INVALID' }),
    );

    expect(() => loadCreatorAgentPackage('relative/package')).toThrow(
      expect.objectContaining({ code: 'AGENT_PACKAGE_INVALID' }),
    );
  });

  it('supports an AGENT.md-only package without inventing a fake Skill', () => {
    const root = temporaryRoot();
    const agent = Buffer.from('# Identity\nA focused conversational agent.\n');
    writeFileSync(join(root, 'AGENT.md'), agent);
    const manifest = createCreatorAgentPackageManifest({
      protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
      name: 'Focused Agent',
      description: 'Uses Codex directly under one package-level guide.',
      instructions: 'AGENT.md',
      skills: [],
      files: [resource('AGENT.md', agent)],
    });
    writeFileSync(join(root, 'agent.json'), serializeCreatorAgentPackageManifest(manifest));

    const loaded = loadCreatorAgentPackage(root);
    try {
      expect(loaded.skillsRoot).toBeUndefined();
      expect(loaded.skills).toEqual([]);
    } finally {
      loaded.release();
    }
  });
});

function packageFixture() {
  const root = temporaryRoot();
  const agent = Buffer.from(
    '# Identity\nYou are an evidence-first release reviewer.\n\n# Capability Routing\nUse the release-review Skill for every release task.\n',
  );
  const skill = Buffer.from(
    '---\nname: release-review\ndescription: Verify a release with exact evidence.\n---\n\nRead the rubric and inspect the target Project before answering.\n',
  );
  const rubric = Buffer.from('# Rubric\nSeparate observed facts from inference.\n');
  mkdirSync(join(root, 'skills', 'release-review', 'references'), { recursive: true });
  writeFileSync(join(root, 'AGENT.md'), agent);
  writeFileSync(join(root, 'skills', 'release-review', 'SKILL.md'), skill);
  writeFileSync(join(root, 'skills', 'release-review', 'references', 'rubric.md'), rubric);
  const manifest = createCreatorAgentPackageManifest({
    protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
    name: 'Release Reviewer',
    description: 'Reviews releases with an evidence-first method.',
    instructions: 'AGENT.md',
    skills: ['skills/release-review/SKILL.md'],
    files: [
      resource('AGENT.md', agent),
      resource('skills/release-review/SKILL.md', skill),
      resource('skills/release-review/references/rubric.md', rubric),
    ],
  });
  writeFileSync(join(root, 'agent.json'), serializeCreatorAgentPackageManifest(manifest));
  return { root, agent, manifest };
}

function resource(path: string, bytes: Uint8Array) {
  return {
    path,
    byteLength: bytes.byteLength,
    digest: digestCreatorAgentPackageFile(bytes),
  };
}

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'combo-agent-package-loader-')));
  roots.push(root);
  return root;
}
