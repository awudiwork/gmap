/**
 * 距离曲线：横轴距离，纵轴弹数或时间，每把枪一条线。
 * 顶上的色带标出每段距离谁杀得最快；下面每把枪一条"效果档随距离变化"的横条。
 * 悬停看某个距离的数值，点一下把距离设成那里。
 */
import { h, roundTag, svg } from '../dom.js'
import {
  CHART_RANGE, MAX_RANGE, ROUND_DASH, ROUND_SHORT, combos, compareSolutions, formatShots, formatTime, shotBand, solve,
  timeBand,
} from '../engine.js'

const STEP = 5
const BAR = { above: 15, bar: 19, name: 38, below: 53 }

export function renderRange(session, { width }) {
  const multi = session.loads.length > 1
  const xMax = session.engagement.range > CHART_RANGE ? MAX_RANGE : CHART_RANGE
  const narrow = width > 0 && width < 560
  const W = narrow ? 360 : (width && width < 760 ? 700 : 1000)
  const H = narrow ? 268 : 346
  const fontSize = width ? Math.max(11, 12 * W / width) : 13
  const textWidth = (text) => text.length * fontSize * 0.62
  const valueOf = (sol) => (session.metric === 'shots' ? sol.shots : sol.time)
  const bandOf = (sol) => (session.metric === 'shots' ? shotBand(sol.shots) : timeBand(sol.time))
  const nameOf = (series) => series.weapon.name + (multi ? ` ${ROUND_SHORT[series.round] ?? series.round}` : '')

  const xs = Array.from({ length: xMax / STEP + 1 }, (_, index) => index * STEP)
  const base = { ...session.engagement, range: 0 }
  const series = combos(session.data, session.picked, session.loads, base, session.colours).map((row) => {
    const sols = xs.map((x) => solve(session.data, row.weapon, { ...base, round: row.round }, x))
    return { ...row, sols, values: sols.map(valueOf) }
  })
  const twoPlus = series.length >= 2
  const pad = { left: narrow ? 30 : 60, right: narrow ? 10 : 90, top: twoPlus ? 60 : (narrow ? 20 : 24), bottom: narrow ? 24 : 28 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom

  const finiteValues = series.flatMap((row) => row.values.filter(Number.isFinite))
  const yMax = session.metric === 'shots'
    ? Math.min(30, Math.max(4, ...finiteValues))
    : Math.min(4000, Math.max(600, ...finiteValues))
  const X = (range) => pad.left + range / xMax * plotW
  const Y = (value) => pad.top + plotH * (1 - Math.min(value, yMax) / yMax)

  const yTicks = [...new Set(Array.from({ length: 6 }, (_, index) => (session.metric === 'shots' ? Math.round(yMax * index / 5) : yMax * index / 5)))]
  const xSegments = narrow ? 4 : 8
  const xTicks = Array.from({ length: xSegments + 1 }, (_, index) => index * xMax / xSegments)
  const anchorFor = (index) => (narrow ? (index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle') : 'middle')

  /* 谁在哪段距离杀得最快。平局时沿用上一段的赢家，色带才不会来回抖 */
  const fastest = []
  if (twoPlus) {
    xs.forEach((range, index) => {
      let best = null
      for (const row of series) {
        const time = row.sols[index].time
        if (!Number.isFinite(time)) continue
        if (!best || time < best.sols[index].time || (time === best.sols[index].time && row.sols[index].shots < best.sols[index].shots)) best = row
      }
      if (!best) return
      const last = fastest[fastest.length - 1]
      if (last && last.s !== best) {
        const lastTime = last.s.sols[index].time
        if (Number.isFinite(lastTime) && lastTime <= best.sols[index].time) best = last.s
      }
      if (last && last.s === best) last.to = range
      else fastest.push({ s: best, from: range, to: range })
    })
  }

  /* 色带分界的距离标注，交错放上下两排避免重叠 */
  const boundaryLabels = []
  const used = { below: -Infinity, above: -Infinity }
  for (let index = 1; index < fastest.length; index += 1) {
    const at = X(fastest[index].from)
    const text = narrow ? String(fastest[index].from) : `${fastest[index].from} m`
    const half = textWidth(text) / 2 + 4
    const slot = at - half > used.below ? 'below' : at - half > used.above ? 'above' : null
    if (!slot) continue
    used[slot] = at + half
    boundaryLabels.push({ at, text, above: slot === 'above', anchor: at - half < 0 ? 'start' : at + half > W ? 'end' : 'middle' })
  }

  /* 右侧线名，上下错开 14 像素，整体不超出图底 */
  const endLabels = series
    .map((row) => {
      const last = [...row.values].reverse().find(Number.isFinite)
      return { s: row, y: last === undefined ? null : Y(last) }
    })
    .filter((entry) => entry.y !== null)
    .sort((a, b) => a.y - b.y)
  for (let index = 1; index < endLabels.length; index += 1) {
    if (endLabels[index].y - endLabels[index - 1].y < 14) endLabels[index].y = endLabels[index - 1].y + 14
  }
  const overflow = endLabels.length ? endLabels[endLabels.length - 1].y - (H - pad.bottom) : 0
  if (overflow > 0) for (const entry of endLabels) entry.y -= overflow

  /* ── 画图 ── */
  const chart = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'range-chart',
    role: 'img',
    'font-size': fontSize,
    'aria-label': `零到 ${xMax} 米的${session.metric === 'shots' ? '击杀弹数' : '击杀时间'}`,
  })

  if (xMax > CHART_RANGE) {
    chart.append(
      svg('rect', { x: X(CHART_RANGE), y: pad.top, width: X(xMax) - X(CHART_RANGE), height: Y(0) - pad.top, fill: 'rgba(255,255,255,.035)' }),
      svg('line', { x1: X(CHART_RANGE), x2: X(CHART_RANGE), y1: pad.top, y2: Y(0), class: 'stroke-mid', 'stroke-width': 1, 'stroke-dasharray': '2 4' }),
    )
  }

  if (fastest.length) {
    if (!narrow) {
      const label = svg('text', { x: pad.left - 6, y: BAR.bar + 6, 'text-anchor': 'end', class: 'fill-dim' })
      label.textContent = '最快'
      chart.append(label)
    }
    fastest.forEach((segment, index) => {
      const from = X(segment.from)
      const to = X(Math.min(segment.to + STEP, xMax))
      const rect = svg('rect', { x: from, y: BAR.bar, width: to - from, height: 6, fill: segment.s.colour })
      const tip = svg('title')
      tip.textContent = `${nameOf(segment.s)} 在 ${segment.from} m 到 ${Math.min(segment.to + STEP, xMax)} m 之间杀得最快`
      rect.append(tip)
      chart.append(rect)
      const name = nameOf(segment.s)
      if (to - from >= textWidth(name)) {
        const text = svg('text', { x: (from + to) / 2, y: BAR.name, 'text-anchor': 'middle', fill: segment.s.colour, class: 'bold' })
        text.textContent = name
        chart.append(text)
      }
      if (index > 0) chart.append(svg('line', { x1: from, x2: from, y1: BAR.bar, y2: pad.top, class: 'stroke-groove', 'stroke-width': 1 }))
    })
    for (const label of boundaryLabels) {
      if (label.above) chart.append(svg('line', { x1: label.at, x2: label.at, y1: BAR.above + 3, y2: BAR.bar, class: 'stroke-groove', 'stroke-width': 1 }))
      const text = svg('text', { x: label.at, y: label.above ? BAR.above : BAR.below, 'text-anchor': label.anchor, class: 'fill-mid bold' })
      text.textContent = label.text
      chart.append(text)
    }
  }

  for (const tick of yTicks) {
    chart.append(svg('line', { x1: pad.left, x2: W - pad.right, y1: Y(tick), y2: Y(tick), class: 'stroke-groove', 'stroke-width': 1 }))
    const text = svg('text', { x: pad.left - 6, y: Y(tick) + 4, 'text-anchor': 'end', class: 'fill-dim' })
    text.textContent = session.metric === 'shots' ? String(tick) : `${(tick / 1000).toFixed(1)}s`
    chart.append(text)
  }
  xTicks.forEach((tick, index) => {
    const text = svg('text', { x: X(tick), y: H - 8, 'text-anchor': anchorFor(index), class: 'fill-dim' })
    text.textContent = `${tick} m`
    chart.append(text)
  })
  chart.append(svg('line', { x1: pad.left, x2: W - pad.right, y1: Y(0), y2: Y(0), class: 'stroke-mid', 'stroke-width': 1 }))

  for (const row of series) {
    let d = ''
    row.values.forEach((value, index) => {
      if (!Number.isFinite(value)) return
      const joined = d && Number.isFinite(row.values[index - 1])
      d += `${joined ? 'L' : 'M'}${X(xs[index]).toFixed(1)} ${Y(value).toFixed(1)} `
    })
    chart.append(svg('path', { d, fill: 'none', stroke: row.colour, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': ROUND_DASH[row.round] || undefined }))
  }
  if (!narrow) {
    for (const entry of endLabels) {
      const text = svg('text', { x: W - pad.right + 8, y: entry.y + 4, fill: entry.s.colour, class: 'bold' })
      text.textContent = nameOf(entry.s)
      chart.append(text)
    }
  }

  // 当前距离
  chart.append(svg('line', { x1: X(session.engagement.range), x2: X(session.engagement.range), y1: pad.top, y2: Y(0), class: 'stroke-amber', 'stroke-width': 1, 'stroke-dasharray': '4 3' }))

  // 悬停层
  const hoverLayer = svg('g')
  chart.append(hoverLayer)
  const tooltip = h('div', { class: 'range-tip hidden' })
  const stage = h('div', { class: 'range-stage' }, chart, tooltip)

  const rangeAt = (event) => {
    const rect = chart.getBoundingClientRect()
    const range = ((event.clientX - rect.left) / rect.width * W - pad.left) / plotW * xMax
    return Math.round(Math.max(0, Math.min(xMax, range)) / 10) * 10
  }
  const showHover = (event) => {
    const range = rangeAt(event)
    // 悬停落在 10 米的整数点上，每 5 米一个样本已经算过，直接取
    const sample = range / STEP
    const solved = series
      .map((row) => ({ s: row, sol: row.sols[sample] ?? solve(session.data, row.weapon, { ...base, round: row.round }, range) }))
      .sort(compareSolutions)
    hoverLayer.replaceChildren(svg('line', { x1: X(range), x2: X(range), y1: pad.top, y2: Y(0), class: 'stroke-mid', 'stroke-width': 1 }))
    for (const entry of solved) {
      const value = valueOf(entry.sol)
      if (!Number.isFinite(value)) continue
      hoverLayer.append(svg('circle', { cx: X(range), cy: Y(value), r: 5, fill: entry.s.colour, stroke: '#000', 'stroke-width': 2 }))
    }
    tooltip.replaceChildren(h('p', { class: 'dim strong', text: `${range} m` }))
    for (const entry of solved) {
      const dot = h('i')
      dot.style.background = entry.s.colour
      tooltip.append(h('div', { class: 'tip-row' }, dot, h('span', { class: 'dim ellipsis', text: nameOf(entry.s) }), h('b', { text: `${formatShots(entry.sol.shots)} / ${formatTime(entry.sol.time)}` })))
    }
    tooltip.classList.remove('hidden')
    const box = stage.getBoundingClientRect()
    const x = event.clientX - box.left
    const y = event.clientY - box.top
    tooltip.style.left = `${Math.min(Math.max(x + 14, 2), Math.max(box.width - tooltip.offsetWidth - 2, 2))}px`
    tooltip.style.top = `${Math.max(y - tooltip.offsetHeight - 12, 2)}px`
  }
  chart.addEventListener('pointermove', showHover)
  chart.addEventListener('pointerdown', showHover)
  chart.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return
    hoverLayer.replaceChildren()
    tooltip.classList.add('hidden')
  })
  chart.addEventListener('click', (event) => session.setEngagement({ range: rangeAt(event) }))

  /* ── 标题 ── */
  const title = h('h3', { class: 'chart-title' }, `${session.metric === 'shots' ? '击杀弹数' : '击杀时间'}随距离变化`)
  if (multi) {
    const legend = h('span', { class: 'line-legend' })
    for (const round of session.loads) {
      const sample = svg('svg', { viewBox: '0 0 32 8', class: 'line-sample' })
      sample.append(svg('line', { x1: 0, y1: 4, x2: 32, y2: 4, class: 'stroke-mid', 'stroke-width': 2, 'stroke-dasharray': ROUND_DASH[round] || undefined }))
      legend.append(h('span', null, sample, ` ${ROUND_SHORT[round] ?? round}`))
    }
    title.append(legend)
  }

  /* ── 效果档横条 ── */
  const bands = h('div', { class: 'band-rows' })
  for (const row of series) {
    const runs = []
    for (const sol of row.sols) {
      const band = bandOf(sol)
      const last = runs[runs.length - 1]
      if (last && last.band === band) last.n += 1
      else runs.push({ band, n: 1 })
    }
    const name = h('div', { class: 'band-name' })
    const dot = h('i')
    dot.style.background = row.colour
    name.append(dot, h('span', { class: 'ellipsis', text: row.weapon.name }))
    if (multi) name.append(roundTag(row.round, { standard: row.standard }))

    const track = h('div', { class: 'band-track' })
    for (const run of runs) {
      const pct = run.n / xs.length * 100
      const seg = h('span', { class: 'band-seg', title: run.band.label, text: run.band.short })
      seg.dataset.chars = String(run.band.short.length)
      seg.style.width = `${pct}%`
      seg.style.background = run.band.colour
      seg.style.color = run.band.ink
      track.append(seg)
    }
    if (xMax > CHART_RANGE) track.append(h('span', { class: 'band-far' }))
    const marker = h('span', { class: 'band-now' })
    marker.style.left = `${session.engagement.range / xMax * 100}%`
    track.append(marker)
    bands.append(name, track)
  }
  const axis = h('div', { class: 'band-axis' })
  for (let index = 0; index <= 4; index += 1) axis.append(h('span', { text: `${index * xMax / 4} m` }))
  bands.append(h('span'), axis)

  const root = h('div', { class: 'view-range' }, title, stage, h('h3', { class: 'chart-title', text: '各距离的效果档' }), bands)

  // 段太窄时不显示文字。要等挂到页面上才量得到宽度
  root.fitBandText = () => {
    for (const track of root.querySelectorAll('.band-track')) {
      const total = track.clientWidth
      for (const seg of track.querySelectorAll('.band-seg')) {
        const px = parseFloat(seg.style.width) / 100 * total
        seg.classList.toggle('mute', px < Number(seg.dataset.chars) * 6.4 + 8)
      }
    }
  }
  return root
}
