import { describe, expect, it } from 'vitest';
import { makeTask } from '../test/fixtures.js';
import { creationResumeFromTasks } from './creationResume.js';
import { listAllCreationTasks } from './useCreationResume.js';

describe('creationResumeFromTasks', () => {
  it('prioritizes unfinished work over a newer succeeded result', () => {
    const resume = creationResumeFromTasks([
      makeTask({
        id: 'task-succeeded',
        status: 'succeeded',
        description: '已经完成的 Agent',
        updatedAt: '2026-07-28T12:00:00.000Z',
      }),
      makeTask({
        id: 'task-uploading',
        description: '旅行穿搭 Agent',
        upload: {
          status: 'pending',
          partsExpected: 100,
          partsLanded: 28,
          pairingExpiresAt: '2026-07-29T12:00:00.000Z',
        },
        updatedAt: '2026-07-27T12:00:00.000Z',
      }),
    ]);

    expect(resume).toEqual({
      title: '旅行穿搭 Agent',
      stage: '正在上传内容',
      href: '/tasks/task-uploading',
      total: 1,
    });
  });

  it('uses the latest actionable task and counts all work that can be resumed', () => {
    const resume = creationResumeFromTasks([
      makeTask({
        id: 'task-uploading',
        currentStep: 'upload',
        description: '另一个上传任务',
        updatedAt: '2026-07-26T12:00:00.000Z',
      }),
      makeTask({
        id: 'task-extracting',
        currentStep: 'extract',
        description: '内容策略 Agent',
        updatedAt: '2026-07-27T12:00:00.000Z',
      }),
    ]);

    expect(resume).toEqual({
      title: '内容策略 Agent',
      stage: '正在提取 Agent',
      href: '/tasks/task-extracting',
      total: 2,
    });
  });

  it('shows the latest failed task when there is no running creation', () => {
    const resume = creationResumeFromTasks([
      makeTask({
        id: 'task-failed',
        status: 'failed',
        currentStep: 'upload',
        description: '需要重新上传',
        updatedAt: '2026-07-28T12:00:00.000Z',
      }),
      makeTask({
        id: 'task-ready',
        status: 'succeeded',
        updatedAt: '2026-07-27T12:00:00.000Z',
      }),
    ]);

    expect(resume).toEqual({
      title: '需要重新上传',
      stage: '上传需要处理',
      href: '/tasks/task-failed',
      total: 1,
    });
  });

  it('keeps an older retryable failure ahead of a newer terminal result', () => {
    const resume = creationResumeFromTasks([
      makeTask({
        id: 'task-ready',
        status: 'succeeded',
        description: '较新的完成结果',
        updatedAt: '2026-07-29T12:00:00.000Z',
      }),
      makeTask({
        id: 'task-retry',
        status: 'failed',
        currentStep: 'extract',
        description: '等待重试的 Agent',
        lastError: {
          userMessage: '模型暂时不可用，请重试。',
          retriable: true,
          action: 'retry',
          traceId: 'trace-retry',
        },
        updatedAt: '2026-07-27T12:00:00.000Z',
      }),
    ]);

    expect(resume).toEqual({
      title: '等待重试的 Agent',
      stage: '提取需要处理',
      href: '/tasks/task-retry',
      total: 1,
    });
  });

  it('keeps the latest successful result available for asynchronous acceptance', () => {
    const resume = creationResumeFromTasks([
      makeTask({
        id: 'task-ready',
        status: 'succeeded',
        description: '',
        updatedAt: '2026-07-27T12:00:00.000Z',
      }),
    ]);

    expect(resume).toEqual({
      title: 'Agent 创作 · task-rea',
      stage: 'Agent 结果待验收',
      href: '/tasks/task-ready',
      total: 1,
    });
  });

  it('returns no shell entry when there are no tasks', () => {
    expect(creationResumeFromTasks([])).toBeUndefined();
  });

  it('reads every task page so an older running task cannot disappear behind the first 20', async () => {
    const newestDone = makeTask({
      id: 'task-newest-done',
      status: 'succeeded',
      updatedAt: '2026-07-29T12:00:00.000Z',
    });
    const olderRunning = makeTask({
      id: 'task-older-running',
      status: 'running',
      currentStep: 'extract',
      description: '深页运行中的 Agent',
      updatedAt: '2026-07-20T12:00:00.000Z',
    });
    const calls: Array<{ cursor?: string; limit?: number }> = [];
    const fetchPage = async (query: { cursor?: string; limit?: number }) => {
      calls.push(query);
      if (!query.cursor) {
        return {
          items: [newestDone],
          page: { nextCursor: 'cursor-2', hasMore: true, limit: 100, order: 'desc' as const },
        };
      }
      if (query.cursor === 'cursor-2') {
        return {
          items: [makeTask({ id: 'task-middle', status: 'succeeded' })],
          page: { nextCursor: 'cursor-3', hasMore: true, limit: 100, order: 'desc' as const },
        };
      }
      return {
        items: [olderRunning],
        page: { nextCursor: null, hasMore: false, limit: 100, order: 'desc' as const },
      };
    };

    const tasks = await listAllCreationTasks(fetchPage);

    expect(calls).toEqual([
      { limit: 100 },
      { cursor: 'cursor-2', limit: 100 },
      { cursor: 'cursor-3', limit: 100 },
    ]);
    expect(tasks).toHaveLength(3);
    expect(creationResumeFromTasks(tasks)).toMatchObject({
      href: '/tasks/task-older-running',
      stage: '正在提取 Agent',
    });
  });
});
