// break-5 Н1: граница своих инструментов обходила необёрнутыми именами fs
// (cpSync/opendir/mkdtemp/statfs/openAsBlob/lchown/writeSync/writevSync,
// fs.promises.cp и др.), одинарным аргументом globSync и process.chdir.
// Тест гоняет настоящий tool-sandbox.cjs на временном дереве с junction наружу.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const sandbox = require('../src/main/tool-sandbox.cjs')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`); if (process.env.DEBUG_STACK) console.error(error.stack) }
}
const asyncCheck = async (name, fn) => {
  total++
  try { await fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-sbx-fs-'))
const workspace = path.join(base, 'workspace')
const outside = path.join(base, 'outside')
fs.mkdirSync(workspace)
fs.mkdirSync(outside)
fs.writeFileSync(path.join(workspace, 'inside.txt'), 'свой файл', 'utf8')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET', 'utf8')
const portal = path.join(workspace, 'portal')
const madeLink = process.platform === 'win32'
  ? spawnSync('cmd', ['/c', 'mklink', '/J', portal, outside], { windowsHide: true, stdio: 'ignore' }).status === 0
  : (() => { try { fs.symlinkSync(outside, portal, 'dir'); return true } catch { return false } })()
if (!madeLink) console.log('   ВНИМАНИЕ: junction не создан — проверки на него пропущены')

const denied = []
const jail = sandbox.create({ roots: [workspace], fs, cwd: workspace, onDeny: info => denied.push(info) })
const jfs = jail.for('fs')
const jp = jail.for('fs/promises')

const isDeny = error => error && error.code === 'ERR_ACCESS_DENIED' && /вне рабочей папки|без имени/.test(error.message)
const mustDeny = fn => {
  try { fn() } catch (error) { assert.ok(isDeny(error), `ожидался отказ границы, получено: ${error.code || ''} ${error.message}`); return }
  assert.fail('вызов прошёл без отказа границы')
}
const mustDenyAsync = async fn => {
  try { await fn() } catch (error) { assert.ok(isDeny(error), `ожидался отказ границы, получено: ${error.code || ''} ${error.message}`); return }
  assert.fail('вызов прошёл без отказа границы')
}
const out = p => path.join(outside, p)
const ws = p => path.join(workspace, p)
const portalPath = p => path.join(portal, p)

async function main() {
  // Статическое покрытие: каждое имя из списка аудита обязано быть в PATH_ARGS,
  // иначе wrap() отдаёт функцию как есть.
  check('все path-принимающие имена fs перечислены в PATH_ARGS', () => {
    const required = ['cp', 'cpSync', 'mkdtemp', 'mkdtempSync', 'mkdtempDisposableSync', 'opendir', 'opendirSync',
      'statfs', 'statfsSync', 'openAsBlob', 'lchown', 'lchownSync', 'lchmod', 'lchmodSync', 'writeSync', 'writevSync']
    for (const name of required) {
      assert.ok(sandbox.PATH_ARGS[name], `PATH_ARGS не знает «${name}»`)
    }
  })

  check('cpSync не читает наружу (прямой путь)', () => mustDeny(() => jfs.cpSync(out('secret.txt'), ws('leak.txt'))))
  check('cpSync не пишет наружу через junction', () => {
    if (!madeLink) return
    mustDeny(() => jfs.cpSync(ws('inside.txt'), portalPath('exfil.txt')))
    assert.equal(fs.existsSync(out('exfil.txt')), false, 'файл создан вне корней')
  })
  await asyncCheck('fs.promises.cp закрыт так же', () => mustDenyAsync(() => jp.cp(out('secret.txt'), ws('leak2.txt'))))
  check('opendirSync не перечисляет junction наружу', () => {
    if (!madeLink) return
    mustDeny(() => jfs.opendirSync(portal))
  })
  await asyncCheck('fs.promises.opendir закрыт', async () => {
    if (!madeLink) return
    await mustDenyAsync(() => jp.opendir(portal))
  })
  check('mkdtempSync не создаёт каталог через junction', () => {
    if (!madeLink) return
    mustDeny(() => jfs.mkdtempSync(portalPath('mk-')))
  })
  await asyncCheck('fs.promises.mkdtemp закрыт', async () => {
    if (!madeLink) return
    await mustDenyAsync(() => jp.mkdtemp(portalPath('mkp-')))
  })
  check('statfsSync не смотрит наружу', () => mustDeny(() => jfs.statfsSync(outside)))
  await asyncCheck('fs.promises.statfs закрыт', () => mustDenyAsync(() => jp.statfs(outside)))
  check('openAsBlob не читает наружу', () => {
    if (typeof fs.openAsBlob !== 'function') return
    mustDeny(() => jfs.openAsBlob(out('secret.txt')))
  })
  check('lchownSync не трогает junction', () => {
    if (!madeLink || typeof fs.lchownSync !== 'function') return
    mustDeny(() => jfs.lchownSync(portalPath('secret.txt'), 0, 0))
  })
  check('writeSync с путём вместо fd отказывает границей', () => {
    mustDeny(() => jfs.writeSync(out('pwn.txt'), 'данные'))
    assert.equal(fs.existsSync(out('pwn.txt')), false)
  })
  check('writevSync с путём вместо fd отказывает границей', () => {
    mustDeny(() => jfs.writevSync(out('pwn2.txt'), [Buffer.from('x')]))
  })
  check('globSync с абсолютным паттерном наружу закрыт (один аргумент)', () => {
    mustDeny(() => jfs.globSync(out('*.txt').replace(/\\/g, '/')))
  })
  check('globSync с options.cwd наружу закрыт', () => {
    mustDeny(() => jfs.globSync('*.txt', { cwd: outside }))
  })
  check('process.chdir запрещён границей', () => {
    let called = null
    const fake = { pid: process.pid, chdir: dir => { called = dir } }
    sandbox.guardProcess({ jail, target: fake })
    assert.throws(() => fake.chdir(outside), error => error.code === 'ERR_ACCESS_DENIED')
    assert.equal(called, null, 'настоящий chdir всё-таки вызван')
  })

  // Отрицательные контроли: законная работа внутри корней не сломана.
  check('контроль: чтение и запись внутри рабочей папки работают', () => {
    assert.equal(jfs.readFileSync(ws('inside.txt'), 'utf8'), 'свой файл')
    jfs.writeFileSync(ws('ok.txt'), 'ок')
    assert.equal(fs.readFileSync(ws('ok.txt'), 'utf8'), 'ок')
  })
  check('контроль: cpSync внутри рабочей папки работает', () => {
    jfs.cpSync(ws('inside.txt'), ws('copy.txt'))
    assert.equal(fs.readFileSync(ws('copy.txt'), 'utf8'), 'свой файл')
  })
  check('контроль: globSync внутри рабочей папки работает', () => {
    // Паттерн абсолютный: cwd юнит-теста — не рабочая папка, а настоящий glob
    // относительные паттерны считает от cwd процесса (в раннере это workspace).
    const found = jfs.globSync(ws('*.txt').replace(/\\/g, '/'))
    assert.ok(found.some(f => String(f).includes('inside.txt')), JSON.stringify(found))
  })
  check('контроль: globSync с cwd внутри работает', () => {
    fs.mkdirSync(ws('sub'))
    fs.writeFileSync(path.join(ws('sub'), 's.txt'), 's')
    const found = jfs.globSync('*.txt', { cwd: ws('sub') })
    assert.ok(found.some(f => String(f).includes('s.txt')), JSON.stringify(found))
  })
  check('контроль: mkdtempSync/opendirSync/statfsSync внутри работают', () => {
    const made = jfs.mkdtempSync(ws('mk-'))
    assert.ok(fs.existsSync(made))
    const dir = jfs.opendirSync(workspace)
    dir.closeSync()
    assert.ok(jfs.statfsSync(workspace))
  })
  check('контроль: writeSync/writevSync с fd из jailed open работают', () => {
    const fd = jfs.openSync(ws('fd.txt'), 'w')
    try {
      jfs.writeSync(fd, 'через fd')
      jfs.writevSync(fd, [Buffer.from(' и вектор')])
    } finally { jfs.closeSync(fd) }
    assert.equal(fs.readFileSync(ws('fd.txt'), 'utf8'), 'через fd и вектор')
  })
  await asyncCheck('контроль: fs.promises внутри работает', async () => {
    assert.equal(await jp.readFile(ws('inside.txt'), 'utf8'), 'свой файл')
    await jp.cp(ws('inside.txt'), ws('pcopy.txt'))
    assert.equal(fs.readFileSync(ws('pcopy.txt'), 'utf8'), 'свой файл')
  })
  check('отказы отражены в onDeny', () => assert.ok(denied.length > 0))

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })
  .finally(() => { try { fs.rmSync(base, { recursive: true, force: true }) } catch {} })