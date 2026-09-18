/**
 * 外部数据源的缓存读取（机制层）。
 *
 * 三层：内存缓存（按 ttl 过期）→ 上游接口 → 本地快照（可选）。
 * 上游挂了就沿用上一次拉到的（标成 stale），从没拉到过才退回快照；
 * 都没有就抛错，由调用方决定怎么告诉客户端。
 *
 * source：upstream 刚拉到；stale 上游暂时拉不到、沿用旧的；snapshot 仓库快照。
 * fetchedAt 是数据真正拿到的时刻，checkedAt 是上次尝试的时刻。
 */
import fs from 'node:fs/promises'

/** 上游对不带浏览器标识的请求返回 403 */
export const BROWSER_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Accept: 'application/json',
})

/**
 * @param {{
 *   name: string,
 *   url: string,
 *   ttlMs: number,
 *   validate: (data: unknown) => boolean,
 *   snapshotPath?: string,
 *   offline?: () => boolean,
 *   timeoutMs?: number,
 * }} options offline 返回 true 时不联网，只用快照
 */
export function createUpstreamCache({ name, url, ttlMs, validate, snapshotPath, offline = () => false, timeoutMs = 12_000 }) {
  let cache = null
  let inflight = null
  let warned = false

  async function fetchUpstream() {
    const response = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`)
    const data = await response.json()
    if (!validate(data)) throw new Error('上游返回的数据缺少必要字段')
    return data
  }

  async function readSnapshot() {
    if (!snapshotPath) throw new Error(`${name} 没有本地快照`)
    const data = JSON.parse(await fs.readFile(snapshotPath, 'utf8'))
    if (!validate(data)) throw new Error(`${name} 的快照损坏`)
    return data
  }

  async function refresh() {
    const now = Date.now()
    if (!offline()) {
      try {
        const data = await fetchUpstream()
        cache = { data, source: 'upstream', fetchedAt: now, checkedAt: now }
        warned = false
        return cache
      } catch (err) {
        if (!warned) {
          console.warn(`[${name}] 拉取上游失败，改用本地数据：${err.message}`)
          warned = true
        }
        // 往后推一个周期再试，不然上游一挂每个请求都要等它超时
        if (cache) {
          cache = { ...cache, source: 'stale', checkedAt: now }
          return cache
        }
      }
    }
    // 离线模式下快照在进程生命周期内不会变，读过一次就一直用
    cache = { data: await readSnapshot(), source: 'snapshot', fetchedAt: now, checkedAt: Infinity }
    return cache
  }

  const isFresh = () => cache !== null && Date.now() - cache.checkedAt < ttlMs

  return {
    /** @returns {Promise<{ data: object, source: string, fetchedAt: number }>} */
    async get() {
      if (isFresh()) return cache
      if (!inflight) inflight = refresh().finally(() => { inflight = null })
      return inflight
    },
    /** 只给测试用 */
    reset() {
      cache = null
      inflight = null
      warned = false
    },
  }
}
