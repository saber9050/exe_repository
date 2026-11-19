import { useEffect, useState } from 'react'
import { Loader, X } from './Icons'

/**
 * 通用确认弹窗。
 *
 * 传 `verifyText` 时升级为「打字确认」：必须原样输入该文本，确认按钮才解禁。
 * 用于删除这类不可恢复的动作——按钮点错容易，逐字敲一遍包名不容易。
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  tone = 'danger',
  busy = false,
  verifyText = '',
  verifyLabel = '',
  verifyPlaceholder = '粘贴或逐字输入上方内容，需完全一致',
  verifyHint = '区分大小写，一个字符都不能差；可从上文直接复制',
  onConfirm,
  onCancel,
}) {
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (open) setTyped('')
  }, [open, verifyText])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null

  const mismatch = Boolean(verifyText) && typed.trim() !== verifyText

  return (
    <div className="dialog-mask" onMouseDown={() => !busy && onCancel?.()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog__head">
          <h3 id="dialog-title">{title}</h3>
          <button className="icon-btn" onClick={onCancel} disabled={busy} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        {description && <div className="dialog__body">{description}</div>}

        {verifyText && (
          <div className="dialog__verify">
            <label className="field__label" htmlFor="dialog-verify">
              {verifyLabel || `输入 ${verifyText} 以继续`}
            </label>
            <input
              id="dialog-verify"
              className={`input mono ${typed && mismatch ? 'input--error' : ''}`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={verifyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              autoFocus
            />
            {!typed && <span className="field__hint">{verifyHint}</span>}
            {typed && mismatch && (
              <span className="field__hint field__hint--error">
                内容不一致，应为 <code>{verifyText}</code>
              </span>
            )}
            {typed && !mismatch && (
              <span className="field__hint field__hint--ok">内容一致，确认按钮已解禁</span>
            )}
          </div>
        )}

        <div className="dialog__foot">
          <button className="btn btn--secondary btn--sm" onClick={onCancel} disabled={busy}>
            {cancelText}
          </button>
          <button
            className={`btn btn--sm ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={busy || mismatch}
          >
            {busy && <Loader size={13} className="spin" />}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
