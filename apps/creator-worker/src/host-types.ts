import {
  HOST_INTERRUPT_TERMINAL_PROTOCOL,
  createHostInterruptedTerminalEvidence,
  createHostTurnTerminalEvidence,
} from '@cb/creator-agent-protocol';
import type {
  HostInterruptedTerminalEvidence,
  HostInterruptedTerminalObservation,
  HostTurnTerminalEvidence,
  HostTurnTerminalObservation,
} from '@cb/creator-agent-protocol';

// The Host interrupted-terminal contract is frozen in the shared protocol package so that
// the VNext SQLite Journal composition can verify cancellation evidence without depending
// on this app. These re-exports keep the local API surface unchanged.
export {
  HOST_INTERRUPT_TERMINAL_PROTOCOL,
  createHostInterruptedTerminalEvidence,
  createHostTurnTerminalEvidence,
  type HostInterruptedTerminalEvidence,
  type HostInterruptedTerminalObservation,
  type HostTurnTerminalEvidence,
  type HostTurnTerminalObservation,
};

export interface HostThread {
  id: string;
  generation: number;
  workspaceRootsAcknowledged: boolean;
}

export interface HostTurnResult {
  text: string;
}

export interface HostTurnHandle {
  readonly turnId: Promise<string>;
  readonly result: Promise<HostTurnResult>;
  readonly terminal: Promise<HostTurnTerminalEvidence>;
  interrupt(): Promise<HostInterruptedTerminalEvidence>;
}

export interface CodexHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  createThread(): Promise<HostThread>;
  startTurn(input: {
    thread: HostThread;
    messageId: string;
    text: string;
    timeoutMs: number;
  }): HostTurnHandle;
}

export type CodexHostErrorCode =
  | 'HOST_NOT_READY'
  | 'HOST_PROTOCOL_ERROR'
  | 'HOST_SESSION_LOST'
  | 'HOST_TIMEOUT'
  | 'HOST_INTERRUPTED'
  | 'HOST_TURN_FAILED'
  | 'HOST_OUTPUT_INVALID';

export class CodexHostError extends Error {
  constructor(
    readonly code: CodexHostErrorCode,
    message: string,
    readonly uncertain = false,
    readonly hostLost = false,
  ) {
    super(message);
    this.name = 'CodexHostError';
  }
}
