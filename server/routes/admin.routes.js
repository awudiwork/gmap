/**
 * 管理员接口：查看用户、开号、重置密码、注销账号。
 *
 * 自助注册默认关闭，账号一律由管理员在这里创建；
 * 创建后把用户名和密码线下告诉对方，对方登录后自行改密码、生成上传 Key。
 */
import express from 'express'
import { badRequest, wrap } from '../lib/errors.js'
import { requireAdmin } from '../middleware/auth.js'
import {
  createUser,
  deleteUser,
  listUsers,
  resetPasswordByAdmin,
  toPublicUser,
} from '../services/user.service.js'

export const adminRouter = express.Router()

adminRouter.use(requireAdmin)

/** 路径参数里的用户 id */
function targetId(req) {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest('invalid_id', '用户 id 非法')
  }
  return id
}

adminRouter.get('/users', (_req, res) => {
  res.json({ ok: true, users: listUsers() })
})

adminRouter.post('/users', wrap(async (req, res) => {
  const user = await createUser({
    username: req.body?.username,
    password: req.body?.password,
    displayName: req.body?.displayName,
    // 管理员身份只能由 .env 指定，接口不开放提权，避免多个来源都能造管理员
    isAdmin: false,
  })
  res.status(201).json({ ok: true, user: toPublicUser(user) })
}))

/** 重置他人密码。目标用户的会话会被全部吊销，必须用新密码重新登录 */
adminRouter.patch('/users/:id/password', wrap(async (req, res) => {
  const user = await resetPasswordByAdmin(targetId(req), req.body?.password)
  res.json({ ok: true, user: toPublicUser(user) })
}))

/** 注销账号：吊销凭据但保留聊天记录，详见 user.service.deleteUser */
adminRouter.delete('/users/:id', wrap(async (req, res) => {
  const removed = deleteUser(req.auth.user.id, targetId(req))
  res.json({ ok: true, user: removed })
}))
