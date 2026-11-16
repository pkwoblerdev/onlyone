// Холодный checkout: sync сам готовит копии общих модулей для телефона, не зависит от cwd,
// не переписывает совпадающее и не трогает исходники; сгенерированное не попадает в git.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const syncScript = path.join(root, 'mobile', 'sync.cjs')
const names = ['remote-protocol.js', 'remote-pairing.js', 'remote-link.js']
const sources = names.map(name => path.join(root, 'src', 'shared', name))
const copies = names.map(name => path.join(root, 'mobile', 'www', 'js', 'shared', name))
const generated = [
  ...names.map(name => 'mobile/www/js/shared/' + name),
  'mobile/www/fonts/instrument-sans-latin-400-normal.woff2',
  'mobile/www/vendor/marked.min.js'
]

let failed = 0
function check(name, fn) { try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) } }

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const runSync = cwd => spawnSync(process.execPath, [syncScript], { cwd, encoding: 'utf8' })
const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' })

const sourceHashes = sources.map(sha256)

check('sync запускается из os.tmpdir() и завершается с кодом 0', () => {
  const result = runSync(os.tmpdir())
  assert.equal(result.status, 0, `код ${result.status}: ${result.stderr}`)
})

check('копии общих модулей побайтово равны src/shared', () => {
  names.forEach((name, index) => {
    assert.ok(fs.existsSync(copies[index]), 'нет копии ' + name)
    assert.equal(Buffer.compare(fs.readFileSync(copies[index]), fs.readFileSync(sources[index])), 0, name + ' разошёлся')
  })
})

check('повторный sync не переписывает совпадающие файлы (mtime сохраняется)', () => {
  const past = new Date('2020-01-01T00:00:00Z')
  const before = copies.map(file => fs.statSync(file).mtimeMs)
  copies.forEach(file => fs.utimesSync(file, past, past))
  const result = runSync(os.tmpdir())
  assert.equal(result.status, 0, `код ${result.status}: ${result.stderr}`)
  copies.forEach((file, index) => {
    assert.equal(fs.statSync(file).mtimeMs, past.getTime(), path.basename(file) + ' перезаписан без изменений')
    assert.equal(Buffer.compare(fs.readFileSync(file), fs.readFileSync(sources[index])), 0, path.basename(file) + ' разошёлся')
  })
  copies.forEach((file, index) => fs.utimesSync(file, new Date(before[index]), new Date(before[index])))
})

check('исходники src/shared не изменились (sha256 до/после)', () => {
  assert.deepEqual(sources.map(sha256), sourceHashes)
})

check('сгенерированное игнорируется git и не видно в git status', () => {
  const ignored = git(['check-ignore', ...generated])
  assert.equal(ignored.status, 0, 'check-ignore: ' + ignored.stderr)
  assert.equal(ignored.stdout.trim().split(/\r?\n/).filter(Boolean).length, generated.length, 'игнорируются не все пути: ' + ignored.stdout)
  const status = git(['status', '--porcelain', '--', ...generated])
  assert.equal(status.status, 0, 'git status: ' + status.stderr)
  assert.equal(status.stdout.trim(), '', 'сгенерированное попало в git status: ' + status.stdout)
})

check('sync не зависит от cwd: пишет в mobile/ репозитория, а не в текущую папку', () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-sync-'))
  try {
    const result = runSync(elsewhere)
    assert.equal(result.status, 0, `код ${result.status}: ${result.stderr}`)
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'sync создал файлы в текущей папке')
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true })
  }
})

check('ошибка чтения исходника видна, а не проглочена', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-sync-broken-'))
  try {
    fs.mkdirSync(path.join(sandbox, 'mobile'))
    const broken = path.join(sandbox, 'mobile', 'sync.cjs')
    fs.copyFileSync(syncScript, broken)
    const result = spawnSync(process.execPath, [broken], { cwd: sandbox, encoding: 'utf8' })
    assert.notEqual(result.status, 0, 'без исходников sync завершился успешно')
    assert.match(result.stderr, /ENOENT|remote-protocol\.js/, 'в ошибке нет имени файла: ' + result.stderr)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

if (failed) process.exit(1)
console.log('\nСинхронизация общих модулей телефона: проверки пройдены')
