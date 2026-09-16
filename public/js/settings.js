/**
 * 本机偏好。只影响当前浏览器，不上服务端。
 *
 * 之所以跟设备走而不是跟账号走：同一个人在游戏机上要自动弹图，
 * 在手机上只想看消息，两台机器的期望本来就不一样。
 */
const STORAGE_KEY = 'gmap.settings.v1'

const DEFAULTS = Object.freeze({
  /** 收到新图自动展开，地图同步的主开关 */
  autoOpenImages: true,
  /** 'api' 只认带 Key 调上传接口推来的图；'all' 网页里发的也算 */
  autoOpenSource: 'api',
  /** 自动展开时给一声提示 */
  sound: false,

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

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    // 只接受已知字段，忽略旧版本残留，避免结构漂移
    const parsed = JSON.parse(raw)
    const merged = { ...DEFAULTS }
    for (const key of Object.keys(DEFAULTS)) {
      if (key in parsed) merged[key] = parsed[key]
    }

    // 这两个是仅有的结构化字段。localStorage 是用户可改的，存进来的东西
    // 不能直接拿去算：坏掉的锚点会让看图器算出 NaN 位置，图会整个消失
    if (!isAnchor(merged.viewAnchor)) merged.viewAnchor = { ...DEFAULTS.viewAnchor }
    if (!Number.isFinite(merged.viewScale) || merged.viewScale < 0) merged.viewScale = 0

    return merged
  } catch {
    return { ...DEFAULTS }
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
 * 这条消息该不该触发自动展开。
 *
 * 关于"自己发的"：只排除自己在网页里手动发的图，刚拖进去就在眼前，再弹一次是打扰。
 * 自己用 Key 从客户端推的图照常展开，因为"游戏机推给第二屏"本来就是一个人的用法，
 * 两边是同一个账号。
 */
export function shouldAutoOpen(message, meId) {
  const config = settings.get()
  if (!config.autoOpenImages) return false
  if (message.kind !== 'file' || message.file?.category !== 'image' || !message.file?.url) return false
  if (config.autoOpenSource === 'api' && message.source !== 'api') return false
  if (message.source === 'web' && message.user.id === meId) return false
  return true
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
