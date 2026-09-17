/**
 * Wardogs 伤害计算器：全屏浮层，左边设条件，右边看结果。
 *
 * 装配层：拉数据、建会话、把各个渲染函数接到会话的变化上。
 * 状态记在本机（localStorage）和地址栏的 hash 里，刷新页面回到同一个视图，
 * "分享此视图"复制的就是这个带 hash 的地址。
 */
import { api, ApiError } from '../api.js'
import { el, icon, toast } from '../ui.js'
import { h } from './dom.js'
import { calibrateTimeBands, usableWeapons } from './engine.js'
import { createPicker } from './picker.js'
import { renderRail } from './rail.js'
import { Session, parseState, serializeState } from './state.js'
import { renderChips, renderControls, renderLegend, renderNotes, renderRanks, renderTabs } from './summary.js'
import { renderAmmo } from './views/ammo.js'
import { renderCompare } from './views/compare.js'
import { renderRange } from './views/range.js'
import { renderTable } from './views/table.js'
import { renderZones } from './views/zonesView.js'

const STORAGE_KEY = 'gmap.wardogs.ballistics'
export const HASH_PREFIX = '#wardogs/ballistics'

/** 数据在页面生命周期内只拉一次；失败时清掉，下次打开重试 */
let loading = null
let root = null

function loadData() {
  if (!loading) {
    loading = api.wardogsBallistics()
      .then((payload) => {
        calibrateTimeBands(payload.ballistics)
        return {
          data: payload.ballistics,
          icons: payload.weapons ?? {},
          source: payload.source,
          generatedAt: payload.generatedAt,
          fetchedAt: payload.fetchedAt,
        }
      })
      .catch((err) => {
        loading = null
        throw err
      })
  }
  return loading
}

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function store(query) {
  try {
    localStorage.setItem(STORAGE_KEY, query)
  } catch {
    // 隐私模式下记不住，下次回到默认视图
  }
}

/** 地址栏里带的计算器状态；没带返回 null */
export function hashQuery() {
  const { hash } = location
  if (!hash.startsWith(HASH_PREFIX)) return null
  const rest = hash.slice(HASH_PREFIX.length)
  return rest.startsWith('?') ? rest.slice(1) : ''
}

const setHash = (query) => history.replaceState(null, '', `${location.pathname}${HASH_PREFIX}?${query}`)
const clearHash = () => {
  if (location.hash.startsWith(HASH_PREFIX)) history.replaceState(null, '', location.pathname)
}

function buildShell() {
  const shell = el('div', 'calc')
  const bar = el('header', 'calc-bar')
  const title = el('div', 'calc-title')
  title.append(el('h2', null, 'Wardogs 伤害计算器'), el('span', 'sub', '正在读取弹道数据'))
  const setup = h('button', { type: 'button', class: 'slim only-rail', text: '设置' })
  const close = h('button', { type: 'button', class: 'bare', 'aria-label': '关闭，Esc 同样生效', title: '关闭，Esc 同样生效' })
  close.append(icon('x'))
  bar.append(title, el('span', 'spacer'), setup, close)

  const railVeil = el('div', 'calc-rail-veil')
  const rail = el('aside', 'calc-rail')
  const main = el('div', 'calc-main')
  const body = el('div', 'calc-body')
  body.append(rail, main, railVeil)
  shell.append(bar, body)
  return { shell, sub: title.querySelector('.sub'), setup, close, rail, main, railVeil }
}

function errorBox(message, { onRetry, onClose }) {
  const box = el('div', 'log-void bad')
  box.append(el('div', 'head', '读不到弹道数据'), el('p', null, message))
  const acts = el('div', 'acts')
  const retry = el('button')
  retry.append(icon('arrow-counter-clockwise'), el('span', null, '重试'))
  retry.addEventListener('click', onRetry)
  const back = el('button', 'bare', '关闭')
  back.addEventListener('click', onClose)
  acts.append(retry, back)
  box.append(acts)
  return box
}

/**
 * 打开计算器。已打开时不重复开。
 * @param {{ query?: string }} options 指定初始状态的查询串；不传用上次的
 */
export async function openBallistics({ query } = {}) {
  if (root) return
  const ui = buildShell()
  root = ui.shell
  document.body.append(root)
  // 数据在路上时可能被关掉再打开，那时 root 已经是另一个壳，这一次的后续全部作废
  const mine = ui.shell
  const alive = () => root === mine

  let unsubscribe = null
  let picker = null

  const close = () => {
    if (!alive()) return
    picker?.close()
    unsubscribe?.()
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onResize)
    root.remove()
    root = null
    clearHash()
  }
  const onKey = (event) => {
    if (event.key === 'Escape') close()
  }
  ui.close.addEventListener('click', close)
  document.addEventListener('keydown', onKey)

  let loaded
  try {
    loaded = await loadData()
  } catch (err) {
    if (!alive()) return
    ui.main.replaceChildren(errorBox(
      err instanceof ApiError ? err.message : '连不上服务端，检查网络后重试。',
      {
        onRetry: () => {
          close()
          openBallistics({ query })
        },
        onClose: close,
      },
    ))
    return
  }
  if (!alive()) return

  const { data, icons, source, generatedAt, fetchedAt } = loaded
  const sourceText = {
    upstream: '来自 metaforge.app',
    stale: `来自 metaforge.app，${new Date(fetchedAt).toLocaleDateString('zh-CN')} 之后没能再刷新`,
    snapshot: '本地快照',
  }[source] ?? source
  ui.sub.textContent = `数据 ${generatedAt ?? '未知日期'}，${sourceText}`

  const initial = parseState(data, new URLSearchParams(query ?? readStored()))
  const session = new Session(data, usableWeapons(data), icons, initial)
  picker = createPicker(session, { host: root })

  const share = async () => {
    const link = `${location.origin}${location.pathname}${HASH_PREFIX}?${serializeState(data, session.toState())}`
    try {
      await navigator.clipboard.writeText(link)
      toast('链接已复制')
    } catch {
      toast('复制失败，请手动复制地址栏', 'bad')
    }
  }

  // 窄屏下设置栏收成底部抽屉
  const slideRail = (out) => root?.classList.toggle('rail-open', out)
  ui.setup.addEventListener('click', () => slideRail(true))
  ui.railVeil.addEventListener('click', () => slideRail(false))

  const legendMetric = () => (session.view === 'compare' || session.view === 'zones' ? 'shots' : session.metric)

  function renderView() {
    switch (session.view) {
      case 'compare': return renderCompare(session)
      case 'zones': return renderZones(session)
      case 'range': return renderRange(session, { width: ui.main.clientWidth - 40 })
      case 'ammo': return renderAmmo(session)
      default: return renderTable(session)
    }
  }

  function renderMain() {
    const view = renderView()
    // 有些视图在没选枪时什么都不画，返回 null，得先滤掉
    const parts = [
      renderRanks(session),
      renderChips(session, { onShare: share }),
      h('div', { class: 'tabs-row' }, renderTabs(session), renderControls(session)),
      view,
      session.view === 'ammo' ? null : renderLegend(legendMetric()),
      renderNotes(),
    ].filter((part) => part !== null)
    ui.main.replaceChildren(...parts)
    // 效果档横条要等挂到页面上才量得到宽度
    view?.fitBandText?.()
  }

  // 拖滑杆时每个 input 事件都来一次，攒到下一帧只画一遍
  let lightFrame = 0
  function render(meta = {}) {
    if (!alive()) return
    if (meta.light) {
      if (!lightFrame) {
        lightFrame = requestAnimationFrame(() => {
          lightFrame = 0
          if (alive()) renderMain()
        })
      }
      return
    }
    cancelAnimationFrame(lightFrame)
    lightFrame = 0
    renderMain()
    if (!meta.light) {
      ui.rail.replaceChildren(renderRail(session, { onOpenPicker: picker.open }))
      picker.refresh()
      const serialized = serializeState(data, session.toState())
      store(serialized)
      setHash(serialized)
    }
    if (session.pickerOpen) {
      session.pickerOpen = false
      picker.open()
    }
  }

  let resizeTimer = null
  const onResize = () => {
    if (session.view !== 'range') return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(renderMain, 120)
  }
  window.addEventListener('resize', onResize)

  unsubscribe = session.subscribe((_, meta) => render(meta))
  render()
}

export const isOpen = () => root !== null

/** 工具注册表（tools.js）按这个名字调用 */
export { openBallistics as open }
