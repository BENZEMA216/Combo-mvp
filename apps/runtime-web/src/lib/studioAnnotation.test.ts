import { describe, expect, it } from 'vitest';
import { buildContextualStudioPrompt, formatStudioAnnotationMessage } from './studioAnnotation.js';
import {
  buildStudioDesignOperationPrompt,
  STUDIO_DESIGN_OPERATIONS,
} from './studioDesignOperations.js';

const element = {
  key: 'result-main',
  label: '今日安排结果',
  role: 'region',
  text: '3 项任务已经排好',
  tagName: 'section',
  path: 'body > main:nth-of-type(1) > section:nth-of-type(1)',
  stableKey: true,
};

const structuralElement = {
  key: 'auto-3',
  label: 'Agent-VM 任务助手',
  role: 'heading',
  text: 'Agent-VM 任务助手',
  tagName: 'h1',
  path: 'body > main:nth-of-type(1) > h1:nth-of-type(1)',
  stableKey: false,
};

describe('studio annotation protocol', () => {
  it('keeps a stable locator and the rest-of-page constraint in model context', () => {
    const prompt = buildContextualStudioPrompt(element, '把这里改成更克制的卡片');

    expect(prompt).toContain('今日安排结果');
    expect(prompt).toContain('data-combo-key="result-main"');
    expect(prompt).toContain('保留其它区域');
  });

  it('hides the locator protocol when the scoped message is shown in conversation', () => {
    const prompt = buildContextualStudioPrompt(element, '把这里改成更克制的卡片');
    const display = formatStudioAnnotationMessage(prompt);

    expect(display).toBe('标注「今日安排结果」\n把这里改成更克制的卡片');
    expect(display).not.toContain('data-combo-key');
  });

  it('uses structural context for a selected element that has no authored key yet', () => {
    const prompt = buildContextualStudioPrompt(structuralElement, '让这个标题更简洁');

    expect(prompt).toContain('<h1>');
    expect(prompt).toContain(structuralElement.path);
    expect(prompt).toContain('补充语义化 data-combo-key');
    expect(prompt).not.toContain('data-combo-key="auto-3"');
    expect(formatStudioAnnotationMessage(prompt)).toBe(
      '标注「Agent-VM 任务助手」\n让这个标题更简洁',
    );
  });

  it('leaves normal conversation messages untouched', () => {
    expect(formatStudioAnnotationMessage('统一页面的色彩和圆角')).toBe('统一页面的色彩和圆角');
  });

  it('hides operation routing for whole-page and annotated edits', () => {
    const operationPrompt = buildStudioDesignOperationPrompt(STUDIO_DESIGN_OPERATIONS[0]);
    expect(formatStudioAnnotationMessage(operationPrompt)).toBe('设计操作「检查并修好」');

    const scopedPrompt = buildContextualStudioPrompt(element, operationPrompt);
    expect(formatStudioAnnotationMessage(scopedPrompt)).toBe(
      '标注「今日安排结果」\n设计操作「检查并修好」',
    );
  });

  it('keeps locator keys out of Design Agent replies', () => {
    expect(
      formatStudioAnnotationMessage(
        '已围绕 `data-combo-key="run-primary"` 完成修改，其它区域保持不变。',
      ),
    ).toBe('已围绕 页面定位标记 完成修改，其它区域保持不变。');
  });
});
