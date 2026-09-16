/**
 * 消息文本的轻量标记解析。
 *
 * 只认三种记号，刻意不做完整 Markdown：聊天框里用得上的就这些，
 * 支持越多，别人打字时被意外格式化的概率越高。
 *
 *   ```lang        围栏代码块，独占一段
 *   `code`         行内代码
 *   **bold**       加粗
 *   http://...     链接，自动识别
 *
 * 这里只产出 token，不碰 DOM。渲染层负责把 token 变成节点，
 * 全程 textContent，没有把用户输入拼进 innerHTML 的路径。
 * 拆成纯函数也是为了能直接单测，不必搭一套 DOM 环境。
 */

/** 围栏代码块。语言标记可省略，结尾围栏缺失时吃到文本末尾 */
const FENCE = /```([a-zA-Z0-9+#._-]*)[ \t]*\r?\n?([\s\S]*?)(?:```|$)/g

/** 行内：反引号代码、双星号加粗、裸链接。都不跨行 */
const INLINE = /`([^`\n]+)`|\*\*([^\n]+?)\*\*|(https?:\/\/[^\s<>"']+)/g

/**
 * 按围栏把文本切成块。
 * @param {string} source
 * @returns {Array<{ type: 'code', lang: string, body: string } | { type: 'text', body: string }>}
 *          相邻块之间的空白已归一；空块不会产出
 */
export function parseBlocks(source) {
  const text = String(source ?? '')
  const blocks = []
  let cursor = 0

  FENCE.lastIndex = 0
  for (const match of text.matchAll(FENCE)) {
    if (match.index > cursor) {
      const before = text.slice(cursor, match.index)
      if (before.trim()) blocks.push({ type: 'text', body: before.replace(/\s+$/, '') })
    }
    blocks.push({
      type: 'code',
      lang: (match[1] ?? '').toLowerCase(),
      // 去掉结尾围栏前的那个换行，但保留代码内部的缩进
      body: (match[2] ?? '').replace(/\r?\n$/, ''),
    })
    cursor = match.index + match[0].length
  }

  if (cursor < text.length) {
    const rest = text.slice(cursor)
    if (rest.trim()) blocks.push({ type: 'text', body: rest.replace(/^\r?\n/, '') })
  }

  // 整条消息没有任何围栏时，原样作为一个文本块
  if (blocks.length === 0 && text.trim()) blocks.push({ type: 'text', body: text })
  return blocks
}

/**
 * 解析一段纯文本里的行内标记。
 * @param {string} text
 * @returns {Array<{ type: 'plain' | 'bold' | 'code' | 'link', text: string }>}
 */
export function parseInline(text) {
  const source = String(text ?? '')
  const tokens = []
  let cursor = 0

  const push = (type, value) => {
    if (value !== '') tokens.push({ type, text: value })
  }

  INLINE.lastIndex = 0
  for (const match of source.matchAll(INLINE)) {
    if (match.index > cursor) push('plain', source.slice(cursor, match.index))
    if (match[1] !== undefined) push('code', match[1])
    else if (match[2] !== undefined) push('bold', match[2])
    else push('link', match[3])
    cursor = match.index + match[0].length
  }

  if (cursor < source.length) push('plain', source.slice(cursor))
  return tokens
}

/**
 * 给一段文本套上记号，供输入框的格式化按钮使用。
 *
 * 已经被同样的记号包住时会脱掉，按钮因此是可逆的：
 * 选中已加粗的文字再按一次加粗，是取消加粗而不是套两层。
 *
 * @param {string} selected 选中的文本，可能为空
 * @param {'bold'|'inlineCode'|'codeBlock'} kind
 * @returns {{ text: string, selectionStart: number, selectionEnd: number }}
 *          偏移量相对于返回的 text
 */
export function applyMark(selected, kind) {
  const value = String(selected ?? '')

  if (kind === 'codeBlock') {
    const fenced = /^```[a-zA-Z0-9+#._-]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(value)
    if (fenced) {
      return { text: fenced[1], selectionStart: 0, selectionEnd: fenced[1].length }
    }
    const text = `\`\`\`\n${value}\n\`\`\``
    // 没选内容时把光标停在围栏之间，直接就能开始打字
    return value
      ? { text, selectionStart: 4, selectionEnd: 4 + value.length }
      : { text, selectionStart: 4, selectionEnd: 4 }
  }

  const fence = kind === 'bold' ? '**' : '`'
  const wrapped = value.startsWith(fence) && value.endsWith(fence) && value.length > fence.length * 2
  if (wrapped) {
    const inner = value.slice(fence.length, -fence.length)
    return { text: inner, selectionStart: 0, selectionEnd: inner.length }
  }

  const text = `${fence}${value}${fence}`
  return { text, selectionStart: fence.length, selectionEnd: fence.length + value.length }
}
