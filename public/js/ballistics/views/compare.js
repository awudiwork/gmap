/**
 * 逐发比较：每把枪一张卡，人形图按部位上色写弹数，下面把每发伤害怎么算出来的摊开。
 * 勾了多种弹时一张卡里按弹种分段。
 */
import { icon } from '../../ui.js'
import { bodyMap } from '../bodymap.js'
import { h, plateBadge, rankBadge, roundTag, weaponIcon } from '../dom.js'
import {
  MOA_CM_PER_M, ROUND_SHORT, armourName, armourShort, calibreFor, calibreLabel, formatNumber, formatShots,
  formatTime, hitLabel, loadsFor, roundLabel, shotBand, slugOf, solve,
} from '../engine.js'
import { addCard } from '../summary.js'

/** 每发伤害的乘法链，一行一个因子 */
function breakdown(session, weapon, solution) {
  const { data, engagement } = session
  const factors = solution.factors
  const armour = solution.stoppedBy
  const interval = 60000 / (weapon.roundsPerMinute ?? 1)
  const spread = weapon.accuracyMoa ? weapon.accuracyMoa * MOA_CM_PER_M * engagement.range : null

  const rows = factors
    ? [
      { op: '', value: formatNumber(factors.base, 1), label: '子弹' },
      { op: '×', value: factors.zone.toFixed(2), label: hitLabel(data, engagement.hit) },
      { op: '×', value: factors.ammo.toFixed(2), label: `${ROUND_SHORT[factors.round] ?? factors.round}${armour ? ' 对甲' : ''}` },
      { op: '×', value: factors.weapon.toFixed(2), label: '武器', idle: factors.weapon === 1 },
      armour && factors.armour !== null
        ? { op: '×', value: factors.armour.toFixed(2), label: `${armourShort(armour.name)} ${Math.round(factors.reduction ?? 0)}%` }
        : { op: '×', value: '1.00', label: '无护甲', idle: true },
      { op: '×', value: factors.range.toFixed(2), label: `${engagement.range} m` },
      { op: '=', value: formatNumber(solution.damage, 1), label: '每发', result: true },
    ]
    : ['子弹', hitLabel(data, engagement.hit), '弹种', '武器', '护甲', `${engagement.range} m`, '每发']
      .map((label, index) => ({ op: index === 0 ? '' : index === 6 ? '=' : '×', value: '-', label, idle: true }))

  const grid = h('div', { class: 'factors' })
  for (const row of rows) {
    grid.append(
      h('span', { class: 'op', text: row.op }),
      h('b', { class: row.result ? 'result' : row.idle ? 'idle' : '', text: row.value }),
      h('span', { class: `flabel ${row.idle ? 'idle' : ''}`, title: row.label, text: row.label }),
    )
  }

  const dl = h('dl', { class: 'sums' })
  // 护甲
  dl.append(h('dt', { text: '护甲' }))
  if (factors && armour && factors.plateHit !== null && factors.durability !== null) {
    const ratio = `${formatNumber(factors.durability)} ÷ ${formatNumber(factors.plateHit, 1)}`
    const broke = solution.plateBreaksAt !== null
    const dd = h('dd', {
      title: broke
        ? `${armourName(armour.name)}：耐久 ${formatNumber(factors.durability)}，每发磨损 ${formatNumber(factors.plateHit, 1)}，第 ${solution.plateBreaksAt} 发打穿，之后每发 ${formatNumber(factors.after ?? 0, 1)}`
        : `${armourName(armour.name)}：耐久 ${formatNumber(factors.durability)}，每发磨损 ${formatNumber(factors.plateHit, 1)}，撑到击杀结束`,
    })
    dd.append(icon(broke ? 'shield-slash' : 'shield-check'), h('b', { text: broke ? `${ratio}，第 ${solution.plateBreaksAt} 发打穿` : `${ratio}，${solution.plateShots} 发打穿` }))
    dl.append(dd)
  } else {
    dl.append(h('dd', { class: 'faint', text: factors ? '此部位无护甲' : '-' }))
  }
  // 弹数
  dl.append(h('dt', { text: '弹数' }))
  if (factors) {
    const dd = h('dd', null, h('b', { text: `${session.data.assumedHealth} ÷ ${formatNumber(solution.damage, 1)} = ${formatShots(solution.shots)}` }))
    if (solution.plateBreaksAt !== null) dd.append(h('span', { class: 'dim', text: '含打穿' }))
    dl.append(dd)
  } else {
    dl.append(h('dd', { class: 'faint', text: '-' }))
  }
  // 时间
  dl.append(h('dt', { text: '时间' }))
  if (factors && Number.isFinite(solution.shots)) {
    const flight = solution.flight ? ` + ${Math.round(solution.flight)} ms` : ''
    dl.append(h('dd', null, h('b', { text: `${solution.shots - 1} × ${Math.round(interval)} ms${flight} = ${formatTime(solution.time)}` })))
  } else {
    dl.append(h('dd', { class: 'faint', text: '-' }))
  }
  // 散布
  dl.append(h('dt', { text: '散布' }))
  if (spread !== null) {
    dl.append(h('dd', null, h('b', { text: `${weapon.accuracyMoa} MOA = ${spread < 10 ? spread.toFixed(1) : Math.round(spread)} cm` })))
  } else {
    dl.append(h('dd', { class: 'faint', text: '-' }))
  }

  return h('div', { class: 'breakdown' }, grid, dl)
}

/** 一把枪一种弹的人形图 + 说明 */
function weaponBlock(session, weapon, round, { standard, multi, rank }) {
  const { data } = session
  const slug = slugOf(weapon)
  const engagement = { ...session.engagement, round }
  const zones = data.hitLocations.map((zone) => zone.key)
  const byZone = new Map(zones.map((key) => [key, solve(data, weapon, { ...engagement, hit: key })]))
  const current = byZone.get(session.engagement.hit) ?? solve(data, weapon, engagement)
  const bandOf = (key) => shotBand(byZone.get(key)?.shots ?? Infinity)

  const map = bodyMap({
    zones,
    hit: session.engagement.hit,
    covered: session.coveredZones,
    fill: (key) => bandOf(key).colour,
    ink: (key) => bandOf(key).ink,
    text: (key) => formatShots(byZone.get(key)?.shots ?? Infinity),
    label: (key) => `${hitLabel(data, key)}：${formatShots(byZone.get(key)?.shots ?? Infinity)} 发`,
    title: (key) => {
      const sol = byZone.get(key)
      return sol ? `${hitLabel(data, key)}：${formatShots(sol.shots)} 发，${formatTime(sol.time)}，每发 ${Math.round(sol.damage)}` : ''
    },
    onPick: (key) => session.setEngagement({ hit: key }),
    className: multi ? 'h64' : 'h80',
  })

  const detail = multi
    ? h('div', { class: 'quick' },
      h('b', { text: `${formatShots(current.shots)} 发` }),
      h('b', { text: formatTime(current.time) }),
      h('span', { class: 'dim', text: `${Math.round(current.damage)}/发` }),
      plateBadge(current),
    )
    : breakdown(session, weapon, current)

  if (multi) {
    return h('section', { class: 'cmp-load' },
      h('div', { class: 'cmp-load-head' }, roundTag(round, { standard }), h('span', { class: 'dim cap', text: roundLabel(data, round).replace(/\s*\(.*\)$/, '') })),
      map,
      detail,
    )
  }

  const card = h('article', { class: 'cmp-card' })
  card.style.setProperty('--c', session.colours[slug] ?? '')
  const title = h('div', { class: 'cmp-title' }, h('span', { class: 'ellipsis', text: weapon.name }))
  if (standard) title.append(roundTag(round, { standard: true }))
  card.append(
    h('header', { class: 'cmp-head' },
      weaponIcon(session, slug, 'wicon lg'),
      h('div', { class: 'min0' }, title, h('div', { class: 'dim ellipsis', text: calibreLabel(data, calibreFor(weapon, engagement)) })),
      h('span', { class: 'cmp-rank' }, rank ? rankBadge(rank, 'sm') : null),
    ),
    map,
    detail,
  )
  return card
}

export function renderCompare(session) {
  if (!session.ranked.length) return null
  const multi = session.loads.length > 1
  const { data } = session

  /** 这把枪在所选弹种下该显示哪一种弹；不卖时退回它自己的弹（只在第一种弹的位置） */
  const pickRound = (calibre, round) => {
    const available = loadsFor(data, calibre)
    const standard = available.length <= 1
    if (available.includes(round)) return { round, standard }
    if (!session.loads.some((item) => available.includes(item)) && round === session.loads[0]) return { round: available[0], standard }
    return null
  }

  const wrap = h('div', { class: 'cmp-grid' })
  if (multi) {
    for (const entry of session.ranked) {
      const calibre = calibreFor(entry.weapon, session.engagement)
      const card = h('article', { class: 'cmp-card multi' })
      card.style.setProperty('--c', entry.colour)
      card.style.borderColor = `color-mix(in srgb, ${entry.colour} 55%, transparent)`
      card.append(h('header', { class: 'cmp-head' },
        weaponIcon(session, entry.slug, 'wicon lg'),
        h('div', { class: 'min0' }, h('div', { class: 'cmp-title ellipsis', text: entry.weapon.name }), h('div', { class: 'dim ellipsis', text: calibreLabel(data, calibre) })),
      ))
      for (const round of session.loads) {
        const choice = pickRound(calibre, round)
        if (choice) {
          card.append(weaponBlock(session, entry.weapon, choice.round, { standard: choice.standard, multi: true }))
        } else {
          card.append(h('section', { class: 'cmp-load' },
            h('div', { class: 'cmp-load-head' }, roundTag(round, { className: 'faint' })),
            h('div', { class: 'cmp-nosale dim', text: '这把枪不卖这种弹' }),
          ))
        }
      }
      wrap.append(card)
    }
  } else {
    session.ranked.forEach((entry, index) => {
      const choice = pickRound(calibreFor(entry.weapon, session.engagement), session.loads[0])
      if (!choice) return
      wrap.append(weaponBlock(session, entry.weapon, choice.round, { standard: choice.standard, multi: false, rank: index + 1 }))
    })
  }
  if (session.ranked.length < 3) wrap.append(addCard(session, 'cmp'))
  return h('div', { class: 'view-compare' }, wrap)
}
