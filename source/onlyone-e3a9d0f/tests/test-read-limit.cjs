// Тест лимита чтения в read_file (докрутка В3-2 / план 1.3.14):
// при отсутствии endLine по умолчанию читаются первые 120 строк с сообщением о пагинации.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

// Вырезаем readTextFile из main.js
const start = src.indexOf('async function readTextFile(')
assert.ok(start > 0, 'readTextFile не найден в main.js')
const end = src.indexOf('async function editWorkspaceFile(', start)
assert.ok(end > start, 'конец readTextFile не найден в main.js')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-read-limit-'))
const assertSafeWorkspacePath = async (p) => path.join(tmpDir, p)
const relativeDisplay = (p) => path.basename(p)
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024

const fnCode = src.slice(start, end)
// eslint-disable-next-line no-new-func
const buildReader = new Function(
  'fs', 'path', 'assertSafeWorkspacePath', 'relativeDisplay', 'MAX_ATTACHMENT_BYTES',
  `${fnCode}\nreturn readTextFile;`
)
const readTextFile = buildReader(fs.promises, path, assertSafeWorkspacePath, relativeDisplay, MAX_ATTACHMENT_BYTES)

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log('ok', name)
  } catch (err) {
    failed++
    console.error('ПРОВАЛ', name, '-', err.message)
  }
}

async function run() {
  // Файл на 250 строк
  const lines250 = Array.from({ length: 250 }, (_, i) => `Строка ${i + 1}`).join('\n')
  fs.writeFileSync(path.join(tmpDir, 'long.txt'), lines250, 'utf8')

  // Файл на 80 строк
  const lines80 = Array.from({ length: 80 }, (_, i) => `Строка ${i + 1}`).join('\n')
  fs.writeFileSync(path.join(tmpDir, 'short.txt'), lines80, 'utf8')

  await check('без endLine длинный файл (250 строк) читает ровно 120 строк по умолчанию', async () => {
    const res = await readTextFile('long.txt')
    assert.equal(res.success, true)
    assert.equal(res.totalLines, 250)
    assert.equal(res.startLine, 1)
    assert.equal(res.endLine, 120, `ожидалось 120 строк по умолчанию, получено ${res.endLine}`)
    assert.equal(res.truncated, true, 'truncated должен быть true при усечении по умолчанию')
    assert.match(res.content, /Показаны строки 1[–-]120 из 250/)
  })

  await check('короткий файл (<120 строк) без endLine читается целиком без усечения', async () => {
    const res = await readTextFile('short.txt')
    assert.equal(res.success, true)
    assert.equal(res.totalLines, 80)
    assert.equal(res.startLine, 1)
    assert.equal(res.endLine, 80)
    assert.equal(res.truncated, false)
    assert.doesNotMatch(res.content, /Показаны строки/)
  })

  await check('явный endLine > 120 читает затребованное количество строк', async () => {
    const res = await readTextFile('long.txt', 1, 200)
    assert.equal(res.success, true)
    assert.equal(res.totalLines, 250)
    assert.equal(res.startLine, 1)
    assert.equal(res.endLine, 200)
    assert.equal(res.truncated, false)
    assert.doesNotMatch(res.content, /Показаны строки/)
  })

  await check('пагинация: чтение со startLine=121 читает строки 121..240 по умолчанию', async () => {
    const res = await readTextFile('long.txt', 121)
    assert.equal(res.success, true)
    assert.equal(res.totalLines, 250)
    assert.equal(res.startLine, 121)
    assert.equal(res.endLine, 240, `ожидалось 240, получено ${res.endLine}`)
    assert.equal(res.truncated, true)
    assert.match(res.content, /Показаны строки 121[–-]240 из 250/)
  })

  await check('нечисловой endLine ("all") трактуется как отсутствие endLine (умолчание 120 строк)', async () => {
    const res = await readTextFile('long.txt', 1, 'all')
    assert.equal(res.success, true)
    assert.equal(res.startLine, 1)
    assert.equal(res.endLine, 120)
    assert.equal(res.truncated, true)
    assert.match(res.content, /Показаны строки 1[–-]120 из 250/)
  })

  await check('при превышении 64 КБ сообщение информирует об усечении по байтам', async () => {
    const bigLines = Array.from({ length: 20 }, (_, i) => `Строка ${i + 1}: ${'x'.repeat(4096)}`).join('\n')
    fs.writeFileSync(path.join(tmpDir, 'big.txt'), bigLines, 'utf8')
    const res = await readTextFile('big.txt')
    assert.equal(res.success, true)
    assert.equal(res.truncated, true)
    assert.match(res.content, /лимит 64 КБ/)
    assert.doesNotMatch(res.content, /Показаны строки/)
  })

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true })

  if (failed > 0) {
    process.exit(1)
  }
}

run()
