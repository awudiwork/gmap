/**
 * Wardogs 频道的专属接口：伤害计算器的弹道数据，情报面板的服务器状态、金条汇率、进度表。
 *
 * 数据是公开的游戏数值，但接口本身仍要登录：它们代理了外部站点，
 * 不该成为任何人都能拿来当跳板的开放代理。
 *
 * 实时数据（状态、汇率）拉不到时如实回 503 upstream_unavailable，不编数。
 */
import express from 'express'
import { AppError, wrap } from '../lib/errors.js'
import { requireUser } from '../middleware/auth.js'
import { getBallistics, getWeaponsMeta } from '../services/ballistics.service.js'
import { getMarket, getProgression, getServerStatus, listZoneServers } from '../services/intel.service.js'

export const wardogsRouter = express.Router()

wardogsRouter.use(requireUser)

/** 实时数据没有兜底，上游失败就是 503；其它错误照常 */
const live = (handler) => wrap(async (req, res) => {
  try {
    await handler(req, res)
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError(503, 'upstream_unavailable', '暂时拉不到 metaforge 的数据，稍后再试')
  }
})

wardogsRouter.get('/ballistics', wrap(async (_req, res) => {
  const [{ ballistics, source, fetchedAt }, weapons] = await Promise.all([getBallistics(), getWeaponsMeta()])
  res.setHeader('Cache-Control', 'private, max-age=600')
  res.json({ ok: true, source, fetchedAt, generatedAt: ballistics.generatedAt ?? null, ballistics, weapons })
}))

wardogsRouter.get('/status', live(async (_req, res) => {
  const { source, fetchedAt, summary } = await getServerStatus()
  res.setHeader('Cache-Control', 'private, max-age=30')
  res.json({ ok: true, source, fetchedAt, ...summary })
}))

wardogsRouter.get('/status/servers', live(async (req, res) => {
  const { source, fetchedAt, zone, servers } = await listZoneServers(req.query.zone)
  res.setHeader('Cache-Control', 'private, max-age=30')
  res.json({ ok: true, source, fetchedAt, zone, servers })
}))

wardogsRouter.get('/market', live(async (_req, res) => {
  const market = await getMarket()
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.json({ ok: true, ...market })
}))

wardogsRouter.get('/progression', wrap(async (_req, res) => {
  const { source, fetchedAt, progression } = await getProgression()
  res.setHeader('Cache-Control', 'private, max-age=3600')
  res.json({ ok: true, source, fetchedAt, ...progression })
}))
