/**
 * 看图器的视图几何。纯计算，不碰 DOM。
 *
 * 位置用归一化锚点表示，而不是像素偏移：锚点是"画面中心落在图片的哪个位置"，
 * 取值 0 到 1。视口大小变了、换了一张尺寸不同的地图，按锚点还原仍然对得上，
 * 存像素偏移就全错了。
 *
 * anchorOf 和 originFor 互为逆运算，测试靠这一点守住。
 */

export const clamp01 = (value) => Math.min(Math.max(value, 0), 1)

/**
 * 当前画面中心落在图片上的归一化位置。
 * @param {{ scale: number, tx: number, ty: number,
 *           natural: { width: number, height: number },
 *           viewport: { width: number, height: number } }} view
 * @returns {{ u: number, v: number } | null} 图片尺寸未知时返回 null
 */
export function anchorOf({ scale, tx, ty, natural, viewport }) {
  if (!natural?.width || !natural?.height || !scale) return null
  return {
    u: clamp01(((viewport.width / 2 - tx) / scale) / natural.width),
    v: clamp01(((viewport.height / 2 - ty) / scale) / natural.height),
  }
}

/**
 * 让指定锚点落在画面中心所需的平移量。
 * @param {{ scale: number, anchor: { u: number, v: number },
 *           natural: { width: number, height: number },
 *           viewport: { width: number, height: number } }} view
 * @returns {{ tx: number, ty: number }}
 */
export function originFor({ scale, anchor, natural, viewport }) {
  return {
    tx: viewport.width / 2 - clamp01(anchor.u) * natural.width * scale,
    ty: viewport.height / 2 - clamp01(anchor.v) * natural.height * scale,
  }
}

/**
 * 适应窗口：按 contain 缩放并居中，小图不放大。
 * @returns {{ scale: number, tx: number, ty: number } | null}
 */
export function fitView({ natural, viewport }) {
  if (!natural?.width || !natural?.height || !viewport?.width || !viewport?.height) return null
  const scale = Math.min(viewport.width / natural.width, viewport.height / natural.height, 1)
  return {
    scale,
    tx: (viewport.width - natural.width * scale) / 2,
    ty: (viewport.height - natural.height * scale) / 2,
  }
}

/**
 * 约束平移，保证图片至少有 margin 那么宽的一块留在视口里。
 * 没有这层约束时，快速拖动很容易把图甩出画面。
 */
export function clampOrigin({ scale, tx, ty, natural, viewport, margin }) {
  const w = natural.width * scale
  const h = natural.height * scale
  if (!w || !h) return { tx, ty }
  return {
    tx: Math.min(Math.max(tx, -(w - margin)), viewport.width - margin),
    ty: Math.min(Math.max(ty, -(h - margin)), viewport.height - margin),
  }
}

/**
 * 以某个屏幕坐标为不动点缩放。
 * @param {{ px: number, py: number, factor: number, min: number, max: number }} input
 *        px / py 是相对舞台左上角的坐标
 */
export function zoomAround({ scale, tx, ty, px, py, factor, min, max }) {
  const next = Math.min(Math.max(scale * factor, min), max)
  return {
    scale: next,
    tx: px - (px - tx) * (next / scale),
    ty: py - (py - ty) * (next / scale),
  }
}
