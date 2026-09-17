/**
 * 看图器。
 *
 * 为地图同步做了两处专门处理：
 *  1. 已经打开时收到新图不关窗重开，而是原地换图源；
 *  2. 新旧图像素尺寸一致时，保留当前的缩放和平移。
 *     游戏地图每次截图画幅一样，你放大盯着某个角落时新的一张会在同一视角刷新，
 *     那才叫同步，而不是"又弹了一张图"。
 */
import { el, formatAge, icon } from './ui.js'
import { settings } from './settings.js'
import { anchorOf, clampOrigin, fitView, originFor, zoomAround } from './viewport.js'

const MIN_SCALE = 0.05
const MAX_SCALE = 12
/** 平移时至少要有这么多像素留在视口里，免得把图拖丢了找不回来 */
const PAN_MARGIN = 48
/** 滚轮是连续事件，攒一下再写设置 */
const REMEMBER_DELAY_MS = 260

const state = {
  root: null,
  stage: null,
  img: null,
  titleNode: null,
  subNode: null,
  zoomNode: null,
  /** 顶栏正中的"多久前推送"，每秒刷新 */
  ageNode: null,
  createdAt: 0,
  ageTimer: null,
  openRaw: null,
  /** 最近一次发出的图片探针，旧探针的回调按它判断是否作废 */
  probe: null,
  unsubscribe: null,
  scale: 1,
  tx: 0,
  ty: 0,
  natural: { width: 0, height: 0 },
}

const isOpen = () => state.root !== null

/** 舞台当前的可视尺寸，几何计算都以它为参照 */
const viewportOf = () => ({ width: state.stage.clientWidth, height: state.stage.clientHeight })

function applyTransform() {
  state.img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`
  state.zoomNode.textContent = `${Math.round(state.scale * 100)}%`
}

function clampPan() {
  const origin = clampOrigin({
    scale: state.scale,
    tx: state.tx,
    ty: state.ty,
    natural: state.natural,
    viewport: viewportOf(),
    margin: PAN_MARGIN,
  })
  state.tx = origin.tx
  state.ty = origin.ty
}

/** 按 contain 规则铺满舞台并居中，小图不放大 */
function fitStage() {
  const view = fitView({ natural: state.natural, viewport: viewportOf() })
  if (!view) return
  Object.assign(state, view)
  applyTransform()
  rememberSoon()
}

function zoomAt(clientX, clientY, factor) {
  const rect = state.stage.getBoundingClientRect()
  Object.assign(state, zoomAround({
    scale: state.scale,
    tx: state.tx,
    ty: state.ty,
    px: clientX - rect.left,
    py: clientY - rect.top,
    factor,
    min: MIN_SCALE,
    max: MAX_SCALE,
  }))
  clampPan()
  applyTransform()
  rememberSoon()
}

/** 当前画面中心落在图片上的归一化位置 */
function currentAnchor() {
  return anchorOf({
    scale: state.scale,
    tx: state.tx,
    ty: state.ty,
    natural: state.natural,
    viewport: viewportOf(),
  })
}

let rememberTimer = null

/** 把当前视图记进设置，攒一小会儿再写，避免滚轮连续触发时反复落盘 */
function rememberSoon() {
  if (!isOpen() || !settings.get().rememberView) return
  clearTimeout(rememberTimer)
  rememberTimer = setTimeout(() => {
    // 定时器到点时窗口可能已经关了，那时舞台尺寸为 0，算出来的锚点是脏的
    if (!isOpen()) return
    const anchor = currentAnchor()
    if (!anchor) return
    settings.set({ viewScale: state.scale, viewAnchor: anchor })
  }, REMEMBER_DELAY_MS)
}

/**
 * 按记住的缩放和锚点摆好视图。
 * @returns {boolean} 是否真的还原了；没开开关或还没记过时返回 false，由调用方退回适应窗口
 */
function restoreView() {
  const config = settings.get()
  if (!config.rememberView || !config.viewScale) return false

  const viewport = viewportOf()
  if (!state.natural.width || !state.natural.height || !viewport.width || !viewport.height) return false

  state.scale = Math.min(Math.max(config.viewScale, MIN_SCALE), MAX_SCALE)
  const anchor = config.centerOnOpen ? { u: 0.5, v: 0.5 } : (config.viewAnchor ?? { u: 0.5, v: 0.5 })
  Object.assign(state, originFor({ scale: state.scale, anchor, natural: state.natural, viewport }))
  clampPan()
  applyTransform()
  return true
}

function build() {
  const root = el('div', 'viewer')

  const stage = el('div', 'viewer-stage')
  const img = el('img')
  img.alt = ''
  img.draggable = false
  stage.append(img)

  const bar = el('div', 'viewer-bar')
  const meta = el('div')
  const title = el('div', 'title')
  const sub = el('div', 'sub')
  meta.append(title, sub)

  const zoom = el('span', 'zoom')
  // 绝对定位在顶栏正中，不参与两侧控件的排布
  const age = el('div', 'age')

  const fitBtn = el('button')
  fitBtn.append(icon('corners-out'), el('span', null, '适应窗口'))
  fitBtn.title = '适应窗口，双击画面同样生效'

  const oneToOne = el('button')
  oneToOne.append(icon('magnifying-glass-plus'), el('span', null, '原始大小'))

  /**
   * 顶栏上的三个开关，和设置面板里的是同一份状态，改哪边都同步。
   * 标签取短的，顶栏本来就挤；完整说明挂在 title 上。
   */
  function switchBtn(label, title) {
    const node = el('button', 'sw')
    node.append(el('span', null, label))
    node.title = title
    node.setAttribute('role', 'switch')
    return node
  }

  const rememberBtn = switchBtn('缩放', '记住缩放：下次打开或收到新图时，沿用现在的缩放倍数')
  rememberBtn.addEventListener('click', () => {
    const next = !settings.get().rememberView
    settings.set({ rememberView: next })
    // 打开的瞬间就把当前视图记下来，不用再动一下滚轮
    if (next) {
      const anchor = currentAnchor()
      if (anchor) settings.set({ viewScale: state.scale, viewAnchor: anchor })
    }
  })

  const centerBtn = switchBtn('居中', '沿用缩放时把位置放回画面中心；关掉则连上次盯着的位置一起沿用')
  centerBtn.addEventListener('click', () => {
    settings.set({ centerOnOpen: !settings.get().centerOnOpen })
  })

  const ownBtn = switchBtn('自己的', '展开自己从客户端推的图，默认关闭。一个人用两块屏时才需要打开。网页里手动发的图一律不展开')
  ownBtn.addEventListener('click', () => {
    settings.set({ autoOpenOwnPush: !settings.get().autoOpenOwnPush })
  })

  state.unsubscribe = settings.subscribe((config) => {
    rememberBtn.classList.toggle('on', config.rememberView)
    rememberBtn.setAttribute('aria-checked', String(config.rememberView))

    centerBtn.classList.toggle('on', config.rememberView && config.centerOnOpen)
    centerBtn.setAttribute('aria-checked', String(config.centerOnOpen))
    // 没开"记住缩放"时"居中"无从生效，置灰而不是让人以为设了有用
    centerBtn.disabled = !config.rememberView

    ownBtn.classList.toggle('on', config.autoOpenImages && config.autoOpenOwnPush)
    ownBtn.setAttribute('aria-checked', String(config.autoOpenOwnPush))
    // 雷达总开关关着时，什么都不会自动展开，这个开关同理失去意义
    ownBtn.disabled = !config.autoOpenImages
  })

  // 用 <a> 而不是按钮，保留中键和右键的原生行为
  const openRaw = el('a', 'act')
  openRaw.target = '_blank'
  openRaw.rel = 'noopener'
  openRaw.title = '在新标签打开原图'
  openRaw.setAttribute('aria-label', '在新标签打开原图')
  openRaw.append(icon('arrow-square-out'))

  const closeBtn = el('button')
  closeBtn.append(icon('x'))
  closeBtn.title = '关闭，Esc 同样生效'
  closeBtn.setAttribute('aria-label', '关闭')

  bar.append(meta, el('span', 'spacer'), zoom, rememberBtn, centerBtn, ownBtn, fitBtn, oneToOne, openRaw, closeBtn, age)

  const foot = el('div', 'viewer-foot')
  foot.append(
    el('span', null, '滚轮缩放'),
    el('span', null, '拖拽平移'),
    el('span', null, '新图在当前视角上刷新'),
  )

  root.append(stage, bar, foot)

  Object.assign(state, { root, stage, img, titleNode: title, subNode: sub, zoomNode: zoom, ageNode: age, openRaw })

  fitBtn.addEventListener('click', fitStage)
  oneToOne.addEventListener('click', () => {
    const rect = state.stage.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / state.scale)
  })
  closeBtn.addEventListener('click', close)

  stage.addEventListener('wheel', (event) => {
    event.preventDefault()
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.15 : 1 / 1.15)
  }, { passive: false })

  stage.addEventListener('dblclick', fitStage)

  /** 指针是否落在图片上。拖拽时有指针捕获，event.target 恒为舞台，只能按坐标判断 */
  function overImage(event) {
    const rect = state.img.getBoundingClientRect()
    return event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom
  }

  /** 超过这个位移就算拖拽，不再当成点击 */
  const CLICK_SLOP = 4

  let dragging = false
  let lastX = 0
  let lastY = 0
  let downAt = null

  stage.addEventListener('pointerdown', (event) => {
    dragging = true
    lastX = event.clientX
    lastY = event.clientY
    downAt = { x: event.clientX, y: event.clientY }
    stage.classList.add('dragging')
    stage.setPointerCapture(event.pointerId)
  })
  stage.addEventListener('pointermove', (event) => {
    if (!dragging) return
    state.tx += event.clientX - lastX
    state.ty += event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    clampPan()
    applyTransform()
  })
  const endDrag = (event) => {
    if (!dragging) return
    dragging = false
    stage.classList.remove('dragging')
    stage.releasePointerCapture?.(event.pointerId)

    // 点在图片外的空白上就关掉。拖动过就不算点击，
    // 否则把图拖到一边松手会意外关窗
    if (!downAt) return
    const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y)
    downAt = null
    if (moved <= CLICK_SLOP && !overImage(event)) close()
    else if (moved > CLICK_SLOP) rememberSoon()
  }
  stage.addEventListener('pointerup', endDrag)
  stage.addEventListener('pointercancel', (event) => {
    downAt = null
    endDrag(event)
  })

  return root
}

function onKeyDown(event) {
  if (event.key === 'Escape') close()
}

function paintAge() {
  if (!isOpen()) return
  state.ageNode.textContent = state.createdAt ? `${formatAge(state.createdAt)}推送` : ''
}

function onResize() {
  if (isOpen()) fitStage()
}

/**
 * 载入一张图。
 * @param {{ url: string, title: string, sub: string }} item
 * @param {boolean} keepView 尝试保留当前视角，尺寸一致时才真正保留
 */
function load(item, keepView) {
  state.titleNode.textContent = item.title
  state.subNode.textContent = item.sub
  state.openRaw.href = item.url
  state.createdAt = item.createdAt ?? 0
  paintAge()

  // 两张图连着到时，慢的那张可能后回调，把画面换回旧图而标题已经是新图的。
  // 记下这次请求，回调时不是最近一次就丢弃
  const probe = new Image()
  state.probe = probe
  probe.addEventListener('load', () => {
    if (state.probe !== probe || !isOpen()) return
    const sameSize = state.natural.width === probe.naturalWidth && state.natural.height === probe.naturalHeight
    state.natural = { width: probe.naturalWidth, height: probe.naturalHeight }
    state.img.src = item.url
    state.img.width = probe.naturalWidth
    state.img.height = probe.naturalHeight

    // 优先级：正在看同尺寸的图就原地不动（这是地图同步的关键），
    // 否则按记住的视图摆好，都不适用才退回适应窗口
    if (keepView && sameSize) applyTransform()
    else if (!restoreView()) fitStage()
  })
  probe.addEventListener('error', () => {
    if (state.probe !== probe || !isOpen()) return
    state.subNode.textContent = '图片读取失败，可能已过保留期被清除'
  })
  probe.src = item.url
}

/** 打开看图器；已打开则原地换图并尽量保留视角 */
export function show(item) {
  if (isOpen()) {
    load(item, true)
    return
  }
  document.getElementById('viewer-root').append(build())
  document.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', onResize)
  state.natural = { width: 0, height: 0 }
  state.ageTimer = setInterval(paintAge, 1000)
  load(item, false)
}

export function close() {
  if (!isOpen()) return
  // 关窗前把待写的视图落定，不然刚调好的缩放会因为防抖没到点而丢掉
  clearTimeout(rememberTimer)
  if (settings.get().rememberView) {
    const anchor = currentAnchor()
    if (anchor) settings.set({ viewScale: state.scale, viewAnchor: anchor })
  }

  state.unsubscribe?.()
  state.unsubscribe = null
  clearInterval(state.ageTimer)
  state.ageTimer = null
  state.root.remove()
  document.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('resize', onResize)
  state.root = null
}

export { isOpen }
