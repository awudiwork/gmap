/**
 * 计算器的状态：选了哪些枪、勾了哪些弹、命中部位、护甲、距离、看哪个视图。
 *
 * 纯逻辑层，不碰 DOM。视图订阅它，任何改动都整体重画。
 * 状态能序列化成查询串（分享链接）也能从查询串还原，格式和原站一致，
 * 原站的链接参数贴过来也能用。
 */
import {
  MAX_PICKED, MAX_RANGE, ROUND_SHORT, armourIdFor, assignColours, coveringArmour, ladder, levelOf,
  ranked, roundIndex, slugOf, solvedCombos, tierLevel, usableWeapons,
} from './engine.js'

export const VIEWS = Object.freeze(['table', 'compare', 'zones', 'range', 'ammo'])

/** 原站的几个视图别名，链接里写 view=ttk 这类也认 */
const VIEW_ALIASES = {
  ttk: { view: 'range', metric: 'time' },
  ranking: { view: 'table', metric: 'time' },
  stk: { view: 'table', metric: 'shots' },
}

export const DEFAULT_PICKS = Object.freeze(['m4', 'ak74', 'mp5', 'svd'])
export const DEFAULT_LEVEL = 2
export const DEFAULT_RANGE = 50
export const DEFAULT_HIT = 'torso_upper'
export const DEFAULT_LOADS = Object.freeze(['FMJ'])

const STATE_PARAMS = ['w', 'armour', 'helmet', 'hit', 'round', 'shell', 'range', 'view', 'metric', 'rounds', 'scope']

export const defaultHit = (data) =>
  (data.hitLocations.some((zone) => zone.key === DEFAULT_HIT) ? DEFAULT_HIT : data.hitLocations[0]?.key ?? '')

/**
 * 从查询串还原状态。认不出的值一律退回默认，不抛错：链接是人手抄的，抄错一个字不该整页打不开。
 * @returns {{ selected: string[], loads: string[], engagement: object, view: string, metric: string, pickedOnly: boolean, isDefaultView: boolean }}
 */
export function parseState(data, params) {
  const known = new Set(usableWeapons(data).map(slugOf))
  const rawPicks = params.get('w')
  const picks = (rawPicks ?? '').split(',').map((item) => item.trim()).filter((item) => known.has(item))
  const selected = rawPicks === ''
    ? []
    : (picks.length ? picks.slice(0, MAX_PICKED) : DEFAULT_PICKS.filter((slug) => known.has(slug)))

  const armourFrom = (value, slot) => {
    if (value === 'none' || value === '0') return null
    if (value && /^[1-4]$/.test(value)) return armourIdFor(data, slot, Number(value))
    const exact = data.armour.find((item) => item.id === value && item.slot === slot)
    return exact ? exact.id : armourIdFor(data, slot, DEFAULT_LEVEL)
  }

  const roundOrder = new Map(data.rounds.map((round, index) => [round.key, index]))
  const byShort = new Map(Object.entries(ROUND_SHORT).map(([key, short]) => [short.toLowerCase(), key]))
  const loads = [...new Set((params.get('round') ?? '')
    .split(',')
    .map((item) => (roundOrder.has(item) ? item : byShort.get(item.toLowerCase()) ?? item))
    .filter((item) => roundOrder.has(item)))]
    .sort((a, b) => roundOrder.get(a) - roundOrder.get(b))

  const hit = params.get('hit')
  const rangeRaw = params.get('range')
  const range = rangeRaw === null ? NaN : Number(rangeRaw)
  const shell = params.get('shell')

  const engagement = {
    armour: armourFrom(params.get('armour'), 'armor'),
    helmet: armourFrom(params.get('helmet'), 'helmet'),
    hit: data.hitLocations.some((zone) => zone.key === hit) ? hit : defaultHit(data),
    round: loads[0] ?? 'FMJ',
    shell: shell && data.calibres[shell] ? shell : undefined,
    range: Number.isFinite(range) && range >= 0 && range <= MAX_RANGE ? range : DEFAULT_RANGE,
  }

  const viewRaw = params.get('view') ?? ''
  const alias = VIEW_ALIASES[viewRaw]
  const view = alias ? alias.view : (VIEWS.includes(viewRaw) ? viewRaw : 'table')
  const metricRaw = params.get('metric')
  const metric = metricRaw === 'shots' || metricRaw === 'time' ? metricRaw : (alias?.metric ?? 'shots')
  const isDefaultView = ![...params.keys()].some((key) => STATE_PARAMS.includes(key))

  return {
    selected,
    loads: loads.length ? loads : [...DEFAULT_LOADS],
    engagement,
    view,
    metric,
    pickedOnly: params.get('scope') === 'picked',
    isDefaultView,
  }
}

/** 把状态写成查询串。等于默认值的项不写，链接才短 */
export function serializeState(data, state) {
  const params = new URLSearchParams()
  const { engagement } = state
  const armourLevel = levelOf(data, engagement.armour)
  const helmetLevel = levelOf(data, engagement.helmet)
  const loads = state.loads.map((round) => ROUND_SHORT[round] ?? round)

  params.set('w', state.selected.join(','))
  if (armourLevel !== DEFAULT_LEVEL) params.set('armour', String(armourLevel))
  if (helmetLevel !== DEFAULT_LEVEL) params.set('helmet', String(helmetLevel))
  if (engagement.hit !== defaultHit(data)) params.set('hit', engagement.hit)
  if (loads.join(',') !== DEFAULT_LOADS.join(',')) params.set('round', loads.join(','))
  if (engagement.shell) params.set('shell', engagement.shell)
  if (engagement.range !== DEFAULT_RANGE) params.set('range', String(engagement.range))
  if (state.view !== 'table') params.set('view', state.view)
  if (state.metric !== 'shots') params.set('metric', state.metric)
  if (state.pickedOnly) params.set('scope', 'picked')
  return params.toString().replace(/%2C/g, ',')
}

/**
 * 会话：可变状态 + 派生值 + 订阅。
 * 派生值（选中的枪、组合、排名）按版本号缓存，一次改动只重算一次。
 */
export class Session {
  constructor(data, weapons, icons, initial) {
    this.data = data
    this.weapons = weapons
    this.icons = icons
    this.ladder = ladder(data)

    this.selected = []
    this.loads = ['FMJ']
    this.engagement = { armour: null, helmet: null, hit: 'torso_upper', round: 'FMJ', range: DEFAULT_RANGE }
    this.view = 'table'
    this.metric = 'shots'
    this.pickedOnly = false
    this.classFilter = null
    this.tableSort = { key: 'cur', asc: true }
    this.ammoSort = { key: 'damage', asc: false }
    this.expanded = {}
    this.colours = {}
    this.pickerOpen = false

    this.version = 0
    this.listeners = new Set()
    this.derivedAt = -1
    this.derived = null

    this.apply(initial)
  }

  /* ── 订阅 ─────────────────────────────────────────── */

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 每次改动都走这里，视图整体重画。
   * meta.light 表示"正在连续拖动"，订阅方可以只刷结果区，别把手里的滑杆换掉。
   */
  touch(meta = {}) {
    this.version += 1
    for (const listener of this.listeners) listener(this, meta)
  }

  /* ── 快照 ─────────────────────────────────────────── */

  apply(state) {
    this.setSelected(state.selected, { silent: true })
    this.loads = [...state.loads]
    this.engagement = { ...state.engagement, round: state.loads[0] ?? state.engagement.round }
    this.view = state.view
    this.metric = state.metric
    this.pickedOnly = state.pickedOnly
    this.touch()
  }

  toState() {
    return {
      selected: [...this.selected],
      loads: [...this.loads],
      engagement: { ...this.engagement },
      view: this.view,
      metric: this.metric,
      pickedOnly: this.pickedOnly,
    }
  }

  /* ── 派生值 ───────────────────────────────────────── */

  compute() {
    if (this.derivedAt === this.version) return this.derived
    const picked = this.selected
      .map((slug) => this.weapons.find((weapon) => slugOf(weapon) === slug))
      .filter((weapon) => !!weapon)
    const covering = coveringArmour(this.data, this.engagement)
    const coveredZones = new Set([this.engagement.armour, this.engagement.helmet]
      .map((id) => (id ? this.data.armour.find((item) => item.id === id) : undefined))
      .flatMap((item) => item?.covers ?? []))
    const combos = solvedCombos(this.data, picked, this.loads, this.engagement, this.colours)
    this.derived = {
      picked,
      isFull: this.selected.length >= MAX_PICKED,
      covering,
      currentLevel: covering ? tierLevel(covering) : 0,
      coveredZones,
      combos,
      ranked: ranked(combos),
    }
    this.derivedAt = this.version
    return this.derived
  }

  get picked() { return this.compute().picked }
  get isFull() { return this.compute().isFull }
  /** 当前命中部位被哪件护甲挡着 */
  get covering() { return this.compute().covering }
  get currentLevel() { return this.compute().currentLevel }
  get coveredZones() { return this.compute().coveredZones }
  get combos() { return this.compute().combos }
  get ranked() { return this.compute().ranked }

  /* ── 动作 ─────────────────────────────────────────── */

  set(patch) {
    Object.assign(this, patch)
    this.touch()
  }

  setEngagement(patch, meta) {
    this.engagement = { ...this.engagement, ...patch }
    this.touch(meta)
  }

  setSelected(slugs, { silent = false } = {}) {
    const next = [...new Set(slugs)].slice(0, MAX_PICKED)
    this.colours = assignColours(next, this.colours)
    this.selected = next
    if (!silent) this.touch()
  }

  toggle(slug) {
    if (this.selected.includes(slug)) {
      this.setSelected(this.selected.filter((item) => item !== slug))
    } else if (!this.isFull) {
      this.setSelected([...this.selected, slug])
    }
  }

  sortLoads(loads) {
    return [...loads].sort((a, b) => roundIndex(this.data, a) - roundIndex(this.data, b))
  }

  /** 至少留一种弹，全取消没有意义 */
  toggleLoad(round) {
    if (this.loads.includes(round)) {
      if (this.loads.length <= 1) return
      this.loads = this.loads.filter((item) => item !== round)
    } else {
      this.loads = this.sortLoads([...this.loads, round])
    }
    this.engagement = { ...this.engagement, round: this.loads[0] }
    this.touch()
  }

  setLoads(loads) {
    this.loads = this.sortLoads(loads)
    this.engagement = { ...this.engagement, round: this.loads[0] }
    this.touch()
  }

  setLevel(slot, level) {
    const id = armourIdFor(this.data, slot, level)
    this.setEngagement(slot === 'armor' ? { armour: id } : { helmet: id })
  }

  setBothLevels(level) {
    this.setEngagement({
      armour: armourIdFor(this.data, 'armor', level),
      helmet: armourIdFor(this.data, 'helmet', level),
    })
  }

  /** 表头点一下按它排，再点一下反向 */
  sortTableBy(key) {
    const active = key === this.tableSort.key || (this.tableSort.key === 'cur' && key === this.currentLevel)
    this.tableSort = active ? { key, asc: !this.tableSort.asc } : { key, asc: true }
    this.touch()
  }

  sortAmmoBy(key) {
    this.ammoSort = this.ammoSort.key === key
      ? { key, asc: !this.ammoSort.asc }
      : { key, asc: key === 'label' }
    this.touch()
  }

  toggleExpanded(key) {
    this.expanded = { ...this.expanded, [key]: !this.expanded[key] }
    this.touch()
  }
}
