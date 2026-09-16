/**
 * 消息领域逻辑：落库、分页读取、对外形态。
 *
 * 契约：
 *  - kind ∈ { text, code, file }，三者的必填字段互不相同，由本模块统一校验。
 *  - source ∈ { web, api }，用于前端区分"网页里发的"和"截图客户端推的"。
 *  - 附件形态不在这里重新拼装，一律复用 file.service.fileDto，保持单一事实来源。
 */
import { db } from '../db.js'
import { badRequest } from '../lib/errors.js'
import { fileDto, getFile } from './file.service.js'

export const MESSAGE_KINDS = Object.freeze(['text', 'code', 'file'])
export const MESSAGE_SOURCES = Object.freeze(['web', 'api'])

const MAX_TEXT_LENGTH = 4000
const MAX_CODE_LENGTH = 20000
const LANG_PATTERN = /^[a-zA-Z0-9+#._-]{1,24}$/

const insertMessage = db.prepare(`
  INSERT INTO messages (user_id, kind, body, lang, file_id, source, created_at)
  VALUES (@userId, @kind, @body, @lang, @fileId, @source, @createdAt)
`)

const SELECT_BASE = `
  SELECT m.id, m.kind, m.body, m.lang, m.file_id, m.source, m.created_at,
         u.id AS author_id, u.display_name AS author_name
  FROM messages m
  JOIN users u ON u.id = m.user_id
`

const selectById = db.prepare(`${SELECT_BASE} WHERE m.id = ?`)
const selectLatest = db.prepare(`${SELECT_BASE} ORDER BY m.id DESC LIMIT ?`)
const selectBefore = db.prepare(`${SELECT_BASE} WHERE m.id < ? ORDER BY m.id DESC LIMIT ?`)

function toDto(row) {
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind,
    body: row.body,
    lang: row.lang,
    source: row.source,
    createdAt: row.created_at,
    user: { id: row.author_id, name: row.author_name },
    file: row.file_id ? fileDto(getFile(row.file_id)) : null,
  }
}

export function getMessage(id) {
  return toDto(selectById.get(id))
}

/**
 * 读取历史消息。
 * @param {{ limit: number, before?: number|null }} params before 为消息 id，用于向上翻页
 * @returns 按时间正序排列的消息 DTO 数组
 */
export function listMessages({ limit, before = null }) {
  const size = Math.min(Math.max(Number(limit) || 0, 1), 200)
  const rows = before ? selectBefore.all(before, size) : selectLatest.all(size)
  return rows.reverse().map(toDto)
}

function persist({ userId, kind, body, lang, fileId, source }) {
  if (!MESSAGE_SOURCES.includes(source)) {
    throw badRequest('invalid_source', '未知的消息来源')
  }
  const result = insertMessage.run({
    userId,
    kind,
    body: body ?? null,
    lang: lang ?? null,
    fileId: fileId ?? null,
    source,
    createdAt: Date.now(),
  })
  return getMessage(result.lastInsertRowid)
}

/**
 * 发送文字或代码块消息。
 * @throws AppError 内容为空、超长、语言标记非法（400）
 */
export function createTextMessage({ userId, kind, body, lang, source = 'web' }) {
  if (kind !== 'text' && kind !== 'code') {
    throw badRequest('invalid_kind', '只支持 text 或 code')
  }
  const content = String(body ?? '')
  if (!content.trim()) {
    throw badRequest('empty_body', '消息内容不能为空')
  }
  const limit = kind === 'code' ? MAX_CODE_LENGTH : MAX_TEXT_LENGTH
  if (content.length > limit) {
    throw badRequest('body_too_long', `消息内容最长 ${limit} 个字符`)
  }
  let language = null
  if (kind === 'code') {
    const raw = String(lang ?? '').trim()
    if (raw) {
      if (!LANG_PATTERN.test(raw)) {
        throw badRequest('invalid_lang', '语言标记只能是 24 位以内的字母、数字或 +#._-')
      }
      language = raw.toLowerCase()
    }
  }
  return persist({ userId, kind, body: content, lang: language, fileId: null, source })
}

/**
 * 发送附件消息。
 * @param {{ userId: number, fileId: number, caption?: string, source?: string }} params
 * @throws AppError 说明文字超长（400）
 */
export function createFileMessage({ userId, fileId, caption = '', source = 'web' }) {
  const text = String(caption ?? '').trim()
  if (text.length > MAX_TEXT_LENGTH) {
    throw badRequest('body_too_long', `说明文字最长 ${MAX_TEXT_LENGTH} 个字符`)
  }
  return persist({ userId, kind: 'file', body: text || null, lang: null, fileId, source })
}
