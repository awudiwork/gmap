/**
 * 装配层：把接口、实时通道、日志渲染、本机设置接起来。
 * 这里只做编排和 DOM 状态，不含业务规则。
 */
import { api, ApiError } from './api.js'
import { connectRealtime } from './ws-client.js'
import { buildDayMark, markExpired, renderRow, viewerItem } from './render.js'
import { show as showViewer } from './viewer.js'
import { isMuted, playBeep, refreshMutedNames, settings, shouldAutoOpen, toggleMute } from './settings.js'
import { initCommand } from './composer.js'
import { openKeys, openProfile, openSettings, openUsers } from './panels.js'
import { avatarInk, avatarLetter, dayKey, el, icon, toast, toggle } from './ui.js'

/** 距底部小于这个距离就认为在看最新，新消息自动跟随 */
const STICK_PX = 80

const log = document.getElementById('log')
const logInner = document.getElementById('log-inner')
const tailHint = document.getElementById('tail-hint')
const lamp = document.getElementById('lamp')
const linkLabel = document.getElementById('link-label')
const roster = document.getElementById('roster')
const rosterCount = document.getElementById('roster-count')
const rail = document.getElementById('rail')
const railVeil = document.getElementById('rail-veil')

const state = {
  me: null,
  last: null,
  lastDay: null,
  oldestId: null,
  hasMore: true,
  loadingMore: false,
}

const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < STICK_PX
const toBottom = () => { log.scrollTop = log.scrollHeight }

/** 加载骨架：形状和位置照抄气泡，加载完成时不会有跳动 */
function showSkeleton(count = 6) {
  const shape = [
    { width: '46%', mine: false },
    { width: '30%', mine: true },
    { width: '62%', mine: false },
    { width: '38%', mine: false },
    { width: '44%', mine: true },
    { width: '28%', mine: false },
  ]
  logInner.replaceChildren()
  for (let i = 0; i < count; i += 1) {
    const { width, mine } = shape[i % shape.length]
    const row = el('div', mine ? 'sk-row mine' : 'sk-row')
    const bubble = el('div', 'sk sk-bubble')
    bubble.style.width = width
    row.append(el('div', 'sk sk-face'), bubble)
    logInner.append(row)
  }
}

/** 空频道：说清这里会出现什么，并给出下一步 */
function showEmpty({ onKeys }) {
  logInner.replaceChildren()
  const box = el('div', 'log-void')
  box.append(el('div', 'head', '频道里还没有东西'))
  box.append(el('p', null, '用截图客户端推一张地图上来，或者把图片拖进这个窗口。房间里的其他人会立刻看到。'))
  const acts = el('div', 'acts')
  const keyBtn = el('button', 'key')
  keyBtn.append(icon('plus'), el('span', null, '生成上传 Key'))
  keyBtn.addEventListener('click', onKeys)
  acts.append(keyBtn)
  box.append(acts)
  logInner.append(box)
}

function showLoadError(message) {
  logInner.replaceChildren()
  const box = el('div', 'log-void bad')
  box.append(el('div', 'head', '读不到消息'))
  box.append(el('p', null, message))
  const acts = el('div', 'acts')
  const retry = el('button')
  retry.append(icon('arrow-counter-clockwise'), el('span', null, '重新加载'))
  retry.addEventListener('click', () => location.reload())
  acts.append(retry)
  box.append(acts)
  logInner.append(box)
}

const clearPlaceholder = () => {
  if (logInner.querySelector('.log-void, .sk-row')) logInner.replaceChildren()
}

/** 追加一行到底部，跨天时先插日期标记 */
function appendRow(message, { fresh = false } = {}) {
  clearPlaceholder()
  const key = dayKey(message.createdAt)
  if (key !== state.lastDay) {
    logInner.append(buildDayMark(message.createdAt))
    state.lastDay = key
  }
  const row = renderRow(message, state.last, state.me.id)
  if (fresh) row.classList.add('fresh')
  logInner.append(row)
  state.last = message
}

/** 向上补历史：整块构建后一次插入，并补偿滚动位置避免视觉跳动 */
function prependRows(messages) {
  const fragment = document.createDocumentFragment()
  let previous = null
  let day = null
  for (const message of messages) {
    const key = dayKey(message.createdAt)
    if (key !== day) {
      fragment.append(buildDayMark(message.createdAt))
      day = key
      previous = null
    }
    fragment.append(renderRow(message, previous, state.me.id))
    previous = message
  }

  // 这批的最后一条若和原本最早那条是同一天，原来那条分隔线就多余了，
  // 不处理的话向上翻历史会看到两个"今天"
  const seam = logInner.querySelector('.day-mark')
  const before = log.scrollHeight
  logInner.insertBefore(fragment, logInner.firstChild)
  if (seam && seam.dataset.day === day) seam.remove()
  log.scrollTop += log.scrollHeight - before
}

/** 当前这批铃铛的重绘函数。renderRoster 每次重建名单时整体换掉，不会越积越多 */
let repaintBells = []

function renderRoster(users) {
  repaintBells = []
  rosterCount.textContent = String(users.length)
  roster.replaceChildren()

  // 对方改了昵称之后，静音记录里存的还是旧名字，趁这次在线名单顺手对齐
  refreshMutedNames(users)

  if (users.length === 0) {
    roster.append(el('div', 'void', '无人在线'))
    return
  }
  for (const user of users) {
    const mine = user.id === state.me?.id
    const row = el('div', mine ? 'roster-row self' : 'roster-row')
    const face = el('div', 'face mini', avatarLetter(user.name))
    face.style.background = avatarInk(user.name)
    row.append(face, el('span', 'who', user.name))

    // 自己那行不给开关：自己的推送归"展开自己推送的图"那个总开关管
    if (!mine) row.append(muteButton(user))

    roster.append(row)
  }
}

/** 单人开关：关掉后这个人推的图不再自动展开，消息照常收 */
function muteButton(user) {
  const node = el('button', 'mute')
  node.setAttribute('role', 'switch')

  const paint = () => {
    const off = isMuted(user.id)
    const radarOff = !settings.get().autoOpenImages
    node.classList.toggle('off', off)
    node.setAttribute('aria-checked', String(!off))
    node.replaceChildren(icon(off ? 'bell-simple-slash' : 'bell-simple'))
    // 雷达总开关关着时谁的图都不会弹，这里跟着置灰，
    // 免得它亮着琥珀却什么也不做
    node.disabled = radarOff
    node.title = radarOff
      ? '雷达总开关关着，现在谁的图都不会自动展开'
      : (off ? `${user.name} 推的图不会自动展开，点击恢复` : `${user.name} 推的图会自动展开，点击关闭`)
  }

  node.addEventListener('click', () => {
    toggleMute(user)
    paint()
  })

  paint()
  repaintBells.push(paint)
  return node
}

/**
 * 设置可能在别处被改掉（设置面板里恢复某人、关掉雷达总开关），
 * 名单上的铃铛必须跟着走。否则它显示的是旧状态，再点一次就会做成反的。
 *
 * 只在真正相关的字段变化时才动，避免看图器缩放时高频写设置连带重画名单。
 */
let bellSignature = null
settings.subscribe((config) => {
  const signature = `${config.autoOpenImages}|${config.mutedUsers.map((entry) => entry.id).join(',')}`
  if (signature === bellSignature) return
  bellSignature = signature
  // 首次订阅时名单还没画出来，repaintBells 是空的，这里自然什么也不做
  for (const paint of repaintBells) paint()
})

function handleIncoming(message) {
  const stick = atBottom()
  appendRow(message, { fresh: true })

  if (stick) {
    toBottom()
    tailHint.classList.add('hidden')
  } else {
    tailHint.classList.remove('hidden')
  }

  if (shouldAutoOpen(message, state.me.id)) {
    showViewer(viewerItem(message))
    if (settings.get().sound) playBeep()
  }
}

function handleEvent(event) {
  switch (event.type) {
    case 'hello':
    case 'presence':
      renderRoster(event.data.online)
      break
    case 'message':
      handleIncoming(event.data)
      break
    case 'files_expired':
      markExpired(event.data.fileIds)
      break
    default:
      break
  }
}

function setLinkState(status) {
  lamp.classList.toggle('up', status === 'online')
  lamp.classList.toggle('down', status === 'offline' || status === 'unauthorized')
  linkLabel.textContent = {
    online: '已连接',
    connecting: '连接中',
    offline: '重连中',
    unauthorized: '登录失效',
  }[status] ?? status
  if (status === 'unauthorized') location.replace('/login.html')
}

async function loadMore() {
  if (state.loadingMore || !state.hasMore || !state.oldestId) return
  state.loadingMore = true
  try {
    const { messages } = await api.messages({ before: state.oldestId, limit: 50 })
    if (messages.length === 0) {
      state.hasMore = false
      return
    }
    state.oldestId = messages[0].id
    prependRows(messages)
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '读取历史失败', 'bad')
  } finally {
    state.loadingMore = false
  }
}

function renderOperator(me) {
  const face = document.getElementById('op-face')
  face.textContent = avatarLetter(me.name)
  face.style.background = avatarInk(me.name)
  document.getElementById('op-name').textContent = me.name
  document.getElementById('op-handle').textContent = me.isAdmin ? `${me.username} / 管理员` : me.username
}

/** 顶栏的雷达拨钮：产品最重要的开关，放在面板最显眼处，用物理开关的形态 */
function mountRadar() {
  const scope = el('span')
  const host = toggle({
    checked: settings.get().autoOpenImages,
    onChange: (next) => settings.set({ autoOpenImages: next }),
  })
  host.append(el('span', 'stencil', 'Radar'), scope)
  document.getElementById('radar-slot').replaceWith(host)

  settings.subscribe((config) => {
    host.setChecked(config.autoOpenImages)
    scope.textContent = config.autoOpenImages
      ? (config.autoOpenSource === 'api' ? '仅 API' : '全部来源')
      : ''
  })
}

async function boot() {
  let me = null
  try {
    ({ user: me } = await api.me())
  } catch {
    location.replace('/login.html')
    return
  }
  if (!me) {
    location.replace('/login.html')
    return
  }
  state.me = me
  renderOperator(me)
  renderRoster([])
  mountRadar()

  const usersBtn = document.getElementById('btn-users')
  usersBtn.classList.toggle('hidden', !me.isAdmin)
  usersBtn.addEventListener('click', () => openUsers(state.me))

  document.getElementById('btn-profile').addEventListener('click', () => {
    openProfile(state.me, (updated) => {
      state.me = updated
      renderOperator(updated)
    })
  })
  document.getElementById('btn-keys').addEventListener('click', openKeys)
  document.getElementById('btn-settings').addEventListener('click', openSettings)
  document.getElementById('btn-logout').addEventListener('click', async () => {
    try {
      await api.logout()
    } finally {
      location.replace('/login.html')
    }
  })

  // 窄屏下侧栏收成抽屉
  const slideRail = (out) => {
    rail.classList.toggle('out', out)
    railVeil.classList.toggle('hidden', !out)
  }
  document.getElementById('btn-rail').addEventListener('click', () => slideRail(true))
  railVeil.addEventListener('click', () => slideRail(false))
  rail.addEventListener('click', (event) => {
    // 名单上的铃铛是就地切换，不跳转到任何地方。收起抽屉会让人看不到
    // 自己刚点的那一下有没有生效，连关三个人就得开三次抽屉
    if (event.target.closest('.mute')) return
    if (event.target.closest('button')) slideRail(false)
  })

  showSkeleton()
  try {
    const { messages } = await api.messages({})
    if (messages.length > 0) {
      state.oldestId = messages[0].id
      logInner.replaceChildren()
      for (const message of messages) appendRow(message)
      toBottom()
    } else {
      state.hasMore = false
      showEmpty({ onKeys: openKeys })
    }
  } catch (err) {
    showLoadError(err instanceof ApiError ? err.message : '连不上服务端，检查网络后重新加载。')
  }

  initCommand()
  connectRealtime({ onEvent: handleEvent, onStatus: setLinkState })

  log.addEventListener('scroll', () => {
    if (log.scrollTop < 120) loadMore()
    if (atBottom()) tailHint.classList.add('hidden')
  })

  document.getElementById('btn-tail').addEventListener('click', () => {
    toBottom()
    tailHint.classList.add('hidden')
  })
}

boot()
