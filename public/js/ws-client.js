/**
 * WebSocket 订阅端：只收不发，断线按指数退避重连。
 *
 * 任何时刻只有一条连接。新建之前先把旧的彻底关掉并摘掉监听，
 * 否则重连交错时会短暂挂着两条，同一条广播就收两次。
 *
 * 关闭码（和服务端 hub.js 约定）：
 *   4401  凭据无效，去登录页
 *   4402  凭据刚换过（改密码 / 被重置），立刻重连；重连再被 4401 拒绝才是真的下线
 *
 * 失败语义：连接关闭时不静默吞掉，通过 onStatus 上报，
 * 由页面决定怎么提示用户（顶栏的连接指示灯）。
 */
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 20_000

const CLOSE_UNAUTHORIZED = 4401
const CLOSE_REAUTH = 4402

export function connectRealtime({ onEvent, onStatus }) {
  let socket = null
  let attempt = 0
  let retryTimer = null
  let stopped = false

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

  /** 关掉当前连接并不再理会它之后的任何事件 */
  const discard = () => {
    if (!socket) return
    const old = socket
    socket = null
    old.onopen = null
    old.onmessage = null
    old.onclose = null
    old.onerror = null
    if (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING) old.close()
  }

  const scheduleRetry = (delay) => {
    if (stopped) return
    clearTimeout(retryTimer)
    retryTimer = setTimeout(open, delay)
  }

  const backoff = () => {
    attempt += 1
    return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS)
  }

  function open() {
    if (stopped) return
    clearTimeout(retryTimer)
    discard()
    onStatus('connecting')
    const ws = new WebSocket(url)
    socket = ws

    ws.onopen = () => {
      attempt = 0
      onStatus('online')
    }

    ws.onmessage = (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload && typeof payload.type === 'string') onEvent(payload)
    }

    ws.onclose = (event) => {
      if (socket === ws) socket = null
      if (event.code === CLOSE_UNAUTHORIZED || event.code === 1008) {
        stopped = true
        onStatus('unauthorized')
        return
      }
      onStatus('offline')
      // 凭据刚换过：新 Cookie 已经在手里，不必等退避
      scheduleRetry(event.code === CLOSE_REAUTH ? 0 : backoff())
    }

    ws.onerror = () => {
      // close 事件随后一定会触发，这里不重复安排重连
      ws.close()
    }
  }

  open()

  // 从后台切回前台时立刻补一次连接，不等退避计时器
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || stopped) return
    if (socket === null) {
      attempt = 0
      open()
    }
  })

  return {
    close() {
      stopped = true
      clearTimeout(retryTimer)
      discard()
    },
  }
}
