'use strict'
// OS-5: мост раздела «Плагины» без окна. Настоящий профиль во временной папке,
// настоящая установка из tests/fixtures/plugins/demo через tools/plugin/install.cjs,
// настоящие обработчики каналов plugins:* — списком, согласием, отключением,
// включением, откатом, удалением и журналом. Окно не нужно: проверяются
// обработчики, которые окно вызовет.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const install = require('../tools/plugin/install.cjs')
const { register, readJournal } = require('../src/main/plugins-ipc.cjs')

const demoDir = path.join(__dirname, 'fixtures', 'plugins', 'demo')
const base = JSON.parse(fs.readFileSync(path.join(demoDir, 'plugin.json'), 'utf8'))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-plugins-ipc-'))
const mainWindow = { webContents: {} }
const otherWindow = { webContents: {} }

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok     ${name}`)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.stack || error.message}`)
  }
}

// Настоящий ipcMain ведёт себя так же: имя канала и одна функция.
const handlers = new Map()
const ipcMain = { handle: (name, fn) => handlers.set(name, fn) }
const call = (name, input, sender = mainWindow) => handlers.get(name)({ sender }, input)
let clock = 1_760_000_000_000
const service = register({ ipcMain, isMain: event => event.sender === mainWindow, profileDir, now: () => (clock += 1000) })

function fixtureSource(extra) {
  const target = fs.mkdtempSync(path.join(profileDir, 'src-'))
  fs.cpSync(demoDir, target, { recursive: true })
  fs.writeFileSync(path.join(target, 'plugin.json'), JSON.stringify({ ...base, ...extra }, null, 2) + '\n')
  return target
}

const list = async () => {
  const result = await call('plugins:list', {})
  assert.equal(result.ok, true, JSON.stringify(result))
  return result
}
const row = async id => (await list()).plugins.find(plugin => plugin.id === id)

async function main() {
  await check('каналы зарегистрированы через ipcMain.handle', () => {
    assert.deepEqual([...handlers.keys()].sort(), [
      'plugins:approve', 'plugins:disable', 'plugins:enable', 'plugins:list', 'plugins:remove', 'plugins:rollback'
    ])
  })

  await check('чужое окно получает отказ и ничего не меняет', async () => {
    for (const name of handlers.keys()) {
      assert.deepEqual(await call(name, { id: 'demo' }, otherWindow), { ok: false, code: 'forbidden' })
    }
    assert.equal(fs.existsSync(path.join(profileDir, 'plugins')), false, 'отказ не создаёт профиль')
  })

  await check('пустой профиль: пустой список и пустой журнал', async () => {
    const result = await list()
    assert.deepEqual(result.plugins, [])
    assert.deepEqual(result.journal, [])
  })

  await check('установленный плагин виден как отключённый, права — запрошенные и не выданные', async () => {
    install.installPlugin(demoDir, { profileDir })
    const plugin = await row('demo')
    assert.equal(plugin.status, 'disabled')
    assert.equal(plugin.version, '1.0.0')
    assert.deepEqual(plugin.versions, ['1.0.0'])
    assert.deepEqual(plugin.requested, base.capabilities)
    assert.deepEqual(plugin.granted, [])
    assert.deepEqual(plugin.pending, base.capabilities)
    assert.equal(plugin.reason, '')
  })

  await check('«Подключить» без согласия не выдаёт права молча', async () => {
    const before = fs.readFileSync(path.join(profileDir, 'plugins', 'demo', 'record.json'), 'utf8')
    const result = await call('plugins:enable', { id: 'demo' })
    assert.deepEqual(result, { ok: false, code: 'approval-required' })
    assert.equal(fs.readFileSync(path.join(profileDir, 'plugins', 'demo', 'record.json'), 'utf8'), before, 'запись не тронута')
    const plugin = await row('demo')
    assert.equal(plugin.status, 'disabled')
    assert.deepEqual(plugin.granted, [])
  })

  await check('«Разрешить» выдаёт ровно запрошенные права и включает', async () => {
    const result = await call('plugins:approve', { id: 'demo' })
    assert.deepEqual(result, { ok: true, id: 'demo', version: '1.0.0' })
    const plugin = await row('demo')
    assert.equal(plugin.status, 'enabled')
    assert.deepEqual(plugin.granted, base.capabilities)
    assert.deepEqual(plugin.pending, [])
  })

  await check('«Отключить» и «Подключить» ходят туда и обратно, права остаются', async () => {
    assert.deepEqual(await call('plugins:disable', { id: 'demo' }), { ok: true, id: 'demo', version: '1.0.0' })
    assert.equal((await row('demo')).status, 'disabled')
    assert.deepEqual(await call('plugins:enable', { id: 'demo' }), { ok: true, id: 'demo', version: '1.0.0' })
    const plugin = await row('demo')
    assert.equal(plugin.status, 'enabled')
    assert.deepEqual(plugin.granted, base.capabilities, 'согласие не отозвано')
  })

  await check('вторая версия рядом: обе видны, откат возвращает прежнюю', async () => {
    install.installPlugin(fixtureSource({ version: '1.0.1' }), { profileDir })
    let plugin = await row('demo')
    assert.equal(plugin.version, '1.0.1')
    assert.deepEqual(plugin.versions, ['1.0.0', '1.0.1'])
    assert.deepEqual(await call('plugins:rollback', { id: 'demo', version: '1.0.0' }), { ok: true, id: 'demo', version: '1.0.0' })
    plugin = await row('demo')
    assert.equal(plugin.version, '1.0.0')
    assert.ok(fs.existsSync(path.join(profileDir, 'plugins', 'demo', '1.0.1')), 'файлы новой версии не стёрты')
  })

  await check('откат на несуществующую и на кривую версию — отказ с кодом, без записи «ok»', async () => {
    assert.deepEqual(await call('plugins:rollback', { id: 'demo', version: '9.9.9' }), { ok: false, code: 'missing' })
    assert.deepEqual(await call('plugins:rollback', { id: 'demo', version: '../1.0.0' }), { ok: false, code: 'invalid' })
    assert.equal((await row('demo')).version, '1.0.0')
  })

  await check('новая версия с широкими правами: отключён, ждёт согласия, «Подключить» отказывает', async () => {
    install.installPlugin(fixtureSource({ version: '1.1.0', capabilities: [...base.capabilities, 'net'] }), { profileDir })
    let plugin = await row('demo')
    assert.equal(plugin.version, '1.1.0')
    assert.equal(plugin.status, 'disabled')
    assert.deepEqual(plugin.pending, ['net'])
    assert.deepEqual(await call('plugins:enable', { id: 'demo' }), { ok: false, code: 'approval-required' })
    assert.deepEqual(await call('plugins:approve', { id: 'demo' }), { ok: true, id: 'demo', version: '1.1.0' })
    plugin = await row('demo')
    assert.equal(plugin.status, 'enabled')
    assert.deepEqual(plugin.granted, [...base.capabilities, 'net'])
    assert.deepEqual(plugin.pending, [])
  })

  await check('подмена файла: карантин виден, «Разрешить» не проходит', async () => {
    const worker = path.join(profileDir, 'plugins', 'demo', '1.1.0', 'worker.cjs')
    fs.appendFileSync(worker, '\n// tampered\n')
    const plugin = await row('demo')
    assert.equal(plugin.status, 'quarantined')
    assert.equal(plugin.reason, 'tampered')
    assert.deepEqual(await call('plugins:approve', { id: 'demo' }), { ok: false, code: 'quarantined' })
    assert.equal((await row('demo')).status, 'quarantined', 'после отказа всё ещё карантин')
  })

  await check('чистая переустановка снимает карантин', async () => {
    install.installPlugin(fixtureSource({ version: '1.1.0', capabilities: [...base.capabilities, 'net'] }), { profileDir })
    const plugin = await row('demo')
    assert.equal(plugin.status, 'enabled')
    assert.equal(plugin.reason, '')
  })

  await check('журнал: дописан по порядку, с версией и итогом', async () => {
    const { journal } = await list()
    const actions = journal.slice().reverse().map(entry => entry.action)
    assert.deepEqual(actions, ['enable', 'approve', 'disable', 'enable', 'rollback', 'rollback', 'rollback', 'enable', 'approve', 'approve'])
    const results = journal.slice().reverse().map(entry => entry.result)
    assert.deepEqual(results, ['approval-required', 'ok', 'ok', 'ok', 'ok', 'missing', 'invalid', 'approval-required', 'ok', 'quarantined'])
    const approved = journal.filter(entry => entry.action === 'approve' && entry.result === 'ok')
    assert.deepEqual(approved.map(entry => entry.version), ['1.1.0', '1.0.0'], 'согласие помнит свою версию')
    assert.equal(approved[0].plugin, 'demo')
    assert.match(approved[0].time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  await check('журнал только дописывается и переживает чужие строки', async () => {
    const file = path.join(profileDir, 'plugins', 'journal.jsonl')
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
    fs.appendFileSync(file, '{broken\n42\n{"action":""}\n{"action":"install","id":"other","version":"2.0.0","ok":"ok"}\n')
    const { journal } = await list()
    assert.equal(journal[0].action, 'install')
    assert.equal(journal[0].plugin, 'other')
    assert.equal(journal[0].result, 'ok')
    assert.equal(journal.filter(entry => entry.plugin === 'demo').length, lines, 'старые строки на месте')
    assert.equal(readJournal(profileDir, 1).length, 1, 'потолок чтения')
  })

  await check('удаление: файлы версий убраны, журнал помнит', async () => {
    assert.deepEqual(await call('plugins:remove', { id: 'demo' }), { ok: true, id: 'demo', version: '1.1.0' })
    assert.deepEqual((await list()).plugins, [])
    assert.equal(fs.existsSync(path.join(profileDir, 'plugins', 'demo')), false)
    assert.deepEqual(await call('plugins:remove', { id: 'demo' }), { ok: false, code: 'missing' })
    const { journal } = await list()
    assert.equal(journal[0].action, 'remove')
    assert.equal(journal[0].result, 'missing')
    assert.equal(journal[1].action, 'remove')
    assert.equal(journal[1].result, 'ok')
  })

  await check('чужой id с точками не выходит за каталог плагинов', async () => {
    const outside = path.join(profileDir, 'plugins', 'record.json')
    fs.writeFileSync(outside, JSON.stringify({ id: 'evil', version: '1.0.0', dir: 'plugins/evil/1.0.0', hash: 'x', grants: [], disabled: true }))
    const result = await call('plugins:approve', { id: '../record' })
    assert.deepEqual(result, { ok: false, code: 'invalid' })
    assert.ok(fs.existsSync(outside), 'файл рядом с плагинами цел')
    fs.rmSync(outside)
  })

  assert.equal(handlers.size, 6)
  console.log(JSON.stringify({ ok: failed === 0, passed, failed, profileDir }))
  process.exit(failed ? 1 : 0)
}

main().catch(error => {
  console.error(error.stack || error)
  process.exit(1)
})
