/**
 * 自动展开判定的回归测试。
 *
 * 这个判断有四个分支、三个开关，组合起来的漏判很难靠肉眼发现：
 * 少弹一张图是"怎么没反应"，多弹一张是"又跳出来打断我"，两种都很恼人。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { decideAutoOpen, DEFAULTS } from '../public/js/settings.js'

const ME = 7
const OTHER = 9

// 直接用真实默认值，默认一改测试就会跟着反映出来
const defaults = { ...DEFAULTS }

/** 造一条图片消息 */
const image = ({ from = OTHER, source = 'api', url = '/api/files/1', room = 'all' } = {}) => ({
  kind: 'file',
  room,
  source,
  user: { id: from },
  file: { category: 'image', url },
})

const decide = (message, patch = {}) =>
  decideAutoOpen({ message, meId: ME, config: { ...defaults, ...patch } })

/** 带上"我现在在哪个频道"再判断 */
const decideIn = (currentRoom, message, patch = {}) =>
  decideAutoOpen({ message, meId: ME, currentRoom, config: { ...defaults, ...patch } })

test('队友用客户端推的图会展开', () => {
  assert.equal(decide(image()), true)
})

test('开箱默认：只展开队友推的，自己推的不弹', () => {
  assert.equal(DEFAULTS.autoOpenImages, true)
  assert.equal(DEFAULTS.autoOpenSource, 'api')
  assert.equal(DEFAULTS.autoOpenOwnPush, false)

  assert.equal(decide(image({ from: OTHER, source: 'api' })), true)
  assert.equal(decide(image({ from: ME, source: 'api' })), false)
})

test('总开关关掉后什么都不展开', () => {
  assert.equal(decide(image(), { autoOpenImages: false }), false)
})

test('默认只认 API 来源，网页里发的图不展开', () => {
  assert.equal(decide(image({ source: 'web' })), false)
})

test('切到全部来源后，网页里发的图也展开', () => {
  assert.equal(decide(image({ source: 'web' }), { autoOpenSource: 'all' }), true)
})

test('自己在网页里发的图永远不展开，哪怕来源设成了全部', () => {
  // 刚拖进去就在眼前，再弹一次是打扰。这条没有开关。
  // 两个用例都必须把来源开到 all，否则会在来源过滤那一步就被挡掉，
  // 根本走不到这里要验的那条规则上，删掉那行代码测试也照样绿
  assert.equal(decide(image({ from: ME, source: 'web' }), { autoOpenSource: 'all' }), false)
  assert.equal(
    decide(image({ from: ME, source: 'web' }), { autoOpenSource: 'all', autoOpenOwnPush: true }),
    false,
  )
})

test('自己从客户端推的图，开关开着就展开', () => {
  assert.equal(decide(image({ from: ME, source: 'api' }), { autoOpenOwnPush: true }), true)
})

test('自己从客户端推的图，开关关掉就不展开', () => {
  assert.equal(decide(image({ from: ME, source: 'api' }), { autoOpenOwnPush: false }), false)
})

test('关掉自己推送的开关，不影响队友推的图', () => {
  assert.equal(decide(image({ from: OTHER, source: 'api' }), { autoOpenOwnPush: false }), true)
})

test('非图片附件不展开', () => {
  const video = { kind: 'file', source: 'api', user: { id: OTHER }, file: { category: 'video', url: '/api/files/2' } }
  assert.equal(decide(video), false)

  const binary = { kind: 'file', source: 'api', user: { id: OTHER }, file: { category: 'file', url: '/api/files/3' } }
  assert.equal(decide(binary), false)
})

test('文字和代码消息不展开', () => {
  assert.equal(decide({ kind: 'text', source: 'web', user: { id: OTHER }, body: 'x' }), false)
  assert.equal(decide({ kind: 'code', source: 'api', user: { id: OTHER }, body: 'x' }), false)
})

test('已过保留期、没有地址的图不展开', () => {
  assert.equal(decide(image({ url: null })), false)
  assert.equal(decide({ kind: 'file', source: 'api', user: { id: OTHER }, file: null }), false)
})

test('单独关掉的人推的图不展开', () => {
  const muted = { mutedUsers: [{ id: OTHER, name: '游侠' }] }
  assert.equal(decide(image({ from: OTHER })), true)
  assert.equal(decide(image({ from: OTHER }), muted), false)
})

test('关掉一个人不影响其他人', () => {
  const third = 11
  const muted = { mutedUsers: [{ id: OTHER, name: '游侠' }] }
  assert.equal(decide(image({ from: third }), muted), true)
})

test('来源开到全部时，被关掉的人两种来源都不弹', () => {
  const config = { autoOpenSource: 'all', mutedUsers: [{ id: OTHER, name: '游侠' }] }
  assert.equal(decide(image({ from: OTHER, source: 'web' }), config), false)
  assert.equal(decide(image({ from: OTHER, source: 'api' }), config), false)
})

test('默认没有人被关掉', () => {
  assert.deepEqual(DEFAULTS.mutedUsers, [])
})

test('只展开当前所在频道的图', () => {
  assert.equal(decideIn('wardogs', image({ room: 'wardogs' })), true)
  assert.equal(decideIn('wardogs', image({ room: 'all' })), false, '别的频道的图不该抢过来占满屏幕')
  assert.equal(decideIn('all', image({ room: 'wardogs' })), false)
})

test('频道判断排在最前，别的条件再宽也盖不过它', () => {
  const loose = { autoOpenSource: 'all', autoOpenOwnPush: true }
  assert.equal(decideIn('all', image({ room: 'wardogs', from: ME, source: 'api' }), loose), false)
})

test('不传当前频道时跳过这条规则', () => {
  // 供其它用例单独验证别的规则，不必每次都编一个频道
  assert.equal(decide(image({ room: 'wardogs' })), true)
})
