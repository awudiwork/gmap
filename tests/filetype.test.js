/**
 * 类型嗅探的回归测试。
 * 重点覆盖失败分支：伪装成图片的文本必须嗅探不出来，从而被降级为附件下载。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isInlineMime, sniff, SNIFF_LENGTH, sniffableMimes } from '../server/lib/filetype.js'

/** 用给定字节拼一个够长的头部，模拟真实文件 */
const head = (...bytes) => {
  const buffer = Buffer.alloc(SNIFF_LENGTH)
  Buffer.from(bytes).copy(buffer)
  return buffer
}
const ascii = (text) => [...text].map((ch) => ch.charCodeAt(0))

test('识别 PNG', () => {
  assert.deepEqual(sniff(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), {
    mime: 'image/png',
    category: 'image',
  })
})

test('识别 JPEG', () => {
  assert.equal(sniff(head(0xff, 0xd8, 0xff, 0xe0))?.mime, 'image/jpeg')
})

test('识别 WebP（RIFF 容器，第 5~8 字节任意）', () => {
  assert.equal(sniff(head(...ascii('RIFF'), 0x11, 0x22, 0x33, 0x44, ...ascii('WEBP')))?.mime, 'image/webp')
})

test('识别 MP4', () => {
  assert.deepEqual(sniff(head(0, 0, 0, 0x20, ...ascii('ftypisom'))), {
    mime: 'video/mp4',
    category: 'video',
  })
})

/** EBML 头：魔数 + 若干元素，DocType（42 82）跟着长度和字符串 */
const ebml = (docType) => head(
  0x1a, 0x45, 0xdf, 0xa3, 0x9f,
  0x42, 0x86, 0x81, 0x01,
  0x42, 0xf7, 0x81, 0x01,
  0x42, 0xf2, 0x81, 0x04,
  0x42, 0xf3, 0x81, 0x08,
  0x42, 0x82, 0x80 | docType.length, ...ascii(docType),
  0x42, 0x87, 0x81, 0x02,
)

test('识别 WebM（EBML 头且 DocType 是 webm）', () => {
  assert.deepEqual(sniff(ebml('webm')), { mime: 'video/webm', category: 'video' })
})

test('MKV 和 WebM 共用 EBML 魔数，但浏览器放不了 MKV，不能识别为视频', () => {
  assert.equal(sniff(ebml('matroska')), null)
  assert.equal(sniff(head(0x1a, 0x45, 0xdf, 0xa3)), null, '只有魔数、没有 DocType 的不认')
})

test('伪装成图片的 HTML 嗅探失败，必须返回 null', () => {
  assert.equal(sniff(head(...ascii('<html><script>alert(1)'))), null)
})

test('RIFF 但不是 WebP/WAV/AVI 的容器不被误判', () => {
  assert.equal(sniff(head(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('XXXX'))), null)
})

test('头部过短不崩溃', () => {
  assert.equal(sniff(Buffer.from([0x89])), null)
  assert.equal(sniff(Buffer.alloc(0)), null)
})

test('非 Buffer 输入返回 null', () => {
  assert.equal(sniff(null), null)
  assert.equal(sniff('PNG'), null)
})

test('凡是能嗅探出来的类型都允许内联下发', () => {
  // 这条一旦破掉，前端会按 img / video 渲染，服务端却下发 attachment，
  // 用户看到的是一张永远加载不出来的破图
  const broken = sniffableMimes().filter((mime) => !isInlineMime(mime))
  assert.deepEqual(broken, [], `这些类型能被识别却不允许内联：${broken.join(', ')}`)
})

test('AVI 不被识别为视频，浏览器放不了它', () => {
  const head = Buffer.alloc(SNIFF_LENGTH)
  Buffer.from([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('AVI ')]).copy(head)
  assert.equal(sniff(head), null, 'AVI 应当落到附件下载，而不是渲染成播不出来的 video')
})
