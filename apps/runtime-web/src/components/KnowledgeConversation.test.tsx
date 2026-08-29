import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { KnowledgeTurnResultSchema, type KnowledgeTurnResult, type MessageView } from '@cb/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  buildKnowledgeConversationEntries,
  formatKnowledgeCents,
  KnowledgeConversation,
  knowledgeUserMessageText,
  type KnowledgeConversationProps,
} from './KnowledgeConversation.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TURN_ID = '22222222-2222-4222-8222-222222222222';
const CAPABILITY_ID = '33333333-3333-4333-8333-333333333333';
const RUNTIME_SHA = 'd'.repeat(40);

function userMessage(text = 'Combo 的唯一分享工件是什么？'): MessageView {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    seq: 1,
    turnId: TURN_ID,
    role: 'user',
    content: [{ type: 'text', text }],
    status: 'completed',
    createdAt: '2026-08-30T01:00:00.000Z',
  };
}

function forgedAssistantMessage(): MessageView {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    seq: 2,
    turnId: TURN_ID,
    role: 'assistant',
    content: [
      { type: 'text', text: 'FORGED_ASSISTANT_CANDIDATE' },
      { type: 'toolResult', text: 'FORGED_TOOL_OUTPUT' },
    ],
    status: 'completed',
    createdAt: '2026-08-30T01:00:01.000Z',
  };
}

function resultCommon(source: 'owner' | 'free' | 'wallet') {
  return {
    protocol: 'combo.agent-usage-receipt/1',
    receiptId: '66666666-6666-4666-8666-666666666666',
    usageId: '77777777-7777-4777-8777-777777777777',
    turnId: TURN_ID,
    createdAt: '2026-08-30T01:00:02.000Z',
    binding: {
      productKind: 'knowledge_agent_test',
      capability: {
        id: CAPABILITY_ID,
        protocol: 'combo.agent-package-capability/2',
      },
      release: {
        protocol: 'combo.agent-package-release/1',
        releaseId: `release.agent-package.${'a'.repeat(32)}`,
        packageDigest: `sha256:${'b'.repeat(64)}`,
      },
      releaseScope: 'controlled_test',
      knowledge: {
        protocol: 'combo.knowledge-bundle/1',
        resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
        resourceDigest: `sha256:${'c'.repeat(64)}`,
      },
    },
    billing: {
      policyVersion: 'knowledge-test-v1',
      source,
      currency: 'CNY',
      unitPriceCents: '100',
      settledCents: source === 'wallet' ? '100' : '0',
      freeLimitSnapshot: 3,
    },
    runtime: {
      environment: 'test',
      releaseId: `release-${RUNTIME_SHA}`,
      sourceSha: RUNTIME_SHA,
    },
  } as const;
}

function answeredResult(source: 'owner' | 'free' | 'wallet' = 'wallet'): KnowledgeTurnResult {
  return KnowledgeTurnResultSchema.parse({
    ...resultCommon(source),
    outcome: 'answered',
    validation: { policyVersion: 'knowledge-test-v1', code: 'accepted' },
    answer: {
      messageId: '88888888-8888-4888-8888-888888888888',
      text: '**Agent Package** 是唯一分享工件。',
      responseDigest: `sha256:${'e'.repeat(64)}`,
    },
    citations: [
      {
        chunkId: `chunk.knowledge.${'1'.repeat(32)}`,
        sourceId: `source.knowledge.${'2'.repeat(32)}`,
        displayLabel: 'Combo 产品基线',
      },
      {
        chunkId: `chunk.knowledge.${'3'.repeat(32)}`,
        sourceId: `source.knowledge.${'4'.repeat(32)}`,
        displayLabel: '工程验收说明',
      },
    ],
  });
}

function insufficientResult(): KnowledgeTurnResult {
  return KnowledgeTurnResultSchema.parse({
    ...resultCommon('free'),
    outcome: 'insufficient_evidence',
    validation: { policyVersion: 'knowledge-test-v1', code: 'insufficient_evidence' },
    answer: {
      messageId: '88888888-8888-4888-8888-888888888888',
      text: '现有知识中没有足够证据回答这个问题。',
      responseDigest: `sha256:${'e'.repeat(64)}`,
    },
    citations: [],
  });
}

function failedResult(): KnowledgeTurnResult {
  return KnowledgeTurnResultSchema.parse({
    ...resultCommon('wallet'),
    billing: { ...resultCommon('wallet').billing, settledCents: '0' },
    outcome: 'failed',
    validation: { policyVersion: 'knowledge-test-v1', code: 'rejected' },
    answer: null,
    citations: [],
  });
}

function interruptedResult(): KnowledgeTurnResult {
  return KnowledgeTurnResultSchema.parse({
    ...resultCommon('free'),
    outcome: 'interrupted',
    validation: { policyVersion: 'knowledge-test-v1', code: 'not_run' },
    answer: null,
    citations: [],
  });
}

function props(overrides: Partial<KnowledgeConversationProps> = {}): KnowledgeConversationProps {
  return {
    sessionId: SESSION_ID,
    messages: [],
    results: [],
    isRunning: false,
    onSend: vi.fn().mockResolvedValue(undefined),
    onInterrupt: vi.fn(),
    ...overrides,
  };
}

describe('KnowledgeConversation authoritative projection', () => {
  it('shows an accessible empty state without an intake or artifact surface', () => {
    render(<KnowledgeConversation {...props()} />);

    expect(screen.getByRole('region', { name: '知识问答' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('从一个问题开始');
    expect(screen.getByRole('textbox', { name: '输入知识问题' })).toBeEnabled();
    expect(screen.queryByText(/生成产物|生成页面/u)).not.toBeInTheDocument();
  });

  it('reads only user text and never projects forged assistant or tool content', () => {
    const user = userMessage();
    expect(knowledgeUserMessageText(forgedAssistantMessage())).toBe('');
    expect(buildKnowledgeConversationEntries([forgedAssistantMessage(), user], [])).toHaveLength(1);

    render(
      <KnowledgeConversation
        {...props({ messages: [user, forgedAssistantMessage()], results: [] })}
      />,
    );

    expect(screen.getByText('Combo 的唯一分享工件是什么？')).toBeInTheDocument();
    expect(screen.queryByText('FORGED_ASSISTANT_CANDIDATE')).not.toBeInTheDocument();
    expect(screen.queryByText('FORGED_TOOL_OUTPUT')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('候选回答不会显示');
  });

  it('renders the accepted answer, citations, actual wallet charge, and exact runtime identity', () => {
    const result = answeredResult('wallet');
    render(<KnowledgeConversation {...props({ messages: [userMessage()], results: [result] })} />);

    expect(screen.getByRole('status', { name: '知识回答：已回答' })).toHaveTextContent(
      'Agent Package 是唯一分享工件。',
    );
    const citations = screen.getByRole('region', { name: '来源引用' });
    expect(within(citations).getByText('Combo 产品基线')).toBeInTheDocument();
    expect(within(citations).getByText('工程验收说明')).toBeInTheDocument();

    const receiptSummary = screen.getByText('使用收据 · 钱包 · 实际结算 ¥1.00');
    fireEvent.click(receiptSummary);
    expect(receiptSummary.closest('details')).toHaveAttribute('open');
    expect(screen.getByText(`release-${RUNTIME_SHA}`)).toBeInTheDocument();
    expect(screen.getByText(RUNTIME_SHA)).toBeInTheDocument();
    expect(screen.getByText(`sha256:${'b'.repeat(64)}`)).toBeInTheDocument();
  });

  it('shows free and insufficient-evidence settlement without inventing citations', () => {
    render(
      <KnowledgeConversation
        {...props({ messages: [userMessage()], results: [insufficientResult()] })}
      />,
    );

    expect(screen.getByRole('status', { name: '知识回答：证据不足' })).toHaveTextContent(
      '现有知识中没有足够证据回答这个问题。',
    );
    expect(screen.getByText('使用收据 · 免费额度 · 实际结算 ¥0.00')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '来源引用' })).not.toBeInTheDocument();
  });

  it('uses accessible failed, interrupted, and running states with zero candidate answer', () => {
    const failed = render(
      <KnowledgeConversation
        {...props({ messages: [userMessage()], results: [failedResult()] })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('引用校验未通过');
    expect(screen.getByText('使用收据 · 钱包 · 实际结算 ¥0.00')).toBeInTheDocument();
    failed.unmount();

    const interrupted = render(
      <KnowledgeConversation
        {...props({ messages: [userMessage()], results: [interruptedResult()] })}
      />,
    );
    expect(screen.getByRole('status', { name: '知识回答：已中断' })).toHaveTextContent(
      '没有产生答案或扣费',
    );
    interrupted.unmount();

    render(<KnowledgeConversation {...props({ messages: [userMessage()], isRunning: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在检索并校验已发布知识');
  });

  it('keeps a rejected question draft, exposes the conflict, and deduplicates pending sends', async () => {
    let reject!: (error: Error) => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    render(<KnowledgeConversation {...props({ onSend })} />);
    const textbox = screen.getByRole('textbox', { name: '输入知识问题' });
    fireEvent.change(textbox, { target: { value: '原问题' } });
    const send = screen.getByRole('button', { name: '发送问题' });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);

    reject(new Error('原 usageId 仍在确认，请重试原问题。'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('原 usageId 仍在确认'));
    expect(textbox).toHaveValue('原问题');
  });

  it('uses the explicit pending retry instead of sending a new question', async () => {
    const onRetryPending = vi.fn().mockResolvedValue(undefined);
    const onSend = vi.fn();
    render(
      <KnowledgeConversation {...props({ pendingRetryAvailable: true, onRetryPending, onSend })} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重试原问题' }));
    await waitFor(() => expect(onRetryPending).toHaveBeenCalledOnce());
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('formatKnowledgeCents', () => {
  it('formats canonical integer cents without floating point conversion', () => {
    expect(formatKnowledgeCents('0')).toBe('¥0.00');
    expect(formatKnowledgeCents('5')).toBe('¥0.05');
    expect(formatKnowledgeCents('100')).toBe('¥1.00');
    expect(formatKnowledgeCents('9223372036854775807')).toBe('¥92233720368547758.07');
    expect(formatKnowledgeCents('1.2')).toBe('金额不可用');
  });
});
