import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { createTestComboMiniappDemoAgent } from '../../api/index.js';
import { ErrorState } from '../../components/index.js';
import { useReleaseMetadata } from '../../shell/releaseIdentity.js';

export interface TestDemoAgentEntryProps {
  placement: 'tasks' | 'blocked-task';
}

/**
 * 只在 Test 发布中出现的验收捷径。它独立于两种正式 Context 来源，不能被理解为第三种创建方式。
 */
export function TestDemoAgentEntry({ placement }: TestDemoAgentEntryProps): ReactElement | null {
  const metadata = useReleaseMetadata();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createDemoMutation = useMutation({
    mutationFn: createTestComboMiniappDemoAgent,
    onSuccess: (result) => {
      // 返回列表时应重新读取刚落库的演示任务与 Agent；当前页面不额外抢跑请求。
      void queryClient.invalidateQueries({ queryKey: ['tasks'], refetchType: 'none' });
      void queryClient.invalidateQueries({ queryKey: ['capabilities'], refetchType: 'none' });
      navigate(`/tasks/${encodeURIComponent(result.taskId)}`);
    },
  });

  if (metadata.environment !== 'test') return null;

  const blockedTask = placement === 'blocked-task';
  return (
    <aside
      className={`cb-test-demo-entry${blockedTask ? ' cb-test-demo-entry--blocked' : ''}`}
      aria-label="Test 演示 Agent"
    >
      <div className="cb-test-demo-entry__copy">
        <span className="cb-test-demo-entry__badge">Test 演示数据</span>
        <div>
          <h3>{blockedTask ? '先体验完整的 Agent 链路' : '直接体验后续链路'}</h3>
          <p>
            {blockedTask
              ? '当前上传会继续保留；载入一份 Combo Miniapp Agent，不影响当前上传。'
              : '载入一份 Combo Miniapp Agent，体验结果、UI 编辑、定价、命名与发布；不影响当前上传。'}
          </p>
        </div>
      </div>
      <div className="cb-test-demo-entry__actions">
        {createDemoMutation.isError ? (
          <ErrorState
            error={createDemoMutation.error}
            onRetry={() => createDemoMutation.mutate()}
          />
        ) : (
          <button
            type="button"
            className="cb-task-action cb-test-demo-entry__action"
            disabled={createDemoMutation.isPending}
            onClick={() => createDemoMutation.mutate()}
          >
            {createDemoMutation.isPending ? '正在准备演示 Agent…' : '载入演示 Agent'}
          </button>
        )}
      </div>
    </aside>
  );
}
