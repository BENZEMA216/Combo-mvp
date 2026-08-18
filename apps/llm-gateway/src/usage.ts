// 从 provider SSE 原始文本中增量提取末帧 usage。按行切分、跨 chunk 缓冲半行、
// 只认 data: 行；与 authoring openrouter 客户端同一切分行规约。
import type { TokenUsage } from './pricing.js';

export interface UsageExtractor {
  push(text: string): void;
  /** 流结束后的最终 usage；provider 未给（未请求 include_usage 或中途断流）时为 null。 */
  result(): TokenUsage | null;
  sawDone(): boolean;
}

function normalizeUsage(value: unknown): TokenUsage | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const prompt = candidate.prompt_tokens;
  const completion = candidate.completion_tokens;
  if (
    !Number.isSafeInteger(prompt) ||
    (prompt as number) < 0 ||
    !Number.isSafeInteger(completion) ||
    (completion as number) < 0
  ) {
    return null;
  }
  return { promptTokens: prompt as number, completionTokens: completion as number };
}

export function createUsageExtractor(): UsageExtractor {
  let buffer = '';
  let usage: TokenUsage | null = null;
  let done = false;

  return {
    push(text) {
      buffer += text;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (payload === '[DONE]') {
          done = true;
          continue;
        }
        try {
          const parsed = JSON.parse(payload) as { usage?: unknown };
          const normalized = normalizeUsage(parsed.usage);
          if (normalized) usage = normalized;
        } catch {
          // 非 JSON 的 data 行（注释、心跳）忽略。
        }
      }
    },
    result() {
      return usage;
    },
    sawDone() {
      return done;
    },
  };
}
