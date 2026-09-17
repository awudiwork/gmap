/**
 * 内存固定窗口限流（机制层，不认识业务概念）。
 *
 * 适用边界：单进程部署。多实例部署需要换成共享存储实现，
 * 届时只要保持 consume(key) -> { allowed, retryAfterMs } 这个接口即可替换。
 */
/**
 * 最小间隔节流：两次通过之间至少要隔 intervalMs。
 *
 * 和固定窗口计数是两回事，各挡各的：窗口计数防的是"一分钟内刷了几十张"，
 * 这个防的是"热键按住不放，一秒钟连发十张"。
 *
 * intervalMs 为 0 时直接放行，不记录任何状态。
 */
export function createThrottle({ intervalMs }) {
  /** @type {Map<string, number>} 上次通过的时间 */
  const seen = new Map()

  const sweep = () => {
    const deadline = Date.now() - Math.max(intervalMs * 10, 60_000)
    for (const [key, at] of seen) {
      if (at < deadline) seen.delete(key)
    }
  }
  const timer = setInterval(sweep, 60_000)
  timer.unref?.()

  return {
    /**
     * 消费一次。
     * @returns {{ allowed: boolean, retryAfterMs: number }}
     */
    consume(key) {
      if (intervalMs <= 0) return { allowed: true, retryAfterMs: 0 }
      const now = Date.now()
      const last = seen.get(key)
      if (last !== undefined && now - last < intervalMs) {
        return { allowed: false, retryAfterMs: intervalMs - (now - last) }
      }
      seen.set(key, now)
      return { allowed: true, retryAfterMs: 0 }
    },
    stop() {
      clearInterval(timer)
      seen.clear()
    },
  }
}

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
