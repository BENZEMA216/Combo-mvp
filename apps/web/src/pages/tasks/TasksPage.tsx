// 任务页（默认页）：「新建上传任务」+ 任务列表（游标分页）。
// 建任务成功 → PairingCard 展示配对码（明文仅此一次）+ 助手连接命令；行点入任务详情看实时进度。
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateTaskResult, TaskView } from '@cb/shared';
import { createTask, getTask, listTasks } from '../../api/index.js';
import { ErrorState, Skeleton } from '../../components/index.js';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';
import { PairingCard } from './PairingCard.js';
import { CreationMethodPicker } from './CreationMethodPicker.js';
import { saveTaskPairingReceipt } from './taskPairingReceipt.js';
import {
  formatTime,
  taskStatusLabel,
  taskStatusVariant,
  taskTitle,
  uploadProgressLabel,
} from './taskPresent.js';

export function TasksPage(): ReactElement {
  useDocumentTitle('创作进度 · Combo');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [created, setCreated] = useState<CreateTaskResult | null>(null);
  const [pairingVisible, setPairingVisible] = useState(false);
  const [methodPickerVisible, setMethodPickerVisible] = useState(false);
  const [pairingReceiptSaved, setPairingReceiptSaved] = useState(false);
  const createResultRef = useRef<HTMLDivElement>(null);
  const methodPickerRef = useRef<HTMLDivElement>(null);
  // Link 跳转不会天然继承页面按钮的 disabled 状态。用同步 ref 把所有创建入口收口成
  // 同一个在途锁，覆盖 React 状态更新前的双击、重复导航和 StrictMode effect 重放。
  const createInFlightRef = useRef(false);

  const tasksQuery = useInfiniteQuery({
    queryKey: ['tasks'],
    queryFn: ({ pageParam }) => listTasks({ ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });

  const createMutation = useMutation({
    mutationFn: () => createTask(),
    onSuccess: (result) => {
      setCreated(result);
      setPairingVisible(true);
      setMethodPickerVisible(false);
      setPairingReceiptSaved(
        saveTaskPairingReceipt({
          taskId: result.task.id,
          pairingCode: result.pairingCode,
          pairingExpiresAt: result.task.upload.pairingExpiresAt,
        }),
      );
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onSettled: () => {
      createInFlightRef.current = false;
    },
  });
  const mutateCreate = createMutation.mutate;
  const requestCreateTask = useCallback(() => {
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;
    mutateCreate();
  }, [mutateCreate]);

  // Shell 的全局“创建 Agent”入口只展开创建方式，不替用户擅自创建真实上传任务。
  useEffect(() => {
    if (searchParams.get('create') !== '1') return;
    const next = new URLSearchParams(searchParams);
    next.delete('create');
    setSearchParams(next, { replace: true });
    setMethodPickerVisible(true);
  }, [searchParams, setSearchParams]);

  // 新建后持续观察这个任务：配对卡给“等待助手连接”的明确反馈；第一片一落地就自动进入
  // 任务详情，让用户连续看到上传进度与随后自动出现的提取进度，无需刷新或手动点“查看进度”。
  // pairingVisible 与 watcher 分离——用户收起明文配对码后，自动承接仍继续生效。
  const watchedTaskQuery = useQuery({
    queryKey: ['task', created?.task.id],
    queryFn: () => getTask(created!.task.id),
    enabled: created !== null,
    initialData: created?.task,
    refetchInterval: (query) => {
      const task = query.state.data;
      return task?.status === 'running' && task.currentStep === 'upload' ? 1_500 : false;
    },
  });
  const watchedTask = watchedTaskQuery.data ?? created?.task;
  useEffect(() => {
    if (!created || !watchedTask) return;
    const uploadStarted = watchedTask.upload.partsLanded > 0;
    const leftWaitingState =
      watchedTask.currentStep !== 'upload' || watchedTask.status !== 'running';
    if (uploadStarted || leftWaitingState) {
      navigate(`/tasks/${created.task.id}`);
    }
  }, [created, navigate, watchedTask]);

  // 从失败任务行发起“重新上传”时，新配对卡会插到列表上方。主动把结果带回视野，
  // 避免用户点完按钮后仍停在旧任务行，以为没有发生任何事情。
  useEffect(() => {
    if (!createMutation.isError && !(created && pairingVisible)) return;
    const result = createResultRef.current;
    if (!result) return;
    result.scrollIntoView?.({ block: 'start' });
    result.focus({ preventScroll: true });
  }, [createMutation.isError, created, pairingVisible]);

  const tasks = tasksQuery.data?.pages.flatMap((p) => p.items) ?? [];
  useEffect(() => {
    if (tasksQuery.isSuccess && tasks.length === 0 && !created) setMethodPickerVisible(true);
  }, [created, tasks.length, tasksQuery.isSuccess]);

  useEffect(() => {
    if (!methodPickerVisible) return;
    methodPickerRef.current?.scrollIntoView?.({ block: 'start' });
    methodPickerRef.current?.focus({ preventScroll: true });
  }, [methodPickerVisible]);
  const runningCount = tasks.filter((task) => task.status === 'running').length;
  const completedCount = tasks.filter((task) => task.status === 'succeeded').length;
  const capabilityCount = tasks.reduce((sum, task) => sum + task.capabilityCount, 0);

  let listBody: ReactNode;
  if (tasksQuery.isPending) {
    listBody = <Skeleton rows={4} label="正在加载任务列表" />;
  } else if (tasksQuery.isError) {
    listBody = <ErrorState error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} />;
  } else if (tasks.length === 0) {
    listBody = (
      <div className="cb-empty">
        <p className="cb-empty__title">还没有创作记录</p>
        <p className="cb-empty__hint">在上方选择一种 Context 来源，完成后进度会保存在这里。</p>
      </div>
    );
  } else {
    listBody = (
      <>
        <table className="cb-table cb-tasks-table">
          <thead>
            <tr>
              <th scope="col">任务</th>
              <th scope="col">状态</th>
              <th scope="col">上传进度</th>
              <th scope="col">能力项</th>
              <th scope="col">下一步</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                createPending={createMutation.isPending}
                onCreateUpload={requestCreateTask}
              />
            ))}
          </tbody>
        </table>
        <div className="cb-pager">
          {tasksQuery.hasNextPage ? (
            <button
              type="button"
              className="cb-pager__more"
              onClick={() => void tasksQuery.fetchNextPage()}
              disabled={tasksQuery.isFetchingNextPage}
            >
              {tasksQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
            </button>
          ) : (
            <p className="cb-pager__end">没有更多了</p>
          )}
        </div>
      </>
    );
  }

  return (
    <section className="cb-page cb-page--tasks" aria-labelledby="cb-tasks-title">
      <div className="cb-page__head cb-page__head--split">
        <div>
          <h2 className="cb-page__title" id="cb-tasks-title">
            创作进度
          </h2>
          <p className="cb-page__lead">
            从上传、提取到结果验收，每一步都会保留。离开后也可以随时回来继续。
          </p>
        </div>
        <button
          type="button"
          className="cb-primary-btn"
          onClick={() => setMethodPickerVisible(true)}
          aria-expanded={methodPickerVisible}
          aria-controls="cb-create-methods-region"
        >
          创建 Agent
        </button>
      </div>

      {methodPickerVisible && (
        <div
          ref={methodPickerRef}
          className="cb-create-methods-anchor"
          id="cb-create-methods-region"
          role="region"
          aria-label="创建 Agent 的 Context 来源"
          tabIndex={-1}
        >
          <CreationMethodPicker
            createPending={createMutation.isPending}
            onCreateUpload={requestCreateTask}
            onClose={tasks.length > 0 ? () => setMethodPickerVisible(false) : undefined}
          />
        </div>
      )}

      <div ref={createResultRef} tabIndex={-1} className="cb-create-result">
        {createMutation.isError && (
          <ErrorState error={createMutation.error} onRetry={requestCreateTask} />
        )}
        {created && pairingVisible && (
          <PairingCard
            created={created}
            liveTask={watchedTask}
            progressUnavailable={watchedTaskQuery.isError || watchedTaskQuery.isRefetchError}
            receiptSaved={pairingReceiptSaved}
            onDismiss={() => setPairingVisible(false)}
          />
        )}
      </div>

      <div className="cb-tasks-panel">
        <div className="cb-tasks-panel__header">
          <div>
            <p className="cb-section-kicker">创建记录</p>
            <h3 className="cb-tasks-panel__title">Agent 创作任务</h3>
            <p className="cb-tasks-panel__hint">
              每个任务都会保留上传进度、提取状态和生成的能力数量。
            </p>
          </div>
          <dl className="cb-tasks-stats" aria-label="任务概览">
            <div>
              <dt>运行中</dt>
              <dd>{runningCount}</dd>
            </div>
            <div>
              <dt>已完成</dt>
              <dd>{completedCount}</dd>
            </div>
            <div>
              <dt>能力项</dt>
              <dd>{capabilityCount}</dd>
            </div>
          </dl>
        </div>
        <div className="cb-tasks-panel__body">{listBody}</div>
      </div>
    </section>
  );
}

function TaskRow({
  task,
  createPending,
  onCreateUpload,
}: {
  task: TaskView;
  createPending: boolean;
  onCreateUpload: () => void;
}): ReactElement {
  const uploadExpired =
    task.currentStep === 'upload' ||
    task.upload.status === 'expired' ||
    task.lastError?.action === 'change_input';

  return (
    <tr className="cb-task-row">
      <td className="cb-task-cell cb-task-cell--primary" data-label="任务">
        <span className="cb-task-cell__label" aria-hidden="true">
          任务
        </span>
        <Link
          className="cb-task-link"
          to={`/tasks/${task.id}`}
          aria-label={`查看任务：${taskTitle(task)}`}
        >
          <span className="cb-task-link__copy">
            <span className="cb-task-link__title">{taskTitle(task)}</span>
            <span className="cb-task-time">{formatTime(task.createdAt)}</span>
          </span>
          <span className="cb-task-link__arrow" aria-hidden="true">
            →
          </span>
        </Link>
      </td>
      <td className="cb-task-cell cb-task-cell--status" data-label="状态">
        <span className="cb-task-cell__label" aria-hidden="true">
          状态
        </span>
        <span className={`cb-status-badge is-${taskStatusVariant(task)}`}>
          {taskStatusLabel(task)}
        </span>
      </td>
      <td className="cb-task-cell cb-task-cell--progress" data-label="上传进度">
        <span className="cb-task-cell__label" aria-hidden="true">
          上传进度
        </span>
        {uploadProgressLabel(task)}
      </td>
      <td className="cb-task-cell cb-task-cell--capability" data-label="能力项">
        <span className="cb-task-cell__label" aria-hidden="true">
          能力项
        </span>
        {task.capabilityCount > 0 ? `${task.capabilityCount} 个` : '—'}
      </td>
      <td className="cb-task-cell cb-task-cell--note cb-task-note" data-label="下一步">
        <span className="cb-task-cell__label" aria-hidden="true">
          下一步
        </span>
        {task.status === 'failed' ? (
          <div className="cb-task-next-step cb-task-next-step--failed">
            <span className="cb-task-error">
              {task.lastError?.userMessage ?? '任务未完成，请查看失败详情。'}
            </span>
            {uploadExpired ? (
              <button
                type="button"
                className="cb-task-action cb-task-action--recovery"
                onClick={onCreateUpload}
                disabled={createPending}
                aria-label={`为${taskTitle(task)}新建上传任务`}
              >
                <span>{createPending ? '正在新建…' : '重新上传'}</span>
                {!createPending && <span aria-hidden="true">→</span>}
              </button>
            ) : (
              <Link className="cb-task-action" to={`/tasks/${task.id}`}>
                <span>{task.lastError?.action === 'retry' ? '查看并重试' : '查看失败详情'}</span>
                <span aria-hidden="true">→</span>
              </Link>
            )}
          </div>
        ) : task.status === 'succeeded' ? (
          <Link className="cb-task-action" to={`/capabilities?taskId=${task.id}`}>
            <span>查看并试用能力</span>
            <span aria-hidden="true">→</span>
          </Link>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}
