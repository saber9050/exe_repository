import { useState } from 'react'
import { Check, Copy } from './Icons'
import { copyText } from '../utils/hash'

export default function CopyButton({ value, label = '复制', className = 'copy-btn', size = 13, onCopied }) {
  const [done, setDone] = useState(false)

  const handle = async () => {
    const ok = await copyText(value)
    if (!ok) return
    setDone(true)
    onCopied?.()
    setTimeout(() => setDone(false), 1600)
  }

  return (
    <button
      type="button"
      className={`${className} ${done ? 'is-done' : ''}`}
      onClick={handle}
      title={done ? '已复制' : label}
      aria-label={label}
    >
      {done ? <Check size={size} /> : <Copy size={size} />}
      {label && <span>{done ? '已复制' : label}</span>}
    </button>
  )
}
