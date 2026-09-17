/**
 * 保留期清理：房间是一个滚动窗口，超过保留期的消息连同附件一起消失。
 *
 * 语义：
 *  - 到期的是**消息**，不只是附件。文字、代码块、图片一视同仁，
 *    否则纯文字会无限累积，房间越用越长。
 *  - 到期时间在消息落库那一刻算好。之后把保留期调短，只影响新消息，
 *    不会让人眼睁睁看着历史当场蒸发。存量消息没有这个字段，按"创建时间 + 当前配置"兜底。
 *  - 先删库再删磁盘。库是事实来源，磁盘上删不掉的残留交给孤儿扫描兜底，
 *    这样不会出现"库里没了、磁盘还在"之外的第三种状态。
 */
import fsp from 'node:fs/promises'
import { db } from '../db.js'
import { config } from '../config.js'
import { filePath } from './file.service.js'
import { purgeExpiredSessions } from './session.service.js'
import { hub } from '../ws/hub.js'

/** 孤儿文件的宽限期：短于此的新文件可能正处于"已落盘、尚未入库"的瞬间，不能删 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000
/** 一轮最多处理这么多条，避免长时间占住数据库 */
const BATCH = 500

// 不写 COALESCE、也不写 ORDER BY：任何一个都会让 idx_messages_expires 失效，
// 退化成全表扫描。删除顺序本来也无所谓。
// 存量消息的空 expires_at 由 backfillExpiry 一次性补齐。
const selectExpired = db.prepare(`
  SELECT id, file_id, room FROM messages
  WHERE expires_at <= ?
  LIMIT ${BATCH}
`)
const backfill = db.prepare('UPDATE messages SET expires_at = created_at + ? WHERE expires_at IS NULL')
const selectStoredName = db.prepare('SELECT stored_name FROM files WHERE id = ?')
const deleteMessage = db.prepare('DELETE FROM messages WHERE id = ?')
const deleteFileRow = db.prepare('DELETE FROM files WHERE id = ?')
const selectLiveStoredNames = db.prepare('SELECT stored_name FROM files')
// 入库了却没有任何消息引用的文件：上传落库和建消息不在一个事务里，
// 中间进程崩掉就会留下这种行。它既不会随消息过期，又会保护着磁盘上的孤儿
const selectUnreferencedFiles = db.prepare(`
  SELECT f.id, f.stored_name FROM files f
  WHERE f.created_at < ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.file_id = f.id)
  LIMIT ${BATCH}
`)

/**
 * 删掉过期的消息及其附件。
 * @returns {Promise<{ ids: number[], files: number }>} 被删的消息 id，用于通知在线客户端
 */
/**
 * 给升级前的消息补上到期时间。
 *
 * 迁移里做不了这件事：到期时长来自运行期配置，而迁移是固定的 SQL。
 * 补完之后清理查询就不必再用 COALESCE 兜底，能走索引。
 *
 * @returns {number} 补了多少条
 */
export function backfillExpiry() {
  const changed = backfill.run(config.retentionMs).changes
  if (changed > 0) console.log(`[cleanup] 已为 ${changed} 条历史消息补上到期时间`)
  return changed
}

async function purgeExpired() {
  const rows = selectExpired.all(Date.now())
  if (rows.length === 0) return { ids: [], rooms: [], files: 0 }

  const fileIds = rows.map((row) => row.file_id).filter(Boolean)
  // 趁行还在，先把磁盘文件名取出来
  const storedNames = fileIds
    .map((id) => selectStoredName.get(id)?.stored_name)
    .filter(Boolean)

  db.transaction(() => {
    for (const row of rows) deleteMessage.run(row.id)
    for (const id of fileIds) deleteFileRow.run(id)
  })()

  for (const name of storedNames) {
    try {
      await fsp.unlink(filePath(name))
    } catch (err) {
      // 删不掉就留给孤儿扫描，库里已经没有它了
      if (err.code !== 'ENOENT') {
        console.error(`[cleanup] 删除文件失败，留给孤儿扫描：${name}`, err.message)
      }
    }
  }

  return {
    ids: rows.map((row) => row.id),
    // 带上受影响的频道，客户端据此清掉那些指向已消失消息的未读标记
    rooms: [...new Set(rows.map((row) => row.room))],
    files: storedNames.length,
  }
}

/**
 * 库里有、却没有消息引用的文件。宽限一小时：刚上传完、消息还没建好的那一瞬间不能删。
 * @returns {Promise<number>} 删掉的条数
 */
async function removeUnreferencedFiles() {
  const rows = selectUnreferencedFiles.all(Date.now() - ORPHAN_GRACE_MS)
  if (rows.length === 0) return 0
  db.transaction(() => {
    for (const row of rows) deleteFileRow.run(row.id)
  })()
  for (const row of rows) {
    await fsp.unlink(filePath(row.stored_name)).catch(() => {})
  }
  return rows.length
}

/** 磁盘上有、库里没有的文件。上传落盘后入库失败会留下这种残留 */
async function removeOrphanFiles() {
  let entries
  try {
    entries = await fsp.readdir(config.uploadDir)
  } catch (err) {
    if (err.code === 'ENOENT') return 0
    throw err
  }
  const known = new Set(selectLiveStoredNames.all().map((row) => row.stored_name))
  const deadline = Date.now() - ORPHAN_GRACE_MS
  let removed = 0
  for (const name of entries) {
    if (known.has(name)) continue
    const absolute = filePath(name)
    try {
      const stat = await fsp.stat(absolute)
      if (!stat.isFile() || stat.mtimeMs > deadline) continue
      await fsp.unlink(absolute)
      removed += 1
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[cleanup] 清理孤儿文件失败：${name}`, err.message)
      }
    }
  }
  return removed
}

/**
 * 跑一轮清理。可独立调用（测试、手动触发），不依赖定时器。
 * @returns {Promise<{ messages: number, files: number, orphans: number, sessions: number }>}
 */
export async function runCleanup() {
  const { ids, rooms, files } = await purgeExpired()
  // 先清没人引用的库记录，它们的磁盘文件才会在下一步被当成孤儿
  const unreferenced = await removeUnreferencedFiles()
  const orphans = (await removeOrphanFiles()) + unreferenced
  const sessions = purgeExpiredSessions()

  if (ids.length > 0) {
    hub.broadcast({ type: 'messages_expired', data: { ids, rooms } })
  }
  return { messages: ids.length, files, orphans, sessions }
}

/** 启动周期清理，并立即跑一轮（覆盖进程停机期间过期的内容） */
export function startCleanupScheduler() {
  backfillExpiry()

  const tick = () => {
    runCleanup()
      .then(({ messages, files, orphans, sessions }) => {
        if (messages || orphans || sessions) {
          console.log(`[cleanup] 过期消息 ${messages} 条（含附件 ${files} 个），孤儿文件 ${orphans} 个，过期会话 ${sessions} 条`)
        }
      })
      .catch((err) => console.error('[cleanup] 本轮清理异常', err))
  }
  tick()
  const timer = setInterval(tick, config.cleanupIntervalMinutes * 60 * 1000)
  timer.unref?.()
  return timer
}
