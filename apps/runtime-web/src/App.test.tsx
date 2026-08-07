import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CLOSED_MARKET_TARGET, ClosedMarketRedirect } from './App.js';

describe('closed market route', () => {
  it('leaves the runtime bundle without rendering market data', async () => {
    const replace = vi.fn();

    render(<ClosedMarketRedirect replace={replace} />);

    expect(screen.getByText('正在返回我的 Agent…')).toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/capabilities'));
    expect(CLOSED_MARKET_TARGET).toBe('/capabilities');
  });
});

describe('runtime visual stability contracts', () => {
  it('loads remote fonts only from the final design layer and wraps mobile toolbar actions', () => {
    const runtimeWebRoot = process.cwd().endsWith('/apps/runtime-web')
      ? process.cwd()
      : resolve(process.cwd(), 'apps/runtime-web');
    const baseCss = readFileSync(resolve(runtimeWebRoot, 'src/styles.css'), 'utf8');
    const designCss = readFileSync(resolve(runtimeWebRoot, 'src/design-claude.css'), 'utf8');

    expect(baseCss).not.toContain('fonts.googleapis.com');
    expect(designCss.match(/fonts\.googleapis\.com/g)).toHaveLength(1);
    expect(baseCss).toMatch(/\.rt-trial__actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(baseCss).toMatch(/\.rt-trial__actions\s*>\s*\*\s*\{[^}]*max-width:\s*100%;/s);
  });
});
