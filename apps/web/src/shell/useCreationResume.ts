import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TaskView } from '@cb/shared';
import { listTasks, type ListQuery, type Page } from '../api/index.js';
import { creationResumeFromTasks, type CreationResumeSummary } from './creationResume.js';

type TaskPageFetcher = (query: ListQuery) => Promise<Page<TaskView>>;

/**
 * Shell 的恢复入口不能只看第一页：旧的 running/retry 任务仍必须可被找回。
 * 使用服务端允许的最大页长逐页读取，并拒绝异常重复游标，避免静默漏项或死循环。
 */
export async function listAllCreationTasks(
  fetchPage: TaskPageFetcher = listTasks,
): Promise<TaskView[]> {
  const items: TaskView[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const page = await fetchPage({ ...(cursor ? { cursor } : {}), limit: 100 });
    items.push(...page.items);
    const nextCursor = page.page.nextCursor ?? undefined;
    if (!page.page.hasMore) return items;
    if (!nextCursor) throw new Error('Task pagination is missing the next cursor.');
    if (seenCursors.has(nextCursor)) throw new Error('Task pagination returned a repeated cursor.');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

/**
 * 侧栏恢复入口使用任务真数据，但不阻塞受保护页面：读取失败时只隐藏胶囊，页面照常可用。
 * 只有运行中的任务需要短轮询；稳定终态依靠任务创建后的 query invalidation 更新。
 */
export function useCreationResume(): CreationResumeSummary | undefined {
  const query = useQuery({
    queryKey: ['tasks', 'creation-resume'],
    queryFn: () => listAllCreationTasks(),
    staleTime: 5_000,
    refetchInterval: (state) =>
      state.state.data?.some((task) => task.status === 'running') ? 5_000 : false,
    refetchOnWindowFocus: true,
  });

  return useMemo(() => creationResumeFromTasks(query.data ?? []), [query.data]);
}
