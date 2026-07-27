import { describe, expect, it } from 'vitest';
import { EventType } from '@ag-ui/core';
import type { ArtifactView } from '@cb/shared';
import {
  initialStreamUiState,
  isTerminalEvent,
  parseStreamEvent,
  streamUiReducer,
  type StreamEvent,
  type StreamUiState,
} from './streamState.js';

function replay(events: StreamEvent[], from: StreamUiState = initialStreamUiState): StreamUiState {
  return events.reduce(
    (state, event) => streamUiReducer(state, { kind: 'stream-event', event }),
    from,
  );
}

function artifact(id: string, title = id): ArtifactView {
  return {
    id,
    kind: 'markdown',
    title,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
  };
}

describe('文本事件聚合（打字机）', () => {
  it('START/CONTENT×n 聚合为一段流式文本', () => {
    const state = replay([
      { type: EventType.RUN_STARTED },
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: '你好' },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: '，世界' },
    ]);
    expect(state.running).toBe(true);
    expect(state.streamingText).toBe('你好，世界');
  });

  it('TEXT_MESSAGE_END 保留已聚合文本（等终态才清）', () => {
    const state = replay([
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'abc' },
      { type: EventType.TEXT_MESSAGE_END },
    ]);
    expect(state.streamingText).toBe('abc');
  });

  it('RUN_FINISHED 清空流式文本并结束运行态（详情为真源）', () => {
    const state = replay([
      { type: EventType.RUN_STARTED, runId: 'turn-1' },
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'abc' },
      { type: EventType.RUN_FINISHED, runId: 'turn-1' },
    ]);
    expect(state).toMatchObject({
      running: false,
      activeRunId: null,
      streamingText: null,
      errorMessage: null,
      terminalRun: {
        runId: 'turn-1',
        state: 'completed',
        message: '已完成，页面结果已更新。',
      },
    });
  });

  it('RUN_ERROR 置人话错误并清空流式文本', () => {
    const state = replay([
      { type: EventType.RUN_STARTED, runId: 'turn-2' },
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: '半截' },
      { type: EventType.RUN_ERROR, runId: 'turn-2', message: '本轮生成已打断。' },
    ]);
    expect(state).toMatchObject({
      running: false,
      streamingText: null,
      errorMessage: '本轮生成已打断。',
      terminalRun: {
        runId: 'turn-2',
        state: 'failed',
        message: '本轮生成已打断。',
      },
    });
  });

  it('其他/历史轮次的终态不会结束当前 activeRunId', () => {
    const state = replay([
      { type: EventType.RUN_STARTED, runId: 'turn-current' },
      { type: EventType.TEXT_MESSAGE_START, runId: 'turn-current' },
      { type: EventType.TEXT_MESSAGE_CONTENT, runId: 'turn-current', delta: '进行中' },
      { type: EventType.RUN_FINISHED, runId: 'turn-history' },
    ]);

    expect(state).toMatchObject({
      running: true,
      activeRunId: 'turn-current',
      streamingText: '进行中',
      terminalRun: {
        runId: 'turn-history',
        state: 'completed',
      },
    });
  });

  it('整段重放已终态的历史轮次后回到静止（无残留文本/错误）', () => {
    const finishedTurn: StreamEvent[] = [
      { type: EventType.RUN_STARTED },
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: '第一轮' },
      { type: EventType.TEXT_MESSAGE_END },
      { type: EventType.RUN_FINISHED },
    ];
    const failedTurn: StreamEvent[] = [
      { type: EventType.RUN_STARTED },
      { type: EventType.RUN_ERROR, message: '出错了' },
    ];
    const liveTurn: StreamEvent[] = [
      { type: EventType.RUN_STARTED },
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: '进行中' },
    ];
    // 新一轮 RUN_STARTED 清掉上一轮的错误；只有未终态的一轮留下实时文本。
    const state = replay([...finishedTurn, ...failedTurn, ...liveTurn]);
    expect(state).toMatchObject({ running: true, streamingText: '进行中', errorMessage: null });
  });
});

describe('产物 STATE_DELTA 归并', () => {
  it('add /artifacts/<id> 上新产物并按 /activeArtifactId 切活跃', () => {
    const a1 = artifact('a1', '评分卡');
    const state = replay([
      {
        type: EventType.STATE_DELTA,
        delta: [
          { op: 'add', path: '/artifacts/a1', value: a1 },
          { op: 'add', path: '/activeArtifactId', value: 'a1' },
        ],
      },
    ]);
    expect(state.artifacts).toEqual({ a1 });
    expect(state.activeArtifactId).toBe('a1');
  });

  it('同 id 重复 add 即替换（原地更新产物）', () => {
    const v1 = artifact('a1', '初稿');
    const v2 = { ...artifact('a1', '终稿'), updatedAt: '2026-07-04T01:00:00.000Z' };
    const state = replay([
      { type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/artifacts/a1', value: v1 }] },
      { type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/artifacts/a1', value: v2 }] },
    ]);
    expect(Object.keys(state.artifacts)).toEqual(['a1']);
    expect(state.artifacts['a1']!.title).toBe('终稿');
  });

  it('RUN_ERROR immediately removes artifacts produced by the failed turn', () => {
    const failedCandidate = {
      ...artifact('a2', '失败候选'),
      sourceTurnId: 'turn-failed',
    };
    const state = replay([
      { type: EventType.RUN_STARTED, runId: 'turn-failed' },
      {
        type: EventType.STATE_DELTA,
        delta: [
          { op: 'add', path: '/artifacts/a1', value: artifact('a1', '已完成版本') },
          { op: 'add', path: '/artifacts/a2', value: failedCandidate },
          { op: 'add', path: '/activeArtifactId', value: 'a2' },
        ],
      },
      { type: EventType.RUN_ERROR, runId: 'turn-failed', message: '已中断' },
    ]);

    expect(Object.keys(state.artifacts)).toEqual(['a1']);
    expect(state.activeArtifactId).toBe('a1');
  });

  it('非法 delta（非数组 / 未知 path / 非对象成员）安全忽略', () => {
    const state = replay([
      { type: EventType.STATE_DELTA, delta: 'oops' },
      { type: EventType.STATE_DELTA, delta: [null, { op: 'remove', path: '/artifacts/a1' }] },
      { type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/other', value: 1 }] },
    ]);
    expect(state).toEqual(initialStreamUiState);
  });

  it('uses a settled initial detail as the exact artifact source and current UI', () => {
    const state = streamUiReducer(initialStreamUiState, {
      kind: 'detail-snapshot',
      artifacts: [artifact('a1', '已落库')],
      activeTurnId: null,
      currentUiArtifactId: 'a1',
      messageTurnIds: [],
      failedTurnIds: [],
    });

    expect(Object.keys(state.artifacts)).toEqual(['a1']);
    expect(state.activeArtifactId).toBe('a1');
    expect(state.running).toBe(false);
  });

  it('restores an active turn from session detail after a page reload', () => {
    const restored = streamUiReducer(initialStreamUiState, {
      kind: 'detail-snapshot',
      artifacts: [artifact('a1')],
      activeTurnId: 'turn-live',
      currentUiArtifactId: 'a1',
      messageTurnIds: ['turn-live'],
      failedTurnIds: [],
    });

    expect(restored).toMatchObject({
      running: true,
      activeRunId: 'turn-live',
      activeArtifactId: 'a1',
    });
  });

  it('keeps STATE_DELTA that arrives before the POST 202/cache update', () => {
    const candidate = {
      ...artifact('a2', 'SSE 候选'),
      sourceTurnId: 'turn-current',
    };
    let state = streamUiReducer(initialStreamUiState, { kind: 'turn-submitting' });
    state = replay(
      [
        {
          type: EventType.STATE_DELTA,
          runId: 'turn-current',
          delta: [
            { op: 'add', path: '/artifacts/a2', value: candidate },
            { op: 'add', path: '/activeArtifactId', value: 'a2' },
          ],
        },
      ],
      state,
    );
    state = streamUiReducer(state, { kind: 'turn-accepted', runId: 'turn-current' });
    // The following snapshot is the message-only cache update: same active turn, old artifacts.
    state = streamUiReducer(state, {
      kind: 'detail-snapshot',
      artifacts: [artifact('a1', '上一版')],
      activeTurnId: 'turn-current',
      currentUiArtifactId: 'a1',
      messageTurnIds: ['turn-current'],
      failedTurnIds: [],
    });

    expect(state.artifacts).toMatchObject({ a1: { title: '上一版' }, a2: candidate });
    expect(state.activeArtifactId).toBe('a2');
    expect(state.activeRunId).toBe('turn-current');
  });

  it('ignores an older GET that resolves after the current STATE_DELTA', () => {
    const candidate = {
      ...artifact('a2', '新轮候选'),
      sourceTurnId: 'turn-current',
    };
    let state = streamUiReducer(initialStreamUiState, { kind: 'turn-submitting' });
    state = streamUiReducer(state, { kind: 'turn-accepted', runId: 'turn-current' });
    state = replay(
      [
        {
          type: EventType.STATE_DELTA,
          runId: 'turn-current',
          delta: [
            { op: 'add', path: '/artifacts/a2', value: candidate },
            { op: 'add', path: '/activeArtifactId', value: 'a2' },
          ],
        },
      ],
      state,
    );
    const afterOldGet = streamUiReducer(state, {
      kind: 'detail-snapshot',
      artifacts: [artifact('a1', '旧 GET')],
      activeTurnId: null,
      currentUiArtifactId: 'a1',
      messageTurnIds: [],
      failedTurnIds: [],
    });

    expect(afterOldGet).toEqual(state);
  });

  it('clears running when a newer detail knows the turn but activeTurn is null', () => {
    const finalArtifact = {
      ...artifact('a2', '已完成版本'),
      sourceTurnId: 'turn-current',
    };
    let state = streamUiReducer(initialStreamUiState, { kind: 'turn-submitting' });
    state = streamUiReducer(state, { kind: 'turn-accepted', runId: 'turn-current' });
    state = streamUiReducer(state, {
      kind: 'detail-snapshot',
      artifacts: [finalArtifact],
      activeTurnId: null,
      currentUiArtifactId: 'a2',
      messageTurnIds: ['turn-current'],
      failedTurnIds: [],
    });

    expect(state).toMatchObject({
      running: false,
      awaitingRunId: false,
      activeRunId: null,
      activeArtifactId: 'a2',
      terminalRun: { runId: 'turn-current', state: 'completed' },
    });
  });

  it('does not resurrect a failed terminal artifact from a stale detail', () => {
    const failedCandidate = {
      ...artifact('a2', '失败候选'),
      sourceTurnId: 'turn-failed',
    };
    let state = replay([
      { type: EventType.RUN_STARTED, runId: 'turn-failed' },
      {
        type: EventType.STATE_DELTA,
        runId: 'turn-failed',
        delta: [{ op: 'add', path: '/artifacts/a2', value: failedCandidate }],
      },
      { type: EventType.RUN_ERROR, runId: 'turn-failed', message: '生成失败' },
    ]);
    state = streamUiReducer(state, {
      kind: 'detail-snapshot',
      artifacts: [failedCandidate],
      activeTurnId: 'turn-failed',
      currentUiArtifactId: null,
      messageTurnIds: ['turn-failed'],
      failedTurnIds: ['turn-failed'],
    });

    expect(state.running).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.artifacts).toEqual({});

    const staleSettled = streamUiReducer(state, {
      kind: 'detail-snapshot',
      artifacts: [failedCandidate],
      activeTurnId: null,
      currentUiArtifactId: null,
      messageTurnIds: ['turn-failed'],
      failedTurnIds: ['turn-failed'],
    });
    expect(staleSettled.artifacts).toEqual({});
  });

  it('does not let a 202 response resurrect a turn whose terminal event arrived first', () => {
    let state = streamUiReducer(initialStreamUiState, { kind: 'turn-submitting' });
    state = replay(
      [
        { type: EventType.RUN_STARTED, runId: 'turn-fast' },
        { type: EventType.RUN_FINISHED, runId: 'turn-fast' },
      ],
      state,
    );
    state = streamUiReducer(state, { kind: 'turn-accepted', runId: 'turn-fast' });

    expect(state.running).toBe(false);
    expect(state.awaitingRunId).toBe(false);
    expect(state.activeRunId).toBeNull();
  });
});

describe('帧解析与终态判定', () => {
  it('parseStreamEvent：合法 JSON 事件解析成功，坏帧返回 null', () => {
    expect(
      parseStreamEvent('{"type":"RUN_STARTED","runId":"turn-1","extra":"忽略透传字段"}'),
    ).toMatchObject({ type: 'RUN_STARTED', runId: 'turn-1' });
    expect(parseStreamEvent('not-json')).toBeNull();
    expect(parseStreamEvent('123')).toBeNull();
    expect(parseStreamEvent('{"noType":true}')).toBeNull();
  });

  it('isTerminalEvent 只认 RUN_FINISHED / RUN_ERROR', () => {
    expect(isTerminalEvent({ type: EventType.RUN_FINISHED })).toBe(true);
    expect(isTerminalEvent({ type: EventType.RUN_ERROR })).toBe(true);
    expect(isTerminalEvent({ type: EventType.TEXT_MESSAGE_END })).toBe(false);
  });
});
