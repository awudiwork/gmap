/**
 * 击杀弹数表：每把枪 x 每种弹一行，列是无甲到四级甲。
 * 格子按效果档着色，点一格就把护甲等级和弹种设成那一格的条件。
 */
import { icon } from '../../ui.js'
import { checkMark, h, roundGlyph, roundTag, weaponIcon } from '../dom.js'
import {
  ROUND_SHORT, calibreFor, calibreLabel, classShort, formatSeconds, formatShots, formatTime, hitLabel, loadsFor,
  shotBand, slugOf, solve, timeBand,
} from '../engine.js'
import { WEAPON_CLASS } from '../text.js'

const CLASS_ALL = '全部武器类型'

function rows(session) {
  const { data, engagement } = session
  const source = session.pickedOnly
    ? session.weapons.filter((weapon) => session.selected.includes(slugOf(weapon)))
    : session.weapons
  const list = []
  for (const weapon of source) {
    if (session.classFilter && weapon.weaponClass !== session.classFilter) continue
    const calibre = calibreFor(weapon, engagement)
    const available = loadsFor(data, calibre)
    let loads = session.loads.filter((round) => available.includes(round))
    if (!loads.length) loads = [available[0]]
    for (const round of loads) {
      list.push({
        slug: slugOf(weapon),
        weapon,
        calibre,
        round,
        standard: available.length <= 1,
        tiers: session.ladder.map((step) => solve(data, weapon, { ...engagement, armour: step.armour, helmet: step.helmet, round })),
      })
    }
  }

  const { key, asc } = session.tableSort
  const column = key === 'cur' ? session.currentLevel : (typeof key === 'number' ? key : null)
  const sortValue = (row) => {
    if (column === null) return row.weapon.name
    const sol = row.tiers[column]
    const value = session.metric === 'shots' ? sol.shots : sol.time
    if (!Number.isFinite(value)) return 1e12
    // 弹数一样时用时间做次序，但只作为小数位，不影响主序
    return session.metric === 'shots' ? value + Math.min(sol.time, 1e5) / 1e6 : value
  }
  list.sort((a, b) => {
    const va = sortValue(a)
    const vb = sortValue(b)
    const delta = typeof va === 'string' ? va.localeCompare(vb) : va - vb
    return asc ? delta : -delta
  })
  return list
}

export function renderTable(session) {
  const { data } = session
  const classes = [...new Set(session.weapons.map((weapon) => weapon.weaponClass).filter((cls) => !!cls))].sort()
  const isSorted = (key) => key === session.tableSort.key || (session.tableSort.key === 'cur' && key === session.currentLevel)

  const filters = h('div', { class: 'class-filters' })
  for (const cls of [null, ...classes]) {
    const on = session.classFilter === cls
    filters.append(h('button', {
      type: 'button',
      class: `cls-chip ${on ? 'on' : ''}`,
      'aria-pressed': String(on),
      text: cls ? (WEAPON_CLASS[cls] ?? cls) : CLASS_ALL,
      onclick: () => session.set({ classFilter: cls }),
    }))
  }

  const headCell = (key, label, { short, left = false, highlight = false, className = '' } = {}) => {
    const sorted = isSorted(key)
    const th = h('th', {
      scope: 'col',
      class: `${left ? 'left' : ''} ${highlight ? 'hl' : sorted ? 'sorted' : ''} ${className}`,
      'aria-sort': sorted ? (session.tableSort.asc ? 'ascending' : 'descending') : 'none',
    })
    const button = h('button', { type: 'button', class: 'th-sort', onclick: () => session.sortTableBy(key) })
    button.append(
      h('span', { class: 'narrow-only', text: short ?? label }),
      h('span', { class: 'narrow-hide', text: label }),
      sorted ? icon(session.tableSort.asc ? 'caret-up' : 'caret-down', 'icon sort') : icon('caret-up-down', 'icon sort faint narrow-hide'),
    )
    th.append(button)
    return th
  }

  const head = h('tr', null,
    headCell('name', '武器', { left: true, className: 'col-name' }),
    h('th', { scope: 'col', class: 'left col-round' }, h('span', { class: 'narrow-hide', text: '弹种' })),
    ...session.ladder.map((step) => headCell(step.level, step.level === 0 ? '无护甲' : `${step.level} 级`, {
      short: step.level === 0 ? '无' : `L${step.level}`,
      highlight: step.level === session.currentLevel,
      className: 'col-tier',
    })),
  )

  const body = h('tbody')
  for (const row of rows(session)) {
    const picked = session.selected.includes(row.slug)
    const tr = h('tr', { class: `${picked ? 'picked' : ''}` })
    if (picked) tr.style.setProperty('--c', session.colours[row.slug])

    const pick = h('button', {
      type: 'button',
      class: `pickbox ${picked ? 'on' : ''}`,
      'aria-pressed': String(picked),
      disabled: !picked && session.isFull,
      title: picked ? '从比较里移除' : (session.isFull ? '先移除一把才能再加' : '加入比较'),
      onclick: () => session.toggle(row.slug),
    }, checkMark(picked))

    const nameCell = h('td', { class: 'cell-name' }, h('div', { class: 'name-wrap' },
      pick,
      weaponIcon(session, row.slug, 'wicon sm narrow-hide'),
      h('span', { class: 'strong ellipsis', text: row.weapon.name }),
      h('small', { class: 'dim hover-only narrow-hide', text: `${classShort(row.weapon.weaponClass)} | ${calibreLabel(data, row.calibre)}` }),
    ))
    const roundCell = h('td', { class: 'cell-round' },
      h('span', { class: 'narrow-hide' }, roundTag(row.round, { standard: row.standard })),
      h('span', { class: 'narrow-only', title: row.standard ? '这把枪只卖一种弹' : ROUND_SHORT[row.round] }, roundGlyph(row.standard ? undefined : row.round)),
    )
    tr.append(nameCell, roundCell)

    row.tiers.forEach((sol, level) => {
      const band = session.metric === 'shots' ? shotBand(sol.shots) : timeBand(sol.time)
      const current = level === session.currentLevel && session.loads.includes(row.round)
      const finite = Number.isFinite(sol.shots)
      const big = session.metric === 'shots' ? formatShots(sol.shots) : (finite ? `${formatSeconds(sol.time)}s` : '∞')
      const small = session.metric === 'shots'
        ? h('small', { text: formatTime(sol.time) })
        : h('small', null, roundGlyph(undefined), ` ${formatShots(sol.shots)}`)
      const tierName = level ? `${level} 级护甲` : '无护甲'
      const title = `${row.weapon.name} ${ROUND_SHORT[row.round] ?? row.round} 对${tierName}，${hitLabel(data, session.engagement.hit)}，${session.engagement.range} m：`
        + `${formatShots(sol.shots)} 发，${formatTime(sol.time)}，每发 ${Math.round(sol.damage)}`
        + (sol.plateBreaksAt !== null ? `，第 ${sol.plateBreaksAt} 发打穿护甲` : '')
      const cell = h('button', {
        type: 'button',
        class: `tier ${current ? 'cur' : ''}`,
        title,
        onclick: () => {
          session.setBothLevels(level)
          if (!session.loads.includes(row.round)) session.setLoads([row.round])
        },
      })
      cell.style.setProperty('--band', band.colour)
      cell.style.color = finite ? band.text : 'var(--dim)'
      cell.append(h('b', { text: big }), h('span', { class: 'narrow-hide' }, small))
      if (sol.plateBreaksAt !== null) cell.append(icon('shield-slash', 'icon narrow-hide'))
      tr.append(h('td', { class: 'cell-tier' }, cell))
    })
    body.append(tr)
  }

  const table = h('table', { class: 'stk' }, h('thead', null, head), body)
  return h('div', { class: 'view-table' }, filters, h('div', { class: 'table-scroll' }, table))
}
