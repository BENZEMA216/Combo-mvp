import { describe, expect, it } from 'vitest';
import { makeTask } from '../test/fixtures.js';
import { creationResumeFromTasks } from './creationResume.js';

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

  it('keeps expired uploads and other change-input failures in the resumable count', () => {
    const resume = creationResumeFromTasks([
      makeTask({
        id: 'task-ready',
        status: 'succeeded',
        description: '较新的完成结果',
        updatedAt: '2026-07-29T12:00:00.000Z',
      }),
      makeTask({
        id: 'task-expired',
        status: 'failed',
        currentStep: 'upload',
        description: '上传已过期',
        upload: {
          status: 'expired',
          partsExpected: 100,
          partsLanded: 28,
          pairingExpiresAt: '2026-07-27T12:00:00.000Z',
        },
        updatedAt: '2026-07-27T12:00:00.000Z',
      }),
      makeTask({
        id: 'task-change-input',
        status: 'failed',
        currentStep: 'extract',
        description: '需要补充资料',
        lastError: {
          userMessage: '请补充更多上下文。',
          retriable: false,
          action: 'change_input',
          traceId: 'trace-input',
        },
        updatedAt: '2026-07-26T12:00:00.000Z',
      }),
    ]);

    expect(resume).toEqual({
      title: '上传已过期',
      stage: '上传需要处理',
      href: '/tasks/task-expired',
      total: 2,
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
});
