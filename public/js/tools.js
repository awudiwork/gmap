/**
 * 频道专属工具。服务端的房间清单里写了 tools: ['ballistics'] 之类的 id，
 * 这里按 id 找到对应的模块，在标题栏上挂按钮。
 *
 * 模块契约：export { open({ query }), hashQuery() }。
 * 模块按需加载：计算器那一坨代码只有点了才拉，不拖慢聊天室首屏。
 */
import { el, icon, toast } from './ui.js'

const TOOLS = Object.freeze({
  ballistics: {
    label: '伤害计算',
    icon: 'calculator',
    /** 分享链接的 hash 前缀，也说明了它属于哪个频道 */
    hash: '#wardogs/ballistics',
    load: () => import('./ballistics/index.js'),
  },
})

/** 把当前频道的工具按钮渲染到标题栏。频道没有工具时清空 */
export function mountTools(host, room) {
  host.replaceChildren()
  for (const id of room?.tools ?? []) {
    const tool = TOOLS[id]
    if (!tool) continue
    const button = el('button', 'slim tool')
    button.append(icon(tool.icon), el('span', null, tool.label))
    button.addEventListener('click', () => {
      tool.load()
        .then((mod) => mod.open())
        .catch(() => toast('工具加载失败，刷新后再试', 'bad'))
    })
    host.append(button)
  }
}

const toolForHash = () => Object.values(TOOLS).find((tool) => location.hash.startsWith(tool.hash)) ?? null

/**
 * 地址栏里带着工具的 hash（分享链接、刷新页面）时直接打开它。
 * @returns {Promise<boolean>} 是否打开了什么
 */
export async function openToolFromHash() {
  const tool = toolForHash()
  if (!tool) return false
  const mod = await tool.load()
  const query = mod.hashQuery()
  if (query === null) return false
  await mod.open({ query })
  return true
}

/** 分享链接指向的频道，进页面时先切过去，关掉工具后人就在对的地方 */
export function roomFromHash() {
  const match = /^#([a-z0-9-]+)\//.exec(location.hash)
  return match ? match[1] : null
}
