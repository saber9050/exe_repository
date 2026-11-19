import { Component } from 'react'

/**
 * 兜底错误边界。
 *
 * React 18 里渲染期抛错会卸载整棵树，页面就剩一片白。这里接住异常，
 * 至少把「哪个页面出错、错误信息是什么」显示出来，并给出重载入口。
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // 控制台留痕，方便在预览面板里直接看到
    console.error('[dsh-market] 渲染失败', error, info?.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="container" style={{ padding: '72px 0', maxWidth: 720 }}>
        <h1 style={{ fontSize: 20, letterSpacing: '-0.01em' }}>这个页面没能渲染出来</h1>
        <p style={{ marginTop: 10, fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.72 }}>
          界面遇到了未预期的错误，下面的信息可以直接贴给维护者。已登记的资产不受影响。
        </p>
        <pre
          className="mono"
          style={{
            marginTop: 16,
            padding: '12px 14px',
            background: '#f7f8fa',
            border: '1px solid var(--line)',
            borderRadius: 10,
            fontSize: 11.5,
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 240,
            overflow: 'auto',
          }}
        >
          {String(error && (error.stack || error.message || error))}
        </pre>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn btn--primary btn--sm" onClick={() => window.location.reload()}>
            重新加载
          </button>
          <a className="btn btn--secondary btn--sm" href="/">
            回资产列表
          </a>
        </div>
      </div>
    )
  }
}
