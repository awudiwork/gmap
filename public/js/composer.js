/**
 * 输入区：富文本编辑器、待发附件、上传队列、高度拖拽。
 *
 * 两条行为约定：
 *  - 粘贴或拖入的文件先进待发区，点发送才上传。手抖粘错东西时还能撤回，
 *    而且能跟着配一句说明一起发出去。
 *  - 发送成功后不在本地插入消息，等服务端通过 WebSocket 广播回来再渲染，
 *    这样"我看到的"和"别人看到的"来自同一条数据路径。
 */
import { api, ApiError } from './api.js'
import { createEditor } from './editor.js'
import { el, formatSize, icon, toast } from './ui.js'

/** 同时最多传 2 个，避免热键连按把上行带宽打满 */
const MAX_PARALLEL = 2

const HEIGHT_KEY = 'gmap.command.height'
const MIN_HEIGHT = 108
const MAX_RATIO = 0.62

export function initCommand() {
  const command = document.getElementById('command')
  const grip = document.getElementById('grip')
  const inputHost = document.getElementById('input')
  const sendBtn = document.getElementById('btn-send')
  const boldBtn = document.getElementById('btn-bold')
  const tickBtn = document.getElementById('btn-tick')
  const codeBtn = document.getElementById('btn-code')
  const attachBtn = document.getElementById('btn-attach')
  const fileInput = document.getElementById('file-input')
  const queue = document.getElementById('queue')
  const tray = document.getElementById('tray')

  const pending = []
  let running = 0

  /* ── 待发附件 ──────────────────────────────────────── */

  /** @type {Array<{ file: File, preview: string | null }>} */
  const staged = []

  function renderTray() {
    tray.replaceChildren()
    tray.classList.toggle('hidden', staged.length === 0)

    for (const item of staged) {
      const chip = el('div', 'chip')

      if (item.preview) {
        const thumb = el('img', 'thumb')
        thumb.src = item.preview
        thumb.alt = ''
        chip.append(thumb)
      } else {
        chip.append(el('span', 'kind', item.file.type?.startsWith('video/') ? 'VID' : 'BIN'))
      }

      const meta = el('div', 'meta')
      meta.append(el('div', 'name', item.file.name || '截图'), el('div', 'size', formatSize(item.file.size)))
      chip.append(meta)

      const drop = el('button', 'bare slim')
      drop.append(icon('x'))
      drop.title = '移除'
      drop.setAttribute('aria-label', `移除 ${item.file.name || '截图'}`)
      drop.addEventListener('click', () => {
        // 按对象定位而不是渲染时的下标：下标是快照，一旦改成增量渲染就会删错
        const at = staged.indexOf(item)
        if (at < 0) return
        if (item.preview) URL.revokeObjectURL(item.preview)
        staged.splice(at, 1)
        renderTray()
        editor.focus()
      })
      chip.append(drop)

      tray.append(chip)
    }
  }

  function stageFiles(files) {
    for (const file of [...files].filter(Boolean)) {
      // 只给图片做预览，视频抽帧要解码，不值得为一个缩略图付这个代价
      const preview = file.type?.startsWith('image/') ? URL.createObjectURL(file) : null
      staged.push({ file, preview })
    }
    renderTray()
    editor.focus()
  }

  function clearStaged() {
    for (const item of staged) {
      if (item.preview) URL.revokeObjectURL(item.preview)
    }
    staged.length = 0
    renderTray()
  }

  /* ── 上传队列 ──────────────────────────────────────── */

  function queueRow(file) {
    const row = el('div', 'queue-row')
    const label = el('span', 'label', file.name || '截图')
    const meter = el('div', 'meter')
    const fill = el('i')
    meter.append(fill)
    const pct = el('span', 'pct', '0%')
    row.append(label, meter, pct)
    queue.append(row)

    return {
      progress(ratio) {
        const value = Math.round(ratio * 100)
        fill.style.width = `${value}%`
        pct.textContent = `${value}%`
      },
      done() { row.remove() },
      fail(reason) {
        row.classList.add('bad')
        row.replaceChildren(icon('warning-circle'), el('span', 'label', file.name || '截图'), el('span', null, reason))
        setTimeout(() => row.remove(), 6000)
      },
    }
  }

  function pump() {
    while (running < MAX_PARALLEL && pending.length > 0) {
      const task = pending.shift()
      running += 1
      task().finally(() => {
        running -= 1
        pump()
      })
    }
  }

  function enqueue(file, caption) {
    const ui = queueRow(file)
    pending.push(async () => {
      try {
        await api.upload({ file, caption, onProgress: ui.progress })
        ui.done()
      } catch (err) {
        ui.fail(err instanceof ApiError ? err.message : '上传失败')
      }
    })
    pump()
  }

  /* ── 发送 ──────────────────────────────────────────── */

  async function send() {
    const body = editor.getValue()
    const files = staged.map((item) => item.file)

    if (!body.trim() && files.length === 0) return

    if (files.length > 0) {
      // 有附件时，输入框里的文字当作第一个附件的说明一起发出去
      files.forEach((file, index) => enqueue(file, index === 0 ? body : ''))
      editor.clear()
      clearStaged()
      editor.focus()
      return
    }

    sendBtn.disabled = true
    try {
      await api.sendText({ kind: 'text', body })
      editor.clear()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '发送失败', 'bad')
    } finally {
      sendBtn.disabled = false
      editor.focus()
    }
  }

  const editor = createEditor(inputHost, { onSubmit: send, onPasteFiles: stageFiles })

  sendBtn.addEventListener('click', send)
  boldBtn.addEventListener('click', editor.toggleBold)
  tickBtn.addEventListener('click', editor.toggleInlineCode)
  codeBtn.addEventListener('click', editor.insertCodeBlock)
  attachBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    stageFiles(fileInput.files)
    fileInput.value = ''
  })

  // 整页接收拖放，拖到哪里都算
  document.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault()
  })
  document.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return
    event.preventDefault()
    stageFiles(event.dataTransfer.files)
  })

  /* ── 高度拖拽 ──────────────────────────────────────── */

  const clampHeight = (value) => Math.min(Math.max(value, MIN_HEIGHT), Math.round(window.innerHeight * MAX_RATIO))

  function setHeight(value, persist = true) {
    const next = clampHeight(value)
    command.style.height = `${next}px`
    if (!persist) return
    try {
      localStorage.setItem(HEIGHT_KEY, String(next))
    } catch {
      // 隐私模式写不进去，本次会话内仍然生效
    }
  }

  try {
    const saved = Number(localStorage.getItem(HEIGHT_KEY))
    if (Number.isFinite(saved) && saved > 0) setHeight(saved, false)
  } catch {
    // 读不到就用样式里的默认高度
  }

  let dragFrom = null
  grip.addEventListener('pointerdown', (event) => {
    dragFrom = { y: event.clientY, height: command.offsetHeight }
    grip.setPointerCapture(event.pointerId)
    grip.classList.add('dragging')
  })
  grip.addEventListener('pointermove', (event) => {
    if (!dragFrom) return
    // 往上拖是变高，所以是起点减当前
    setHeight(dragFrom.height + (dragFrom.y - event.clientY))
  })
  const endDrag = (event) => {
    if (!dragFrom) return
    dragFrom = null
    grip.classList.remove('dragging')
    grip.releasePointerCapture?.(event.pointerId)
  }
  grip.addEventListener('pointerup', endDrag)
  grip.addEventListener('pointercancel', endDrag)

  // 键盘也能调，拖拽条不该是只有鼠标能用的控件
  grip.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 16
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHeight(command.offsetHeight + step)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHeight(command.offsetHeight - step)
    }
  })

  window.addEventListener('resize', () => setHeight(command.offsetHeight, false))

  return { focus: editor.focus }
}
