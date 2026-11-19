import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { CircleCheck, CircleAlert, Info, X } from '../components/Icons'

const ToastContext = createContext(null)

const TONE = {
  success: { icon: CircleCheck, className: 'toast--ok' },
  error: { icon: CircleAlert, className: 'toast--error' },
  info: { icon: Info, className: 'toast--info' },
}

export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const seq = useRef(0)

  const dismiss = useCallback((id) => {
    setItems((list) => list.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback(
    (message, tone = 'success', duration = 3200) => {
      const id = ++seq.current
      setItems((list) => [...list, { id, message, tone }])
      if (duration) setTimeout(() => dismiss(id), duration)
      return id
    },
    [dismiss],
  )

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => {
          const meta = TONE[t.tone] || TONE.info
          const Icon = meta.icon
          return (
            <div key={t.id} className={`toast ${meta.className}`}>
              <Icon size={16} />
              <span>{t.message}</span>
              <button className="toast__close" onClick={() => dismiss(t.id)} aria-label="关闭">
                <X size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast 必须在 ToastProvider 内使用')
  return ctx
}
