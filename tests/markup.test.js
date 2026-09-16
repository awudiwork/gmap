/**
 * 消息标记解析的回归测试。
 *
 * 这块最容易出的问题不是"解析不出来"，而是"解析过头"：
 * 把别人正常打的星号、反引号、乘法算式误当成格式。下面一半用例是在守这个。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyMark, parseBlocks, parseInline } from '../public/js/markup.js'

test('没有围栏时整条消息是一个文本块', () => {
  assert.deepEqual(parseBlocks('北区已清'), [{ type: 'text', body: '北区已清' }])
})

test('围栏代码块被单独切出来', () => {
  const blocks = parseBlocks('看这段\n```js\nconst a = 1\n```\n跑一下')
  assert.deepEqual(blocks, [
    { type: 'text', body: '看这段' },
    { type: 'code', lang: 'js', body: 'const a = 1' },
    { type: 'text', body: '跑一下' },
  ])
})

test('围栏可以没有语言标记', () => {
  const blocks = parseBlocks('```\nplain\n```')
  assert.deepEqual(blocks, [{ type: 'code', lang: '', body: 'plain' }])
})

test('语言标记统一转小写', () => {
  assert.equal(parseBlocks('```JS\nx\n```')[0].lang, 'js')
})

test('代码块内部的缩进和空行原样保留', () => {
  const body = parseBlocks('```py\ndef f():\n    return 1\n\n```')[0].body
  assert.equal(body, 'def f():\n    return 1\n')
})

test('结尾围栏缺失时也能解析，不至于整条消息渲染失败', () => {
  const blocks = parseBlocks('```js\nconst a = 1')
  assert.deepEqual(blocks, [{ type: 'code', lang: 'js', body: 'const a = 1' }])
})

test('连续两个代码块之间没有空文本块', () => {
  const blocks = parseBlocks('```\na\n```\n```\nb\n```')
  assert.equal(blocks.length, 2)
  assert.ok(blocks.every((block) => block.type === 'code'))
})

test('行内加粗与代码', () => {
  assert.deepEqual(parseInline('看 **北区** 和 `map.png`'), [
    { type: 'plain', text: '看 ' },
    { type: 'bold', text: '北区' },
    { type: 'plain', text: ' 和 ' },
    { type: 'code', text: 'map.png' },
  ])
})

test('反引号里的星号不被当成加粗', () => {
  assert.deepEqual(parseInline('`a ** b`'), [{ type: 'code', text: 'a ** b' }])
})

test('裸链接被识别', () => {
  const tokens = parseInline('见 https://example.com/a?b=1 里')
  assert.deepEqual(tokens[1], { type: 'link', text: 'https://example.com/a?b=1' })
})

test('单个星号不触发加粗', () => {
  assert.deepEqual(parseInline('2 * 3 = 6'), [{ type: 'plain', text: '2 * 3 = 6' }])
})

test('加粗不跨行，避免把两段话粘成一块', () => {
  const tokens = parseInline('**开头\n结尾**')
  assert.deepEqual(tokens, [{ type: 'plain', text: '**开头\n结尾**' }])
})

test('空内容返回空 token 列表', () => {
  assert.deepEqual(parseInline(''), [])
  assert.deepEqual(parseBlocks(''), [])
})

test('加粗按钮包住选中内容并把选区留在里面', () => {
  const result = applyMark('北区', 'bold')
  assert.equal(result.text, '**北区**')
  assert.equal(result.text.slice(result.selectionStart, result.selectionEnd), '北区')
})

test('对已加粗的内容再按一次是取消加粗', () => {
  const result = applyMark('**北区**', 'bold')
  assert.equal(result.text, '北区')
  assert.equal(result.text.slice(result.selectionStart, result.selectionEnd), '北区')
})

test('没选内容时加粗把光标停在记号中间', () => {
  const result = applyMark('', 'bold')
  assert.equal(result.text, '****')
  assert.equal(result.selectionStart, 2)
  assert.equal(result.selectionEnd, 2)
})

test('代码块按钮用围栏包住选中内容', () => {
  const result = applyMark('const a = 1', 'codeBlock')
  assert.equal(result.text, '```\nconst a = 1\n```')
  assert.equal(result.text.slice(result.selectionStart, result.selectionEnd), 'const a = 1')
})

test('对已经是围栏的内容再按一次是脱掉围栏', () => {
  const result = applyMark('```js\nconst a = 1\n```', 'codeBlock')
  assert.equal(result.text, 'const a = 1')
})

test('行内代码同样可逆', () => {
  assert.equal(applyMark('x', 'inlineCode').text, '`x`')
  assert.equal(applyMark('`x`', 'inlineCode').text, 'x')
})

test('只有一对记号本身时不会被误判成已包裹', () => {
  // '**' 脱掉会得到空串，所以按"套上"处理：两个记号加原本的两个星号
  assert.equal(applyMark('**', 'bold').text, '******')
})
