/**
 * 弹药表：每种口径一行，列出用它的枪、基础伤害、可售弹种和弹道参数。
 * 展开一行看每种弹对肉、对护甲、对头盔的系数。
 */
import { icon } from '../../ui.js'
import { checkMark, h, roundTag } from '../dom.js'
import { roundLabel, slugOf } from '../engine.js'

const COLUMNS = [
  { key: 'label', label: '口径', left: true },
  { key: 'users', label: '武器', left: true },
  { key: 'damage', label: '伤害' },
  { key: 'loads', label: '可售弹种', left: true, plain: true },
  { key: 'velocity', label: '初速' },
  { key: 'mass', label: '弹头质量' },
  { key: 'diameter', label: '弹头直径' },
]

/** 大于 1 是加成（绿），小于 1 是削弱（橙） */
const factorClass = (value) => (value > 1 ? 'up' : value < 1 ? 'down' : '')
/** 护甲减伤系数反过来：大于 1 表示护甲更有效，对射手是坏事 */
const penClass = (value) => (value > 1 ? 'down' : value < 1 ? 'up' : '')

function tierRange(vsTier, prefix) {
  const values = Object.entries(vsTier).filter(([tier]) => tier.startsWith(prefix)).map(([, value]) => value)
  if (!values.length) return '×1'
  const low = Math.min(...values)
  const high = Math.max(...values)
  return low === high ? `×${low}` : `×${low}-${high}`
}

function rows(session) {
  const list = []
  for (const [key, calibre] of Object.entries(session.data.calibres)) {
    const users = session.weapons.filter((weapon) => weapon.calibre === key || weapon.shells?.includes(key))
    if (!users.length) continue
    const speeds = users.map((weapon) => weapon.muzzleVelocity).filter((value) => value !== null && value !== undefined)
    list.push({
      key,
      calibre,
      users,
      damage: calibre.baseDamage * (calibre.pellets ?? 1),
      vmin: speeds.length ? Math.min(...speeds) : null,
      vmax: speeds.length ? Math.max(...speeds) : null,
    })
  }
  const { key, asc } = session.ammoSort
  const valueOf = (row) => {
    switch (key) {
      case 'label': return row.calibre.label ?? row.key
      case 'damage': return row.damage
      case 'velocity': return row.vmax ?? 0
      case 'mass': return row.calibre.mass ?? 0
      case 'diameter': return row.calibre.diameter ?? 0
      case 'users': return row.users.length
      default: return 0
    }
  }
  list.sort((a, b) => {
    const va = valueOf(a)
    const vb = valueOf(b)
    const delta = typeof va === 'string' ? va.localeCompare(vb) : va - vb
    return asc ? delta : -delta
  })
  return list
}

export function renderAmmo(session) {
  const { data } = session
  const list = rows(session)
  const maxDamage = Math.max(1, ...list.map((row) => row.damage))

  const head = h('tr')
  for (const column of COLUMNS) {
    const th = h('th', { scope: 'col', class: column.left ? 'left' : '' })
    if (column.plain) {
      th.textContent = column.label
    } else {
      const sorted = session.ammoSort.key === column.key
      th.classList.toggle('sorted', sorted)
      th.setAttribute('aria-sort', sorted ? (session.ammoSort.asc ? 'ascending' : 'descending') : 'none')
      th.append(h('button', { type: 'button', class: 'th-sort', onclick: () => session.sortAmmoBy(column.key) },
        `${column.label} `,
        sorted ? icon(session.ammoSort.asc ? 'caret-up' : 'caret-down', 'icon sort') : icon('caret-up-down', 'icon sort faint'),
      ))
    }
    head.append(th)
  }

  const body = h('tbody')
  for (const row of list) {
    const { calibre } = row
    const loads = calibre.loads?.length ? calibre.loads : ['FMJ']
    const expanded = !!session.expanded[row.key]
    const iconName = calibre.roundIcons?.FMJ ?? Object.values(calibre.roundIcons ?? {})[0]

    const iconNode = iconName ? h('img', { class: 'ammo-icon', src: `/wardogs/icons/${iconName}.webp`, alt: '', loading: 'lazy' }) : h('span', { class: 'ammo-icon' })
    if (iconName) iconNode.addEventListener('error', () => { iconNode.style.visibility = 'hidden' })
    const sub = calibre.pellets
      ? `${calibre.pellets} 粒 × ${calibre.baseDamage}`
      : (calibre.armourClass ? `${calibre.armourClass.replace('Arms.', '')} 级武器` : '')
    const expand = h('button', {
      type: 'button',
      class: 'ammo-expand',
      'aria-expanded': String(expanded),
      onclick: () => session.toggleExpanded(row.key),
    },
      iconNode,
      h('span', { class: 'min0' }, h('b', { class: 'block ellipsis', text: calibre.label ?? row.key }), h('small', { class: 'dim block', text: sub })),
      icon('caret-down', `icon caret ${expanded ? 'flip' : ''}`),
    )

    const users = h('div', { class: 'ammo-users' })
    for (const weapon of row.users) {
      const slug = slugOf(weapon)
      const on = session.selected.includes(slug)
      const button = h('button', {
        type: 'button',
        class: `user-chip ${on ? 'on' : ''}`,
        'aria-pressed': String(on),
        disabled: !on && session.isFull,
        title: on ? '从比较里移除' : (session.isFull ? '先移除一把才能再加' : '加入比较'),
        onclick: () => session.toggle(slug),
      }, on ? checkMark(true, 'xs') : null, ` ${weapon.name}`)
      if (on) button.style.setProperty('--c', session.colours[slug])
      users.append(button)
    }

    const bar = h('i', { class: 'dmg-bar' })
    bar.style.width = `${row.damage / maxDamage * 100}%`
    const damage = h('span', { class: 'dmg' }, h('b', null, icon('crosshair-simple', 'icon faint'), ` ${row.damage}`), bar)

    const loadTags = h('span', { class: 'load-tags' }, loads.map((round) => roundTag(round, { standard: loads.length <= 1 })))
    const velocity = row.vmax === null ? '-' : (row.vmin === row.vmax ? `${Math.round(row.vmax)} m/s` : `${Math.round(row.vmin)}-${Math.round(row.vmax)} m/s`)

    body.append(h('tr', null,
      h('td', { class: 'left' }, expand),
      h('td', { class: 'left' }, users),
      h('td', { class: 'num' }, damage),
      h('td', { class: 'left' }, loadTags),
      h('td', { class: 'num dim', text: velocity }),
      h('td', { class: 'num dim', text: calibre.mass ? `${(calibre.mass * 1000).toFixed(1)} g` : '-' }),
      h('td', { class: 'num dim', text: calibre.diameter ? `${(calibre.diameter * 10).toFixed(1)} mm` : '-' }),
    ))

    if (expanded && calibre.combat) {
      for (const round of loads) {
        const combat = calibre.combat[round]
        if (!combat) continue
        const armourMin = Math.min(1, ...Object.entries(combat.vsTier).filter(([tier]) => tier.startsWith('Armor.')).map(([, value]) => value))
        const helmetMin = Math.min(1, ...Object.entries(combat.vsTier).filter(([tier]) => tier.startsWith('Helmet.')).map(([, value]) => value))
        const fact = (label, value, cls) => h('span', null, `${label} `, h('b', { class: cls, text: value }))
        body.append(h('tr', { class: 'ammo-detail' },
          h('td', { class: 'left indent' }, roundTag(round, { standard: loads.length <= 1 }), h('span', { class: 'dim', text: ` ${roundLabel(data, round)}` })),
          h('td', { class: 'left', colSpan: 6 }, h('span', { class: 'fact-grid' },
            fact('肉伤', `×${combat.bare}`, factorClass(combat.bare)),
            fact('穿护甲', tierRange(combat.vsTier, 'Armor.'), factorClass(armourMin)),
            fact('穿头盔', tierRange(combat.vsTier, 'Helmet.'), factorClass(helmetMin)),
            fact('护甲减伤', `×${combat.penScalar}`, penClass(combat.penScalar)),
            fact('磨甲', `×${combat.plateArmor}`, 'strong'),
            fact('磨盔', `×${combat.plateHelmet}`, 'strong'),
          )),
        ))
      }
    }
  }

  const table = h('table', { class: 'ammo-table' }, h('thead', null, head), body)
  return h('div', { class: 'view-ammo table-scroll' }, table)
}
