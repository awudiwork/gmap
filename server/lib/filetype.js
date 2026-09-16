/**
 * 文件类型嗅探（按魔数，不信任客户端声明的 Content-Type 与扩展名）。
 *
 * 安全动机：分类结果决定文件是否允许内联展示。伪装成 image/png 的 HTML
 * 嗅探不出来就会落到 'file' 分类，只能以附件形式下载，不会在站点内被渲染执行。
 */

const ASCII = (text) => [...text].map((ch) => ch.charCodeAt(0))

/** 每条规则：offset 起始处逐字节比对，null 表示该位任意 */
const SIGNATURES = [
  { mime: 'image/png', category: 'image', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', category: 'image', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', category: 'image', offset: 0, bytes: ASCII('GIF8') },
  { mime: 'image/bmp', category: 'image', offset: 0, bytes: ASCII('BM') },
  { mime: 'image/webp', category: 'image', offset: 0, bytes: [...ASCII('RIFF'), null, null, null, null, ...ASCII('WEBP')] },
  { mime: 'image/avif', category: 'image', offset: 4, bytes: [...ASCII('ftyp'), ...ASCII('avif')] },
  { mime: 'image/vnd.microsoft.icon', category: 'image', offset: 0, bytes: [0x00, 0x00, 0x01, 0x00] },

  { mime: 'video/webm', category: 'video', offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: 'video/mp4', category: 'video', offset: 4, bytes: [...ASCII('ftyp'), ...ASCII('isom')] },
  { mime: 'video/mp4', category: 'video', offset: 4, bytes: [...ASCII('ftyp'), ...ASCII('mp4')] },
  { mime: 'video/mp4', category: 'video', offset: 4, bytes: [...ASCII('ftyp'), ...ASCII('M4V')] },
  { mime: 'video/quicktime', category: 'video', offset: 4, bytes: [...ASCII('ftyp'), ...ASCII('qt')] },
  // AVI 刻意不认：浏览器放不了它，识别成 video 只会让前端渲染一个永远播不出来的
  // <video>。嗅探不出来就落到 file 分类，按附件下载才是对的。

  { mime: 'audio/mpeg', category: 'audio', offset: 0, bytes: ASCII('ID3') },
  { mime: 'audio/ogg', category: 'audio', offset: 0, bytes: ASCII('OggS') },
  { mime: 'audio/wav', category: 'audio', offset: 0, bytes: [...ASCII('RIFF'), null, null, null, null, ...ASCII('WAVE')] },
]

/** 嗅探需要的最小头部字节数 */
export const SNIFF_LENGTH = 32

/**
 * 允许以原始 MIME 内联下发的类型。
 *
 * 和 SIGNATURES 放在同一个文件里是有意的：这两份清单必须始终对齐。
 * 一旦某个类型能被嗅探成 image/video/audio，却不在这里，前端会按媒体渲染，
 * 服务端却下发 attachment，结果是一张永远加载不出来的破图。
 * tests/filetype.test.js 会双向校验这件事。
 */
const INLINE_MIME = new Set(SIGNATURES.map((rule) => rule.mime))

/** 这个类型能不能直接用 img / video / audio 展示 */
export const isInlineMime = (mime) => INLINE_MIME.has(mime)

/** 嗅探能产出的全部 MIME，供测试比对 */
export const sniffableMimes = () => [...INLINE_MIME]

function matches(head, rule) {
  if (head.length < rule.offset + rule.bytes.length) return false
  for (let i = 0; i < rule.bytes.length; i += 1) {
    const expected = rule.bytes[i]
    if (expected === null) continue
    if (head[rule.offset + i] !== expected) return false
  }
  return true
}

/**
 * @param {Buffer} head 文件开头至少 SNIFF_LENGTH 字节
 * @returns {{ mime: string, category: 'image'|'video'|'audio' } | null} 无法识别时返回 null
 */
export function sniff(head) {
  if (!Buffer.isBuffer(head)) return null
  for (const rule of SIGNATURES) {
    if (matches(head, rule)) return { mime: rule.mime, category: rule.category }
  }
  return null
}
