// 普通试用的开场表单：按能力定义收取一次真实任务输入。
// Studio 从左侧持续对话直接开始，不在画布里再造第二套输入表单。
import { useState } from 'react';
import type { CapabilityInputField, SessionDetail } from '@cb/shared';

type TrialCapability = SessionDetail['capability'];

function buildPrompt(
  fields: CapabilityInputField[],
  values: Record<string, string>,
  extra: string,
): string {
  const lines = fields
    .map((f) => {
      const value = values[f.key]?.trim() ?? '';
      return value ? `${f.label}：${value}` : null;
    })
    .filter(Boolean);
  if (extra.trim()) lines.push(fields.length > 0 ? `补充要求：${extra.trim()}` : extra.trim());
  return `请基于这些输入生成第一版产物。\n\n${lines.join('\n')}`;
}

export function TrialIntakeForm({
  capability,
  disabled,
  onSubmit,
  preview = false,
}: {
  capability: TrialCapability;
  disabled: boolean;
  onSubmit: (prompt: string) => void;
  /** Studio 无自定义 UI 时，按消费者真实默认页做只读预览。 */
  preview?: boolean;
}) {
  const fields = capability.inputs;
  const [values, setValues] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState('');

  const setField = (key: string, value: string) => setValues((s) => ({ ...s, [key]: value }));
  const requiredMissing = fields.some((f) => f.required && !(values[f.key]?.trim() ?? ''));
  const allEmpty = !extra.trim() && fields.every((f) => !(values[f.key]?.trim() ?? ''));
  const controlsDisabled = disabled || preview;

  return (
    <section
      className={`rt-intake${preview ? ' rt-intake--preview' : ''}`}
      aria-label={preview ? '系统默认页面预览' : '本次试用输入'}
    >
      <div className="rt-intake__head">
        <h2>开始生成 · {capability.name}</h2>
        <p>{capability.summary || '补充这次使用需要的上下文，按这个能力生成第一版产物。'}</p>
      </div>
      <div className="rt-intake__fields">
        {fields.map((field) => (
          <label
            key={field.key}
            className={`rt-field${field.type === 'text' ? ' rt-field--wide' : ''}`}
          >
            <span className="rt-field__label">
              {field.label}
              {field.required && <span className="rt-field__req">*</span>}
            </span>
            {field.type === 'text' ? (
              <textarea
                className="rt-field__control"
                rows={3}
                value={values[field.key] ?? ''}
                disabled={controlsDisabled}
                onChange={(event) => setField(field.key, event.target.value)}
              />
            ) : field.type === 'enum' ? (
              <select
                className="rt-field__control"
                value={values[field.key] ?? ''}
                disabled={controlsDisabled}
                onChange={(event) => setField(field.key, event.target.value)}
              >
                <option value="">请选择…</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="rt-field__control"
                type={field.type === 'number' ? 'number' : 'text'}
                value={values[field.key] ?? ''}
                disabled={controlsDisabled}
                onChange={(event) => setField(field.key, event.target.value)}
              />
            )}
          </label>
        ))}
        <label className="rt-field rt-field--wide">
          <span className="rt-field__label">{fields.length > 0 ? '补充要求' : '想要什么'}</span>
          <textarea
            className="rt-field__control"
            rows={3}
            placeholder="用一两句话描述这次想得到的产出…"
            value={extra}
            disabled={controlsDisabled}
            onChange={(event) => setExtra(event.target.value)}
          />
        </label>
      </div>
      {capability.starterPrompts.length > 0 && (
        <div className="rt-starters">
          <div className="rt-starters__label">或从一个开头开始</div>
          <div className="rt-starters__row">
            {capability.starterPrompts.slice(0, 3).map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="rt-starter"
                disabled={controlsDisabled}
                onClick={() => setExtra(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        className="rt-btn rt-btn--accent rt-intake__start"
        disabled={controlsDisabled || requiredMissing || allEmpty}
        onClick={() => {
          if (!preview) onSubmit(buildPrompt(fields, values, extra));
        }}
      >
        {preview ? '开始生成 →' : disabled ? '正在生成…' : '开始生成 →'}
      </button>
    </section>
  );
}
