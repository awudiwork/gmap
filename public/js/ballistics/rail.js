/**
 * 左侧设置栏：三段可折叠的面板，武器、命中部位（含弹种和护甲）、距离。
 * 每次会话变化整体重画；只有距离滑杆在拖动中不重画，见 index.js 的轻量刷新。
 */
import { el, icon } from '../ui.js'
import { bodyMap } from './bodymap.js'
import { checkMark, h, roundGlyph, segmented, weaponIcon } from './dom.js'
import {
  MAX_PICKED, MAX_RANGE, ROUND_SHORT, armourName, armourShort, calibreFor, calibreLabel, classShort, hitLabel,
  levelOf, roundLabel, tierLevel,
} from './engine.js'

const RANGE_PRESETS = [10, 50, 100, 200, 500, 1000]

/** 折叠状态跨重画保留 */
const open = { weapons: true, target: true, range: true }

function section({ key, title, summary, action, body }) {
  const node = h('section', { class: `rail-sec ${open[key] ? 'open' : ''}` })
  const head = h('div', { class: 'rail-sec-head' })
  const toggle = h('button', { type: 'button', class: 'rail-sec-toggle', 'aria-expanded': String(open[key]) })
  toggle.append(h('span', { class: 'rail-sec-title', text: title }))
  if (!open[key]) toggle.append(h('span', { class: 'rail-sec-summary', text: summary }))
  toggle.append(icon('caret-down', 'icon caret'))
  toggle.addEventListener('click', () => {
    open[key] = !open[key]
    node.classList.toggle('open', open[key])
    toggle.setAttribute('aria-expanded', String(open[key]))
    // 只改本段的开合，不劳烦整栏重画
    const summaryNode = toggle.querySelector('.rail-sec-summary')
    if (open[key]) summaryNode?.remove()
    else toggle.insertBefore(h('span', { class: 'rail-sec-summary', text: summary }), toggle.lastChild)
  })
  head.append(toggle)
  if (action) head.append(action)
  node.append(head, h('div', { class: 'rail-sec-body' }, body))
  return node
}

/* ── 武器 ─────────────────────────────────────────────── */

function weaponsBody(session, onOpenPicker) {
  // 不叫 .picked：表格里选中的行也用这个词，样式会串
  const list = h('ul', { class: 'picked-list' })
  for (const weapon of session.picked) {
    const slug = weapon.slug ?? weapon.id
    const row = h('li', { class: 'picked-row' })
    const bar = h('i', { class: 'cbar' })
    bar.style.background = session.colours[slug] ?? ''
    const name = h('span', { class: 'pname', text: weapon.name, title: weapon.name })

    let ammo
    if (weapon.shells && weapon.shells.length > 1) {
      // 霰弹枪可以换弹：默认口径排前面
      ammo = h('span', { class: 'shells' })
      const shells = [...weapon.shells].sort((a, b) => +(b === weapon.calibre) - +(a === weapon.calibre))
      for (const shell of shells) {
        const on = calibreFor(weapon, session.engagement) === shell
        ammo.append(h('button', {
          type: 'button',
          class: `shell ${on ? 'on' : ''}`,
          'aria-pressed': String(on),
          text: calibreLabel(session.data, shell).replace(/^12g /, ''),
          onclick: () => session.setEngagement({ shell }),
        }))
      }
    } else {
      ammo = h('span', { class: 'pcal', text: calibreLabel(session.data, weapon.calibre) })
    }

    const remove = h('button', { type: 'button', class: 'bare premove', 'aria-label': `移除 ${weapon.name}`, onclick: () => session.toggle(slug) })
    remove.append(icon('x'))
    row.append(bar, weaponIcon(session, slug), name, ammo, remove)
    list.append(row)
  }
  if (session.selected.length < MAX_PICKED) {
    const add = h('button', { type: 'button', class: 'padd', onclick: onOpenPicker })
    add.append(icon('plus'), ` 添加武器（${session.selected.length} / ${MAX_PICKED}）`)
    list.append(h('li', { class: 'padd-row' }, add))
  }
  return list
}

/* ── 命中部位 ─────────────────────────────────────────── */

function roundsBody(session) {
  const { data } = session
  const calibres = [...new Set(session.picked.map((weapon) => calibreFor(weapon, session.engagement)))]
    .map((key) => (key ? data.calibres[key] : undefined))
    .filter((calibre) => !!calibre)

  const group = h('div', { class: 'rounds', role: 'group', 'aria-label': '弹种' })
  for (const round of data.rounds) {
    const on = session.loads.includes(round.key)
    const missing = calibres.length > 0 && calibres.every((calibre) => calibre.loads?.length && !calibre.loads.includes(round.key))
    const lines = [roundLabel(data, round.key)]
    for (const calibre of calibres) {
      const combat = calibre.combat?.[round.key]
      if (!combat) continue
      lines.push(`${calibre.label ?? calibre.key}：肉伤 ×${combat.bare}，穿甲 ×${combat.vsTier['Armor.Medium'] ?? 1}，磨甲 ×${combat.plateArmor}`)
    }
    if (missing) lines.push('选中的武器都不卖这种弹')

    const button = h('button', {
      type: 'button',
      role: 'checkbox',
      'aria-checked': String(on),
      class: `round ${on ? 'on' : ''} ${missing ? 'missing' : ''}`,
      title: lines.join('\n'),
      onclick: () => session.toggleLoad(round.key),
    })
    button.append(checkMark(on), h('span', { class: 'round-name' }, roundGlyph(round.key), ` ${ROUND_SHORT[round.key] ?? round.key}`))
    group.append(button)
  }
  return group
}

function armourOptions(data, slot) {
  const items = data.armour.filter((item) => item.slot === slot)
  const noneTitle = slot === 'armor'
    ? '不穿护甲，减伤 0%。\n吉利服也算在这里：它没有防板、不减伤，只有隐蔽（配头套可躲过红外侦测，瞄准时间 ×0.8，准星晃动 ×1.15）'
    : '不戴头盔，减伤 0%。\n吉利头套也算在这里：它没有防板、不减伤，只有隐蔽（配套装可躲过红外侦测，瞄准时间 ×0.8，准星晃动 ×1.15）'
  return [
    { key: '0', label: '无', sub: '或吉利服', title: noneTitle },
    ...[1, 2, 3, 4].map((level) => {
      const item = items.find((candidate) => tierLevel(candidate) === level)
      return {
        key: String(level),
        label: `L${level}`,
        sub: item ? `${item.reduction}%` : '',
        disabled: !item,
        title: item ? `${armourName(item.name)}：减伤 ${item.reduction}%，耐久 ${item.durability}` : undefined,
      }
    }),
  ]
}

function targetBody(session) {
  const { data, engagement } = session
  const zones = data.hitLocations.map((zone) => zone.key)
  const map = bodyMap({
    zones,
    hit: engagement.hit,
    covered: session.coveredZones,
    label: (key) => hitLabel(data, key),
    onPick: (key) => session.setEngagement({ hit: key }),
    className: 'pickmap',
  })

  // 部位倍率：选中的枪按武器类各不相同，给个范围
  const mults = [...new Set(session.picked.map((weapon) => weapon.weaponClass).filter((cls) => !!cls))]
    .map((cls) => ({ cls, value: data.hitboxes[cls]?.[engagement.hit] }))
    .filter((entry) => entry.value !== null && entry.value !== undefined)
  let damage
  if (mults.length === 0) {
    damage = h('span', { class: 'dim', text: '无武器' })
  } else {
    const low = Math.min(...mults.map((entry) => entry.value))
    const high = Math.max(...mults.map((entry) => entry.value))
    const tip = [`${hitLabel(data, engagement.hit)}部位倍率`, ...[...mults].sort((a, b) => b.value - a.value).map((entry) => `${classShort(entry.cls)} ×${entry.value.toFixed(2)}`)].join('\n')
    damage = h('span', { class: 'help', title: tip })
    if (low === high) damage.append(`×${low.toFixed(2)} `, h('span', { class: 'dim', text: classShort(mults[0].cls) }))
    else damage.append(`×${low.toFixed(2)} 至 ×${high.toFixed(2)} `, h('span', { class: 'dim', text: '按武器类' }))
  }

  const cover = h('span', { class: 'cover' })
  if (session.covering) {
    cover.append(
      icon('shield-check'),
      ` ${armourShort(session.covering.name)} ${session.covering.slot === 'helmet' ? '头盔' : '护甲'} `,
      h('span', { class: 'dim', text: `${session.covering.reduction}% / ${session.covering.durability}` }),
    )
  } else {
    cover.append(icon('shield-slash'), h('span', { class: 'dim', text: ' 无护甲' }))
  }

  const facts = h('dl', { class: 'facts' },
    h('dt', { text: '部位' }), h('dd', { class: 'strong', text: hitLabel(data, engagement.hit) }),
    h('dt', { text: '伤害' }), h('dd', null, damage),
    h('dt', { text: '覆盖' }), h('dd', null, cover),
  )

  const rounds = h('div', { class: 'fstack' }, h('span', { class: 'label', text: '弹种' }), roundsBody(session))
  const top = h('div', { class: 'target-grid' }, map, h('div', { class: 'target-side' }, facts, rounds))

  const helmet = h('div', { class: 'fstack' },
    h('span', { class: 'label', text: '头盔' }),
    segmented({
      label: '头盔',
      options: armourOptions(data, 'helmet'),
      value: String(levelOf(data, engagement.helmet)),
      onChange: (key) => session.setLevel('helmet', Number(key)),
    }),
  )
  const armour = h('div', { class: 'fstack' },
    h('span', { class: 'label', text: '护甲' }),
    segmented({
      label: '护甲',
      options: armourOptions(data, 'armor'),
      value: String(levelOf(data, engagement.armour)),
      onChange: (key) => session.setLevel('armor', Number(key)),
    }),
  )
  return h('div', { class: 'target' }, top, helmet, armour)
}

/* ── 距离 ─────────────────────────────────────────────── */

function rangeBody(session) {
  const output = h('output', { class: 'range-out', text: `${session.engagement.range} m` })
  const slider = h('input', {
    type: 'range', min: 0, max: MAX_RANGE, step: 10,
    class: 'range-slider',
    'aria-label': '距离，米',
  })
  slider.value = String(session.engagement.range)
  slider.style.setProperty('--fill', `${session.engagement.range / MAX_RANGE * 100}%`)

  let presets = null
  const paintPresets = (range) => {
    for (const button of presets.querySelectorAll('.seg-item')) {
      button.setAttribute('aria-pressed', String(button.dataset.key === String(range)))
    }
  }
  // 拖动中只更新数字和结果区，不重画本栏，否则滑杆会在手里被换掉
  slider.addEventListener('input', () => {
    const range = Number(slider.value)
    output.textContent = `${range} m`
    slider.style.setProperty('--fill', `${range / MAX_RANGE * 100}%`)
    paintPresets(range)
    session.setEngagement({ range }, { light: true })
  })
  slider.addEventListener('change', () => session.touch())

  presets = segmented({
    label: '常用距离',
    className: 'presets',
    options: RANGE_PRESETS.map((value) => ({ key: String(value), label: String(value) })),
    value: String(session.engagement.range),
    onChange: (key) => session.setEngagement({ range: Number(key) }),
  })
  for (const button of presets.querySelectorAll('.seg-item')) button.dataset.key = button.textContent

  const track = h('div', { class: 'range-row' }, slider, output)
  return h('div', { class: 'fstack' }, track, presets)
}

/* ── 整栏 ─────────────────────────────────────────────── */

/**
 * @param {import('./state.js').Session} session
 * @param {{ onOpenPicker: () => void }} handlers
 */
export function renderRail(session, { onOpenPicker }) {
  const summaries = {
    weapons: session.picked.map((weapon) => weapon.name).join(', ') || '还没选',
    target: [
      hitLabel(session.data, session.engagement.hit),
      session.covering ? armourShort(session.covering.name) : '无护甲',
      session.loads.map((round) => ROUND_SHORT[round] ?? round).join('+'),
    ].join(', '),
    range: `${session.engagement.range} m`,
  }

  const change = h('button', { type: 'button', class: 'slim', text: '更换', onclick: onOpenPicker })
  const root = el('div', 'rail-secs')
  root.append(
    section({ key: 'weapons', title: '武器', summary: summaries.weapons, action: change, body: weaponsBody(session, onOpenPicker) }),
    section({ key: 'target', title: '命中部位', summary: summaries.target, body: targetBody(session) }),
    section({ key: 'range', title: '距离', summary: summaries.range, body: rangeBody(session) }),
  )
  return root
}
