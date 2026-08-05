/** Agent Miniapp 的最小运行契约；Authoring 和 Runtime 保存 HTML 时使用同一校验器。 */
export interface AgentMiniappHtmlValidation {
  ok: boolean;
  errors: string[];
}

const REQUIRED_DOCUMENT_PARTS: ReadonlyArray<[RegExp, string]> = [
  [/<!doctype\s+html(?:\s[^>]*)?>/i, '缺少 <!doctype html>'],
  [/<html(?:\s[^>]*)?>/i, '缺少 <html>'],
  [/<head(?:\s[^>]*)?>/i, '缺少 <head>'],
  [/<body(?:\s[^>]*)?>/i, '缺少 <body>'],
  [/<style(?:\s[^>]*)?>[\s\S]*?<\/style>/i, '缺少内联 <style>'],
  [/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/i, '缺少内联 <script>'],
  [/<\/body>/i, '缺少 </body>'],
  [/<\/html>/i, '缺少 </html>'],
];

const FORBIDDEN_RUNTIME_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsetTimeout\s*\(/i, '禁止使用 setTimeout 伪造运行进度或结果'],
  [/\bsetInterval\s*\(/i, '禁止使用 setInterval 伪造运行进度或结果'],
  [/\bMath\s*\.\s*random\s*\(/i, '禁止使用 Math.random 伪造运行结果'],
  [
    /\b(?:mock|fake|dummy)(?:Data|Result|Response|Output|Delay|Success)?\b|(?:模拟|伪造)(?:数据|结果|响应)|演示数据/i,
    '禁止使用 mock/fake/dummy 结果',
  ],
];

export function validateAgentMiniappHtml(content: string): AgentMiniappHtmlValidation {
  const errors: string[] = [];
  const html = content.trim();
  if (!html) return { ok: false, errors: ['HTML 内容不能为空'] };

  for (const [pattern, message] of REQUIRED_DOCUMENT_PARTS) {
    if (!pattern.test(html)) errors.push(message);
  }
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) {
    errors.push('脚本必须内联，不能使用 <script src>');
  }
  if (/<link\b[^>]*\brel\s*=\s*['"]?stylesheet/i.test(html)) {
    errors.push('样式必须内联，不能使用外链 stylesheet');
  }
  if (!/data-combo-key\s*=\s*['"]run-primary['"]/i.test(html)) {
    errors.push('主操作缺少 data-combo-key="run-primary"');
  }
  if (!/(?:window\s*\.\s*)?parent\s*\.\s*postMessage\s*\(/i.test(html)) {
    errors.push('主操作没有调用 window.parent.postMessage');
  }
  if (!/['"]combo:run['"]/i.test(html)) errors.push('缺少 combo:run bridge 类型');
  if (!/['"]?version['"]?\s*:\s*1\b/i.test(html)) {
    errors.push('combo:run bridge 必须使用 version: 1');
  }
  if (!/\bprompt\b/i.test(html)) errors.push('combo:run bridge 必须传递 prompt');

  for (const [pattern, message] of FORBIDDEN_RUNTIME_PATTERNS) {
    if (pattern.test(html)) errors.push(message);
  }
  return { ok: errors.length === 0, errors };
}
