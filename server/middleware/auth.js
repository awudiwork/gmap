/**
 * 鉴权策略层：把"会话 Cookie"和"API Key"两种凭据统一成 req.auth。
 *
 * req.auth = { user, via: 'session' | 'apikey', keyId?: number }
 *
 * 两条凭据路径的差别只在这一层，下游服务拿到的都是同一个 user 对象，
 * 因此上传逻辑不需要关心请求来自网页还是截图客户端。
 */
import { parseCookies, serializeCookie } from '../lib/cookies.js'
import { config } from '../config.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { SESSION_COOKIE, resolveSession } from '../services/session.service.js'
import { resolveApiKey } from '../services/apikey.service.js'
import { findActiveUserById, toPublicUser } from '../services/user.service.js'

/**
 * 会话 → 用户。两步分开是为了让依赖方向保持单向：
 * 会话层只认 token，用户层只认用户，由这一层把两者接起来。
 * 已注销的账号在这里被挡掉，即便残留 token 也登不进来。
 */
function userFromCookie(cookies) {
  const session = resolveSession(cookies[SESSION_COOKIE])
  return session ? findActiveUserById(session.userId) : null
}

/** 从请求中取出明文 API Key：优先 Authorization: Bearer，其次 X-API-Key */
function readApiKey(req) {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  const alt = req.headers['x-api-key']
  return typeof alt === 'string' ? alt.trim() : null
}

/** 无论是否登录都放行，只负责把身份挂到 req 上 */
export function attachAuth(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie)
  const sessionUser = userFromCookie(req.cookies)
  if (sessionUser) {
    req.auth = { user: toPublicUser(sessionUser), via: 'session' }
  } else {
    req.auth = null
  }
  next()
}

/** 只允许网页会话（注册、Key 管理等面向人的操作） */
export function requireSession(req, _res, next) {
  if (!req.auth || req.auth.via !== 'session') {
    next(unauthorized('not_logged_in', '请先登录'))
    return
  }
  next()
}

/** 管理员专属操作（开号、看用户列表）。API Key 不具备管理员能力 */
export function requireAdmin(req, _res, next) {
  if (!req.auth || req.auth.via !== 'session') {
    next(unauthorized('not_logged_in', '请先登录'))
    return
  }
  if (!req.auth.user.isAdmin) {
    next(forbidden('not_admin', '只有管理员可以执行该操作'))
    return
  }
  next()
}

/**
 * 允许网页会话或有效 API Key（发消息、上传、取文件）。
 * 注意顺序：已登录的网页请求不再去查 Key，避免无谓的库查询与 last_used_at 抖动。
 */
export function requireUser(req, _res, next) {
  if (req.auth?.via === 'session') {
    next()
    return
  }
  const plain = readApiKey(req)
  if (!plain) {
    next(unauthorized('missing_credentials', '缺少登录会话或 API Key'))
    return
  }
  const resolved = resolveApiKey(plain)
  if (!resolved) {
    next(unauthorized('invalid_api_key', 'API Key 无效、已被删除，或所属账号已注销'))
    return
  }
  req.auth = { user: toPublicUser(resolved.user), via: 'apikey', keyId: resolved.keyId }
  next()
}

/** 供 WebSocket 升级握手复用：只认 Cookie，不接受 API Key（客户端不需要订阅） */
export function authenticateUpgrade(req) {
  const user = userFromCookie(parseCookies(req.headers.cookie))
  return user ? toPublicUser(user) : null
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, {
    maxAge: config.sessionTtlMs,
    secure: config.cookieSecure,
  }))
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    secure: config.cookieSecure,
  }))
}
