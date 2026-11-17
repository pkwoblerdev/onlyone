'use strict'

// break-4 Н13: секрет внутри `action` расписания не ловится проверкой и не
// зачищается хранилищем. Два рубежа: модель отвергает секретное поле на любой
// глубине, хранилище зачищает текст действия (redact) и держит модельный предел
// длины. Ключи выдуманные, не настоящие. Отрицательные контроли: легальная
// длинная команда не режется, чистое действие проходит, корневой секрет ловится.

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const model = require('../src/main/schedule-model.js')
const { createScheduleStore } = require('../src/main/schedule-store.js')

const FAKE = 'sk-EXAMPLEba37aa24cd'
const redact = text => String(text).replace(/sk-[A-Za-z0-9-]+/g, '***')
const base = { timeZone: 'Europe/Berlin', enabled: true, kind: 'daily', daily: { time: '07:30' } }

let fails = 0
const check = (name, fn) => {
  try { fn(); console.log('ok   ' + name) } catch (error) { fails++; console.log('FAIL ' + name + ' :: ' + error.message) }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-secret-'))
const storeIn = name => {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir)
  return { dir, store: createScheduleStore({ dir, now: () => 1, redact }) }
}
const fileOf = dir => fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8')

// 1. Модель: вложенное секретное поле (env) отклоняется.
check('Н13 model: action.env.API_KEY rejected', () => {
  const v = model.validateSchedule({ ...base, action: { type: 'command', command: 'run', env: { API_KEY: FAKE } } })
  assert.strictEqual(v.ok, false, 'вложенный секрет принят')
  assert.ok(v.errors.some(e => e.code === 'action_secret_field'), 'нет ошибки action_secret_field')
})

// 2. Модель: секрет глубже двух уровней и внутри массива.
check('Н13 model: deep and array-nested secret rejected', () => {
  const deep = model.validateSchedule({ ...base, action: { type: 'note', text: 'x', meta: { headers: { authorization: 'Bearer ' + FAKE } } } })
  assert.strictEqual(deep.ok, false, 'глубокий секрет принят')
  const arr = model.validateSchedule({ ...base, action: { type: 'note', text: 'x', steps: [{ token: FAKE }] } })
  assert.strictEqual(arr.ok, false, 'секрет в массиве принят')
})

// 3. Хранилище: секрет в action.prompt зачищен, длина в модельном пределе.
check('Н13 store: action.prompt redacted and clipped', () => {
  const { dir, store } = storeIn('prompt')
  const long = FAKE + ' просьба'.repeat(3000)
  store.save([{ ...base, id: 'a1', action: { type: 'agent-turn', prompt: long } }])
  const text = fileOf(dir)
  assert.ok(!text.includes(FAKE), 'секрет ушёл в файл дословно')
  const rec = JSON.parse(text).records[0]
  assert.ok(rec.action.prompt.startsWith('***'), 'зачистка не применена к action.prompt')
  assert.ok(rec.action.prompt.length <= model.ACTION_TEXT_LIMIT, 'длина больше модельного предела')
})

// 4. Хранилище: значение env и текст команды зачищаются, ключи поля не трогаются.
check('Н13 store: action.env and action.command redacted', () => {
  const { dir, store } = storeIn('env')
  store.save([{ ...base, id: 'a2', action: { type: 'command', command: 'run --key ' + FAKE, env: { API_KEY: FAKE, NODE_ENV: 'production' } } }])
  const text = fileOf(dir)
  assert.ok(!text.includes(FAKE), 'секрет ушёл в файл дословно')
  const rec = JSON.parse(text).records[0]
  assert.strictEqual(rec.action.env.API_KEY, '***')
  assert.strictEqual(rec.action.env.NODE_ENV, 'production', 'несекретное значение изменено')
})

// Отрицательный контроль: легальная длинная команда (в пределах модели) не режется.
check('NEG: legal long command survives validation and store intact', () => {
  const command = 'echo ' + 'x'.repeat(15000)
  const v = model.validateSchedule({ ...base, action: { type: 'command', command } })
  assert.strictEqual(v.ok, true, 'легальная длинная команда отклонена: ' + JSON.stringify(v.errors))
  const { dir, store } = storeIn('long')
  store.save([{ ...base, id: 'a3', action: { type: 'command', command } }])
  const rec = JSON.parse(fileOf(dir)).records[0]
  assert.strictEqual(rec.action.command, command, 'длинная команда обрезана хранилищем')
})

// Отрицательный контроль: чистое действие проходит, корневой секрет по-прежнему ловится.
check('NEG: clean action passes, root secret still rejected', () => {
  const clean = model.validateSchedule({ ...base, action: { type: 'agent-turn', prompt: 'собери отчёт', env: { NODE_ENV: 'production' } } })
  assert.strictEqual(clean.ok, true, 'чистое действие отклонено: ' + JSON.stringify(clean.errors))
  const root = model.validateSchedule({ ...base, action: { type: 'note', text: 'x', apikey: FAKE } })
  assert.strictEqual(root.ok, false, 'корневой секрет перестал ловиться')
  assert.ok(root.errors.some(e => e.code === 'action_secret_field'))
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fails ? `\nFAILS=${fails}` : '\nALL OK')
process.exit(fails ? 1 : 0)