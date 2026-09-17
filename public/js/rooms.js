/**
 * 频道栏：最左边一竖排游戏图标。
 *
 * 只负责"显示有哪些频道、当前在哪个、哪个有未读"，切换动作交给回调。
 * 房间清单来自服务端，这里不硬编码任何游戏。
 */
import { el } from './ui.js'

const LAST_ROOM_KEY = 'gmap.room'

/** 记住上次待的频道，下次进来直接回到那里 */
export function readLastRoom(fallback) {
  try {
    return localStorage.getItem(LAST_ROOM_KEY) || fallback
  } catch {
    return fallback
  }
}

function rememberRoom(id) {
  try {
    localStorage.setItem(LAST_ROOM_KEY, id)
  } catch {
    // 隐私模式下记不住，下次回到默认频道即可
  }
}

/**
 * 渲染频道栏。
 *
 * @param {{ host: HTMLElement, rooms: object[], current: string, onPick: (id: string) => void }} config
 * @returns {{ setCurrent: (id: string) => void, mark: (id: string) => void }}
 *          mark 用来点亮某个频道的未读标记
 */
export function mountGames({ host, rooms, current, onPick }) {
  host.replaceChildren()
  const buttons = new Map()
  const unread = new Set()
  let active = current

  rooms.forEach((room, index) => {
    // 兜底频道和具体游戏之间划一道线。按"前一个是不是兜底频道"判断，
    // 而不是写死下标：清单顺序改了也不会把线画错地方
    if (index > 0 && !rooms[index - 1].icon && room.icon) {
      host.append(el('div', 'divider'))
    }

    const node = el('button', 'game')
    node.title = room.hint ? `${room.name}：${room.hint}` : room.name
    node.setAttribute('aria-label', room.name)

    if (room.icon) {
      const img = el('img')
      img.src = room.icon
      img.alt = ''
      // 图标挂了就退回短标记，不留一个空框
      img.addEventListener('error', () => node.replaceChildren(el('span', null, room.short)))
      node.append(img)
    } else {
      node.append(el('span', null, room.short))
    }

    node.addEventListener('click', () => {
      if (active === room.id) return
      onPick(room.id)
    })

    buttons.set(room.id, node)
    host.append(node)
  })

  function paint() {
    for (const [id, node] of buttons) {
      node.classList.toggle('on', id === active)
      const dot = node.querySelector('.unread')
      // 当前频道不显示未读：人就在这儿看着
      if (unread.has(id) && id !== active) {
        if (!dot) node.append(el('span', 'unread'))
      } else if (dot) {
        dot.remove()
      }
    }
  }

  paint()

  return {
    setCurrent(id) {
      active = id
      unread.delete(id)
      rememberRoom(id)
      paint()
    },
    mark(id) {
      if (id === active || !buttons.has(id)) return
      unread.add(id)
      paint()
    },

    /**
     * 清掉未读标记。用于那条"新消息"已经过保留期被删掉的情况：
     * 标记还亮着，切过去却什么都没有。
     */
    clearMark(id) {
      if (!unread.delete(id)) return
      paint()
    },
  }
}
