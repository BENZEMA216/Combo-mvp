import type { ReleaseMetadata } from '@cb/shared';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ReleaseIdentityBadge,
  ReleaseMetadataFailure,
  resolveWebReleaseMetadata,
} from './releaseIdentity.js';

const PREVIEW_METADATA: ReleaseMetadata = {
  schemaVersion: 1,
  environment: 'preview',
  sourceSha: 'a'.repeat(40),
  releaseId: `release-${'a'.repeat(40)}`,
  builtAt: '2026-07-25T00:00:00.000Z',
  releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
  webAssetManifest: `sha256:${'c'.repeat(64)}`,
};
const DEVELOPMENT_METADATA: ReleaseMetadata = {
  schemaVersion: 1,
  environment: 'development',
  sourceSha: '0'.repeat(40),
  releaseId: `release-${'0'.repeat(40)}`,
  builtAt: '1970-01-01T00:00:00.000Z',
  releaseManifestDigest: `sha256:${'0'.repeat(64)}`,
  webAssetManifest: `sha256:${'0'.repeat(64)}`,
};

describe('resolveWebReleaseMetadata', () => {
  it('loads the exact runtime config path', async () => {
    const fetchMetadata = vi.fn(async () => ({
      ok: true,
      json: async () => PREVIEW_METADATA,
    }));

    await expect(resolveWebReleaseMetadata({ development: false, fetchMetadata })).resolves.toEqual(
      PREVIEW_METADATA,
    );
    expect(fetchMetadata).toHaveBeenCalledWith('/runtime-config.json', expect.any(Object));
  });

  it('only permits fixed development metadata in explicit development mode', async () => {
    const fetchMetadata = vi.fn(async () => {
      throw new Error('missing runtime config');
    });

    await expect(
      resolveWebReleaseMetadata({ development: true, fetchMetadata }),
    ).resolves.toMatchObject({ environment: 'development', sourceSha: '0'.repeat(40) });
    await expect(
      resolveWebReleaseMetadata({ development: false, fetchMetadata }),
    ).rejects.toThrow();
  });

  it('rejects a syntactically valid development identity in every deployed build', async () => {
    const fetchMetadata = vi.fn(async () => ({
      ok: true,
      json: async () => DEVELOPMENT_METADATA,
    }));

    await expect(
      resolveWebReleaseMetadata({ development: false, fetchMetadata }),
    ).rejects.toMatchObject({ name: 'ReleaseMetadataLoadError', failure: 'invalid' });
    await expect(resolveWebReleaseMetadata({ development: true, fetchMetadata })).resolves.toEqual(
      DEVELOPMENT_METADATA,
    );
  });
});

describe('ReleaseIdentityBadge', () => {
  it('stays hidden outside Preview', () => {
    render(<ReleaseIdentityBadge metadata={{ ...PREVIEW_METADATA, environment: 'production' }} />);
    expect(screen.queryByLabelText('Preview 发布身份')).toBeNull();
  });

  it('shows complete runtime identity and copies a sanitized acceptance context', async () => {
    window.history.replaceState(
      {},
      '',
      '/tasks/01982e62-6d6e-7f4d-8fe8-b55f62720b5b?token=hidden#secret',
    );
    const writeClipboard = vi.fn<(text: string) => Promise<void>>(async () => {});
    render(<ReleaseIdentityBadge metadata={PREVIEW_METADATA} writeClipboard={writeClipboard} />);

    const trigger = screen.getByRole('button', { name: /Preview aaaaaaaa/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);

    const panel = screen.getByRole('region', { name: 'Preview 发布详情' });
    expect(panel).toHaveTextContent('preview');
    expect(panel).toHaveTextContent(PREVIEW_METADATA.sourceSha);
    expect(panel).toHaveTextContent(PREVIEW_METADATA.releaseId);
    expect(panel).toHaveTextContent(PREVIEW_METADATA.webAssetManifest);

    await userEvent.click(screen.getByRole('button', { name: '复制验收上下文' }));
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    const copied = writeClipboard.mock.calls[0]?.[0] ?? '';
    expect(copied).toContain(`environment=preview`);
    expect(copied).toContain(`sourceSha=${PREVIEW_METADATA.sourceSha}`);
    expect(copied).toContain(`releaseId=${PREVIEW_METADATA.releaseId}`);
    expect(copied).toContain(`webAssetManifest=${PREVIEW_METADATA.webAssetManifest}`);
    expect(copied).toContain(
      'page=http://localhost:3000/tasks/01982e62-6d6e-7f4d-8fe8-b55f62720b5b',
    );
    expect(copied).not.toContain('token=hidden');
    expect(copied).not.toContain('#secret');
    expect(await screen.findByRole('status')).toHaveTextContent('验收上下文已复制');
  });

  it('closes on Escape and returns focus to its trigger', async () => {
    render(<ReleaseIdentityBadge metadata={PREVIEW_METADATA} />);
    const trigger = screen.getByRole('button', { name: /Preview aaaaaaaa/ });

    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('region', { name: 'Preview 发布详情' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('renders a blocking, non-technical failure page', () => {
    render(<ReleaseMetadataFailure />);
    expect(screen.getByRole('alert')).toHaveTextContent('无法确认当前发布版本');
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
    expect(screen.queryByText(/Zod|HTTP|schemaVersion/)).toBeNull();
  });
});
