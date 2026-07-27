import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App.js';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('App landing route', () => {
  it('renders / as a public page without probing the protected session', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    window.history.replaceState({}, '', '/');

    render(<App />);

    expect(
      screen.getByRole('heading', {
        name: '把你的内容，变成一个可以工作的 Agent。',
      }),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
