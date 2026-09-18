/**
 * Wardogs 情报面板：服务器状态、金条汇率、进度 XP 表。三个标签一个弹层。
 *
 * 渲染函数都只吃数据不发请求，便于用 happy-dom 直接测；
 * open() 负责拉数据、定时刷新、记住上次看的标签。
 */
import { api, ApiError } from '../api.js'
import { el, formatAge, icon, openSheet } from '../ui.js'

export const HASH_PREFIX = '#wardogs/intel'
const TAB_KEY = 'gmap.wardogs.intel.tab'
/** 服务器状态每分钟刷一次，和上游的更新频率一致 */
const STATUS_REFRESH_MS = 60_000

const TABS = [
  ['status', '服务器'],
  ['market', '金条'],
  ['xp', '进度 XP'],
]

/* ── 文案 ─────────────────────────────────────────────── */

const ZONE_NAME = {
  'asia-east': '亚洲东', 'asia-west': '亚洲西', 'asia-southeast': '东南亚',
  oceania: '大洋洲',
  'na-east': '北美东', 'na-central': '北美中', 'na-west': '北美西', 'na-north': '北美北',
  'eu-west': '欧洲西', 'eu-central': '欧洲中', 'eu-east': '欧洲东', 'eu-south': '欧洲南',
  'south-america': '南美',
}
/** 大区分组，亚洲排最前：这是中文用户最常去的 */
const CONTINENTS = [
  ['亚洲', ['asia-east', 'asia-southeast', 'asia-west']],
  ['大洋洲', ['oceania']],
  ['北美', ['na-east', 'na-central', 'na-west', 'na-north']],
  ['欧洲', ['eu-west', 'eu-central', 'eu-east', 'eu-south']],
  ['南美', ['south-america']],
]
const VARIANT_NAME = { Hardcore: '硬核', InfantryOnly: '纯步兵' }
const SKY_NAME = {
  DayStartClear: '开局晴', DayEarlyClear: '清晨晴', DayEarlyFog: '清晨雾', DayClear: '白天晴',
  DayLateClear: '傍晚晴', DayLateGray: '傍晚阴', DayLateGrayFog: '傍晚阴雾',
}
const ROLE_NAME = { driver: '驾驶员', infantry: '步兵', medic: '医疗兵', pilot: '飞行员', recon: '侦察兵', support: '支援兵' }
const GROUP_NAME = {
  'Anti-vehicle': '反载具', Building: '建造', Combat: '战斗', Denial: '压制', Logistics: '后勤',
  Medical: '医疗', Objectives: '目标', Other: '其它', Spotting: '标记', Transport: '运输',
}
const TAB_NAME = { weapons: '武器', attachments: '配件', ammunition: '弹药', armor: '护甲', vehicles: '载具', storage: '储物', equipment: '装备', throwables: '投掷物', deployables: '部署物' }

export const zoneName = (id) => ZONE_NAME[id] ?? id
const n = (value) => (Number.isFinite(value) ? value.toLocaleString('zh-CN') : '-')
const pct = (part, whole) => (whole > 0 ? Math.round(part / whole * 100) : 0)

/* ── 小件 ─────────────────────────────────────────────── */

function stat(label, value, sub) {
  const node = el('div', 'it-stat')
  node.append(el('b', null, value), el('span', 'it-stat-label', label))
  if (sub) node.append(el('span', 'it-stat-sub', sub))
  return node
}

/** 占比条：在线 / 容量 */
function bar(part, whole, className = '') {
  const track = el('span', `it-bar ${className}`)
  const fill = el('i')
  fill.style.width = `${Math.min(100, pct(part, whole))}%`
  track.append(fill)
  return track
}

function sourceNote(payload, label) {
  const when = payload.fetchedAt ? `${formatAge(payload.fetchedAt)}取得` : ''
  const from = { upstream: '来自 metaforge.app', stale: '上游暂时拉不到，显示的是上次取得的', snapshot: '本地快照' }[payload.source] ?? ''
  return el('div', 'it-note', [label, from, when].filter(Boolean).join('，'))
}

function emptyBox(message) {
  const box = el('div', 'it-empty')
  box.append(el('div', 'head', '拉不到数据'), el('p', null, message))
  return box
}

/* ── 服务器状态 ───────────────────────────────────────── */

/**
 * @param {object} status /api/wardogs/status 的响应
 * @param {{ onZone: (zone: string) => void }} handlers
 */
export function buildStatusView(status, { onZone }) {
  const root = el('div', 'it-status')
  const { totals } = status

  const stats = el('div', 'it-stats')
  stats.append(
    stat('Steam 在线', n(status.steamPlayers), status.steamPlayers === null ? '暂时拿不到' : ''),
    stat('服务器内玩家', n(totals.players), `容量 ${n(totals.capacity)}，${pct(totals.players, totals.capacity)}% 满`),
    stat('服务器', n(totals.servers), totals.queued ? `排队 ${n(totals.queued)}` : ''),
  )
  root.append(stats)

  const byId = new Map(status.zones.map((zone) => [zone.id, zone]))
  const { node: zoneTable, body } = table(['区', '服务器', '在线', '容量'])
  for (const [continent, ids] of CONTINENTS) {
    const zones = ids.map((id) => byId.get(id)).filter(Boolean)
    if (!zones.length) continue
    const head = el('tr', 'it-group')
    const cell = el('td', null, continent)
    cell.colSpan = 4
    head.append(cell)
    body.append(head)
    for (const zone of zones) {
      const tr = el('tr', 'it-zone')
      tr.tabIndex = 0
      tr.setAttribute('role', 'button')
      tr.title = `看 ${zoneName(zone.id)} 的服务器清单`
      const name = el('td', null)
      name.append(el('b', null, zoneName(zone.id)), el('span', 'it-dim', ` ${zone.id}`))
      const players = el('td', 'it-num', n(zone.players))
      const capacity = el('td', 'it-num')
      capacity.append(bar(zone.players, zone.capacity), el('span', 'it-dim', ` ${pct(zone.players, zone.capacity)}%`))
      tr.append(name, el('td', 'it-num', n(zone.servers)), players, capacity)
      const pick = () => onZone(zone.id)
      tr.addEventListener('click', pick)
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          pick()
        }
      })
      body.append(tr)
    }
  }
  // 清单里没归到大区的新区，别静默丢掉
  const known = new Set(CONTINENTS.flatMap(([, ids]) => ids))
  for (const zone of status.zones.filter((item) => !known.has(item.id))) {
    body.append(row([zone.id, n(zone.servers), n(zone.players), n(zone.capacity)]))
  }
  root.append(el('h3', 'it-h', '各区'), zoneTable)

  const maps = el('div', 'it-maps')
  const most = Math.max(1, ...status.maps.map((item) => item.players))
  for (const item of status.maps) {
    const line = el('div', 'it-map')
    line.append(el('span', 'it-map-name', item.map), bar(item.players, most, 'wide'), el('span', 'it-num', `${n(item.players)} 人，${n(item.servers)} 台`))
    maps.append(line)
  }
  root.append(el('h3', 'it-h', '在打哪张图'), maps)
  return root
}

function row(cells, tag = 'td') {
  const tr = el('tr')
  cells.forEach((text, index) => tr.append(el(tag, index > 0 ? 'it-num' : '', text)))
  return tr
}

/** 带表头的表格骨架，返回表和它的 tbody */
function table(headers, className = '') {
  const node = el('table', `it-table ${className}`)
  const head = el('thead')
  head.append(row(headers, 'th'))
  const body = el('tbody')
  node.append(head, body)
  return { node, body }
}

/** 横向可滚动的容器 */
function scrollBox(child) {
  const box = el('div', 'it-scroll')
  box.append(child)
  return box
}

/**
 * 某个区的服务器清单。
 * @param {{ zone: string, servers: object[] }} payload
 */
export function buildZoneView(payload, { onBack }) {
  const root = el('div', 'it-servers')
  const head = el('div', 'it-head')
  const back = el('button', 'slim')
  back.append(icon('arrow-left'), el('span', null, '各区'))
  back.addEventListener('click', onBack)
  head.append(back, el('h3', 'it-h', `${zoneName(payload.zone)}，${payload.servers.length} 台`))
  root.append(head)

  if (!payload.servers.length) {
    root.append(el('p', 'it-dim', '这个区现在没有服务器。'))
    return root
  }
  const list = el('div', 'it-list')
  for (const server of payload.servers) {
    const item = el('div', `it-server ${server.players >= server.max ? 'full' : ''}`)
    const title = el('div', 'it-server-title')
    // 官方服有编号，社区服的编号全是 0，显示编号没有意义
    title.append(el('b', null, server.official ? `#${server.number}` : '社区服'))
    if (server.official) title.append(el('span', 'it-badge', '官方'))
    if (server.passworded) title.append(icon('lock-simple', 'icon it-lock'))
    const meta = [server.map, ...server.variants.map((variant) => VARIANT_NAME[variant] ?? variant), SKY_NAME[server.sky] ?? server.sky]
      .filter(Boolean).join('，')
    title.append(el('span', 'it-dim', meta))
    const load = el('div', 'it-server-load')
    load.append(bar(server.players, server.max), el('span', 'it-num', `${n(server.players)} / ${n(server.max)}`))
    item.append(title, load)
    list.append(item)
  }
  root.append(list)
  return root
}

/* ── 金条汇率 ─────────────────────────────────────────── */

const RANGES = [['30', '30 天'], ['90', '90 天'], ['all', '全部']]

/**
 * @param {object} market /api/wardogs/market 的响应
 * @param {{ range: string, onRange: (range: string) => void }} view
 */
export function buildMarketView(market, { range, onRange }) {
  const root = el('div', 'it-market')
  const { stats } = market

  const stat0 = el('div', 'it-stats')
  stat0.append(
    stat('一根金条', `$${n(stats.current)}`, market.updatedAt ? `${formatAge(market.updatedAt)}更新` : ''),
    stat('历史最低', `$${n(stats.min)}`),
    stat('历史最高', `$${n(stats.max)}`),
  )
  root.append(stat0)

  const changes = el('div', 'it-changes')
  for (const [key, label] of [['7d', '7 天'], ['30d', '30 天'], ['90d', '90 天'], ['1y', '1 年'], ['all', '全部']]) {
    const value = stats.changes?.[key]
    const chip = el('span', 'it-change')
    const sign = Number.isFinite(value) ? (value > 0 ? 'up' : value < 0 ? 'down' : '') : ''
    chip.classList.add(sign)
    chip.append(el('span', 'it-dim', label), el('b', null, Number.isFinite(value) ? `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%` : '-'))
    changes.append(chip)
  }
  root.append(changes)

  const picker = el('div', 'pick')
  for (const [key, label] of RANGES) {
    const button = el('button', key === range ? 'on' : '', label)
    button.type = 'button'
    button.addEventListener('click', () => onRange(key))
    picker.append(button)
  }
  root.append(picker, sparkline(market.points, range))
  return root
}

/** 折线图。points 是 [时间戳, 价格]，按天一个点 */
function sparkline(points, range) {
  const SVG = 'http://www.w3.org/2000/svg'
  const shown = range === 'all' ? points : points.slice(-Number(range))
  const W = 640
  const H = 180
  const pad = { left: 8, right: 8, top: 12, bottom: 22 }
  const prices = shown.map((point) => point[1])
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const span = max - min || 1
  const x = (index) => pad.left + (shown.length > 1 ? index / (shown.length - 1) : 0.5) * (W - pad.left - pad.right)
  const y = (price) => pad.top + (1 - (price - min) / span) * (H - pad.top - pad.bottom)

  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'it-spark')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `金条价格走势，${shown.length} 天`)

  const line = shown.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(point[1]).toFixed(1)}`).join(' ')
  const area = document.createElementNS(SVG, 'path')
  area.setAttribute('d', `${line} L${x(shown.length - 1).toFixed(1)} ${H - pad.bottom} L${x(0).toFixed(1)} ${H - pad.bottom} Z`)
  area.setAttribute('class', 'area')
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', line)
  path.setAttribute('class', 'line')
  svg.append(area, path)

  // 首尾日期
  const stamp = (ms) => new Date(ms).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  for (const [index, anchor] of [[0, 'start'], [shown.length - 1, 'end']]) {
    const text = document.createElementNS(SVG, 'text')
    text.setAttribute('x', x(index))
    text.setAttribute('y', H - 6)
    text.setAttribute('text-anchor', anchor)
    text.setAttribute('class', 'label')
    text.textContent = stamp(shown[index][0])
    svg.append(text)
  }

  // 悬停读数
  const cursor = document.createElementNS(SVG, 'line')
  cursor.setAttribute('class', 'cursor')
  cursor.setAttribute('y1', pad.top)
  cursor.setAttribute('y2', H - pad.bottom)
  cursor.style.display = 'none'
  const dot = document.createElementNS(SVG, 'circle')
  dot.setAttribute('r', 4)
  dot.setAttribute('class', 'dot')
  dot.style.display = 'none'
  const readout = document.createElementNS(SVG, 'text')
  readout.setAttribute('class', 'readout')
  readout.setAttribute('y', pad.top - 2)
  readout.style.display = 'none'
  svg.append(cursor, dot, readout)

  svg.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    const index = Math.max(0, Math.min(shown.length - 1, Math.round(((ratio * W) - pad.left) / (W - pad.left - pad.right) * (shown.length - 1))))
    const [t, price] = shown[index]
    cursor.setAttribute('x1', x(index))
    cursor.setAttribute('x2', x(index))
    dot.setAttribute('cx', x(index))
    dot.setAttribute('cy', y(price))
    readout.setAttribute('x', x(index))
    readout.setAttribute('text-anchor', index > shown.length / 2 ? 'end' : 'start')
    readout.textContent = `${stamp(t)}  $${n(price)}`
    for (const node of [cursor, dot, readout]) node.style.display = ''
  })
  svg.addEventListener('pointerleave', () => {
    for (const node of [cursor, dot, readout]) node.style.display = 'none'
  })
  return svg
}

/* ── 进度 XP ──────────────────────────────────────────── */

/**
 * @param {object} progression /api/wardogs/progression 的响应
 * @param {{ role: string, section: 'levels' | 'actions', group: string | null }} view
 * @param {(patch: object) => void} onChange
 */
export function buildXpView(progression, view, onChange) {
  const root = el('div', 'it-xp')
  const roles = progression.roles
  const role = roles.find((item) => item.id === view.role) ?? roles[0]

  const rolePick = el('div', 'pick')
  for (const item of roles) {
    const button = el('button', item.id === role.id ? 'on' : '', ROLE_NAME[item.id] ?? item.name)
    button.type = 'button'
    button.addEventListener('click', () => onChange({ role: item.id }))
    rolePick.append(button)
  }
  const sectionPick = el('div', 'pick')
  for (const [key, label] of [['levels', '等级表'], ['actions', '行动奖励']]) {
    const button = el('button', key === view.section ? 'on' : '', label)
    button.type = 'button'
    button.addEventListener('click', () => onChange({ section: key }))
    sectionPick.append(button)
  }
  root.append(rolePick, sectionPick)

  if (view.section === 'actions') {
    root.append(buildActions(progression, view, onChange))
    return root
  }

  root.append(el('p', 'it-dim', `${ROLE_NAME[role.id] ?? role.name}满级 ${role.maxLevel}，共需 ${n(role.totalXpToMax)} XP。解锁列出这一级给这个兵种开放的东西。`))

  const unlocksByLevel = new Map()
  for (const unlock of progression.unlocks) {
    if (unlock.role !== role.id) continue
    const list = unlocksByLevel.get(unlock.level) ?? []
    list.push(unlock)
    unlocksByLevel.set(unlock.level, list)
  }

  const { node: levelTable, body } = table(['等级', '累计 XP', '本级需要', '解锁'], 'it-levels')
  for (const level of role.levels) {
    if (level.level === 0) continue
    const tr = el('tr')
    const unlocks = el('td', 'it-unlocks')
    for (const unlock of unlocksByLevel.get(level.level) ?? []) {
      const chip = el('span', 'it-unlock', unlock.name)
      chip.title = [TAB_NAME[unlock.tab] ?? unlock.tab, unlock.subcategory, unlock.cash ? `$${n(unlock.cash)}` : ''].filter(Boolean).join('，')
      unlocks.append(chip)
    }
    tr.append(el('td', 'it-num', String(level.level)), el('td', 'it-num', n(level.totalXp)), el('td', 'it-num', n(level.xpFromPrevious)), unlocks)
    body.append(tr)
  }
  root.append(scrollBox(levelTable))
  return root
}

function buildActions(progression, view, onChange) {
  const wrap = el('div')
  const groups = [...new Set(progression.actions.map((action) => action.group))]
  const chips = el('div', 'it-groups')
  for (const group of [null, ...groups]) {
    const chip = el('button', `slim ${view.group === group ? 'on' : ''}`, group ? (GROUP_NAME[group] ?? group) : '全部')
    chip.type = 'button'
    chip.addEventListener('click', () => onChange({ group }))
    chips.append(chip)
  }
  wrap.append(chips)

  const placement = progression.placement
  if (placement?.xpFactors) {
    wrap.append(el('p', 'it-dim', `结算加成：第一名 XP ×${placement.xpFactors.first}、第二名 ×${placement.xpFactors.second}、第三名 ×${placement.xpFactors.third}；现金另加 $${n(placement.flatCash?.first)} / $${n(placement.flatCash?.second)} / $${n(placement.flatCash?.third)}。同一行动重复做会递减。`))
  }

  const { node: actionTable, body } = table(['行动', 'XP', '现金', '递减'])
  const reward = (item) => {
    if (item.base === null && item.max === null) return '-'
    if (item.max !== null && item.max !== item.base) return `${n(item.base ?? 0)} 至 ${n(item.max)}`
    return n(item.base)
  }
  for (const action of progression.actions) {
    if (view.group && action.group !== view.group) continue
    const tr = el('tr')
    const label = el('td', null)
    label.append(el('span', null, action.label))
    if (action.isAssist) label.append(el('span', 'it-badge', '助攻'))
    label.append(el('span', 'it-dim', ` ${GROUP_NAME[action.group] ?? action.group}`))
    const decay = action.xp.decay ?? action.cash.decay
    tr.append(
      label,
      el('td', 'it-num', reward(action.xp)),
      el('td', 'it-num', reward(action.cash)),
      el('td', 'it-num', decay ? `每次 -${Math.round(decay.perRepeat * 100)}%，${decay.maxRepeats} 次` : '-'),
    )
    body.append(tr)
  }
  wrap.append(scrollBox(actionTable))
  return wrap
}

/* ── 面板 ─────────────────────────────────────────────── */

function readTab() {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    return TABS.some(([key]) => key === saved) ? saved : 'status'
  } catch {
    return 'status'
  }
}

function saveTab(tab) {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    // 记不住就算了
  }
}

export function hashQuery() {
  const { hash } = location
  if (!hash.startsWith(HASH_PREFIX)) return null
  const rest = hash.slice(HASH_PREFIX.length)
  return rest.startsWith('?') ? rest.slice(1) : ''
}

let opened = false

/**
 * 打开面板。已打开时不重复开。
 * @param {{ query?: string }} options query 里可带 tab=status|market|xp
 */
export async function open({ query } = {}) {
  if (opened) return
  opened = true
  const params = new URLSearchParams(query ?? '')
  const wanted = params.get('tab')
  let tab = TABS.some(([key]) => key === wanted) ? wanted : readTab()

  const { body, close: closeSheet } = openSheet('Wardogs 情报')
  body.parentElement.classList.add('wide')
  const tabs = el('div', 'pick it-tabs')
  const content = el('div', 'it-content')
  body.append(tabs, content)

  const state = {
    zone: null,
    range: '90',
    xp: { role: 'infantry', section: 'levels', group: null },
  }
  let timer = null
  let generation = 0

  const paintTabs = () => {
    tabs.replaceChildren()
    for (const [key, label] of TABS) {
      const button = el('button', key === tab ? 'on' : '', label)
      button.type = 'button'
      button.addEventListener('click', () => {
        if (tab === key) return
        tab = key
        saveTab(tab)
        state.zone = null
        paintTabs()
        render()
      })
      tabs.append(button)
    }
  }

  const fail = (err) => {
    content.replaceChildren(emptyBox(err instanceof ApiError ? err.message : '连不上服务端，稍后再试。'))
  }

  async function render() {
    const gen = ++generation
    clearInterval(timer)
    timer = null
    content.replaceChildren(el('p', 'it-dim', '读取中'))
    try {
      if (tab === 'status') {
        if (state.zone) {
          const payload = await api.wardogsZoneServers(state.zone)
          if (gen !== generation) return
          content.replaceChildren(buildZoneView(payload, { onBack: () => { state.zone = null; render() } }), sourceNote(payload, '服务器清单'))
        } else {
          const payload = await api.wardogsStatus()
          if (gen !== generation) return
          content.replaceChildren(buildStatusView(payload, { onZone: (zone) => { state.zone = zone; render() } }), sourceNote(payload, '服务器状态'))
        }
        // 实时数据，面板开着就每分钟刷一次
        timer = setInterval(() => { if (gen === generation) render() }, STATUS_REFRESH_MS)
      } else if (tab === 'market') {
        const payload = await api.wardogsMarket()
        if (gen !== generation) return
        content.replaceChildren(buildMarketView(payload, { range: state.range, onRange: (range) => { state.range = range; render() } }), sourceNote(payload, '金条汇率'))
      } else {
        const payload = await api.wardogsProgression()
        if (gen !== generation) return
        const onChange = (patch) => { Object.assign(state.xp, patch); render() }
        content.replaceChildren(buildXpView(payload, state.xp, onChange), sourceNote(payload, `进度表 ${payload.generatedAt ?? ''}`))
      }
    } catch (err) {
      if (gen === generation) fail(err)
    }
  }

  // 弹层关掉时停掉定时器。openSheet 没有关闭回调，盯着节点是否还在页面上
  const watcher = new MutationObserver(() => {
    if (document.body.contains(body)) return
    clearInterval(timer)
    watcher.disconnect()
    opened = false
  })
  watcher.observe(document.getElementById('sheet-root'), { childList: true })

  paintTabs()
  await render()
  return { close: closeSheet }
}
