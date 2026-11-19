/**
 * 带 HTTP 状态码的业务错误。
 *
 * 原来挂在插件库的 store.js 上，依赖库借用了同一个类。依赖库独立成服务之后
 * 不能再把整个插件库仓储拖进来，所以拆成独立模块 —— 两个库的报错语义本来就一样：
 * status 决定响应码，extra 原样铺进 JSON。
 */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.extra = extra
  }
}
