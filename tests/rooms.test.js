/**
 * 房间清单的回归测试。
 *
 * 房间 id 会写进数据库，改一次就会让历史消息落到一个不存在的房间里，
 * 所以这里把清单的形状钉死，也顺带校验图标文件真的在仓库里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ROOM, isRoom, normalizeRoom, ROOMS, TOOL_IDS } from '../server/lib/rooms.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('每个房间的 id 都合法且不重复', () => {
  const ids = ROOMS.map((room) => room.id)
  assert.deepEqual(ids, [...new Set(ids)], 'id 不能重复')
  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]{1,32}$/, `${id} 会进数据库和查询串，只允许小写字母数字和连字符`)
  }
})

test('每个房间都有名字和短标记', () => {
  for (const room of ROOMS) {
    assert.ok(room.name && typeof room.name === 'string', `${room.id} 缺名字`)
    assert.ok(room.short && room.short.length <= 4, `${room.id} 的短标记要短到能塞进图标位`)
  }
})

test('默认房间在清单里', () => {
  assert.ok(isRoom(DEFAULT_ROOM))
  assert.equal(ROOMS[0].id, DEFAULT_ROOM, '默认房间应当排在最前，界面上它是第一个')
})

test('声明了图标的房间，图标文件真的存在', () => {
  for (const room of ROOMS.filter((item) => item.icon)) {
    assert.match(room.icon, /^\//, `${room.id} 的图标要用站内绝对路径，不能外链`)
    const file = path.join(ROOT, 'public', room.icon)
    assert.ok(fs.existsSync(file), `${room.id} 的图标文件不存在：${room.icon}`)
    assert.ok(fs.statSync(file).size > 0, `${room.id} 的图标是空文件`)
  }
})

test('每个房间挂的工具都是前端认识的', () => {
  // 清单里写了个前端没有的工具 id，标题栏上只会静静地少一个按钮，没人会发现
  const known = new Set(TOOL_IDS)
  for (const room of ROOMS) {
    assert.ok(Array.isArray(room.tools), `${room.id} 的 tools 必须是数组，没有工具就给空数组`)
    for (const tool of room.tools) assert.ok(known.has(tool), `${room.id} 挂了前端不认识的工具 ${tool}`)
  }
  assert.ok(ROOMS.find((room) => room.id === 'wardogs').tools.includes('ballistics'))
})

test('认不出来的房间落到默认房间，而不是报错', () => {
  // 老版本客户端可能传个陌生的房间，把图推丢比推错地方更糟
  for (const junk of ['不存在的房间', '', null, undefined, 42, {}, 'ALL']) {
    assert.equal(normalizeRoom(junk), DEFAULT_ROOM)
  }
})

test('认识的房间原样保留', () => {
  for (const room of ROOMS) {
    assert.equal(normalizeRoom(room.id), room.id)
  }
})

test('isRoom 只认字符串', () => {
  assert.equal(isRoom('all'), true)
  assert.equal(isRoom('wardogs'), true)
  assert.equal(isRoom('nope'), false)
  assert.equal(isRoom(null), false)
  assert.equal(isRoom(undefined), false)
})

test('清单连同每一项都是冻结的，运行期改不动', () => {
  // Object.freeze 是浅的。只冻数组的话元素照样可改，
  // 而这个对象会被直接 res.json 出去，改一次影响所有客户端
  assert.equal(Object.isFrozen(ROOMS), true)
  for (const room of ROOMS) {
    assert.equal(Object.isFrozen(room), true, `${room.id} 这一项没冻上`)
  }
})
