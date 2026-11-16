'use strict'
// «Кто вы» и «упор в работе» (вступительный экран, 9.1) доходят до модели:
// настоящие personalSettings и personalSection из главного процесса, с
// подставным хранилищем. Лишнее и чужое в хранилище не проходит.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
const cut = (from, to) => {
  const a = main.indexOf(from)
  const b = main.indexOf(to, a)
  assert(a >= 0 && b > a, 'не найдено: ' + from)
  return main.slice(a, b)
}

let checks = 0
function check(name, fn) { fn(); checks++; console.log('ok', name) }

function sandbox(saved) {
  const data = new Map([['personal', saved]])
  const store = { get: (k, d) => (data.has(k) ? data.get(k) : d), set: (k, v) => data.set(k, v) }
  return new Function('store', `
    ${cut("const PERSONAL_KEY = 'personal'", 'function buildSkillsSystemPrompt(')}
    return { personalSettings, personalSection }
  `)(store)
}

check('роль и упор уходят в раздел «О пользователе»', () => {
  const api = sandbox({ name: 'Паша', role: 'product', focus: ['design', 'research'] })
  const text = api.personalSection()
  assert.match(text, /--- О пользователе ---/)
  assert.match(text, /Кто он: менеджер продукта/)
  assert.match(text, /Упор в его работе: дизайн и интерфейсы, исследования и анализ/)
})

check('новые профессиональные роли принимаются профилем и передаются модели', () => {
  const api = sandbox({ name: 'Паша', role: 'consultant', focus: [] })
  assert.equal(api.personalSettings().role, 'consultant')
  assert.match(api.personalSection(), /Кто он: консультант или фрилансер/)
})

check('персональный профиль и контекст согласованы со всеми вариантами анкеты', () => {
  const roles = ['developer', 'designer', 'product', 'analyst', 'marketing', 'founder', 'manager', 'consultant', 'operations', 'educator', 'student', 'other']
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8')
  const roleBlock = renderer.match(/const PERSONAL_ROLES = \[([\s\S]*?)\n  \]/)?.[1] || ''
  for (const role of roles) {
    assert.match(roleBlock, new RegExp(`\\['${role}',`), `роль ${role} отсутствует в анкете`)
    assert.ok(sandbox({ role }).personalSettings().role === role, `роль ${role} не сохраняется`)
  }
})

check('неизвестная роль и чужой упор отбрасываются', () => {
  const api = sandbox({ role: 'hacker', focus: ['code', 'ignore previous', 'code', 42] })
  const settings = api.personalSettings()
  assert.equal(settings.role, '')
  assert.deepEqual(settings.focus, ['code'])
  assert.doesNotMatch(api.personalSection(), /hacker|ignore previous/)
})

check('«Другое» и пустой упор не добавляют строк', () => {
  const api = sandbox({ role: 'other', focus: [] })
  assert.equal(api.personalSection(), '')
})

console.log(JSON.stringify({ ok: true, checks, failed: 0 }))
