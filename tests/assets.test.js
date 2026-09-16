/**
 * 前端静态资产的一致性检查。
 *
 * 这几条都是"错了也不报错、只是悄悄变难看"的类型：
 * 图标名拼错只会渲染出一个空白方块，em-dash 混进文案只有肉眼能发现。
 * 做成测试才能在每次改动后自动兜住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')

/** 递归收集 public 下指定后缀的文件 */
function collect(dir, extensions, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collect(full, extensions, found)
    else if (extensions.includes(path.extname(entry.name))) found.push(full)
  }
  return found
}

const sourceFiles = collect(PUBLIC, ['.html', '.js', '.css'])
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/')

test('sprite 里存在被引用的每一个图标', () => {
  const sprite = fs.readFileSync(path.join(PUBLIC, 'vendor', 'icons.svg'), 'utf8')
  const available = new Set([...sprite.matchAll(/id="i-([a-z0-9-]+)"/g)].map((m) => m[1]))
  assert.ok(available.size > 0, 'sprite 应当包含图标')

  const missing = []
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/#i-([a-z0-9-]+)/g)) {
      if (!available.has(match[1])) missing.push(`${rel(file)} 引用了不存在的图标 ${match[1]}`)
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'))
})

test('sprite 里没有无人引用的图标', () => {
  const sprite = fs.readFileSync(path.join(PUBLIC, 'vendor', 'icons.svg'), 'utf8')
  const available = [...sprite.matchAll(/id="i-([a-z0-9-]+)"/g)].map((m) => m[1])
  const allText = sourceFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n')

  // 图标有三种引用写法：HTML 里的 #i-name、JS 里的 icon('name')、
  // 以及作为变量传给 icon() 的字符串字面量。三者都要算数。
  const unused = available.filter(
    (name) => !allText.includes(`#i-${name}`) && !allText.includes(`'${name}'`) && !allText.includes(`"${name}"`),
  )
  assert.deepEqual(unused, [], `sprite 里有多余图标，从 build-sprite 的清单里删掉：${unused.join(', ')}`)
})

test('界面文案里没有 em-dash 或 en-dash', () => {
  const offenders = []
  for (const file of sourceFiles) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (/[—–]/.test(line)) offenders.push(`${rel(file)}:${index + 1}  ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

/** 注释行不算界面文案，这几条规则只管用户看得见的字符串 */
const isComment = (line) => /^\s*(\/\/|\/\*|\*|<!--)/.test(line)

test('单行文案里的间隔号不超过一个', () => {
  const offenders = []
  for (const file of sourceFiles) {
    if (file.endsWith('.css')) continue
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (isComment(line)) return
      const count = (line.match(/·/g) ?? []).length
      if (count > 1) offenders.push(`${rel(file)}:${index + 1}  出现 ${count} 个间隔号  ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test('页面引用的本地资源都真实存在', () => {
  const missing = []
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8')
    // 抓 href/src/url() 里以 / 开头的本地路径
    const refs = [
      ...[...text.matchAll(/(?:href|src)="(\/[^"#?]+)/g)].map((m) => m[1]),
      ...[...text.matchAll(/url\("(\/[^"#?]+)/g)].map((m) => m[1]),
    ]
    for (const ref of refs) {
      if (ref.startsWith('/api/')) continue
      if (!fs.existsSync(path.join(PUBLIC, ref))) missing.push(`${rel(file)} 引用了不存在的 ${ref}`)
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'))
})

test('没有监听全局滚动', () => {
  // 容器上的 scroll 监听是正常的；挂在 window / document 上才会每帧触发且无法节流
  const offenders = []
  for (const file of sourceFiles.filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(file, 'utf8')
    if (/(window|document)\.addEventListener\(\s*['"]scroll['"]/.test(text)) offenders.push(rel(file))
    if (/\bwindow\.scrollY\b/.test(text)) offenders.push(`${rel(file)} 直接读取了 window.scrollY`)
  }
  assert.deepEqual(offenders, [], `应当用容器滚动或 IntersectionObserver：${offenders.join(', ')}`)
})

test('脚本取用的 id 在页面上都存在', () => {
  // 改 HTML 时漏改 JS 的 id 会直接白屏，而且语法检查抓不到
  const html = ['index.html', 'login.html'].map((name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8')).join('\n')
  const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))

  const missing = []
  for (const file of sourceFiles.filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) {
      if (!declared.has(match[1])) missing.push(`${rel(file)} 取用了页面上没有的 id：${match[1]}`)
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'))
})

test('界面文案里没有装饰性箭头', () => {
  // 按钮和链接文字后缀一个 → 是最典型的生成痕迹
  const offenders = []
  for (const file of sourceFiles) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (isComment(line)) return
      if (/[→←⇒➔➜]/.test(line)) offenders.push(`${rel(file)}:${index + 1}  ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})
