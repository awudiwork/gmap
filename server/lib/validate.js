/**
 * 请求参数的通用校验（机制层，不认识业务概念）。
 * 路径参数和查询串里的 id / 游标都是"正整数或非法"，各个路由不必各写一遍。
 */
import { badRequest } from './errors.js'

/**
 * 把字符串解析成正整数。
 * @param {unknown} raw 原始值
 * @param {{ code: string, message: string, max?: number }} spec 非法时抛出的错误语义
 * @returns {number}
 * @throws AppError 400
 */
export function parsePositiveInt(raw, { code, message, max = Number.MAX_SAFE_INTEGER }) {
  // 只认纯数字串。Number('1e3') / Number(' 7 ') 都能过 Number.isInteger，但那不是 id 的写法
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw badRequest(code, message)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw badRequest(code, message)
  return value
}
