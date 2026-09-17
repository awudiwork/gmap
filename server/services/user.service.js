/**
 * 用户领域逻辑：注册、查询、凭据校验。
 *
 * 契约：
 *  - 对外只返回 public 形态的用户对象（不含 password_hash）。
 *  - 用户名大小写不敏感（库上 COLLATE NOCASE），展示名保留用户输入的原样。
 *  - 校验失败一律抛 AppError，调用方不需要区分"返回 null"和"抛错"两种风格。
 */
import bcrypt from 'bcryptjs'
import { db } from '../db.js'
import { config } from '../config.js'
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js'
import { destroyUserSessions } from './session.service.js'

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,20}$/
const BCRYPT_ROUNDS = 10
/** 仅用于消耗与真实校验相当的 CPU 时间，永远不会匹配成功的路径 */
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

const selectById = db.prepare('SELECT * FROM users WHERE id = ?')
const selectActiveById = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
const selectByUsername = db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL')
const insertUser = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, is_admin, created_at)
  VALUES (@username, @displayName, @passwordHash, @isAdmin, @createdAt)
`)
const countUsers = db.prepare('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL')
const selectAll = db.prepare('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY id ASC')
const updateHash = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
const updateAdminFlag = db.prepare('UPDATE users SET is_admin = ? WHERE id = ?')
const updateDisplayName = db.prepare('UPDATE users SET display_name = ? WHERE id = ?')
const softDelete = db.prepare('UPDATE users SET deleted_at = ?, username = ? WHERE id = ?')
const removeKeysOfUser = db.prepare('DELETE FROM api_keys WHERE user_id = ?')
const selectOtherAdmins = db.prepare('SELECT id, username FROM users WHERE is_admin = 1 AND id != ?')

/** 是不是 .env 里指定的管理员登录名（用户名不分大小写） */
const isAdminName = (name) => name.toLowerCase() === config.adminUsername.toLowerCase()

/** 把库记录转成可以安全下发给前端的形态 */
export function toPublicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    name: row.display_name,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
  }
}

/**
 * 按 id 查用户，**包含已注销的**。
 * 只用于解析历史消息的作者等展示场景；鉴权路径一律用 findActiveUserById。
 */
export function findUserById(id) {
  return selectById.get(id) ?? null
}

/** 按 id 查未注销的用户。会话与 API Key 的解析必须走这个，注销后凭据立即失效 */
export function findActiveUserById(id) {
  return selectActiveById.get(id) ?? null
}

export function findUserByUsername(username) {
  return selectByUsername.get(username) ?? null
}

export function userCount() {
  return countUsers.get().n
}

/**
 * 校验密码形态并返回规范化后的值。
 * bcrypt 只取前 72 字节，超长部分会被静默截断，所以在入口按字节数拒绝而不是按字符数。
 * @throws AppError 长度不合规（400）
 */
function assertPasswordShape(password) {
  const secret = String(password ?? '')
  const bytes = Buffer.byteLength(secret, 'utf8')
  if (bytes < 8 || bytes > 72) {
    throw badRequest('invalid_password', '密码长度需为 8~72 字节（一个汉字算 3 字节）')
  }
  return secret
}

/**
 * 创建用户。
 * @throws AppError 用户名/密码不合规（400）、用户名已存在或是保留的管理员名（409）
 */
export async function createUser({ username, password, displayName, isAdmin = false }) {
  const name = String(username ?? '').trim()
  if (!USERNAME_PATTERN.test(name)) {
    throw badRequest('invalid_username', '用户名需为 3~20 位的字母、数字、下划线或连字符')
  }
  const secret = assertPasswordShape(password)
  const display = assertDisplayName(String(displayName ?? '').trim() || name)
  if (findUserByUsername(name)) {
    throw conflict('username_taken', '该用户名已被占用')
  }
  // 管理员登录名是保留的：先注册占了这个名，等运维改配置重启时，
  // 引导逻辑会把这个账号提升成管理员，等于自助提权
  if (!isAdmin && isAdminName(name)) {
    throw conflict('username_reserved', '该用户名保留给管理员')
  }

  const passwordHash = await bcrypt.hash(secret, BCRYPT_ROUNDS)
  try {
    const result = insertUser.run({
      username: name,
      displayName: display,
      passwordHash,
      isAdmin: isAdmin ? 1 : 0,
      createdAt: Date.now(),
    })
    return findUserById(result.lastInsertRowid)
  } catch (err) {
    // 并发注册同名用户时唯一索引会兜底，转成与前置检查一致的语义
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw conflict('username_taken', '该用户名已被占用')
    }
    throw err
  }
}

/**
 * 校验账号密码。
 * @throws AppError 凭据错误（401）——不区分"用户不存在"与"密码错误"，避免账号枚举
 */
export async function verifyCredentials(username, password) {
  const row = findUserByUsername(String(username ?? '').trim())
  // 用户不存在时也跑一次 bcrypt（用一个格式合法的占位 hash），抹平响应时间差，防止账号枚举
  const hash = row?.password_hash ?? DUMMY_HASH
  const matched = await bcrypt.compare(String(password ?? ''), hash)
  if (!row || !matched) {
    throw unauthorized('invalid_credentials', '用户名或密码错误')
  }
  return row
}

export function listUsers() {
  return selectAll.all().map(toPublicUser)
}

/** 直接改密码，不校验旧密码。调用方自己负责鉴权 */
export async function setPassword(userId, password) {
  const secret = assertPasswordShape(password)
  updateHash.run(await bcrypt.hash(secret, BCRYPT_ROUNDS), userId)
}

/**
 * 校验昵称并返回规范化后的值。导出给路由用，好在落库前把整个请求先校验完。
 * @throws AppError 昵称不合规（400）
 */
export function assertDisplayName(displayName) {
  const display = String(displayName ?? '').trim()
  if (!display) throw badRequest('invalid_display_name', '昵称不能为空')
  if (display.length > 24) throw badRequest('invalid_display_name', '昵称最长 24 个字符')
  return display
}

/**
 * 用户改自己的昵称。
 * @throws AppError 昵称不合规（400）
 */
export function updateDisplayNameOf(userId, displayName) {
  updateDisplayName.run(assertDisplayName(displayName), userId)
  return findUserById(userId)
}

/**
 * 用户改自己的密码。
 *
 * 副作用（显式声明）：成功后该用户的**全部会话被吊销**，包括当前这个。
 * 调用方需要重新签发会话，否则用户会被自己踢下线。
 *
 * @throws AppError 旧密码错误（401）、新密码不合规（400）、管理员（403）
 */
export async function changeOwnPassword(userId, currentPassword, newPassword) {
  const row = findActiveUserById(userId)
  if (!row) throw notFound('user_not_found', '账号不存在')
  if (row.is_admin === 1) {
    throw forbidden('admin_password_locked', '管理员密码由 .env 的 ADMIN_PASSWORD 决定，请修改配置后重启')
  }
  if (!(await bcrypt.compare(String(currentPassword ?? ''), row.password_hash))) {
    throw unauthorized('wrong_current_password', '当前密码不正确')
  }
  await setPassword(userId, newPassword)
  destroyUserSessions(userId)
  return findUserById(userId)
}

/**
 * 管理员重置他人密码。
 *
 * 副作用：目标用户的全部会话被吊销，必须用新密码重新登录。其 API Key 不受影响。
 *
 * @throws AppError 目标不存在（404）、目标是管理员（403）、新密码不合规（400）
 */
export async function resetPasswordByAdmin(targetId, newPassword) {
  const row = findActiveUserById(targetId)
  if (!row) throw notFound('user_not_found', '账号不存在')
  if (row.is_admin === 1) {
    throw forbidden('admin_password_locked', '管理员密码由 .env 的 ADMIN_PASSWORD 决定，请修改配置后重启')
  }
  await setPassword(targetId, newPassword)
  destroyUserSessions(targetId)
  return findUserById(targetId)
}

/**
 * 注销账号（软删除）。
 *
 * 语义：吊销凭据，保留历史。该用户的会话与 API Key 立即失效，无法再登录；
 * 但他发过的消息和昵称仍留在聊天记录里，不会在历史中留下空洞。
 * 用户名会被改写腾出来，之后可以重建同名账号。
 *
 * @throws AppError 目标不存在（404）、删自己（400）、删管理员（403）
 */
export function deleteUser(actorId, targetId) {
  const row = findActiveUserById(targetId)
  if (!row) throw notFound('user_not_found', '账号不存在')
  if (row.id === actorId) throw badRequest('cannot_delete_self', '不能删除自己的账号')
  if (row.is_admin === 1) {
    throw forbidden('cannot_delete_admin', '管理员账号由 .env 决定，如需更换请修改配置后重启')
  }

  const now = Date.now()
  db.transaction(() => {
    // 用户名带上后缀腾出原名；display_name 保持不变，历史消息里仍显示原昵称
    softDelete.run(now, `${row.username}#deleted${row.id}`, row.id)
    destroyUserSessions(row.id)
    removeKeysOfUser.run(row.id)
  })()

  return { id: row.id, username: row.username, name: row.display_name }
}

/**
 * 启动引导：保证 .env 里配置的管理员账号存在且密码与配置一致，
 * 且**只有它**是管理员。
 *
 * 设计取舍：.env 是管理员凭据的唯一事实来源，每次启动都会把库里的密码同步过去。
 * 这样"改 .env 重启即可找回管理员"，代价是不能在页面上改管理员密码——
 * 本系统本来就没有改密码入口，不构成冲突。
 *
 * 改了 ADMIN_USERNAME 之后，旧的管理员会被降成普通用户：不降的话它既改不了密码
 * 也注销不掉（页面上对管理员的三个操作都是硬拒绝），成了一个只能手改库的残留账号。
 * 被提升或被降级的账号，旧会话一律吊销，免得浏览器里的旧 Cookie 带着新身份。
 *
 * @throws Error 配置缺失且系统会因此完全无法登录时，直接终止启动
 */
export async function ensureAdminAccount() {
  const { adminUsername, adminPassword, allowRegistration } = config

  if (!adminPassword) {
    if (userCount() === 0 && !allowRegistration) {
      throw new Error(
        '未设置 ADMIN_PASSWORD 且未开放自助注册，没有任何账号能登录。'
        + '请在 .env 里填写 ADMIN_PASSWORD 后重启。',
      )
    }
    console.warn('[gmap] 未设置 ADMIN_PASSWORD，跳过管理员账号引导')
    return null
  }

  let admin = findUserByUsername(adminUsername)
  if (!admin) {
    admin = await createUser({
      username: adminUsername,
      password: adminPassword,
      displayName: adminUsername,
      isAdmin: true,
    })
    console.log(`[gmap] 已按 .env 创建管理员账号：${admin.username}`)
  } else {
    if (!(await bcrypt.compare(adminPassword, admin.password_hash))) {
      await setPassword(admin.id, adminPassword)
      console.log(`[gmap] 管理员 ${admin.username} 的密码已同步为 .env 中的值`)
    }
    if (admin.is_admin !== 1) {
      updateAdminFlag.run(1, admin.id)
      destroyUserSessions(admin.id)
      console.log(`[gmap] 已将 ${admin.username} 提升为管理员`)
    }
  }

  for (const other of selectOtherAdmins.all(admin.id)) {
    updateAdminFlag.run(0, other.id)
    destroyUserSessions(other.id)
    console.log(`[gmap] ${other.username} 不再是 .env 指定的管理员，已降为普通用户`)
  }
  return findUserById(admin.id)
}
