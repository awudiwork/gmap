/**
 * 基础构件：DOM、格式化、弹层、拨钮、toast。
 *
 * 渲染约定：用户内容一律走 textContent，任何地方都不把它拼进 innerHTML。
 */

export function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const SPRITE = '/vendor/icons.svg'

/** 引用 Phosphor sprite。代码里不手写任何 path */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  // SVG 的 className 是只读的 SVGAnimatedString，必须走 setAttribute
  svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', `${SPRITE}#i-${name}`)
  svg.append(use)
  return svg
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const pad = (n) => String(n).padStart(2, '0')

/** 日志时间精确到秒：这条流的用途就是分辨"谁先推的" */
export function formatStamp(ms) {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatClock(ms) {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatDay(ms) {
  const date = new Date(ms)
  const today = new Date()
  const sameDay = (a, b) => a.toDateString() === b.toDateString()
  if (sameDay(date, today)) return '今天'
  if (sameDay(date, new Date(today.getTime() - 86400000))) return '昨天'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function formatDateTime(ms) {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '尚未使用'
}

/**
 * 头像底色板。刻意不做全色相随机：满屏高饱和头像会把唯一的琥珀强调色淹掉。
 * 这六个都压在 45% 以下的饱和度、35% 以下的亮度，彼此能分辨，
 * 但都退到界面后面，白字压上去也够清楚。
 */
const AVATAR_INK = [
  'hsl(38 45% 31%)',
  'hsl(19 36% 33%)',
  'hsl(150 26% 27%)',
  'hsl(201 26% 31%)',
  'hsl(281 15% 34%)',
  'hsl(55 30% 29%)',
]

/** 由名字稳定映射到色板中的一个，免去存头像文件 */
export function avatarInk(name) {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 4096
  return AVATAR_INK[hash % AVATAR_INK.length]
}

/** 昵称首字作为默认头像。取一个完整字符，避免把 emoji 或代理对切碎 */
export function avatarLetter(name) {
  const first = [...String(name ?? '')][0] ?? '?'
  return first.toUpperCase()
}

/**
 * 弹性拨钮。滑块用带过冲的 spring 曲线，到位时会轻微回弹，
 * 像一个真的被拨过去的物理开关。
 *
 * @param {{ checked: boolean, label: string, onChange: (next: boolean) => void }} config
 */
export function toggle({ checked = false, label = '', onChange }) {
  const node = el('button', 'toggle')
  node.type = 'button'
  node.setAttribute('role', 'switch')
  node.setAttribute('aria-checked', String(checked))

  const track = el('span', 'toggle-track')
  track.append(el('span', 'toggle-thumb'))
  node.append(track)
  if (label) node.append(el('span', null, label))

  node.addEventListener('click', () => {
    const next = node.getAttribute('aria-checked') !== 'true'
    node.setAttribute('aria-checked', String(next))
    onChange(next)
  })

  node.setChecked = (next) => node.setAttribute('aria-checked', String(next))
  return node
}

/**
 * 打开一个弹层。
 * @returns {{ body: HTMLElement, close: () => void }}
 */
export function openSheet(title) {
  const root = document.getElementById('sheet-root')
  const veil = el('div', 'veil')
  const sheet = el('div', 'sheet')
  const bar = el('div', 'sheet-bar')
  const closeBtn = el('button', 'bare')
  closeBtn.append(icon('x'))
  closeBtn.setAttribute('aria-label', '关闭')
  const body = el('div', 'sheet-body')

  bar.append(el('h2', null, title), el('span', 'spacer'), closeBtn)
  sheet.append(bar, body)
  veil.append(sheet)
  root.append(veil)

  const close = () => {
    veil.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (event) => {
    if (event.key === 'Escape') close()
  }

  closeBtn.addEventListener('click', close)
  veil.addEventListener('mousedown', (event) => {
    if (event.target === veil) close()
  })
  document.addEventListener('keydown', onKey)

  return { body, close }
}

/**
 * 瞬时提示。从下方弹入并过冲回弹，退出时收回去。
 * 只用于"结果在别处已经可见"的确认；需要用户处理的错误就地显示。
 */
export function toast(text, kind = 'ok') {
  const node = el('div', kind === 'bad' ? 'toast bad' : 'toast')
  node.append(icon(kind === 'bad' ? 'warning-circle' : 'check'), el('span', null, text))
  document.body.append(node)

  setTimeout(() => {
    node.classList.add('leaving')
    setTimeout(() => node.remove(), 260)
  }, 3200)
}
