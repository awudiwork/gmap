/**
 * Wardogs 情报面板的数据源：服务器状态、金条汇率、进度 XP 表。
 *
 * 三份都来自 metaforge.app 的公开接口，服务器状态另加 Steam 在线人数。
 * 服务器状态的原始数据是 2 MB 的全量服务器清单，这里在服务端压成
 * 几 KB 的汇总再发给页面；要看某个区的清单时再按区取。
 *
 * 状态和汇率是实时数据，没有快照：拉不到就如实报 503，不编数。
 * 进度表几乎不变，有快照兜底。
 */
import path from 'node:path'
import { badRequest } from '../lib/errors.js'
import { createUpstreamCache } from '../lib/upstream.js'
import { isOffline, SNAPSHOT_DIR } from './ballistics.service.js'

const STEAM_APP_ID = 1867240

/* ── 服务器状态 ───────────────────────────────────────── */

const isStatusPayload = (data) => data !== null && typeof data === 'object'
  && Array.isArray(data.servers) && Array.isArray(data.regions)
  && data.totals !== null && typeof data.totals === 'object'

const statusCache = createUpstreamCache({
  name: 'server-status',
  url: 'https://metaforge.app/api/wardogs/server-status',
  ttlMs: 60_000,
  validate: isStatusPayload,
  offline: isOffline,
  timeoutMs: 20_000,
})

const steamCache = createUpstreamCache({
  name: 'steam-players',
  url: `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${STEAM_APP_ID}`,
  ttlMs: 60_000,
  validate: (data) => Number.isInteger(data?.response?.player_count),
  offline: isOffline,
})

/** 属性值形如 "str:Europe" / "int:1"，去掉类型前缀 */
const attr = (server, key) => {
  const raw = server.attributes?.[key]
  return typeof raw === 'string' ? raw.replace(/^[a-z0-9]+:/, '') : null
}

/**
 * 服务器跑的是哪张图、什么模式。Experience 形如 "Bakurani_KOTH_01+KOTH_Hardcore"：
 * 前一段是地图（内部名），加号后面是变体。
 */
export function describeMatch(server) {
  const experience = attr(server, 'Experience') ?? ''
  const [base, ...variants] = experience.split('+')
  const map = attr(server, 'VariantMapName') || base.split('_')[0] || attr(server, 'MAPNAME') || '未知'
  return { map, variants: variants.map((item) => item.replace(/^KOTH_/, '')) }
}

/** 把一台服务器压成页面要的几个字段 */
export function compactServer(server) {
  const { map, variants } = describeMatch(server)
  return {
    id: server.id,
    number: server.number,
    zone: server.zone,
    official: !!server.official,
    passworded: !!server.passworded,
    players: server.players ?? 0,
    max: server.max ?? 0,
    map,
    variants,
    sky: attr(server, 'Sky'),
  }
}

/**
 * 把全量清单压成汇总：各区服务器数 / 在线 / 容量，各地图在线人数。
 * @param {object} raw 上游原始数据
 * @param {number | null} steamPlayers Steam 在线人数，拿不到就是 null
 */
export function summarizeStatus(raw, steamPlayers) {
  const zones = new Map()
  const maps = new Map()
  for (const server of raw.servers) {
    const zone = zones.get(server.zone) ?? { id: server.zone, servers: 0, players: 0, capacity: 0 }
    zone.servers += 1
    zone.players += server.players ?? 0
    zone.capacity += server.max ?? 0
    zones.set(server.zone, zone)

    const { map } = describeMatch(server)
    const entry = maps.get(map) ?? { map, servers: 0, players: 0 }
    entry.servers += 1
    entry.players += server.players ?? 0
    maps.set(map, entry)
  }
  // 上游的 regions 里还有 0 台服务器的区，补进去，页面上区的清单才完整
  for (const region of raw.regions) {
    if (!zones.has(region.region)) zones.set(region.region, { id: region.region, servers: 0, players: 0, capacity: 0 })
  }
  return {
    upstreamFetchedAt: raw.fetched_at ?? null,
    steamPlayers,
    totals: {
      players: raw.totals.players ?? 0,
      capacity: raw.totals.capacity ?? 0,
      servers: raw.totals.servers ?? raw.servers.length,
      queued: raw.totals.queued ?? 0,
    },
    matchmakingAvailable: !!raw.matchmaking_available,
    zones: [...zones.values()].sort((a, b) => b.players - a.players),
    maps: [...maps.values()].sort((a, b) => b.players - a.players),
  }
}

/** 汇总。Steam 人数拿不到不影响主体 */
export async function getServerStatus() {
  const [{ data, source, fetchedAt }, steam] = await Promise.all([
    statusCache.get(),
    steamCache.get().catch(() => null),
  ])
  return {
    source,
    fetchedAt,
    summary: summarizeStatus(data, steam?.data?.response?.player_count ?? null),
  }
}

const ZONE_PATTERN = /^[a-z-]{2,32}$/

/**
 * 某个区的服务器清单，按在线人数倒序。
 * @throws AppError 区 id 形状不对（400）
 */
export async function listZoneServers(zone) {
  if (typeof zone !== 'string' || !ZONE_PATTERN.test(zone)) {
    throw badRequest('invalid_zone', '区 id 非法')
  }
  const { data, source, fetchedAt } = await statusCache.get()
  const servers = data.servers
    .filter((server) => server.zone === zone)
    .map(compactServer)
    .sort((a, b) => b.players - a.players || a.number - b.number)
  return { source, fetchedAt, zone, servers }
}

/* ── 金条汇率 ─────────────────────────────────────────── */

const isMarketPayload = (data) => data !== null && typeof data === 'object'
  && Array.isArray(data.points) && data.points.length > 0
  && data.stats !== null && typeof data.stats === 'object'

const marketCache = createUpstreamCache({
  name: 'gold-market',
  url: 'https://metaforge.app/api/wardogs/market',
  ttlMs: 10 * 60_000,
  validate: isMarketPayload,
  offline: isOffline,
})

export async function getMarket() {
  const { data, source, fetchedAt } = await marketCache.get()
  return {
    source,
    fetchedAt,
    updatedAt: data.updatedAt ?? null,
    stats: data.stats,
    points: data.points.map((point) => [point.t, point.price]),
  }
}

/* ── 进度与 XP ────────────────────────────────────────── */

const isProgressionPayload = (data) => data !== null && typeof data === 'object'
  && Array.isArray(data.roles) && data.roles.length > 0
  && Array.isArray(data.unlocks) && Array.isArray(data.actions)

const progressionCache = createUpstreamCache({
  name: 'progression',
  url: 'https://metaforge.app/api/wardogs/progression',
  ttlMs: 24 * 60 * 60_000,
  validate: isProgressionPayload,
  snapshotPath: path.join(SNAPSHOT_DIR, 'progression.json'),
  offline: isOffline,
})

/** 奖励数值：base 是主值，variants 里的条件值取最大的做上限；缺了就是 null */
function rewardOf(reward) {
  const base = Number.isFinite(reward?.base) ? reward.base : null
  const values = (reward?.variants ?? []).map((variant) => variant.value).filter(Number.isFinite)
  const max = Math.max(base ?? 0, ...values)
  return {
    base,
    max: values.length || base !== null ? max : null,
    decay: reward?.decay && Number.isFinite(reward.decay.perRepeat) ? reward.decay : null,
  }
}

/** 上游数据 245 KB，页面只要角色等级表、解锁和行动奖励 */
export function slimProgression(raw) {
  return {
    generatedAt: raw.generatedAt ?? null,
    roles: raw.roles.map((role) => ({
      id: role.id,
      name: role.name,
      maxLevel: role.maxLevel,
      totalXpToMax: role.totalXpToMax,
      levels: role.levels.map((level) => ({ level: level.level, totalXp: level.totalXp, xpFromPrevious: level.xpFromPrevious })),
    })),
    unlocks: raw.unlocks.map((unlock) => ({
      name: unlock.name,
      tab: unlock.tab,
      subcategory: unlock.subcategory,
      role: unlock.role,
      level: unlock.level,
      cash: unlock.cash ?? null,
    })),
    actions: raw.actions.map((action) => ({
      label: action.playerLabel || action.label,
      group: action.group ?? 'Other',
      isAssist: !!action.isAssist,
      xp: rewardOf(action.xp),
      cash: rewardOf(action.cash),
    })),
    placement: raw.placement ?? null,
  }
}

export async function getProgression() {
  const { data, source, fetchedAt } = await progressionCache.get()
  return { source, fetchedAt, progression: slimProgression(data) }
}

/** 只给测试用 */
export function resetIntelCaches() {
  statusCache.reset()
  steamCache.reset()
  marketCache.reset()
  progressionCache.reset()
}
