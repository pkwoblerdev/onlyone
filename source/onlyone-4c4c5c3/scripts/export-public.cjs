#!/usr/bin/env node
// Публичный экспорт из git-объектов ревизии (не из рабочей копии: байты и окончания строк сохраняются).
//   node scripts/export-public.cjs --revision 835e7a3 --out D:\tmp\onlyone-public
//   node scripts/export-public.cjs --verify D:\tmp\onlyone-public --manifest D:\tmp\onlyone-public.manifest.json
// Флаги: --revision <sha> (по умолчанию HEAD), --out <dir>, --manifest <path> (по умолчанию рядом с out),
//        --internal-docs=exclude|public|include (exclude — все внутренние документы; public — оставить
//        README/PROJECT-MAP/SELF-DEVELOPMENT, убрать AGENTS/CLAUDE/GEMINI; include — все),
//        --force (заменить непустую папку; новый экспорт готовится рядом, прежний возвращается при сбое), --self-check.
// Проверка НЕ является аудитом секретов: publication-blocking: secret audit pending.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })
const die = message => { console.error('ОТКАЗ: ' + message); process.exit(1) }

// Правила исключения: [регулярное выражение по пути от корня, причина]. Порядок важен — первая причина попадает в манифест.
const RULES = [
  [/^resources\/(?:1code-icon-(?:clean|final|transparent|transparent_original)|1code-icon_original|mark-source)\.png$/i, 'неиспользуемый черновик иконки'],
  [/(?:^|\/)(?:\.git|worktrees|node_modules|\.claude|\.codex|\.1code|\.agents|_private)\//i, 'служебный каталог разработки'],
  [/(?:^|\/)(?:audits|audit-093-evidence|design-validation|scratch|release|dist|out)\//i, 'локальные аудиты, снимки или сборки'],
  [/^(?:mobile\/android\/(?:\.gradle|build|app\/build)\/|.*(?:^|\/)build\/intermediates\/)/, 'выход сборки Android'],
  [/(?:^|\/)local\.properties$/, 'машинный путь Android SDK'],
  [/(?:^|\/)google-services\.json$/, 'ключи Firebase'],
  [/\.(?:apk|aab|apks)$/, 'собранное приложение Android'],
  [/(?:^|\/)\.env(?:\..*)?$/i, 'файл окружения с секретами'],
  [/(?:^|\/)(?:1code-settings\.json|Local State)$/i, 'локальный профиль пользователя'],
  [/\.(?:pem|p12|pfx|key|jks|keystore)$/i, 'ключ или хранилище ключей'],
  [/\.(?:log|tmp|temp|bak|orig|swp)$/i, 'журнал или временный файл'],
  [/^(?:PUBLIC-FILES\.md|safety-report\.json)$/i, 'служебный отчёт бенчмарка или старых ревизий'],
  [/(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/, 'мусор файловой системы']
]

// Внутренние документы. public-режим оставляет документы для внешнего читателя и убирает
// инструкции конкретных агентов; содержимое всё равно должно быть очищено до экспорта.
const INTERNAL_DOCS = {
  'AGENTS.md': 'excluded-until-sanitized',
  'CLAUDE.md': 'excluded',
  'GEMINI.md': 'excluded',
  'PROJECT-MAP.md': 'excluded-until-sanitized',
  'README.md': 'excluded-until-sanitized',
  'SELF-DEVELOPMENT.md': 'excluded'
}
const PUBLIC_DOCS = new Set(['README.md', 'PROJECT-MAP.md', 'SELF-DEVELOPMENT.md'])

// Записки агентов о слияниях: имена внутренних веток и ревизий, внешнему
// читателю не нужны. Правило по префиксу, чтобы новый INTEGRATION-*.md не
// просочился в экспорт только потому, что его забыли дописать в таблицу.
const INTERNAL_NOTE = /^INTEGRATION(?:-[a-z0-9-]+)?\.md$/i

function internalDocStatus (file) {
  const status = INTERNAL_DOCS[file]
  if (status) return status
  return INTERNAL_NOTE.test(file) ? 'excluded' : null
}

function docStatus (file, mode) {
  const status = internalDocStatus(file)
  if (!status) return null
  if (mode === 'include' || (mode === 'public' && PUBLIC_DOCS.has(file))) return 'included'
  return status
}

function classify (file, mode = 'exclude') {
  const status = docStatus(file, mode)
  return status && status !== 'included'
    ? { status, reason: 'внутренняя инструкция или документ разработки' }
    : null
}

function category (file) {
  if (file.startsWith('src/main/')) return 'source-main'
  if (file.startsWith('src/preload/')) return 'source-preload'
  if (file.startsWith('src/renderer/')) return 'source-renderer'
  if (file.startsWith('src/shared/')) return 'source-shared'
  if (file.startsWith('src/cli/')) return 'source-cli'
  if (file.startsWith('tests/retired/')) return 'test-retired'
  if (file.startsWith('tests/')) return 'test'
  if (file.startsWith('mobile/')) return 'mobile'
  if (file.startsWith('server/')) return 'server'
  if (file.startsWith('scripts/')) return 'script'
  if (file.startsWith('resources/')) return 'resource'
  if (file.startsWith('build/')) return 'installer'
  if (file.startsWith('tools/')) return 'tool'
  if (file.startsWith('archive/')) return 'archive'
  if (file.endsWith('.md')) return 'doc'
  return 'config'
}

// git ls-tree -r -l: mode type sha size\tpath. Содержимое — одним git cat-file --batch, чтобы не звать git 832 раза.
function readRevision (revision) {
  let listing
  try {
    listing = git('ls-tree', '-r', '-l', '-z', revision)
  } catch {
    die(`ревизия не найдена: ${revision}`)
  }
  const entries = listing.split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t')
    const meta = line.slice(0, tab), file = line.slice(tab + 1)
    const [mode, type, sha, size] = meta.trim().split(/\s+/)
    return { file, mode, type, sha, size: Number(size) }
  })
  return entries
}

function readBlobs (shas) {
  const out = execFileSync('git', ['-C', ROOT, 'cat-file', '--batch'], {
    input: shas.join('\n') + '\n', maxBuffer: 1 << 30
  })
  const blobs = new Map()
  let at = 0
  for (const sha of shas) {
    const eol = out.indexOf(10, at)
    const [size] = out.subarray(at, eol).toString().trim().split(/\s+/).slice(2)
    const start = eol + 1
    const length = Number(size)
    blobs.set(sha, out.subarray(start, start + length))
    at = start + length + 1 // после данных идёт перевод строки
  }
  return blobs
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex')
// Git blob id: те же байты, что в ревизии, дают тот же объект; связывает файл с ls-tree.
const gitBlob = buffer => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`), buffer])).digest('hex')
const SHA1 = /^[0-9a-f]{40}$/i

function plan (revision, internalDocs) {
  const entries = readRevision(revision)
  const included = []
  const excluded = []
  const docs = []
  for (const entry of entries) {
    if (entry.type !== 'blob') die(`не блоб: ${entry.file} (${entry.type})`)
    if (!['100644', '100755'].includes(entry.mode)) die(`ссылка или неподдерживаемый Git mode: ${entry.file}`)
    if (path.isAbsolute(entry.file) || /[\\:\x00-\x1f]/.test(entry.file) || entry.file.split('/').some(part => !part || part === '.' || part === '..')) die(`небезопасный путь Git: ${entry.file}`)
    if (internalDocStatus(entry.file)) docs.push({ path: entry.file, status: docStatus(entry.file, internalDocs) })
    const skipped = classify(entry.file, internalDocs)
    let reason = RULES.find(([re]) => re.test(entry.file))?.[1]
    if (skipped && !reason) reason = skipped.reason
    if (reason) excluded.push({ path: entry.file, reason })
    else included.push(entry)
  }
  const seen = new Set()
  for (const file of [...included.map(e => e.file), ...excluded.map(e => e.path)]) {
    if (seen.has(file)) die(`файл учтён дважды: ${file}`)
    seen.add(file)
  }
  if (seen.size !== entries.length) die(`учтено ${seen.size} из ${entries.length} файлов ревизии`)
  return { revision, entries, included, excluded, docs, mode: internalDocs }
}

// Экспорт транзакционный: содержимое и манифест готовятся в памяти и временных путях,
// прежний out уходит в backup и возвращается при любом сбое — до готовности out не трогается.
function writeExport (plan, out, manifestPath) {
  const manifestReal = realish(manifestPath)
  if (protectedRoots().some(root => inside(root, manifestReal))) die('--manifest не может заменять исходники или Git репозитория')
  if (manifestPath === out) die('--manifest не может совпадать с --out')
  const manifestRelative = path.relative(out, manifestPath).split(path.sep).join('/')
  if (plan.included.some(entry => entry.file.toLowerCase() === manifestRelative.toLowerCase())) die('--manifest совпадает с файлом экспорта')
  const blobs = readBlobs(plan.included.map(e => e.sha))
  const files = []
  const writes = []
  for (const entry of plan.included) {
    const data = blobs.get(entry.sha)
    if (!data || data.length !== entry.size) die(`размер не совпал: ${entry.file}`)
    writes.push({ file: entry.file, data })
    files.push({ path: entry.file, size: entry.size, sha256: sha256(data), gitBlob: entry.sha, gitMode: entry.mode, category: category(entry.file) })
  }
  const categories = {}
  for (const file of files) {
    const bucket = categories[file.category] || (categories[file.category] = { files: 0, bytes: 0 })
    bucket.files++
    bucket.bytes += file.size
  }
  const revision = git('rev-parse', plan.revision).trim()
  const manifest = {
    revision,
    // Дерево ревизии: по нему набор файлов сверяется с исходным репозиторием
    // (`git rev-parse <revision>^{tree}`), а не только с самим манифестом.
    tree: git('rev-parse', `${plan.revision}^{tree}`).trim(),
    generatedAt: new Date().toISOString(),
    source: 'git ls-tree + git cat-file (working tree not used)',
    counts: {
      tracked: plan.entries.length,
      included: files.length,
      excluded: plan.excluded.length,
      includedBytes: files.reduce((sum, file) => sum + file.size, 0)
    },
    categories,
    internalDocsMode: plan.mode,
    internalDocs: plan.docs,
    files,
    excluded: plan.excluded,
    publicationBlocking: plan.mode === 'public'
      ? 'secret audit pending; README/PROJECT-MAP/SELF-DEVELOPMENT must be sanitized in this revision — не считать экспорт безопасным'
      : 'secret audit pending; internal documents unsanitized — не считать экспорт безопасным или готовым к публикации'
  }
  const serialized = JSON.stringify(manifest, null, 2) + '\n'

  const suffix = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const staging = `${out}.staging-${suffix}`
  const backup = `${out}.backup-${suffix}`
  if (manifestPath === out) die('--manifest не может совпадать с --out')
  const manifestInside = manifestPath.startsWith(out + path.sep)
  const manifestTemp = manifestInside ? null : `${manifestPath}.tmp-${suffix}`
  const hadOut = fs.existsSync(out)
  try {
    fs.mkdirSync(staging, { recursive: true })
    for (const { file, data } of writes) {
      const target = path.join(staging, ...file.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, data)
    }
    if (manifestInside) {
      const target = path.join(staging, path.relative(out, manifestPath))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, serialized)
    } else {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
      fs.writeFileSync(manifestTemp, serialized)
    }
    if (hadOut) fs.renameSync(out, backup)
    let swapped = false
    try {
      fs.renameSync(staging, out)
      swapped = true
      if (manifestTemp) fs.renameSync(manifestTemp, manifestPath)
    } catch (error) {
      if (swapped) fs.rmSync(out, { recursive: true, force: true })
      if (hadOut) fs.renameSync(backup, out)
      throw error
    }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    if (manifestTemp) fs.rmSync(manifestTemp, { force: true })
    if (hadOut && !fs.existsSync(out)) fs.renameSync(backup, out)
    die(`экспорт не записан, прежняя папка восстановлена: ${error.message}`)
  }
  if (hadOut) {
    try { fs.rmSync(backup, { recursive: true, force: true }) } catch (error) { console.error('ПРЕДУПРЕЖДЕНИЕ: резервная копия не удалена: ' + backup) }
  }
  return manifest
}

// realpath для ещё не существующего пути: разрешаем ближайшего существующего родителя.
function realish (target) {
  const missing = []
  let current = target
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return target
    missing.unshift(path.basename(current))
    current = parent
  }
  return path.join(fs.realpathSync(current), ...missing)
}

// out не должен быть ссылкой или файлом, репозиторием, его предком или потомком.
function inside(root, target) {
  const relative = path.relative(root, target)
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}
function protectedRoots() {
  const roots = [fs.realpathSync(ROOT)]
  try { roots.push(fs.realpathSync(path.resolve(ROOT, git('rev-parse', '--git-common-dir').trim()))) } catch { return roots }
  return roots
}
function assertSafeOut (out, force) {
  let stat = null
  try { stat = fs.lstatSync(out) } catch {}
  if (stat && stat.isSymbolicLink()) die(`out — symlink/junction, а не каталог: ${out}`)
  if (stat && !stat.isDirectory()) die(`out существует и это не каталог: ${out}`)
  const realOut = realish(out)
  if (protectedRoots().some(root => inside(root, realOut) || inside(realOut, root))) die(`нельзя затереть исходники или Git репозитория: ${out}`)
  if (stat && fs.readdirSync(out).length && !force) die(`папка не пуста: ${out} (--force)`)
}

function verify (dir, manifestPath) {
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) die('экспорт должен быть обычным каталогом, не ссылкой')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const problems = []
  if (!SHA1.test(String(manifest.revision || ''))) problems.push('в манифесте нет полного SHA-1 ревизии')
  if (!SHA1.test(String(manifest.tree || ''))) problems.push('в манифесте нет дерева ревизии (tree)')
  const present = new Map()
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? rel + '/' + entry.name : entry.name
      if (entry.isSymbolicLink()) { problems.push(`ссылка в экспорте: ${child}`); continue }
      if (entry.isDirectory()) { walk(child); continue }
      if (!entry.isFile()) { problems.push(`не обычный файл: ${child}`); continue }
      if (path.resolve(dir, child) === manifestPath && !manifest.files.some(file => file.path === child)) continue
      const data = fs.readFileSync(path.join(dir, child))
      present.set(child, { size: data.length, sha256: sha256(data), gitBlob: gitBlob(data) })
    }
  }
  if (!fs.existsSync(dir)) die(`нет папки экспорта: ${dir}`)
  walk('')
  for (const file of manifest.files) {
    const onDisk = present.get(file.path)
    if (!onDisk) problems.push(`нет файла: ${file.path}`)
    else if (onDisk.size !== file.size || onDisk.sha256 !== file.sha256) problems.push(`не совпал хэш или размер: ${file.path}`)
    if (!SHA1.test(String(file.gitBlob || ''))) problems.push(`нет git blob в манифесте: ${file.path}`)
    else if (onDisk && onDisk.gitBlob !== file.gitBlob) problems.push(`git blob не совпал с ревизией: ${file.path}`)
    if (!['100644', '100755'].includes(file.gitMode)) problems.push(`нет git mode в манифесте: ${file.path}`)
  }
  for (const entry of manifest.excluded) if (present.has(entry.path)) problems.push(`исключённый путь на месте: ${entry.path}`)
  for (const file of present.keys()) {
    if (!manifest.files.some(item => item.path === file)) problems.push(`лишний файл: ${file}`)
    if (RULES.some(([re]) => re.test(file))) problems.push(`запрещённый путь в экспорте: ${file}`)
  }
  if (present.size !== manifest.counts.included) problems.push(`файлов на диске ${present.size}, в манифесте ${manifest.counts.included}`)
  if (manifest.counts.included + manifest.counts.excluded !== manifest.counts.tracked) problems.push('counts не сходятся')
  for (const line of problems) console.error('ПРОВАЛ ' + line)
  console.log(JSON.stringify({
    ok: problems.length === 0, dir, revision: manifest.revision, tree: manifest.tree,
    files: present.size, bytes: manifest.counts.includedBytes, problems: problems.length,
    note: 'это проверка целостности копии, не аудит секретов'
  }))
  process.exit(problems.length ? 1 : 0)
}

function selfCheck () {
  const assert = require('node:assert/strict')
  assert.equal(classify('src/main/main.js'), null)
  assert.equal(classify('build/installer.nsh'), null, 'build/installer.nsh нужен electron-builder')
  assert.equal(classify('mobile/android/app/build.gradle'), null, 'build.gradle — исходник, не выход сборки')
  assert.ok(RULES.find(([re]) => re.test('.env.local')))
  assert.ok(RULES.find(([re]) => re.test('mobile/android/app/build/intermediates/x.class')))
  assert.ok(RULES.find(([re]) => re.test('node_modules/ws/index.js')))
  assert.ok(RULES.find(([re]) => re.test('nested/worktrees/agent/notes.md')))
  assert.ok(RULES.find(([re]) => re.test('audits/2026-10-28/report.md')))
  assert.ok(RULES.find(([re]) => re.test('profile/1code-settings.json')))
  assert.ok(RULES.find(([re]) => re.test('profile/Local State')))
  assert.ok(RULES.find(([re]) => re.test('logs/app.log')))
  assert.ok(RULES.find(([re]) => re.test('dist/app.asar')))
  assert.equal(category('tests/retired/x.cjs'), 'test-retired')
  assert.equal(category('mobile/www/index.html'), 'mobile')
  assert.equal(INTERNAL_DOCS['README.md'], 'excluded-until-sanitized')
  assert.equal(classify('README.md', 'exclude').status, 'excluded-until-sanitized')
  assert.equal(classify('README.md', 'public'), null)
  assert.equal(classify('PROJECT-MAP.md', 'public'), null)
  assert.equal(classify('AGENTS.md', 'public').status, 'excluded-until-sanitized')
  assert.equal(classify('AGENTS.md', 'include'), null)
  assert.equal(classify('INTEGRATION.md', 'public').status, 'excluded')
  assert.equal(classify('INTEGRATION-review.md', 'public').status, 'excluded')
  assert.equal(classify('INTEGRATION-note-for-a-reader.md', 'public').status, 'excluded')
  assert.equal(classify('src/main/INTEGRATION.md', 'public'), null, 'правило действует только на корневые записки')
  console.log('self-check ok')
}

function main () {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const index = argv.indexOf('--' + name)
    return index < 0 ? fallback : (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : true)
  }
  if (argv.includes('--self-check')) return selfCheck()
  const docArg = argv.find(arg => arg.startsWith('--internal-docs='))
  const internalDocs = docArg ? docArg.slice('--internal-docs='.length) : 'exclude'
  if (!['exclude', 'public', 'include'].includes(internalDocs)) die('--internal-docs: exclude|public|include')
  const verifyDir = flag('verify')
  if (verifyDir) {
    if (verifyDir === true) die('--verify требует папку')
    const manifest = flag('manifest')
    if (!manifest || manifest === true) die('для --verify нужен --manifest <манифест>')
    return verify(path.resolve(verifyDir), path.resolve(manifest))
  }
  const outArg = flag('out')
  if (!outArg || outArg === true) die('нужен --out <dir> или --verify <dir>')
  const out = path.resolve(outArg)
  assertSafeOut(out, argv.includes('--force'))
  const revision = flag('revision', 'HEAD')
  const manifestPath = path.resolve(flag('manifest', out + '.manifest.json'))
  // Ревизия, план и все blob'ы проверяются до первой записи на диск.
  const built = plan(revision, internalDocs)
  const manifest = writeExport(built, out, manifestPath)
  console.log(JSON.stringify({
    out, manifest: manifestPath, revision: manifest.revision, counts: manifest.counts,
    internalDocs, excluded: manifest.excluded.length,
    note: 'publication-blocking: secret audit pending'
  }, null, 2))
}

main()
