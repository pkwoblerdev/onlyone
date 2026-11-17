// break-1 Н5: снимок вкладки писался как `page-<ISO>.png` — имя с точностью до
// миллисекунды и без случайного суффикса. Два снимка в одну миллисекунду молча
// перезаписывали друг друга (образец рядом: save-pasted-image добавляет randomBytes).
// Тест исполняет НАСТОЯЩИЙ обработчик save-page-screenshot из main.js в песочнице:
// fs настоящий во временном каталоге, часы заморожены, окно подставное.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

let failed = 0
let total = 0
const asyncCheck = async (name, fn) => {
  total++
  try { await fn(); console.log('ok     ' + name) } catch (error) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + error.message) }
}

const mainSrc = fs.readFileSync(process.env.ONECODE_TEST_MAIN_SRC || path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const start = mainSrc.indexOf("ipcMain.handle('save-page-screenshot'")
const end = mainSrc.indexOf("ipcMain.handle('save-pasted-image'")
if (start < 0 || end <= start) throw new Error('обработчик save-page-screenshot не найден')
const block = mainSrc.slice(start, end)

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-shot-'))
const FROZEN = Date.parse('2026-11-11T12:00:00.123Z')
class FrozenDate extends Date { constructor() { super(FROZEN) } }

// dataUrl с разными байтами: какой файл чей — видно по содержимому.
const png = label => 'data:image/png;base64,' + Buffer.from('СНИМОК-' + label, 'utf8').toString('base64')

const run = async ({ label, workspacePath, dataUrl, maxBytes }) => {
  let handler = null
  const deps = {
    ipcMain: { handle: (_channel, fn) => { handler = fn } },
    MAX_ATTACHMENT_BYTES: maxBytes === undefined ? 64 * 1024 * 1024 : maxBytes,
    workspace: { path: workspacePath },
    resolve: path.resolve, join: path.join,
    app: { getPath: () => path.join(base, 'userData') },
    fs: fsp, Date: FrozenDate, crypto,
    describeAttachment: async target => ({ path: target, name: path.basename(target) })
  }
  new Function('deps', `
    const { ipcMain, MAX_ATTACHMENT_BYTES, workspace, resolve, join, app, fs, Date, crypto, describeAttachment } = deps
    ${block}
  `)(deps)
  assert.equal(typeof handler, 'function', 'обработчик не зарегистрирован')
  return handler({}, { dataUrl: dataUrl === undefined ? png(label) : dataUrl })
}

async function main() {
  const project = path.join(base, 'project')
  fs.mkdirSync(project, { recursive: true })

  let first = null
  let second = null
  await asyncCheck('два снимка в одну миллисекунду — два разных файла, оба содержимых', async () => {
    first = await run({ label: 'ПЕРВЫЙ', workspacePath: project })
    second = await run({ label: 'ВТОРОЙ', workspacePath: project })
    const dir = path.join(project, 'onlyone-screens')
    const names = fs.readdirSync(dir).sort()
    assert.equal(names.length, 2, 'файлов на диске: ' + names.length + ' (' + names.join(', ') + ') — второй снимок перезаписал первый')
    assert.notEqual(first.path, second.path, 'имена снимков совпали: ' + first.path)
    assert.equal(fs.readFileSync(path.join(dir, path.basename(first.path)), 'utf8'), 'СНИМОК-ПЕРВЫЙ')
    assert.equal(fs.readFileSync(path.join(dir, path.basename(second.path)), 'utf8'), 'СНИМОК-ВТОРОЙ')
  })

  await asyncCheck('контроль: имя прежнего вида, возвращённый путь ведёт на диск', async () => {
    assert.match(path.basename(first.path), /^page-2026-11-11T12-00-00-123Z.*\.png$/, 'форма имени изменилась: ' + first.path)
    assert.match(first.path, /^onlyone-screens\//, 'относительный путь проекта: ' + first.path)
    assert.ok(fs.existsSync(path.join(project, first.path)), 'файла по возвращённому пути нет')
    assert.equal(first.attachment.name, path.basename(first.path))
  })

  await asyncCheck('контроль: без проекта снимок ложится в userData и путь абсолютный', async () => {
    const shot = await run({ label: 'БЕЗ-ПРОЕКТА', workspacePath: '' })
    assert.ok(path.isAbsolute(shot.path), 'путь не абсолютный: ' + shot.path)
    assert.ok(fs.existsSync(shot.path), 'файла нет: ' + shot.path)
    assert.equal(fs.readFileSync(shot.path, 'utf8'), 'СНИМОК-БЕЗ-ПРОЕКТА')
  })

  await asyncCheck('контроль: не-картинка и слишком большой снимок по-прежнему отказаны', async () => {
    await assert.rejects(run({ label: 'x', workspacePath: project, dataUrl: 'data:text/plain;base64,QUJD' }), /Снимок вкладки не получен/)
    const huge = 'data:image/png;base64,' + Buffer.alloc(64).toString('base64')
    await assert.rejects(run({ label: 'x', workspacePath: project, dataUrl: huge, maxBytes: 8 }), /больше 64 МБ/)
  })

  fs.rmSync(base, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })