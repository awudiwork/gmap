/**
 * 聊天室接口：历史消息、发送文字/代码、上传附件、下发文件。
 *
 * 写入路径只有这一条：校验 → 落库 → 广播。WebSocket 不接受上行业务消息，
 * 因此不存在"两套校验逻辑漂移"的问题。
 */
import express from 'express'
import { config } from '../config.js'
import { badRequest, notFound, tooMany, wrap } from '../lib/errors.js'
import { createRateLimiter, createThrottle } from '../lib/ratelimit.js'
import { DEFAULT_ROOM, ROOMS } from '../lib/rooms.js'
import { requireUser } from '../middleware/auth.js'
import {
  discardFile,
  fileDto,
  filePath,
  getFile,
  isInlineSafe,
  registerUpload,
  uploadMiddleware,
} from '../services/file.service.js'
import { createFileMessage, createTextMessage, listMessages } from '../services/message.service.js'
import { hub } from '../ws/hub.js'

export const messageRouter = express.Router()

const uploadLimiter = createRateLimiter({ windowMs: 60_000, max: config.uploadRatePerMinute })
const uploadThrottle = createThrottle({ intervalMs: config.uploadMinIntervalMs })

/** 限流维度：API Key 按 Key，网页按用户。同一人换 Key 不共享配额，便于定位刷屏来源 */
const rateKey = (req) => (req.auth.via === 'apikey' ? `key:${req.auth.keyId}` : `user:${req.auth.user.id}`)

/**
 * 两道闸：最小间隔挡热键连按，每分钟配额挡持续刷屏。
 *
 * 最小间隔只管 API Key。热键按住不放是截图客户端特有的问题；
 * 网页端一次拖五张图是正常操作，按秒卡会让后面四张凭空失败。
 */
function guardUploadRate(req, _res, next) {
  if (req.auth.via === 'apikey') {
    const paced = uploadThrottle.consume(rateKey(req))
    if (!paced.allowed) {
      next(tooMany('upload_too_fast', `上传太快，请 ${Math.ceil(paced.retryAfterMs / 1000)} 秒后再试`))
      return
    }
  }

  const { allowed, retryAfterMs } = uploadLimiter.consume(rateKey(req))
  if (!allowed) {
    next(tooMany('upload_rate_limited', `上传过于频繁，请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试`))
    return
  }
  next()
}

/** 生成兼容中文文件名的 Content-Disposition */
function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** 房间清单是公开的产品结构，登录后就能读 */
messageRouter.get('/rooms', requireUser, (_req, res) => {
  res.json({ ok: true, rooms: ROOMS, defaultRoom: DEFAULT_ROOM })
})

messageRouter.get('/messages', requireUser, (req, res) => {
  const before = req.query.before === undefined ? null : Number(req.query.before)
  if (before !== null && (!Number.isInteger(before) || before <= 0)) {
    throw badRequest('invalid_cursor', 'before 必须是正整数消息 id')
  }
  const limit = req.query.limit === undefined ? config.historyLimit : Number(req.query.limit)
  res.json({ ok: true, messages: listMessages({ room: req.query.room, limit, before }) })
})

messageRouter.post('/messages', requireUser, (req, res) => {
  const message = createTextMessage({
    room: req.body?.room,
    userId: req.auth.user.id,
    kind: req.body?.kind ?? 'text',
    body: req.body?.body,
    lang: req.body?.lang,
    source: req.auth.via === 'apikey' ? 'api' : 'web',
  })
  hub.broadcast({ type: 'message', data: message })
  res.status(201).json({ ok: true, message })
})

/**
 * 上传附件并自动在聊天室发一条消息。这是截图客户端对接的唯一接口。
 *
 * 中间件顺序是有意为之：先鉴权与限流，最后才让 multer 收流落盘，
 * 未授权请求不会在磁盘上留下任何东西。
 */
messageRouter.post('/upload', requireUser, guardUploadRate, uploadMiddleware, wrap(async (req, res) => {
  if (!req.file) {
    throw badRequest('missing_file', '请以 multipart/form-data 提交名为 file 的字段')
  }
  const row = await registerUpload({ ownerId: req.auth.user.id, uploaded: req.file })

  let message
  try {
    message = createFileMessage({
      // 截图客户端用 multipart 字段传房间；认不出来的值会落到默认房间，
      // 老版本客户端不会因此把图推丢
      room: req.body?.room,
      userId: req.auth.user.id,
      fileId: row.id,
      caption: req.body?.caption,
      source: req.auth.via === 'apikey' ? 'api' : 'web',
    })
  } catch (err) {
    // 文件已经落盘入库，消息却没建成。不回滚的话磁盘和库各留一份垃圾，
    // 要等保留期到了才被清走
    await discardFile(row)
    throw err
  }

  hub.broadcast({ type: 'message', data: message })
  res.status(201).json({ ok: true, message, file: fileDto(row) })
}))

messageRouter.get('/files/:id', requireUser, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest('invalid_id', '文件 id 非法')
  }
  const row = getFile(id)
  // 文件跟着消息一起被清理，所以库里查不到就是已经过期了
  if (!row) throw notFound('file_expired', '文件已超过保留期并被清理')
  if (row.expires_at <= Date.now()) {
    throw notFound('file_expired', '文件已超过保留期并被清理')
  }

  const inline = isInlineSafe(row)
  res.sendFile(filePath(row.stored_name), {
    headers: {
      // 非白名单类型一律降级为二进制附件，杜绝在站内被渲染执行
      'Content-Type': inline ? row.mime : 'application/octet-stream',
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', row.original_name),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    },
  }, (err) => {
    if (!err) return
    // 清理任务可能正好在这一刻删掉了文件
    if (err.code === 'ENOENT') {
      if (!res.headersSent) res.status(404).json({ ok: false, code: 'file_expired', message: '文件已被清理' })
      return
    }
    if (!res.headersSent) res.status(500).json({ ok: false, code: 'internal_error', message: '文件读取失败' })
  })
})
