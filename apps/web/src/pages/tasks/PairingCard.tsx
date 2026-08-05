// 建任务成功后的配对引导卡：配对码明文只在这里出现一次（库里只存哈希），提示用户复制；
// 附本机助手一条命令（GET /connect/script?code=<配对码> 下发脚本，`| sh` 直跑）。
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { CreateTaskResult, TaskView } from '@cb/shared';
import { connectCommand } from '../../api/index.js';
import { CopyButton } from '../../components/CopyButton.js';
import { formatTime } from './taskPresent.js';

export interface PairingCardProps {
  created: CreateTaskResult;
  /** 新建后轮询到的实时任务；用于等待反馈，第一片落地后由父页自动进详情。 */
  liveTask?: TaskView;
  /** 本拍查询失败时的非阻断提示；watcher 会继续自动重试。 */
  progressUnavailable?: boolean;
  /** 是否已把明文命令暂存在当前标签页，供任务详情刷新后恢复。 */
  receiptSaved?: boolean;
  onDismiss: () => void;
}

/** 配对等待区的人话反馈（纯函数，便于状态回归测试）。 */
export function pairingProgressLabel(task: TaskView, progressUnavailable = false): string {
  if (task.status === 'failed') return '任务已停止，正在打开详情…';
  if (task.currentStep === 'extract' || task.upload.status !== 'pending') {
    return '上传完成，正在进入提取…';
  }
  if (task.upload.partsLanded > 0) {
    const total = task.upload.partsExpected;
    return total === null
      ? `已接收 ${task.upload.partsLanded} 片，正在打开进度页…`
      : `已接收 ${task.upload.partsLanded} / ${total} 片，正在打开进度页…`;
  }
  if (progressUnavailable) return '暂时没拿到上传进度，正在自动重试…';
  return '等待本机助手连接，上传开始后会自动打开进度页。';
}

export function PairingCard({
  created,
  liveTask = created.task,
  progressUnavailable = false,
  receiptSaved = false,
  onDismiss,
}: PairingCardProps): ReactElement {
  const command = connectCommand(created.pairingCode);
  return (
    <section className="cb-pairing" aria-labelledby="cb-pairing-title">
      <div className="cb-pairing__header">
        <div>
          <p className="cb-pairing__eyebrow">任务已创建</p>
          <h3 className="cb-pairing__title" id="cb-pairing-title">
            复制命令，在终端运行
          </h3>
          <p className="cb-pairing__summary">助手会连接这个任务，上传进度会在下方队列实时更新。</p>
        </div>
        <Link className="cb-pairing__detail" to={`/tasks/${created.task.id}`}>
          查看进度
        </Link>
      </div>

      <div className="cb-pairing__code-row">
        <span className="cb-pairing__label">配对码</span>
        <code className="cb-pairing__code">{created.pairingCode}</code>
        <CopyButton text={created.pairingCode} label="复制" />
        <span className="cb-pairing__note">
          云端仅下发一次；当前标签页可暂存至 {formatTime(created.task.upload.pairingExpiresAt)}
        </span>
      </div>

      <div className="cb-cmdbox" aria-label="本机助手连接命令">
        <div className="cb-cmdbox__head">
          <span className="cb-pairing__label">终端命令</span>
          <span className="cb-cmdbox__hint">复制整行后粘贴运行</span>
        </div>
        <div className="cb-cmdbox__command">
          <code className="cb-cmdbox__command-text">{command}</code>
          <CopyButton text={command} label="复制命令" className="cb-cmdbox__copy" />
        </div>
      </div>

      <div className="cb-pairing__actions">
        <div>
          <p className="cb-pairing__phase" role="status" aria-live="polite">
            {pairingProgressLabel(liveTask, progressUnavailable)}
          </p>
          <p className="cb-pairing__note">命令中断后重跑同一条即可续传。</p>
          <p className="cb-pairing__note">
            {receiptSaved
              ? '当前标签页已临时保存这条命令；刷新后可从任务详情继续。'
              : '当前浏览器未能临时保存命令，请先运行或安全保存。'}
          </p>
        </div>
        <button type="button" className="cb-pairing__dismiss" onClick={onDismiss}>
          {receiptSaved ? '已保存命令，收起' : '确认已复制，收起'}
        </button>
      </div>

      <details className="cb-pairing__details">
        <summary>这条命令会读取什么？</summary>
        <p>
          它会读取本机的对话历史（~/.claude 与
          ~/.codex）并上传到云端；云端会在提取前抹掉手机号、密钥等隐私信息。
        </p>
      </details>
    </section>
  );
}
