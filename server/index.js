/**
 * 进程入口：启动 HTTP 服务、周期清理，并处理优雅退出。
 */
import os from 'node:os'
import { createHttpServer } from './app.js'
import { config } from './config.js'
import { db } from './db.js'
import { startCleanupScheduler } from './services/cleanup.service.js'
import { ensureAdminAccount } from './services/user.service.js'
import { hub } from './ws/hub.js'

// 先把管理员账号落实，再开始对外提供服务：
// 配置缺失导致"谁都登不进去"的情况必须在监听端口之前就暴露出来
try {
  await ensureAdminAccount()
} catch (err) {
  console.error(`[gmap] 启动失败：${err.message}`)
  process.exit(1)
}

const server = createHttpServer()
const cleanupTimer = startCleanupScheduler()

/**
 * 把监听地址翻译成真正能在浏览器里打开的地址。
 * HOST=0.0.0.0 表示"监听所有网卡"，它本身不是可访问的目标，
 * 直接拼进 URL 会得到一个点不开的链接，所以这里展开成本机 + 各网卡的实际地址。
 */
function accessUrls() {
  if (config.host !== '0.0.0.0' && config.host !== '::') {
    return [['本机', `http://${config.host}:${config.port}`]]
  }
  const urls = [['本机', `http://localhost:${config.port}`]]
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const net of entries ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(['局域网', `http://${net.address}:${config.port}`])
      }
    }
  }
  return urls
}

server.listen(config.port, config.host, () => {
  console.log('[gmap] 已启动，浏览器打开：')
  for (const [label, url] of accessUrls()) console.log(`[gmap]   ${label}  ${url}`)
  console.log(`[gmap] 上传目录 ${config.uploadDir}`)
  console.log(`[gmap] 消息与附件保留 ${config.retentionHours} 小时，每 ${config.cleanupIntervalMinutes} 分钟清理一次`)
})

let shuttingDown = false

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[gmap] 收到 ${signal}，正在退出…`)
  clearInterval(cleanupTimer)
  hub.close()
  server.close(() => {
    db.close()
    process.exit(0)
  })
  // 兜底：10 秒内没能优雅关完就强退，避免卡住部署脚本
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
