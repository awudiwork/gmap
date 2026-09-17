/**
 * 命中部位人形图。
 *
 * 两种用法：
 *  - 选部位：点哪儿就打哪儿，当前部位亮琥珀，被护甲盖住的部位打斜线；
 *  - 看伤害：每个部位按效果档上色并写上弹数（传 fill / text）。
 */
import { svg } from './dom.js'
import { ZONES, ZONE_CANVAS } from './zones.js'

let hatchSerial = 0

/**
 * @param {{
 *   zones: string[], hit: string, covered?: Set<string>,
 *   fill?: (key: string) => string, ink?: (key: string) => string, text?: (key: string) => string,
 *   label: (key: string) => string, title?: (key: string) => string,
 *   onPick: (key: string) => void, className?: string,
 * }} config
 */
export function bodyMap({ zones, hit, covered = new Set(), fill, ink, text, label, title, onPick, className = '' }) {
  const hatchId = `hatch-${(hatchSerial += 1)}`
  const shown = ZONES.filter((zone) => zones.includes(zone.key))

  const root = svg('svg', {
    viewBox: `0 0 ${ZONE_CANVAS.width} ${ZONE_CANVAS.height}`,
    role: 'group',
    'aria-label': '命中部位',
    class: `bodymap ${className}`,
  })

  const pattern = svg('pattern', { id: hatchId, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' })
  pattern.append(
    svg('line', { x1: 3.5, y1: 0, x2: 3.5, y2: 7, stroke: 'rgba(0,0,0,.5)', 'stroke-width': 3.2 }),
    svg('line', { x1: 3.5, y1: 0, x2: 3.5, y2: 7, stroke: 'rgba(255,255,255,.55)', 'stroke-width': 1.3 }),
  )
  const defs = svg('defs')
  defs.append(pattern)
  root.append(defs)

  for (const zone of shown) {
    const active = zone.key === hit
    const custom = fill?.(zone.key)
    const path = svg('path', {
      d: zone.d,
      role: 'button',
      tabindex: 0,
      'aria-label': label(zone.key),
      'aria-pressed': String(active),
      class: `zone ${active ? 'on' : ''} ${custom ? 'tinted' : ''}`,
      fill: custom ?? undefined,
    })
    const tip = svg('title')
    tip.textContent = title?.(zone.key) ?? label(zone.key)
    path.append(tip)
    path.addEventListener('click', () => onPick(zone.key))
    path.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onPick(zone.key)
      }
    })
    root.append(path)
    if (covered.has(zone.key)) {
      root.append(svg('path', { d: zone.d, fill: `url(#${hatchId})`, class: 'hatch' }))
    }
  }

  // 上色模式下当前部位单靠颜色分不出来，描一圈白边
  const current = shown.find((zone) => zone.key === hit)
  if (current && fill) {
    root.append(
      svg('path', { d: current.d, fill: 'none', stroke: '#000', 'stroke-width': 4, class: 'hatch' }),
      svg('path', { d: current.d, fill: 'none', stroke: '#fff', 'stroke-width': 2, class: 'hatch' }),
    )
  }

  if (text) {
    for (const zone of shown) {
      for (const [x, y] of zone.labels) {
        const node = svg('text', {
          x, y,
          'text-anchor': 'middle',
          'dominant-baseline': 'central',
          'font-size': zone.small ? 19 : 22,
          fill: ink?.(zone.key) ?? '#f2efe8',
          class: 'zone-text',
        })
        node.textContent = text(zone.key)
        root.append(node)
      }
    }
  }

  return root
}
