// Codex 会话解析边界：宿主注入不进入正文，delegation 只暴露真实 input，坏包装安全丢弃。
import { describe, expect, it } from 'vitest';
import { parseSessions } from '../modules/task/session-parse.js';

function codexJsonl(messages: Array<{ role: 'user' | 'assistant'; text: string }>): string {
  return messages
    .map((message, index) =>
      JSON.stringify({
        type: 'response_item',
        timestamp: `2026-08-08T00:00:0${index}Z`,
        payload: {
          type: 'message',
          role: message.role,
          content: [
            { type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text },
          ],
        },
      }),
    )
    .join('\n');
}

function parseCodex(messages: Array<{ role: 'user' | 'assistant'; text: string }>) {
  return parseSessions([{ source: 'codex', raw: codexJsonl(messages), sessionRef: 'session-1' }]);
}

describe('parseSessions · Codex 宿主消息', () => {
  it('完整 recommended_plugins 注入块不进入标题、正文或消息数', () => {
    const injected =
      '<recommended_plugins>\n- GitHub (github@example)\n- Figma (figma@example)\n</recommended_plugins>';
    const out = parseCodex([
      { role: 'user', text: injected },
      { role: 'user', text: '请帮我整理这次发布的验收清单' },
      { role: 'assistant', text: '我会先核对版本与测试证据。' },
    ]);

    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]).toMatchObject({
      title: '请帮我整理这次发布的验收清单',
      messageCount: 2,
    });
    expect(out.segments[0]!.content).not.toContain('recommended_plugins');
  });

  it('只过滤纯注入块，不泛化过滤用户对同名 XML 标签的讨论', () => {
    const userText =
      '<recommended_plugins>这是示例，不是完整宿主块</recommended_plugins>\n请解释上面的标签。';
    const out = parseCodex([
      { role: 'user', text: userText },
      { role: 'assistant', text: '这是一个 XML 风格的包裹标签。' },
    ]);

    expect(out.segments[0]).toMatchObject({
      title: '<recommended_plugins>这是示例，不是完整宿主块</recommended_plugins>',
      messageCount: 2,
    });
    expect(out.segments[0]!.content).toContain('请解释上面的标签。');
  });
});

describe('parseSessions · Codex delegation', () => {
  it('只取 input 作为真实用户内容，并按 Desktop 契约解码实体', () => {
    const delegated = [
      '<codex_delegation>',
      '<source_thread_id>019-test-source</source_thread_id>',
      '<input>请审阅 &lt;config&gt; 配置\n并保留 A &amp; B</input>',
      '</codex_delegation>',
    ].join('\n');
    const out = parseCodex([
      { role: 'user', text: delegated },
      { role: 'assistant', text: '我会逐项检查配置。' },
    ]);

    expect(out.segments[0]).toMatchObject({ title: '请审阅 <config> 配置', messageCount: 2 });
    expect(out.segments[0]!.content).toContain('user: 请审阅 <config> 配置\n并保留 A & B');
    expect(out.segments[0]!.content).not.toContain('source_thread_id');
    expect(out.segments[0]!.content).not.toContain('codex_delegation');
  });

  it.each([
    [
      '缺 input',
      '<codex_delegation>\n<source_thread_id>019-test-source</source_thread_id>\n</codex_delegation>',
    ],
    [
      '缺闭合标签',
      '<codex_delegation>\n<source_thread_id>019-test-source</source_thread_id>\n<input>伪内容</input>',
    ],
  ])('malformed 包装（%s）安全丢弃，不污染后续真实任务', (_caseName, malformed) => {
    const out = parseCodex([
      { role: 'user', text: malformed },
      { role: 'user', text: '这是后续真实任务' },
      { role: 'assistant', text: '收到。' },
    ]);

    expect(out.segments[0]).toMatchObject({ title: '这是后续真实任务', messageCount: 2 });
    expect(out.segments[0]!.content).not.toContain('codex_delegation');
  });
});
