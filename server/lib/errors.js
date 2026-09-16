/**
 * 统一错误语义。
 *
 * 契约：业务代码只抛 AppError；未被识别的异常一律按 500 处理且不向客户端泄露细节。
 * 每个 AppError 带有稳定的 code 字段，前端与外部客户端按 code 判断，不依赖文案。
 */
export class AppError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
  }
}

export const badRequest = (code, message) => new AppError(400, code, message)
export const unauthorized = (code, message) => new AppError(401, code, message)
export const forbidden = (code, message) => new AppError(403, code, message)
export const notFound = (code, message) => new AppError(404, code, message)
export const conflict = (code, message) => new AppError(409, code, message)
export const tooLarge = (code, message) => new AppError(413, code, message)
export const tooMany = (code, message) => new AppError(429, code, message)

/** Express 错误处理中间件（必须挂在所有路由之后） */
export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    res.status(err.status).json({ ok: false, code: err.code, message: err.message })
    return
  }
  // multer 的体积超限错误映射为 413，其余未知异常统一 500
  if (err?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ ok: false, code: 'file_too_large', message: '文件超过服务端允许的大小上限' })
    return
  }
  console.error('[unhandled]', err)
  res.status(500).json({ ok: false, code: 'internal_error', message: '服务器内部错误' })
}

/** 包装 async 路由处理器，让抛出的异常进入 errorHandler */
export const wrap = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next)
}
