import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { SessionView } from '@cb/shared';
import {
  archivedSessionTarget,
  isRuntimeNavigationTarget,
  SessionListItem,
} from './SessionSidebar.js';

const CURRENT: SessionView = {
  id: 'session-current',
  capabilityId: 'capability-1',
  title: '项目复盘',
  status: 'active',
  createdAt: '2026-07-20T08:00:00.000Z',
  updatedAt: '2026-07-20T08:10:00.000Z',
};

const OTHER: SessionView = {
  ...CURRENT,
  id: 'session-other',
  title: '另一个会话',
};

describe('SessionSidebar 会话操作', () => {
  it('会话链接与改名/归档按钮是并列元素，没有 Link 内嵌 button', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(SessionListItem, {
          session: CURRENT,
          active: true,
          onRename: async () => undefined,
          onArchive: async () => undefined,
        }),
      ),
    );

    const linkMarkup = markup.match(/<a[\s\S]*?<\/a>/)?.[0];
    expect(linkMarkup).toBeTruthy();
    expect(linkMarkup).not.toContain('<button');
    expect(linkMarkup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="重命名“项目复盘”"');
    expect(markup).toContain('aria-label="归档“项目复盘”"');
  });

  it('归档当前会话时保留创作者返回链路，无剩余会话时直接返回创作端', () => {
    const returnTo = '/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43?from=trial';
    expect(archivedSessionTarget(CURRENT.id, CURRENT.id, [CURRENT, OTHER], returnTo)).toBe(
      '/session/session-other?returnTo=%2Ftasks%2F018f47ea-bc32-7a3d-8f6e-2f90c7b01d43%3Ffrom%3Dtrial',
    );
    expect(archivedSessionTarget(CURRENT.id, CURRENT.id, [CURRENT], returnTo)).toBe(returnTo);
    expect(archivedSessionTarget(CURRENT.id, CURRENT.id, [CURRENT])).toBe('/capabilities');
    expect(archivedSessionTarget(OTHER.id, CURRENT.id, [CURRENT, OTHER])).toBeNull();
    expect(isRuntimeNavigationTarget('/session/session-other')).toBe(true);
    expect(isRuntimeNavigationTarget('/capabilities')).toBe(false);
    expect(isRuntimeNavigationTarget(returnTo)).toBe(false);
  });

  it('正在生成的会话在所有侧栏实例中都禁用归档', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(SessionListItem, {
          session: CURRENT,
          active: true,
          archiveDisabled: true,
          inputIdPrefix: 'mobile',
          onRename: async () => undefined,
          onArchive: async () => undefined,
        }),
      ),
    );

    expect(markup).toContain('aria-label="“项目复盘”正在生成，暂时不能归档"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>⌑<\/button>/);
  });

  it('Studio 设计上下文不显示通用归档入口', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(SessionListItem, {
          session: CURRENT,
          active: true,
          allowArchive: false,
          onRename: async () => undefined,
          onArchive: async () => undefined,
        }),
      ),
    );

    expect(markup).toContain('aria-label="重命名“项目复盘”"');
    expect(markup).not.toContain('归档“项目复盘”');
  });
});
