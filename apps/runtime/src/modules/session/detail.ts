import type { ArtifactView, TerminalTurnView } from '@cb/shared';
import { getActiveTurn, getLatestTerminalTurnView } from '../agent/turn-repo.js';
import { listArtifacts, readCapabilityUiArtifact, type StoredArtifact } from '../artifact/repo.js';
import { readCapabilitySummary, type CapabilitySummary } from '../capability/loader.js';
import { withTransaction, type RuntimeDb } from '../../platform/infra/db.js';
import { getMessages, getSession, type MessageRecord, type SessionRow } from './repo.js';
import { readKnowledgeUsageReceipts, type KnowledgeReceiptDbRow } from '../knowledge-agent/repo.js';

export interface SessionDetailDbSnapshot {
  session: SessionRow;
  capability: Pick<CapabilitySummary, 'id' | 'name' | 'summary' | 'kind'> | null;
  messages: MessageRecord[];
  artifacts: ArtifactView[];
  currentUiArtifact: StoredArtifact | null;
  activeTurn: { id: string; createdAt: string } | null;
  latestTerminalTurn: TerminalTurnView | null;
  knowledgeReceipts: KnowledgeReceiptDbRow[];
}

/**
 * 会话详情里的全部 PostgreSQL 状态必须来自同一个 MVCC 快照。第一条业务查询在事务内
 * 重新校验 active Session 与 owner；后续消息、Artifact、当前 UI 和 active Turn 不会
 * 拼接到别的提交时刻。
 */
export async function readSessionDetailDbSnapshot(
  db: RuntimeDb,
  input: { sessionId: string; ownerUserId: string },
): Promise<SessionDetailDbSnapshot | null> {
  return withTransaction(
    db,
    async (tx) => {
      const session = await getSession(tx, input.sessionId, input.ownerUserId);
      if (!session) return null;

      // 单连接顺序读取让每一项都明确属于上面建立的 REPEATABLE READ 快照。
      const capability = await readCapabilitySummary(tx, session.capabilityId);
      const messages = await getMessages(tx, session.id);
      const artifacts = await listArtifacts(tx, session.id, session.mode);
      const currentUiArtifact =
        session.mode === 'studio' ? await readCapabilityUiArtifact(tx, session.capabilityId) : null;
      const activeTurn = await getActiveTurn(tx, session.id);
      const latestTerminalTurn = await getLatestTerminalTurnView(tx, session.id);
      const knowledgeReceipts =
        session.agentBinding.productKind === 'knowledge_agent_test'
          ? await readKnowledgeUsageReceipts(tx, session.id)
          : [];

      return {
        session,
        capability,
        messages,
        artifacts,
        currentUiArtifact,
        activeTurn,
        latestTerminalTurn,
        knowledgeReceipts,
      };
    },
    { readOnlySnapshot: true },
  );
}
