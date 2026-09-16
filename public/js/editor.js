/**
 * 输入框。用 contenteditable 而不是 textarea，因为加粗要真的显示成粗体，
 * 而不是让人盯着一串 ** 号打字。
 *
 * 存储格式仍然是纯文本标记：编辑器里是富文本，发出去之前序列化回
 * `**bold**` / `` `code` `` / 围栏。这样服务端、API 客户端、历史消息
 * 全都不受影响，只有编辑这一层是富的。
 *
 * 允许存在的元素只有 STRONG / B / CODE / PRE / BR，粘贴一律降级成纯文本，
 * 所以这棵树永远不会长出意料之外的结构。
 */

const TEXT_NODE = 3
const ELEMENT_NODE = 1

/** 编辑器里允许的块级元素，序列化时前后补换行 */
const BLOCKISH = new Set(['DIV', 'P'])

/**
 * 把编辑器的节点树序列化成纯文本标记。
 *
 * 只依赖 nodeType / nodeName / data / childNodes 四个字段，
 * 因此可以脱离浏览器直接测。
 *
 * @param {{ nodeType: number, nodeName?: string, data?: string, childNodes?: object[] }} node
 * @returns {string}
 */
export function serialize(node) {
  if (!node) return ''

  if (node.nodeType === TEXT_NODE) return node.data ?? ''

  if (node.nodeType !== ELEMENT_NODE) return ''

  const name = (node.nodeName ?? '').toUpperCase()
  const children = [...(node.childNodes ?? [])]
  const inner = children.map(serialize).join('')

  if (name === 'BR') return '\n'

  if (name === 'STRONG' || name === 'B') {
    // 空的加粗节点不产出记号，否则会留下一对孤零零的星号
    return inner.trim() ? `**${inner}**` : inner
  }

  if (name === 'CODE') {
    // PRE 里的 CODE 由 PRE 统一处理，这里只管行内的
    return inner.trim() ? `\`${inner}\`` : inner
  }

  if (name === 'PRE') {
    const body = inner.replace(/\n$/, '')
    return `\n\`\`\`\n${body}\n\`\`\`\n`
  }

  if (BLOCKISH.has(name)) {
    // 浏览器在粘贴多行时会生成 DIV，每个 DIV 是一行
    return `${inner}\n`
  }

  return inner
}

/** 序列化整个编辑器并归一化首尾空白 */
export function readValue(root) {
  const text = [...root.childNodes].map(serialize).join('')
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
}

const escapeHtml = (text) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

/** 从选区往上找指定标签，找不到返回 null */
function closestTag(node, tagName, root) {
  let cursor = node
  while (cursor && cursor !== root) {
    if (cursor.nodeType === ELEMENT_NODE && cursor.nodeName === tagName) return cursor
    cursor = cursor.parentNode
  }
  return null
}

/** 把元素替换成它的子节点，用于取消行内代码 */
function unwrap(node) {
  const parent = node.parentNode
  while (node.firstChild) parent.insertBefore(node.firstChild, node)
  parent.removeChild(node)
}

/**
 * 挂载编辑器。
 *
 * @param {HTMLElement} root contenteditable 容器
 * @param {{ onSubmit: () => void, onPasteFiles: (files: File[]) => void }} handlers
 */
export function createEditor(root, { onSubmit, onPasteFiles }) {
  root.contentEditable = 'true'
  root.spellcheck = false

  const selection = () => window.getSelection()

  const insertHtml = (html) => {
    root.focus()
    // execCommand 虽然标记为废弃，却是唯一能把改动记进原生撤销栈的办法
    try {
      if (document.execCommand('insertHTML', false, html)) return true
    } catch {
      // 落到下面的兜底
    }
    return false
  }

  /** 加粗走浏览器原生实现，它处理跨节点选区比自己写靠谱得多 */
  function toggleBold() {
    root.focus()
    try {
      document.execCommand('styleWithCSS', false, 'false')
    } catch {
      // 老浏览器不支持这个开关，忽略即可
    }
    document.execCommand('bold')
  }

  /** 行内代码没有原生命令，自己包一层，再按一次是解开 */
  function toggleInlineCode() {
    root.focus()
    const sel = selection()
    if (!sel || sel.rangeCount === 0) return

    const range = sel.getRangeAt(0)
    const existing = closestTag(range.startContainer, 'CODE', root)
    if (existing && !closestTag(existing, 'PRE', root)) {
      unwrap(existing)
      return
    }

    const text = sel.toString()
    if (!insertHtml(`<code>${escapeHtml(text || ' ')}</code>`)) {
      const node = document.createElement('code')
      node.append(range.extractContents())
      range.insertNode(node)
    }
  }

  /** 代码块是一个真实的 PRE 块，里面 Enter 换行而不是发送 */
  function insertCodeBlock() {
    root.focus()
    const sel = selection()
    const inside = sel?.rangeCount ? closestTag(sel.getRangeAt(0).startContainer, 'PRE', root) : null
    if (inside) {
      unwrap(inside)
      return
    }
    const text = sel ? sel.toString() : ''
    if (!insertHtml(`<pre>${escapeHtml(text)}</pre><br>`)) {
      const pre = document.createElement('pre')
      pre.textContent = text
      root.append(pre)
    }
  }

  // contenteditable 被删空后往往留下一个 <br> 或空 <div>，:empty 不再成立，
  // placeholder 就消失了，看着像个高高的空白框。清干净它。
  root.addEventListener('input', () => {
    if (root.childNodes.length > 0 && readValue(root) === '') root.replaceChildren()
  })

  root.addEventListener('keydown', (event) => {
    const sel = selection()
    const inPre = sel?.rangeCount ? closestTag(sel.getRangeAt(0).startContainer, 'PRE', root) : null

    if (event.key === 'Enter' && !event.isComposing) {
      // 代码块里 Enter 是换行，外面 Enter 是发送
      if (inPre || event.shiftKey) {
        event.preventDefault()
        insertHtml('<br>')
        return
      }
      event.preventDefault()
      onSubmit()
      return
    }

    if (!event.ctrlKey && !event.metaKey) return
    const key = event.key.toLowerCase()
    if (key === 'b') {
      event.preventDefault()
      toggleBold()
    } else if (key === 'e') {
      event.preventDefault()
      toggleInlineCode()
    } else if (key === 'c' && event.shiftKey) {
      event.preventDefault()
      insertCodeBlock()
    } else if (key === 'i' || key === 'u') {
      // 斜体和下划线没有对应的标记，别让它们进来
      event.preventDefault()
    }
  })

  // 粘贴一律降级成纯文本：外部富文本的结构和样式没有一样能用的
  root.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean)
    if (files.length > 0) {
      event.preventDefault()
      onPasteFiles(files)
      return
    }
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    insertHtml(escapeHtml(text).replace(/\r?\n/g, '<br>'))
  })

  // 拖入编辑器的内容同样只取纯文本，文件交给外面处理
  root.addEventListener('drop', (event) => {
    if (event.dataTransfer?.files?.length) return
    event.preventDefault()
    const text = event.dataTransfer?.getData('text/plain') ?? ''
    insertHtml(escapeHtml(text).replace(/\r?\n/g, '<br>'))
  })

  return {
    getValue: () => readValue(root),
    isEmpty: () => readValue(root).trim() === '',
    clear() {
      root.replaceChildren()
    },
    focus: () => root.focus(),
    toggleBold,
    toggleInlineCode,
    insertCodeBlock,
  }
}
