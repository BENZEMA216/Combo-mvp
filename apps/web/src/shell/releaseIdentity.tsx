import {
  DEVELOPMENT_RELEASE_METADATA_ENV,
  loadReleaseMetadata,
  ReleaseMetadataLoadError,
  releaseMetadataFromEnv,
  type ReleaseMetadata,
  type ReleaseMetadataFetch,
} from '@cb/shared';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ComboWordmark } from './brand.js';

const DEVELOPMENT_METADATA = releaseMetadataFromEnv(DEVELOPMENT_RELEASE_METADATA_ENV);
const ReleaseMetadataContext = createContext<ReleaseMetadata>(DEVELOPMENT_METADATA);

export function ReleaseMetadataProvider({
  metadata,
  children,
}: {
  metadata: ReleaseMetadata;
  children: ReactNode;
}): ReactElement {
  return (
    <ReleaseMetadataContext.Provider value={metadata}>{children}</ReleaseMetadataContext.Provider>
  );
}

export function useReleaseMetadata(): ReleaseMetadata {
  return useContext(ReleaseMetadataContext);
}

/**
 * Web 只从运行时文件读取发布身份。仅本地 Vite 开发模式允许使用固定 development 占位身份；
 * 任何非开发构建都让错误冒泡，由入口渲染阻断页。
 */
export async function resolveWebReleaseMetadata({
  development,
  fetchMetadata,
}: {
  development: boolean;
  fetchMetadata?: ReleaseMetadataFetch;
}): Promise<ReleaseMetadata> {
  try {
    const metadata = await loadReleaseMetadata('/runtime-config.json', fetchMetadata);
    if (!development && metadata.environment === 'development') {
      throw new ReleaseMetadataLoadError('invalid');
    }
    return metadata;
  } catch (error) {
    if (development) return DEVELOPMENT_METADATA;
    throw error;
  }
}

export function ReleaseMetadataLoading(): ReactElement {
  return (
    <main className="cb-release-gate" role="status" aria-live="polite">
      <ComboWordmark className="cb-release-gate__brand" />
      <p>正在确认当前发布身份…</p>
    </main>
  );
}

export function ReleaseMetadataFailure(): ReactElement {
  return (
    <main className="cb-release-gate" role="alert">
      <ComboWordmark className="cb-release-gate__brand" />
      <h1>无法确认当前发布版本</h1>
      <p>运行时发布信息缺失或不完整。为避免进入身份不明的环境，页面已停止加载。</p>
      <button type="button" onClick={() => window.location.reload()}>
        重新加载
      </button>
    </main>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

export interface ReleaseIdentityBadgeProps {
  metadata?: ReleaseMetadata;
  writeClipboard?: (text: string) => Promise<void>;
}

/**
 * Preview 身份胶囊。所有展示值都来自 runtime-config.json，不读取 Vite 构建变量。
 */
export function ReleaseIdentityBadge({
  metadata: metadataOverride,
  writeClipboard = (text) => navigator.clipboard.writeText(text),
}: ReleaseIdentityBadgeProps = {}): ReactElement | null {
  const contextMetadata = useReleaseMetadata();
  const metadata = metadataOverride ?? contextMetadata;
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const rootRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const resetTimerRef = useRef<number | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!expanded) return;

    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setExpanded(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setExpanded(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [expanded]);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    },
    [],
  );

  if (metadata.environment !== 'preview') return null;

  const copyLabel =
    copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制验收上下文';

  const copyAcceptanceContext = async (): Promise<void> => {
    const context = [
      'Combo Preview acceptance context',
      // Query/hash may carry workflow context. Acceptance identity only needs the route.
      `page=${window.location.origin}${window.location.pathname}`,
      `environment=${metadata.environment}`,
      `sourceSha=${metadata.sourceSha}`,
      `releaseId=${metadata.releaseId}`,
      `releaseManifestDigest=${metadata.releaseManifestDigest}`,
      `webAssetManifest=${metadata.webAssetManifest}`,
      `viewport=${window.innerWidth}x${window.innerHeight}`,
      `userAgent=${navigator.userAgent}`,
    ].join('\n');

    try {
      await writeClipboard(context);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1_800);
  };

  return (
    <aside ref={rootRef} className="cb-release-identity" aria-label="Preview 发布身份">
      <button
        ref={triggerRef}
        type="button"
        className="cb-release-identity__trigger"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="cb-release-identity__mark" aria-hidden="true" />
        <span>Preview</span>
        <code>{metadata.sourceSha.slice(0, 8)}</code>
      </button>

      {expanded ? (
        <section
          id={panelId}
          className="cb-release-identity__panel"
          role="region"
          aria-label="Preview 发布详情"
        >
          <div className="cb-release-identity__heading">
            <strong>Preview 发布身份</strong>
            <span>数据与正式环境隔离</span>
          </div>
          <dl>
            <div>
              <dt>环境</dt>
              <dd>{metadata.environment}</dd>
            </div>
            <div>
              <dt>完整 SHA</dt>
              <dd>
                <code>{metadata.sourceSha}</code>
              </dd>
            </div>
            <div>
              <dt>Release ID</dt>
              <dd>
                <code>{metadata.releaseId}</code>
              </dd>
            </div>
            <div>
              <dt>Web 资产摘要</dt>
              <dd>
                <code>{metadata.webAssetManifest}</code>
              </dd>
            </div>
          </dl>
          <button type="button" onClick={() => void copyAcceptanceContext()}>
            {copyLabel}
          </button>
          <span role="status" aria-live="polite" className="cb-release-identity__status">
            {copyState === 'copied'
              ? '验收上下文已复制'
              : copyState === 'failed'
                ? '复制失败，请重试'
                : ''}
          </span>
        </section>
      ) : null}
    </aside>
  );
}
