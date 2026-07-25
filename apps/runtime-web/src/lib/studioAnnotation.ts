import type { ComboElementSelection } from '../components/ArtifactRenderer.js';
import { formatStudioDesignOperationMessage } from './studioDesignOperations.js';

const CONTEXT_PREFIX = '请只围绕当前选中的页面元素「';
const CONTEXT_SUFFIX = '」进行修改。';
const PRESERVE_INSTRUCTION =
  '保留其它区域的内容结构与真实运行行为，并继续保留所有稳定的 data-combo-key。';
const STABLE_LOCATOR_PREFIX = '定位键是 data-combo-key=';
const STRUCTURAL_LOCATOR_PREFIX = '结构定位是 ';
const LOCATOR_PROTOCOL = /`?data-combo-(?:key|inspection-key)(?:=(["'])[^"']*\1)?`?/g;

function hideLocatorProtocol(value: string): string {
  return value.replace(LOCATOR_PROTOCOL, '页面定位标记');
}

export function buildContextualStudioPrompt(
  element: ComboElementSelection,
  instruction: string,
): string {
  const locator =
    element.stableKey === false
      ? `${STRUCTURAL_LOCATOR_PREFIX}<${element.tagName}>，路径「${element.path ?? '当前可见元素'}」，当前文本「${element.text || element.label}」。该元素尚无稳定定位键；修改时请为它补充语义化 data-combo-key。`
      : `${STABLE_LOCATOR_PREFIX}"${element.key}"。`;
  return [
    `${CONTEXT_PREFIX}${element.label}${CONTEXT_SUFFIX}`,
    locator,
    instruction.trim(),
    PRESERVE_INSTRUCTION,
  ].join('\n');
}

/** Keep the locator protocol in model context without exposing it in the creator conversation. */
export function formatStudioAnnotationMessage(value: string): string {
  const operationMessage = formatStudioDesignOperationMessage(value);
  if (operationMessage) return operationMessage;

  const lines = value.split('\n');
  const firstLine = lines[0] ?? '';
  if (
    !firstLine.startsWith(CONTEXT_PREFIX) ||
    !firstLine.endsWith(CONTEXT_SUFFIX) ||
    (!lines[1]?.startsWith(STABLE_LOCATOR_PREFIX) &&
      !lines[1]?.startsWith(STRUCTURAL_LOCATOR_PREFIX)) ||
    lines.at(-1) !== PRESERVE_INSTRUCTION
  ) {
    return hideLocatorProtocol(value);
  }

  const label = firstLine.slice(CONTEXT_PREFIX.length, -CONTEXT_SUFFIX.length).trim();
  const instruction = lines.slice(2, -1).join('\n').trim();
  if (!label || !instruction) return hideLocatorProtocol(value);
  return `标注「${label}」\n${formatStudioDesignOperationMessage(instruction) ?? instruction}`;
}
