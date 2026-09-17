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

/**
 * multer 的错误码 → 本站语义。这些全是客户端把请求发错了，不是服务器故障，
 * 不能落到 500 让客户端当成"服务挂了"去重试。
 */
const MULTER_ERRORS = {
  LIMIT_FILE_SIZE: [413, 'file_too_large', '文件超过服务端允许的大小上限'],
  LIMIT_UNEXPECTED_FILE: [400, 'missing_file', '请以 multipart/form-data 提交名为 file 的字段'],
  LIMIT_FILE_COUNT: [400, 'too_many_files', '一次只能上传一个文件'],
  LIMIT_PART_COUNT: [400, 'invalid_multipart', 'multipart 表单的字段太多'],
  LIMIT_FIELD_COUNT: [400, 'invalid_multipart', 'multipart 表单的字段太多'],
  LIMIT_FIELD_KEY: [400, 'invalid_multipart', 'multipart 表单的字段名太长'],
  LIMIT_FIELD_VALUE: [400, 'invalid_multipart', 'multipart 表单的字段值太长'],
}

/** body-parser（express.json）的错误 type → 本站语义 */
const BODY_ERRORS = {
  'entity.parse.failed': [400, 'invalid_json', '请求体不是合法的 JSON'],
  'entity.too.large': [413, 'body_too_large', '请求体太大'],
  'encoding.unsupported': [415, 'invalid_body', '不支持的请求体编码'],
  'charset.unsupported': [415, 'invalid_body', '不支持的请求体字符集'],
  'entity.verify.failed': [400, 'invalid_body', '请求体校验失败'],
  'request.aborted': [400, 'invalid_body', '请求体未接收完整'],
}

/** Express 错误处理中间件（必须挂在所有路由之后） */
export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    res.status(err.status).json({ ok: false, code: err.code, message: err.message })
    return
  }
  const mapped = (err?.name === 'MulterError' && MULTER_ERRORS[err.code])
    || (typeof err?.type === 'string' && BODY_ERRORS[err.type])
  if (mapped) {
    const [status, code, message] = mapped
    res.status(status).json({ ok: false, code, message })
    return
  }
  // 其余带 4xx 状态的框架错误按原状态返回，只有真正未知的才算 500
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ ok: false, code: 'bad_request', message: '请求不合法' })
    return
  }
  console.error('[unhandled]', err)
  res.status(500).json({ ok: false, code: 'internal_error', message: '服务器内部错误' })
}

/** 包装 async 路由处理器，让抛出的异常进入 errorHandler */
export const wrap = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next)
}
