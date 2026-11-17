// break-1 Н2: move_path молча перезаписывал существующий destination (Windows
// MoveFileEx REPLACE_EXISTING), риск 'edit' вместо 'destructive', без снимка —
// «Отменить» не возвращал файл. Тест исполняет настоящую ветку move_path из
// main.js в песочнице с подставными зависимостями и настоящим fs во временном каталоге.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}
const asyncCheck = async (name, fn) => {
  total++
  try { await fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const start = mainSrc.indexOf("if (name === 'move_path')")
const end = mainSrc.indexOf("if (name === 'delete_path')")
if (start < 0 || end <= start) throw new Error('ветка move_path не найдена')
const branch = mainSrc.slice(start, end)

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-move-'))
const runBranch = async ({ args, permission = 'auto' }) => {
  const calls = { approvals: [], snapshots: [] }
  const deps = {
    name: 'move_path', args, event: {}, requestId: 'req-test', signal: null,
    workspace: { permission },
    assertSafeWorkspacePath: async p => path.resolve(base, String(p)),
    planModeRefusal: what => ({ success: false, denied: true, message: 'plan: ' + what }),
    relativeDisplay: p => path.relative(base, p),
    requireMutationApproval: async (event, summary, details, diff, risk) => {
      calls.approvals.push({ summary, details, diff, risk })
      return true
    },
    fs: fsp,
    dirname: path.dirname,
    snapshotBeforeWrite: async (requestId, target, existed, previous, next) => {
      calls.snapshots.push({ requestId, target, existed, previous, next })
    },
    sendToWindow: () => {},
    tr: (s, ...rest) => rest.reduce((acc, v, i) => acc.replace('%s', v), s)
  }
  const fn = new Function('deps', `
    const { name, args, event, requestId, signal, workspace, assertSafeWorkspacePath, planModeRefusal,
      relativeDisplay, requireMutationApproval, fs, dirname, snapshotBeforeWrite, sendToWindow, tr } = deps
    return (async () => { ${branch}\n return { fellThrough: true } })()
  `)
  return { result: await fn(deps), calls }
}

async function main() {
  // Существующий destination: карточка обязана предупредить о замене, спросить
  // как destructive и оставить снимок прежнего содержимого.
  fs.writeFileSync(path.join(base, 'a.txt'), 'SRC-CONTENT', 'utf8')
  fs.writeFileSync(path.join(base, 'b.txt'), 'VICTIM-CONTENT', 'utf8')
  const overwrite = await runBranch({ args: { source: 'a.txt', destination: 'b.txt' } })
  await asyncCheck('существующий destination классифицирован как destructive', () => {
    assert.equal(overwrite.calls.approvals.length, 1)
    assert.equal(overwrite.calls.approvals[0].risk, 'destructive',
      'риск edit — в acceptEdits/auto карточки нет вовсе')
  })
  await asyncCheck('карточка предупреждает о существующем destination', () => {
    const details = String(overwrite.calls.approvals[0].details || '')
    assert.match(details, /существует|перезаписан|замен/, 'предупреждения о замене нет: ' + details)
    assert.match(details, /b\.txt/, 'имя назначения не названо')
  })
  await asyncCheck('снимок destination сделан до перезаписи', () => {
    assert.equal(overwrite.calls.snapshots.length, 1, 'снимка нет — «Отменить» не вернёт файл')
    const snap = overwrite.calls.snapshots[0]
    assert.equal(snap.target, path.join(base, 'b.txt'))
    assert.equal(snap.existed, true)
    assert.equal(snap.previous, 'VICTIM-CONTENT', 'в снимке не прежнее содержимое')
  })
  await asyncCheck('само перемещение состоялось', () => {
    assert.equal(overwrite.result.success, true)
    assert.equal(fs.readFileSync(path.join(base, 'b.txt'), 'utf8'), 'SRC-CONTENT')
    assert.equal(fs.existsSync(path.join(base, 'a.txt')), false)
  })

  // Контроль: обычное переименование в несуществующий destination не стало
  // destructive и не обзавелось лишним снимком.
  fs.writeFileSync(path.join(base, 'c.txt'), 'C-CONTENT', 'utf8')
  const plain = await runBranch({ args: { source: 'c.txt', destination: 'd.txt' } })
  await asyncCheck('контроль: новое имя — риск edit, без снимка', () => {
    assert.equal(plain.result.success, true)
    assert.equal(plain.calls.approvals[0].risk, 'edit')
    assert.equal(plain.calls.snapshots.length, 0)
    assert.equal(fs.readFileSync(path.join(base, 'd.txt'), 'utf8'), 'C-CONTENT')
  })

  // Назначение-каталог: понятный отказ до карточки, а не сырая ошибка rename.
  fs.writeFileSync(path.join(base, 'e.txt'), 'E', 'utf8')
  fs.mkdirSync(path.join(base, 'dir'))
  await asyncCheck('назначение-каталог отклонено понятным сообщением', async () => {
    let error = null
    try { await runBranch({ args: { source: 'e.txt', destination: 'dir' } }) } catch (e) { error = e }
    assert.ok(error, 'ожидался отказ')
    assert.match(error.message, /каталог/i, 'сырая ошибка вместо понятной: ' + error.message)
    assert.equal(fs.readFileSync(path.join(base, 'e.txt'), 'utf8'), 'E', 'источник тронут')
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })
  .finally(() => { try { fs.rmSync(base, { recursive: true, force: true }) } catch {} })