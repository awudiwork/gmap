/**
 * 同源写操作校验（CSRF 兜底）。
 *
 * 会话 Cookie 已经是 SameSite=Lax，跨站发起的写请求本就带不上 Cookie；
 * 这里再按 Origin/Referer 拒一次，覆盖浏览器策略之外的边角情况。
 *
 * 只对 Cookie 会话生效：API Key 来自截图客户端，本来就没有 Origin 头，
 * 且凭据不会被浏览器自动附带，不存在 CSRF 面。
 */
import { forbidden } from '../lib/errors.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function verifyOrigin(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) {
    next()
    return
  }
  if (req.auth?.via !== 'session') {
    next()
    return
  }
  const raw = req.headers.origin ?? req.headers.referer
  if (!raw) {
    // 同源的 fetch 一定带 Origin；没有则说明不是本站页面发出的请求
    next(forbidden('missing_origin', '缺少 Origin 头，请求被拒绝'))
    return
  }
  let host
  try {
    host = new URL(raw).host
  } catch {
    next(forbidden('bad_origin', 'Origin 头格式非法'))
    return
  }
  if (host !== req.headers.host) {
    next(forbidden('cross_origin', '不允许跨站写操作'))
    return
  }
  next()
}
