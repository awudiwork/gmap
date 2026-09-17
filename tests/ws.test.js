/**
 * WebSocket 握手与生命周期的回归测试。
 *
 * 用真实的 ws 客户端连真实的服务，验的是边界：
 * 没凭据怎么拒、跨站怎么拒、凭据被吊销时连接会不会断、改昵称名单跟不跟。
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmap-ws-'))
process.env.DATA_DIR = path.join(workdir, 'data')
process.env.UPLOAD_DIR = path.join(workdir, 'uploads')
process.env.ADMIN_USERNAME = 'root'
process.env.ADMIN_PASSWORD = 'admin-secret-2026'
process.env.LOGIN_RATE_PER_MINUTE = '1000'

const { createHttpServer } = await import('../server/app.js')
const { db } = await import('../server/db.js')
const { ensureAdminAccount } = await import('../server/services/user.service.js')
const { hub, CLOSE_REAUTH, CLOSE_UNAUTHORIZED } = await import('../server/ws/hub.js')

let server
let origin
let wsUrl

/** 每个身份自己保存 Cookie，用例之间不共享 */
async function login(username, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(response.status, 200)
  return response.headers.getSetCookie().map((entry) => entry.split(';')[0]).find((pair) => pair.startsWith('gmap_session='))
}

async function call(cookie, pathname, { method = 'GET', body } = {}) {
  const init = { method, headers: { Origin: origin, Cookie: cookie } }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${origin}${pathname}`, init)
  return { status: response.status, payload: await response.json() }
}

/** 建立连接并收到 hello 后返回；events 里会持续攒下之后的事件 */
function connect({ cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers } })
    const events = []
    const closed = new Promise((done) => ws.on('close', (code, reason) => done({ code, reason: reason.toString() })))
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString())
      events.push(event)
      if (event.type === 'hello') resolve({ ws, events, closed, hello: event.data })
    })
    ws.on('error', reject)
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    closed.then((result) => reject(Object.assign(new Error(`closed ${result.code}`), result)))
  })
}

/** 等到 events 里出现满足条件的事件 */
async function waitFor(events, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = events.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等不到预期的事件')
}

before(async () => {
  await ensureAdminAccount()
  server = createHttpServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws`
})

after(async () => {
  hub.close()
  await new Promise((resolve) => server.close(resolve))
  db.close()
  await fsp.rm(workdir, { recursive: true, force: true })
})

test('没有凭据：握手完成后以 4401 关闭，客户端据此去登录页而不是无限重连', async () => {
  await assert.rejects(connect(), (err) => err.code === CLOSE_UNAUTHORIZED)
})

test('跨站 Origin 被拒绝，即使带着有效 Cookie', async () => {
  const cookie = await login('root', 'admin-secret-2026')
  await assert.rejects(connect({ cookie, headers: { Origin: 'http://evil.example' } }), /HTTP 403/)
  await assert.rejects(connect({ cookie, headers: { Origin: '' } }), /HTTP 403|closed/)
})

test('有效会话：收到 hello，带在线名单和 bootId', async () => {
  const cookie = await login('root', 'admin-secret-2026')
  const client = await connect({ cookie })
  assert.equal(client.hello.user.username, 'root')
  assert.ok(client.hello.online.some((user) => user.username === undefined && user.id === client.hello.user.id))
  assert.match(client.hello.bootId, /^[0-9a-f]{16}$/)
  assert.equal(client.hello.bootId, hub.bootId)
  client.ws.close()
})

test('一次广播每条连接只收一次', async () => {
  const cookie = await login('root', 'admin-secret-2026')
  const client = await connect({ cookie })
  const sent = await call(cookie, '/api/messages', { method: 'POST', body: { kind: 'text', body: '只发一次' } })
  assert.equal(sent.status, 201)
  await waitFor(client.events, (event) => event.type === 'message' && event.data.id === sent.payload.message.id)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const copies = client.events.filter((event) => event.type === 'message' && event.data.id === sent.payload.message.id)
  assert.equal(copies.length, 1)
  client.ws.close()
})

test('改昵称后在线名单立刻用新名字', async () => {
  const root = await login('root', 'admin-secret-2026')
  const created = await call(root, '/api/admin/users', { method: 'POST', body: { username: 'renamer', password: 'renamer-pass-1', displayName: '旧名' } })
  assert.equal(created.status, 201)
  const cookie = await login('renamer', 'renamer-pass-1')

  const watcher = await connect({ cookie: root })
  const self = await connect({ cookie })
  await waitFor(watcher.events, (event) => event.type === 'presence' && event.data.online.some((user) => user.name === '旧名'))

  const renamed = await call(cookie, '/api/auth/me', { method: 'PATCH', body: { displayName: '新名' } })
  assert.equal(renamed.status, 200)
  const presence = await waitFor(watcher.events, (event) => event.type === 'presence' && event.data.online.some((user) => user.name === '新名'))
  assert.equal(presence.data.online.some((user) => user.name === '旧名'), false)
  watcher.ws.close()
  self.ws.close()
})

test('被管理员重置密码：已建立的连接以 4402 断开，在线名单里立刻消失', async () => {
  const root = await login('root', 'admin-secret-2026')
  const created = await call(root, '/api/admin/users', { method: 'POST', body: { username: 'victim', password: 'victim-pass-1', displayName: '受害者' } })
  const victimId = created.payload.user.id
  const cookie = await login('victim', 'victim-pass-1')

  const watcher = await connect({ cookie: root })
  const victim = await connect({ cookie })
  await waitFor(watcher.events, (event) => event.type === 'presence' && event.data.online.some((user) => user.id === victimId))

  const reset = await call(root, `/api/admin/users/${victimId}/password`, { method: 'PATCH', body: { password: 'new-victim-pass-1' } })
  assert.equal(reset.status, 200)
  const closed = await victim.closed
  assert.equal(closed.code, CLOSE_REAUTH)

  // 旧 Cookie 重连会被 4401 拒绝
  await assert.rejects(connect({ cookie }), (err) => err.code === CLOSE_UNAUTHORIZED)
  const presence = await waitFor(watcher.events, (event) => event.type === 'presence' && !event.data.online.some((user) => user.id === victimId))
  assert.ok(presence)
  watcher.ws.close()
})

test('注销账号：连接断开，之后不再收到任何广播', async () => {
  const root = await login('root', 'admin-secret-2026')
  const created = await call(root, '/api/admin/users', { method: 'POST', body: { username: 'goner', password: 'goner-pass-1' } })
  const gonerId = created.payload.user.id
  const cookie = await login('goner', 'goner-pass-1')
  const goner = await connect({ cookie })

  assert.equal((await call(root, `/api/admin/users/${gonerId}`, { method: 'DELETE' })).status, 200)
  const closed = await goner.closed
  assert.equal(closed.code, CLOSE_REAUTH)
  assert.equal(hub.clients.size >= 0 && [...hub.clients.values()].some((entry) => entry.user.id === gonerId), false)
})

test('自己改密码：连接被断开，拿新 Cookie 能重新连上', async () => {
  const root = await login('root', 'admin-secret-2026')
  await call(root, '/api/admin/users', { method: 'POST', body: { username: 'changer', password: 'changer-pass-1' } })
  const cookie = await login('changer', 'changer-pass-1')
  const client = await connect({ cookie })

  const response = await fetch(`${origin}/api/auth/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify({ currentPassword: 'changer-pass-1', newPassword: 'changer-pass-2' }),
  })
  assert.equal(response.status, 200)
  const fresh = response.headers.getSetCookie().map((entry) => entry.split(';')[0]).find((pair) => pair.startsWith('gmap_session='))

  const closed = await client.closed
  assert.equal(closed.code, CLOSE_REAUTH)
  await assert.rejects(connect({ cookie }), (err) => err.code === CLOSE_UNAUTHORIZED, '旧 Cookie 不能再连')
  const again = await connect({ cookie: fresh })
  assert.equal(again.hello.user.username, 'changer')
  again.ws.close()
})
