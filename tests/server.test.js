/**
 * 关键路径的端到端回归测试：注册登录 → 发消息 → 生成 Key → 客户端上传 → 删除 Key → 过期清理。
 *
 * 用真实 HTTP + 真实 SQLite（临时目录），不做 mock：
 * 这条链路的价值恰恰在于中间件顺序、鉴权分支和磁盘副作用，mock 掉就测不到了。
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmap-test-'))
process.env.DATA_DIR = path.join(workdir, 'data')
process.env.UPLOAD_DIR = path.join(workdir, 'uploads')
process.env.ALLOW_REGISTRATION = 'true'
process.env.REGISTRATION_CODE = ''
process.env.ADMIN_USERNAME = 'root'
process.env.ADMIN_PASSWORD = 'admin-secret-2026'
process.env.FILE_RETENTION_HOURS = '1'
process.env.UPLOAD_RATE_PER_MINUTE = '100'

// 必须在环境变量就位后再加载，config 是在 import 时求值的
const { createHttpServer } = await import('../server/app.js')
const { db } = await import('../server/db.js')
const { runCleanup } = await import('../server/services/cleanup.service.js')
const { ensureAdminAccount } = await import('../server/services/user.service.js')
const { hub } = await import('../server/ws/hub.js')

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

let server
let origin
let cookie = ''

/** 统一带上 Origin（服务端对会话写操作做同源校验）与已保存的 Cookie */
async function call(pathname, { method = 'GET', body, headers = {}, raw } = {}) {
  const init = { method, headers: { Origin: origin, ...headers } }
  if (raw !== undefined) {
    init.body = raw
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  // 显式传入的 Cookie / Authorization 优先，用于验证"旧凭据是否已失效"这类场景
  if (cookie && !headers.Authorization && !headers.Cookie) init.headers.Cookie = cookie

  const response = await fetch(`${origin}${pathname}`, init)
  const setCookie = response.headers.getSetCookie?.() ?? []
  for (const entry of setCookie) {
    const [pair] = entry.split(';')
    if (pair.startsWith('gmap_session=')) cookie = pair
  }
  const text = await response.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text
  }
  return { status: response.status, payload, response }
}

function pngBlob(extraBytes = 64) {
  return new Blob([Buffer.from([...PNG_HEADER, ...Buffer.alloc(extraBytes, 7)])], { type: 'image/png' })
}

/** 切换当前测试身份。用例之间不再靠"保存/恢复 cookie"来隐式串联状态 */
async function loginAs(username, password) {
  cookie = ''
  const res = await call('/api/auth/login', { method: 'POST', body: { username, password } })
  assert.equal(res.status, 200, `登录 ${username} 失败：${JSON.stringify(res.payload)}`)
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

test('未登录时读消息返回 401', async () => {
  const { status, payload } = await call('/api/messages')
  assert.equal(status, 401)
  assert.equal(payload.code, 'missing_credentials')
})

test('.env 里的管理员账号在启动时被建好', async () => {
  const { status, payload } = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'root', password: 'admin-secret-2026' },
  })
  assert.equal(status, 200)
  assert.equal(payload.user.isAdmin, true, '管理员身份应由 .env 决定')
  cookie = ''
})

test('注册用户并自动登录，但拿不到管理员身份', async () => {
  const { status, payload } = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'scout', password: 'map-sync-2026', displayName: '侦察兵' },
  })
  assert.equal(status, 201)
  assert.equal(payload.user.name, '侦察兵')
  assert.equal(payload.user.isAdmin, false, '自助注册不得产出管理员')
  assert.ok(cookie.startsWith('gmap_session='), '应当下发会话 Cookie')
})

test('普通用户访问管理接口返回 403', async () => {
  const list = await call('/api/admin/users')
  assert.equal(list.status, 403)
  assert.equal(list.payload.code, 'not_admin')

  const create = await call('/api/admin/users', {
    method: 'POST',
    body: { username: 'sneaky', password: 'sneaky-password' },
  })
  assert.equal(create.status, 403)
})

test('重复用户名注册被拒', async () => {
  const saved = cookie
  const { status, payload } = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'SCOUT', password: 'another-password' },
  })
  assert.equal(status, 409)
  assert.equal(payload.code, 'username_taken')
  cookie = saved
})

test('弱密码被拒', async () => {
  const { status, payload } = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'weakling', password: '123' },
  })
  assert.equal(status, 400)
  assert.equal(payload.code, 'invalid_password')
})

test('密码错误时返回 401 且不泄露账号是否存在', async () => {
  const { status, payload } = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'scout', password: 'wrong-password' },
  })
  assert.equal(status, 401)
  assert.equal(payload.code, 'invalid_credentials')

  const missing = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'nobody-here', password: 'wrong-password' },
  })
  assert.equal(missing.payload.code, 'invalid_credentials', '不存在的账号应返回相同的错误码')
})

test('发送文字与代码块消息', async () => {
  const text = await call('/api/messages', { method: 'POST', body: { kind: 'text', body: '北区已清' } })
  assert.equal(text.status, 201)
  assert.equal(text.payload.message.source, 'web')

  const code = await call('/api/messages', {
    method: 'POST',
    body: { kind: 'code', body: 'const a = 1', lang: 'JS' },
  })
  assert.equal(code.status, 201)
  assert.equal(code.payload.message.lang, 'js', '语言标记应归一化为小写')

  const empty = await call('/api/messages', { method: 'POST', body: { kind: 'text', body: '   ' } })
  assert.equal(empty.status, 400)
  assert.equal(empty.payload.code, 'empty_body')

  const badLang = await call('/api/messages', {
    method: 'POST',
    body: { kind: 'code', body: 'x', lang: 'j s;drop' },
  })
  assert.equal(badLang.payload.code, 'invalid_lang')
})

test('历史消息按时间正序返回', async () => {
  const { status, payload } = await call('/api/messages')
  assert.equal(status, 200)
  assert.ok(payload.messages.length >= 2)
  const ids = payload.messages.map((m) => m.id)
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b))
})

test('跨站写操作被拒绝', async () => {
  const { status, payload } = await call('/api/messages', {
    method: 'POST',
    body: { kind: 'text', body: 'csrf' },
    headers: { Origin: 'http://evil.example' },
  })
  assert.equal(status, 403)
  assert.equal(payload.code, 'cross_origin')
})

let apiKey = ''

test('生成 API Key，明文只返回一次', async () => {
  const { status, payload } = await call('/api/keys', { method: 'POST', body: { name: '游戏本截图工具' } })
  assert.equal(status, 201)
  assert.ok(payload.plain.startsWith('gmap_'))
  assert.equal(payload.key.prefix, payload.plain.slice(0, 12))
  apiKey = payload.plain

  const list = await call('/api/keys')
  assert.equal(list.payload.keys.length, 1)
  assert.equal(list.payload.keys[0].plain, undefined, '列表接口不得返回明文 Key')
})

test('无凭据上传被拒，且不在磁盘留下文件', async () => {
  const before = fs.readdirSync(process.env.UPLOAD_DIR).length
  const form = new FormData()
  form.append('file', pngBlob(), 'map.png')

  const response = await fetch(`${origin}/api/upload`, { method: 'POST', body: form })
  assert.equal(response.status, 401)
  assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, before, '鉴权失败时不应落盘')
})

test('伪造的 API Key 被拒', async () => {
  const form = new FormData()
  form.append('file', pngBlob(), 'map.png')
  const response = await fetch(`${origin}/api/upload`, {
    method: 'POST',
    headers: { Authorization: 'Bearer gmap_0000000000000000000000000000000000000000' },
    body: form,
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).code, 'invalid_api_key')
})

let uploadedFileId = 0

test('截图客户端用 API Key 上传图片，自动进聊天室', async () => {
  const form = new FormData()
  form.append('file', pngBlob(), '地图 截图.png')
  form.append('caption', '北区刷新')

  const response = await fetch(`${origin}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  assert.equal(response.status, 201)
  const payload = await response.json()

  assert.equal(payload.message.source, 'api', '客户端来源应标记为 api，前端据此决定是否自动弹图')
  assert.equal(payload.message.kind, 'file')
  assert.equal(payload.message.body, '北区刷新')
  assert.equal(payload.file.category, 'image')
  assert.equal(payload.file.mime, 'image/png')
  assert.equal(payload.file.name, '地图 截图.png')
  uploadedFileId = payload.file.id

  const stored = db.prepare('SELECT stored_name FROM files WHERE id = ?').get(uploadedFileId)
  assert.match(stored.stored_name, /^[0-9a-f]{32}$/, '磁盘文件名应是无扩展名的随机串')
  assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, stored.stored_name)))
})

test('伪装成 PNG 的 HTML 被降级为附件下载', async () => {
  const form = new FormData()
  form.append('file', new Blob(['<html><script>alert(1)</script>'], { type: 'image/png' }), 'evil.png')

  const response = await fetch(`${origin}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  assert.equal(response.status, 201)
  const { file } = await response.json()
  assert.equal(file.category, 'file', '嗅探不出来的内容不得归入 image')
  assert.equal(file.mime, 'application/octet-stream')

  const fetched = await call(`/api/files/${file.id}`)
  assert.equal(fetched.response.headers.get('content-type'), 'application/octet-stream')
  assert.match(fetched.response.headers.get('content-disposition'), /^attachment/)
  assert.equal(fetched.response.headers.get('x-content-type-options'), 'nosniff')
})

test('说明文字超长时，已落盘的文件被回滚掉', async () => {
  const before = fs.readdirSync(process.env.UPLOAD_DIR).length
  const rows = db.prepare('SELECT COUNT(*) AS n FROM files').get().n

  const form = new FormData()
  form.append('file', pngBlob(), 'map.png')
  form.append('caption', 'x'.repeat(4001))

  const response = await fetch(`${origin}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'body_too_long')

  // 文件在 multer 阶段就已经落盘入库了，消息建不成时必须连带清掉
  assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, before, '磁盘上不应留下这个文件')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, rows, '库里不应留下这条记录')
})

test('空文件被拒且不留残留', async () => {
  const before = fs.readdirSync(process.env.UPLOAD_DIR).length
  const form = new FormData()
  form.append('file', new Blob([]), 'empty.png')

  const response = await fetch(`${origin}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'empty_file')
  assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, before, '失败的上传必须删掉已落盘的临时文件')
})

test('登录用户可以取回图片，响应头为内联 PNG', async () => {
  const { status, response } = await call(`/api/files/${uploadedFileId}`)
  assert.equal(status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.match(response.headers.get('content-disposition'), /^inline/)
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/, '中文名应走 RFC 5987 编码')
})

test('删除后该 Key 立即失效，且不再出现在列表里', async () => {
  const { payload } = await call('/api/keys')
  const target = payload.keys[0]
  const removed = await call(`/api/keys/${target.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.equal(removed.payload.key.name, target.name)

  const form = new FormData()
  form.append('file', pngBlob(), 'map.png')
  const response = await fetch(`${origin}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).code, 'invalid_api_key')

  const after = await call('/api/keys')
  assert.equal(after.payload.keys.some((key) => key.id === target.id), false, '删掉的 Key 不应留在列表里')

  const again = await call(`/api/keys/${target.id}`, { method: 'DELETE' })
  assert.equal(again.status, 404, '重复删除应当是 404 而不是静默成功')
})

test('到期清理：磁盘文件被删除，消息保留但标记为已过期', async () => {
  const row = db.prepare('SELECT stored_name FROM files WHERE id = ?').get(uploadedFileId)
  const absolute = path.join(process.env.UPLOAD_DIR, row.stored_name)
  assert.ok(fs.existsSync(absolute))

  db.prepare('UPDATE files SET expires_at = 1 WHERE id = ?').run(uploadedFileId)
  const result = await runCleanup()
  assert.ok(result.expired >= 1)
  assert.equal(fs.existsSync(absolute), false, '过期文件应从磁盘删除')

  const fetched = await call(`/api/files/${uploadedFileId}`)
  assert.equal(fetched.status, 404)
  assert.equal(fetched.payload.code, 'file_expired')

  const { payload } = await call('/api/messages')
  const message = payload.messages.find((item) => item.file?.id === uploadedFileId)
  assert.ok(message, '聊天记录本身不应被删除')
  assert.equal(message.file.expired, true)
  assert.equal(message.file.url, null, '过期文件不再下发可访问地址')
})

test('重复清理是幂等的', async () => {
  const again = await runCleanup()
  assert.equal(again.expired, 0)
})

test('管理员可以开号，新账号能立刻登录', async () => {
  const scoutCookie = cookie
  cookie = ''
  await call('/api/auth/login', { method: 'POST', body: { username: 'root', password: 'admin-secret-2026' } })

  const created = await call('/api/admin/users', {
    method: 'POST',
    body: { username: 'ranger', password: 'ranger-password-1', displayName: '游侠' },
  })
  assert.equal(created.status, 201)
  assert.equal(created.payload.user.isAdmin, false, '管理员开出来的也是普通用户')

  const listed = await call('/api/admin/users')
  assert.ok(listed.payload.users.some((user) => user.username === 'ranger'))

  cookie = ''
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'ranger', password: 'ranger-password-1' },
  })
  assert.equal(login.status, 200)
  assert.equal(login.payload.user.name, '游侠')

  cookie = scoutCookie
})

test('用户可以改自己的昵称', async () => {
  await loginAs('scout', 'map-sync-2026')
  const { status, payload } = await call('/api/auth/me', {
    method: 'PATCH',
    body: { displayName: '前线侦察兵' },
  })
  assert.equal(status, 200)
  assert.equal(payload.user.name, '前线侦察兵')

  const back = await call('/api/auth/me', { method: 'PATCH', body: { displayName: '侦察兵' } })
  assert.equal(back.payload.user.name, '侦察兵')

  const empty = await call('/api/auth/me', { method: 'PATCH', body: { displayName: '  ' } })
  assert.equal(empty.status, 400)
  assert.equal(empty.payload.code, 'invalid_display_name')
})

test('用户改密码：旧密码校验、其它设备被踢、当前设备保持登录', async () => {
  // 模拟同一个人在两台设备上登录，拿到两个独立会话
  await loginAs('scout', 'map-sync-2026')
  const secondary = cookie
  await loginAs('scout', 'map-sync-2026')
  const primary = cookie
  const wrong = await call('/api/auth/me', {
    method: 'PATCH',
    body: { currentPassword: 'not-my-password', newPassword: 'brand-new-password' },
  })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.payload.code, 'wrong_current_password')

  const lonely = await call('/api/auth/me', { method: 'PATCH', body: { newPassword: 'brand-new-password' } })
  assert.equal(lonely.status, 400)
  assert.equal(lonely.payload.code, 'password_pair_required')

  const changed = await call('/api/auth/me', {
    method: 'PATCH',
    body: { currentPassword: 'map-sync-2026', newPassword: 'brand-new-password' },
  })
  assert.equal(changed.status, 200)
  assert.notEqual(cookie, primary, '当前设备应当拿到补发的新会话')

  const stillHere = await call('/api/messages')
  assert.equal(stillHere.status, 200, '改密码的这台设备不应被踢下线')

  const other = await call('/api/messages', { headers: { Cookie: secondary } })
  assert.equal(other.status, 401, '其它设备的会话应当失效')

  // 后续用例仍用 scout，改回原密码保持数据一致
  await call('/api/auth/me', {
    method: 'PATCH',
    body: { currentPassword: 'brand-new-password', newPassword: 'map-sync-2026' },
  })
})

test('管理员重置他人密码，旧密码与旧会话立即失效', async () => {
  await loginAs('root', 'admin-secret-2026')
  const created = await call('/api/admin/users', {
    method: 'POST',
    body: { username: 'resettarget', password: 'initial-password-1', displayName: '重置样本' },
  })
  assert.equal(created.status, 201)
  const targetId = created.payload.user.id

  await loginAs('resettarget', 'initial-password-1')
  const staleCookie = cookie

  await loginAs('root', 'admin-secret-2026')
  const reset = await call(`/api/admin/users/${targetId}/password`, {
    method: 'PATCH',
    body: { password: 'reset-by-admin-01' },
  })
  assert.equal(reset.status, 200)

  const stale = await call('/api/messages', { headers: { Cookie: staleCookie } })
  assert.equal(stale.status, 401, '被重置密码后原有会话应当失效')

  cookie = ''
  const old = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'resettarget', password: 'initial-password-1' },
  })
  assert.equal(old.status, 401, '旧密码应当失效')

  await loginAs('resettarget', 'reset-by-admin-01')

  await loginAs('root', 'admin-secret-2026')
  const onAdmin = await call('/api/admin/users/1/password', { method: 'PATCH', body: { password: 'hijack-the-admin' } })
  assert.equal(onAdmin.status, 403)
  assert.equal(onAdmin.payload.code, 'admin_password_locked', '管理员密码只能通过 .env 修改')
})

test('管理员注销账号：凭据失效、Key 失效、聊天记录保留', async () => {
  // 先以受害者身份留下一条消息和一把 Key，用来验证注销的连带效果
  await loginAs('ranger', 'ranger-password-1')
  const victimCookie = cookie
  const victimKey = (await call('/api/keys', { method: 'POST', body: { name: '游侠的工具' } })).payload.plain
  await call('/api/messages', { method: 'POST', body: { kind: 'text', body: '游侠到此一游' } })

  await loginAs('root', 'admin-secret-2026')
  const victim = (await call('/api/admin/users')).payload.users.find((user) => user.username === 'ranger')
  const removed = await call(`/api/admin/users/${victim.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.equal(removed.payload.user.username, 'ranger')

  const stale = await call('/api/messages', { headers: { Cookie: victimCookie } })
  assert.equal(stale.status, 401, '会话应立即失效')

  const form = new FormData()
  form.append('file', pngBlob(), 'map.png')
  const keyUse = await fetch(`${origin}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${victimKey}` },
    body: form,
  })
  assert.equal(keyUse.status, 401, 'Key 应随账号一起失效')

  const relogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'ranger', password: 'ranger-password-1' },
    headers: { Cookie: 'none=none' },
  })
  assert.equal(relogin.status, 401, '注销后无法再登录')

  assert.equal((await call('/api/admin/users')).payload.users.some((u) => u.username === 'ranger'), false)

  const history = await call('/api/messages?limit=200')
  const kept = history.payload.messages.find((item) => item.body === '游侠到此一游')
  assert.ok(kept, '注销不应带走聊天记录')
  assert.equal(kept.user.name, '游侠', '历史消息仍能解析出作者昵称')

  // 用户名被腾出来，可以重建同名账号
  const rebuilt = await call('/api/admin/users', {
    method: 'POST',
    body: { username: 'ranger', password: 'ranger-password-2', displayName: '新游侠' },
  })
  assert.equal(rebuilt.status, 201)
})

test('注销账号的边界：不能删自己、不能重复删、目标不存在报 404', async () => {
  await loginAs('root', 'admin-secret-2026')

  // root 既是自己又是管理员，两条规则都命中，以"不能删自己"为准
  const self = await call('/api/admin/users/1', { method: 'DELETE' })
  assert.equal(self.status, 400)
  assert.equal(self.payload.code, 'cannot_delete_self')

  const missing = await call('/api/admin/users/99999', { method: 'DELETE' })
  assert.equal(missing.status, 404)
  assert.equal(missing.payload.code, 'user_not_found')

  // 已注销的账号不在活跃用户里，再删一次应当是 404 而不是重复生效
  const temp = await call('/api/admin/users', {
    method: 'POST',
    body: { username: 'tempuser', password: 'temp-password-1' },
  })
  const tempId = temp.payload.user.id
  assert.equal((await call(`/api/admin/users/${tempId}`, { method: 'DELETE' })).status, 200)
  assert.equal((await call(`/api/admin/users/${tempId}`, { method: 'DELETE' })).status, 404)
})

test('管理员密码被改动后，重新引导会按 .env 复原', async () => {
  const { setPassword } = await import('../server/services/user.service.js')
  const admin = db.prepare("SELECT id FROM users WHERE username = 'root'").get()
  await setPassword(admin.id, 'temporarily-different')

  await ensureAdminAccount()

  const saved = cookie
  cookie = ''
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'root', password: 'admin-secret-2026' },
  })
  assert.equal(login.status, 200, '重新引导后 .env 里的密码应当重新生效')
  cookie = saved
})

test('登出后会话立即失效', async () => {
  const out = await call('/api/auth/logout', { method: 'POST' })
  assert.equal(out.status, 200)
  cookie = ''
  const { status } = await call('/api/messages')
  assert.equal(status, 401)
})
