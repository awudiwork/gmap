/**
 * Wardogs 频道的专属接口。目前只有伤害计算器要的弹道数据。
 *
 * 数据是公开的游戏数值，但接口本身仍要登录：它代理了一个外部站点，
 * 不该成为任何人都能拿来当跳板的开放代理。
 */
import express from 'express'
import { wrap } from '../lib/errors.js'
import { requireUser } from '../middleware/auth.js'
import { getBallistics, getWeaponsMeta } from '../services/ballistics.service.js'

export const wardogsRouter = express.Router()

wardogsRouter.get('/ballistics', requireUser, wrap(async (_req, res) => {
  const [{ ballistics, source, fetchedAt }, weapons] = await Promise.all([getBallistics(), getWeaponsMeta()])
  res.setHeader('Cache-Control', 'private, max-age=600')
  res.json({ ok: true, source, fetchedAt, generatedAt: ballistics.generatedAt ?? null, ballistics, weapons })
}))
