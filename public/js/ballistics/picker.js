/**
 * 选枪面板：按武器类分栏列出所有能算的枪，勾选加入比较，最多五把。
 *
 * 搜索框在会话变化时不重建，只重画下面的清单，否则每勾一把枪光标就丢一次。
 */
import { el, icon } from '../ui.js'
import { checkMark, h, weaponIcon } from './dom.js'
import { CLASS_ORDER, MAX_PICKED, calibreLabel, slugOf } from './engine.js'
import { WEAPON_CLASS } from './text.js'

/**
 * @param {import('./state.js').Session} session
 * @param {{ host: HTMLElement }} config 面板挂在哪个节点下
 * @returns {{ open: () => void, close: () => void, refresh: () => void, isOpen: () => boolean }}
 */
export function createPicker(session, { host }) {
  let veil = null
  let query = ''
  let listNode = null
  let countNode = null
  let clearNode = null

  const unlockOf = (weapon) => session.icons[slugOf(weapon)]?.unlock ?? 0

  function groups() {
    const needle = query.trim().toLowerCase()
    const matches = (weapon, cls) => !needle
      || weapon.name.toLowerCase().includes(needle)
      || calibreLabel(session.data, weapon.calibre).toLowerCase().includes(needle)
      || cls.toLowerCase().includes(needle)
      || (WEAPON_CLASS[cls] ?? '').includes(needle)
    return CLASS_ORDER
      .map((cls) => ({
        cls,
        weapons: session.weapons
          .filter((weapon) => weapon.weaponClass === cls && matches(weapon, cls))
          // 先按解锁等级，同级按名字，和游戏商店里的顺序一致
          .sort((a, b) => unlockOf(a) - unlockOf(b) || a.name.localeCompare(b.name)),
      }))
      .filter((group) => group.weapons.length > 0)
  }

  function paintList() {
    const sections = groups()
    listNode.replaceChildren()
    for (const group of sections) {
      const sec = h('section', { class: 'pk-group' })
      sec.append(h('header', null, h('h3', null, WEAPON_CLASS[group.cls] ?? group.cls, h('small', { text: String(group.weapons.length) }))))
      for (const weapon of group.weapons) {
        const slug = slugOf(weapon)
        const on = session.selected.includes(slug)
        const button = h('button', {
          type: 'button',
          class: `pk-weapon ${on ? 'on' : ''}`,
          'aria-pressed': String(on),
          disabled: !on && session.isFull,
          title: weapon.name,
          onclick: () => session.toggle(slug),
        })
        if (on) button.style.setProperty('--c', session.colours[slug])
        button.append(
          weaponIcon(session, slug, 'wicon lg'),
          h('span', { class: 'pk-meta' },
            h('span', { class: 'pk-name', text: weapon.name }),
            h('span', { class: 'pk-cal', text: calibreLabel(session.data, weapon.calibre) }),
          ),
          checkMark(on, 'lg'),
        )
        sec.append(button)
      }
      listNode.append(sec)
    }
    if (sections.length === 0) {
      listNode.append(h('p', { class: 'pk-empty', text: `没有匹配“${query}”的武器` }))
    }
    countNode.textContent = String(session.selected.length)
    clearNode.classList.toggle('hidden', session.selected.length === 0)
  }

  function build() {
    veil = el('div', 'veil pk-veil')
    const panel = h('div', { class: 'pk', role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择武器' })

    const closeBtn = h('button', { type: 'button', class: 'bare only-narrow', 'aria-label': '关闭', onclick: close })
    closeBtn.append(icon('x'))
    countNode = h('b', { text: '0' })
    const search = h('input', { type: 'search', class: 'pk-search', placeholder: '搜索武器', 'aria-label': '搜索武器' })
    search.value = query
    search.addEventListener('input', () => {
      query = search.value
      paintList()
    })
    const searchWrap = h('label', { class: 'pk-search-wrap' }, icon('magnifying-glass'), search)
    clearNode = h('button', { type: 'button', class: 'slim hidden', text: '清空', onclick: () => session.setSelected([]) })
    const done = h('button', { type: 'button', class: 'key', text: '完成', onclick: close })

    const head = h('header', { class: 'pk-head' },
      closeBtn,
      h('h2', { text: '武器' }),
      h('span', { class: 'pk-count' }, countNode, ` / ${MAX_PICKED} 已选`),
      searchWrap,
      h('span', { class: 'spacer' }),
      clearNode,
      done,
    )
    listNode = h('div', { class: 'pk-list' })
    panel.append(head, h('div', { class: 'pk-body' }, listNode))
    veil.append(panel)
    veil.addEventListener('mousedown', (event) => {
      if (event.target === veil) close()
    })
    paintList()
    return { veil, search }
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    }
  }

  function open() {
    if (veil) return
    const built = build()
    host.append(built.veil)
    // 用 capture 抢在计算器自己的 Esc 之前，先关面板再关计算器
    document.addEventListener('keydown', onKey, true)
    if (window.innerWidth >= 1024) built.search.focus()
  }

  function close() {
    if (!veil) return
    document.removeEventListener('keydown', onKey, true)
    veil.remove()
    veil = null
    query = ''
  }

  return {
    open,
    close,
    isOpen: () => veil !== null,
    refresh: () => { if (veil) paintList() },
  }
}
