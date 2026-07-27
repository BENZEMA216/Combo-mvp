// 复制按钮：写剪贴板 + 短暂「已复制」反馈（配对码 / 连接命令 / 分享令牌共用）。
import { useEffect, useRef, useState, type ReactElement } from 'react';

export interface CopyButtonProps {
  /** 要复制的文本。 */
  text: string;
  /** 按钮文案（默认「复制」）。 */
  label?: string;
  /** 可把简短视觉文案补成带对象语境的无障碍名称。 */
  ariaLabel?: string;
  className?: string;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({
  text,
  label = '复制',
  ariaLabel,
  className,
}: CopyButtonProps): ReactElement {
  const [feedback, setFeedback] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleClick = async (): Promise<void> => {
    const ok = await copyText(text);
    setFeedback(ok ? '已复制' : '复制失败，请手动选中复制');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setFeedback(null), 2000);
  };

  return (
    <button
      type="button"
      className={className ? `cb-copy ${className}` : 'cb-copy'}
      aria-label={ariaLabel}
      onClick={() => void handleClick()}
    >
      {feedback ?? label}
    </button>
  );
}
