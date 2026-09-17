/**
 * 本机偏好。只影响当前浏览器，不上服务端。
 *
 * 之所以跟设备走而不是跟账号走：同一个人在游戏机上要自动弹图，
 * 在手机上只想看消息，两台机器的期望本来就不一样。
 */
const STORAGE_KEY = 'gmap.settings.v1'

export const DEFAULTS = Object.freeze({
  /** 收到新图自动展开，地图同步的主开关 */
  autoOpenImages: true,
  /** 'api' 只认带 Key 调上传接口推来的图；'all' 网页里发的也算 */
  autoOpenSource: 'api',
  /**
   * 自己从客户端推的图，要不要在自己这块屏幕上展开。
   * 默认关：多数情况是几个人互相同步，自己刚推的那张不必再弹一次。
   * 一个人用两块屏时把它打开。
   */
  autoOpenOwnPush: false,
  /** 自动展开时给一声提示 */
  sound: false,

  /**
   * 被单独关掉的人：他们推的图不再自动展开，消息照常收。
   * 存 { id, name } 而不是光存 id，是为了他离线、不在在线列表里时，
   * 设置面板里还能认出这是谁并把他放回来。
   */
  mutedUsers: [],

  /** 看图器：下次打开沿用上次的缩放，而不是每次都适应窗口 */
  rememberView: false,
  /** 沿用缩放时，位置回到画面中心；关掉则连上次盯着的位置一起沿用 */
  centerOnOpen: true,

  /**
   * 记住的视图。0 表示还没记过。
   *
   * 位置存的是归一化锚点而不是像素偏移：视口大小或图片尺寸一变，
   * 像素偏移就错位了。锚点表示"画面中心落在图片的哪个位置"，
   * 换一张尺寸不同的地图也能还原到同一个角落。
   */
  viewScale: 0,
  viewAnchor: { u: 0.5, v: 0.5 },
})

const isAnchor = (value) =>
  value !== null && typeof value === 'object'
  && Number.isFinite(value.u) && Number.isFinite(value.v)

/** Object.freeze 是浅的，结构化字段必须复制出来，否则各处共用同一个实例 */
const freshDefaults = () => ({
  ...DEFAULTS,
  mutedUsers: [],
  viewAnchor: { ...DEFAULTS.viewAnchor },
})

/**
 * 把读到的东西收敛成一份合法配置。
 *
 * localStorage 是用户能直接编辑的，读进来的值不能拿去就算：
 * 坏掉的锚点会让看图器算出 NaN 位置，图会整个消失；
 * 坏掉的静音项会在设置面板里渲染成 [object Object]。
 *
 * 纯函数，与 read 分开是为了能直接测这些失败分支。
 *
 * @param {unknown} parsed JSON.parse 的结果，或 null
 */
export function sanitize(parsed) {
  const merged = freshDefaults()
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return merged

  // 只接受已知字段，忽略旧版本残留，避免结构漂移
  for (const key of Object.keys(DEFAULTS)) {
    if (key in parsed) merged[key] = parsed[key]
  }

  if (!isAnchor(merged.viewAnchor)) merged.viewAnchor = { ...DEFAULTS.viewAnchor }
  if (!Number.isFinite(merged.viewScale) || merged.viewScale < 0) merged.viewScale = 0

  merged.mutedUsers = Array.isArray(merged.mutedUsers)
    ? merged.mutedUsers
      .filter((entry) => entry !== null && typeof entry === 'object' && Number.isInteger(entry.id))
      // 名字只用来显示，不是字符串就丢掉，让面板退回"用户 12"的兜底写法
      .map((entry) => ({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : '' }))
    : []

  return merged
}

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return sanitize(raw ? JSON.parse(raw) : null)
  } catch {
    // 读不到或解析失败都退回默认值，不让一份坏数据把整个页面卡住
    return sanitize(null)
  }
}

let current = read()
const listeners = new Set()

export const settings = {
  get: () => ({ ...current }),

  set(patch) {
    current = { ...current, ...patch }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
    } catch {
      // 隐私模式下写不进去，内存里的设置仍然生效
    }
    for (const listener of listeners) listener(this.get())
  },

  subscribe(listener) {
    listeners.add(listener)
    listener(this.get())
    return () => listeners.delete(listener)
  },
}

/**
 * 判断一条消息该不该触发自动展开。纯函数，config 由调用方传入，便于直接测。
 *
 * 六条规则，全部成立才展开（任何一条不满足就不弹）：
 *  1. 得是当前所在频道的消息。切频道的意思就是"我现在只关心这个"，
 *     别的频道有新图时只在频道栏上点个未读，不该抢过来占满屏幕。
 *  2. 总开关得开着。
 *  3. 得是一张带得出地址的图片。
 *  4. 来源过滤：默认只认带 Key 推来的图，网页里发的表情包不该打断你。
 *  5. 自己发的分两种：网页里手动发的**永远**不弹，刚拖进去就在眼前；
 *     从客户端推的由开关决定，因为"游戏机推给第二屏"是一个人的正常用法，
 *     两边是同一个账号。
 *  6. 被单独关掉的人不弹。
 *
 * @param {{ message: object, meId: number, config: object, currentRoom?: string }} input
 *        currentRoom 省略时不做频道判断，便于单独测其它规则
 */
export function decideAutoOpen({ message, meId, config, currentRoom }) {
  if (currentRoom !== undefined && message.room !== currentRoom) return false
  if (!config.autoOpenImages) return false
  if (message.kind !== 'file' || message.file?.category !== 'image' || !message.file?.url) return false
  if (config.autoOpenSource === 'api' && message.source !== 'api') return false

  const mine = message.user.id === meId
  if (mine && message.source === 'web') return false
  if (mine && message.source === 'api' && !config.autoOpenOwnPush) return false

  // 单独关掉的人，只是不再打断你，消息照常收
  if (config.mutedUsers?.some((entry) => entry.id === message.user.id)) return false

  return true
}

/** 取当前设置做一次判断 */
export function shouldAutoOpen(message, meId, currentRoom) {
  return decideAutoOpen({ message, meId, currentRoom, config: settings.get() })
}

/** 这个人推的图还会不会自动展开 */
export const isMuted = (userId) => current.mutedUsers.some((entry) => entry.id === userId)

/** 把某人移出静音名单 */
export function unmute(userId) {
  settings.set({ mutedUsers: current.mutedUsers.filter((entry) => entry.id !== userId) })
}

/**
 * 开关某个人。关掉只影响自动展开，消息照常收、照常显示在聊天里。
 *
 * @param {{ id: number, name: string }} user
 * @returns {boolean} 切换之后他是否处于"被关掉"状态
 */
export function toggleMute(user) {
  const muted = current.mutedUsers
  const wasMuted = muted.some((entry) => entry.id === user.id)
  if (wasMuted) {
    unmute(user.id)
  } else {
    // 同时记下名字，他离线后在设置面板里还认得出是谁
    settings.set({ mutedUsers: [...muted, { id: user.id, name: user.name }] })
  }
  return !wasMuted
}

/**
 * 用在线名单里的最新昵称刷新静音记录。
 *
 * 存进去的名字是当时的快照，对方改了昵称之后，设置面板会一直显示旧名，
 * 和在线名单对不上号。
 *
 * @param {Array<{ id: number, name: string }>} users 当前在线的人
 * @returns {boolean} 是否真的改了，没改就不写存储，免得触发无谓的通知
 */
export function refreshMutedNames(users) {
  const online = new Map(users.map((user) => [user.id, user.name]))
  let changed = false
  const next = current.mutedUsers.map((entry) => {
    const fresh = online.get(entry.id)
    if (fresh === undefined || fresh === entry.name) return entry
    changed = true
    return { id: entry.id, name: fresh }
  })
  if (changed) settings.set({ mutedUsers: next })
  return changed
}

/** 用 Web Audio 合成提示音，省掉音频文件和自动播放策略的麻烦 */
export function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = 1180
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.11, ctx.currentTime + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.18)
    osc.onended = () => ctx.close()
  } catch {
    // 浏览器未授权播放，静默跳过
  }
}
