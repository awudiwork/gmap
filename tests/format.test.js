/**
 * 界面格式化函数的回归测试。这些都是纯函数，边界（刚好 60 秒、整小时、跨天）容易写错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatAge, formatSize } from '../public/js/ui.js'

const NOW = 1_800_000_000_000
const ago = (seconds) => NOW - seconds * 1000

test('一分钟内按秒', () => {
  assert.equal(formatAge(ago(0), NOW), '0 秒前')
  assert.equal(formatAge(ago(12), NOW), '12 秒前')
  assert.equal(formatAge(ago(59), NOW), '59 秒前')
})

test('一小时内按分钟', () => {
  assert.equal(formatAge(ago(60), NOW), '1 分钟前')
  assert.equal(formatAge(ago(59 * 60 + 59), NOW), '59 分钟前')
})

test('一天内按小时加分钟，整点不写零分', () => {
  assert.equal(formatAge(ago(3600), NOW), '1 小时前')
  assert.equal(formatAge(ago(3600 * 2 + 60 * 7), NOW), '2 小时 7 分前')
  assert.equal(formatAge(ago(3600 * 23 + 60 * 59), NOW), '23 小时 59 分前')
})

test('超过一天按天加小时', () => {
  assert.equal(formatAge(ago(86400), NOW), '1 天前')
  assert.equal(formatAge(ago(86400 * 3 + 3600 * 5), NOW), '3 天 5 小时前')
})

test('时钟倒退时不出负数', () => {
  assert.equal(formatAge(NOW + 5000, NOW), '0 秒前')
})

test('文件大小', () => {
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(2048), '2.0 KB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB')
  assert.equal(formatSize(-1), '未知大小')
})
