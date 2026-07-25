import { createElement, StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapabilityDeepLink,
  runCapabilityDeepLink,
  type CapabilityDeepLinkGuard,
} from './CapabilityDeepLink.js';

const apiMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock('../api/runtime.js', () => ({
  useCreateSession: () => ({ mutateAsync: apiMocks.createSession }),
}));

function LocationProbe() {
  const location = useLocation();
  return createElement('output', null, `${location.pathname}${location.search}`);
}

describe('CapabilityDeepLink', () => {
  const taskReturnTo = '/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43';

  beforeEach(() => {
    apiMocks.createSession.mockReset();
  });

  it('建会话成功后 replace 跳到该会话', async () => {
    const guard: CapabilityDeepLinkGuard = { current: false };
    const createSession = vi.fn(async () => ({ id: 'session-1' }));
    const navigate = vi.fn();

    await runCapabilityDeepLink({ capabilityId: 'cap-1', guard, createSession, navigate });

    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith('cap-1');
    expect(navigate).toHaveBeenCalledWith('/session/session-1', { replace: true });
  });

  it('保留任务来源，建会话后把 returnTo 传入会话页', async () => {
    const guard: CapabilityDeepLinkGuard = { current: false };
    const createSession = vi.fn(async () => ({ id: 'session-task' }));
    const navigate = vi.fn();

    await runCapabilityDeepLink({
      capabilityId: 'cap-task',
      guard,
      createSession,
      navigate,
      returnTo: taskReturnTo,
    });

    expect(navigate).toHaveBeenCalledWith(
      `/session/session-task?returnTo=${encodeURIComponent(taskReturnTo)}`,
      { replace: true },
    );
  });

  it('拒绝不安全的 returnTo，不把外站目标带进会话页', async () => {
    const guard: CapabilityDeepLinkGuard = { current: false };
    const createSession = vi.fn(async () => ({ id: 'session-safe' }));
    const navigate = vi.fn();

    await runCapabilityDeepLink({
      capabilityId: 'cap-safe',
      guard,
      createSession,
      navigate,
      returnTo: '//example.com/phish',
    });

    expect(navigate).toHaveBeenCalledWith('/session/session-safe', { replace: true });
  });

  it('拒绝会被浏览器规范化的编码路径，不把它带进会话页', async () => {
    const guard: CapabilityDeepLinkGuard = { current: false };
    const createSession = vi.fn(async () => ({ id: 'session-normalized' }));
    const navigate = vi.fn();
    const decodedReturnTo = new URLSearchParams('returnTo=%2Ftasks%2F%252e%252e').get('returnTo');

    await runCapabilityDeepLink({
      capabilityId: 'cap-normalized',
      guard,
      createSession,
      navigate,
      returnTo: decodedReturnTo,
    });

    expect(navigate).toHaveBeenCalledWith('/session/session-normalized', { replace: true });
  });

  it('建会话失败后 replace 回我的 Agent，而不是未开放的市集', async () => {
    const guard: CapabilityDeepLinkGuard = { current: false };
    const createSession = vi.fn(async () => {
      throw new Error('capability unavailable');
    });
    const navigate = vi.fn();

    await runCapabilityDeepLink({ capabilityId: 'cap-missing', guard, createSession, navigate });

    expect(createSession).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/capabilities', { replace: true });
  });

  it('StrictMode 重跑 effect 时只发一次建会话 POST', async () => {
    const guard: CapabilityDeepLinkGuard = { current: false };
    let resolveSession!: (session: { id: string }) => void;
    const pending = new Promise<{ id: string }>((resolve) => {
      resolveSession = resolve;
    });
    const createSession = vi.fn(() => pending);
    const navigate = vi.fn();
    const input = { capabilityId: 'cap-strict', guard, createSession, navigate };

    const firstEffect = runCapabilityDeepLink(input);
    const secondEffect = runCapabilityDeepLink(input);
    expect(createSession).toHaveBeenCalledOnce();

    resolveSession({ id: 'session-strict' });
    await Promise.all([firstEffect, secondEffect]);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/session/session-strict', { replace: true });
  });

  it('真实 StrictMode 挂载只建一次会话并完成带来源跳转', async () => {
    apiMocks.createSession.mockResolvedValueOnce({ id: 'session-strict-render' });

    render(
      createElement(
        StrictMode,
        null,
        createElement(
          MemoryRouter,
          {
            initialEntries: [`/c/cap-strict-render?returnTo=${encodeURIComponent(taskReturnTo)}`],
          },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/c/:capabilityId',
              element: createElement(CapabilityDeepLink),
            }),
            createElement(Route, {
              path: '/session/:sessionId',
              element: createElement(LocationProbe),
            }),
          ),
        ),
      ),
    );

    expect(
      await screen.findByText(
        `/session/session-strict-render?returnTo=${encodeURIComponent(taskReturnTo)}`,
      ),
    ).toBeInTheDocument();
    expect(apiMocks.createSession).toHaveBeenCalledOnce();
    expect(apiMocks.createSession).toHaveBeenCalledWith('cap-strict-render');
  });
});
