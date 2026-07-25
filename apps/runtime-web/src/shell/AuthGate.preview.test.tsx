import type { ReleaseMetadata } from '@cb/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AuthGate } from './AuthGate.js';
import { ReleaseMetadataProvider } from './releaseIdentity.js';

const PREVIEW_METADATA: ReleaseMetadata = {
  schemaVersion: 1,
  environment: 'preview',
  sourceSha: 'a'.repeat(40),
  releaseId: `release-${'a'.repeat(40)}`,
  builtAt: '2026-07-25T00:00:00.000Z',
  releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
  webAssetManifest: `sha256:${'c'.repeat(64)}`,
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/try/');
});

describe('AuthGate Preview recovery', () => {
  it('sends a rejected refresh to Preview bootstrap instead of OIDC', async () => {
    window.history.replaceState(
      {},
      '',
      '/try/session/11111111-1111-4111-8111-111111111111?mode=studio',
    );
    const replies = [new Response(null, { status: 401 }), new Response(null, { status: 401 })];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => replies.shift() ?? new Response(null, { status: 500 })),
    );
    const navigateToAuth = vi.fn<(target: string) => void>();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <ReleaseMetadataProvider metadata={PREVIEW_METADATA}>
        <QueryClientProvider client={queryClient}>
          <AuthGate navigateToAuth={navigateToAuth}>
            <p>受保护试用内容</p>
          </AuthGate>
        </QueryClientProvider>
      </ReleaseMetadataProvider>,
    );

    expect(await screen.findByText('预览会话已失效，请恢复后继续。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去登录' })).toBeNull();
    expect(screen.queryByRole('button', { name: '本地开发登录' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '恢复预览会话' }));
    expect(navigateToAuth).toHaveBeenCalledWith(
      `/__review/bootstrap?returnTo=${encodeURIComponent(
        '/try/session/11111111-1111-4111-8111-111111111111?mode=studio',
      )}`,
    );
  });
});
