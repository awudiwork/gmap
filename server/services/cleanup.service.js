/**
 * 保留期清理：把过期文件从磁盘删掉，并通知在线客户端把对应消息置灰。
 *
 * 语义：
 *  - 只删磁盘文件，不删 files 行也不删 messages 行。聊天记录保持完整，
 *    过期附件在前端显示为"已过期"，避免历史被打断。
 *  - 删除失败（除文件本就不存在外）不标记 deleted_at，下一轮自然重试，
 *    宁可多试几次也不要留下"库说删了、磁盘还在"的不一致状态。
 *  - 孤儿文件（落盘后登记失败残留的）按文件 mtime 超过一轮宽限期后清掉，防止磁盘泄漏。
 */
import fsp from 'node:fs/promises'
import { db } from '../db.js'
import { config } from '../config.js'
import { filePath } from './file.service.js'
import { purgeExpiredSessions } from './session.service.js'
import { hub } from '../ws/hub.js'

/** 孤儿文件的宽限期：短于此的新文件可能正处于"已落盘、尚未入库"的瞬间，不能删 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000

const selectExpired = db.prepare(`
  SELECT id, stored_name FROM files
  WHERE deleted_at IS NULL AND expires_at <= ?
  LIMIT 500
`)
const markDeleted = db.prepare('UPDATE files SET deleted_at = ? WHERE id = ?')
const selectAllStoredNames = db.prepare('SELECT stored_name FROM files WHERE deleted_at IS NULL')

async function removeExpiredFiles() {
  const rows = selectExpired.all(Date.now())
  const removedIds = []
  for (const row of rows) {
    try {
      await fsp.unlink(filePath(row.stored_name))
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[cleanup] 删除文件失败，将在下一轮重试：${row.stored_name}`, err.message)
        continue
      }
      // 文件本就不存在，视为已达成目标
    }
    markDeleted.run(Date.now(), row.id)
    removedIds.push(row.id)
  }
  return removedIds
}

async function removeOrphanFiles() {
  let entries
  try {
    entries = await fsp.readdir(config.uploadDir)
  } catch (err) {
    if (err.code === 'ENOENT') return 0
    throw err
  }
  const known = new Set(selectAllStoredNames.all().map((row) => row.stored_name))
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
 * @returns {Promise<{ expired: number, orphans: number, sessions: number }>}
 */
export async function runCleanup() {
  const removedIds = await removeExpiredFiles()
  const orphans = await removeOrphanFiles()
  const sessions = purgeExpiredSessions()

  if (removedIds.length > 0) {
    hub.broadcast({ type: 'files_expired', data: { fileIds: removedIds } })
  }
  return { expired: removedIds.length, orphans, sessions }
}

/** 启动周期清理，并立即跑一轮（覆盖进程停机期间过期的文件） */
export function startCleanupScheduler() {
  const tick = () => {
    runCleanup()
      .then(({ expired, orphans, sessions }) => {
        if (expired || orphans || sessions) {
          console.log(`[cleanup] 过期文件 ${expired} 个，孤儿文件 ${orphans} 个，过期会话 ${sessions} 条`)
        }
      })
      .catch((err) => console.error('[cleanup] 本轮清理异常', err))
  }
  tick()
  const timer = setInterval(tick, config.cleanupIntervalMinutes * 60 * 1000)
  timer.unref?.()
  return timer
}
