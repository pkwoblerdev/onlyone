// test-approval-sender.cjs — находка Н5 аудита sec-net 2026-11-01.
//
// Канал `resolve-agent-approval` принимал ответ по одному `id`, не глядя на
// отправителя, хотя в pendingApprovals лежит windowId окна, которому карточку
// показали. Любое чужое верхнее окно (при XSS — любой кадр приложения) могло
// ответить за человека. Проверяется настоящий обработчик, вырезанный из main.js.
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const start = source.indexOf("ipcMain.handle('resolve-agent-approval'")
const end = source.indexOf("ipcMain.handle('get-mcp-servers'", start)
assert.ok(start >= 0 && end > start, 'обработчик resolve-agent-approval не найден в main.js')

const pendingApprovals = new Map()
let captured = null
const ipcMain = { handle: (channel, fn) => { captured = fn } }
new Function('ipcMain', 'pendingApprovals', source.slice(start, end) + '; return undefined')(ipcMain, pendingApprovals)
assert.equal(typeof captured, 'function', 'обработчик не зарегистрировался в подставном ipcMain')

const windowOf = id => ({ id, isDestroyed: () => false })
function arm (id, windowId) {
  let resolved = null
  pendingApprovals.set(id, { windowId, resolve: value => { resolved = value } })
  return () => resolved
}

let failed = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

;(async () => {
  await check('хозяин карточки получает ответ, ожидание снимается', async () => {
    const read = arm('a1', 7)
    const ok = await captured({ sender: windowOf(7) }, { id: 'a1', approved: true })
    assert.deepEqual(ok, { ok: true })
    assert.equal(read(), true, 'ожидание не разрешено')
    assert.equal(pendingApprovals.has('a1'), false)
  })

  await check('чужое окно не может ответить за человека: отказ, ожидание цело', async () => {
    const read = arm('a2', 7)
    await assert.rejects(() => captured({ sender: windowOf(8) }, { id: 'a2', approved: true }), /друго|окн/i)
    assert.equal(read(), null, 'чужой ответ разрешил ожидание')
    assert.equal(pendingApprovals.has('a2'), true, 'запись снята чужим окном')
  })

  await check('ожидание без окна-хозяина не отвечает никому', async () => {
    arm('a3', null)
    await assert.rejects(() => captured({ sender: windowOf(7) }, { id: 'a3', approved: true }))
    assert.equal(pendingApprovals.has('a3'), true)
  })

  await check('мёртвый запрос всё так же отказывает', async () => {
    await assert.rejects(() => captured({ sender: windowOf(7) }, { id: 'нет-такого', approved: true }))
  })

  console.log(JSON.stringify({ ok: failed === 0, failed }))
  process.exit(failed ? 1 : 0)
})()
