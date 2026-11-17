// break-3 Н5: карусель запросов агента на телефоне считает pending по ВСЕМ чатам,
// а карточки отфильтрованы по открытому. Если в другом чате тоже есть pending,
// индекс растёт до чужого total, зажимается items.length-1 и никогда не сбрасывается:
// первый запрос (опасное действие) недостижим — ход агента стоит.
//
// Отрицательный контроль: без чужих pending карусель честно циклит 0→1→0.
// Стенд: настоящий mobile/www/js/app.js (mobile-stand), подменные Store/сеть.
'use strict'
const assert = require('node:assert/strict')
const { loadPhone } = require('./fixtures/mobile-stand.cjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let failed = 0
let total = 0
async function check (name, fn) {
  total++
  try { await fn(); console.log('  ok  ' + name) } catch (error) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message)) }
}

async function open (approvals) {
  const stand = loadPhone()
  await sleep(20)
  stand.remote.state.pending.approvals = approvals
  stand.app.go('chat', { kind: 'pc', id: 'c1' })
  await sleep(20)
  return stand
}
const pager = stand => stand.$('asks').querySelector('[data-act="ask-next"]')
async function clickNext (stand) {
  const button = pager(stand)
  assert.ok(button, 'пейджер должен быть нарисован (запросов > 1)')
  stand.dom.fire(button, 'click', {})
  await sleep(10)
}
const first = { id: 'a1', chat: 'c1', summary: 'Первый запрос: удалить папку', dangerous: true }
const second = { id: 'a2', chat: 'c1', summary: 'Второй запрос: записать файл', dangerous: false }
const foreign = { id: 'a3', chat: 'c2', summary: 'Чужой запрос', dangerous: false }

// Н5: два запроса в c1 + один в c2 — карусель обязана вернуться к первому.
async function main () {
await check('Н5: чужой pending не запирает карусель', async () => {
  const stand = await open([{ ...first }, { ...second }, { ...foreign }])
  assert.equal(stand.app.S.pc.askIdx, 0, 'начали с первого')
  await clickNext(stand)
  assert.equal(stand.app.S.pc.askIdx, 1, 'клик 1 → второй')
  await clickNext(stand)
  assert.equal(stand.app.S.pc.askIdx, 0, 'клик 2 → возврат к первому, получено ' + stand.app.S.pc.askIdx)
  assert.match(pager(stand).textContent, /1 \/ 2/, 'пейджер показывает 1 / 2')
  assert.match(stand.$('asks').textContent, /Первый запрос/, 'первый запрос снова на экране')
})

// Отрицательный контроль: без чужих pending карусель циклит (работало и до правки).
await check('Н5 контроль: без чужих pending карусель циклит', async () => {
  const stand = await open([{ ...first }, { ...second }])
  await clickNext(stand)
  assert.equal(stand.app.S.pc.askIdx, 1)
  await clickNext(stand)
  assert.equal(stand.app.S.pc.askIdx, 0)
})

// Контроль: три запроса в своём чате — цикл 0→1→2→0.
await check('Н5 контроль: три своих запроса циклят', async () => {
  const third = { id: 'a4', chat: 'c1', summary: 'Третий', dangerous: false }
  const stand = await open([{ ...first }, { ...second }, third, { ...foreign }])
  await clickNext(stand); assert.equal(stand.app.S.pc.askIdx, 1)
  await clickNext(stand); assert.equal(stand.app.S.pc.askIdx, 2)
  await clickNext(stand); assert.equal(stand.app.S.pc.askIdx, 0, 'возврат к первому из трёх')
})

console.log(`\n${total - failed}/${total} ok`)
}
main().then(() => process.exit(failed ? 1 : 0), error => { console.error(error); process.exit(1) })