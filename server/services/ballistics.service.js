/**
 * Wardogs 弹道数据源。
 *
 * 数据来自 metaforge.app 的公开接口，游戏每次更新数值它都会跟着改。
 * 这里做三层：内存缓存（按刷新周期过期）→ 上游接口 → 仓库里的快照。
 * 上游挂了或部署在没有外网的内网里，计算器照样能开，只是数值停在快照那一天。
 *
 * 武器图标和解锁等级另存一份快照：它们来自另一个体积很大的物品库接口，
 * 而且几乎不变，没必要每次跟着弹道数据一起拉。图标文件已经放在 public/wardogs/icons。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'

const UPSTREAM_URL = 'https://metaforge.app/api/wardogs/ballistics'
const UPSTREAM_TIMEOUT_MS = 12_000
/** 上游对不带浏览器标识的请求返回 403 */
const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Accept: 'application/json',
}

const SNAPSHOT_DIR = path.join(config.root, 'server', 'assets', 'wardogs')
const ICON_BASE = '/wardogs/icons'

/**
 * source：upstream 刚从上游拉到；stale 上游暂时拉不到、沿用之前拉到的；snapshot 仓库快照。
 * fetchedAt 是数据真正拿到的时刻，checkedAt 是上次尝试刷新的时刻，前端按 fetchedAt 提示新旧。
 * @type {{ ballistics: object, source: 'upstream' | 'stale' | 'snapshot', fetchedAt: number, checkedAt: number } | null}
 */
let cache = null
/** 同一时刻只让一个请求去拉上游，其余的等它 */
let inflight = null
/** 上游失败只提醒一次，不然每个刷新周期都刷一行日志 */
let warnedUpstream = false

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

async function readSnapshot() {
  const raw = await fs.readFile(path.join(SNAPSHOT_DIR, 'ballistics.json'), 'utf8')
  const data = JSON.parse(raw)
  if (!isBallisticsPayload(data)) throw new Error('弹道数据快照损坏')
  return data
}

async function fetchUpstream() {
  const response = await fetch(UPSTREAM_URL, {
    headers: UPSTREAM_HEADERS,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`)
  const data = await response.json()
  if (!isBallisticsPayload(data)) throw new Error('上游返回的数据缺少必要字段')
  return data
}

const refreshMs = () => config.ballisticsRefreshHours * 60 * 60 * 1000
/** 不联网时快照在进程生命周期内不会变，读过一次就一直用 */
const isFresh = () => cache !== null
  && (config.ballisticsRefreshHours === 0 || Date.now() - cache.checkedAt < refreshMs())

async function refresh() {
  const now = Date.now()
  // 刷新周期为 0 表示不联网，只用仓库里的快照。测试和内网部署走这条
  if (config.ballisticsRefreshHours > 0) {
    try {
      const ballistics = await fetchUpstream()
      cache = { ballistics, source: 'upstream', fetchedAt: now, checkedAt: now }
      warnedUpstream = false
      return cache
    } catch (err) {
      if (!warnedUpstream) {
        console.warn(`[ballistics] 拉取上游失败，改用本地数据：${err.message}`)
        warnedUpstream = true
      }
      // 之前拉到过就继续用旧的，比退回更老的快照强；标成 stale 且不动 fetchedAt，
      // 前端能如实说"上次更新是哪天"。往后推一个周期再试，不然上游一挂每个请求都要等它超时
      if (cache) {
        cache = { ...cache, source: 'stale', checkedAt: now }
        return cache
      }
    }
  }
  cache = { ballistics: await readSnapshot(), source: 'snapshot', fetchedAt: now, checkedAt: now }
  return cache
}

/**
 * 取当前的弹道数据。
 * @returns {Promise<{ ballistics: object, source: string, fetchedAt: number }>}
 */
export async function getBallistics() {
  if (isFresh()) return cache
  if (!inflight) {
    inflight = refresh().finally(() => { inflight = null })
  }
  return inflight
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
  cache = null
  inflight = null
  weaponsMeta = null
  warnedUpstream = false
}
