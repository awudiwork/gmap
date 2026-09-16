/**
 * 编辑器序列化的回归测试。
 *
 * serialize 只读 nodeType / nodeName / data / childNodes 四个字段，
 * 所以这里用普通对象搭出节点树，不需要 jsdom 之类的 DOM 实现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { serialize } from '../public/js/editor.js'

const text = (data) => ({ nodeType: 3, data })
const tag = (nodeName, ...childNodes) => ({ nodeType: 1, nodeName, childNodes })
const root = (...childNodes) => tag('DIV', ...childNodes)

/** 模拟 readValue：逐个序列化根的子节点 */
const readAll = (node) => node.childNodes.map(serialize).join('')

test('纯文本原样输出', () => {
  assert.equal(readAll(root(text('北区已清'))), '北区已清')
})

test('加粗序列化成双星号', () => {
  assert.equal(readAll(root(text('看 '), tag('STRONG', text('北区')))), '看 **北区**')
})

test('浏览器生成的 B 标签同样识别', () => {
  assert.equal(readAll(root(tag('B', text('x')))), '**x**')
})

test('行内代码序列化成反引号', () => {
  assert.equal(readAll(root(tag('CODE', text('map.png')))), '`map.png`')
})

test('代码块序列化成围栏', () => {
  assert.equal(serialize(tag('PRE', text('const a = 1'))), '\n```\nconst a = 1\n```\n')
})

test('代码块末尾多余的换行被吃掉，不会产出空行', () => {
  assert.equal(serialize(tag('PRE', text('const a = 1\n'))), '\n```\nconst a = 1\n```\n')
})

test('BR 变成换行', () => {
  assert.equal(readAll(root(text('上'), tag('BR'), text('下'))), '上\n下')
})

test('粘贴产生的 DIV 每个算一行', () => {
  assert.equal(readAll(root(tag('DIV', text('一')), tag('DIV', text('二')))), '一\n二\n')
})

test('空的加粗节点不留下孤零零的星号', () => {
  assert.equal(readAll(root(tag('STRONG'), text('x'))), 'x')
  assert.equal(readAll(root(tag('STRONG', text('   ')), text('x'))), '   x')
})

test('空的行内代码同样不留记号', () => {
  assert.equal(readAll(root(tag('CODE'), text('x'))), 'x')
})

test('嵌套结构按深度展开', () => {
  const tree = root(tag('STRONG', text('粗'), tag('CODE', text('码'))))
  assert.equal(readAll(tree), '**粗`码`**')
})

test('不认识的标签只取其中的文字', () => {
  assert.equal(readAll(root(tag('SPAN', text('x')), tag('EM', text('y')))), 'xy')
})

test('注释之类的非元素节点被忽略', () => {
  assert.equal(serialize({ nodeType: 8, data: '注释' }), '')
  assert.equal(serialize(null), '')
})

test('标签名大小写不敏感', () => {
  assert.equal(serialize(tag('strong', text('x'))), '**x**')
})

test('一条混合消息的完整往返', () => {
  const tree = root(
    text('看 '),
    tag('STRONG', text('北区')),
    text(' 和 '),
    tag('CODE', text('map.png')),
    tag('PRE', text('const a = 1')),
    text('跑一下'),
  )
  assert.equal(readAll(tree), '看 **北区** 和 `map.png`\n```\nconst a = 1\n```\n跑一下')
})
