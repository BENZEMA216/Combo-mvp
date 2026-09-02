import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PendingUsageRecoveryView } from '@cb/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as ReactRouterDom from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HostedKnowledgeAgentAnonymous,
  HostedKnowledgeAgentPage,
} from './HostedKnowledgeAgentPage.js';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  navigate: vi.fn(),
  resolveRecovery: vi.fn<() => Promise<PendingUsageRecoveryView | null>>(async () => null),
}));

vi.mock('../api/runtime.js', () => ({
  useHostedKnowledgeAgentDescriptor: () => ({
    data: {
      slug: 'combo-knowledge',
      name: 'Combo 知识助手',
      summary: '基于已发布知识回答陌生问题。',
      billing: { currency: 'CNY', unitPriceCents: '100', freeUses: 3 },
    },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useStartHostedKnowledgeAgent: () => ({
    mutateAsync: mocks.start,
    isPending: false,
    error: null,
  }),
}));

vi.mock('../api/recovery.js', () => ({
  resolveHostedPendingRecovery: mocks.resolveRecovery,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof ReactRouterDom>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});

function renderAuthed(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HostedKnowledgeAgentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.start.mockReset();
  mocks.navigate.mockReset();
  mocks.resolveRecovery.mockReset();
  mocks.resolveRecovery.mockResolvedValue(null);
});

describe('fixed hosted knowledge Agent page', () => {
  it('renders an anonymous static Beta shell with the exact first-party login returnTo', () => {
    render(<HostedKnowledgeAgentAnonymous />);
    expect(screen.getByText('Combo 知识助手')).toBeInTheDocument();
    expect(screen.getByText(/Test Beta/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '登录后开始体验' })).toHaveAttribute(
      'href',
      '/login?returnTo=%2Ftry%2Fagent%2Fcombo-knowledge',
    );
  });

  it('starts only after an explicit click and navigates using the strict sessionId response', async () => {
    mocks.start.mockResolvedValue({ sessionId: 'session-new' });
    renderAuthed();

    expect(await screen.findByText('基于已发布知识回答陌生问题。')).toBeInTheDocument();
    expect(mocks.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '开始提问' }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(mocks.navigate).toHaveBeenCalledWith('/session/session-new');
  });

  it('discovers pending work from the server and enters its frozen Session without starting anew', async () => {
    mocks.resolveRecovery.mockResolvedValue(pendingRecovery());
    renderAuthed();

    fireEvent.click(await screen.findByRole('button', { name: '继续原问题' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/session/11111111-1111-4111-8111-111111111111');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('fails closed without starting when exact server recovery cannot be established', async () => {
    mocks.resolveRecovery.mockRejectedValue(new Error('list/exact mismatch'));
    renderAuthed();

    expect(await screen.findByRole('alert')).toHaveTextContent('当前 Test Agent 暂不可用');
    expect(screen.queryByRole('button', { name: '开始提问' })).not.toBeInTheDocument();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

function pendingRecovery(): PendingUsageRecoveryView {
  return {
    usageId: '22222222-2222-4222-8222-222222222222',
    sessionId: '11111111-1111-4111-8111-111111111111',
    capabilityId: '33333333-3333-4333-8333-333333333333',
    requestText: '原问题',
    requestFingerprint: '4'.repeat(64),
    binding: {
      productKind: 'knowledge_agent_test',
      capability: {
        id: '33333333-3333-4333-8333-333333333333',
        protocol: 'combo.agent-package-capability/2',
      },
      release: {
        protocol: 'combo.agent-package-release/1',
        releaseId: `release.agent-package.${'5'.repeat(32)}`,
        packageDigest: `sha256:${'6'.repeat(64)}`,
      },
      releaseScope: 'controlled_test',
      knowledge: {
        protocol: 'combo.knowledge-bundle/1',
        resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
        resourceDigest: `sha256:${'7'.repeat(64)}`,
      },
    },
    billing: {
      currency: 'CNY',
      policyVersion: 'runtime-usage-v1',
      validatorPolicyVersion: 'knowledge-agent-grounded-validator-v2',
      unitPriceCents: '100',
      freeLimitSnapshot: 3,
    },
    status: 'active',
    activeRechargeIntentId: '88888888-8888-4888-8888-888888888888',
    expiresAt: '2026-09-03T00:00:00.000Z',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:01:00.000Z',
  };
}
