/**
 * WebSocket 广播中心（机制层）。
 *
 * 职责边界：
 *  - 只负责"谁连着 / 把事件推给谁 / 断线清理"，不含任何业务规则。
 *  - 鉴权策略由调用方以 authenticate 回调注入，本模块不认识 Cookie 也不认识用户表。
 *  - 通道是单向的：业务动作一律走 HTTP 接口，WS 只做下行推送。
 *    这样消息的校验、限流、事务只有一条代码路径，不需要在两套协议里各实现一遍。
 *
 * 下行事件：
 *   { type: 'hello',         data: { user, online } }
 *   { type: 'message',       data: <messageDto> }
 *   { type: 'presence',      data: { online: [...] } }
 *   { type: 'files_expired', data: { fileIds: number[] } }
 */
import { WebSocketServer } from 'ws'

const HEARTBEAT_INTERVAL_MS = 30_000

export class Hub {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true })
    /** @type {Map<import('ws').WebSocket, { user: object, alive: boolean }>} */
    this.clients = new Map()
    this.heartbeatTimer = null
  }

  /**
   * 接管 HTTP 服务器的 upgrade 事件。
   * @param {import('node:http').Server} httpServer
   * @param {{ path?: string, authenticate: (req) => object | null }} options
   */
  attach(httpServer, { path = '/ws', authenticate }) {
    httpServer.on('upgrade', (req, socket, head) => {
      let pathname
      try {
        pathname = new URL(req.url, 'http://placeholder').pathname
      } catch {
        socket.destroy()
        return
      }
      if (pathname !== path) {
        socket.destroy()
        return
      }

      const user = authenticate(req)
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => this.#register(ws, user))
    })

    this.heartbeatTimer = setInterval(() => this.#sweep(), HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  #register(ws, user) {
    this.clients.set(ws, { user, alive: true })

    ws.on('pong', () => {
      const entry = this.clients.get(ws)
      if (entry) entry.alive = true
    })
    ws.on('close', () => {
      this.clients.delete(ws)
      this.broadcast({ type: 'presence', data: { online: this.onlineUsers() } })
    })
    ws.on('error', () => ws.terminate())
    // 上行不承载业务语义，收到任何内容都忽略，避免给出可被利用的第二条写入路径
    ws.on('message', () => {})

    this.#send(ws, { type: 'hello', data: { user, online: this.onlineUsers() } })
    this.broadcast({ type: 'presence', data: { online: this.onlineUsers() } })
  }

  /** 断开心跳无响应的连接，回收僵尸 socket */
  #sweep() {
    for (const [ws, entry] of this.clients) {
      if (!entry.alive) {
        ws.terminate()
        this.clients.delete(ws)
        continue
      }
      entry.alive = false
      try {
        ws.ping()
      } catch {
        ws.terminate()
        this.clients.delete(ws)
      }
    }
  }

  #send(ws, event) {
    if (ws.readyState !== ws.OPEN) return
    try {
      ws.send(JSON.stringify(event))
    } catch {
      ws.terminate()
      this.clients.delete(ws)
    }
  }

  /** 把事件推给全部在线连接 */
  broadcast(event) {
    const payload = JSON.stringify(event)
    for (const [ws] of this.clients) {
      if (ws.readyState !== ws.OPEN) continue
      try {
        ws.send(payload)
      } catch {
        ws.terminate()
        this.clients.delete(ws)
      }
    }
  }

  /** 在线用户（按用户去重，同一人开多个标签页只算一个） */
  onlineUsers() {
    const byId = new Map()
    for (const { user } of this.clients.values()) {
      byId.set(user.id, { id: user.id, name: user.name })
    }
    return [...byId.values()]
  }

  close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    for (const [ws] of this.clients) ws.terminate()
    this.clients.clear()
    this.wss.close()
  }
}

export const hub = new Hub()
