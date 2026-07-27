// 我的 Agent：把提取出的能力作为可持续编辑的 Agent 项目管理。
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type { CapabilityView, PublishResult } from '@cb/shared';
import {
  createStudioSession,
  listCapabilities,
  publishCapability,
  unpublishCapability,
  type Page,
} from '../../api/index.js';
import { ErrorState, Skeleton } from '../../components/index.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import { CapabilityRow } from './CapabilityRow.js';

type CapabilityFilter = 'all' | 'published' | 'draft';
type CapabilityPages = InfiniteData<Page<CapabilityView>>;

const CAPABILITY_FILTERS: ReadonlyArray<{ key: CapabilityFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'published', label: '已上架' },
  { key: 'draft', label: '草稿' },
];

/** 发布结果只改变对应 Agent；保留已加载页和游标，避免发布后整表跳动。 */
export function mergePublishResult(
  data: CapabilityPages | undefined,
  result: PublishResult,
): CapabilityPages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.id === result.id
          ? {
              ...item,
              published: result.published,
              ...(result.publishedAt !== undefined ? { publishedAt: result.publishedAt } : {}),
              ...(result.shareToken !== undefined ? { shareToken: result.shareToken } : {}),
            }
          : item,
      ),
    })),
  };
}

export interface CapabilitiesPageProps {
  /** 注入点只供测试；生产必须整页进入独立的 runtime-web bundle。 */
  navigateToStudio?: (url: string) => void;
}

function defaultNavigateToStudio(url: string): void {
  window.location.assign(url);
}

function studioUrl(sessionId: string): string {
  return `/try/session/${encodeURIComponent(sessionId)}?mode=studio&returnTo=${encodeURIComponent('/capabilities')}`;
}

export function CapabilitiesPage({
  navigateToStudio = defaultNavigateToStudio,
}: CapabilitiesPageProps = {}): ReactElement {
  const [params] = useSearchParams();
  const taskId = params.get('taskId') ?? undefined;
  const [filter, setFilter] = useState<CapabilityFilter>('all');
  const [editError, setEditError] = useState<{ capabilityId: string; message: string } | null>(
    null,
  );
  const [publishError, setPublishError] = useState<{
    capabilityId: string;
    message: string;
  } | null>(null);
  useDocumentTitle('我的 Agent · Combo');
  const queryClient = useQueryClient();

  const capsQuery = useInfiniteQuery<Page<CapabilityView>, Error>({
    queryKey: ['capabilities', taskId ?? null],
    queryFn: ({ pageParam }) =>
      listCapabilities({
        ...(taskId ? { taskId } : {}),
        ...(pageParam ? { cursor: pageParam as string } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });

  const studioMutation = useMutation({
    mutationFn: (capabilityId: string) => createStudioSession(capabilityId),
    onMutate: () => setEditError(null),
    onSuccess: ({ session }) => navigateToStudio(studioUrl(session.id)),
    onError: (error, capabilityId) => {
      setEditError({
        capabilityId,
        message: error instanceof Error ? error.message : '暂时没能打开设计空间，请稍后重试。',
      });
    },
  });

  const publishMutation = useMutation({
    mutationFn: ({ capabilityId, publish }: { capabilityId: string; publish: boolean }) =>
      publish ? publishCapability(capabilityId) : unpublishCapability(capabilityId),
    onMutate: () => setPublishError(null),
    onSuccess: (result) => {
      queryClient.setQueriesData<CapabilityPages>({ queryKey: ['capabilities'] }, (data) =>
        mergePublishResult(data, result),
      );
    },
    onError: (error, { capabilityId, publish }) => {
      const fallback = publish
        ? '暂时没能发布这个 Agent，请稍后重试。'
        : '暂时没能下架这个 Agent，请稍后重试。';
      setPublishError({
        capabilityId,
        message: error instanceof Error ? error.message : fallback,
      });
    },
  });

  const items = capsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const visibleItems = useMemo(
    () =>
      items.filter((capability) => {
        if (filter === 'all') return true;
        return filter === 'published' ? capability.published : !capability.published;
      }),
    [filter, items],
  );

  /*
   * 后端目前只提供游标分页，没有状态筛选。若当前已加载页没有命中，继续向后查，
   * 直到找到结果或真正到达末页；不能把“这一页没有”冒充成“全部数据没有”。
   */
  useEffect(() => {
    if (
      filter !== 'all' &&
      visibleItems.length === 0 &&
      capsQuery.hasNextPage &&
      !capsQuery.isFetchingNextPage &&
      !capsQuery.isFetchNextPageError
    ) {
      void capsQuery.fetchNextPage();
    }
  }, [capsQuery, filter, visibleItems.length]);

  let body: ReactNode;
  if (capsQuery.isPending) {
    body = <Skeleton rows={4} label="正在加载 Agent 列表" />;
  } else if (capsQuery.isError && !capsQuery.data) {
    body = <ErrorState error={capsQuery.error} onRetry={() => void capsQuery.refetch()} />;
  } else if (items.length === 0) {
    body = (
      <div className="cb-empty cb-empty--capabilities">
        <span className="cb-empty__index" aria-hidden="true">
          01
        </span>
        <div className="cb-empty__copy">
          <p className="cb-empty__title">还没有 Agent</p>
          <p className="cb-empty__hint">上传一段真实工作记录，生成你的第一个 Agent。</p>
          <Link className="cb-empty__action cb-empty__action--primary" to="/tasks">
            创建 Agent
          </Link>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <div className="cb-capabilities__list-toolbar">
          <Link className="cb-btn cb-btn--primary cb-capabilities__create" to="/tasks">
            <span aria-hidden="true">＋</span>
            创建 Agent
          </Link>
          <div className="cb-capabilities__filters" role="group" aria-label="按状态筛选">
            {CAPABILITY_FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`cb-filter-chip${filter === item.key ? ' cb-filter-chip--active' : ''}`}
                aria-pressed={filter === item.key}
                onClick={() => setFilter(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {visibleItems.length === 0 && capsQuery.isFetchNextPageError ? (
          <div className="cb-empty cb-capabilities__filtered-empty" role="alert">
            <p className="cb-empty__title">列表还没有加载完整</p>
            <p className="cb-empty__hint">继续加载失败了，请重试后再判断这个状态下是否有 Agent。</p>
            <button
              type="button"
              className="cb-empty__action"
              onClick={() => void capsQuery.fetchNextPage()}
            >
              继续加载
            </button>
          </div>
        ) : visibleItems.length === 0 &&
          filter !== 'all' &&
          (capsQuery.hasNextPage || capsQuery.isFetchingNextPage) ? (
          <div className="cb-capabilities__filter-progress" role="status">
            正在查找更多{filter === 'published' ? '已上架' : '草稿'} Agent…
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="cb-empty cb-capabilities__filtered-empty" role="status">
            <p className="cb-empty__title">该状态下还没有 Agent</p>
            <button type="button" className="cb-empty__action" onClick={() => setFilter('all')}>
              查看全部
            </button>
          </div>
        ) : (
          <div className="cb-cap-table-wrap">
            <table className="cb-cap-table cb-cap-table--manage" aria-label="Agent 项目列表">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">状态</th>
                  <th scope="col">创建日期</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((capability) => (
                  <CapabilityRow
                    key={capability.id}
                    cap={capability}
                    editing={studioMutation.isPending && studioMutation.variables === capability.id}
                    actionsBusy={studioMutation.isPending}
                    editError={
                      editError && editError.capabilityId === capability.id
                        ? editError.message
                        : undefined
                    }
                    publishing={
                      publishMutation.isPending &&
                      publishMutation.variables?.capabilityId === capability.id
                    }
                    publishError={
                      publishError && publishError.capabilityId === capability.id
                        ? publishError.message
                        : undefined
                    }
                    onEdit={(capabilityId) => studioMutation.mutate(capabilityId)}
                    onTogglePublished={(capabilityId, publish) =>
                      publishMutation.mutate({ capabilityId, publish })
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {capsQuery.hasNextPage && (
          <div className="cb-pager">
            <button
              type="button"
              className="cb-pager__more"
              onClick={() => void capsQuery.fetchNextPage()}
              disabled={capsQuery.isFetchingNextPage}
            >
              {capsQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <section className="cb-page cb-capabilities-page" aria-labelledby="cb-caps-title">
      <header className="cb-page__head cb-capabilities-page__head">
        <div className="cb-capabilities-page__titleline">
          <h2 className="cb-page__title" id="cb-caps-title">
            我的 Agent
          </h2>
          {taskId && <span className="cb-capabilities-page__scope">本次提取</span>}
        </div>
        {taskId && (
          <Link className="cb-capabilities-page__scope-exit" to="/capabilities">
            查看全部 Agent <span aria-hidden="true">→</span>
          </Link>
        )}
      </header>
      {body}
    </section>
  );
}
