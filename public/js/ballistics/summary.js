/**
 * 结果区上半部分：名次卡、当前条件摘要、视图切换、着色选项、效果图例。
 * 这些不属于任何一个具体视图，切视图时它们不动。
 */
import { icon } from '../ui.js'
import { h, plateBadge, rankBadge, roundGlyph, roundTag, weaponIcon } from './dom.js'
import {
  MAX_PICKED, ROUND_SHORT, SHOT_BANDS, TIME_BANDS, armourName, calibreLabel, formatSeconds, formatShots,
  hitLabel, shotBand,
} from './engine.js'
import { VIEWS } from './state.js'

const VIEW_LABEL = {
  table: '击杀弹数',
  compare: '逐发比较',
  zones: '部位伤害',
  range: '距离曲线',
  ammo: '弹药',
}

const VIEW_ICON = {
  compare: 'person',
  zones: 'crosshair-simple',
  range: 'chart-line',
}

/* ── 名次 ─────────────────────────────────────────────── */

function addCard(session, className) {
  const node = h('button', { type: 'button', class: `add-card ${className}`, onclick: () => session.set({ pickerOpen: true }) })
  node.append(
    h('span', { class: 'ring' }, icon('plus')),
    h('span', { class: 'strong', text: '添加一把武器来比较' }),
    h('span', { class: 'dim', text: `${session.selected.length} / ${MAX_PICKED}` }),
  )
  return node
}

function bandChip(band, { hideLabelOnNarrow = false } = {}) {
  const chip = h('span', { class: 'band-chip', title: band.label })
  const dot = h('i')
  dot.style.background = band.colour
  chip.append(dot, h('span', { class: hideLabelOnNarrow ? 'narrow-hide' : '', text: band.label }))
  return chip
}

/** 紧凑的一行一把枪，窄屏用 */
function rankRows(session) {
  const multi = session.loads.length > 1
  const list = h('div', { class: 'rank-rows' })
  session.ranked.forEach((entry, index) => {
    const sol = entry.best.sol
    const band = shotBand(sol.shots)
    const row = h('div', { class: 'rank-row' })
    row.style.setProperty('--c', entry.colour)
    const name = h('span', { class: 'rname' }, h('span', { text: entry.weapon.name }))
    if (multi) name.append(roundTag(entry.best.round, { standard: entry.best.standard }))
    row.append(
      rankBadge(index + 1, 'sm'),
      h('i', { class: 'cbar' }),
      name,
      h('span', { class: 'num' }, formatShots(sol.shots), h('small', { text: '发' })),
      h('span', { class: 'num' }, formatSeconds(sol.time), h('small', { text: 's' })),
      bandChip(band, { hideLabelOnNarrow: true }),
    )
    list.append(row)
  })
  return list
}

/** 宽屏的名次卡，每把枪一张 */
function rankCards(session) {
  const multi = session.loads.length > 1
  const wrap = h('div', { class: 'rank-cards' })
  session.ranked.forEach((entry, index) => {
    const sol = entry.best.sol
    const band = shotBand(sol.shots)
    const card = h('article', { class: 'rank-card' })
    card.style.setProperty('--c', entry.colour)
    card.append(
      h('span', { class: 'stripe' }),
      rankBadge(index + 1),
      weaponIcon(session, entry.slug, 'wicon lg'),
      h('div', { class: 'rank-title' },
        h('div', { class: 'strong ellipsis', text: entry.weapon.name }),
        h('div', { class: 'dim ellipsis', text: calibreLabel(session.data, entry.best.calibre) }),
      ),
    )

    if (multi) {
      // 多种弹时一张卡里列出每种弹的结果，最好的那行亮一些
      const table = h('table', { class: 'rank-loads' })
      const body = h('tbody')
      for (const round of session.loads) {
        const fallback = !entry.list.some((row) => session.loads.includes(row.round)) && round === session.loads[0]
        const row = entry.list.find((item) => item.round === round) ?? (fallback ? entry.best : undefined)
        if (!row) {
          body.append(h('tr', { class: 'faint' },
            h('td', null, roundTag(round, { className: 'faint' })),
            h('td', { title: '这把枪不卖这种弹', text: '-' }), h('td', { text: '-' }), h('td', { text: '-' }), h('td'),
          ))
          continue
        }
        const rowBand = shotBand(row.sol.shots)
        const shots = h('b', { text: formatShots(row.sol.shots) })
        shots.style.color = Number.isFinite(row.sol.shots) ? rowBand.text : 'var(--dim)'
        shots.title = rowBand.label
        body.append(h('tr', { class: row === entry.best ? 'best' : '' },
          h('td', null, roundTag(row.round, { standard: row.standard })),
          h('td', null, shots, h('small', { text: '发' })),
          h('td', null, h('b', { text: formatSeconds(row.sol.time) }), h('small', { text: 's' })),
          h('td', null, h('b', { text: row.sol.damage ? String(Math.round(row.sol.damage)) : '-' }), h('small', { text: '/发' })),
          h('td', { class: 'w7' }, plateBadge(row.sol)),
        ))
      }
      table.append(body)
      card.append(table)
    } else {
      card.append(
        h('div', { class: 'rank-big' },
          h('div', null, h('b', { text: formatShots(sol.shots) }), h('span', { class: 'cap', text: '发' })),
          h('div', { class: 'center' }, h('b', null, formatSeconds(sol.time), h('small', { text: 's' })), h('span', { class: 'cap', text: '击杀' })),
          h('div', { class: 'end' }, h('b', { text: sol.damage ? String(Math.round(sol.damage)) : '-' }), h('span', { class: 'cap', text: '每发' })),
        ),
        h('div', { class: 'rank-foot' }, bandChip(band), plateBadge(sol)),
      )
    }
    wrap.append(card)
  })
  if (session.ranked.length < 3) wrap.append(addCard(session, 'card'))
  return wrap
}

export function renderRanks(session) {
  if (session.ranked.length === 0) {
    return h('p', { class: 'dim', text: '选一把武器看看它的表现。' })
  }
  // 两种布局都渲染，由容器宽度决定显示哪种
  return h('div', { class: 'ranks' }, rankRows(session), rankCards(session))
}

/* ── 条件摘要 ─────────────────────────────────────────── */

export function renderChips(session, { onShare }) {
  const { data, engagement, covering } = session
  const armourText = covering
    ? `${armourName(covering.name)}`
    : '无护甲'
  const share = h('button', { type: 'button', class: 'slim share', onclick: onShare })
  share.append(icon('link-simple'), ' 分享此视图')
  return h('div', { class: 'chips' },
    h('span', null, h('b', { text: hitLabel(data, engagement.hit) })),
    h('span', null, h('b', { text: armourText }), covering ? h('span', { class: 'dim', text: ` ${covering.reduction}% / ${covering.durability}` }) : null),
    h('span', null, h('b', { text: `${engagement.range} m` })),
    h('span', null, h('b', { text: session.loads.map((round) => ROUND_SHORT[round] ?? round).join(' + ') })),
    share,
  )
}

/* ── 视图切换与选项 ───────────────────────────────────── */

function viewIcon(view) {
  if (view === 'table') return roundGlyph(undefined, 'tab-glyph')
  if (view === 'ammo') {
    return h('span', { class: 'tab-ammo' }, h('img', { src: '/wardogs/icons/t_ui_icon_ammobox_5_56x45mm_fmj.webp', alt: '' }))
  }
  return icon(VIEW_ICON[view])
}

export function renderTabs(session) {
  const tabs = h('div', { class: 'tabs', role: 'tablist' })
  for (const view of VIEWS) {
    const on = session.view === view
    tabs.append(h('button', {
      type: 'button',
      role: 'tab',
      class: `tab ${on ? 'on' : ''}`,
      'aria-selected': String(on),
      onclick: () => session.set({ view }),
    }, viewIcon(view), ` ${VIEW_LABEL[view]}`))
  }
  return tabs
}

export function renderControls(session) {
  if (['ammo', 'compare', 'zones'].includes(session.view)) return null
  const wrap = h('div', { class: 'controls' })
  if (session.view === 'table') {
    wrap.append(segmentedInline({
      label: '显示范围',
      options: [
        { key: 'all', label: '全部' },
        { key: 'picked', label: '已选', disabled: session.selected.length === 0 },
      ],
      value: session.pickedOnly ? 'picked' : 'all',
      onChange: (key) => session.set({ pickedOnly: key === 'picked' }),
    }))
  }
  wrap.append(segmentedInline({
    label: '按什么着色',
    options: [
      { key: 'shots', label: '击杀弹数' },
      { key: 'time', label: '击杀时间' },
    ],
    value: session.metric,
    onChange: (key) => session.set({ metric: key }),
  }))
  return wrap
}

function segmentedInline({ label, options, value, onChange }) {
  const node = h('div', { class: 'seg inline', role: 'group', 'aria-label': label })
  for (const option of options) {
    node.append(h('button', {
      type: 'button',
      class: 'seg-item',
      'aria-pressed': String(option.key === value),
      disabled: !!option.disabled,
      text: option.label,
      onclick: () => onChange(option.key),
    }))
  }
  return node
}

/* ── 效果图例 ─────────────────────────────────────────── */

let legendOpen = false

export function renderLegend(metric) {
  const bands = metric === 'time' ? TIME_BANDS : SHOT_BANDS
  const scale = metric === 'time' ? '击杀时间' : '击杀弹数'

  const box = h('div', { class: `legend ${legendOpen ? 'open' : ''}` })
  const head = h('button', { type: 'button', class: 'legend-head', 'aria-expanded': String(legendOpen) })
  const chips = h('span', { class: 'legend-chips' })
  for (const band of bands) {
    const chip = h('span', { class: 'legend-chip', text: band.short, title: band.label })
    chip.style.background = `color-mix(in srgb, ${band.colour} 14%, transparent)`
    chip.style.color = band.colour
    chips.append(chip)
  }
  head.append(chips, h('span', { class: 'legend-title', text: `${scale}刻度` }), icon('caret-down', 'icon caret'))

  const table = h('table', { class: 'legend-table' })
  table.append(h('thead', null, h('tr', null, h('th', { text: scale }), h('th', { text: '效果' }), h('th', { text: '含义' }))))
  const body = h('tbody')
  for (const band of bands) {
    const range = h('td', { class: 'strong', text: band.range })
    range.style.background = `color-mix(in srgb, ${band.colour} 14%, transparent)`
    range.style.color = band.colour
    const label = h('td', { text: band.label })
    label.style.color = band.colour
    body.append(h('tr', null, range, label, h('td', { class: 'dim', text: band.description })))
  }
  table.append(body)
  const foot = h('p', { class: 'dim legend-note', text: '这是"该带什么枪"的参考，不是精确计数。所有数字都来自解出的伤害，第一发打得好或漏了一粒霰弹，真实数字就会变。' })
  const bodyNode = h('div', { class: 'legend-body' }, h('div', { class: 'legend-scroll' }, table), foot)

  head.addEventListener('click', () => {
    legendOpen = !legendOpen
    box.classList.toggle('open', legendOpen)
    head.setAttribute('aria-expanded', String(legendOpen))
  })
  box.append(head, bodyNode)
  return box
}

/** 页脚的使用说明，照原站的四段 */
export function renderNotes() {
  return h('div', { class: 'notes' },
    h('p', { text: '最多选五把武器，再设定命中部位、头盔与护甲等级和距离。' }),
    h('p', { text: '"击杀弹数"把所有武器在各个护甲等级下排成一表；上面的名次卡和"逐发比较"则把你选的枪并排放在一起，给出每发伤害、击杀弹数和击杀时间。' }),
    h('p', { text: '击杀时间算进了子弹飞行时间，所以慢弹在远距离会吃亏。' }),
    h('p', { text: '勾选多种弹可以看 FMJ、HP、AP 之间的取舍；"距离曲线"把一切画在距离轴上；"弹药"一次比较所有口径。' }),
  )
}
