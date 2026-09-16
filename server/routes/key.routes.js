/**
 * API Key 管理：只面向已登录用户，管理自己名下的 Key。
 * 明文 Key 仅在创建响应里出现一次，此后任何接口都拿不回来。
 */
import express from 'express'
import { badRequest, wrap } from '../lib/errors.js'
import { createApiKey, deleteApiKey, listApiKeys } from '../services/apikey.service.js'
import { requireSession } from '../middleware/auth.js'

export const keyRouter = express.Router()

keyRouter.use(requireSession)

keyRouter.get('/', (req, res) => {
  res.json({ ok: true, keys: listApiKeys(req.auth.user.id) })
})

keyRouter.post('/', wrap(async (req, res) => {
  const { key, plain } = createApiKey(req.auth.user.id, req.body?.name)
  res.status(201).json({ ok: true, key, plain })
}))

keyRouter.delete('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest('invalid_id', 'Key id 非法')
  }
  res.json({ ok: true, key: deleteApiKey(req.auth.user.id, id) })
}))
