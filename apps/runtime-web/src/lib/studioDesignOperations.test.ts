import { describe, expect, it } from 'vitest';
import {
  buildStudioDesignOperationPrompt,
  formatStudioDesignOperationMessage,
  STUDIO_DESIGN_OPERATIONS,
} from './studioDesignOperations.js';

describe('studio design operations', () => {
  it('keeps the internal operation instruction in model context', () => {
    const operation = STUDIO_DESIGN_OPERATIONS[0];
    const prompt = buildStudioDesignOperationPrompt(operation);

    expect(prompt).toContain('[COMBO_DESIGN_OPERATION:critique]');
    expect(prompt).toContain('1–3 个问题');
  });

  it('uses a bounded instruction for an annotated element', () => {
    const operation = STUDIO_DESIGN_OPERATIONS[1];
    const prompt = buildStudioDesignOperationPrompt(operation, 'element');

    expect(prompt).toContain('只理清当前选中区域内部');
    expect(prompt).toContain('不得移动、删除或改写其它页面区域');
    expect(prompt).not.toContain('当前页面的视觉和信息层级');
  });

  it('shows only a compact creator-facing operation label', () => {
    const prompt = buildStudioDesignOperationPrompt(STUDIO_DESIGN_OPERATIONS[2]);

    expect(formatStudioDesignOperationMessage(prompt)).toBe('设计操作「补全状态」');
    expect(formatStudioDesignOperationMessage(prompt)).not.toContain('mock');
  });

  it('does not treat unknown or incomplete protocol as an operation', () => {
    expect(formatStudioDesignOperationMessage('[COMBO_DESIGN_OPERATION:unknown]\n执行')).toBeNull();
    expect(formatStudioDesignOperationMessage('补全页面状态')).toBeNull();
  });
});
