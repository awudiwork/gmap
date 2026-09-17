/**
 * 部位伤害表：行是十二个部位，列是选中的枪（和弹种），点一行就把命中部位设成它。
 * 两把枪以内每把三列（伤害 / 弹数 / 时间），再多就压成一格。
 */
import { icon } from '../../ui.js'
import { h, plateBadge, roundGlyph, roundTag } from '../dom.js'
import { coveringArmour, falloffAt, formatSeconds, formatShots, hitLabel, shotBand, solve } from '../engine.js'

/** 小数只在小于 0.95 时保留一位，不然四舍五入成整数 */
const damageText = (value) => (value > 0 && value < 0.95 ? value.toFixed(1) : String(Math.round(value)))

function comboHead(session, item) {
  const node = h('span', { class: 'zh-combo' })
  const name = h('b', { text: item.combo.weapon.name })
  name.style.color = item.combo.colour ?? ''
  node.append(name)
  if (item.tagged) node.append(roundTag(item.combo.round, { standard: item.combo.standard }))
  if (item.pellets) node.append(h('span', { class: 'dim', title: '假设每一粒霰弹都命中', text: '†' }))
  if (item.falloff < 1) {
    node.append(h('span', { class: 'penalty', title: `${session.engagement.range} m 处的距离衰减`, text: `${Math.round(item.falloff * 100)}%` }))
  }
  return node
}

export function renderZones(session) {
  if (!session.combos.length) return null
  const { data, engagement } = session
  const multiLoads = session.loads.length > 1
  const wide = session.combos.length <= 2
  const showBare = session.combos.length === 1 && !!(engagement.armour || engagement.helmet)

  const items = session.combos.map((combo) => ({
    combo,
    pellets: (data.calibres[combo.calibre ?? '']?.pellets ?? 1) > 1,
    falloff: falloffAt(combo.weapon.falloff, engagement.range),
    tagged: multiLoads || combo.standard || combo.round !== session.loads[0],
  }))
  const zebra = (index) => (items.length > 1 && index % 2 === 0 ? 'zebra' : '')

  const thead = h('thead')
  if (wide) {
    const groupRow = h('tr', null, h('td'))
    items.forEach((item, index) => {
      groupRow.append(h('th', { scope: 'colgroup', colSpan: showBare ? 4 : 3, class: `zh-group ${zebra(index)}` }, comboHead(session, item)))
    })
    const labelRow = h('tr', null, h('th', { scope: 'col', class: 'left', text: '部位' }))
    items.forEach((_, index) => {
      labelRow.append(h('th', { scope: 'col', class: zebra(index), text: '伤害' }))
      if (showBare) labelRow.append(h('th', { scope: 'col', class: zebra(index), text: '无甲' }))
      labelRow.append(h('th', { scope: 'col', class: zebra(index), text: '弹数' }), h('th', { scope: 'col', class: zebra(index), text: '时间' }))
    })
    thead.append(groupRow, labelRow)
  } else {
    const row = h('tr', null, h('th', { scope: 'col', class: 'left', text: '部位' }))
    items.forEach((item, index) => row.append(h('th', { scope: 'col', class: zebra(index) }, comboHead(session, item))))
    thead.append(row)
  }

  const tbody = h('tbody')
  for (const location of data.hitLocations) {
    const at = { ...engagement, hit: location.key }
    const stopper = coveringArmour(data, at)
    const current = engagement.hit === location.key
    const tr = h('tr', { class: current ? 'cur' : '', onclick: () => session.setEngagement({ hit: location.key }) })
    const th = h('th', { scope: 'row', class: `left ${current ? 'hl' : ''}` }, `${hitLabel(data, location.key)} `)
    if (stopper) th.append(h('small', { class: 'dim', title: stopper.name, text: `-${stopper.reduction}%` }))
    tr.append(th)

    items.forEach((item, index) => {
      const sol = solve(data, item.combo.weapon, { ...at, round: item.combo.round })
      const bare = showBare ? solve(data, item.combo.weapon, { ...at, round: item.combo.round, armour: null, helmet: null }) : null
      const finite = Number.isFinite(sol.shots)
      const band = shotBand(sol.shots)

      if (wide) {
        tr.append(h('td', { class: `num strong ${zebra(index)}`, title: '每发伤害' }, icon('crosshair-simple', 'icon faint'), ` ${finite ? damageText(sol.damage) : '-'}`))
        if (showBare) {
          tr.append(h('td', { class: `num dim ${zebra(index)}`, title: '无护甲时的每发伤害' }, icon('crosshair-simple', 'icon faint'), ` ${bare && Number.isFinite(bare.shots) ? damageText(bare.damage) : '-'}`))
        }
        const shots = h('td', { class: `num strong ${finite ? '' : zebra(index)}` })
        if (finite) {
          shots.style.background = `color-mix(in srgb, ${band.colour} 14%, transparent)`
          shots.style.color = band.colour
          shots.title = band.label
        }
        shots.append(roundGlyph(undefined, finite ? '' : 'faint'), ` ${formatShots(sol.shots)} `, finite ? plateBadge(sol) : null)
        tr.append(shots)
        const time = h('td', { class: `num dim ${zebra(index)}`, title: '击杀时间' }, icon('timer', 'icon faint'))
        time.append(finite ? h('span', null, ` ${formatSeconds(sol.time)}`, h('small', { text: 's' })) : ' -')
        tr.append(time)
      } else {
        const cell = h('td', { class: `num ${zebra(index)}` })
        if (finite) {
          const shots = h('span', { class: 'z-shots', title: band.label }, roundGlyph(undefined), ` ${formatShots(sol.shots)} `, plateBadge(sol))
          shots.style.color = band.colour
          cell.append(h('span', { class: 'z-compact' },
            h('span', { class: 'strong', title: '每发伤害' }, icon('crosshair-simple', 'icon faint'), ` ${damageText(sol.damage)}`),
            shots,
            h('span', { class: 'dim', title: '击杀时间' }, icon('timer', 'icon faint'), ` ${formatSeconds(sol.time)}s`),
          ))
        } else {
          cell.append(h('span', { class: 'dim', text: '-' }))
        }
        tr.append(cell)
      }
    })
    tbody.append(tr)
  }

  const table = h('table', { class: 'zones-table' }, thead, tbody)
  return h('div', { class: 'view-zones table-scroll' }, table)
}
