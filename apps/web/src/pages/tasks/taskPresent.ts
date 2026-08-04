// 任务视图 → 人话展示口径（列表与详情共用，不各写一套）。
import type { TaskView } from '@cb/shared';

/** 步骤/状态合并成一个人话短语。 */
export function taskStatusLabel(task: TaskView): string {
  if (task.status === 'failed') return '失败';
  if (task.status === 'succeeded') return '提取完成';
  if (task.currentStep === 'extract') return '提取中';
  return task.upload.partsExpected === null && task.upload.partsLanded === 0
    ? '等待开始'
    : '上传中';
}

/** 状态徽章色调变体（cb-status-badge is-*）。 */
export function taskStatusVariant(task: TaskView): 'published' | 'pending' | 'rejected' {
  if (task.status === 'failed') return 'rejected';
  if (task.status === 'succeeded') return 'published';
  return 'pending';
}

/** 上传分片进度人话（partsExpected 未声明前为 null）。 */
export function uploadProgressLabel(task: TaskView): string {
  const { partsLanded, partsExpected, status } = task.upload;
  if (status === 'expired') {
    if (partsExpected !== null) return `已超时 · ${partsLanded} / ${partsExpected} 片`;
    return partsLanded > 0 ? `已超时 · 已收 ${partsLanded} 片` : '上传已超时';
  }
  if (status === 'processed') return '上传完成';
  if (partsExpected !== null) return `已收 ${partsLanded} / ${partsExpected} 片`;
  if (partsLanded > 0) return `已收 ${partsLanded} 片`;
  return '等待开始';
}

/** 任务展示名：描述优先，否则短 ID 兜底。 */
export function taskTitle(task: TaskView): string {
  return task.description?.trim() || `任务 ${task.id.slice(0, 8)}`;
}

/** ISO 时间 → 本地人读时间。 */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}
