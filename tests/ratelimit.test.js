/**
 * 限流的回归测试。
 *
 * 两种闸各管各的：节流防"热键按住不放一秒连发十张"，
 * 窗口计数防"一分钟内持续刷几十张"。调错一个，要么挡不住刷屏，
 * 要么把正常使用的人锁在门外，两种都很难从日志里看出来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter, createThrottle } from '../server/lib/ratelimit.js'

/* ── 最小间隔节流 ──────────────────────────────────── */

test('间隔内的第二次被挡下，并给出还要等多久', () => {
  const throttle = createThrottle({ intervalMs: 1000 })
  assert.equal(throttle.consume('k').allowed, true)

  const second = throttle.consume('k')
  assert.equal(second.allowed, false)
  assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= 1000)
  throttle.stop()
})

test('间隔过去之后放行', async () => {
  const throttle = createThrottle({ intervalMs: 40 })
  assert.equal(throttle.consume('k').allowed, true)
  assert.equal(throttle.consume('k').allowed, false)

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(throttle.consume('k').allowed, true, '等够了就该放行')
  throttle.stop()
})

test('不同的 key 互不影响', () => {
  const throttle = createThrottle({ intervalMs: 1000 })
  assert.equal(throttle.consume('a').allowed, true)
  assert.equal(throttle.consume('b').allowed, true, '另一个客户端不该被别人的节奏拖累')
  assert.equal(throttle.consume('a').allowed, false)
  throttle.stop()
})

test('间隔设为 0 就是不限制', () => {
  const throttle = createThrottle({ intervalMs: 0 })
  for (let i = 0; i < 50; i += 1) {
    assert.equal(throttle.consume('k').allowed, true)
  }
  throttle.stop()
})

test('被挡下的那次不刷新计时，否则连按会把自己永远锁在门外', async () => {
  const throttle = createThrottle({ intervalMs: 50 })
  throttle.consume('k')
  // 在间隔内疯狂重试
  for (let i = 0; i < 10; i += 1) throttle.consume('k')

  await new Promise((resolve) => setTimeout(resolve, 70))
  assert.equal(throttle.consume('k').allowed, true, '从第一次通过算起满 50ms 就该放行')
  throttle.stop()
})

/* ── 固定窗口计数 ──────────────────────────────────── */

test('窗口内用满配额后被挡', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 3 })
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.consume('k').allowed, true, `第 ${i + 1} 次应当放行`)
  }
  const blocked = limiter.consume('k')
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfterMs > 0)
  limiter.stop()
})

test('窗口过去后配额重置', async () => {
  const limiter = createRateLimiter({ windowMs: 40, max: 1 })
  assert.equal(limiter.consume('k').allowed, true)
  assert.equal(limiter.consume('k').allowed, false)

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(limiter.consume('k').allowed, true)
  limiter.stop()
})

test('reset 立刻还回配额，登录成功后用得上', () => {
  const limiter = createRateLimiter({ windowMs: 10_000, max: 1 })
  limiter.consume('ip')
  assert.equal(limiter.consume('ip').allowed, false)

  limiter.reset('ip')
  assert.equal(limiter.consume('ip').allowed, true)
  limiter.stop()
})

test('不同的 key 各有各的配额', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1 })
  assert.equal(limiter.consume('a').allowed, true)
  assert.equal(limiter.consume('b').allowed, true)
  assert.equal(limiter.consume('a').allowed, false)
  limiter.stop()
})
