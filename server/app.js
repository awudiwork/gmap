/**
 * 装配层：把中间件、路由、WebSocket 接成一个可启动的 HTTP 服务。
 *
 * 与 index.js 分开的原因：测试需要一个"能 listen 在随机端口、能关掉"的服务实例，
 * 而不是一个启动即占用固定端口、注册了信号处理器的进程。
 * 这里只负责接线，不含业务规则。
 */
import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { config } from './config.js'
import { errorHandler, notFound } from './lib/errors.js'
import { attachAuth, authenticateUpgrade } from './middleware/auth.js'
import { verifyOrigin } from './middleware/origin.js'
import { adminRouter } from './routes/admin.routes.js'
import { authRouter } from './routes/auth.routes.js'
import { keyRouter } from './routes/key.routes.js'
import { messageRouter } from './routes/message.routes.js'
import { hub } from './ws/hub.js'

/**
 * 基础安全头。script-src 不含 'unsafe-inline'，
 * 因此前端脚本必须放独立 .js 文件——这是有意施加的约束。
 */
function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  )
  next()
}

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  // 刻意不开 trust proxy：没有可信反代时开启会让登录/上传限流被伪造的
  // X-Forwarded-For 绕过。确实部署在 Nginx/Caddy 之后时，再打开下面这行。
  // app.set('trust proxy', 1)

  app.use(securityHeaders)
  app.use(express.json({ limit: '256kb' }))
  app.use(attachAuth)
  app.use(verifyOrigin)

  app.use('/api/auth', authRouter)
  app.use('/api/admin', adminRouter)
  app.use('/api/keys', keyRouter)
  app.use('/api', messageRouter)

  // 未匹配的 /api 请求返回 JSON 404，不要落到静态资源里
  app.use('/api', (_req, _res, next) => next(notFound('endpoint_not_found', '接口不存在')))

  app.use(express.static(path.join(config.root, 'public'), {
    index: 'index.html',
    etag: true,
    maxAge: 0,
  }))

  app.use(errorHandler)
  return app
}

/** 创建 HTTP 服务并挂上 WebSocket 广播中心 */
export function createHttpServer() {
  const server = http.createServer(createApp())
  hub.attach(server, { path: '/ws', authenticate: authenticateUpgrade })
  return server
}
