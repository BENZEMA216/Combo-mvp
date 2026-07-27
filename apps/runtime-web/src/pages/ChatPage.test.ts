import { describe, expect, it } from 'vitest';
import { resolveStudioSaveStatus, resolveTrialCanvasState } from './ChatPage.js';

describe('resolveTrialCanvasState', () => {
  it('keeps the honest page skeleton while a first artifact is still running', () => {
    expect(resolveTrialCanvasState({ messageCount: 2, running: true, hasArtifact: false })).toBe(
      'running',
    );
  });

  it('keeps an existing artifact visible while applying another edit', () => {
    expect(resolveTrialCanvasState({ messageCount: 3, running: true, hasArtifact: true })).toBe(
      'output',
    );
  });

  it('shows intake only before any conversation or artifact exists', () => {
    expect(resolveTrialCanvasState({ messageCount: 0, running: false, hasArtifact: false })).toBe(
      'intake',
    );
  });
});

describe('resolveStudioSaveStatus', () => {
  it('never reports saved while a revision is still running', () => {
    expect(
      resolveStudioSaveStatus({
        running: true,
        hasArtifact: true,
        hasError: false,
        activeArtifactId: 'artifact-new',
        currentUiArtifactId: 'artifact-old',
        terminalState: 'completed',
      }),
    ).toEqual({ label: '正在生成并保存…', tone: 'progress' });
  });

  it('reports the persisted and failed states truthfully', () => {
    expect(
      resolveStudioSaveStatus({
        running: false,
        hasArtifact: true,
        hasError: false,
        activeArtifactId: 'artifact-current',
        currentUiArtifactId: 'artifact-current',
        terminalState: 'completed',
      }),
    ).toEqual({ label: '已自动保存', tone: 'success' });
    expect(
      resolveStudioSaveStatus({
        running: false,
        hasArtifact: true,
        hasError: false,
        activeArtifactId: 'artifact-new',
        currentUiArtifactId: 'artifact-old',
        terminalState: 'failed',
      }),
    ).toEqual({ label: '本轮未保存', tone: 'error' });
  });

  it('does not infer a successful save from a persisted session artifact', () => {
    expect(
      resolveStudioSaveStatus({
        running: false,
        hasArtifact: true,
        hasError: false,
        activeArtifactId: 'artifact-new',
        currentUiArtifactId: undefined,
        terminalState: null,
      }),
    ).toEqual({ label: '自动保存已开启', tone: 'idle' });
  });

  it('does not call a failed or unbound revision the current Agent UI', () => {
    expect(
      resolveStudioSaveStatus({
        running: false,
        hasArtifact: true,
        hasError: false,
        activeArtifactId: 'artifact-new',
        currentUiArtifactId: 'artifact-current',
        terminalState: null,
      }),
    ).toEqual({ label: '当前版本未设为 Agent UI', tone: 'error' });
    expect(
      resolveStudioSaveStatus({
        running: false,
        hasArtifact: false,
        hasError: false,
        activeArtifactId: null,
        currentUiArtifactId: null,
        terminalState: 'completed',
      }),
    ).toEqual({ label: '本轮未生成 UI', tone: 'error' });
  });

  it('does not reuse an old saved state after a send or stream error', () => {
    expect(
      resolveStudioSaveStatus({
        running: false,
        hasArtifact: true,
        hasError: true,
        activeArtifactId: 'artifact-current',
        currentUiArtifactId: 'artifact-current',
        terminalState: 'completed',
      }),
    ).toEqual({ label: '保存状态待确认', tone: 'error' });
  });
});
