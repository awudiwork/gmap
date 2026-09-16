/**
 * 账号相关接口：注册、登录、登出、当前身份。
 */
import crypto from 'node:crypto'
import express from 'express'
import { config } from '../config.js'
import { badRequest, forbidden, tooMany, wrap } from '../lib/errors.js'
import { createRateLimiter } from '../lib/ratelimit.js'
import {
  changeOwnPassword,
  createUser,
  findUserById,
  toPublicUser,
  updateDisplayNameOf,
  verifyCredentials,
} from '../services/user.service.js'
import { createSession, destroySession, SESSION_COOKIE } from '../services/session.service.js'
import { clearSessionCookie, requireSession, setSessionCookie } from '../middleware/auth.js'

export const authRouter = express.Router()

/** 登录/注册按来源 IP 限流，挡住在线密码爆破 */
const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 10 })

/** 定长比较，避免邀请码被逐字符试探 */
function codeMatches(expected, actual) {
  const a = Buffer.from(String(expected))
  const b = Buffer.from(String(actual ?? ''))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function guardRate(req) {
  const { allowed, retryAfterMs } = loginLimiter.consume(req.ip ?? 'unknown')
  if (!allowed) {
    throw tooMany('too_many_attempts', `尝试过于频繁，请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试`)
  }
}

/**
 * 登录页用它决定是否显示注册入口，并把运行参数印在铭牌上。
 * 这里只暴露公开的策略信息，不含任何凭据或路径。
 */
authRouter.get('/config', (_req, res) => {
  res.json({
    ok: true,
    allowRegistration: config.allowRegistration,
    requiresCode: config.registrationCode !== '',
    fileRetentionHours: config.fileRetentionHours,
    maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
  })
})

authRouter.get('/me', (req, res) => {
  res.json({ ok: true, user: req.auth?.via === 'session' ? req.auth.user : null })
})

authRouter.post('/register', wrap(async (req, res) => {
  guardRate(req)
  if (!config.allowRegistration) {
    throw forbidden('registration_closed', '本站未开放自助注册')
  }
  if (config.registrationCode && !codeMatches(config.registrationCode, req.body?.code)) {
    throw forbidden('invalid_registration_code', '邀请码不正确')
  }

  // 管理员身份只由 .env 的 ADMIN_USERNAME 决定，自助注册一律产出普通用户
  const user = await createUser({
    username: req.body?.username,
    password: req.body?.password,
    displayName: req.body?.displayName,
    isAdmin: false,
  })

  const { token } = createSession(user.id)
  setSessionCookie(res, token)
  res.status(201).json({ ok: true, user: toPublicUser(user) })
}))

authRouter.post('/login', wrap(async (req, res) => {
  guardRate(req)
  const user = await verifyCredentials(req.body?.username, req.body?.password)
  const { token } = createSession(user.id)
  setSessionCookie(res, token)
  loginLimiter.reset(req.ip ?? 'unknown')
  res.json({ ok: true, user: toPublicUser(user) })
}))

/**
 * 改自己的昵称和密码。两者可以分别提交，也可以一次提交。
 *
 * 改密码会吊销该用户的全部会话（含当前这个），所以这里立刻补发一个新会话，
 * 效果是"其它设备被踢下线，本设备继续用"。
 */
authRouter.patch('/me', requireSession, wrap(async (req, res) => {
  const { id } = req.auth.user
  const { displayName, currentPassword, newPassword } = req.body ?? {}

  if (displayName !== undefined) {
    updateDisplayNameOf(id, displayName)
  }

  if (newPassword !== undefined || currentPassword !== undefined) {
    if (!newPassword || !currentPassword) {
      throw badRequest('password_pair_required', '修改密码需要同时提供当前密码和新密码')
    }
    await changeOwnPassword(id, currentPassword, newPassword)
    const { token } = createSession(id)
    setSessionCookie(res, token)
  }

  res.json({ ok: true, user: toPublicUser(findUserById(id)) })
}))

authRouter.post('/logout', requireSession, (req, res) => {
  destroySession(req.cookies?.[SESSION_COOKIE])
  clearSessionCookie(res)
  res.json({ ok: true })
})
