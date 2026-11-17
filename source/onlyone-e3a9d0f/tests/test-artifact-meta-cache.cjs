// Список артефактов не расшифровывает неизменившуюся мету заново (журнал владельца: get-artifacts держал главный процесс 440 мс).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { create } = require('../src/main/artifacts')

let failed = 0
async function check(name, fn) { try { await fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) } }

;(async () => {
  let decrypts = 0
  const store = create({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-meta-cache-')),
    protect: text => 'P' + Buffer.from(text, 'utf8').toString('base64'),
    unprotect: body => { decrypts++; return Buffer.from(String(body).slice(1), 'base64').toString('utf8') }
  })
  const made = await store.add({ chatId: 'c1', title: 'Страница', kind: 'page', content: '<h1>раз</h1>' })

  await check('повторный список не расшифровывает мету заново', async () => {
    await store.list({ chatId: 'c1' })
    const after = decrypts
    for (let i = 0; i < 5; i++) await store.list({ chatId: 'c1' })
    assert.equal(decrypts, after, 'расшифровок на неизменной мете быть не должно')
  })

  await check('правка видна сразу: после сохранения версии мета читается заново', async () => {
    await store.list({ chatId: 'c1' })
    await store.update(made.id, '<h1>два</h1>', { chatId: 'c1' })
    const before = decrypts
    const listed = await store.list({ chatId: 'c1' })
    assert.ok(decrypts > before, 'после записи мета должна быть прочитана с диска')
    assert.equal(listed.length, 1)
    assert.ok((listed[0].versions || []).length >= 2 || listed[0].version >= 2 || listed[0].updatedAt, 'версия обновилась')
  })

  await check('изменение кэшированной копии снаружи не портит хранилище', async () => {
    const [one] = await store.list({ chatId: 'c1' })
    one.title = 'ИСПОРЧЕНО'
    const [again] = await store.list({ chatId: 'c1' })
    assert.notEqual(again.title, 'ИСПОРЧЕНО')
  })

  await check('архивирование сбрасывает кэш: артефакт пропадает из списка', async () => {
    await store.list({ chatId: 'c1' })
    assert.equal(await store.archive(made.id, { chatId: 'c1' }), true)
    assert.equal((await store.list({ chatId: 'c1' })).length, 0)
  })

  if (failed) process.exit(1)
  console.log('\nКэш меты артефактов: проверки пройдены')
})()
