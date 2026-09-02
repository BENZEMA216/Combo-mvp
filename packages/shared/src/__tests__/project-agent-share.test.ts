import { describe, expect, it } from 'vitest';
import { CreateProjectAgentShareBodySchema, ProjectAgentShareManifestSchema } from '../index.js';

const validBody = {
  name: 'Repository reviewer',
  description: 'Review one immutable Git Project with Codex.',
  repositoryUrl: 'https://github.com/openai/codex.git',
  sourceRef: 'refs/heads/main',
  commitSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  startPrompt: 'Inspect the repository and explain its architecture.',
  requirements: {
    codexVersion: '>=0.147',
    commands: ['git', 'pnpm'],
    plugins: ['combo@dangdang-tech-combo', '@openai/example'],
    environmentVariableNames: ['DATABASE_URL'],
  },
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
};

describe('Project Agent share contract', () => {
  it('accepts the canonical GitHub source and bounded requirement arrays', () => {
    expect(CreateProjectAgentShareBodySchema.parse(validBody)).toEqual(validBody);
    const withoutRequirements = CreateProjectAgentShareBodySchema.parse({
      ...validBody,
      requirements: undefined,
    });
    expect(withoutRequirements.requirements).toBeUndefined();
    expect(
      CreateProjectAgentShareBodySchema.safeParse({
        ...validBody,
        sourceRef: 'refs/heads/foo./bar',
      }).success,
    ).toBe(true);
    // V0 is byte-frozen; the stricter shell-safe advertised-ref contract applies only to V1.
    expect(
      CreateProjectAgentShareBodySchema.safeParse({
        ...validBody,
        sourceRef: 'refs/heads/$(legacy)',
      }).success,
    ).toBe(true);
  });

  it.each([
    'not a url',
    'https://github.com/a-/repo.git',
    'https://github.com/-a/repo.git',
    'https://gitlab.com/a/repo.git',
    'https://github.com/a/repo',
    'https://user@github.com/a/repo.git',
    'https://github.com/a/repo.git?ref=main',
  ])('rejects a non-canonical repository URL: %s', (repositoryUrl) => {
    expect(
      CreateProjectAgentShareBodySchema.safeParse({ ...validBody, repositoryUrl }).success,
    ).toBe(false);
  });

  it.each([
    'main',
    'refs/heads/a..b',
    'refs/tags/.hidden',
    'refs/heads/a.lock',
    'refs/heads/feature/a.lock/child',
    'refs/heads/a?b',
    'refs/heads/trailing.',
    ' refs/heads/main',
    'refs/heads/main ',
    'refs/pull/1/head',
  ])('rejects an unsafe or incomplete source ref: %s', (sourceRef) => {
    expect(CreateProjectAgentShareBodySchema.safeParse({ ...validBody, sourceRef }).success).toBe(
      false,
    );
  });

  it('rejects unsafe dependencies, duplicates and malformed SHA values', () => {
    const candidates = [
      { requirements: { commands: ['git status'] } },
      { requirements: { plugins: ['plugin\nname'] } },
      { requirements: { plugins: [`@${'a'.repeat(62)}/${'b'.repeat(63)}@${'c'.repeat(63)}`] } },
      { requirements: { environmentVariableNames: ['DATABASE_URL=secret'] } },
      { requirements: { commands: ['git', 'git'] } },
      { commitSha: 'A'.repeat(40) },
      { treeSha: 'short' },
    ];
    for (const candidate of candidates) {
      expect(
        CreateProjectAgentShareBodySchema.safeParse({ ...validBody, ...candidate }).success,
      ).toBe(false);
    }
  });

  it('rejects V0 free text that PostgreSQL jsonb cannot persist', () => {
    for (const invalidText of ['contains\u0000nul', 'lone-high-\ud800', 'lone-low-\udc00']) {
      for (const candidate of [
        { name: invalidText },
        { description: invalidText },
        { startPrompt: invalidText },
        { sourceRef: `refs/heads/${invalidText}` },
        { requirements: { ...validBody.requirements, codexVersion: invalidText } },
      ]) {
        expect(
          CreateProjectAgentShareBodySchema.safeParse({ ...validBody, ...candidate }).success,
        ).toBe(false);
      }
    }
    expect(
      CreateProjectAgentShareBodySchema.safeParse({
        ...validBody,
        description: '合法控制\u0001、CRLF\r\n与 astral 🙂',
        startPrompt: 'Review\u0002🙂',
      }).success,
    ).toBe(true);
  });

  it('rejects file, session and credential fields instead of silently dropping them', () => {
    for (const extra of [
      { files: ['README.md'] },
      { session: { id: 'private' } },
      { accessToken: 'private' },
      { environment: { DATABASE_URL: 'private' } },
    ]) {
      expect(CreateProjectAgentShareBodySchema.safeParse({ ...validBody, ...extra }).success).toBe(
        false,
      );
    }
  });

  it('requires normalized requirements and exact source identity in a public manifest', () => {
    const manifest = {
      schemaVersion: 'combo.project-agent-share/1',
      name: validBody.name,
      description: validBody.description,
      source: {
        repositoryUrl: validBody.repositoryUrl,
        sourceRef: validBody.sourceRef,
        commitSha: validBody.commitSha,
        treeSha: validBody.treeSha,
      },
      startPrompt: validBody.startPrompt,
      requirements: { commands: [], plugins: [], environmentVariableNames: [] },
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    expect(ProjectAgentShareManifestSchema.parse(manifest)).toEqual(manifest);
  });
});
