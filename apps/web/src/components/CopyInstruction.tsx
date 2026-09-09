import { useId, useState, type ReactElement } from 'react';
import { CopyButton } from './CopyButton.js';
import './copyInstruction.css';

interface CopyInstructionProps {
  text: string;
  label: string;
  copiedHint: string;
  className?: string;
}

function CopyInstructionState({
  text,
  label,
  copiedHint,
  className,
}: CopyInstructionProps): ReactElement {
  const [result, setResult] = useState<'idle' | 'copied' | 'failed'>('idle');
  const id = useId();
  return (
    <div className="cb-copy-instruction">
      <CopyButton
        text={text}
        label={label}
        ariaLabel={label}
        className={className}
        onCopyResult={(copied) => setResult(copied ? 'copied' : 'failed')}
      />
      {result === 'copied' && (
        <p className="cb-copy-instruction__feedback" role="status">
          {copiedHint}
        </p>
      )}
      {result === 'failed' && (
        <div className="cb-copy-instruction__fallback">
          <p role="alert" id={`${id}-help`}>
            未能复制。请选中下方完整文本，手动复制。
          </p>
          <textarea
            aria-label={`${label}的完整文本`}
            aria-describedby={`${id}-help`}
            value={text}
            readOnly
            rows={5}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}

/** 文本身份改变时清除上一份指令的反馈；不修改或自行重建待复制内容。 */
export function CopyInstruction(props: CopyInstructionProps): ReactElement {
  return <CopyInstructionState key={props.text} {...props} />;
}
