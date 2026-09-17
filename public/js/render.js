/**
 * 消息渲染。
 *
 * 布局是聊天气泡：别人在左，自己在右，每条带头像和昵称。
 * 视觉语言仍然是工业终端那一套，所以气泡是直角的，靠一道琥珀侧条
 * 和背景深浅区分归属，而不是靠圆角和彩色。
 *
 * 全部用 createElement + textContent 组装，没有把用户内容拼进 innerHTML 的路径。
 */
import { avatarInk, avatarLetter, dayKey, el, formatClock, formatDay, formatSize, formatStamp, icon } from './ui.js'
import { parseBlocks, parseInline } from './markup.js'
import { show as showViewer } from './viewer.js'

/** 同一人 5 分钟内的连续发言并进一组，不重复画头像和昵称 */
const GROUP_WINDOW_MS = 5 * 60 * 1000

export function isSameGroup(message, previous) {
  if (!previous) return false
  if (previous.user.id !== message.user.id) return false
  if (previous.source !== message.source) return false
  if (message.createdAt - previous.createdAt > GROUP_WINDOW_MS) return false
  return new Date(previous.createdAt).toDateString() === new Date(message.createdAt).toDateString()
}

/** 日期分隔线。带上 data-day 便于向上补历史时识别并合并重复的那条 */
export function buildDayMark(ms) {
  const node = el('div', 'day-mark', formatDay(ms))
  node.dataset.day = dayKey(ms)
  return node
}

/** 把行内 token 铺进容器 */
function renderInline(host, text) {
  for (const token of parseInline(text)) {
    if (token.type === 'bold') {
      host.append(el('strong', null, token.text))
    } else if (token.type === 'code') {
      host.append(el('code', 'tick', token.text))
    } else if (token.type === 'link') {
      const link = el('a', null, token.text)
      link.href = token.text
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      host.append(link)
    } else {
      host.append(document.createTextNode(token.text))
    }
  }
  return host
}

/** 代码石板。lang 来自围栏标记，或 kind='code' 消息的 lang 字段 */
function renderCodeSlab(body, lang) {
  const slab = el('div', 'code-slab')
  const bar = el('div', 'slab-bar')
  bar.append(el('span', null, lang || 'text'), el('span', 'spacer'))

  const copyBtn = el('button', 'bare slim')
  const setLabel = (text, glyph) => copyBtn.replaceChildren(icon(glyph), el('span', null, text))
  setLabel('复制', 'copy')
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(body ?? '')
      setLabel('已复制', 'check')
    } catch {
      setLabel('复制失败', 'warning-circle')
    }
    setTimeout(() => setLabel('复制', 'copy'), 1600)
  })
  bar.append(copyBtn)

  const pre = el('pre')
  pre.append(el('code', null, body ?? ''))
  slab.append(bar, pre)
  return slab
}

/** 正文：先按围栏切块，代码块走石板，其余走行内标记 */
function renderBody(text) {
  const fragment = document.createDocumentFragment()
  for (const block of parseBlocks(text)) {
    if (block.type === 'code') fragment.append(renderCodeSlab(block.body, block.lang))
    else fragment.append(renderInline(el('div', 'say'), block.body))
  }
  return fragment
}

function goneSlab() {
  const node = el('div', 'gone')
  node.append(el('span', null, '附件已过保留期，从磁盘清除'))
  return node
}

const KIND_MARK = { image: 'IMG', video: 'VID', audio: 'AUD', file: 'BIN' }

export function viewerItem(message) {
  const via = message.source === 'api' ? 'API' : '网页'
  return {
    url: message.file.url,
    title: message.file.name,
    sub: `${message.user.name} 在 ${formatStamp(message.createdAt)} 经 ${via} 推送`,
    createdAt: message.createdAt,
  }
}

/** 过期后的占位：保留类型标记和文件名，好让人知道丢的是哪一张 */
function goneBlock(kind, name) {
  const fragment = document.createDocumentFragment()
  const label = el('div', 'att-kind')
  label.append(el('b', null, kind))
  label.append(document.createTextNode(`  ${name}`))
  fragment.append(label, goneSlab())
  return fragment
}

function renderAttachment(message) {
  const wrap = el('div', 'att')
  wrap.dataset.fileId = String(message.file.id)

  if (message.file.expired || !message.file.url) {
    wrap.append(goneBlock(KIND_MARK[message.file.category] ?? 'BIN', message.file.name))
    return wrap
  }

  if (message.file.category === 'image') {
    const frame = el('div', 'att-frame')
    const img = el('img')
    img.src = message.file.url
    img.alt = message.file.name
    img.loading = 'lazy'
    img.addEventListener('click', () => showViewer(viewerItem(message)))

    const peek = el('div', 'peek')
    peek.append(icon('magnifying-glass-plus'), el('span', null, '点击展开'))
    frame.append(img, peek)
    wrap.append(frame)
  } else if (message.file.category === 'video') {
    const frame = el('div', 'att-frame')
    const video = el('video')
    video.src = message.file.url
    video.controls = true
    video.preload = 'metadata'
    frame.append(video)
    wrap.append(frame)
  } else if (message.file.category === 'audio') {
    const audio = el('audio')
    audio.src = message.file.url
    audio.controls = true
    wrap.append(audio)
  } else {
    const slab = el('a', 'file-slab')
    slab.href = message.file.url
    slab.download = message.file.name
    const info = el('div', 'info')
    info.append(el('div', 'name', message.file.name), el('div', 'size', formatSize(message.file.size)))
    slab.append(info, icon('download-simple'))
    wrap.append(slab)
  }

  if (message.body) wrap.append(renderInline(el('div', 'caption'), message.body))
  return wrap
}

/**
 * 渲染一条消息。
 * @param {object} message 消息 DTO
 * @param {object|null} previous 上一条，用于判断是否并组
 * @param {number} meId 当前用户 id，决定靠左还是靠右
 */
export function renderRow(message, previous, meId) {
  const mine = message.user.id === meId
  const grouped = isSameGroup(message, previous)

  const classes = ['turn']
  if (mine) classes.push('mine')
  if (grouped) classes.push('grouped')
  const row = el('div', classes.join(' '))
  row.dataset.messageId = String(message.id)

  // 头像列始终占位，同组的后续消息让它留白，气泡才对得齐
  const face = el('div', 'face')
  if (!grouped) {
    face.textContent = avatarLetter(message.user.name)
    face.style.background = avatarInk(message.user.name)
    face.title = message.user.name
  } else {
    face.classList.add('blank')
  }

  const stack = el('div', 'stack')
  if (!grouped) {
    const head = el('div', 'turn-head')
    head.append(el('span', 'nick', message.user.name))
    head.append(el('span', 'clock', formatClock(message.createdAt)))
    if (message.source === 'api') head.append(el('span', 'via', 'API'))
    stack.append(head)
  }

  const bubble = el('div', message.source === 'api' ? 'bubble relay' : 'bubble')
  bubble.title = formatStamp(message.createdAt)

  // kind='code' 是接口层保留的整条代码消息形态；网页端发的一律是 text，围栏在正文里
  if (message.kind === 'code') bubble.append(renderCodeSlab(message.body, message.lang))
  else if (message.kind === 'file' && message.file) bubble.append(renderAttachment(message))
  else if (message.body) bubble.append(renderBody(message.body))

  stack.append(bubble)
  row.append(face, stack)
  return row
}

/**
 * 清理任务报告某些消息到期时，把它们从页面上摘掉。
 *
 * 顺带清理因此变空的日期分隔线：一整天的消息都过期了，那条"昨天"
 * 就没有内容可分隔了，留着是个孤零零的标签。
 *
 * @returns {number} 实际移除的条数
 */
export function dropMessages(ids) {
  let removed = 0
  for (const id of ids) {
    const node = document.querySelector(`.turn[data-message-id="${CSS.escape(String(id))}"]`)
    if (!node) continue
    node.remove()
    removed += 1
  }

  for (const mark of document.querySelectorAll('.day-mark')) {
    // 后面紧跟着的如果不是消息，这条分隔线就没有东西可分隔了
    const next = mark.nextElementSibling
    if (!next || !next.classList.contains('turn')) mark.remove()
  }

  return removed
}
