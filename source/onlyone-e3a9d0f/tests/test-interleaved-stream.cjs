const assert = require('node:assert/strict')
// Настоящий код разделения и слияния блоков ленты — в модуле (план, 2d).
// Instantiate the real module so the merger keeps its private redaction helpers
// in scope. Re-evaluating a source slice worked only while pushBlock had no
// dependencies, then failed at runtime after tool text was made secret-safe.
const { pushThinking, pushBlock } = require('../src/renderer/message-blocks.js').create({})
const pane = {blocks:[]}
const pieces = ['Метод ', 'send', 'Message ', 'существует.']
for (const text of pieces) {
  pushThinking(pane,text,'Агент 2')
  pushThinking(pane,text,'Агент 3')
}
assert.equal(pane.blocks.length,2)
for(const block of pane.blocks) assert.equal(block.text,pieces.join(''))
pushBlock(pane,'tool','read_file completed','Агент 2')
pushThinking(pane,'После чтения.','Агент 2')
pushThinking(pane,' Продолжаю.','Агент 3')
assert.equal(pane.blocks.length,4)
assert.equal(pane.blocks[1].text,pieces.join('')+' Продолжаю.')
assert.equal(pane.blocks[3].text,'После чтения.')
const textPane={blocks:[]}
for(const word of ['Ответ ', 'содержит ', 'слова.']) {
  pushBlock(textPane,'text',word,'Агент 2')
  pushThinking(textPane,word,'Агент 3')
}
assert.equal(textPane.blocks.length,2)
assert.equal(textPane.blocks[0].text,'Ответ содержит слова.')
const headings={blocks:[]}
pushThinking(headings,'Разбор. '.repeat(40),'Агент 2')
pushThinking(headings,'Чужой поток.','Агент 3')
pushThinking(headings,'## Проверка\nПроверяю результат.','Агент 2')
assert.equal(headings.blocks.length,3)
assert.equal(headings.blocks[0].closed,true)
assert.ok(headings.blocks[2].text.startsWith('## Проверка'))
// Simulate character-sized chunks from multiple models.
const chars={blocks:[]}, expected='preload: sendMessage есть; слово не разрывается.'
for(const char of expected) for(const agent of ['Агент 1','Агент 2','Агент 3']) pushThinking(chars,char,agent)
assert.equal(chars.blocks.length,3)
assert.ok(chars.blocks.every(block=>block.text===expected))
console.log('PASS: interleaved production streams, exact text, own tool boundaries, per-agent headings')
