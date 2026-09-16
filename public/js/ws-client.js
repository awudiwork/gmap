/**
 * WebSocket 订阅端：只收不发，断线按指数退避重连。
 *
 * 失败语义：连接关闭时不静默吞掉，通过 onStatus 上报，
 * 由页面决定怎么提示用户（顶栏的连接指示灯）。
 */
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 20_000

export function connectRealtime({ onEvent, onStatus }) {
  let socket = null
  let attempt = 0
  let retryTimer = null
  let stopped = false

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

  const scheduleRetry = () => {
    if (stopped) return
    attempt += 1
    const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS)
    retryTimer = setTimeout(open, delay)
  }

  function open() {
    if (stopped) return
    onStatus('connecting')
    socket = new WebSocket(url)

    socket.addEventListener('open', () => {
      attempt = 0
      onStatus('online')
    })

    socket.addEventListener('message', (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload && typeof payload.type === 'string') onEvent(payload)
    })

    socket.addEventListener('close', (event) => {
      onStatus('offline')
      // 1008/4401 之类的鉴权失败没必要重试，交给页面跳登录
      if (event.code === 1008) {
        stopped = true
        onStatus('unauthorized')
        return
      }
      scheduleRetry()
    })

    socket.addEventListener('error', () => {
      // close 事件随后一定会触发，这里不重复安排重连
      socket?.close()
    })
  }

  open()

  // 从后台切回前台时立刻补一次连接，不等退避计时器
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket?.readyState === WebSocket.CLOSED && !stopped) {
      clearTimeout(retryTimer)
      attempt = 0
      open()
    }
  })

  return {
    close() {
      stopped = true
      clearTimeout(retryTimer)
      socket?.close()
    },
  }
}
