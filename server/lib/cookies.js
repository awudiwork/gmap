/**
 * 极简 Cookie 读写。
 *
 * 独立成模块的原因：HTTP 路由和 WebSocket 升级握手都要解析同一个会话 Cookie，
 * 而 WebSocket 阶段拿不到 Express 中间件链，必须能脱离 Express 复用。
 */

/** 解析 Cookie 请求头，返回 { name: value }；头不存在时返回空对象 */
export function parseCookies(header) {
  const jar = {}
  if (!header) return jar
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    try {
      jar[name] = decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      // 非法百分号编码：按原文保留，避免整串 Cookie 解析失败
      jar[name] = part.slice(index + 1).trim()
    }
  }
  return jar
}

/** 序列化为 Set-Cookie 头的值 */
export function serializeCookie(name, value, { maxAge, httpOnly = true, secure = false, sameSite = 'Lax', path = '/' } = {}) {
  const segments = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`]
  if (typeof maxAge === 'number') segments.push(`Max-Age=${Math.floor(maxAge / 1000)}`)
  if (httpOnly) segments.push('HttpOnly')
  if (secure) segments.push('Secure')
  return segments.join('; ')
}
