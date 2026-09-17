/**
 * 计算器界面的基础构件：节点构造器和几个到处复用的小徽标。
 *
 * 数据里的字符串（武器名、口径）一律走 textContent，不拼 innerHTML。
 * 这里的 SVG 是原站的几何：子弹剪影、名次盾、护甲盾。图标库里没有对应的形状，
 * 而这几个形状本身就是界面的语言，玩家一眼认得出。
 */
import { el } from '../ui.js'
import { ROUND_SHORT, armourName } from './engine.js'

const SVG_NS = 'http://www.w3.org/2000/svg'

export function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    node.setAttribute(key, String(value))
  }
  return node
}

/**
 * 节点构造器。props 里 class / title / style 直接设，on* 是事件，aria-* 和 data-* 原样设属性，
 * 其余当 DOM 属性赋值。子节点可以是字符串、节点、数组或 null。
 */
export function h(tag, props = null, ...children) {
  const node = document.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue
      if (key === 'class') node.className = value
      else if (key === 'style') node.style.cssText = value
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
      else if (key === 'role' || key.startsWith('aria-') || key.startsWith('data-')) node.setAttribute(key, String(value))
      else if (key === 'text') node.textContent = value
      else node[key] = value
    }
  }
  append(node, children)
  return node
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

/* ── 子弹剪影 ─────────────────────────────────────────── */

const ROUND_GLYPH = {
  FMJ: { w: 37, h: 49, d: 'M16 0L20 0L20 13L13 10L13 8L16 8ZM22 12L24 12L24 14L22 14ZM0 21L20 21L19 22L19 27L20 28L19 29L0 29ZM22 21L33 22L33 23L36 23L37 26L30 27L30 28L22 28ZM22 35L24 37L22 37ZM17 37L20 37L20 49L16 49L16 41L12 41L14 38L17 38Z' },
  HollowPoint: { w: 47, h: 42, d: 'M44 0L47 0L47 4L46 4L44 12L43 12L43 25L42 25L42 27L38 30L38 32L35 34L35 36L31 39L30 42L28 42L27 39L32 34L33 31L28 33L28 34L26 34L26 35L24 35L24 36L21 36L21 37L19 37L17 39L14 39L15 35L17 35L17 34L19 34L19 33L21 33L21 32L23 32L23 31L25 31L25 30L31 28L32 26L34 26L34 25L36 25L36 24L41 22L39 19L37 19L36 17L31 15L29 12L24 10L23 6L28 8L29 10L39 14ZM36 3L39 3L37 11L35 11L34 8L33 8L34 4L36 4ZM0 18L18 18L18 25L0 25ZM21 18L34 20L35 22L30 23L30 24L23 24L23 25L21 25Z' },
  ArmorPiercing: { w: 36, h: 44, d: 'M14 0L27 1L27 6L25 8L23 17L22 18L12 18L10 28L4 33L2 28L1 28L1 24L0 24L0 4L1 3L5 3L5 2L14 1ZM33 3L36 4L36 25L35 25L35 29L34 29L33 33L31 34L31 36L27 40L25 40L24 42L22 42L20 44L16 44L16 43L12 42L11 40L9 40L8 36L15 31L16 23L26 23Z' },
}

/** 整发子弹的剪影，没指定弹种时画的是它 */
const CARTRIDGE = [
  'M12 0.5C8.4 4.2 4.7 9.4 3 14.6V22h18v-7.4C19.3 9.4 15.6 4.2 12 0.5Z',
  'M0 26h24v33H0z',
  'M0 63h24v3.5l-1 5.5H1l-1-5.5z',
]

/** 弹种剪影。FMJ / HP / AP 各有一个形状，不传弹种时是整发子弹 */
export function roundGlyph(round, className = '') {
  const shape = round ? ROUND_GLYPH[round] : undefined
  if (shape) {
    const node = svg('svg', { viewBox: `0 0 ${shape.w} ${shape.h}`, fill: 'currentColor', 'aria-hidden': 'true', class: `glyph ${className}` })
    node.style.width = `${(shape.w / shape.h * 1.15).toFixed(2)}em`
    node.append(svg('path', { d: shape.d }))
    return node
  }
  const node = svg('svg', { viewBox: '0 0 24 72', fill: 'currentColor', 'aria-hidden': 'true', class: `glyph cartridge ${className}` })
  for (const d of CARTRIDGE) node.append(svg('path', { d }))
  return node
}

/** 弹种小标签：剪影 + 代号。只卖一种弹的枪显示 STD */
export function roundTag(round, { standard = false, className = '' } = {}) {
  const node = h('span', { class: `rtag ${standard ? 'std' : ''} ${className}` })
  if (standard) {
    node.title = '这把枪只卖一种弹'
    node.append(roundGlyph(undefined), 'STD')
  } else {
    node.append(roundGlyph(round), ` ${ROUND_SHORT[round] ?? round}`)
  }
  return node
}

/* ── 名次盾 ───────────────────────────────────────────── */

const RANK_STYLE = [
  { fill: '#e2ac2a', rim: '#f0cd77', ink: '#12100c' },
  { fill: '#b9bec6', rim: '#dfe3e8', ink: '#12100c' },
  { fill: '#b5723a', rim: '#d79a63', ink: '#12100c' },
  { fill: '#5c6165', rim: '#888e93', ink: '#12100c' },
]

export function rankBadge(rank, size = 'md') {
  const style = RANK_STYLE[Math.min(rank, RANK_STYLE.length) - 1] ?? RANK_STYLE[3]
  const label = `按击杀时间排第 ${rank}`
  const node = svg('svg', { viewBox: '0 0 22 26', role: 'img', 'aria-label': label, class: `rank ${size}` })
  const title = svg('title')
  title.textContent = label
  node.append(
    title,
    svg('path', { d: 'M1.9 1.4h18.2v14.4L11 24.6 1.9 15.8Z', fill: style.fill, stroke: style.rim, 'stroke-width': 1.4, 'stroke-linejoin': 'round' }),
  )
  const text = svg('text', { x: 11, y: 14.8, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: style.ink })
  text.textContent = String(rank)
  node.append(text)
  return node
}

/* ── 护甲盾 ───────────────────────────────────────────── */

/**
 * 护甲在这次击杀里的命运：撑到最后（实线，数字是磨穿它要几发）
 * 或中途被打穿（虚线，数字是第几发打穿）。没有护甲挡着就不画。
 */
export function plateBadge(solution, className = '') {
  const armour = solution.stoppedBy
  if (!armour) return null
  const broke = solution.plateBreaksAt !== null
  const number = String((broke ? solution.plateBreaksAt : solution.plateShots) ?? '')
  const label = broke
    ? `${armourName(armour.name)}在第 ${solution.plateBreaksAt} 发被打穿，之后的命中落在身上`
    : `${armourName(armour.name)}撑到击杀结束，打穿它要 ${solution.plateShots} 发`
  const node = svg('svg', { viewBox: '0 0 24 26', role: 'img', 'aria-label': label, class: `plate ${broke ? 'broke' : ''} ${className}` })
  const title = svg('title')
  title.textContent = label
  node.append(
    title,
    svg('path', {
      d: 'M12 1.2 22 4.8V12c0 6.2-4.4 10.7-10 12.8C6.4 22.7 2 18.2 2 12V4.8Z',
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linejoin': 'round',
      'stroke-dasharray': broke ? '3.6 2.4' : undefined,
    }),
  )
  const text = svg('text', { x: 12, y: 16.6, 'text-anchor': 'middle', 'font-weight': 600, fill: 'currentColor', 'font-size': number.length > 2 ? 8.5 : 12.5 })
  text.textContent = number
  node.append(text)
  return node
}

/* ── 其它 ─────────────────────────────────────────────── */

/** 武器图标，没有图标的枪留一个同尺寸的空位，行高才对得齐 */
export function weaponIcon(session, slug, className = 'wicon') {
  const src = session.icons[slug]?.icon
  if (!src) return el('span', className)
  const img = h('img', { class: className, src, alt: '', loading: 'lazy' })
  img.addEventListener('error', () => { img.style.visibility = 'hidden' })
  return img
}

/**
 * 分段选择器：一排互斥的按钮。
 * @param {{ label: string, options: Array<{ key: string, label: string, sub?: string, disabled?: boolean, title?: string }>, value: string, onChange: (key: string) => void, className?: string }} config
 */
export function segmented({ label, options, value, onChange, className = '' }) {
  const node = h('div', { class: `seg ${className}`, role: 'group', 'aria-label': label })
  for (const option of options) {
    const button = h('button', {
      type: 'button',
      class: 'seg-item',
      'aria-pressed': String(option.key === value),
      disabled: !!option.disabled,
      title: option.title ?? null,
      onclick: () => onChange(option.key),
    })
    if (option.sub) {
      button.append(h('span', { class: 'seg-main', text: option.label }), h('span', { class: 'seg-sub', text: option.sub }))
    } else {
      button.textContent = option.label
    }
    node.append(button)
  }
  return node
}

/** 空心方框里打勾的选择标记。不叫 .tick：聊天里的行内代码用了这个名字 */
export function checkMark(on, className = '') {
  const node = h('span', { class: `cbox ${on ? 'on' : ''} ${className}` })
  if (on) {
    const mark = svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' })
    mark.append(svg('path', { d: 'M3 8.5l3 3 7-7', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
    node.append(mark)
  }
  return node
}
