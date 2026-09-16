/**
 * 看图器视图几何的回归测试。
 *
 * 这块出错的表现是"图偏了一点"，肉眼未必立刻发现，但地图同步场景下
 * 偏一点就意味着盯着的角落不见了。往返一致性是最有力的约束。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { anchorOf, clampOrigin, fitView, originFor, zoomAround } from '../public/js/viewport.js'

const natural = { width: 1600, height: 1200 }
const viewport = { width: 1000, height: 700 }

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `期望 ${expected}，实际 ${actual}`)

test('适应窗口按 contain 缩放并居中', () => {
  const view = fitView({ natural, viewport })
  // 高度更受限：700/1200 < 1000/1600
  close(view.scale, 700 / 1200)
  close(view.tx, (1000 - 1600 * (700 / 1200)) / 2)
  close(view.ty, 0)
})

test('小图不放大', () => {
  const view = fitView({ natural: { width: 200, height: 100 }, viewport })
  assert.equal(view.scale, 1)
  close(view.tx, 400)
  close(view.ty, 300)
})

test('尺寸缺失时适应窗口返回 null，调用方据此跳过', () => {
  assert.equal(fitView({ natural: { width: 0, height: 0 }, viewport }), null)
  assert.equal(fitView({ natural, viewport: { width: 0, height: 0 } }), null)
})

test('锚点与平移量互为逆运算', () => {
  const view = { scale: 2.5, tx: -840, ty: -613, natural, viewport }
  const anchor = anchorOf(view)
  const origin = originFor({ scale: view.scale, anchor, natural, viewport })
  close(origin.tx, view.tx, 1e-6)
  close(origin.ty, view.ty, 1e-6)
})

test('居中锚点算出来就是把图放在正中', () => {
  const origin = originFor({ scale: 1, anchor: { u: 0.5, v: 0.5 }, natural, viewport })
  close(origin.tx, (1000 - 1600) / 2)
  close(origin.ty, (700 - 1200) / 2)
})

test('换一张尺寸不同的图，同一个锚点仍然指向同一处相对位置', () => {
  // 盯着右下角四分之一处
  const anchor = { u: 0.75, v: 0.75 }
  const small = originFor({ scale: 1, anchor, natural: { width: 800, height: 600 }, viewport })
  const large = originFor({ scale: 1, anchor, natural: { width: 1600, height: 1200 }, viewport })
  // 画面中心都落在各自图片的 75% 处
  close((viewport.width / 2 - small.tx) / 800, 0.75)
  close((viewport.width / 2 - large.tx) / 1600, 0.75)
})

test('锚点被夹在 0 到 1 之间，图拖出画面也不会记成负数', () => {
  const anchor = anchorOf({ scale: 1, tx: 5000, ty: 5000, natural, viewport })
  assert.equal(anchor.u, 0)
  assert.equal(anchor.v, 0)

  const far = anchorOf({ scale: 1, tx: -9000, ty: -9000, natural, viewport })
  assert.equal(far.u, 1)
  assert.equal(far.v, 1)
})

test('尺寸未知时算不出锚点', () => {
  assert.equal(anchorOf({ scale: 1, tx: 0, ty: 0, natural: { width: 0, height: 0 }, viewport }), null)
  assert.equal(anchorOf({ scale: 0, tx: 0, ty: 0, natural, viewport }), null)
})

test('平移约束保证图片始终留一块在视口里', () => {
  const margin = 48
  const far = clampOrigin({ scale: 1, tx: 99999, ty: 99999, natural, viewport, margin })
  assert.equal(far.tx, viewport.width - margin)
  assert.equal(far.ty, viewport.height - margin)

  const back = clampOrigin({ scale: 1, tx: -99999, ty: -99999, natural, viewport, margin })
  assert.equal(back.tx, -(natural.width - margin))
  assert.equal(back.ty, -(natural.height - margin))
})

test('在约束范围内的平移不被改动', () => {
  const kept = clampOrigin({ scale: 1, tx: -100, ty: -80, natural, viewport, margin: 48 })
  assert.equal(kept.tx, -100)
  assert.equal(kept.ty, -80)
})

test('以光标为不动点缩放：光标下的那个点不动', () => {
  const before = { scale: 1, tx: -200, ty: -100 }
  const px = 400
  const py = 300
  // 缩放前光标落在图片坐标系的这个点上
  const imageX = (px - before.tx) / before.scale
  const imageY = (py - before.ty) / before.scale

  const after = zoomAround({ ...before, px, py, factor: 2.5, min: 0.05, max: 12 })
  close(after.scale, 2.5)
  // 缩放后同一个图片坐标仍然落在光标处
  close(after.tx + imageX * after.scale, px, 1e-6)
  close(after.ty + imageY * after.scale, py, 1e-6)
})

test('缩放被夹在上下限之间', () => {
  assert.equal(zoomAround({ scale: 10, tx: 0, ty: 0, px: 0, py: 0, factor: 5, min: 0.05, max: 12 }).scale, 12)
  assert.equal(zoomAround({ scale: 0.1, tx: 0, ty: 0, px: 0, py: 0, factor: 0.1, min: 0.05, max: 12 }).scale, 0.05)
})
