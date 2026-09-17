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
 *   { type: 'hello',            data: { user, online, bootId } }
 *   { type: 'message',          data: <messageDto> }
 *   { type: 'presence',         data: { online: [...] } }
 *   { type: 'messages_expired', data: { ids: number[], rooms: string[] } }
 *
 * 关闭码（给客户端分辨"该重连"还是"该去登录"）：
 *   4401  握手时凭据无效：会话过期、账号注销。别再重连，去登录页
 *   4402  凭据刚被换掉或吊销：改密码、被重置、被注销。立刻重连一次，重连再被拒才是真的下线
 */
import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'

const HEARTBEAT_INTERVAL_MS = 30_000

export const CLOSE_UNAUTHORIZED = 4401
export const CLOSE_REAUTH = 4402

/** Origin 头的 host 部分；解析不了返回 null */
function originHost(origin) {
  try {
    return new URL(origin).host
  } catch {
    return null
  }
}

export class Hub {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true })
    /** @type {Map<import('ws').WebSocket, { user: object, alive: boolean }>} */
    this.clients = new Map()
    this.heartbeatTimer = null
    /**
     * 本进程的标识。页面拿到的 bootId 和上次不一样，就知道服务重启过，
     * 代码可能已经更新，该把自己刷新一遍。
     */
    this.bootId = crypto.randomBytes(8).toString('hex')
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

      // 浏览器发起的 WebSocket 一定带 Origin。跨站页面也能让浏览器附带本站 Cookie
      // （SameSite 不区分端口和子域），HTTP 写操作有 verifyOrigin 挡着，这里得自己挡
      const origin = req.headers.origin
      if (!origin || originHost(origin) !== req.headers.host) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }

      let user
      try {
        user = authenticate(req)
      } catch (err) {
        // 鉴权查库偶发失败不能变成 uncaughtException 把进程带走
        console.error('[ws] 握手鉴权异常', err)
        socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }

      // 凭据无效也先完成握手再用关闭码拒绝：直接断 TCP 的话浏览器只看到 1006，
      // 分不清"网断了"和"该去登录了"，会一直重连下去
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        if (!user) {
          ws.close(CLOSE_UNAUTHORIZED, 'unauthorized')
          return
        }
        this.#register(ws, user)
      })
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
      this.broadcastPresence()
    })
    ws.on('error', () => ws.terminate())
    // 上行不承载业务语义，收到任何内容都忽略，避免给出可被利用的第二条写入路径
    ws.on('message', () => {})

    this.#send(ws, { type: 'hello', data: { user, online: this.onlineUsers(), bootId: this.bootId } })
    this.broadcastPresence()
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

  broadcastPresence() {
    this.broadcast({ type: 'presence', data: { online: this.onlineUsers() } })
  }

  /** 在线用户（按用户去重，同一人开多个标签页只算一个） */
  onlineUsers() {
    const byId = new Map()
    for (const { user } of this.clients.values()) {
      byId.set(user.id, { id: user.id, name: user.name })
    }
    return [...byId.values()]
  }

  /**
   * 凭据被换掉或吊销时把这个人的连接全部断开。
   * 吊销会话只影响之后的 HTTP 请求，已经建立的 WS 不重新鉴权，不断开它就会一直收广播。
   * @returns {number} 断开了几条
   */
  disconnectUser(userId) {
    let count = 0
    for (const [ws, entry] of this.clients) {
      if (entry.user.id !== userId) continue
      this.clients.delete(ws)
      count += 1
      try {
        ws.close(CLOSE_REAUTH, 'reauth')
      } catch {
        ws.terminate()
      }
    }
    if (count > 0) this.broadcastPresence()
    return count
  }

  /**
   * 用户资料变了（改昵称），刷新连接上缓存的快照并重播在线名单，
   * 否则名单上一直是旧名字，和消息流里的新名字对不上。
   */
  updateUser(user) {
    let touched = false
    for (const entry of this.clients.values()) {
      if (entry.user.id !== user.id) continue
      entry.user = user
      touched = true
    }
    if (touched) this.broadcastPresence()
    return touched
  }

  close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    for (const [ws] of this.clients) ws.terminate()
    this.clients.clear()
    this.wss.close()
  }
}

export const hub = new Hub()
