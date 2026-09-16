/**
 * 内存固定窗口限流（机制层，不认识业务概念）。
 *
 * 适用边界：单进程部署。多实例部署需要换成共享存储实现，
 * 届时只要保持 consume(key) -> { allowed, retryAfterMs } 这个接口即可替换。
 */
export function createRateLimiter({ windowMs, max }) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map()

  const sweep = () => {
    const now = Date.now()
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key)
    }
  }
  const timer = setInterval(sweep, Math.max(windowMs, 60_000))
  timer.unref?.()

  return {
    /**
     * 消费一次配额。
     * @returns {{ allowed: boolean, retryAfterMs: number }}
     */
    consume(key) {
      const now = Date.now()
      const bucket = buckets.get(key)
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs })
        return { allowed: true, retryAfterMs: 0 }
      }
      if (bucket.count >= max) {
        return { allowed: false, retryAfterMs: bucket.resetAt - now }
      }
      bucket.count += 1
      return { allowed: true, retryAfterMs: 0 }
    },
    reset(key) {
      buckets.delete(key)
    },
    stop() {
      clearInterval(timer)
      buckets.clear()
    },
  }
}
