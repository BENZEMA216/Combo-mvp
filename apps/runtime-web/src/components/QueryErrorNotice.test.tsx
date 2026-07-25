import type { ReleaseMetadata } from '@cb/shared';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '../api/client.js';
import { ReleaseMetadataProvider } from '../shell/releaseIdentity.js';
import { QueryErrorNotice } from './QueryErrorNotice.js';

const PREVIEW_METADATA: ReleaseMetadata = {
  schemaVersion: 1,
  environment: 'preview',
  sourceSha: 'a'.repeat(40),
  releaseId: `release-${'a'.repeat(40)}`,
  builtAt: '2026-07-25T00:00:00.000Z',
  releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
  webAssetManifest: `sha256:${'c'.repeat(64)}`,
};

describe('QueryErrorNotice authentication recovery', () => {
  it('routes Preview 401 recovery through bootstrap with the safe current /try path', () => {
    window.history.replaceState(
      {},
      '',
      '/try/session/11111111-1111-4111-8111-111111111111?mode=studio',
    );
    const navigateToAuth = vi.fn<(target: string) => void>();
    render(
      <ReleaseMetadataProvider metadata={PREVIEW_METADATA}>
        <QueryErrorNotice
          error={new ApiError('请先登录。', 401)}
          onRetry={vi.fn()}
          navigateToAuth={navigateToAuth}
        />
      </ReleaseMetadataProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '恢复预览会话' }));
    expect(navigateToAuth).toHaveBeenCalledWith(
      `/__review/bootstrap?returnTo=${encodeURIComponent(
        '/try/session/11111111-1111-4111-8111-111111111111?mode=studio',
      )}`,
    );
  });

  it('keeps non-Preview 401 recovery on the existing OIDC login', () => {
    const navigateToAuth = vi.fn<(target: string) => void>();
    render(
      <QueryErrorNotice
        error={new ApiError('请先登录。', 401)}
        onRetry={vi.fn()}
        navigateToAuth={navigateToAuth}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '去登录' }));
    expect(navigateToAuth).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/v1\/auth\/login/));
  });
});
