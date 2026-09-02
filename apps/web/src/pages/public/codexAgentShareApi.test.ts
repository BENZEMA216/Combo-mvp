import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@cb/shared';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { fetchCodexAgentShare } from './codexAgentShareApi.js';

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

const token = 'A'.repeat(43);
const manifest = {
  schemaVersion: 'combo.codex-agent-share/1',
  name: 'Reviewer',
  description: 'Review a repository.',
  source: {
    repositoryUrl: 'https://github.com/openai/codex.git',
    sourceRef: 'refs/heads/main',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
  },
  agent: { instructions: 'Review it.', starterPrompts: ['Review the branch.'] },
  authoringSource: { kind: 'codex_current_task', rawStored: false },
  requirements: { commands: [], plugins: [], environmentVariableNames: [] },
  createdAt: '2026-08-10T00:00:00.000Z',
} as const;
const base = {
  manifest,
  manifestSha256: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
  copyPrompt: 'Read this link, verify its digest, and wait for confirmation.',
};

describe('codexAgentShareApi', () => {
  it('runtime-validates the public v2 response', async () => {
    fetchMock = installFetchMock({ status: 200, json: { data: { manifest: {}, shareUrl: 3 } } });
    await expect(fetchCodexAgentShare(token)).rejects.toThrow();
    expect(fetchMock.calls[0]?.url).toBe(`/api/v1/codex-agent-shares/${token}`);
  });

  it('fails closed on another origin, token, or the legacy path', async () => {
    fetchMock = installFetchMock([
      { status: 200, json: { data: { ...base, shareUrl: `https://evil.example/agent/${token}` } } },
      {
        status: 200,
        json: {
          data: {
            ...base,
            shareUrl: new URL(`/agent/${'B'.repeat(43)}`, window.location.origin).toString(),
          },
        },
      },
      {
        status: 200,
        json: {
          data: {
            ...base,
            shareUrl: new URL(`/project-agent/${token}`, window.location.origin).toString(),
          },
        },
      },
    ]);
    await expect(fetchCodexAgentShare(token)).rejects.toThrow(/does not match/u);
    await expect(fetchCodexAgentShare(token)).rejects.toThrow(/does not match/u);
    await expect(fetchCodexAgentShare(token)).rejects.toThrow(/does not match/u);
  });

  it('rejects a tampered manifest when the advertised digest is unchanged', async () => {
    fetchMock = installFetchMock({
      status: 200,
      json: {
        data: {
          ...base,
          manifest: { ...base.manifest, description: 'tampered after digest creation' },
          shareUrl: new URL(`/agent/${token}`, window.location.origin).toString(),
        },
      },
    });
    await expect(fetchCodexAgentShare(token)).rejects.toThrow(/digest verification failed/u);
  });

  it('rejects a malformed token before making an anonymous request', async () => {
    fetchMock = installFetchMock({ status: 200, json: { data: {} } });
    await expect(fetchCodexAgentShare('not-a-token')).rejects.toThrow();
    expect(fetchMock.calls).toHaveLength(0);
  });
});
