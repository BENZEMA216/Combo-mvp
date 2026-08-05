import { useState, type FormEvent, type ReactElement } from 'react';
import { readLandingDraft, saveLandingDraft } from '../landing/landingDraft.js';

export interface CreationMethodPickerProps {
  createPending: boolean;
  onCreateUpload: () => void;
  onClose?: () => void;
}

type ManagedDraftState = 'idle' | 'saved' | 'invalid' | 'unavailable';

export function CreationMethodPicker({
  createPending,
  onCreateUpload,
  onClose,
}: CreationMethodPickerProps): ReactElement {
  const cached = readLandingDraft();
  const [managedOpen, setManagedOpen] = useState(false);
  const [profileUrl, setProfileUrl] = useState(cached?.profileUrl ?? '');
  const [contactEmail, setContactEmail] = useState(cached?.contactEmail ?? '');
  const [consent, setConsent] = useState(cached?.consent === true);
  const [draftState, setDraftState] = useState<ManagedDraftState>(
    cached?.contactEmail ? 'saved' : 'idle',
  );

  function saveManagedDraft(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!consent) {
      setDraftState('invalid');
      return;
    }
    const result = saveLandingDraft({ profileUrl, contactEmail, consent: true });
    setDraftState(result.ok ? 'saved' : result.reason);
  }

  return (
    <section className="cb-create-methods" aria-labelledby="cb-create-methods-title">
      <header className="cb-create-methods__head">
        <div>
          <p className="cb-section-kicker">选择 Context 来源</p>
          <h3 id="cb-create-methods-title">用哪种方式创建 Agent？</h3>
          <p>两条路径同等重要。现在可真实导入本机会话，也可以先体验公开主页托管表单。</p>
        </div>
        {onClose && (
          <button type="button" className="cb-create-methods__close" onClick={onClose}>
            收起
          </button>
        )}
      </header>

      <div className="cb-create-methods__grid">
        <article className="cb-create-method">
          <div className="cb-create-method__topline">
            <span className="cb-create-method__number">01</span>
            <span className="cb-create-method__badge is-real">真实上传</span>
          </div>
          <h4>导入本机会话</h4>
          <p>在 Codex 或终端运行一条命令，上传本机对话历史；进度可离开后继续。</p>
          <p className="cb-create-method__meta">适合已有 Claude / Codex 工作记录的创作者</p>
          <button
            type="button"
            className="cb-create-method__action"
            onClick={onCreateUpload}
            disabled={createPending}
          >
            {createPending ? '正在创建连接…' : '创建连接任务'}
          </button>
        </article>

        <article className="cb-create-method">
          <div className="cb-create-method__topline">
            <span className="cb-create-method__number">02</span>
            <span className="cb-create-method__badge is-mock">前端体验 · 未提交</span>
          </div>
          <h4>提交公开主页</h4>
          <p>留下 KOL 主页和联系邮箱，体验托管搭建的资料准备方式。</p>
          <p className="cb-create-method__meta">适合希望由 Combo 异步整理公开内容的创作者</p>
          <button
            type="button"
            className="cb-create-method__action"
            aria-expanded={managedOpen}
            aria-controls="cb-managed-intake"
            onClick={() => setManagedOpen((value) => !value)}
          >
            {managedOpen ? '收起资料' : '填写资料'}
          </button>
        </article>
      </div>

      {managedOpen && (
        <form className="cb-managed-intake" id="cb-managed-intake" onSubmit={saveManagedDraft}>
          <div className="cb-managed-intake__heading">
            <div>
              <span className="cb-create-method__badge is-mock">Mock</span>
              <h4>托管创建资料</h4>
            </div>
            <p>这里只验证交互与信息结构，不会发起网络请求。</p>
          </div>
          <div className="cb-managed-intake__fields">
            <label>
              <span>公开主页链接</span>
              <input
                type="url"
                inputMode="url"
                value={profileUrl}
                onChange={(event) => {
                  setProfileUrl(event.target.value);
                  setDraftState('idle');
                }}
                placeholder="https://example.com/creator"
                required
              />
            </label>
            <label>
              <span>联系邮箱</span>
              <input
                type="email"
                inputMode="email"
                value={contactEmail}
                onChange={(event) => {
                  setContactEmail(event.target.value);
                  setDraftState('idle');
                }}
                placeholder="creator@example.com"
                required
              />
            </label>
          </div>
          <label className="cb-managed-intake__consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => {
                setConsent(event.target.checked);
                setDraftState('idle');
              }}
              required
            />
            <span>我确认这些内容是公开资料；未来真实提交时，Combo 会再次请求授权。</span>
          </label>
          <div className="cb-managed-intake__footer">
            <p className="cb-managed-intake__notice">
              资料仅保存在当前标签页，尚未提交到 Combo，不会开始抓取或生成 Agent。
            </p>
            <button type="submit" className="cb-create-method__action">
              保存体验草稿
            </button>
          </div>
          {draftState === 'saved' && (
            <p className="cb-managed-intake__feedback is-success" role="status">
              体验草稿已保存在当前标签页；关闭标签页后不会作为真实任务保留。
            </p>
          )}
          {draftState === 'invalid' && (
            <p className="cb-managed-intake__feedback is-error" role="alert">
              请检查公开主页链接、联系邮箱与授权选项。
            </p>
          )}
          {draftState === 'unavailable' && (
            <p className="cb-managed-intake__feedback is-error" role="alert">
              当前浏览器无法保存这份体验草稿，请稍后再试。
            </p>
          )}
        </form>
      )}
    </section>
  );
}
