/**
 * Wardogs 弹道数据源。
 *
 * 数据来自 metaforge.app 的公开接口，游戏每次更新数值它都会跟着改。
 * 缓存与兜底的机制在 lib/upstream.js；这里只定义"这份数据长什么样才算合法"。
 *
 * 武器图标和解锁等级另存一份快照：它们来自另一个体积很大的物品库接口，
 * 而且几乎不变，没必要每次跟着弹道数据一起拉。图标文件已经放在 public/wardogs/icons。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { createUpstreamCache } from '../lib/upstream.js'

export const SNAPSHOT_DIR = path.join(config.root, 'server', 'assets', 'wardogs')
const ICON_BASE = '/wardogs/icons'

/** 刷新周期为 0 表示不联网，只用仓库里的快照。测试和内网部署走这条 */
export const isOffline = () => config.ballisticsRefreshHours === 0

/**
 * 上游偶尔会改字段。这里只认引擎真正依赖的骨架，缺一项就当作坏数据丢掉，
 * 宁可退回快照也不把半份数据发给前端让它算出 NaN。
 */
export function isBallisticsPayload(data) {
  return data !== null && typeof data === 'object'
    && Number.isFinite(data.assumedHealth)
    && Array.isArray(data.hitLocations) && data.hitLocations.length > 0
    && Array.isArray(data.rounds) && data.rounds.length > 0
    && Array.isArray(data.armour)
    && Array.isArray(data.weapons) && data.weapons.length > 0
    && data.hitboxes !== null && typeof data.hitboxes === 'object'
    && data.calibres !== null && typeof data.calibres === 'object'
    && data.dragCurves !== null && typeof data.dragCurves === 'object'
}

const ballisticsCache = createUpstreamCache({
  name: 'ballistics',
  url: 'https://metaforge.app/api/wardogs/ballistics',
  ttlMs: config.ballisticsRefreshHours * 60 * 60 * 1000,
  validate: isBallisticsPayload,
  snapshotPath: path.join(SNAPSHOT_DIR, 'ballistics.json'),
  offline: isOffline,
})

/**
 * 取当前的弹道数据。
 * @returns {Promise<{ ballistics: object, source: string, fetchedAt: number }>}
 */
export async function getBallistics() {
  const { data, source, fetchedAt } = await ballisticsCache.get()
  return { ballistics: data, source, fetchedAt }
}

let weaponsMeta = null

/**
 * 武器附加信息：站内图标路径与解锁等级。快照里没有的武器（上游新加的）
 * 拿不到图标，前端会留空位，不影响计算。
 * @returns {Promise<Record<string, { icon: string | null, unlock: number }>>}
 */
export async function getWeaponsMeta() {
  if (weaponsMeta) return weaponsMeta
  const raw = await fs.readFile(path.join(SNAPSHOT_DIR, 'weapons.json'), 'utf8')
  const parsed = JSON.parse(raw)
  const result = {}
  for (const [slug, entry] of Object.entries(parsed)) {
    result[slug] = {
      icon: entry.icon ? `${ICON_BASE}/${entry.icon}.webp` : null,
      unlock: Number.isFinite(entry.unlock) ? entry.unlock : 0,
    }
  }
  weaponsMeta = result
  return result
}

/** 只给测试用：清掉内存缓存，好验证"上游关掉时走快照"这类分支 */
export function resetBallisticsCache() {
  ballisticsCache.reset()
  weaponsMeta = null
}
