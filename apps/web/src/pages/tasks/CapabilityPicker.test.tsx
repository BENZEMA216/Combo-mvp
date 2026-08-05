import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { envelopeBody, makeCapability, makeTask } from '../../test/fixtures.js';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { CapabilityPicker } from './CapabilityPicker.js';

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

const TASK = makeTask({ id: 'task-result', status: 'succeeded', capabilityCount: 1 });
const CAPABILITY = makeCapability({ id: 'cap-weekly', name: '周报整理' });

describe('CapabilityPicker — result to Studio and release', () => {
  it('creates a real Studio session and preserves pricing as the return step', async () => {
    const navigateToStudio = vi.fn();
    fetchMock = installFetchMock({
      status: 201,
      json: envelopeBody({ session: { id: 'studio-result-1' } }),
      match: '/runtime/studio/sessions',
    });
    renderPage(
      <CapabilityPicker
        taskId={TASK.id}
        task={TASK}
        items={[CAPABILITY]}
        extracting={false}
        navigateToStudio={navigateToStudio}
      />,
    );

    expect(screen.getByRole('link', { name: /直接定价与发布/ })).toHaveAttribute(
      'href',
      '/capabilities/cap-weekly/release/pricing',
    );
    await userEvent.click(screen.getByRole('button', { name: '调整「周报整理」UI' }));
    await waitFor(() => expect(navigateToStudio).toHaveBeenCalledTimes(1));

    const request = fetchMock.calls.find((call) => call.url.includes('/runtime/studio/sessions'));
    expect(request).toEqual(
      expect.objectContaining({
        url: '/api/v1/runtime/studio/sessions',
        method: 'POST',
        body: { capabilityId: 'cap-weekly' },
      }),
    );
    expect(navigateToStudio).toHaveBeenCalledWith(
      '/try/session/studio-result-1?mode=studio&returnTo=%2Fcapabilities%2Fcap-weekly%2Frelease%2Fpricing',
    );
  });

  it('keeps the result usable and shows a scoped error when Studio cannot open', async () => {
    fetchMock = installFetchMock({
      status: 503,
      json: {
        error: {
          userMessage: '设计空间暂时没有准备好，请稍后重试。',
          retriable: true,
          action: 'retry',
          traceId: 'studio-result-down',
        },
      },
      match: '/runtime/studio/sessions',
    });
    renderPage(
      <CapabilityPicker
        taskId={TASK.id}
        task={TASK}
        items={[CAPABILITY]}
        extracting={false}
        navigateToStudio={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '调整「周报整理」UI' }));
    expect(
      await screen.findByText('调整 UI 未打开：设计空间暂时没有准备好，请稍后重试。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /直接定价与发布/ })).toBeInTheDocument();
  });
});
