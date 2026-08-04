// 公开能力页 /a/:slug（对外只读，裸壳 PublicLayout，无创作者外壳）。
// 结构：hero（eyebrow + 名称 + tagline + 描述 + 双 CTA）+ 三面板网格
// （需要你提供 / 可以这样开始 / 使用边界）。数据来自前端 mock 层 publicApi。
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { trialUrl } from '../../api/index.js';
import { ErrorState, Skeleton } from '../../components/index.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import { releasePath } from '../release/releaseDraft.js';
import { fetchLocalReleasePreview, fetchPublicCapability } from './publicApi.js';

export function PublicCapabilityPage(): ReactElement {
  const { slug = '' } = useParams<{ slug?: string }>();
  const [searchParams] = useSearchParams();
  const previewCapabilityId = searchParams.get('preview');
  const query = useQuery({
    queryKey: ['public-capability', slug, previewCapabilityId],
    queryFn: () =>
      previewCapabilityId
        ? fetchLocalReleasePreview(slug, previewCapabilityId)
        : fetchPublicCapability(slug),
    enabled: slug.length > 0,
    retry: false,
  });
  useDocumentTitle(query.data ? `${query.data.name} · Combo` : undefined);

  if (query.isLoading) {
    return (
      <section className="cb-public" aria-busy="true">
        <Skeleton rows={5} label="公开能力页加载中" />
      </section>
    );
  }

  if (query.isError || !query.data) {
    return (
      <section className="cb-public">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </section>
    );
  }

  const capability = query.data;

  return (
    <section
      className="cb-public cb-public-capability"
      aria-labelledby="cb-public-capability-title"
    >
      <header className="cb-public-capability__hero">
        <p className="cb-public-capability__eyebrow">
          {capability.localPreview ? '本机发布预览' : '公开能力'}
        </p>
        <h1 className="cb-public-capability__title" id="cb-public-capability-title">
          {capability.name}
        </h1>
        <p className="cb-public-capability__tagline">{capability.tagline}</p>
        <p className="cb-public-capability__description">{capability.description}</p>
        {capability.localPreview && (
          <div className="cb-public-capability__preview-note" role="note">
            <strong>这是这台设备上的效果预览</strong>
            <span>
              草稿定价：{capability.localPreview.pricing}
              。域名和计费尚未上线，这个地址不会分享给其他人。
            </span>
          </div>
        )}
        <div className="cb-public-capability__actions">
          {capability.localPreview ? (
            <>
              <a
                className="cb-public__action"
                href={trialUrl(
                  capability.localPreview.capabilityId,
                  releasePath(capability.localPreview.capabilityId, 'success'),
                )}
              >
                登录后真实试用
              </a>
              <Link
                className="cb-public__action cb-public__action--ghost"
                to={`/capabilities/${encodeURIComponent(capability.localPreview.capabilityId)}/release/success`}
              >
                返回发布结果
              </Link>
            </>
          ) : (
            <a className="cb-public__action" href="/capabilities">
              返回我的 Agent
            </a>
          )}
        </div>
      </header>

      <div className="cb-public-capability__grid">
        <section className="cb-public-capability__panel" aria-labelledby="cb-public-inputs-title">
          <h2 className="cb-public-capability__section-title" id="cb-public-inputs-title">
            需要你提供
          </h2>
          <ul className="cb-public-capability__field-list">
            {capability.inputs.fields.map((field) => (
              <li className="cb-public-capability__field" key={field.key}>
                <span>{field.label}</span>
                <small>
                  {field.required ? '必填' : '可选'} · {field.type}
                </small>
              </li>
            ))}
          </ul>
        </section>

        <section className="cb-public-capability__panel" aria-labelledby="cb-public-prompts-title">
          <h2 className="cb-public-capability__section-title" id="cb-public-prompts-title">
            可以这样开始
          </h2>
          <ul className="cb-public-capability__prompt-list">
            {capability.starterPrompts.map((prompt) => (
              <li className="cb-public-capability__prompt" key={prompt}>
                {prompt}
              </li>
            ))}
          </ul>
        </section>

        <section
          className="cb-public-capability__panel cb-public-capability__panel--wide"
          aria-labelledby="cb-public-boundaries-title"
        >
          <h2 className="cb-public-capability__section-title" id="cb-public-boundaries-title">
            使用边界
          </h2>
          <ul className="cb-public-capability__boundary-list">
            {capability.boundaries.redLines.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}
