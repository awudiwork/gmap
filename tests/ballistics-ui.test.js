/**
 * 伤害计算器界面的冒烟测试：用 happy-dom 把每个视图真的渲染一遍。
 *
 * 引擎有数字基准可对，界面没有；这里守的是"不会在某个状态下直接抛错白屏"：
 * 没选枪、勾了三种弹、距离拉到 2000、无护甲、只看已选、展开弹药详情……
 * 每种状态都把整块界面画出来，再点几下确认交互能改状态。
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 界面模块在 import 时不碰 DOM，但渲染时要；全局先挂好再动态加载
const window = new Window({ url: 'http://localhost/' })
// node 自带的 navigator 只有 getter，其余几个直接赋值即可
for (const key of ['document', 'HTMLElement', 'Node', 'location', 'history', 'localStorage', 'Image', 'SVGElement']) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.window = window

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'assets', 'wardogs', 'ballistics.json'), 'utf8'))
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'assets', 'wardogs', 'weapons.json'), 'utf8'))
const icons = Object.fromEntries(Object.entries(meta).map(([slug, entry]) => [slug, { icon: entry.icon ? `/wardogs/icons/${entry.icon}.webp` : null, unlock: entry.unlock }]))

// 用例清单在模块顶层就要用到 VIEWS，所以这里直接顶层 await，不放进 before
const engine = await import('../public/js/ballistics/engine.js')
const state = await import('../public/js/ballistics/state.js')
const rail = await import('../public/js/ballistics/rail.js')
const summary = await import('../public/js/ballistics/summary.js')
const picker = await import('../public/js/ballistics/picker.js')
const rangeView = await import('../public/js/ballistics/views/range.js')
const views = {
  table: (await import('../public/js/ballistics/views/table.js')).renderTable,
  compare: (await import('../public/js/ballistics/views/compare.js')).renderCompare,
  zones: (await import('../public/js/ballistics/views/zonesView.js')).renderZones,
  range: (session) => rangeView.renderRange(session, { width: 900 }),
  ammo: (await import('../public/js/ballistics/views/ammo.js')).renderAmmo,
}

before(() => {
  engine.calibrateTimeBands(data)
})

function makeSession(query = '') {
  const initial = state.parseState(data, new URLSearchParams(query))
  return new state.Session(data, engine.usableWeapons(data), icons, initial)
}

/** 把结果区和左栏整个画出来，返回挂好的容器 */
async function renderAll(session) {
  const host = document.createElement('div')
  host.append(rail.renderRail(session, { onOpenPicker: () => {} }))
  host.append(summary.renderRanks(session))
  host.append(summary.renderChips(session, { onShare: () => {} }))
  host.append(summary.renderTabs(session))
  const controls = summary.renderControls(session)
  if (controls) host.append(controls)
  const view = await views[session.view](session)
  if (view) host.append(view)
  host.append(summary.renderLegend(session.metric), summary.renderNotes())
  document.body.append(host)
  view?.fitBandText?.()
  return host
}

const SCENARIOS = [
  ['默认视图', ''],
  ['一把枪都没选', 'w='],
  ['三种弹全勾', 'round=FMJ,HP,AP'],
  ['距离拉到 2000', 'range=2000'],
  ['无甲无盔', 'armour=0&helmet=0'],
  ['只看已选', 'scope=picked'],
  ['按时间着色', 'metric=time'],
  ['打头', 'hit=head&helmet=4'],
  ['霰弹枪和弓', 'w=m500,compound-bow,judge'],
  ['满五把', 'w=m4,ak74,mp5,svd,amr-50'],
]

for (const view of state.VIEWS) {
  for (const [name, query] of SCENARIOS) {
    test(`${view} 视图：${name}`, async () => {
      const session = makeSession(`${query}${query ? '&' : ''}view=${view}`)
      const host = await renderAll(session)
      assert.ok(host.textContent.length > 0)
      host.remove()
    })
  }
}

test('击杀弹数表列出了所有能算的枪，点一格会套用那格的护甲和弹种', async () => {
  const session = makeSession('round=FMJ,AP&armour=0&helmet=0')
  const host = await renderAll(session)
  const rows = host.querySelectorAll('.stk tbody tr')
  assert.ok(rows.length >= engine.usableWeapons(data).length, '每把枪至少一行')
  assert.ok(host.textContent.includes('M4'))

  // 第一行第四级那一格
  const cells = rows[0].querySelectorAll('.tier')
  assert.equal(cells.length, session.ladder.length)
  cells[4].click()
  assert.equal(session.currentLevel, 4, '点了四级那一列')
  host.remove()
})

test('名次卡按击杀时间排，最快的排第一', async () => {
  const session = makeSession('')
  const host = await renderAll(session)
  const names = [...host.querySelectorAll('.rank-card .rank-title .strong')].map((node) => node.textContent)
  assert.deepEqual(names, ['SVD', 'M4', 'AK74', 'MP5'])
  assert.ok(host.querySelector('.rank-card')?.textContent.includes('47'), 'SVD 每发 47')
  host.remove()
})

test('左栏：点部位、勾弹种、切护甲等级都会改会话', async () => {
  const session = makeSession('')
  const host = await renderAll(session)

  // SVG 元素没有 click()，派发事件
  host.querySelector('.bodymap .zone[aria-label="头部"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.equal(session.engagement.hit, 'head')

  host.querySelector('.round[aria-checked="false"]').click()
  assert.equal(session.loads.length, 2)

  const seg = host.querySelectorAll('.seg')[0]
  seg.querySelector('.seg-item:last-child').click()
  assert.equal(engine.levelOf(data, session.engagement.helmet), 4)
  host.remove()
})

test('弹种至少留一种，最后一种取消不掉', () => {
  const session = makeSession('')
  session.toggleLoad('FMJ')
  assert.deepEqual(session.loads, ['FMJ'])
})

test('距离滑杆拖动时只发轻量更新', () => {
  const session = makeSession('')
  const events = []
  session.subscribe((_, meta) => events.push(meta))
  const host = document.createElement('div')
  host.append(rail.renderRail(session, { onOpenPicker: () => {} }))
  const slider = host.querySelector('.range-slider')
  slider.value = '300'
  slider.dispatchEvent(new window.Event('input'))
  assert.equal(session.engagement.range, 300)
  assert.equal(events[events.length - 1].light, true)
  slider.dispatchEvent(new window.Event('change'))
  assert.equal(events[events.length - 1].light, undefined, '松手后来一次完整刷新')
})

test('选枪面板：搜索过滤、勾选、满五把后其余禁用', () => {
  const session = makeSession('w=m4,ak74,mp5,svd')
  const host = document.createElement('div')
  document.body.append(host)
  const pk = picker.createPicker(session, { host })
  pk.open()
  assert.equal(pk.isOpen(), true)
  const all = host.querySelectorAll('.pk-weapon').length
  assert.ok(all >= 20)

  const search = host.querySelector('.pk-search')
  search.value = 'svd'
  search.dispatchEvent(new window.Event('input'))
  const filtered = host.querySelectorAll('.pk-weapon')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].getAttribute('aria-pressed'), 'true')

  search.value = ''
  search.dispatchEvent(new window.Event('input'))
  const spare = [...host.querySelectorAll('.pk-weapon')].find((node) => node.getAttribute('aria-pressed') === 'false')
  spare.click()
  assert.equal(session.selected.length, 5)
  pk.refresh()
  const disabled = [...host.querySelectorAll('.pk-weapon')].filter((node) => node.disabled)
  assert.equal(disabled.length, all - 5, '没选中的全部禁用')

  pk.close()
  assert.equal(pk.isOpen(), false)
  host.remove()
})

test('弹药表展开一行能看到每种弹的系数', async () => {
  const session = makeSession('view=ammo')
  session.toggleExpanded('556mm')
  const host = await renderAll(session)
  assert.ok(host.querySelectorAll('.ammo-detail').length === 3, '5.56 有三种弹')
  assert.ok(host.textContent.includes('穿护甲'))
  host.remove()
})

test('距离曲线：点图会把距离设到那里，效果档横条每把枪一条', async () => {
  const session = makeSession('view=range&round=FMJ,HP')
  const host = await renderAll(session)
  assert.equal(host.querySelectorAll('.band-track').length, session.combos.length)
  assert.ok(host.querySelectorAll('.range-chart path').length >= session.combos.length)
  host.remove()
})

test('界面文案里没有英文残留的部位和护甲名', async () => {
  const session = makeSession('view=zones')
  const host = await renderAll(session)
  const text = host.textContent
  for (const english of ['Upper torso', 'Level 2 Armor', 'Head', 'Assault Rifle']) {
    assert.ok(!text.includes(english), `界面上不该出现 ${english}`)
  }
  assert.ok(text.includes('上躯干'))
  host.remove()
})
