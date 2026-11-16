// Счёт токенов хода в окне. Главный процесс шлёт два события: `agent-progress` после каждого шага —
// НАКОПЛЕННЫЙ итог текущего прогона агента, и `message-complete` в конце прогона — тот же итог ещё раз.
// Окно записывало первое и прибавляло второе: один агент на 10 000 токенов показывался как 20 000,
// а в команде прогресс второго агента затирал расход первого. Здесь — правила подсчёта и проводка в окне.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const tally = require('../src/renderer/token-tally.js')
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')

test('один агент: прогресс по шагам и завершение не удваивают итог', () => {
  const s = tally.fresh()
  assert.equal(tally.progress(s, 0, 3000), 3000)
  assert.equal(tally.progress(s, 0, 7000), 7000)
  assert.equal(tally.progress(s, 0, 10000), 10000)
  assert.equal(tally.complete(s, 0, 10000), 10000)
})

test('команда: расход агентов складывается, прогресс одного не затирает другого', () => {
  const s = tally.fresh()
  tally.progress(s, 0, 4000)
  tally.progress(s, 1, 1500)
  assert.equal(tally.total(s), 5500)
  tally.complete(s, 1, 2000)
  assert.equal(tally.progress(s, 0, 6000), 8000)
  assert.equal(tally.complete(s, 0, 6000), 8000)
})

test('тот же агент во втором прогоне (доработка) прибавляется к первому', () => {
  const s = tally.fresh()
  tally.progress(s, 0, 5000)
  tally.complete(s, 0, 5000)
  assert.equal(tally.progress(s, 0, 1000), 6000)
  assert.equal(tally.complete(s, 0, 2500), 7500)
})

test('новый прогон без завершения прежнего не теряет прежний расход', () => {
  const s = tally.fresh()
  tally.progress(s, 2, 9000)
  // счётчик прогона начался заново — значит, прежний кончился без message-complete
  assert.equal(tally.progress(s, 2, 800), 9800)
})

test('завершение без прогресса (ход без инструментов) учитывается', () => {
  const s = tally.fresh()
  assert.equal(tally.complete(s, 0, 1234), 1234)
  assert.equal(tally.complete(s, 0, 0), 1234)
  assert.equal(tally.complete(s, 0, undefined), 1234)
})

test('окно не прибавляет итог прогона поверх прогресса', () => {
  assert.doesNotMatch(app, /pane\.totalTokens \+= /, 'в app.js осталось pane.totalTokens += …')
  assert.match(app, /OnlyoneTokenTally\.progress\(/, 'agent-progress не идёт через счёт')
  assert.match(app, /OnlyoneTokenTally\.complete\(/, 'message-complete не идёт через счёт')
})

test('счёт хода сбрасывается и переживает переключение диалога вместе с итогом', () => {
  const resets = app.match(/pane\.totalTokens = 0/g) || []
  const tallyResets = app.match(/pane\.tokenTally = null/g) || []
  assert.ok(resets.length >= 2 && tallyResets.length >= resets.length, 'итог обнуляется, а счёт агентов — нет')
  assert.match(app, /turn\.tokenTally = pane\.tokenTally/, 'счёт не сохраняется с живым ходом')
  assert.match(app, /pane\.tokenTally = liveTurn\.tokenTally/, 'счёт не восстанавливается с живым ходом')
})

test('модуль подключён в окне раньше app.js', () => {
  const at = html.indexOf('token-tally.js')
  assert.ok(at > 0 && at < html.indexOf('src="app.js"'), 'token-tally.js не подключён до app.js')
})
