/**
 * 伤害计算引擎的回归测试。
 *
 * 基准数字取自原站（metaforge.app/wardogs/ballistics）默认视图的服务端渲染结果：
 * M4 / AK74 / MP5 / SVD，二级护甲与头盔，上躯干，标准弹，50 米。
 * 引擎是逐条移植的，这些数字对不上就说明某一步的公式抄错了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SHOT_BANDS, TIME_BANDS, armourIdFor, assignColours, calibrateTimeBands, combos, falloffAt, flightTimeMs,
  formatNumber, formatShots, formatTime, ladder, ranked, shotBand, solve, solvedCombos, timeBand, usableWeapons,
} from '../public/js/ballistics/engine.js'
import { parseState, serializeState } from '../public/js/ballistics/state.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'assets', 'wardogs', 'ballistics.json'), 'utf8'))

const weapon = (slug) => data.weapons.find((item) => item.slug === slug)

/** 原站默认交战条件 */
const DEFAULT = {
  armour: armourIdFor(data, 'armor', 2),
  helmet: armourIdFor(data, 'helmet', 2),
  hit: 'torso_upper',
  round: 'FMJ',
  range: 50,
}

test('快照数据包含引擎依赖的全部字段', () => {
  assert.equal(data.assumedHealth, 100)
  assert.ok(usableWeapons(data).length >= 20)
  assert.ok(data.hitLocations.some((zone) => zone.key === 'torso_upper'))
  assert.equal(ladder(data).length, 5, '无甲 + 四级')
})

test('默认视图四把枪的数字和原站一致', () => {
  // 原站页面：SVD 3 发 0.31s 每发 47；M4 6 发 0.43s 每发 18；AK74 6 发 0.52s 每发 17；MP5 7 发 0.59s 每发 15
  const expect = {
    svd: { shots: 3, time: '0.31', damage: 47, strip: 10 },
    m4: { shots: 6, time: '0.43', damage: 18, strip: 20 },
    ak74: { shots: 6, time: '0.52', damage: 17, strip: 22 },
    mp5: { shots: 7, time: '0.59', damage: 15, strip: 25 },
  }
  for (const [slug, want] of Object.entries(expect)) {
    const sol = solve(data, weapon(slug), DEFAULT)
    assert.equal(sol.shots, want.shots, `${slug} 弹数`)
    assert.equal((sol.time / 1000).toFixed(2), want.time, `${slug} 击杀时间`)
    assert.equal(Math.round(sol.damage), want.damage, `${slug} 每发伤害`)
    assert.equal(sol.plateBreaksAt, null, `${slug} 二级甲应当撑到击杀结束`)
    assert.equal(sol.plateShots, want.strip, `${slug} 磨穿护甲要的发数`)
    assert.equal(sol.stoppedBy?.name, 'Level 2 Armor')
  }
})

test('表格各护甲等级的弹数与时间和原站一致', () => {
  // 原站表格（上躯干、标准弹、50 米），列依次是无甲、一到四级
  const rows = {
    'amr-50': [[1, '0.06'], [1, '0.06'], [1, '0.06'], [2, '1.50'], [2, '1.50']],
    'bmr-308': [[2, '0.19'], [2, '0.19'], [2, '0.19'], [3, '0.32'], [4, '0.46']],
    'mosin-nagant': [[1, '0.06'], [2, '1.36'], [2, '1.36'], [3, '2.67'], [3, '2.67']],
  }
  const steps = ladder(data)
  for (const [slug, cells] of Object.entries(rows)) {
    cells.forEach(([shots, time], index) => {
      const step = steps[index]
      const sol = solve(data, weapon(slug), { ...DEFAULT, armour: step.armour, helmet: step.helmet })
      assert.equal(sol.shots, shots, `${slug} 对 ${step.level} 级的弹数`)
      assert.equal((sol.time / 1000).toFixed(2), time, `${slug} 对 ${step.level} 级的时间`)
    })
  }
})

test('排名按击杀时间，和原站的名次一致', () => {
  const picked = ['m4', 'ak74', 'mp5', 'svd'].map(weapon)
  const colours = assignColours(['m4', 'ak74', 'mp5', 'svd'], {})
  const order = ranked(solvedCombos(data, picked, ['FMJ'], DEFAULT, colours)).map((row) => row.slug)
  assert.deepEqual(order, ['svd', 'm4', 'ak74', 'mp5'])
})

test('无甲时弹数就是血量除以每发伤害向上取整', () => {
  const sol = solve(data, weapon('m4'), { ...DEFAULT, armour: null, helmet: null })
  assert.equal(sol.stoppedBy, null)
  assert.equal(sol.shots, Math.ceil(100 / sol.damage))
  assert.equal(sol.plateShots, null)
})

test('头盔只挡头部，打躯干时头盔不起作用', () => {
  const helmetOnly = { ...DEFAULT, armour: null }
  assert.equal(solve(data, weapon('m4'), helmetOnly).stoppedBy, null)
  assert.equal(solve(data, weapon('m4'), { ...helmetOnly, hit: 'head' }).stoppedBy?.slot, 'helmet')
})

test('护甲会被磨穿：打穿之后的每发按无甲算', () => {
  // 一级甲 200 耐久，M4 标准弹每发磨 28x0.4=11.2，第 18 发磨穿。头部被头盔挡，用手枪打躯干凑弹数
  const sol = solve(data, weapon('m1911'), {
    ...DEFAULT, armour: armourIdFor(data, 'armor', 4), helmet: null,
  })
  assert.ok(Number.isFinite(sol.shots))
  if (sol.plateBreaksAt !== null) {
    assert.ok(sol.plateBreaksAt < sol.shots, '磨穿发生在击杀之前')
    assert.ok(sol.factors.after > sol.damage, '磨穿后的每发伤害高于穿甲伤害')
  }
})

test('不卖的弹种退回标准弹并打上标记', () => {
  // .50 口径只卖标准弹
  const sol = solve(data, weapon('amr-50'), { ...DEFAULT, round: 'HollowPoint' })
  assert.equal(sol.roundUnavailable, true)
  assert.equal(sol.factors.round, 'FMJ')
  assert.equal(sol.damage, solve(data, weapon('amr-50'), DEFAULT).damage)

  // 没写 loads 的口径（12g 独头弹）视为只有标准弹，但不算"不卖"
  const slug = solve(data, weapon('m500'), { ...DEFAULT, shell: '12g.RifledSlug', round: 'HollowPoint' })
  assert.equal(slug.roundUnavailable, false)
})

test('打不死的情况返回无穷弹数，而不是死循环', () => {
  const bow = weapon('compound-bow')
  const sol = solve(data, bow, { ...DEFAULT, hit: 'arm_hand', armour: armourIdFor(data, 'armor', 4) })
  assert.ok(Number.isFinite(sol.shots) || sol.shots === Infinity)
  assert.equal(formatShots(Infinity), '∞')
  assert.equal(formatTime(Infinity), '∞')
})

test('距离衰减：曲线外取端点，节点之间线性插值', () => {
  const curve = [[0, 1, 0, 0, 0], [500, 1, 0, 0, 0], [1200, 0.2, 0, 0, 0]]
  assert.equal(falloffAt(curve, 0), 1)
  assert.equal(falloffAt(curve, 300), 1)
  assert.equal(falloffAt(curve, 5000), 0.2)
  assert.ok(Math.abs(falloffAt(curve, 850) - 0.6) < 1e-9)
  assert.equal(falloffAt([], 100), 1, '没有曲线就是不衰减')
})

test('飞行时间随距离单调增加，且零距离为零', () => {
  const m4 = weapon('m4')
  const calibre = data.calibres[m4.calibre]
  assert.equal(flightTimeMs(data, m4, m4.calibre, calibre, 0), 0)
  const t100 = flightTimeMs(data, m4, m4.calibre, calibre, 100)
  const t400 = flightTimeMs(data, m4, m4.calibre, calibre, 400)
  assert.ok(t100 > 100 && t100 < 200, `100 米大约 110 毫秒，实际 ${t100}`)
  assert.ok(t400 > t100 * 3, '远处减速，时间超线性增长')
  assert.equal(flightTimeMs(data, m4, m4.calibre, calibre, 5000), flightTimeMs(data, m4, m4.calibre, calibre, 2000), '超出表长按 2000 米算')
})

test('弹数分档的阈值', () => {
  assert.equal(shotBand(1).label, '一枪毙命')
  assert.equal(shotBand(2).label, '很有效')
  assert.equal(shotBand(4).label, '有效')
  assert.equal(shotBand(8).label, '略有效')
  assert.equal(shotBand(12).label, '只能倾泻')
  assert.equal(shotBand(19).label, '绝望')
  assert.equal(shotBand(20).label, '无效')
  assert.equal(shotBand(Infinity).label, '无效')
  assert.equal(SHOT_BANDS.length, 7)
})

test('时间分档标定后阈值单调递减，且区间文案跟着更新', () => {
  calibrateTimeBands(data)
  for (let i = 1; i < TIME_BANDS.length; i += 1) {
    assert.ok(TIME_BANDS[i].min < TIME_BANDS[i - 1].min, `第 ${i} 档阈值应低于上一档`)
  }
  assert.equal(TIME_BANDS[6].min, 0)
  assert.match(TIME_BANDS[0].range, /s 以上$/)
  assert.match(TIME_BANDS[6].range, /s 以内$/)
  assert.equal(timeBand(0).label, '瞬杀')
  assert.equal(timeBand(Infinity).label, '无效')
  assert.equal(timeBand(TIME_BANDS[0].min + 1).label, '无效')
})

test('颜色分配稳定：去掉一把枪不会让其它枪换色', () => {
  const first = assignColours(['m4', 'ak74', 'mp5'], {})
  const second = assignColours(['m4', 'mp5', 'svd'], first)
  assert.equal(second.m4, first.m4)
  assert.equal(second.mp5, first.mp5)
  assert.notEqual(second.svd, first.m4)
  assert.notEqual(second.svd, first.mp5)
})

test('组合展开：不卖所选弹种的枪只出它自己的弹', () => {
  const rows = combos(data, [weapon('m4'), weapon('compound-bow')], ['HollowPoint'], DEFAULT, { m4: '#000', 'compound-bow': '#111' })
  const bow = rows.filter((row) => row.slug === 'compound-bow')
  assert.equal(bow.length, 1)
  assert.equal(bow[0].standard, true)
  assert.equal(rows.find((row) => row.slug === 'm4').round, 'HollowPoint')
})

test('格式化数字去掉尾零', () => {
  assert.equal(formatNumber(28), '28')
  assert.equal(formatNumber(11.2, 1), '11.2')
  assert.equal(formatNumber(11.0001, 1), '11')
})

test('查询串解析：空串给默认视图，别名和大小写都认', () => {
  const state = parseState(data, new URLSearchParams(''))
  assert.deepEqual(state.selected, ['m4', 'ak74', 'mp5', 'svd'])
  assert.equal(state.engagement.range, 50)
  assert.equal(state.engagement.hit, 'torso_upper')
  assert.equal(state.engagement.armour, armourIdFor(data, 'armor', 2))
  assert.equal(state.isDefaultView, true)

  const aliased = parseState(data, new URLSearchParams('view=ttk&round=hp,ap&armour=0&range=200'))
  assert.equal(aliased.view, 'range')
  assert.equal(aliased.metric, 'time')
  assert.deepEqual(aliased.loads, ['HollowPoint', 'ArmorPiercing'])
  assert.equal(aliased.engagement.armour, null)
  assert.equal(aliased.engagement.range, 200)
  assert.equal(aliased.isDefaultView, false)
})

test('查询串解析：坏值退回默认而不是报错', () => {
  const state = parseState(data, new URLSearchParams('w=不存在,m4&hit=nowhere&range=-5&armour=9&view=xx&metric=yy'))
  assert.deepEqual(state.selected, ['m4'])
  assert.equal(state.engagement.hit, 'torso_upper')
  assert.equal(state.engagement.range, 50)
  assert.equal(state.engagement.armour, armourIdFor(data, 'armor', 2))
  assert.equal(state.view, 'table')
  assert.equal(state.metric, 'shots')
  assert.deepEqual(parseState(data, new URLSearchParams('w=')).selected, [], 'w 显式为空表示一把都不选')
})

test('序列化只写非默认项，来回一致', () => {
  const state = parseState(data, new URLSearchParams(''))
  assert.equal(serializeState(data, state), 'w=m4,ak74,mp5,svd')

  const query = 'w=svd&armour=4&helmet=0&hit=head&round=FMJ,AP&range=300&view=compare&metric=time&scope=picked'
  const parsed = parseState(data, new URLSearchParams(query))
  assert.equal(serializeState(data, parsed), query)
})
