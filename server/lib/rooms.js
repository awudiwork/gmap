/**
 * 房间清单。
 *
 * 为什么硬编码而不是建一张表：房间对应的是具体游戏，数量有限，而且每个游戏
 * 迟早要带上自己的东西（地图画幅、坐标系、裁剪提示、专属的客户端参数）。
 * 那些逻辑写在代码里比塞进数据库好维护，也让"加一个游戏"这件事有唯一的落点。
 *
 * 加新游戏的步骤：
 *   1. 把图标放进 public/games/
 *   2. 在下面加一条
 *   3. tests/rooms.test.js 会校验 id 合法、图标文件真实存在
 *
 * id 会直接写进数据库和 URL，定下来就不要改，否则历史消息会落到一个不存在的房间里。
 *
 * tools 是这个频道在标题栏上挂的专属工具，前端按 id 找对应模块（见 public/js/tools.js）。
 * 清单放在服务端而不是前端写死，是让"这个游戏有什么"只有一处定义。
 */
// 逐项冻结：Object.freeze 是浅的，只冻数组的话 ROOMS[0].name = 'x' 照样改得动，
// 而这个对象会被直接 res.json 出去，改一次就影响所有客户端
export const ROOMS = Object.freeze([
  {
    id: 'all',
    name: '全部',
    short: 'ALL',
    icon: null,
    hint: '没有单独频道的游戏都发这里',
    tools: Object.freeze([]),
  },
  {
    id: 'wardogs',
    name: 'Wardogs',
    short: 'WD',
    icon: '/games/wardogs.webp',
    hint: '战狗',
    // 顺序就是标题栏上按钮的顺序
    tools: Object.freeze(['intel', 'ballistics']),
  },
].map(Object.freeze))

/** 前端认识的工具 id，清单里写了别的会在测试里报出来 */
export const TOOL_IDS = Object.freeze(['ballistics', 'intel'])

/** 没指定房间时落在哪儿 */
export const DEFAULT_ROOM = 'all'

const IDS = new Set(ROOMS.map((room) => room.id))

export const isRoom = (id) => typeof id === 'string' && IDS.has(id)

/**
 * 把外部传来的房间 id 收敛成合法值。
 * 认不出来的一律落到默认房间，而不是报错：客户端可能是个老版本，
 * 把图推丢了比推错房间更糟。
 */
export const normalizeRoom = (id) => (isRoom(id) ? id : DEFAULT_ROOM)
