/**
 * 管理员引导的回归测试：.env 里的 ADMIN_USERNAME 是唯一的管理员来源。
 *
 * 用独立的库，把 ADMIN_USERNAME 设成 ops，库里先造一个旧管理员 admin，
 * 验证引导之后旧的被降级、名字保留给管理员。
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmap-admin-'))
process.env.DATA_DIR = path.join(workdir, 'data')
process.env.UPLOAD_DIR = path.join(workdir, 'uploads')
process.env.ADMIN_USERNAME = 'ops'
process.env.ADMIN_PASSWORD = 'ops-secret-2026'

const { db } = await import('../server/db.js')
const { createUser, ensureAdminAccount, findUserByUsername } = await import('../server/services/user.service.js')
const { createSession, resolveSession } = await import('../server/services/session.service.js')

let oldAdminId
let oldAdminToken

before(async () => {
  // 上一任管理员：曾经的 .env 写的是 admin
  const old = await createUser({ username: 'admin', password: 'old-admin-pass', isAdmin: true })
  oldAdminId = old.id
  oldAdminToken = createSession(old.id).token
})

after(async () => {
  db.close()
  await fsp.rm(workdir, { recursive: true, force: true })
})

test('管理员登录名是保留的，普通渠道注册不到', async () => {
  await assert.rejects(
    createUser({ username: 'OPS', password: 'whatever-pass-1', isAdmin: false }),
    (err) => err.code === 'username_reserved' && err.status === 409,
  )
})

test('引导后只有 .env 指定的账号是管理员，旧管理员被降级且会话吊销', async () => {
  const admin = await ensureAdminAccount()
  assert.equal(admin.username, 'ops')
  assert.equal(admin.is_admin, 1)

  const old = findUserByUsername('admin')
  assert.equal(old.is_admin, 0, '改了 ADMIN_USERNAME 之后旧管理员应降为普通用户')
  assert.equal(resolveSession(oldAdminToken), null, '降级的账号旧会话应当失效')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n, 1)
  assert.equal(old.id, oldAdminId)
})

test('引导是幂等的', async () => {
  const again = await ensureAdminAccount()
  assert.equal(again.username, 'ops')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n, 1)
})
