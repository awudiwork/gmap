/**
 * 配置层：环境变量的唯一事实来源。
 *
 * 契约：
 *  - 所有配置在进程启动时一次性解析并校验，非法值直接抛错终止启动（fail fast），
 *    不允许运行期出现"配置是 undefined / NaN"的中间状态。
 *  - 对外只暴露冻结后的 config 对象，任何模块不得再读 process.env。
 *  - 路径一律解析为绝对路径，避免受进程工作目录影响。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

dotenv.config()

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 已经改名的配置项。留着旧名默默用默认值，比起不了服务更糟：
 * 保留期会悄悄变回 12 小时，而且没有任何迹象。
 */
const RENAMED = {
  FILE_RETENTION_HOURS: 'RETENTION_HOURS',
}

for (const [oldName, newName] of Object.entries(RENAMED)) {
  if (process.env[oldName] !== undefined && process.env[newName] === undefined) {
    throw new Error(
      `配置 ${oldName} 已更名为 ${newName}（它现在同时管消息和附件），请修改 .env 后重新启动`,
    )
  }
}

/** 读取整数配置，越界或非数字直接抛错 */
function readInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`配置 ${name} 非法：期望 ${min}~${max} 的整数，实际收到 "${raw}"`)
  }
  return value
}

function readBool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  throw new Error(`配置 ${name} 非法：期望布尔值，实际收到 "${raw}"`)
}

function readPath(name, fallback) {
  const raw = process.env[name]?.trim()
  const value = raw || fallback
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value)
}

function readString(name, fallback = '') {
  const raw = process.env[name]
  return raw === undefined ? fallback : raw.trim()
}

export const config = Object.freeze({
  root: ROOT,
  host: readString('HOST', '0.0.0.0'),
  port: readInt('PORT', 3000, { min: 1, max: 65535 }),

  dataDir: readPath('DATA_DIR', './data'),
  uploadDir: readPath('UPLOAD_DIR', './uploads'),

  // 保留期管的是房间里的一切：消息、代码块、附件
  retentionHours: readInt('RETENTION_HOURS', 12, { min: 1, max: 24 * 365 }),
  cleanupIntervalMinutes: readInt('CLEANUP_INTERVAL_MINUTES', 10, { min: 1, max: 1440 }),
  maxUploadBytes: readInt('MAX_UPLOAD_MB', 25, { min: 1, max: 2048 }) * 1024 * 1024,

  historyLimit: readInt('HISTORY_LIMIT', 80, { min: 10, max: 500 }),
  sessionTtlMs: readInt('SESSION_TTL_DAYS', 30, { min: 1, max: 3650 }) * 24 * 60 * 60 * 1000,
  cookieSecure: readBool('COOKIE_SECURE', false),

  registrationCode: readString('REGISTRATION_CODE', ''),
  // 默认关闭自助注册：账号由 .env 里的管理员在页面上逐个开
  allowRegistration: readBool('ALLOW_REGISTRATION', false),
  adminUsername: readString('ADMIN_USERNAME', 'admin'),
  adminPassword: readString('ADMIN_PASSWORD', ''),

  uploadRatePerMinute: readInt('UPLOAD_RATE_PER_MINUTE', 30, { min: 1, max: 6000 }),
  // 两次上传之间的最小间隔，挡住热键连按。0 表示不限
  uploadMinIntervalMs: readInt('UPLOAD_MIN_INTERVAL_MS', 1000, { min: 0, max: 60_000 }),
})
