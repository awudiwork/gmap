/**
 * 从 @phosphor-icons/core 生成 public/vendor/icons.svg。
 *
 *   pnpm build:icons
 *
 * 为什么要有这个脚本：界面用到的图标不手写 path，全部来自官方图标库，
 * 线宽和视觉重量才会一致。下面这份清单就是"界面用到哪些图标"的唯一来源，
 * 增删图标改这里再重新生成，不要手工编辑 icons.svg。
 *
 * tests/assets.test.js 会双向校验：引用了但 sprite 里没有的会失败，
 * sprite 里有但没人引用的也会失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'public', 'vendor', 'icons.svg')

/**
 * 界面里绝大多数动作用文字标签，符合终端的语言习惯。
 * 只有这几处图标比文字更省地方或更准确，才留下来。
 */
const ICONS = [
  'list',                    // 窄屏展开侧栏
  'arrow-down',              // 回到最新
  'bell-simple', 'bell-simple-slash', // 按人开关自动展开
  'download-simple',         // 附件下载
  'copy',                    // 复制
  'check', 'warning-circle', // toast 的两种结果
  'trash', 'plus', 'arrow-counter-clockwise', // 删除 / 新建 / 重置
  'corners-out', 'magnifying-glass-plus', 'arrow-square-out', 'x', // 看图器

  // 伤害计算器
  'calculator',                                   // 标题栏上的入口
  'caret-down', 'caret-up', 'caret-up-down',      // 折叠 / 排序
  'magnifying-glass',                             // 选枪搜索
  'shield-check', 'shield-slash',                 // 护甲挡住 / 被打穿
  'crosshair-simple', 'timer',                    // 伤害 / 时间
  'person', 'chart-line',                         // 视图标签
  'link-simple',                                  // 分享链接
]

function resolveAssetsDir() {
  const require = createRequire(import.meta.url)
  try {
    return path.join(path.dirname(require.resolve('@phosphor-icons/core/package.json')), 'assets', 'regular')
  } catch {
    // 包的 exports 字段可能不暴露 package.json，退回到目录扫描
    const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm')
    const match = fs.readdirSync(pnpmDir).find((name) => name.startsWith('@phosphor-icons+core@'))
    if (!match) throw new Error('找不到 @phosphor-icons/core，请先执行 pnpm install')
    return path.join(pnpmDir, match, 'node_modules', '@phosphor-icons', 'core', 'assets', 'regular')
  }
}

const assetsDir = resolveAssetsDir()
const missing = []
const symbols = []

for (const name of ICONS) {
  const file = path.join(assetsDir, `${name}.svg`)
  if (!fs.existsSync(file)) {
    missing.push(name)
    continue
  }
  const inner = fs.readFileSync(file, 'utf8')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim()
  symbols.push(`<symbol id="i-${name}" viewBox="0 0 256 256">${inner}</symbol>`)
}

if (missing.length > 0) {
  console.error(`这些图标在 Phosphor regular 里不存在：${missing.join(', ')}`)
  process.exit(1)
}

const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">\n${symbols.join('\n')}\n</svg>\n`
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, sprite)
console.log(`已生成 ${path.relative(ROOT, OUT)}，${symbols.length} 个图标，${(sprite.length / 1024).toFixed(1)} KB`)
