import { randomUUID } from 'node:crypto';

import {
  CodexHostError,
  type CodexHost,
  type HostThread,
  type HostTurnHandle,
} from './host-types.js';

export type CreatorWorkerErrorCode =
  | 'INVALID_INPUT'
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_BUSY'
  | 'CONVERSATION_LIMIT'
  | 'CAPACITY_REACHED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NO_ACTIVE_TURN'
  | 'HOST_UNAVAILABLE'
  | 'TURN_TIMEOUT'
  | 'TURN_INTERRUPTED'
  | 'TURN_FAILED';

const ERROR_MESSAGES: Record<CreatorWorkerErrorCode, string> = {
  INVALID_INPUT: '请求内容不符合体验版约束。',
  CONVERSATION_NOT_FOUND: '这段对话已失效，请新建对话。',
  CONVERSATION_BUSY: '这段对话正在回答，请稍后再发。',
  CONVERSATION_LIMIT: '这段对话已达到体验版轮数上限。',
  CAPACITY_REACHED: 'Agent 正在回答另一段对话，请稍后再试。',
  IDEMPOTENCY_CONFLICT: '同一个消息标识不能对应不同内容。',
  NO_ACTIVE_TURN: '当前没有可停止的回答。',
  HOST_UNAVAILABLE: '本地 Codex 暂时不可用，请新建对话后重试。',
  TURN_TIMEOUT: '这次回答超时了，请新建消息后重试。',
  TURN_INTERRUPTED: '这次回答已停止。',
  TURN_FAILED: 'Codex 没能完成这次回答。',
};

export class CreatorWorkerError extends Error {
  constructor(
    readonly code: CreatorWorkerErrorCode,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CreatorWorkerError';
  }
}

export interface CreatorWorkerOptions {
  host: CodexHost;
  maxConcurrentTurns?: number;
  maxConversations?: number;
  maxMessagesPerConversation?: number;
  turnTimeoutMs?: number;
}

export interface ConversationCreated {
  conversationId: string;
}

export interface MessageReply {
  text: string;
}

export interface CreatorWorkerStatus {
  online: boolean;
  mode: 'local_experience';
  activeTurns: number;
  maxConcurrentTurns: number;
  conversations: number;
}

interface StoredMessage {
  readonly text: string;
  readonly promise: Promise<MessageReply>;
  state: 'pending' | 'completed' | 'failed';
  result?: MessageReply;
  error?: CreatorWorkerError;
  handle?: HostTurnHandle;
  cancelRequested: boolean;
  turnDispatched: boolean;
}

interface Conversation {
  readonly id: string;
  readonly messages: Map<string, StoredMessage>;
  thread?: HostThread;
  activeMessageId?: string;
}

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CONVERSATION_ID_PATTERN = /^[0-9a-f-]{36}$/;
const MAX_TEXT_CHARS = 4_000;

export class CreatorWorker {
  private readonly host: CodexHost;
  private readonly maxConcurrentTurns: number;
  private readonly maxConversations: number;
  private readonly maxMessagesPerConversation: number;
  private readonly turnTimeoutMs: number;
  private readonly conversations = new Map<string, Conversation>();
  private activeTurns = 0;
  private online = false;
  private closed = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(options: CreatorWorkerOptions) {
    this.host = options.host;
    this.maxConcurrentTurns = options.maxConcurrentTurns ?? 1;
    this.maxConversations = options.maxConversations ?? 20;
    this.maxMessagesPerConversation = options.maxMessagesPerConversation ?? 50;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
    if (
      !Number.isSafeInteger(this.maxConcurrentTurns) ||
      this.maxConcurrentTurns < 1 ||
      !Number.isSafeInteger(this.maxConversations) ||
      this.maxConversations < 1 ||
      !Number.isSafeInteger(this.maxMessagesPerConversation) ||
      this.maxMessagesPerConversation < 1 ||
      !Number.isSafeInteger(this.turnTimeoutMs) ||
      this.turnTimeoutMs < 1_000
    ) {
      throw new TypeError('Creator Worker limits are invalid.');
    }
  }

  async start(): Promise<void> {
    if (this.closed) throw new CreatorWorkerError('HOST_UNAVAILABLE', 503, false);
    if (this.online) return;
    if (this.starting) return this.starting;
    const starting = this.startOnce();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async startOnce(): Promise<void> {
    try {
      await this.host.start();
      if (this.closed) {
        await this.host.stop().catch(() => undefined);
        throw new CreatorWorkerError('HOST_UNAVAILABLE', 503, false);
      }
      this.online = true;
    } catch (error) {
      if (error instanceof CreatorWorkerError) throw error;
      throw new CreatorWorkerError('HOST_UNAVAILABLE', 503, false);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.online = false;
    this.stopping = (async () => {
      const interrupts: Promise<void>[] = [];
      for (const conversation of this.conversations.values()) {
        const active = conversation.activeMessageId
          ? conversation.messages.get(conversation.activeMessageId)
          : undefined;
        if (active?.handle) interrupts.push(active.handle.interrupt().catch(() => undefined));
      }
      await Promise.allSettled(interrupts);
      await this.host.stop().catch(() => undefined);
      this.conversations.clear();
      this.activeTurns = 0;
    })();
    return this.stopping;
  }

  async createConversation(): Promise<ConversationCreated> {
    if (this.closed) throw new CreatorWorkerError('HOST_UNAVAILABLE', 503, false);
    if (!this.online) await this.start();
    if (this.closed || !this.online) {
      throw new CreatorWorkerError('HOST_UNAVAILABLE', 503, false);
    }
    if (this.conversations.size >= this.maxConversations) {
      throw new CreatorWorkerError('CAPACITY_REACHED', 503, true);
    }
    const id = randomUUID();
    this.conversations.set(id, { id, messages: new Map() });
    return { conversationId: id };
  }

  sendMessage(input: {
    conversationId: string;
    messageId: string;
    text: string;
  }): Promise<MessageReply> {
    validateConversationId(input.conversationId);
    validateMessageId(input.messageId);
    validateText(input.text);
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) throw new CreatorWorkerError('CONVERSATION_NOT_FOUND', 404, false);

    // Idempotency always wins over busy and global-capacity checks.
    const existing = conversation.messages.get(input.messageId);
    if (existing) {
      if (existing.text !== input.text) {
        throw new CreatorWorkerError('IDEMPOTENCY_CONFLICT', 409, false);
      }
      if (existing.state === 'completed' && existing.result) {
        return Promise.resolve(existing.result);
      }
      if (existing.state === 'failed' && existing.error) {
        return Promise.reject(existing.error);
      }
      return existing.promise;
    }

    if (!this.online) throw new CreatorWorkerError('HOST_UNAVAILABLE', 503, true);

    if (conversation.activeMessageId) {
      throw new CreatorWorkerError('CONVERSATION_BUSY', 409, true);
    }
    if (conversation.messages.size >= this.maxMessagesPerConversation) {
      throw new CreatorWorkerError('CONVERSATION_LIMIT', 409, false);
    }
    if (this.activeTurns >= this.maxConcurrentTurns) {
      throw new CreatorWorkerError('CAPACITY_REACHED', 503, true);
    }

    this.activeTurns += 1;
    conversation.activeMessageId = input.messageId;
    let resolveMessage!: (reply: MessageReply) => void;
    let rejectMessage!: (error: CreatorWorkerError) => void;
    const promise = new Promise<MessageReply>((resolve, reject) => {
      resolveMessage = resolve;
      rejectMessage = reject;
    });
    const record: StoredMessage = {
      text: input.text,
      promise,
      state: 'pending',
      cancelRequested: false,
      turnDispatched: false,
    };
    conversation.messages.set(input.messageId, record);
    void (async () => {
      let result: MessageReply | undefined;
      let failure: CreatorWorkerError | undefined;
      try {
        result = await this.executeMessage(conversation, input.messageId, input.text);
        record.state = 'completed';
        record.result = result;
      } catch (error) {
        failure = toWorkerError(error);
        if (!record.turnDispatched) {
          conversation.messages.delete(input.messageId);
        } else {
          if (failure.retryable) {
            failure = new CreatorWorkerError(failure.code, failure.status, false);
          }
          record.state = 'failed';
          record.error = failure;
        }
      } finally {
        if (conversation.activeMessageId === input.messageId) {
          conversation.activeMessageId = undefined;
        }
        this.activeTurns = Math.max(0, this.activeTurns - 1);
      }
      if (failure) rejectMessage(failure);
      else if (result) resolveMessage(result);
      else rejectMessage(new CreatorWorkerError('TURN_FAILED', 500, false));
    })();
    return promise;
  }

  async interrupt(conversationId: string): Promise<void> {
    validateConversationId(conversationId);
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new CreatorWorkerError('CONVERSATION_NOT_FOUND', 404, false);
    const message = conversation.activeMessageId
      ? conversation.messages.get(conversation.activeMessageId)
      : undefined;
    if (!message || message.state !== 'pending') {
      throw new CreatorWorkerError('NO_ACTIVE_TURN', 409, false);
    }
    if (message.cancelRequested) return;
    message.cancelRequested = true;
    if (message.handle) await message.handle.interrupt();
  }

  status(): CreatorWorkerStatus {
    return {
      online: this.online,
      mode: 'local_experience',
      activeTurns: this.activeTurns,
      maxConcurrentTurns: this.maxConcurrentTurns,
      conversations: this.conversations.size,
    };
  }

  private async executeMessage(
    conversation: Conversation,
    messageId: string,
    text: string,
  ): Promise<MessageReply> {
    try {
      const message = conversation.messages.get(messageId);
      if (!message) throw new CreatorWorkerError('TURN_FAILED', 500, false);
      if (!conversation.thread) conversation.thread = await this.host.createThread();
      message.turnDispatched = true;
      const handle = this.host.startTurn({
        thread: conversation.thread,
        messageId,
        text,
        timeoutMs: this.turnTimeoutMs,
      });
      message.handle = handle;
      void handle.turnId.catch(() => undefined);
      if (message.cancelRequested) await handle.interrupt();
      const result = await handle.result;
      return { text: result.text };
    } catch (error) {
      if (error instanceof CodexHostError && error.hostLost) {
        this.online = false;
        this.conversations.clear();
      }
      throw error;
    }
  }
}

function validateConversationId(value: string): void {
  if (!CONVERSATION_ID_PATTERN.test(value)) {
    throw new CreatorWorkerError('INVALID_INPUT', 400, false);
  }
}

function validateMessageId(value: string): void {
  if (!MESSAGE_ID_PATTERN.test(value)) {
    throw new CreatorWorkerError('INVALID_INPUT', 400, false);
  }
}

function validateText(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length > MAX_TEXT_CHARS ||
    value.includes('\0') ||
    value.trim().length === 0
  ) {
    throw new CreatorWorkerError('INVALID_INPUT', 400, false);
  }
}

function toWorkerError(error: unknown): CreatorWorkerError {
  if (error instanceof CreatorWorkerError) return error;
  if (error instanceof CodexHostError) {
    if (error.code === 'HOST_TIMEOUT') {
      return new CreatorWorkerError('TURN_TIMEOUT', 504, false);
    }
    if (error.code === 'HOST_INTERRUPTED') {
      return new CreatorWorkerError('TURN_INTERRUPTED', 409, false);
    }
    if (
      error.code === 'HOST_NOT_READY' ||
      error.code === 'HOST_SESSION_LOST' ||
      error.code === 'HOST_PROTOCOL_ERROR'
    ) {
      return new CreatorWorkerError('HOST_UNAVAILABLE', 503, false);
    }
  }
  return new CreatorWorkerError('TURN_FAILED', 500, false);
}
