/**
 * Wardogs 伤害计算引擎。纯函数，不碰 DOM，浏览器和 node:test 里都能跑。
 *
 * 移植自 metaforge.app 弹道页的计算模块，公式逐条对应，数字要和原站一致。
 * 术语：
 *   engagement  一次交战的条件 { armour, helmet, hit, round, shell, range }
 *   solution    对某把枪解出的结果 { damage, shots, time, flight, falloff, stoppedBy, plateBreaksAt, plateShots, ... }
 *   band        效果分档，按弹数或时间落到七档之一
 */
import { HIT_ZONE, ROUND_NAME, SHOT_BAND_TEXT, TIME_BAND_TEXT, WEAPON_CLASS_SHORT, armourName } from './text.js'

/** 弹道模拟的最远距离，也是距离滑杆的上限 */
export const MAX_RANGE = 2000
/** 距离图默认画到这里，只有滑杆拉过 1000 才展开到 2000 */
export const CHART_RANGE = 1000
/** 1 MOA 在 1 米处的散布，厘米 */
export const MOA_CM_PER_M = 0.029089
/** 最多同时比较几把枪 */
export const MAX_PICKED = 5

const AIR_DENSITY = 1.225

/** 五把枪的专属色，按选中顺序分配，去掉一把不影响其它的颜色 */
export const WEAPON_COLOURS = Object.freeze(['#3987e5', '#d55181', '#9085e9', '#199e70', '#d95926'])

export const ROUND_SHORT = Object.freeze({ FMJ: 'FMJ', HollowPoint: 'HP', ArmorPiercing: 'AP' })
/** 距离图上每种弹的线型 */
export const ROUND_DASH = Object.freeze({ FMJ: '', HollowPoint: '7 4', ArmorPiercing: '2 3' })

export const CLASS_ORDER = Object.freeze([
  'Assault Rifle', 'Submachine Gun', 'Light Machine Gun', 'Shotgun',
  'Marksman Rifle', 'Sniper Rifle', 'Pistol', 'Combat Bow',
])

/* ── 数据取值 ─────────────────────────────────────────── */

export const slugOf = (weapon) => weapon.slug ?? weapon.id

/** 能算的枪：有射速、口径在表里、有命中部位倍率的武器类 */
export function usableWeapons(data) {
  return data.weapons.filter((weapon) =>
    weapon.roundsPerMinute && weapon.calibre && data.calibres[weapon.calibre]
    && weapon.weaponClass && data.hitboxes[weapon.weaponClass])
}

/** 霰弹枪可以换弹种（鹿弹 / 独头弹），选了它支持的就用它，否则用默认口径 */
export function calibreFor(weapon, engagement) {
  return engagement.shell && weapon.shells?.includes(engagement.shell) ? engagement.shell : weapon.calibre
}

/** 这个口径卖哪几种弹。没写就只有标准弹 */
export function loadsFor(data, calibreKey) {
  const loads = calibreKey ? data.calibres[calibreKey]?.loads : undefined
  return loads?.length ? loads : ['FMJ']
}

export const calibreLabel = (data, key) => (key && data.calibres[key]?.label) || key || ''
export const hitLabel = (data, key) => HIT_ZONE[key] ?? data.hitLocations.find((zone) => zone.key === key)?.label ?? key
export const roundLabel = (data, key) => ROUND_NAME[key] ?? data.rounds.find((round) => round.key === key)?.label ?? key
export const roundIndex = (data, key) => {
  const index = data.rounds.findIndex((round) => round.key === key)
  return index === -1 ? data.rounds.length : index
}
/** "Level 2 Armor" 缩成 "L2" */
export const armourShort = (name) => name.replace(/^Level (\d) (Armor|Helmet)$/, 'L$1')
export { armourName }

const TIER_LEVEL = { Light: 1, Medium: 2, Heavy: 3, SuperHeavy: 4 }
export const tierLevel = (armour) => TIER_LEVEL[armour.tier.split('.').pop() ?? ''] ?? 0

export function levelOf(data, armourId) {
  const armour = armourId ? data.armour.find((item) => item.id === armourId) : undefined
  return armour ? tierLevel(armour) : 0
}

/** 某个槽位（armor / helmet）某一级的护甲 id，0 级或没有这一级时为 null */
export function armourIdFor(data, slot, level) {
  if (!level) return null
  return data.armour.find((item) => item.slot === slot && tierLevel(item) === level)?.id ?? null
}

/** 护甲阶梯：无甲 + 四个等级（头盔和护甲同级），表格的列就是它 */
export function ladder(data) {
  const levels = [1, 2, 3, 4].map((level) => ({
    level,
    armour: armourIdFor(data, 'armor', level),
    helmet: armourIdFor(data, 'helmet', level),
  }))
  return [{ level: 0, armour: null, helmet: null }, ...levels.filter((step) => step.armour && step.helmet)]
}

/** 这次命中被哪件护甲挡着：先看护甲再看头盔，取第一件覆盖到该部位的 */
export function coveringArmour(data, engagement) {
  return [engagement.armour, engagement.helmet]
    .map((id) => (id ? data.armour.find((item) => item.id === id) : undefined))
    .filter((item) => !!item)
    .find((item) => item.covers.includes(engagement.hit)) ?? null
}

/* ── 弹道 ─────────────────────────────────────────────── */

/**
 * 距离衰减。曲线是 [距离, 倍率, 出切线, 入切线, 是否用 Hermite] 的节点表，
 * 两节点之间线性或三次 Hermite 插值。
 */
export function falloffAt(curve, range) {
  if (!curve?.length) return 1
  if (range <= curve[0][0]) return curve[0][1]
  for (let i = 1; i < curve.length; i += 1) {
    const [x0, y0, tangentOut, , hermite] = curve[i - 1]
    const [x1, y1, , tangentIn] = curve[i]
    if (range > x1) continue
    const span = x1 - x0
    if (span === 0) return y1
    const t = (range - x0) / span
    if (!hermite) return y0 + (y1 - y0) * t
    const m0 = tangentOut * span
    const m1 = tangentIn * span
    const t2 = t * t
    const t3 = t2 * t
    return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1
  }
  return curve[curve.length - 1][1]
}

/** 飞行时间表按数据对象缓存，换了一份数据就整个作废 */
const flightTables = new WeakMap()

/**
 * 子弹飞到 range 米要多少毫秒。逐米模拟空气阻力减速，
 * 每把枪每种口径算一张 2000 米的表，之后查表插值。
 */
export function flightTimeMs(data, weapon, calibreKey, calibre, range) {
  if (range <= 0) return 0
  const v0 = weapon.muzzleVelocity
  const curve = calibre.dragModel ? data.dragCurves?.[calibre.dragModel] : undefined
  if (!v0 || !curve?.length || !calibre.mass || !calibre.diameter) return 0

  let tables = flightTables.get(data)
  if (!tables) {
    tables = new Map()
    flightTables.set(data, tables)
  }
  const key = `${weapon.id}|${calibreKey}`
  let table = tables.get(key)
  if (!table) {
    const dragAt = (velocity) => {
      if (velocity <= curve[0][0]) return curve[0][1]
      for (let i = 1; i < curve.length; i += 1) {
        if (velocity <= curve[i][0]) {
          const [va, ca] = curve[i - 1]
          const [vb, cb] = curve[i]
          return ca + (velocity - va) / (vb - va) * (cb - ca)
        }
      }
      return curve[curve.length - 1][1]
    }
    const area = Math.PI * (calibre.diameter / 200) ** 2
    const k = 0.5 * AIR_DENSITY * area * (calibre.dragCoefficient ?? 1) / calibre.mass
    table = new Float64Array(MAX_RANGE + 1)
    let velocity = v0
    let elapsed = 0
    for (let metre = 1; metre <= MAX_RANGE; metre += 1) {
      elapsed += 1000 / velocity
      velocity = Math.max(velocity - k * dragAt(velocity) * velocity, 10)
      table[metre] = elapsed
    }
    tables.set(key, table)
  }
  const clamped = Math.min(range, MAX_RANGE)
  const lower = Math.floor(clamped)
  return table[lower] + (clamped - lower) * (table[Math.min(lower + 1, MAX_RANGE)] - table[lower])
}

/* ── 求解 ─────────────────────────────────────────────── */

export const EMPTY_SOLUTION = Object.freeze({
  damage: 0,
  roundUnavailable: false,
  shots: Infinity,
  time: Infinity,
  flight: 0,
  falloff: 1,
  stoppedBy: null,
  plateBreaksAt: null,
  plateShots: null,
  factors: null,
})

const NEUTRAL_COMBAT = { bare: 1, penScalar: 1, vsTier: {}, plateArmor: 1, plateHelmet: 1 }

/**
 * 对一把枪解出一次交战。
 *
 * 每发原始伤害 = 口径基础伤害 x 弹丸数 x 部位倍率 x 距离衰减。
 * 无甲：每发 = 原始 x 弹种肉伤系数 x 武器系数，弹数 = ceil(血量 / 每发)。
 * 有甲：减伤 = min(100, 护甲减伤 x 弹种穿透系数)，穿甲每发 = 原始 x 弹种对该级护甲系数 x 武器系数 x (1 - 减伤)；
 *       每发同时磨掉护甲耐久 = 基础 x 衰减 x 弹种磨甲系数，磨穿之后的每发按无甲算。
 * 击杀时间 = (弹数 - 1) x 射击间隔 + 子弹飞行时间。
 */
export function solve(data, weapon, engagement, range = engagement.range) {
  const calibreKey = calibreFor(weapon, engagement)
  const calibre = calibreKey ? data.calibres[calibreKey] : undefined
  const zoneMult = weapon.weaponClass ? data.hitboxes[weapon.weaponClass]?.[engagement.hit] : undefined
  const roundUnavailable = !!calibre?.loads?.length && !calibre.loads.includes(engagement.round)
  if (!calibre || zoneMult === undefined || !weapon.roundsPerMinute) return EMPTY_SOLUTION

  // 这个口径不卖所选弹种时退回标准弹，界面上会把它标成"未售"
  const round = roundUnavailable ? 'FMJ' : engagement.round
  const combat = calibre.combat?.[round] ?? NEUTRAL_COMBAT
  const health = data.assumedHealth
  const armour = coveringArmour(data, engagement)
  const falloff = falloffAt(weapon.falloff, range)
  const base = calibre.baseDamage * (calibre.pellets ?? 1)
  const weaponMult = weapon.damageMult ?? 1
  const raw = base * zoneMult * falloff
  const bare = Math.max(0, raw * combat.bare * weaponMult)
  const flight = flightTimeMs(data, weapon, calibreKey, calibre, range)
  const timeFor = (shots) => (shots - 1) * 60000 / weapon.roundsPerMinute + flight
  const factors = {
    base, zone: zoneMult, ammo: combat.bare, weapon: weaponMult,
    armour: null, reduction: null, range: falloff, round, after: null, plateHit: null, durability: null,
  }

  if (!armour) {
    if (bare <= 0) return { ...EMPTY_SOLUTION, falloff, roundUnavailable }
    const shots = Math.ceil(health / bare)
    return {
      damage: bare, shots, time: timeFor(shots), flight, falloff,
      stoppedBy: null, plateBreaksAt: null, plateShots: null, roundUnavailable, factors,
    }
  }

  const reduction = Math.min(100, armour.reduction * combat.penScalar)
  const through = Math.max(0, raw * (combat.vsTier[armour.tier] ?? 1) * weaponMult * (1 - reduction / 100))
  const plateHit = base * falloff * (armour.slot === 'helmet' ? combat.plateHelmet : combat.plateArmor)
  const durability = Number.isFinite(armour.durability) ? armour.durability : Infinity
  const plateShots = plateHit > 0 && Number.isFinite(durability) ? Math.ceil(durability / plateHit) : null
  Object.assign(factors, {
    ammo: combat.vsTier[armour.tier] ?? 1,
    armour: 1 - reduction / 100,
    reduction,
    after: bare,
    plateHit,
    durability,
  })

  // 逐发模拟：板子还在就打穿甲伤害并磨耐久，磨穿之后按肉伤算
  let hp = health
  let plate = durability
  let shots = 0
  let plateBreaksAt = null
  while (hp > 0 && shots < 999) {
    shots += 1
    if (plate > 0) {
      hp -= through
      plate -= plateHit
      if (plate <= 0 && hp > 0) plateBreaksAt = shots
    } else {
      hp -= bare
    }
  }
  if (hp > 0) {
    return { ...EMPTY_SOLUTION, damage: through, flight, falloff, stoppedBy: armour, plateShots, roundUnavailable, factors }
  }
  return {
    damage: through, shots, time: timeFor(shots), flight, falloff,
    stoppedBy: armour, plateBreaksAt, plateShots, roundUnavailable, factors,
  }
}

/* ── 效果分档 ─────────────────────────────────────────── */

const BAND_COLOUR = ['#761c1c', '#a84314', '#d78419', '#ecd147', '#a9d048', '#379450', '#115a28']
const BAND_TEXT_COLOUR = ['#e05252', '#e8703f', '#eb9434', '#e6c83e', '#b3d44a', '#66bb62', '#49ad66']
/** 色块上压的字：深色块用浅字，亮色块用深字 */
const BAND_INK = ['#f2efe8', '#f2efe8', '#12100c', '#12100c', '#12100c', '#12100c', '#f2efe8']

const band = (value, text, range, short, min) => ({
  value,
  label: text.label,
  description: text.description,
  range,
  short,
  min,
  colour: BAND_COLOUR[value],
  ink: BAND_INK[value],
  text: BAND_TEXT_COLOUR[value],
})

/** 按弹数分档，阈值是固定的 */
export const SHOT_BANDS = [
  band(0, SHOT_BAND_TEXT[0], '20+', '20+', 20),
  band(1, SHOT_BAND_TEXT[1], '13 到 19', '13-19', 13),
  band(2, SHOT_BAND_TEXT[2], '9 到 12', '9-12', 9),
  band(3, SHOT_BAND_TEXT[3], '5 到 8', '5-8', 5),
  band(4, SHOT_BAND_TEXT[4], '3 或 4', '3-4', 3),
  band(5, SHOT_BAND_TEXT[5], '2', '2', 2),
  band(6, SHOT_BAND_TEXT[6], '1', '1', 1),
]

export function shotBand(shots) {
  if (!Number.isFinite(shots)) return SHOT_BANDS[0]
  return SHOT_BANDS.find((entry) => shots >= entry.min) ?? SHOT_BANDS[6]
}

/**
 * 按时间分档。阈值不是定死的：calibrateTimeBands 会按全部武器的时间分布
 * 重新标定，让"很有效"在时间上的占比和它在弹数上的占比一致。
 */
export const TIME_BANDS = [
  band(0, TIME_BAND_TEXT[0], '', '', 2500),
  band(1, TIME_BAND_TEXT[1], '', '', 1600),
  band(2, TIME_BAND_TEXT[2], '', '', 1100),
  band(3, TIME_BAND_TEXT[3], '', '', 750),
  band(4, TIME_BAND_TEXT[4], '', '', 500),
  band(5, TIME_BAND_TEXT[5], '', '', 300),
  band(6, TIME_BAND_TEXT[6], '', '', 0),
]

const seconds = (ms) => (ms / 1000).toFixed(2)

function relabelTimeBands() {
  TIME_BANDS.forEach((entry, index) => {
    if (index === 0) {
      entry.range = `${seconds(entry.min)}s 以上`
      entry.short = `${seconds(entry.min)}s+`
    } else if (index === 6) {
      entry.range = `${seconds(TIME_BANDS[5].min)}s 以内`
      entry.short = `<${seconds(TIME_BANDS[5].min)}s`
    } else {
      entry.range = `${seconds(entry.min)} 到 ${seconds(TIME_BANDS[index - 1].min)}s`
      entry.short = `${seconds(entry.min)}-${seconds(TIME_BANDS[index - 1].min)}s`
    }
  })
}
relabelTimeBands()

export function timeBand(ms) {
  if (!Number.isFinite(ms)) return TIME_BANDS[0]
  return TIME_BANDS.find((entry) => ms >= entry.min) ?? TIME_BANDS[6]
}

let calibratedFor = null

/** 标定时间档位。同一份数据只算一次 */
export function calibrateTimeBands(data) {
  if (calibratedFor === data) return
  calibratedFor = data

  const zones = ['head', 'torso_upper', 'torso_middle', 'leg_thigh', 'arm_upper']
    .filter((key) => data.hitLocations.some((zone) => zone.key === key))
  const ranges = [10, 50, 100, 200, 400]
  const shotsSeen = []
  const timesSeen = []
  for (const weapon of usableWeapons(data)) {
    for (const round of loadsFor(data, weapon.calibre)) {
      for (const { armour, helmet } of ladder(data)) {
        for (const hit of zones) {
          for (const range of ranges) {
            const solution = solve(data, weapon, { armour, helmet, hit, round, range })
            shotsSeen.push(solution.shots)
            timesSeen.push(solution.time)
          }
        }
      }
    }
  }
  if (!shotsSeen.length) return

  const total = shotsSeen.length
  const share = SHOT_BANDS.map((entry) => shotsSeen.filter((shots) => shotBand(shots) === entry).length / total)
  const sortedTimes = timesSeen.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sortedTimes.length) return

  let cumulative = 0
  let floor = 0
  for (let value = 6; value >= 1; value -= 1) {
    cumulative += share[value]
    const at = sortedTimes[Math.min(sortedTimes.length - 1, Math.floor(cumulative * sortedTimes.length))]
    let threshold = Math.round(at / 10) * 10
    if (threshold <= floor) threshold = floor + 10
    TIME_BANDS[value - 1].min = threshold
    floor = threshold
  }
  TIME_BANDS[6].min = 0
  relabelTimeBands()
}

/* ── 格式化 ───────────────────────────────────────────── */

/** 击杀时间：0 是瞬间，打不死显示无穷 */
export const formatTime = (ms) => (Number.isFinite(ms) ? (ms === 0 ? '瞬间' : `${seconds(ms)}s`) : '∞')
/** 只要秒数，单位由界面另加 */
export const formatSeconds = (ms) => (Number.isFinite(ms) ? seconds(ms) : '∞')
export const formatShots = (shots) => (Number.isFinite(shots) ? String(shots) : '∞')
/** 整数原样，小数保留 digits 位并去掉尾零 */
export const formatNumber = (value, digits = 2) =>
  (Number.isInteger(value) ? String(value) : value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, ''))

/* ── 多把枪的组合 ─────────────────────────────────────── */

/** 时间短的在前，时间一样弹数少的在前 */
export const compareSolutions = (a, b) => a.sol.time - b.sol.time || a.sol.shots - b.sol.shots

/**
 * 给选中的枪分配颜色。已经有颜色的保留，新来的拿第一个没被占用的，
 * 这样删掉一把再加一把，其它枪的颜色不会跳。
 */
export function assignColours(selected, existing) {
  const result = {}
  const taken = new Set()
  for (const slug of selected) {
    if (existing[slug]) {
      result[slug] = existing[slug]
      taken.add(existing[slug])
    }
  }
  for (const slug of selected) {
    if (result[slug]) continue
    const colour = WEAPON_COLOURS.find((candidate) => !taken.has(candidate)) ?? WEAPON_COLOURS[0]
    result[slug] = colour
    taken.add(colour)
  }
  return result
}

/**
 * 把"选中的枪 x 勾选的弹种"展开成一行行组合。
 * 枪不卖勾选的弹种时只出它自己的第一种，并标记 standard（只卖一种弹）。
 */
export function combos(data, picked, loads, engagement, colours) {
  const rows = []
  for (const weapon of picked) {
    const slug = slugOf(weapon)
    const calibre = calibreFor(weapon, engagement)
    const available = loadsFor(data, calibre)
    const chosen = loads.filter((round) => available.includes(round))
    const rounds = chosen.length ? chosen : [available[0]]
    for (const round of rounds) {
      rows.push({ weapon, slug, colour: colours[slug], calibre, round, standard: available.length <= 1 })
    }
  }
  return rows
}

export function solvedCombos(data, picked, loads, engagement, colours) {
  return combos(data, picked, loads, engagement, colours)
    .map((row) => ({ ...row, sol: solve(data, row.weapon, { ...engagement, round: row.round }) }))
}

/** 按枪归并，每把取最好的那一行，再按最好的排名 */
export function ranked(rows) {
  const groups = new Map()
  for (const row of rows) {
    const list = groups.get(row.slug)
    if (list) list.push(row)
    else groups.set(row.slug, [row])
  }
  return [...groups.values()]
    .map((list) => {
      const best = [...list].sort(compareSolutions)[0]
      return { weapon: best.weapon, slug: best.slug, colour: best.colour, list, best }
    })
    .sort((a, b) => compareSolutions(a.best, b.best))
}

export const classShort = (weaponClass) => WEAPON_CLASS_SHORT[weaponClass] ?? weaponClass
