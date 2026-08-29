import { CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_BROWSER_VALIDATION_SPEC } from '@cb/creator-agent-protocol/agent-package-draft';
import {
  PROJECT_HISTORY_AGENT_DRAFT_SUMMARY,
  PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_LABEL,
  PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE,
} from './contracts.js';

export const PROJECT_HISTORY_AGENT_DRAFT_APP_URI =
  'ui://combo/project-history-agent-draft/v1.html' as const;

export const PROJECT_HISTORY_AGENT_DRAFT_APP_RESOURCE = Object.freeze({
  uri: PROJECT_HISTORY_AGENT_DRAFT_APP_URI,
  name: 'combo-project-history-agent-draft',
  title: 'Combo Agent Package Draft',
  description:
    'Render one exact persisted Project-history Agent Package Draft and its fixed confirmation action.',
  mimeType: 'text/html;profile=mcp-app',
});

export const PROJECT_HISTORY_AGENT_DRAFT_APP_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; background: transparent; color: var(--color-text-primary, #172033); }
      main { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--color-border-default, #dce2ec); border-radius: 18px; background: var(--color-background-primary, #fff); }
      .eyebrow { color: #3b5ccc; font-size: 12px; font-weight: 750; letter-spacing: .06em; }
      h1, h2, p, dl { margin: 0; }
      h1 { font-size: 20px; } h2 { font-size: 14px; }
      .summary, dd, .status { color: var(--color-text-secondary, #596579); font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
      section { display: grid; gap: 8px; padding: 12px; border-radius: 12px; background: var(--color-background-secondary, #f5f7fa); }
      dl { display: grid; grid-template-columns: minmax(105px, .45fr) 1fr; gap: 6px 10px; font-size: 12px; }
      dt { color: var(--color-text-secondary, #6b7280); } dd { margin: 0; }
      ul { margin: 0; padding-left: 20px; font-size: 13px; }
      button { appearance: none; justify-self: start; border: 1px solid #3b5ccc; border-radius: 10px; padding: 9px 13px; background: #3b5ccc; color: #fff; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
      button:disabled { cursor: wait; opacity: .6; }
      .warning { color: #805500; }
      .error { color: #a62b2b; font-size: 12px; }
      @media (prefers-color-scheme: dark) { main { background: #151922; border-color: #353d4b; } section { background: #202632; } }
    </style>
  </head>
  <body>
    <main aria-live="polite">
      <div class="eyebrow">AGENT PACKAGE DRAFT</div>
      <h1 id="title">正在准备草稿…</h1>
      <p id="summary" class="summary"></p>
      <section><h2>内容</h2><dl id="content"></dl><div><strong>起始任务</strong><ul id="starters"></ul></div></section>
      <section><h2>来源边界</h2><dl id="source"></dl><div><strong>固定限制</strong><ul id="limitations"></ul></div><p class="summary warning">这是 best-effort 提炼；来源覆盖、Host 认证与进入模型前的字段投影均未证明。原始历史不由 Combo 存储。</p></section>
      <section><h2>分享效果</h2><p class="summary warning">确认后会创建不过期且不可撤回的公开链接；任何持链接者都可读取，但这不等于 marketplace publication 或 public listing。</p></section>
      <button id="confirm" type="button" hidden>确认创建公开且不可撤回的分享</button>
      <p id="status" class="status" hidden></p>
      <p id="error" class="error" hidden></p>
    </main>
    <script>
      (() => {
        const MCP_UI_PROTOCOL_VERSION = '2026-01-26';
        const REQUEST_TIMEOUT_MS = 8000;
        const pending = new Map();
        let nextId = 1;
        let action = null;
        let locked = false;
        let active = true;
        let bridgeState = 'starting';
        let lifecycleEpoch = 0;
        let renderEpoch = 0;
        const TEXT_VALIDATION_SPEC = ${JSON.stringify(
          CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_BROWSER_VALIDATION_SPEC,
        )};
        const AGENT_NAME_PATTERN = new RegExp(TEXT_VALIDATION_SPEC.agentNamePattern.source, TEXT_VALIDATION_SPEC.agentNamePattern.flags);
        const CREDENTIAL_PATTERNS = TEXT_VALIDATION_SPEC.credentialPatterns.map((entry) => new RegExp(entry.source, entry.flags));
        const HOST_IDENTIFIER_PATTERN = new RegExp(TEXT_VALIDATION_SPEC.hostIdentifierPattern.source, TEXT_VALIDATION_SPEC.hostIdentifierPattern.flags);
        const NONPORTABLE_PATTERNS = TEXT_VALIDATION_SPEC.nonPortableAgentReference.patterns.map((entry) => new RegExp(entry.source, entry.flags));
        const COMMON_POSIX_ROOT_SEGMENTS = new Set(TEXT_VALIDATION_SPEC.nonPortableAgentReference.commonPosixRootSegments);
        const FIXED_SUMMARY = ${JSON.stringify(PROJECT_HISTORY_AGENT_DRAFT_SUMMARY)};
        const FIXED_ACTION_LABEL = ${JSON.stringify(PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_LABEL)};
        const FIXED_ACTION_MESSAGE = ${JSON.stringify(PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE)};
        const LIMITATION_REASONS = [
          'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
          'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
          'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED'
        ];
        const SOURCE_KEYS = [
          'kind', 'selection', 'assurance', 'completeness', 'hostAttestation',
          'sourceProjectionEnforced', 'rawStored', 'projectCount', 'discoveredThreadCount',
          'readThreadCount', 'omittedThreadCount', 'completedTurnCount',
          'userVisibleMessageCount', 'omittedItemCount', 'limitationReasons'
        ];
        const MAX_SNAPSHOT_DEPTH = 20;
        const MAX_SNAPSHOT_NODES = 4096;
        const MAX_SNAPSHOT_BYTES = 262144;
        const DANGEROUS_SNAPSHOT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
        function detachStrictJson(raw) {
          const seen = new WeakSet();
          const encoder = new window.TextEncoder();
          let nodes = 0;
          let bytes = 0;
          function accountText(value) {
            bytes += encoder.encode(value).byteLength;
            if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('snapshot byte limit exceeded');
          }
          function dataDescriptor(descriptor, enumerable) {
            return descriptor && descriptor.enumerable === enumerable &&
              Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
              !Object.prototype.hasOwnProperty.call(descriptor, 'get') &&
              !Object.prototype.hasOwnProperty.call(descriptor, 'set');
          }
          function visit(value, depth) {
            nodes += 1;
            if (nodes > MAX_SNAPSHOT_NODES || depth > MAX_SNAPSHOT_DEPTH) {
              throw new Error('snapshot structure limit exceeded');
            }
            if (value === null || typeof value === 'boolean') return value;
            if (typeof value === 'string') { accountText(value); return value; }
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (!value || typeof value !== 'object' || seen.has(value)) {
              throw new Error('snapshot contains non-JSON or aliased value');
            }
            seen.add(value);
            const array = Array.isArray(value);
            const prototype = Object.getPrototypeOf(value);
            if ((array && prototype !== Array.prototype) ||
                (!array && prototype !== Object.prototype && prototype !== null)) {
              throw new Error('snapshot contains a non-plain prototype');
            }
            const descriptors = Object.getOwnPropertyDescriptors(value);
            const descriptorKeys = Reflect.ownKeys(descriptors);
            if (descriptorKeys.some((key) => typeof key !== 'string')) {
              throw new Error('snapshot contains a symbol key');
            }
            if (array) {
              const lengthDescriptor = descriptors.length;
              if (!dataDescriptor(lengthDescriptor, false) ||
                  !Number.isInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
                  lengthDescriptor.value > MAX_SNAPSHOT_NODES ||
                  descriptorKeys.length !== lengthDescriptor.value + 1) {
                throw new Error('snapshot contains a sparse or decorated array');
              }
              const result = new Array(lengthDescriptor.value);
              for (let index = 0; index < lengthDescriptor.value; index += 1) {
                const key = String(index);
                const descriptor = descriptors[key];
                if (!dataDescriptor(descriptor, true)) {
                  throw new Error('snapshot contains a sparse or accessor array item');
                }
                result[index] = visit(descriptor.value, depth + 1);
              }
              return Object.freeze(result);
            }
            const result = Object.create(null);
            for (const key of descriptorKeys) {
              if (key === 'length' || DANGEROUS_SNAPSHOT_KEYS.has(key)) {
                throw new Error('snapshot contains a dangerous key');
              }
              accountText(key);
              const descriptor = descriptors[key];
              if (!dataDescriptor(descriptor, true)) {
                throw new Error('snapshot contains an accessor or hidden property');
              }
              Object.defineProperty(result, key, {
                value: visit(descriptor.value, depth + 1),
                enumerable: true,
                configurable: false,
                writable: false
              });
            }
            return Object.freeze(result);
          }
          return visit(raw, 0);
        }
        function text(value) { return typeof value === 'string' ? value : ''; }
        function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
        function row(list, label, value) {
          const dt = document.createElement('dt'); dt.textContent = label;
          const dd = document.createElement('dd'); dd.textContent = text(value);
          list.append(dt, dd);
        }
        function exactObject(value, keys) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
          const actual = Object.keys(value);
          return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
        }
        function strictArray(value) {
          if (!Array.isArray(value)) return false;
          const keys = Object.keys(value);
          return keys.length === value.length && keys.every((key, index) => key === String(index));
        }
        function containsLoneSurrogate(value) {
          for (let index = 0; index < value.length; index += 1) {
            const unit = value.charCodeAt(index);
            if (unit >= 0xd800 && unit <= 0xdbff) {
              const next = value.charCodeAt(index + 1);
              if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
              index += 1;
            } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
          }
          return false;
        }
        function containsUnsafeText(value) {
          if (containsLoneSurrogate(value) || /\\p{Cf}/u.test(value)) return true;
          for (let index = 0; index < value.length; index += 1) {
            const unit = value.charCodeAt(index);
            if (unit <= 0x08 || (unit >= 0x0b && unit <= 0x1f) ||
                (unit >= 0x7f && unit <= 0x9f) || unit === 0x2028 || unit === 0x2029) return true;
          }
          return false;
        }
        function containsNonPortableReference(value) {
          if (value.includes('\\\\') || NONPORTABLE_PATTERNS.some((pattern) => pattern.test(value))) return true;
          for (let index = 0; index < value.length; index += 1) {
            if (value[index] !== '/') continue;
            if (index === 0) return true;
            const previous = value[index - 1];
            if (/[\\s\\p{P}\\p{S}]/u.test(previous)) return true;
            const match = /^[A-Za-z0-9._-]+/u.exec(value.slice(index + 1));
            const segment = match && match[0].toLowerCase();
            if (segment !== null && segment !== undefined && COMMON_POSIX_ROOT_SEGMENTS.has(segment) &&
                !/[A-Za-z0-9._-]/u.test(previous)) return true;
          }
          return false;
        }
        function containsProjectHistoryCredential(value) {
          return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
        }
        function containsProjectHistorySourceReference(value) {
          return containsNonPortableReference(value) || HOST_IDENTIFIER_PATTERN.test(value);
        }
        function safeText(value, minimum, maximum) {
          return typeof value === 'string' && value.length >= minimum && value.length <= maximum &&
            value.normalize('NFC') === value && value.trim() === value && value.trim().length > 0 &&
            /[\\p{L}\\p{N}\\p{P}\\p{S}]/u.test(value) && !containsUnsafeText(value) &&
            !containsNonPortableReference(value);
        }
        function safeLine(value, minimum, maximum) {
          return safeText(value, minimum, maximum) && !/[\\r\\n]/u.test(value) &&
            value.replace(/\\s+/gu, ' ') === value;
        }
        function agentName(value) {
          return typeof value === 'string' && AGENT_NAME_PATTERN.test(value) &&
            value.normalize('NFC') === value && value.trim() === value &&
            value.replace(/\\s+/gu, ' ') === value;
        }
        function digest(value) { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
        function integer(value, minimum, maximum) {
          return Number.isInteger(value) && value >= minimum && value <= maximum;
        }
        function confirmationBoundaryValid(value) {
          const opaqueKey = ['confirmation', 'Token'].join('');
          const opaquePrefix = ['cf', 'rm_'].join('');
          const opaqueValue = value && typeof value === 'object' ? value[opaqueKey] : undefined;
          return exactObject(value, ['scheme', opaqueKey, 'expiresAt']) &&
            value.scheme === 'combo.agent-package-share-confirmation/1' &&
            typeof opaqueValue === 'string' && opaqueValue.length === 48 &&
            opaqueValue.startsWith(opaquePrefix) && /^[A-Za-z0-9_-]{43}$/u.test(opaqueValue.slice(5)) &&
            typeof value.expiresAt === 'string' && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/u.test(value.expiresAt) &&
            new Date(value.expiresAt).toISOString() === value.expiresAt;
        }
        function contentValid(value) {
          if (!exactObject(value, ['name', 'description', 'instructions', 'starterPrompts', 'outputDescription']) ||
            !agentName(value.name) || !safeLine(value.description, 1, 500) ||
            !safeText(value.instructions, 1, 8000) || !safeText(value.outputDescription, 1, 1000) ||
            !strictArray(value.starterPrompts) || value.starterPrompts.length < 1 || value.starterPrompts.length > 5 ||
            !value.starterPrompts.every((item) => safeLine(item, 1, 1000)) ||
            new Set(value.starterPrompts).size !== value.starterPrompts.length) return false;
          const fields = [value.name, value.description, value.instructions, ...value.starterPrompts, value.outputDescription];
          return !fields.some((field) => containsProjectHistoryCredential(field) || containsProjectHistorySourceReference(field));
        }
        function sourceValid(value, includesCommitment) {
          const keys = includesCommitment ? SOURCE_KEYS.concat(['candidateCommitment']) : SOURCE_KEYS;
          return exactObject(value, keys) &&
            value.kind === 'host_project_scoped_reduced_history' &&
            value.selection === 'user_selected_saved_project' && value.assurance === 'best_effort' &&
            value.completeness === 'not_proven' && value.hostAttestation === 'not_proven' &&
            value.sourceProjectionEnforced === 'not_proven' && value.rawStored === false &&
            value.projectCount === 1 && integer(value.discoveredThreadCount, 1, 20) &&
            integer(value.readThreadCount, 1, 20) && value.readThreadCount === value.discoveredThreadCount &&
            integer(value.omittedThreadCount, 0, 10000) && integer(value.completedTurnCount, 1, 10000) &&
            integer(value.userVisibleMessageCount, 1, 20000) &&
            value.userVisibleMessageCount <= value.completedTurnCount * 1000 &&
            integer(value.omittedItemCount, 0, 20000) && strictArray(value.limitationReasons) &&
            value.limitationReasons.length === LIMITATION_REASONS.length &&
            value.limitationReasons.every((reason, index) => reason === LIMITATION_REASONS[index]) &&
            (!includesCommitment || digest(value.candidateCommitment));
        }
        function sourceDisclosure(source) {
          const result = {};
          for (const key of SOURCE_KEYS) result[key] = source[key];
          return result;
        }
        function canonical(value) {
          if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
          if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
          if (strictArray(value)) return '[' + value.map(canonical).join(',') + ']';
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid canonical value');
          return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
        }
        async function fingerprint(domain, value) {
          if (!window.crypto || !window.crypto.subtle || typeof window.TextEncoder !== 'function') {
            throw new Error('secure digest unavailable');
          }
          const wire = canonical({ domain, implementation: 'combo-rfc8785-jcs/1', value });
          const bytes = new window.TextEncoder().encode(wire);
          const hashed = await window.crypto.subtle.digest('SHA-256', bytes);
          return 'sha256:' + Array.from(new Uint8Array(hashed), (unit) => unit.toString(16).padStart(2, '0')).join('');
        }
        async function normalize(raw) {
          if (!exactObject(raw, ['schemaVersion', 'draft', 'cardSnapshot', 'actions', 'confirmation']) ||
              raw.schemaVersion !== 'combo.agent-package-draft-card/1' ||
              !confirmationBoundaryValid(raw.confirmation)) return null;
          const draft = raw.draft;
          if (!exactObject(draft, ['protocol', 'draftId', 'revision', 'parentDraftFingerprint', 'creatorRequest', 'source', 'content', 'draftFingerprint']) ||
              draft.protocol !== 'combo.agent-package-draft/3' ||
              typeof draft.draftId !== 'string' || !/^draft\\.agent-package\\.[0-9a-f]{32}$/u.test(draft.draftId) ||
              draft.revision !== 1 || draft.parentDraftFingerprint !== null ||
              !digest(draft.draftFingerprint) ||
              !exactObject(draft.creatorRequest, ['protocol', 'intent', 'request']) ||
              draft.creatorRequest.protocol !== 'combo.agent-package-creator-request/3' ||
              draft.creatorRequest.intent !== 'create_agent_package_from_project_task_history' ||
              !safeText(draft.creatorRequest.request, 1, 2000) ||
              containsProjectHistoryCredential(draft.creatorRequest.request) ||
              containsProjectHistorySourceReference(draft.creatorRequest.request) ||
              !sourceValid(draft.source, true) ||
              !contentValid(draft.content)) return null;
          const evidence = sourceDisclosure(draft.source);
          const expectedCommitment = await fingerprint('combo.agent-package-draft/3:candidate-commitment', {
            creatorRequest: draft.creatorRequest, candidate: draft.content, sourceEvidence: evidence
          });
          if (draft.source.candidateCommitment !== expectedCommitment) return null;
          const expectedDraftFingerprint = await fingerprint('combo.agent-package-draft/3:fingerprint', {
            protocol: draft.protocol, draftId: draft.draftId, revision: draft.revision,
            parentDraftFingerprint: draft.parentDraftFingerprint, creatorRequest: draft.creatorRequest,
            source: draft.source, content: draft.content
          });
          if (draft.draftFingerprint !== expectedDraftFingerprint) return null;
          const card = raw.cardSnapshot;
          if (!exactObject(card, ['stage', 'title', 'summary', 'sourceDisclosure', 'shareDisclosure', 'content']) ||
              card.stage !== 'draft' || card.title !== draft.content.name || card.summary !== FIXED_SUMMARY ||
              !sourceValid(card.sourceDisclosure, false) || canonical(card.sourceDisclosure) !== canonical(evidence) ||
              !contentValid(card.content) || canonical(card.content) !== canonical(draft.content) ||
              !exactObject(card.shareDisclosure, ['access', 'revocation', 'expiry', 'marketplacePublication']) ||
              card.shareDisclosure.access !== 'public_by_link' || card.shareDisclosure.revocation !== 'not_supported' ||
              card.shareDisclosure.expiry !== 'none' || card.shareDisclosure.marketplacePublication !== false) return null;
          if (!strictArray(raw.actions) || raw.actions.length !== 1) return null;
          const candidateAction = raw.actions[0];
          if (!exactObject(candidateAction, ['id', 'label', 'message', 'emphasis']) ||
              candidateAction.id !== 'confirm_create_agent_package_share' ||
              candidateAction.label !== FIXED_ACTION_LABEL || candidateAction.message !== FIXED_ACTION_MESSAGE ||
              candidateAction.emphasis !== 'primary') return null;
          return { card, action: candidateAction };
        }
        async function render(raw) {
          if (!active || locked) return;
          const epoch = ++renderEpoch;
          let snapshot = null;
          let normalized = null;
          try { snapshot = detachStrictJson(raw); } catch { snapshot = null; }
          try { normalized = snapshot && await normalize(snapshot); } catch { normalized = null; }
          if (!active || locked || epoch !== renderEpoch) return;
          if (!normalized) {
            deactivate('草稿数据未通过完整性校验。为避免误创建，当前卡片已停用。');
            return;
          }
          const card = normalized.card;
          document.getElementById('title').textContent = text(card.title) || 'Agent Package Draft';
          document.getElementById('summary').textContent = text(card.summary);
          const content = document.getElementById('content'); clear(content);
          row(content, '名称', card.content.name); row(content, '说明', card.content.description);
          row(content, '运行指令', card.content.instructions); row(content, '输出', card.content.outputDescription);
          const starters = document.getElementById('starters'); clear(starters);
          for (const starter of Array.isArray(card.content.starterPrompts) ? card.content.starterPrompts : []) {
            const li = document.createElement('li'); li.textContent = text(starter); starters.appendChild(li);
          }
          const source = document.getElementById('source'); clear(source);
          const disclosure = card.sourceDisclosure && typeof card.sourceDisclosure === 'object' ? card.sourceDisclosure : {};
          row(source, '来源类型', disclosure.kind);
          row(source, '选择方式', disclosure.selection); row(source, '保证等级', disclosure.assurance);
          row(source, '完整性', disclosure.completeness); row(source, 'Host 认证', disclosure.hostAttestation);
          row(source, '投影执行', disclosure.sourceProjectionEnforced);
          row(source, '原始历史存储', String(disclosure.rawStored ?? ''));
          row(source, 'Project 数量', String(disclosure.projectCount ?? ''));
          row(source, '已选 eligible 任务', String(disclosure.discoveredThreadCount ?? ''));
          row(source, '已读任务', String(disclosure.readThreadCount ?? ''));
          row(source, '忽略任务', String(disclosure.omittedThreadCount ?? ''));
          row(source, '完成轮次', String(disclosure.completedTurnCount ?? ''));
          row(source, '用户可见消息', String(disclosure.userVisibleMessageCount ?? ''));
          row(source, '忽略条目', String(disclosure.omittedItemCount ?? ''));
          const limitations = document.getElementById('limitations'); clear(limitations);
          for (const reason of Array.isArray(disclosure.limitationReasons) ? disclosure.limitationReasons : []) {
            const li = document.createElement('li'); li.textContent = text(reason); limitations.appendChild(li);
          }
          action = normalized.action;
          const button = document.getElementById('confirm');
          button.textContent = action.label;
          syncActionButton();
        }
        function request(method, params) {
          const id = nextId++; window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
          return new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => { pending.delete(id); reject(new Error('Host request timed out.')); }, REQUEST_TIMEOUT_MS);
            pending.set(id, { resolve, reject, timeout });
          });
        }
        function notify(method, params = {}) {
          window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
        }
        function syncActionButton() {
          const button = document.getElementById('confirm');
          const bridgeAvailable = bridgeState === 'ready' || bridgeState === 'compatibility';
          const actionAvailable = active && action !== null && bridgeAvailable;
          button.hidden = !actionAvailable;
          button.disabled = locked || !actionAvailable;
        }
        function deactivate(message) {
          if (!active) return;
          active = false; locked = true; bridgeState = 'terminated'; action = null;
          lifecycleEpoch += 1; renderEpoch += 1;
          const waiters = [...pending.values()]; pending.clear();
          for (const waiter of waiters) {
            window.clearTimeout(waiter.timeout);
            waiter.reject(new Error('Draft App lifecycle ended.'));
          }
          const button = document.getElementById('confirm'); button.disabled = true; button.hidden = true;
          const status = document.getElementById('status'); status.hidden = false; status.textContent = message;
          const error = document.getElementById('error'); error.hidden = true; error.textContent = '';
        }
        async function confirm() {
          if (!active || locked || !action || !text(action.message) ||
              (bridgeState !== 'ready' && bridgeState !== 'compatibility')) return;
          const epoch = lifecycleEpoch;
          locked = true; document.getElementById('confirm').disabled = true;
          const status = document.getElementById('status'); status.hidden = false; status.textContent = '正在发送确认…';
          try {
            if (bridgeState === 'ready') {
              await request('ui/message', { role: 'user', content: [{ type: 'text', text: action.message }] });
            } else if (bridgeState === 'compatibility' && window.openai && typeof window.openai.sendFollowUpMessage === 'function') {
              await window.openai.sendFollowUpMessage({ prompt: action.message, scrollToBottom: true });
            } else {
              throw new Error('当前 Codex 宿主不支持卡片消息。');
            }
            if (!active || epoch !== lifecycleEpoch) return;
            status.textContent = '确认已发送，正在等待 Codex 继续。';
          } catch {
            if (!active || epoch !== lifecycleEpoch) return;
            status.textContent = '发送状态不确定。为避免重复创建，请不要再次点击并等待 Codex 回复。';
          }
        }
        document.getElementById('confirm').addEventListener('click', confirm);
        window.addEventListener('message', (event) => {
          if (event.source !== window.parent) return;
          const message = event.data; if (!message || message.jsonrpc !== '2.0') return;
          if (message.method === undefined && message.id !== undefined && pending.has(message.id)) {
            const waiter = pending.get(message.id); pending.delete(message.id); window.clearTimeout(waiter.timeout);
            if (message.error) waiter.reject(new Error(text(message.error.message))); else waiter.resolve(message.result || {});
            return;
          }
          if (message.method === 'ui/resource-teardown' && message.id !== undefined) {
            window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
            deactivate('卡片已关闭。当前卡片不会再发送任何确认。');
            return;
          }
          if (message.method === 'ui/notifications/tool-cancelled') {
            deactivate('草稿调用已取消。为避免误创建，当前卡片已停用。');
            return;
          }
          if (message.method === 'ui/notifications/tool-result') void render(message.params && message.params.structuredContent);
        }, { passive: true });
        const initial = window.openai && window.openai.toolOutput; if (initial) void render(initial);
        request('ui/initialize', { appInfo: { name: 'combo-project-history-agent-draft', version: '0.8.4' }, appCapabilities: { availableDisplayModes: ['inline'] }, protocolVersion: MCP_UI_PROTOCOL_VERSION })
          .then(() => { if (!active) return; bridgeState = 'ready'; syncActionButton(); notify('ui/notifications/initialized'); })
          .catch(() => {
            if (!active) return;
            if (initial && window.openai && typeof window.openai.sendFollowUpMessage === 'function') {
              bridgeState = 'compatibility';
              syncActionButton();
              return;
            }
            deactivate('无法初始化 Codex 卡片。为避免误创建，当前卡片已停用。');
          });
      })();
    </script>
  </body>
</html>`;

export const PROJECT_HISTORY_AGENT_MCP_RESOURCES = Object.freeze([
  PROJECT_HISTORY_AGENT_DRAFT_APP_RESOURCE,
]);

export function readProjectHistoryAgentMcpResource(uri: string) {
  if (uri !== PROJECT_HISTORY_AGENT_DRAFT_APP_URI) return null;
  return Object.freeze({
    contents: Object.freeze([
      Object.freeze({
        uri: PROJECT_HISTORY_AGENT_DRAFT_APP_URI,
        mimeType: PROJECT_HISTORY_AGENT_DRAFT_APP_RESOURCE.mimeType,
        text: PROJECT_HISTORY_AGENT_DRAFT_APP_HTML,
        _meta: Object.freeze({ ui: Object.freeze({ prefersBorder: true }) }),
      }),
    ]),
  });
}
