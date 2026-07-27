import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GeneratingPageSkeleton } from './GeneratingPageSkeleton.js';

describe('GeneratingPageSkeleton', () => {
  it('shows one honest state without decorative workflow claims', () => {
    render(<GeneratingPageSkeleton startedAt={Date.now()} />);

    expect(screen.getByRole('status')).toHaveTextContent('正在生成页面');
    expect(screen.queryByText(/读取能力定义|生成第一版产物|整理产物结构/)).not.toBeInTheDocument();
  });

  it('names the real first UI generation state in studio mode', () => {
    render(<GeneratingPageSkeleton experience="studio" startedAt={Date.now()} />);

    expect(screen.getByRole('status')).toHaveTextContent('正在生成第一版 UI');
    expect(screen.queryByText(/理解页面|保留 Agent|整理页面版本/)).not.toBeInTheDocument();
  });
});
