// 左侧会话栏：按能力隔离——给了 capabilityId 只列该能力下的会话，「新会话」也在
// 该能力下直接开（GET /runtime/sessions?capabilityId= + POST /runtime/sessions）；
// 换能力回创作端的 Agent 列表。头部是 Combo 字标 + 返回按钮，底部常驻当前登录账号。
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SESSION_TITLE_MAX_LENGTH, type Role, type SessionView } from '@cb/shared';
import {
  useArchiveSession,
  useCreateSession,
  useSessions,
  useUpdateSessionTitle,
} from '../api/runtime.js';
import { useRuntimeMe } from '../shell/AuthGate.js';
import { ComboWordmark } from './ComboBrand.js';
import {
  appendRuntimeReturnTo,
  runtimeBackLabel,
  runtimeBackTarget,
  safeRuntimeReturnTo,
} from '../navigation/runtimeReturn.js';
import type { RuntimeSessionExperience } from '../sessionExperience.js';

const ROLE_LABEL: Record<Role, string> = {
  creator: '创作者',
};

/** 无角色/未知角色的兜底：消费端绝不把访客标成「创作者」（#27）。 */
const DEFAULT_ROLE_LABEL = '使用者';

function avatarInitial(name: string): string {
  const ch = Array.from(name.trim())[0] ?? '?';
  return ch.toUpperCase();
}

export function archivedSessionTarget(
  archivedSessionId: string,
  activeSessionId: string | undefined,
  sessions: SessionView[],
  returnTo?: string | null,
): string | null {
  if (archivedSessionId !== activeSessionId) return null;
  const nextSession = sessions.find((session) => session.id !== archivedSessionId);
  return nextSession
    ? appendRuntimeReturnTo(`/session/${nextSession.id}`, returnTo)
    : (safeRuntimeReturnTo(returnTo) ?? '/capabilities');
}

export function isRuntimeNavigationTarget(target: string): boolean {
  return target.startsWith('/session/');
}

export function SessionSidebar({
  activeSessionId,
  capabilityId,
  capabilityName,
  returnTo,
  runningSessionId,
  instanceId = 'desktop',
  onNavigate,
  experience = 'consume',
}: {
  activeSessionId?: string;
  /** 当前能力：会话列表与「新会话」都限定在它下面；缺省（加载中）时列表为空态。 */
  capabilityId?: string;
  capabilityName?: string;
  returnTo?: string | null;
  /** 当前正在生成的会话不能归档；服务端仍会做最终并发校验。 */
  runningSessionId?: string;
  /** 同页多实例（桌面侧栏 + 移动抽屉）使用不同 id 前缀。 */
  instanceId?: string;
  onNavigate?: () => void;
  experience?: RuntimeSessionExperience;
}) {
  const studioMode = experience === 'studio';
  const safeReturnTo = studioMode ? '/capabilities' : safeRuntimeReturnTo(returnTo);
  const navigate = useNavigate();
  const me = useRuntimeMe();
  const accountName = me?.account ?? '当前账号';
  const role = me?.roles[0];
  const accountTitle = role ? (ROLE_LABEL[role] ?? DEFAULT_ROLE_LABEL) : DEFAULT_ROLE_LABEL;
  const hasCapability = Boolean(capabilityId);
  const sessions = useSessions(capabilityId, {
    enabled: hasCapability,
    mode: studioMode ? 'studio' : 'consume',
  });
  const createSession = useCreateSession();
  const updateSession = useUpdateSessionTitle();
  const archiveSession = useArchiveSession();
  const [createError, setCreateError] = useState(false);
  const ordered = useMemo(
    () =>
      [...(hasCapability ? (sessions.data ?? []) : [])].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [hasCapability, sessions.data],
  );

  const startNewSession = () => {
    if (!capabilityId || createSession.isPending) return;
    setCreateError(false);
    createSession.mutate(capabilityId, {
      onSuccess: (session) => {
        onNavigate?.();
        navigate(appendRuntimeReturnTo(`/session/${session.id}`, safeReturnTo));
      },
      onError: () => setCreateError(true),
    });
  };

  const renameSession = async (sessionId: string, title: string) => {
    await updateSession.mutateAsync({ sessionId, title });
  };

  const archiveExistingSession = async (sessionId: string) => {
    await archiveSession.mutateAsync(sessionId);
    const target = archivedSessionTarget(sessionId, activeSessionId, ordered, safeReturnTo);
    if (!target) return;
    onNavigate?.();
    if (isRuntimeNavigationTarget(target)) navigate(target);
    else window.location.assign(target);
  };

  return (
    <nav className="rt-sidebar">
      <div className="rt-sidebar__head">
        {/* 市集暂未开放，品牌回到用户已有 Agent 的列表。 */}
        <a
          href="/capabilities"
          className="rt-sidebar__brand"
          aria-label="Combo 我的 Agent"
          onClick={onNavigate}
        >
          <ComboWordmark className="rt-sidebar__brand-word" />
        </a>
        {/* Studio 恒定回 Agent 列表；普通试用仍保留创作流程 returnTo。 */}
        {safeReturnTo && (
          <button
            type="button"
            className="rt-sidebar__back"
            aria-label={studioMode ? '← 返回我的 Agent' : runtimeBackLabel(safeReturnTo)}
            title={studioMode ? '← 返回我的 Agent' : runtimeBackLabel(safeReturnTo)}
            onClick={() => window.location.assign(runtimeBackTarget(safeReturnTo))}
          >
            <span aria-hidden="true">←</span>
          </button>
        )}
      </div>
      <div className="rt-sidebar__label">
        {studioMode ? `${capabilityName ?? 'Agent'} · UI 设计` : (capabilityName ?? '会话')}
      </div>
      <div className="rt-sidebar__list">
        {capabilityId && !studioMode && (
          <button
            type="button"
            className="rt-sidebar__item rt-sidebar__item--action"
            disabled={createSession.isPending}
            onClick={startNewSession}
          >
            <span className="rt-sidebar__avatar">＋</span>
            <span className="rt-sidebar__item-copy">
              <span className="rt-sidebar__item-title">
                {createSession.isPending ? '创建中…' : '新会话'}
              </span>
              <span className="rt-sidebar__item-cap">
                {createError ? '没建成，点击重试' : '用这个能力再开一次'}
              </span>
            </span>
          </button>
        )}
        {ordered.map((s) => (
          <SessionListItem
            key={s.id}
            session={s}
            active={s.id === activeSessionId}
            onRename={renameSession}
            onArchive={archiveExistingSession}
            archiveDisabled={s.id === runningSessionId}
            allowArchive={!studioMode}
            inputIdPrefix={instanceId}
            returnTo={safeReturnTo}
            onNavigate={onNavigate}
          />
        ))}
        {hasCapability && sessions.data && ordered.length === 0 && (
          <div className="rt-sidebar__empty">
            {studioMode ? '还没有设计记录' : '这个能力下还没有会话'}
          </div>
        )}
      </div>
      <div className="rt-sidebar__foot">
        <a href="/capabilities" className="rt-sidebar__market" onClick={onNavigate}>
          返回我的 Agent
        </a>
      </div>
      <div className="rt-sidebar__user">
        <span className="rt-sidebar__user-avatar" aria-hidden="true">
          {avatarInitial(accountName)}
        </span>
        <span>
          {accountName} · {accountTitle}
        </span>
      </div>
    </nav>
  );
}

export function SessionListItem({
  session,
  active,
  onRename,
  onArchive,
  archiveDisabled = false,
  allowArchive = true,
  inputIdPrefix = 'sidebar',
  returnTo,
  onNavigate,
}: {
  session: SessionView;
  active: boolean;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onArchive: (sessionId: string) => Promise<void>;
  archiveDisabled?: boolean;
  /** Studio has one durable design context per Agent, so it must not expose generic archive. */
  allowArchive?: boolean;
  inputIdPrefix?: string;
  returnTo?: string | null;
  onNavigate?: () => void;
}) {
  const title = session.title ?? '未命名会话';
  const avatar = title.trim().slice(0, 1).toUpperCase() || 'A';
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title ?? '');
  const [pendingAction, setPendingAction] = useState<'rename' | 'archive' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const updated = new Date(session.updatedAt).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const beginRename = () => {
    setDraftTitle(session.title ?? '');
    setActionError(null);
    setEditing(true);
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    const nextTitle = draftTitle.trim();
    if (!nextTitle || pendingAction) return;
    setActionError(null);
    setPendingAction('rename');
    try {
      await onRename(session.id, nextTitle);
      setEditing(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '改名失败，请重试。');
    } finally {
      setPendingAction(null);
    }
  };

  const confirmArchive = async () => {
    if (pendingAction) return;
    const confirmed =
      typeof window === 'undefined' || window.confirm(`归档“${title}”？会话内容会保留。`);
    if (!confirmed) return;
    setActionError(null);
    setPendingAction('archive');
    try {
      await onArchive(session.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '归档失败，请重试。');
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="rt-sidebar__session">
      {editing ? (
        <form
          className={`rt-sidebar__editor${active ? ' is-active' : ''}`}
          onSubmit={(event) => void submitRename(event)}
        >
          <label className="rt-sr-only" htmlFor={`${inputIdPrefix}-session-title-${session.id}`}>
            会话名称
          </label>
          <input
            id={`${inputIdPrefix}-session-title-${session.id}`}
            className="rt-sidebar__title-input"
            value={draftTitle}
            maxLength={SESSION_TITLE_MAX_LENGTH}
            autoFocus
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false);
            }}
          />
          <div className="rt-sidebar__editor-actions">
            <button type="submit" disabled={!draftTitle.trim() || pendingAction !== null}>
              {pendingAction === 'rename' ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              disabled={pendingAction !== null}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
        </form>
      ) : (
        <>
          <Link
            to={appendRuntimeReturnTo(`/session/${session.id}`, returnTo)}
            className={`rt-sidebar__item${active ? ' is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={onNavigate}
          >
            <span className="rt-sidebar__avatar">{avatar}</span>
            <span className="rt-sidebar__item-copy">
              <span className="rt-sidebar__item-title">{title}</span>
              <span className="rt-sidebar__item-cap">{updated}</span>
            </span>
          </Link>
          <span className="rt-sidebar__actions">
            <button
              type="button"
              aria-label={`重命名“${title}”`}
              title="重命名"
              disabled={pendingAction !== null}
              onClick={beginRename}
            >
              ✎
            </button>
            {allowArchive && (
              <button
                type="button"
                aria-label={archiveDisabled ? `“${title}”正在生成，暂时不能归档` : `归档“${title}”`}
                title={archiveDisabled ? '正在生成，结束或打断后才能归档' : '归档'}
                disabled={pendingAction !== null || archiveDisabled}
                onClick={() => void confirmArchive()}
              >
                {pendingAction === 'archive' ? '…' : '⌑'}
              </button>
            )}
          </span>
        </>
      )}
      {actionError && (
        <span className="rt-sidebar__action-error" role="alert">
          {actionError}
        </span>
      )}
    </div>
  );
}
