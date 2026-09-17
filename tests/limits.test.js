/**
 * 限流与节流的接口级回归测试。
 *
 * 单独一个文件、把阈值调到很小：主测试文件里登录和发消息几十次，
 * 阈值一小就全红；而限流的价值又恰恰在于路由怎么接的、返回什么码，纯函数测不到。
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmap-limits-'))
process.env.DATA_DIR = path.join(workdir, 'data')
process.env.UPLOAD_DIR = path.join(workdir, 'uploads')
process.env.ADMIN_USERNAME = 'root'
process.env.ADMIN_PASSWORD = 'admin-secret-2026'
process.env.LOGIN_RATE_PER_MINUTE = '4'
process.env.UPLOAD_MIN_INTERVAL_MS = '1000'
process.env.UPLOAD_RATE_PER_MINUTE = '100'
process.env.WARDOGS_BALLISTICS_REFRESH_HOURS = '0'

const { createHttpServer } = await import('../server/app.js')
const { db } = await import('../server/db.js')
const { ensureAdminAccount } = await import('../server/services/user.service.js')
const { hub } = await import('../server/ws/hub.js')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(64, 7)])

let server
let origin
let cookie = ''

async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { Origin: origin, ...headers } }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  if (cookie && !headers.Cookie) init.headers.Cookie = cookie
  const response = await fetch(`${origin}${pathname}`, init)
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(';')
    if (pair.startsWith('gmap_session=')) cookie = pair
  }
  return { status: response.status, payload: await response.json() }
}

async function upload(apiKey) {
  const form = new FormData()
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'map.png')
  const response = await fetch(`${origin}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form })
  return { status: response.status, payload: await response.json() }
}

before(async () => {
  await ensureAdminAccount()
  server = createHttpServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  hub.close()
  await new Promise((resolve) => server.close(resolve))
  db.close()
  await fsp.rm(workdir, { recursive: true, force: true })
})

test('登录成功不会清空来源 IP 的计数，拿一个合法账号刷不掉限流', async () => {
  // 上限 4 次：猜两次 → 正确登录一次 → 再猜一次 → 第五次该被挡
  const wrong = { username: 'root', password: 'guess' }
  assert.equal((await call('/api/auth/login', { method: 'POST', body: wrong })).status, 401)
  assert.equal((await call('/api/auth/login', { method: 'POST', body: wrong })).status, 401)
  const ok = await call('/api/auth/login', { method: 'POST', body: { username: 'root', password: 'admin-secret-2026' } })
  assert.equal(ok.status, 200)
  assert.equal((await call('/api/auth/login', { method: 'POST', body: wrong })).status, 401)

  const blocked = await call('/api/auth/login', { method: 'POST', body: wrong })
  assert.equal(blocked.status, 429)
  assert.equal(blocked.payload.code, 'too_many_attempts')
})

test('API Key 上传 1 秒内的第二张被节流成 429 upload_too_fast', async () => {
  // 上一个用例已经登录成 root
  const { payload } = await call('/api/keys', { method: 'POST', body: { name: '连击测试' } })
  const first = await upload(payload.plain)
  assert.equal(first.status, 201)
  const second = await upload(payload.plain)
  assert.equal(second.status, 429)
  assert.equal(second.payload.code, 'upload_too_fast')
  assert.match(second.payload.message, /秒后再试/)
})

test('API Key 只能推图，发不了文字和代码', async () => {
  const { payload } = await call('/api/keys', { method: 'POST', body: { name: '只许推图' } })
  const response = await fetch(`${origin}/api/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${payload.plain}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'text', body: '用 Key 发文字' }),
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).code, 'not_logged_in')
})
