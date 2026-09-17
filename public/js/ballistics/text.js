/**
 * 伤害计算器的中文文案。
 *
 * 规则：界面上的说明、部位、护甲、效果等级全部用中文；
 * 武器名、口径、弹种代号（FMJ / HP / AP）沿用游戏里的写法，
 * 玩家在游戏里看到的就是这些，翻了反而对不上号。
 */

export const HIT_ZONE = Object.freeze({
  head: '头部',
  neck: '颈部',
  torso_upper: '上躯干',
  torso_middle: '中躯干',
  torso_lower: '下躯干',
  pelvis: '骨盆',
  arm_upper: '上臂',
  arm_lower: '前臂',
  arm_hand: '手部',
  leg_thigh: '大腿',
  leg_calf: '小腿',
  leg_foot: '脚部',
})

/** 弹种全名，代号保留 */
export const ROUND_NAME = Object.freeze({
  FMJ: '标准弹 (FMJ)',
  HollowPoint: '扩张弹 (HP)',
  ArmorPiercing: '穿甲弹 (AP)',
})

export const WEAPON_CLASS = Object.freeze({
  'Assault Rifle': '突击步枪',
  'Submachine Gun': '冲锋枪',
  'Light Machine Gun': '轻机枪',
  Shotgun: '霰弹枪',
  'Marksman Rifle': '精确射手步枪',
  'Sniper Rifle': '狙击步枪',
  Pistol: '手枪',
  'Combat Bow': '复合弓',
})

/** 表格里跟在武器名后面的短标记，放不下全名 */
export const WEAPON_CLASS_SHORT = Object.freeze({
  'Assault Rifle': 'AR',
  'Submachine Gun': 'SMG',
  'Light Machine Gun': 'LMG',
  Shotgun: '霰弹',
  'Marksman Rifle': 'DMR',
  'Sniper Rifle': '狙击',
  Pistol: '手枪',
  'Combat Bow': '弓',
})

/** "Level 2 Armor" 这类名字转成中文，认不出的原样返回 */
export function armourName(name) {
  const match = /^Level (\d) (Armor|Helmet)$/.exec(name ?? '')
  if (!match) return name ?? ''
  return `${match[1]} 级${match[2] === 'Armor' ? '护甲' : '头盔'}`
}

/** 击杀弹数的七档，从最差到最好 */
export const SHOT_BAND_TEXT = Object.freeze([
  { label: '无效', description: '打多少发都不可能打穿' },
  { label: '绝望', description: '要打掉大半个弹匣才见效' },
  { label: '只能倾泻', description: '只有按住扳机不松、还全都命中才赢得下来' },
  { label: '略有效', description: '能用，但一个点射远远不够' },
  { label: '有效', description: '一个可控的点射就能击杀' },
  { label: '很有效', description: '两连发击杀' },
  { label: '一枪毙命', description: '一枪一个' },
].map(Object.freeze))

/** 击杀时间的七档，从最差到最好 */
export const TIME_BAND_TEXT = Object.freeze([
  { label: '无效', description: '对面过完马路换完弹匣，这边还没打死' },
  { label: '交火吃亏', description: '任何以正常射速还击的人都先赢' },
  { label: '慢', description: '足够对方脱离视线' },
  { label: '勉强可用', description: '能杀，前提是全程压住不脱靶' },
  { label: '有效', description: '大约就是对方做出反应的时间' },
  { label: '很有效', description: '对方还没还上枪就倒了' },
  { label: '瞬杀', description: '没有还手的时间' },
].map(Object.freeze))
