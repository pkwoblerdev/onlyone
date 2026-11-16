// Инициатива 5 (11.10.2026): чек-листы и доска умирали вместе с ходом, и в следующем сообщении агент не помнил, что осталось
// незакрытым. Теперь незакрытое переносится между сообщениями ОДНОГО диалога: на диск, коротким блоком в хвосте промпта,
// с пометкой, что это записи самого агента, а не проверенный факт. Закрытое не переносится.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { collectOpen, renderCarryover, createSessionTaskStore, MAX_ITEMS, MAX_BLOCK } = require('../src/main/session-tasks.cjs')

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-session-')), 'session-tasks.json')

check('в перенос идут только незакрытые пункты чек-листов и доски', () => {
  const items = collectOpen({
    plans: [[{ id: 'a', title: 'Кнопка отмены прерывает запрос', status: 'doing' }, { id: 'b', title: 'Тесты зелёные', status: 'done' }]],
    board: [{ agent: 'Агент 2', title: 'Вёрстка', task: 'сверстать', status: 'blocked', note: 'нет макета' }, { agent: 'Агент 3', title: 'Ревью', status: 'done' }]
  })
  assert.equal(items.length, 2)
  assert.ok(items.some(i => /Кнопка отмены/.test(i.title) && i.status === 'doing'))
  assert.ok(items.some(i => /Вёрстка/.test(i.title) && i.status === 'blocked' && /нет макета/.test(i.note)))
})

check('нечего переносить — пустой блок', () => {
  assert.deepEqual(collectOpen({ plans: [[{ id: 'a', title: 'x', status: 'done' }]], board: [] }), [])
  assert.equal(renderCarryover([]), '')
  assert.deepEqual(collectOpen({}), [])
})

check('блок назван недоверенным и короткий', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ title: 'пункт номер ' + i + ' ' + 'очень длинное название '.repeat(10), status: 'todo', owner: 'Агент 2' }))
  const text = renderCarryover(items)
  assert.match(text, /не проверен|записи агента|проверь/i)
  assert.ok(text.length <= MAX_BLOCK, 'длина ' + text.length)
  assert.ok((text.match(/\n- /g) || []).length <= MAX_ITEMS)
})

check('collectOpen ограничивает число пунктов', () => {
  const plan = Array.from({ length: 40 }, (_, i) => ({ id: 'i' + i, title: 'пункт ' + i, status: 'todo' }))
  assert.equal(collectOpen({ plans: [plan], board: [] }).length, MAX_ITEMS)
})

check('два сообщения одного диалога: пункты первого видны во втором, чужой диалог их не видит', () => {
  const file = tmp()
  const first = createSessionTaskStore(file)
  first.set('chat-A', [{ title: 'Дописать тест отмены', status: 'doing', owner: 'Агент 1' }])
  const second = createSessionTaskStore(file) // «следующее сообщение» — новый разговор с хранилищем, в том числе после перезапуска
  assert.match(renderCarryover(second.get('chat-A')), /Дописать тест отмены/)
  assert.deepEqual(second.get('chat-B'), [])
})

check('пусто после хода — запись диалога снимается, закрытое не всплывает', () => {
  const file = tmp()
  const store = createSessionTaskStore(file)
  store.set('chat-A', [{ title: 'x', status: 'todo' }])
  store.set('chat-A', [])
  assert.deepEqual(createSessionTaskStore(file).get('chat-A'), [])
  assert.ok(!/chat-A/.test(fs.readFileSync(file, 'utf8')), 'запись осталась в файле')
})

check('испорченный файл не роняет ход', () => {
  const file = tmp(); fs.writeFileSync(file, '{не json')
  const store = createSessionTaskStore(file)
  assert.deepEqual(store.get('chat-A'), [])
  store.set('chat-A', [{ title: 'после порчи', status: 'todo' }])
  assert.equal(store.get('chat-A')[0].title, 'после порчи')
})

check('хранилище помнит не больше 60 диалогов, свежие остаются', () => {
  const store = createSessionTaskStore(tmp())
  for (let i = 0; i < 80; i++) store.set('chat-' + i, [{ title: 'п' + i, status: 'todo' }])
  assert.deepEqual(store.get('chat-0'), [])
  assert.equal(store.get('chat-79')[0].title, 'п79')
})

check('main.js: незакрытое сохраняется по диалогу в конце хода и подаётся в хвост промпта', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.ok(/require\('\.\/session-tasks\.cjs'\)/.test(main), 'нет в main.js: ' + String(/require\('\.\/session-tasks\.cjs'\)/))
  assert.ok(/rememberOpenWork\(/.test(main), 'нет в main.js: ' + String(/rememberOpenWork\(/))
  assert.ok(/renderCarryover\(/.test(main), 'нет в main.js: ' + String(/renderCarryover\(/))
})

if (failed) process.exit(1)
console.log('Память незакрытого между сообщениями: проверки пройдены')
