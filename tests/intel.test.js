/**
 * 情报面板的回归测试：服务端的数据压缩，和三个视图在 happy-dom 里的渲染。
 *
 * 服务器状态的原始数据 2 MB，页面拿到的是几 KB 的汇总；这里用一份手搓的小清单
 * 验汇总算得对，再把汇总喂给视图看它画不画得出来、点得动不动。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const window = new Window({ url: 'http://localhost/' })
for (const key of ['document', 'HTMLElement', 'Node', 'location', 'history', 'localStorage', 'MutationObserver', 'SVGElement']) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.window = window

const { compactServer, describeMatch, slimProgression, summarizeStatus } = await import('../server/services/intel.service.js')
const { buildMarketView, buildStatusView, buildXpView, buildZoneView, zoneName } = await import('../public/js/wardogs/intel.js')

const server = (zone, players, max, experience, extra = {}) => ({
  id: `${zone}-${players}`, number: players, zone, official: true, passworded: false, players, max,
  attributes: { Experience: `str:${experience}`, Sky: 'str:DayClear', MAPNAME: 'str:Kavkazi' },
  ...extra,
})

const RAW_STATUS = {
  fetched_at: 1_800_000_000_000,
  regions: [{ region: 'asia-east', servers: 2 }, { region: 'eu-west', servers: 1 }, { region: 'asia-southeast', servers: 0 }],
  servers: [
    server('asia-east', 100, 100, 'Bakurani_KOTH_01'),
    server('asia-east', 40, 100, 'Madrid_KOTH_01+KOTH_Hardcore', { passworded: true }),
    server('eu-west', 10, 60, 'Detroit_KOTH_01+KOTH_InfantryOnly', { official: false }),
  ],
  totals: { players: 150, capacity: 260, servers: 3, queued: 0 },
  matchmaking_available: false,
}

test('服务器汇总：各区、各图人数按清单累加，没有服务器的区也列出来', () => {
  const summary = summarizeStatus(RAW_STATUS, 123)
  assert.equal(summary.steamPlayers, 123)
  assert.deepEqual(summary.totals, { players: 150, capacity: 260, servers: 3, queued: 0 })

  const asia = summary.zones.find((zone) => zone.id === 'asia-east')
  assert.deepEqual(asia, { id: 'asia-east', servers: 2, players: 140, capacity: 200 })
  assert.deepEqual(summary.zones.find((zone) => zone.id === 'asia-southeast'), { id: 'asia-southeast', servers: 0, players: 0, capacity: 0 })
  assert.equal(summary.zones[0].id, 'asia-east', '按在线人数倒序')

  assert.deepEqual(summary.maps.map((item) => [item.map, item.players]), [['Bakurani', 100], ['Madrid', 40], ['Detroit', 10]])
})

test('地图与变体从 Experience 字段解析', () => {
  assert.deepEqual(describeMatch(server('x', 0, 0, 'Madrid_KOTH_01+KOTH_Hardcore')), { map: 'Madrid', variants: ['Hardcore'] })
  assert.deepEqual(describeMatch(server('x', 0, 0, 'Bakurani_KOTH_01')), { map: 'Bakurani', variants: [] })
  assert.equal(describeMatch({ attributes: { MAPNAME: 'str:Kavkazi' } }).map, 'Kavkazi', '没有 Experience 时退回 MAPNAME')
  assert.equal(describeMatch({}).map, '未知')
})

test('压缩后的服务器只剩页面要的字段，类型前缀被去掉', () => {
  const compact = compactServer(RAW_STATUS.servers[1])
  assert.deepEqual(compact, {
    id: 'asia-east-40', number: 40, zone: 'asia-east', official: true, passworded: true,
    players: 40, max: 100, map: 'Madrid', variants: ['Hardcore'], sky: 'DayClear',
  })
})

test('进度表精简：奖励取 base 与条件上限，缺的字段变成 null', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'assets', 'wardogs', 'progression.json'), 'utf8'))
  const slim = slimProgression(raw)
  assert.equal(slim.roles.length, 6)
  assert.equal(slim.roles[0].levels.length, 101)
  assert.ok(slim.unlocks.length > 100)
  const kill = slim.actions.find((action) => action.label === 'Kill an enemy')
  assert.deepEqual(kill.xp, { base: 250, max: 350, decay: { perRepeat: 0.24, maxRepeats: 4 } })
  for (const action of slim.actions) {
    assert.ok(action.xp.base === null || Number.isFinite(action.xp.base), `${action.label} 的 XP 不是数字也不是 null`)
    assert.ok(typeof action.label === 'string' && action.label.length > 0)
  }
  assert.ok(!('curves' in slim) && !('xpItems' in slim), '面板用不到的大字段不下发')
})

test('服务器状态视图：大区分组、点区触发回调', () => {
  const summary = summarizeStatus(RAW_STATUS, null)
  const picked = []
  const view = buildStatusView({ ...summary, fetchedAt: Date.now(), source: 'upstream' }, { onZone: (zone) => picked.push(zone) })
  document.body.append(view)
  assert.ok(view.textContent.includes('亚洲东'))
  assert.ok(view.textContent.includes('暂时拿不到'), 'Steam 人数拿不到时要说明')
  assert.ok(view.textContent.includes('Bakurani'))
  view.querySelector('.it-zone').click()
  assert.deepEqual(picked, ['asia-east'])
  assert.equal(zoneName('na-east'), '北美东')
  assert.equal(zoneName('mars'), 'mars', '认不出的区原样显示')
  view.remove()
})

test('区清单视图：官方、密码、变体和天气都有中文标记，返回按钮可用', () => {
  const servers = RAW_STATUS.servers.filter((item) => item.zone === 'asia-east').map(compactServer)
  let back = 0
  const view = buildZoneView({ zone: 'asia-east', servers }, { onBack: () => { back += 1 } })
  document.body.append(view)
  assert.ok(view.textContent.includes('官方'))
  assert.ok(view.textContent.includes('硬核'))
  assert.ok(view.textContent.includes('白天晴'))
  assert.ok(view.querySelector('.it-lock'), '密码服要有锁图标')
  view.querySelector('button').click()
  assert.equal(back, 1)
  view.remove()

  const empty = buildZoneView({ zone: 'asia-southeast', servers: [] }, { onBack: () => {} })
  assert.ok(empty.textContent.includes('没有服务器'))
})

test('金条视图：现价、涨跌和折线都画出来，切换区间触发回调', () => {
  const points = Array.from({ length: 120 }, (_, index) => [1_700_000_000_000 + index * 86_400_000, 300_000 + index * 1000])
  const market = {
    source: 'upstream', fetchedAt: Date.now(), updatedAt: Date.now(),
    stats: { current: 419_000, min: 300_000, max: 419_000, changes: { '7d': 0.017, '30d': -0.02, '90d': 0.3, '1y': 0.39, all: 0.39 } },
    points,
  }
  const ranges = []
  const view = buildMarketView(market, { range: '30', onRange: (range) => ranges.push(range) })
  document.body.append(view)
  assert.ok(view.textContent.includes('$419,000'))
  assert.ok(view.textContent.includes('+1.7%'))
  assert.ok(view.textContent.includes('-2.0%'))
  assert.ok(view.querySelector('.it-spark path.line').getAttribute('d').startsWith('M'))
  const buttons = view.querySelectorAll('.pick button')
  assert.equal(buttons[0].className, 'on')
  buttons[2].click()
  assert.deepEqual(ranges, ['all'])
  view.remove()
})

test('进度视图：等级表带解锁，行动奖励可按分组过滤', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'assets', 'wardogs', 'progression.json'), 'utf8'))
  const progression = slimProgression(raw)
  const changes = []
  const levels = buildXpView(progression, { role: 'driver', section: 'levels', group: null }, (patch) => changes.push(patch))
  document.body.append(levels)
  assert.equal(levels.querySelectorAll('.it-levels tbody tr').length, 100, '1 到 100 级')
  assert.ok(levels.textContent.includes('URAL'), '驾驶员 3 级解锁 URAL')
  levels.querySelectorAll('.pick')[1].querySelectorAll('button')[1].click()
  assert.deepEqual(changes, [{ section: 'actions' }])
  levels.remove()

  const actions = buildXpView(progression, { role: 'driver', section: 'actions', group: 'Combat' }, () => {})
  document.body.append(actions)
  const rows = actions.querySelectorAll('tbody tr')
  assert.ok(rows.length > 0 && rows.length < 40, '只剩战斗分组')
  assert.ok(actions.textContent.includes('Kill an enemy'))
  assert.ok(actions.textContent.includes('每次 -24%'))
  actions.remove()
})
