'use strict'
// break-3 Н7: имя расписания попадало в разметку подтверждения удаления без esc()
// (L('Удалить «%s»?', record.name)) — единственное место в файле, где поле не
// экранировано (соседние esc(record.name)/esc(record.id)). Имя с HTML-инъекцией
// исполнялось в разметке подтверждения. После правки имя экранируется.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'schedules.js'), 'utf8').replace(/\r\n/g, '\n')
const cut = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker missing: ' + a); return SRC.slice(i, j) }
const escCode = cut('  function esc (value) {', '  function newId () {')
const rowCode = cut('    function row (record) {', '    function brokenRow (item) {')

function renderRow(record, confirmId) {
  const ctx = {
    // L подставляет %s без экранирования — как root.__t (в этом и была дыра).
    L: (text, ...args) => { let s = String(text); for (const a of args) s = s.replace('%s', String(a)); return s },
    state: { confirmId, nextText: {} },
    Date, console
  }
  vm.createContext(ctx)
  vm.runInContext(escCode + '\n' + rowCode + '\nthis.__row = row', ctx)
  return ctx.__row(record)
}
const future = Date.now() + 3600 * 1000
const rec = (name) => ({ id: 'sch_1', name, enabled: true, nextRunAt: future, running: false })

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

check('Н7: имя в подтверждении удаления экранируется', () => {
  const html = renderRow(rec('<img src=x onerror=alert(1)>'), 'sch_1')
  assert.ok(html.includes('Да, удалить'), 'нет ветки подтверждения — тест пустой')
  assert.ok(!html.includes('<img src=x'), 'имя расписания попало в разметку подтверждения без экранирования')
  assert.ok(html.includes('&lt;img'), 'имя не экранировано')
})

check('контроль: обычное имя показывается в подтверждении', () => {
  const html = renderRow(rec('Утренний разбор'), 'sch_1')
  assert.ok(html.includes('Удалить «Утренний разбор»?'), 'обычное имя не подставлено')
})

check('контроль: вне подтверждения имя тоже экранируется (соседнее поле)', () => {
  const html = renderRow(rec('<b>x</b>'), null)
  assert.ok(!html.includes('<b>x</b>'), 'имя в обычной строке не экранировано')
  assert.ok(html.includes('&lt;b&gt;'))
})

if (failed) process.exit(1)
console.log('ok test-schedules-name-escape')