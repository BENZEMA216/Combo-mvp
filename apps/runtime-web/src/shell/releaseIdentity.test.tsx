import type { ReleaseMetadata } from '@cb/shared';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  RUNTIME_RELEASE_METADATA_PATH,
  ReleaseIdentityBadge,
  ReleaseMetadataFailure,
  resolveRuntimeReleaseMetadata,
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

describe('resolveRuntimeReleaseMetadata', () => {
  it('loads the explicit /try/ runtime config path', async () => {
    const fetchMetadata = vi.fn(async () => ({
      ok: true,
      json: async () => PREVIEW_METADATA,
    }));

    await expect(
      resolveRuntimeReleaseMetadata({ development: false, fetchMetadata }),
    ).resolves.toEqual(PREVIEW_METADATA);
    expect(RUNTIME_RELEASE_METADATA_PATH).toBe('/try/runtime-config.json');
    expect(fetchMetadata).toHaveBeenCalledWith(
      '/try/runtime-config.json',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    );
  });

  it('only permits fixed development metadata in explicit development mode', async () => {
    const fetchMetadata = vi.fn(async () => {
      throw new Error('missing runtime config');
    });

    await expect(
      resolveRuntimeReleaseMetadata({ development: true, fetchMetadata }),
    ).resolves.toMatchObject({ environment: 'development', sourceSha: '0'.repeat(40) });
    await expect(
      resolveRuntimeReleaseMetadata({ development: false, fetchMetadata }),
    ).rejects.toThrow();
  });

  it('rejects a syntactically valid development identity in every deployed build', async () => {
    const fetchMetadata = vi.fn(async () => ({
      ok: true,
      json: async () => DEVELOPMENT_METADATA,
    }));

    await expect(
      resolveRuntimeReleaseMetadata({ development: false, fetchMetadata }),
    ).rejects.toMatchObject({ name: 'ReleaseMetadataLoadError', failure: 'invalid' });
    await expect(
      resolveRuntimeReleaseMetadata({ development: true, fetchMetadata }),
    ).resolves.toEqual(DEVELOPMENT_METADATA);
  });
});

describe('ReleaseIdentityBadge', () => {
  it('reserves non-overlapping toolbar space in Preview viewports', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

    expect(styles).toMatch(
      /\.rt-release-identity\s*\{[\s\S]*?right:\s*64px;[\s\S]*?z-index:\s*90;/,
    );
    expect(styles).toMatch(
      /@media \(min-width: 901px\)\s*\{[\s\S]*?\.rt-release-identity ~ \.rt-shell \.rt-trial__toolbar\s*\{[\s\S]*?padding-right:\s*224px;/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 900px\)\s*\{[\s\S]*?\.rt-release-identity ~ \.rt-shell \.rt-trial__toolbar\s*\{[\s\S]*?padding-top:\s*58px;/,
    );
  });

  it('stays hidden outside Preview', () => {
    render(<ReleaseIdentityBadge metadata={{ ...PREVIEW_METADATA, environment: 'production' }} />);
    expect(screen.queryByLabelText('Preview 发布身份')).toBeNull();
  });

  it('shows complete identity and copies a credential-free acceptance context', async () => {
    window.history.replaceState({}, '', '/try/session/acceptance?invite=secret#token');
    const writeClipboard = vi.fn<(text: string) => Promise<void>>(async () => {});
    render(<ReleaseIdentityBadge metadata={PREVIEW_METADATA} writeClipboard={writeClipboard} />);

    const trigger = screen.getByRole('button', { name: /Preview aaaaaaaa/ });
    fireEvent.click(trigger);

    const panel = screen.getByRole('region', { name: 'Preview 发布详情' });
    expect(panel).toHaveTextContent('preview');
    expect(panel).toHaveTextContent(PREVIEW_METADATA.sourceSha);
    expect(panel).toHaveTextContent(PREVIEW_METADATA.releaseId);
    expect(panel).toHaveTextContent(PREVIEW_METADATA.webAssetManifest);

    fireEvent.click(screen.getByRole('button', { name: '复制验收上下文' }));
    const copied = writeClipboard.mock.calls[0]?.[0] ?? '';
    expect(copied).toContain(`environment=preview`);
    expect(copied).toContain(`sourceSha=${PREVIEW_METADATA.sourceSha}`);
    expect(copied).toContain(`releaseId=${PREVIEW_METADATA.releaseId}`);
    expect(copied).toContain(`webAssetManifest=${PREVIEW_METADATA.webAssetManifest}`);
    expect(copied).toContain('page=http://localhost:3000/try/session/acceptance');
    expect(copied).not.toContain('invite=secret');
    expect(copied).not.toMatch(/cookie|token|authorization/i);
    expect(await screen.findByRole('status')).toHaveTextContent('验收上下文已复制');
  });

  it('closes on Escape and restores focus', () => {
    render(<ReleaseIdentityBadge metadata={PREVIEW_METADATA} />);
    const trigger = screen.getByRole('button', { name: /Preview aaaaaaaa/ });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('region', { name: 'Preview 发布详情' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('renders a blocking non-technical failure page', () => {
    render(<ReleaseMetadataFailure />);
    expect(screen.getByRole('alert')).toHaveTextContent('无法确认当前发布版本');
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
    expect(screen.queryByText(/Zod|HTTP|schemaVersion/)).toBeNull();
  });
});
