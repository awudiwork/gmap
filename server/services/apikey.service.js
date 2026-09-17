/**
 * API Key：外部截图客户端的上传凭据。
 *
 * 契约：
 *  - 明文 key 只在创建时返回一次，库里只存 SHA-256；丢了只能删掉重建。
 *  - key 形如 gmap_<40 位 hex>，前 12 位（gmap_ + 7 hex）明文留存用于列表展示。
 *  - 删除是物理删除。Key 不像用户那样挂着历史内容，留一行"已吊销"记录
 *    只会让列表越来越长，没人会去读。
 */
import crypto from 'node:crypto'
import { db } from '../db.js'
import { badRequest, notFound } from '../lib/errors.js'
import { sha256 } from '../lib/hash.js'
import { findActiveUserById } from './user.service.js'

const KEY_NAMESPACE = 'gmap_'
const PREFIX_LENGTH = 12

const insertKey = db.prepare(`
  INSERT INTO api_keys (user_id, name, key_hash, key_prefix, created_at)
  VALUES (?, ?, ?, ?, ?)
`)
const selectByHash = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?')
const selectById = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?')
const selectByUser = db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC')
const removeKey = db.prepare('DELETE FROM api_keys WHERE id = ?')
const touchUsed = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')

function toDto(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

/**
 * 创建一枚 API Key。
 * @returns {{ key: object, plain: string }} plain 为明文 key，调用方必须立刻交给用户且不得落库
 */
export function createApiKey(userId, name) {
  const label = String(name ?? '').trim() || '未命名客户端'
  if (label.length > 32) {
    throw badRequest('invalid_key_name', 'Key 名称最长 32 个字符')
  }
  const plain = KEY_NAMESPACE + crypto.randomBytes(20).toString('hex')
  const result = insertKey.run(userId, label, sha256(plain), plain.slice(0, PREFIX_LENGTH), Date.now())
  return { key: toDto(selectById.get(result.lastInsertRowid, userId)), plain }
}

export function listApiKeys(userId) {
  return selectByUser.all(userId).map(toDto)
}

/**
 * 删除一枚 Key，立即失效。
 * @throws AppError 找不到或不属于该用户（404）
 */
export function deleteApiKey(userId, id) {
  const row = selectById.get(id, userId)
  if (!row) throw notFound('key_not_found', '找不到这枚 Key')
  removeKey.run(row.id)
  return { id: row.id, name: row.name, prefix: row.key_prefix }
}

/**
 * 校验明文 key。
 * @returns {{ keyId: number, user: object } | null} key 不存在或所属账号已注销时返回 null
 */
export function resolveApiKey(plain) {
  if (typeof plain !== 'string' || !plain.startsWith(KEY_NAMESPACE)) return null
  const row = selectByHash.get(sha256(plain))
  if (!row) return null
  // 账号被注销后，残留的 Key 一律拒绝
  const user = findActiveUserById(row.user_id)
  if (!user) return null
  touchUsed.run(Date.now(), row.id)
  return { keyId: row.id, user }
}
