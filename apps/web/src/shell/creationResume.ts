import { DISPLAYABLE_ACTIONS, type TaskView } from '@cb/shared';

/** Shell 只消费轻量恢复摘要，不把任务查询与完整 TaskView 下放给导航组件。 */
export interface CreationResumeSummary {
  title: string;
  stage: string;
  href: string;
  total: number;
}

function stageForTask(task: TaskView): string {
  if (task.status === 'succeeded') return 'Agent 结果待验收';
  if (task.status === 'failed') {
    return task.currentStep === 'upload' ? '上传需要处理' : '提取需要处理';
  }
  if (task.currentStep === 'extract') return '正在提取 Agent';
  return task.upload.partsLanded > 0 ? '正在上传内容' : '等待本机连接';
}

function taskTime(task: TaskView): number {
  const parsed = new Date(task.updatedAt).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 运行中的创作优先占据恢复位；若当前没有运行任务，则恢复最近一次结果（成功或失败）。
 * 这样异步离开的用户可以直接验收，同时不会被很久以前的失败任务永久拦在旧断点。
 */
export function creationResumeFromTasks(
  tasks: readonly TaskView[],
): CreationResumeSummary | undefined {
  const sorted = [...tasks].sort((a, b) => taskTime(b) - taskTime(a));
  const actionable = sorted.filter(
    (task) =>
      task.status === 'running' ||
      (task.status === 'failed' &&
        (DISPLAYABLE_ACTIONS.some((action) => action === task.lastError?.action) ||
          (task.currentStep === 'upload' && task.upload.status === 'expired'))),
  );
  const candidates = actionable.length > 0 ? actionable : sorted.slice(0, 1);
  const latest = candidates[0];
  if (!latest) return undefined;

  return {
    title: latest.description?.trim() || `Agent 创作 · ${latest.id.slice(0, 8)}`,
    stage: stageForTask(latest),
    href: `/tasks/${encodeURIComponent(latest.id)}`,
    total: candidates.length,
  };
}
