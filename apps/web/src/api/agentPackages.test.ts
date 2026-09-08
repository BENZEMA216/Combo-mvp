import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentPackageRequestError,
  approveAgentTransfer,
  getAgentPackageDownload,
  getAgentPublication,
  getAgentTransfer,
  publicationRequestId,
  publishAgentTransfer,
} from './agentPackages.js';
import { resetUnauthorizedRedirectForTest, unauthorizedNavigation } from './client.js';

const ID = '11111111-1111-4111-8111-111111111111';
const RELEASE = `release.agent-package.${'a'.repeat(32)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const FINGERPRINT = `sha256:${'c'.repeat(64)}`;
const files = [
  { path: 'AGENT.md', text: '# Agent\n安全内容' },
  { path: 'skills/method/SKILL.md', text: '# Method\n可复用方法' },
];
const pkg = {
  manifestText: JSON.stringify({
    protocol: 'combo.agent-package/1',
    name: 'method-agent',
    description: '方法 Agent',
  }),
  packageDigest: DIGEST,
  files,
};
const transfer = {
  protocol: 'combo.agent-transfer/1',
  transferId: ID,
  phase: 'pending_approval',
  approvalUrl: `${window.location.origin}/agent-transfers/${ID}`,
  verificationCode: 'AB12CD34',
  expiresAt: '2030-09-08T08:00:00.000Z',
};
const view = {
  transfer,
  name: 'method-agent',
  draftFingerprint: FINGERPRINT,
  packageDigest: DIGEST,
};
const publicView = {
  protocol: 'combo.agent-publication/1',
  release: { protocol: 'combo.agent-package-release/1', releaseId: RELEASE, packageDigest: DIGEST },
  publishedAt: '2026-09-08T08:00:00.000Z',
  name: 'method-agent',
  description: '方法 Agent',
  publisher: { account: 'creator-abcdefgh' },
  sourceVerification: 'not_verified',
  package: pkg,
  shareUrl: `${window.location.origin}/agents/${RELEASE}`,
  acquirePrompt: '请核对后在当前任务中使用。',
};
const publishedReceipt = {
  ...transfer,
  phase: 'published',
  saved: { draftId: 'draft-id', revision: 1, draftFingerprint: FINGERPRINT, packageDigest: DIGEST },
  release: {
    releaseId: RELEASE,
    packageDigest: DIGEST,
    shareUrl: publicView.shareUrl,
    acquirePrompt: publicView.acquirePrompt,
  },
};
const fetcher = vi.fn<typeof fetch>();
function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: { traceId: 'test-only' } }), { status });
}

beforeEach(() => {
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
  sessionStorage.clear();
  resetUnauthorizedRedirectForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('Agent Package HTTP boundary', () => {
  it('reads a private transfer with Cookie but never sends upload secret or approval', async () => {
    fetcher.mockResolvedValue(response({ ...view, secret: 'must-not-project' }));
    await expect(getAgentTransfer(ID)).resolves.toEqual(view);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/agent-package-transfers/${ID}`,
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
      }),
    );
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });
  it('reads public metadata anonymously and does not probe /me', async () => {
    fetcher.mockResolvedValue(response(publicView));
    await expect(getAgentPublication(RELEASE)).resolves.toEqual(publicView);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/agent-package-publications/${RELEASE}`,
      expect.objectContaining({ method: 'GET', credentials: 'omit' }),
    );
  });
  it('downloads only bare Package JSON and preserves the received JSON text', async () => {
    const text = JSON.stringify(pkg, null, 2);
    fetcher.mockResolvedValue(new Response(text));
    const blob = await getAgentPackageDownload(RELEASE, DIGEST);
    const read = new FileReader();
    const result = new Promise((resolve) => {
      read.onload = () => resolve(read.result);
    });
    read.readAsText(blob);
    await expect(result).resolves.toBe(text);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/agent-package-publications/${RELEASE}/package`,
      expect.objectContaining({ credentials: 'omit', method: 'GET' }),
    );
  });
  it('approval and publication are separate explicit POSTs bound to exact digests', async () => {
    fetcher.mockImplementation(async () => response({ ...transfer, phase: 'approved' }));
    const approval = {
      decision: 'approve' as const,
      verificationCode: 'AB12CD34',
      draftFingerprint: FINGERPRINT,
      packageDigest: DIGEST,
    };
    await approveAgentTransfer(ID, approval);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/v1/agent-package-transfers/${ID}/approval`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'include',
      method: 'POST',
      body: JSON.stringify(approval),
    });
    const publish = {
      requestId: ID,
      draftFingerprint: FINGERPRINT,
      packageDigest: DIGEST,
      confirmPublic: true as const,
    };
    fetcher.mockResolvedValueOnce(response(publishedReceipt));
    await publishAgentTransfer(ID, publish);
    expect(fetcher.mock.calls[1]?.[0]).toBe(`/api/v1/agent-package-transfers/${ID}/publication`);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(publish));
  });
  it.each([
    {
      ...publishedReceipt,
      saved: { ...publishedReceipt.saved, draftFingerprint: `sha256:${'e'.repeat(64)}` },
    },
    {
      ...publishedReceipt,
      saved: {
        ...publishedReceipt.saved,
        draftFingerprint: `sha256:${'e'.repeat(64)}`,
        packageDigest: `sha256:${'d'.repeat(64)}`,
      },
      release: { ...publishedReceipt.release, packageDigest: `sha256:${'d'.repeat(64)}` },
    },
    { ...transfer, phase: 'approved' },
  ])(
    'refuses a mutation response that does not publish the exact submitted pair %#',
    async (payload) => {
      fetcher.mockResolvedValue(response(payload));
      await expect(
        publishAgentTransfer(ID, {
          requestId: ID,
          draftFingerprint: FINGERPRINT,
          packageDigest: DIGEST,
          confirmPublic: true,
        }),
      ).rejects.toMatchObject({ outcomeUncertain: true });
    },
  );
  it.each([404, 503])('does not reveal server error content for HTTP %s', async (status) => {
    fetcher.mockResolvedValue(response({ secret: 'sensitive-stack-raw' }, status));
    const error = await getAgentPublication(RELEASE).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AgentPackageRequestError);
    expect(String(error)).not.toContain('sensitive-stack-raw');
  });
  it('public 401 never redirects to login, private 401 preserves exact transfer returnTo', async () => {
    const navigate = vi.spyOn(unauthorizedNavigation, 'assign').mockImplementation(() => {});
    fetcher.mockImplementation(async () => response({}, 401));
    await expect(getAgentPublication(RELEASE)).rejects.toBeInstanceOf(AgentPackageRequestError);
    expect(navigate).not.toHaveBeenCalled();
    window.history.replaceState({}, '', `/agent-transfers/${ID}`);
    await expect(getAgentTransfer(ID)).rejects.toBeInstanceOf(AgentPackageRequestError);
    expect(navigate).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent(`/agent-transfers/${ID}`)}`,
    );
  });
  it.each([
    { ...publicView, shareUrl: 'https://evil.example/agents/x' },
    { ...publicView, shareUrl: `${publicView.shareUrl}?secret=x` },
    { ...publicView, sourceVerification: 'verified' },
    { ...publicView, release: { ...publicView.release, releaseId: 'other' } },
    { ...publicView, package: { ...pkg, packageDigest: FINGERPRINT } },
    { ...publicView, package: { ...pkg, files: [...files, files[0]] } },
    {
      ...publicView,
      package: { ...pkg, files: [{ path: 'skills/../hidden', text: 'x' }, ...files] },
    },
    { ...publicView, package: { ...pkg, files: [{ path: 'agent.json', text: '{}' }, ...files] } },
    { ...publicView, package: { ...pkg, manifestText: '<html>not JSON</html>' } },
  ])('fails closed on malformed or misbound public projection %#', async (payload) => {
    fetcher.mockResolvedValue(response(payload));
    await expect(getAgentPublication(RELEASE)).rejects.toBeInstanceOf(AgentPackageRequestError);
  });
  it.each([
    { ...view, transfer: { ...transfer, transferId: 'other' } },
    { ...view, transfer: { ...transfer, phase: 'uploaded' }, review: pkg },
    { ...view, transfer: { ...transfer, phase: 'pending_approval', saved: {} } },
    {
      ...view,
      transfer: {
        ...transfer,
        phase: 'uploaded',
        saved: {
          draftId: 'draft-id',
          revision: 1,
          draftFingerprint: DIGEST,
          packageDigest: DIGEST,
        },
      },
      review: pkg,
    },
  ])('fails closed on inconsistent transfer receipt %#', async (payload) => {
    fetcher.mockResolvedValue(response(payload));
    await expect(getAgentTransfer(ID)).rejects.toBeInstanceOf(AgentPackageRequestError);
  });
  it('rejects malformed route IDs without a network request', () => {
    expect(() => getAgentTransfer('../me')).toThrow(AgentPackageRequestError);
    expect(() => getAgentPublication(`${RELEASE}?secret=x`)).toThrow(AgentPackageRequestError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('marks lost, non-JSON and 5xx POST outcomes uncertain without automatic retries', async () => {
    const input = {
      requestId: ID,
      draftFingerprint: FINGERPRINT,
      packageDigest: DIGEST,
      confirmPublic: true as const,
    };
    fetcher
      .mockRejectedValueOnce(new TypeError('socket lost'))
      .mockResolvedValueOnce(new Response('broken', { status: 200 }))
      .mockResolvedValueOnce(response({}, 503));
    for (let count = 0; count < 3; count++)
      await expect(publishAgentTransfer(ID, input)).rejects.toMatchObject({
        outcomeUncertain: true,
      });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('retains a single request ID across module reload and stores no package content or secrets', async () => {
    const first = publicationRequestId(ID, FINGERPRINT, DIGEST);
    vi.resetModules();
    const reloaded = await import('./agentPackages.js');
    expect(reloaded.publicationRequestId(ID, FINGERPRINT, DIGEST)).toBe(first);
    expect(JSON.parse(sessionStorage.getItem(`combo.agent-publication-request/1:${ID}`)!)).toEqual({
      requestId: first,
      draftFingerprint: FINGERPRINT,
      packageDigest: DIGEST,
    });
    expect(() => publicationRequestId(ID, DIGEST, FINGERPRINT)).toThrow('尚未发送');
  });
  it('blocks publication setup if session storage fails or contains a malformed prior request', () => {
    const key = `combo.agent-publication-request/1:${ID}`;
    sessionStorage.setItem(key, '{broken');
    expect(() => publicationRequestId(ID, FINGERPRINT, DIGEST)).toThrow('尚未发送');
    sessionStorage.clear();
    const setItem = vi
      .spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });
    expect(sessionStorage.setItem).toBe(setItem);
    expect(() => publicationRequestId(ID, FINGERPRINT, DIGEST)).toThrow('尚未发送');
    expect(setItem).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
