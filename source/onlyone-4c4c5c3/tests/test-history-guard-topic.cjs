'use strict'
// break-4 Н7: охрана history-guard снималась целиком при несовпадении темы, даже
// когда заметка агента на месте. Переименование темы человеком — не удаление
// заметки: reconcile трактовал это как «удалили» и очищал pending для всех окон,
// после чего устаревшая копия другого окна теряла заметку. После правки заметка
// переживает переименование темы и устаревшее сохранение второго окна.
const assert = require('node:assert/strict')
const guard = require('../src/main/history-guard.js')

const NOTE = { role: 'assistant', content: 'ЗАМЕТКА', fromAgentNote: true, timestamp: 20 }
const chatWith = (topic, withNote) => ({
  id: 'a', topic,
  messages: withNote ? [{ role: 'user', content: 'u', timestamp: 1 }, NOTE] : [{ role: 'user', content: 'u', timestamp: 1 }]
})
const contents = list => (list.find(c => c.id === 'a')?.messages || []).map(m => m.content)

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

// Н7: заметка+тема одной записью, человек переименовал тему, второе окно шлёт устаревшую копию.
check('Н7: заметка переживает переименование темы и устаревшую копию второго окна', () => {
  const g = guard.create()
  g.wrote({ chat: chatWith('T', true), note: NOTE, topic: 'T' }, [1, 2])
  g.seen(1, [chatWith('T', true)])
  g.reconcile(1, [chatWith('T2', true)])            // человек переименовал тему, заметка на месте
  const out = g.reconcile(2, [chatWith('T', false)]) // устаревшая копия второго окна без заметки
  assert.ok(contents(out).includes('ЗАМЕТКА'), 'заметка агента потеряна после переименования темы')
})

check('Н7: переименование темы человеком не затирается обратно темой агента', () => {
  const g = guard.create()
  g.wrote({ chat: chatWith('T', true), note: NOTE, topic: 'T' }, [1])
  g.seen(1, [chatWith('T', true)])
  const out = g.reconcile(1, [chatWith('T2', true)])
  assert.equal(out.find(c => c.id === 'a').topic, 'T2', 'новая тема человека затёрта темой агента')
})

// Отрицательный контроль: настоящее удаление заметки всё ещё учитывается.
check('контроль: удалённая человеком заметка не возвращается устаревшей копией второго окна', () => {
  const g = guard.create()
  g.wrote({ chat: chatWith('T', true), note: NOTE, topic: 'T' }, [1, 2])
  g.seen(1, [chatWith('T', true)])
  g.reconcile(1, [chatWith('T', false)])            // человек удалил заметку (тема та же)
  const out = g.reconcile(2, [chatWith('T', false)]) // устаревшая копия второго окна
  assert.ok(!contents(out).includes('ЗАМЕТКА'), 'удалённая заметка воскресла')
})

// Контроль: раздельные записи заметки и темы (как в main.js) — заметка цела.
check('контроль: раздельные записи заметки и темы — заметка переживает переименование', () => {
  const g = guard.create()
  g.wrote({ chat: chatWith(undefined, true), note: NOTE }, [1, 2])
  g.wrote({ chat: chatWith('T', true), topic: 'T' }, [1, 2])
  g.seen(1, [chatWith('T', true)])
  g.reconcile(1, [chatWith('T2', true)])
  const out = g.reconcile(2, [chatWith('T', false)])
  assert.ok(contents(out).includes('ЗАМЕТКА'), 'заметка потеряна при раздельных записях')
})

// Контроль: тема агента без заметки по-прежнему применяется, когда её нет.
check('контроль: тема агента применяется к сохранению без темы', () => {
  const g = guard.create()
  g.wrote({ chat: { id: 'a' }, topic: 'тема агента' }, [7])
  const out = g.reconcile(7, [{ id: 'a', messages: [] }])
  assert.equal(out[0].topic, 'тема агента')
})

if (failed) process.exit(1)
console.log('ok test-history-guard-topic')