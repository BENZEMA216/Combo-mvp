import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listCreationResumeTasks } from '../api/index.js';
import { creationResumeFromTasks, type CreationResumeSummary } from './creationResume.js';

/**
 * 侧栏恢复入口使用任务真数据，但不阻塞受保护页面：读取失败时只隐藏胶囊，页面照常可用。
 * 服务端负责筛选和有界读取；只有运行中的任务需要短轮询。
 */
export function useCreationResume(): CreationResumeSummary | undefined {
  const query = useQuery({
    queryKey: ['tasks', 'creation-resume'],
    queryFn: listCreationResumeTasks,
    staleTime: 5_000,
    refetchInterval: (state) =>
      state.state.data?.some((task) => task.status === 'running') ? 5_000 : false,
    refetchOnWindowFocus: true,
  });

  return useMemo(() => creationResumeFromTasks(query.data ?? []), [query.data]);
}
