import { afterEach, describe, expect, it } from 'vitest';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { fetchProjectAgentShare } from './projectAgentShareApi.js';

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

describe('projectAgentShareApi', () => {
  it('runtime-validates the public response instead of trusting a TypeScript generic', async () => {
    fetchMock = installFetchMock({ status: 200, json: { data: { manifest: {}, shareUrl: 3 } } });

    await expect(fetchProjectAgentShare('A'.repeat(43))).rejects.toThrow();
    expect(fetchMock.calls[0]?.url).toBe(`/api/v1/project-agent-shares/${'A'.repeat(43)}`);
  });

  it('fails closed when a schema-valid response points to another origin or token', async () => {
    const token = 'A'.repeat(43);
    const base = {
      manifest: {
        schemaVersion: 'combo.project-agent-share/1',
        name: 'Reviewer',
        description: 'Review a repository.',
        source: {
          repositoryUrl: 'https://github.com/openai/codex.git',
          sourceRef: 'refs/heads/main',
          commitSha: 'a'.repeat(40),
          treeSha: 'b'.repeat(40),
        },
        startPrompt: 'Review it.',
        requirements: { commands: [], plugins: [], environmentVariableNames: [] },
        createdAt: '2026-08-10T00:00:00.000Z',
      },
      copyPrompt: 'Review this link after confirmation.',
    };
    fetchMock = installFetchMock([
      {
        status: 200,
        json: { data: { ...base, shareUrl: `https://evil.example/project-agent/${token}` } },
      },
      {
        status: 200,
        json: {
          data: {
            ...base,
            shareUrl: new URL(
              `/project-agent/${'B'.repeat(43)}`,
              window.location.origin,
            ).toString(),
          },
        },
      },
    ]);

    await expect(fetchProjectAgentShare(token)).rejects.toThrow(/does not match/u);
    await expect(fetchProjectAgentShare(token)).rejects.toThrow(/does not match/u);
  });

  it('rejects a malformed token before making an anonymous request', async () => {
    fetchMock = installFetchMock({ status: 200, json: { data: {} } });
    await expect(fetchProjectAgentShare('not-a-token')).rejects.toThrow();
    expect(fetchMock.calls).toHaveLength(0);
  });
});
