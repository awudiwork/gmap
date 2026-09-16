/**
 * 本机设置的回归测试：存储清洗与静音名单的增删。
 *
 * localStorage 是用户能直接编辑的，sanitize 是挡在它和界面之间的唯一一道，
 * 漏掉一种坏形状就会在页面上渲染成乱码，或者让看图器算出 NaN 位置。
 *
 * 静音名单这几个函数写的是持久化状态，错一次就是"点了没反应"或者"点反了"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, isMuted, refreshMutedNames, sanitize, settings, toggleMute, unmute } from '../public/js/settings.js'

/* ── 存储清洗 ──────────────────────────────────────── */

test('空输入退回默认值', () => {
  assert.deepEqual(sanitize(null), { ...DEFAULTS, mutedUsers: [], viewAnchor: { u: 0.5, v: 0.5 } })
  assert.deepEqual(sanitize(undefined).mutedUsers, [])
})

test('非对象输入不会让解析崩掉', () => {
  for (const junk of ['字符串', 42, true, [], [1, 2, 3]]) {
    assert.equal(sanitize(junk).autoOpenImages, DEFAULTS.autoOpenImages)
  }
})

test('只认识已知字段，旧版本残留被丢掉', () => {
  const result = sanitize({ autoOpenImages: false, legacyFlag: 'x', theme: 'dark' })
  assert.equal(result.autoOpenImages, false)
  assert.equal('legacyFlag' in result, false)
  assert.equal('theme' in result, false)
})

test('坏掉的锚点退回居中，否则看图器会算出 NaN 位置', () => {
  for (const junk of [null, 'x', {}, { u: 0.5 }, { u: 'a', v: 'b' }, { u: NaN, v: 0.5 }]) {
    assert.deepEqual(sanitize({ viewAnchor: junk }).viewAnchor, { u: 0.5, v: 0.5 })
  }
  // 合法的照原样留下
  assert.deepEqual(sanitize({ viewAnchor: { u: 0.25, v: 0.75 } }).viewAnchor, { u: 0.25, v: 0.75 })
})

test('坏掉的缩放退回 0，也就是"还没记过"', () => {
  for (const junk of [NaN, Infinity, -1, 'big', null]) {
    assert.equal(sanitize({ viewScale: junk }).viewScale, 0)
  }
  assert.equal(sanitize({ viewScale: 2.5 }).viewScale, 2.5)
})

test('静音名单不是数组就丢掉', () => {
  for (const junk of ['x', 42, null, {}]) {
    assert.deepEqual(sanitize({ mutedUsers: junk }).mutedUsers, [])
  }
})

test('静音名单里 id 不是整数的条目被剔除', () => {
  const result = sanitize({
    mutedUsers: [
      { id: 3, name: '游侠' },
      { id: '4', name: '字符串 id' },
      { id: 1.5, name: '小数 id' },
      { name: '没有 id' },
      null,
      '整个不是对象',
    ],
  })
  assert.deepEqual(result.mutedUsers, [{ id: 3, name: '游侠' }])
})

test('名字不是字符串时归一成空串，让面板走"用户 N"的兜底', () => {
  const result = sanitize({ mutedUsers: [{ id: 3, name: { x: 1 } }, { id: 4, name: 42 }, { id: 5 }] })
  assert.deepEqual(result.mutedUsers, [{ id: 3, name: '' }, { id: 4, name: '' }, { id: 5, name: '' }])
})

test('清洗出来的结构化字段不共用默认值的实例', () => {
  // Object.freeze 是浅的，直接摊开 DEFAULTS 会把同一个数组发给每个调用方，
  // 将来谁写一句 push 就会污染整个模块
  const a = sanitize(null)
  const b = sanitize(null)
  assert.notEqual(a.mutedUsers, b.mutedUsers)
  assert.notEqual(a.mutedUsers, DEFAULTS.mutedUsers)
  assert.notEqual(a.viewAnchor, DEFAULTS.viewAnchor)
})

/* ── 静音名单 ──────────────────────────────────────── */

test('开关一个人：来回切换是对称的', () => {
  settings.set({ mutedUsers: [] })
  const ranger = { id: 21, name: '游侠' }

  assert.equal(isMuted(21), false)
  assert.equal(toggleMute(ranger), true, '返回值应当是"切换之后是否被关掉"')
  assert.equal(isMuted(21), true)
  assert.deepEqual(settings.get().mutedUsers, [{ id: 21, name: '游侠' }])

  assert.equal(toggleMute(ranger), false)
  assert.equal(isMuted(21), false)
  assert.deepEqual(settings.get().mutedUsers, [])
})

test('关掉一个人不影响名单上的其他人', () => {
  settings.set({ mutedUsers: [] })
  toggleMute({ id: 21, name: '游侠' })
  toggleMute({ id: 22, name: '侦察兵' })
  assert.equal(settings.get().mutedUsers.length, 2)

  unmute(21)
  assert.deepEqual(settings.get().mutedUsers, [{ id: 22, name: '侦察兵' }])
  assert.equal(isMuted(22), true)
})

test('恢复一个本来就不在名单里的人是安全的', () => {
  settings.set({ mutedUsers: [{ id: 22, name: '侦察兵' }] })
  unmute(999)
  assert.deepEqual(settings.get().mutedUsers, [{ id: 22, name: '侦察兵' }])
})

test('同一个人重复关掉不会在名单里出现两次', () => {
  settings.set({ mutedUsers: [] })
  const scout = { id: 22, name: '侦察兵' }
  toggleMute(scout)
  // 第二次调用走的是取消分支，所以名单会空掉，而不是塞进两条
  toggleMute(scout)
  assert.deepEqual(settings.get().mutedUsers, [])
})

test('对方改了昵称后，静音记录跟着在线名单更新', () => {
  settings.set({ mutedUsers: [{ id: 21, name: '游侠' }] })

  const changed = refreshMutedNames([{ id: 21, name: '夜枭' }])
  assert.equal(changed, true)
  assert.deepEqual(settings.get().mutedUsers, [{ id: 21, name: '夜枭' }])
})

test('名字没变时不写存储，免得触发无谓的重绘', () => {
  settings.set({ mutedUsers: [{ id: 21, name: '游侠' }] })
  assert.equal(refreshMutedNames([{ id: 21, name: '游侠' }]), false)
  assert.equal(refreshMutedNames([]), false, '人不在线时保留旧名字，不当作变化')
})

test('离线的人留在静音名单里，名字保持上次见到的样子', () => {
  settings.set({ mutedUsers: [{ id: 21, name: '游侠' }, { id: 22, name: '侦察兵' }] })
  refreshMutedNames([{ id: 22, name: '侦察兵改名了' }])
  assert.deepEqual(settings.get().mutedUsers, [
    { id: 21, name: '游侠' },
    { id: 22, name: '侦察兵改名了' },
  ])
})
