// break-2 Н5: createdAt записи возврата итога всегда 0 — app.js передаёт now внутри
// input (второй аргумент put), а модуль читает options.now (третий) и input.createdAt,
// игнорируя input.now. Метаданные реестра недостоверны навсегда (запись идемпотентна).
//
// Отрицательные контроли: документированный вызов put(chat, input, {now}) даёт createdAt;
// input.createdAt как запасной источник; без времени — 0.
'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const forkReturn = require(path.join(__dirname, '..', 'src', 'renderer', 'fork-return.js'))

let failed = 0
let total = 0
function check (name, fn) {
  total++
  try { fn(); console.log('  ok  ' + name) } catch (error) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message)) }
}

const input = now => ({ operationId: 'op-12345678', childChatId: 'child', messageKey: 't:1', text: 'Итог задачи', now })

// Н5: форма вызова точно как app.js — now внутри input.
check('Н5: now внутри input даёт createdAt (форма app.js)', () => {
  const chat = { id: 'parent' }
  const res = forkReturn.put(chat, input(1234567890))
  assert.equal(res.ok, true)
  assert.equal(res.record.createdAt, 1234567890, 'createdAt всегда 0: ' + res.record.createdAt)
})

// Контроль: документированный вызов с options.now.
check('Н5 контроль: options.now даёт createdAt', () => {
  const chat = { id: 'parent' }
  const { now, ...rest } = input(0)
  const res = forkReturn.put(chat, rest, { now: 555 })
  assert.equal(res.record.createdAt, 555)
})

// Контроль: options.now приоритетнее input.now.
check('Н5 контроль: options.now приоритетнее input.now', () => {
  const chat = { id: 'parent' }
  const res = forkReturn.put(chat, input(111), { now: 222 })
  assert.equal(res.record.createdAt, 222)
})

// Контроль: input.createdAt как запасной источник.
check('Н5 контроль: input.createdAt запасной', () => {
  const chat = { id: 'parent' }
  const { now, ...rest } = input(0)
  const res = forkReturn.put(chat, { ...rest, createdAt: 777 })
  assert.equal(res.record.createdAt, 777)
})

// Контроль: без времени — 0.
check('Н5 контроль: без времени createdAt 0', () => {
  const chat = { id: 'parent' }
  const { now, ...rest } = input(0)
  const res = forkReturn.put(chat, rest)
  assert.equal(res.record.createdAt, 0)
})

console.log(`\n${total - failed}/${total} ok`)
if (failed) process.exit(1)