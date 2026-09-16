/**
 * 网页端会话：随机 token 写 Cookie，库里只存 token 的 SHA-256。
 *
 * 选型说明：不用 JWT 是因为本场景需要"能立即吊销"（改密码、退出登录），
 * 有状态会话在单机 SQLite 上成本极低且语义更简单。
 */
import crypto from 'node:crypto'
import { db } from '../db.js'
import { config } from '../config.js'

export const SESSION_COOKIE = 'gmap_session'

const insertSession = db.prepare(`
  INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`)
const selectSession = db.prepare('SELECT * FROM sessions WHERE token_hash = ?')
const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?')
const deleteExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
const deleteByUser = db.prepare('DELETE FROM sessions WHERE user_id = ?')

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

/** 为用户签发新会话，返回明文 token（只在此刻存在，之后无法从库里还原） */
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const now = Date.now()
  insertSession.run(sha256(token), userId, now, now + config.sessionTtlMs)
  return { token, expiresAt: now + config.sessionTtlMs }
}

/**
 * 用 token 换取会话。
 *
 * 只返回 userId 而不是用户记录：这样会话层不需要认识用户表，
 * 依赖方向保持单向（用户层可以反过来吊销会话，不构成循环）。
 *
 * @returns {{ userId: number, expiresAt: number } | null} token 缺失、无效或已过期时返回 null
 */
export function resolveSession(token) {
  if (!token || typeof token !== 'string') return null
  const hash = sha256(token)
  const row = selectSession.get(hash)
  if (!row) return null
  if (row.expires_at <= Date.now()) {
    deleteSession.run(hash)
    return null
  }
  return { userId: row.user_id, expiresAt: row.expires_at }
}

export function destroySession(token) {
  if (!token) return
  deleteSession.run(sha256(token))
}

/** 吊销某人的全部会话：改密码、被重置密码、被删号时调用 */
export function destroyUserSessions(userId) {
  return deleteByUser.run(userId).changes
}

/** 由清理任务周期调用 */
export function purgeExpiredSessions() {
  return deleteExpired.run(Date.now()).changes
}
