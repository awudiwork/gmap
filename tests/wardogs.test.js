/**
 * Wardogs 弹道数据接口的回归测试。
 *
 * 刷新周期设成 0，接口只走仓库里的快照，测试不联网。
 * 要验的是：登录才能读、返回的骨架能被前端引擎直接使用、图标路径指向真实存在的文件。
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmap-wd-test-'))
process.env.DATA_DIR = path.join(workdir, 'data')
process.env.UPLOAD_DIR = path.join(workdir, 'uploads')
process.env.ADMIN_USERNAME = 'root'
process.env.ADMIN_PASSWORD = 'admin-secret-2026'
process.env.WARDOGS_BALLISTICS_REFRESH_HOURS = '0'

const { createHttpServer } = await import('../server/app.js')
const { db } = await import('../server/db.js')
const { ensureAdminAccount } = await import('../server/services/user.service.js')
const { hub } = await import('../server/ws/hub.js')
const { isBallisticsPayload, resetBallisticsCache } = await import('../server/services/ballistics.service.js')

let server
let origin
let cookie = ''

async function call(pathname, { method = 'GET', body } = {}) {
  const init = { method, headers: { Origin: origin } }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  if (cookie) init.headers.Cookie = cookie
  const response = await fetch(`${origin}${pathname}`, init)
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(';')
    if (pair.startsWith('gmap_session=')) cookie = pair
  }
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

test('未登录读不到弹道数据', async () => {
  const res = await call('/api/wardogs/ballistics')
  assert.equal(res.status, 401)
})

test('登录后拿到快照，骨架完整', async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'root', password: 'admin-secret-2026' } })
  assert.equal(login.status, 200)

  resetBallisticsCache()
  const res = await call('/api/wardogs/ballistics')
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.source, 'snapshot', '刷新周期为 0 时必须走快照，不能联网')
  assert.ok(isBallisticsPayload(res.payload.ballistics))
  assert.equal(typeof res.payload.generatedAt, 'string')
  assert.ok(Number.isFinite(res.payload.fetchedAt))
})

test('武器图标指向仓库里真实存在的文件', async () => {
  const res = await call('/api/wardogs/ballistics')
  const entries = Object.entries(res.payload.weapons)
  assert.ok(entries.length >= 20)
  for (const [slug, meta] of entries) {
    assert.ok(Number.isFinite(meta.unlock), `${slug} 缺解锁等级`)
    if (meta.icon === null) continue
    assert.match(meta.icon, /^\/wardogs\/icons\/[\w-]+\.webp$/, `${slug} 的图标路径不是站内路径`)
    assert.ok(fs.existsSync(path.join(ROOT, 'public', meta.icon)), `${slug} 的图标文件不存在：${meta.icon}`)
  }
})

test('第二次请求命中缓存，仍然是同一份数据', async () => {
  const first = await call('/api/wardogs/ballistics')
  const second = await call('/api/wardogs/ballistics')
  assert.equal(first.payload.fetchedAt, second.payload.fetchedAt)
})

test('离线模式下实时数据如实报 503，进度表走快照', async () => {
  const status = await call('/api/wardogs/status')
  assert.equal(status.status, 503)
  assert.equal(status.payload.code, 'upstream_unavailable')

  const market = await call('/api/wardogs/market')
  assert.equal(market.status, 503)

  const progression = await call('/api/wardogs/progression')
  assert.equal(progression.status, 200)
  assert.equal(progression.payload.source, 'snapshot')
  assert.equal(progression.payload.roles.length, 6)
  assert.ok(progression.payload.actions.every((action) => typeof action.label === 'string'))
})

test('区 id 形状不对是 400，不会去碰上游', async () => {
  const bad = await call('/api/wardogs/status/servers?zone=asia%20east')
  assert.equal(bad.status, 400)
  assert.equal(bad.payload.code, 'invalid_zone')
  const missing = await call('/api/wardogs/status/servers')
  assert.equal(missing.status, 400)
})

test('情报接口同样要登录', async () => {
  const saved = cookie
  cookie = ''
  for (const pathname of ['/api/wardogs/status', '/api/wardogs/market', '/api/wardogs/progression']) {
    assert.equal((await call(pathname)).status, 401, pathname)
  }
  cookie = saved
})

test('坏数据不会被当成弹道数据', () => {
  assert.equal(isBallisticsPayload(null), false)
  assert.equal(isBallisticsPayload({}), false)
  assert.equal(isBallisticsPayload({ assumedHealth: 100, weapons: [] }), false)
})
