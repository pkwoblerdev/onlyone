// Текущее время в запросе модели. Агент не знает, который час: в промпте не было ни даты, ни времени, а «Get-Date» в оболочке
// cmd.exe не существует, `date -u` ждёт ввода и вешает ход на таймаут. Из-за этого шестичасовой тест с пятиминутными окнами
// не мог привязать ни одной записи ко времени. Строка времени живёт в хвосте запроса (она меняется каждую минуту) и
// отдаётся готовой, вместе с UTC: рынки и графики живут по UTC и по времени биржи.
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { clockNote } = require('../src/main/clock-note.cjs')

let failed = 0
function check (name, fn) {
  try { fn(); console.log('  ok  ' + name) } catch (error) { failed++; console.error('ПРОВАЛ ' + name + ' — ' + error.message) }
}

// 2026-10-14 12:55:30 UTC = 15:55 в UTC+3
const now = new Date(Date.UTC(2026, 9, 14, 12, 55, 30))

check('строка называет местное время, UTC и день недели', () => {
  const note = clockNote(now, -180)
  assert.match(note, /14\.10\.2026/, note)
  assert.match(note, /15:55/, note)
  assert.match(note, /UTC\+3/, note)
  assert.match(note, /12:55 UTC/, note)
  assert.match(note, /среда/i, note)
})

check('смещение к западу от Гринвича показывается со знаком минус', () => {
  const note = clockNote(now, 240) // UTC-4: 08:55
  assert.match(note, /08:55/, note)
  assert.match(note, /UTC-4/, note)
})

check('дробное смещение (UTC+5:30) не теряет минуты', () => {
  const note = clockNote(now, -330)
  assert.match(note, /18:25/, note)
  assert.match(note, /UTC\+5:30/, note)
})

check('границы окон: время до секунд и граница ближайшего пятиминутного окна', () => {
  const note = clockNote(now, -180)
  assert.match(note, /12:55:30/, 'в строке нет секунд: окна по 5 минут без них не посчитать')
  assert.match(note, /13:00:00 UTC/, 'нет границы следующего 5-минутного окна')
})

check('невалидная дата не роняет запрос', () => {
  assert.equal(clockNote(new Date('нет'), 0), '')
})

check('главный процесс кладёт строку в хвост запроса, а не в постоянную часть', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  assert.match(main, /clockNote\(new Date\(\), new Date\(\)\.getTimezoneOffset\(\)\)/, 'clockNote не вызывается с текущим временем')
  const tail = main.slice(main.indexOf('buildCarryoverBlock(agentName),'), main.indexOf('buildCarryoverBlock(agentName),') + 300)
  assert.match(tail, /clockNote/, 'строка времени не в хвосте запроса (она меняется каждую минуту и ломает кэш префикса, если стоит в середине)')
})

check('описание run_command предупреждает, что оболочка — cmd.exe', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  assert.match(main, /оболочка — cmd\.exe/, 'модель не знает, что Get-Date в cmd не работает')
})

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
