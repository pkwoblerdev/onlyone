#!/usr/bin/env node
// Технический verifier публичной подготовки версии: ревизия и её дерево, SHA256 и git blob
// файлов экспорта, обязательные ресурсы/notices, следы авторства моделей, зелёный полный npm test.
// Порядок подготовки — scripts/PUBLIC-EXPORT.md.
//   node scripts/verify-public-readiness.cjs --export <dir> --manifest <manifest.json> \
//     --run <run.json> --revision <sha> [--out <readiness.json>]
// --run — JSON обёртки полного прогона: revision, startedAt, finishedAt, durationMs, code,
//         signal, log (путь к логу; относительный считается от файла run.json).
// Проверяет согласованность локальной записи прогона и экспорта; не удостоверяет автора записи.
// НЕ проверяет лицензии, права, секреты и НЕ разрешает публикацию: legal всегда unresolved.
// Наличие LICENSE ничего не доказывает и на вывод не влияет.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')
const gitBlob = data => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest('hex')
const SHA1 = /^[0-9a-f]{40}$/i
const SHA256 = /^[0-9a-f]{64}$/

// Файлы, без которых копия не соберётся или потеряет обязательные notices и интеграции.
// LICENSE сюда не входит: правообладатель — отдельное решение человека.
const REQUIRED = [
  'package.json', 'package-lock.json',
  'README.md', 'THIRD-PARTY-NOTICES.md', 'LICENSES/OFL-1.1.txt',
  'src/renderer/vendor/react-LICENSE.txt', 'src/renderer/vendor/react-dom-LICENSE.txt',
  'electron-builder.config.cjs', 'build/installer.nsh',
  'resources/1code.ico', 'resources/cli/onlyone.cmd', 'resources/cli/path.ps1',
  'src/main/main.js', 'src/preload/preload.js', 'src/renderer/index.html', 'src/renderer/app.js',
  'mobile/capacitor.config.json', 'mobile/package.json', 'server/relay/package.json'
]
const PACKAGE_SCRIPTS = ['build', 'build:win', 'test', 'test:public-record']

// Следы авторства моделей в тексте. Названия провайдеров (Claude, Gemini, …) сами по себе
// разрешены — ищем только формулы авторства, поэтому массовой чистки комментариев не нужно.
const ATTRIBUTION = [
  [/\bco-authored-by\s*:/i, 'трейлер Co-Authored-By'],
  [/\b(?:generated|written|authored|created|implemented|reviewed)\s+by\s+(?:claude|codex|gemini|qoder|deepseek|copilot|gpt)\b/i, 'авторство модели по-английски'],
  [/(?:claude|codex|gemini|qoder|deepseek)\s+(?:wrote|decided|measured|implemented|reviewed)\b/i, 'авторство модели по-английски'],
  [/(?:поручени[ея]|приёмк[аи]|решение|снято с|замер(?:ил|ено)|проверил[аи]?)\s+(?:claude|codex|gemini|qoder|deepseek)\b/i, 'авторство модели в комментарии'],
  [/(?:claude|codex|gemini|qoder|deepseek)\s+(?:написал[аи]?|сделал[аи]?|измерил[аи]?|решил[аи]?|поручил[аи]?|проверил[аи]?)\b/i, 'авторство модели в комментарии']
]

function flag (argv, name) {
  const index = argv.indexOf('--' + name)
  if (index < 0) return null
  const value = argv[index + 1]
  return value && !value.startsWith('--') ? value : true
}

const fail = message => { console.error('ОТКАЗ: ' + message); process.exit(1) }

const checks = []
function check (id, body) {
  const problems = []
  try {
    body(message => problems.push(message))
  } catch (error) {
    problems.push('проверка не выполнена: ' + error.message)
  }
  checks.push({ id, ok: problems.length === 0, problems })
}

// Снимок каталога: относительные пути через «/», размер и sha256 каждого файла.
// Ссылки не разыменовываются: в экспорте их быть не должно.
function snapshot (dir, problem) {
  const files = new Map()
  const walk = rel => {
    const abs = rel ? path.join(dir, ...rel.split('/')) : dir
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = rel ? rel + '/' + entry.name : entry.name
      if (entry.isSymbolicLink()) { problem(`ссылка в экспорте: ${child}`); continue }
      if (entry.isDirectory()) { walk(child); continue }
      if (!entry.isFile()) { problem(`не обычный файл в экспорте: ${child}`); continue }
      const data = fs.readFileSync(path.join(abs, entry.name))
      files.set(child, { size: data.length, sha256: sha256(data), gitBlob: gitBlob(data) })
    }
  }
  walk('')
  return files
}

function main () {
  const argv = process.argv.slice(2)
  const exportArg = flag(argv, 'export')
  const manifestArg = flag(argv, 'manifest')
  const runArg = flag(argv, 'run')
  const revision = flag(argv, 'revision')
  const outArg = flag(argv, 'out')
  for (const [name, value] of [['export', exportArg], ['manifest', manifestArg], ['run', runArg], ['revision', revision]]) {
    if (!value) fail(`нужен --${name} <значение>`)
    if (value === true) fail(`--${name} требует значение`)
  }
  if (outArg === true) fail('--out требует путь')

  const exportDir = path.resolve(exportArg)
  const manifestPath = path.resolve(manifestArg)
  const runPath = path.resolve(runArg)
  const out = outArg ? path.resolve(outArg) : null
  if (out) {
    const inside = path.relative(exportDir, out)
    if (!inside.startsWith('..') && !path.isAbsolute(inside)) fail(`--out не может быть внутри экспорта: ${out}`)
    if (out === manifestPath || out === runPath) fail('--out не может заменить манифест или файл прогона')
  }

  let manifest = null
  let run = null
  let manifestDigest = null
  let runDigest = null
  let present = null
  let logPath = null
  let logBytes = null
  let logDigest = null
  let attributionScanned = null

  check('inputs', problem => {
    if (!SHA1.test(revision)) problem(`--revision должен быть полным SHA-1 коммита: ${revision}`)
    try {
      const bytes = fs.readFileSync(manifestPath)
      manifestDigest = sha256(bytes)
      manifest = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      problem(`манифест не прочитан: ${manifestPath} (${error.message})`)
    }
    try {
      const bytes = fs.readFileSync(runPath)
      runDigest = sha256(bytes)
      run = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      problem(`файл прогона не прочитан: ${runPath} (${error.message})`)
    }
  })

  check('manifest', problem => {
    if (!manifest) return problem('манифест не прочитан')
    const counts = manifest.counts
    if (!counts || !Array.isArray(manifest.files) || !Array.isArray(manifest.excluded)) {
      return problem('в манифесте нет counts/files/excluded')
    }
    if (manifest.revision !== revision) problem(`ревизия манифеста ${manifest.revision} не совпадает с ${revision}`)
    if (counts.tracked !== counts.included + counts.excluded) {
      problem(`counts не сходятся: tracked ${counts.tracked} ≠ included ${counts.included} + excluded ${counts.excluded}`)
    }
    if (manifest.files.length !== counts.included) problem(`файлов в манифесте ${manifest.files.length}, counts.included ${counts.included}`)
    if (manifest.excluded.length !== counts.excluded) problem(`исключений в манифесте ${manifest.excluded.length}, counts.excluded ${counts.excluded}`)
    const seen = new Set()
    let bytes = 0
    for (const file of manifest.files) {
      if (!file || typeof file.path !== 'string' || !file.path) { problem('файл без пути в манифесте'); continue }
      if (seen.has(file.path)) problem(`дубль пути в манифесте: ${file.path}`)
      seen.add(file.path)
      if (!Number.isInteger(file.size) || file.size < 0) problem(`нет размера: ${file.path}`)
      else bytes += file.size
      if (!SHA256.test(String(file.sha256))) problem(`нет sha256: ${file.path}`)
    }
    if (bytes !== counts.includedBytes) problem(`includedBytes ${counts.includedBytes} ≠ сумма размеров файлов ${bytes}`)
    for (const entry of manifest.excluded) {
      if (!entry || typeof entry.path !== 'string') { problem('исключение без пути в манифесте'); continue }
      if (seen.has(entry.path)) problem(`путь и включён, и исключён: ${entry.path}`)
      seen.add(entry.path)
    }
  })

  check('export', problem => {
    if (!manifest) return problem('манифест не прочитан — сверять не с чем')
    if (!fs.existsSync(exportDir) || !fs.lstatSync(exportDir).isDirectory() || fs.lstatSync(exportDir).isSymbolicLink()) return problem(`нет обычной папки экспорта: ${exportDir}`)
    present = snapshot(exportDir, problem)
    const listed = new Map()
    for (const file of manifest.files || []) {
      if (file && typeof file.path === 'string') listed.set(file.path, file)
    }
    for (const [file, item] of listed) {
      const disk = present.get(file)
      if (!disk) problem(`нет файла экспорта: ${file}`)
      else if (disk.size !== item.size) problem(`размер не совпал: ${file}`)
      else if (disk.sha256 !== item.sha256) problem(`sha256 не совпал: ${file}`)
    }
    for (const entry of manifest.excluded || []) {
      if (entry && present.has(entry.path)) problem(`исключённый файл оказался в экспорте: ${entry.path}`)
    }
    for (const file of present.keys()) {
      if (listed.has(file)) continue
      if (file.split('/').includes('node_modules')) problem(`node_modules в экспорте — копия изменена после сборки: ${file}`)
      else problem(`лишний файл в экспорте: ${file}`)
    }
    if (manifest.counts && present.size !== manifest.counts.included) {
      problem(`файлов на диске ${present.size}, в манифесте ${manifest.counts.included}`)
    }
  })

  // Привязка к ревизии: каждый файл обязан совпасть с git blob из манифеста.
  // Дерево ревизии в манифесте сверяется с источником `git rev-parse <revision>^{tree}`.
  check('binding', problem => {
    if (!manifest) return problem('манифест не прочитан — привязывать не к чему')
    if (!SHA1.test(String(manifest.revision || ''))) problem('ревизия манифеста — не полный SHA-1')
    if (!SHA1.test(String(manifest.tree || ''))) problem('в манифесте нет дерева ревизии (tree) — набор файлов не привязан к ревизии')
    if (!present) return problem('снимок экспорта не снят')
    for (const file of manifest.files || []) {
      if (!file || typeof file.path !== 'string' || !file.path) continue
      if (!SHA1.test(String(file.gitBlob || ''))) problem(`нет git blob в манифесте: ${file.path}`)
      else {
        const disk = present.get(file.path)
        if (disk && disk.gitBlob !== file.gitBlob) problem(`git blob не совпал с ревизией: ${file.path}`)
      }
      if (!['100644', '100755'].includes(file.gitMode)) problem(`нет git mode в манифесте: ${file.path}`)
    }
  })

  // Следы авторства моделей: формулы авторства в тексте, не названия провайдеров.
  check('attribution', problem => {
    if (!present) return problem('снимок экспорта не снят')
    let scanned = 0
    for (const file of present.keys()) {
      let data
      try { data = fs.readFileSync(path.join(exportDir, ...file.split('/'))) } catch { continue }
      if (data.length > 1024 * 1024) continue
      if (data.subarray(0, 8192).includes(0)) continue
      scanned++
      const text = data.toString('utf8')
      for (const [re, label] of ATTRIBUTION) {
        if (re.test(text)) { problem(`след авторства (${label}) в файле ${file}`); break }
      }
    }
    attributionScanned = scanned
  })

  // Обязательные ресурсы, notices и действующие идентификаторы интеграций.
  check('required', problem => {
    if (!manifest) return problem('манифест не прочитан — состав не с чем сверять')
    const included = new Set((manifest.files || []).map(file => file && file.path))
    for (const file of REQUIRED) if (!included.has(file)) problem(`нет обязательного файла: ${file}`)
    if (!present) return
    if (present.has('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(exportDir, 'package.json'), 'utf8'))
        if (pkg.main !== 'src/main/main.js') problem(`package.json main неожиданный: ${pkg.main}`)
        for (const name of PACKAGE_SCRIPTS) if (!pkg.scripts || typeof pkg.scripts[name] !== 'string') problem(`в package.json нет скрипта ${name}`)
      } catch (error) { problem('package.json не читается: ' + error.message) }
    }
    if (present.has('mobile/capacitor.config.json')) {
      try {
        const cap = JSON.parse(fs.readFileSync(path.join(exportDir, 'mobile', 'capacitor.config.json'), 'utf8'))
        if (cap.appId !== 'best.pkwobler.onlyone') problem(`идентификатор Android-пакета изменён: ${cap.appId} (ожидается best.pkwobler.onlyone)`)
      } catch (error) { problem('mobile/capacitor.config.json не читается: ' + error.message) }
    }
    if (present.has('electron-builder.config.cjs')) {
      const builder = fs.readFileSync(path.join(exportDir, 'electron-builder.config.cjs'), 'utf8')
      if (!/appId\s*:\s*['"]com\.onecode\.workspace['"]/.test(builder)) problem('в electron-builder.config.cjs нет appId com.onecode.workspace')
    }
  })

  check('run', problem => {
    if (!run) return problem('файл прогона не прочитан')
    if (run.runner !== 'onlyone-public-tests/v1') problem('нужна запись runner onlyone-public-tests/v1')
    if (JSON.stringify(run.command) !== '["npm","test"]' || run.ok !== true) problem('нет успешного полного npm test')
    if (run.manifestSha256 !== manifestDigest) problem('sha256 проверенного манифеста не совпал')
    if (manifest && Array.isArray(manifest.files)) {
      const source = sha256(Buffer.from(JSON.stringify(manifest.files.map(({path,size,sha256}) => ({path,size,sha256})).sort((a,b) => a.path.localeCompare(b.path, 'en')))))
      if (run.sourceBefore !== source || run.sourceAfter !== source) problem('проверенные исходники не совпадают с экспортом')
    }
    if (!SHA1.test(run.checkoutBefore || '') || run.checkoutAfter !== run.checkoutBefore || run.statusBefore !== '' || run.statusAfter !== '' || !Array.isArray(run.changed) || run.changed.length) problem('Git изменён или не подтверждён до/после прогона')
    if (run.revision !== revision) problem(`ревизия прогона ${run.revision} не совпадает с ${revision}`)
    if (run.code !== 0) problem(`полный прогон завершился с кодом ${run.code}`)
    if (run.signal !== null && run.signal !== undefined && run.signal !== '') problem(`прогон прерван сигналом ${run.signal}`)
    const finished = Date.parse(run.finishedAt)
    if (!run.finishedAt) problem('нет finishedAt — прогон не завершён')
    else if (!Number.isFinite(finished)) problem(`finishedAt не дата: ${run.finishedAt}`)
    if (!Number.isFinite(run.durationMs) || run.durationMs <= 0) problem('нет durationMs')
    if (run.startedAt) {
      const started = Date.parse(run.startedAt)
      if (Number.isFinite(started) && Number.isFinite(finished) && finished < started) problem('finishedAt раньше startedAt')
    } else problem('нет startedAt')
    if (typeof run.log !== 'string' || !run.log) return problem('нет пути к логу прогона')
    logPath = path.resolve(path.dirname(runPath), run.log)
    let stat = null
    try { stat = fs.statSync(logPath) } catch {}
    if (!stat || !stat.isFile()) return problem(`лог прогона не найден: ${logPath}`)
    if (!stat.size) return problem(`лог прогона пуст: ${logPath}`)
    logBytes = stat.size
    logDigest = sha256(fs.readFileSync(logPath))
    if (run.logSha256 !== logDigest) problem('sha256 журнала не совпал с записью прогона')
  })

  // Второй проход: экспорт, манифест, run и лог не подменены между проверкой и вердиктом.
  check('stable', problem => {
    if (!present) return problem('снимок экспорта не снят')
    if (!manifestDigest || !runDigest) return problem('манифест или прогон не прочитаны')
    const again = snapshot(exportDir, problem)
    for (const [file, item] of present) {
      const now = again.get(file)
      if (!now) problem(`файл исчез после проверки: ${file}`)
      else if (now.size !== item.size || now.sha256 !== item.sha256) problem(`файл изменён после проверки: ${file}`)
    }
    for (const file of again.keys()) if (!present.has(file)) problem(`файл появился после проверки: ${file}`)
    if (sha256(fs.readFileSync(manifestPath)) !== manifestDigest) problem('манифест подменён после проверки')
    if (sha256(fs.readFileSync(runPath)) !== runDigest) problem('файл прогона подменён после проверки')
    if (logPath && logDigest && sha256(fs.readFileSync(logPath)) !== logDigest) problem('лог прогона изменён после проверки')
  })

  check('output', problem => {
    if (!out) return
    const target = fs.existsSync(out) ? fs.realpathSync(out) : path.join(fs.realpathSync(path.dirname(out)), path.basename(out))
    const relative = path.relative(fs.realpathSync(exportDir), target)
    if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) problem('output находится внутри экспорта')
    for (const input of [manifestPath, runPath, logPath].filter(Boolean)) if (path.relative(fs.realpathSync(input), target) === '') problem('output заменяет исходные доказательства')
  })
  const technicalReady = checks.every(item => item.ok)
  const report = {
    technicalReady,
    revision,
    checks,
    exportManifest: {
      path: manifestPath,
      sha256: manifestDigest,
      revision: manifest ? manifest.revision : null,
      tree: manifest ? manifest.tree : null,
      counts: manifest && manifest.counts ? manifest.counts : null,
      files: manifest && Array.isArray(manifest.files) ? manifest.files.length : null
    },
    attribution: { filesScanned: attributionScanned },
    run: {
      path: runPath,
      revision: run ? run.revision : null,
      startedAt: run ? run.startedAt : null,
      finishedAt: run ? run.finishedAt : null,
      durationMs: run ? run.durationMs : null,
      code: run ? run.code : null,
      signal: run ? run.signal : null,
      log: logPath,
      logBytes
    },
    // Права и лицензии verifier не решает — это отдельное решение человека.
    legal: { status: 'unresolved', publicationAllowed: false },
    evidence: { kind: 'local-run-record', executionAuthenticated: false }
  }

  if (!technicalReady) {
    for (const item of checks) for (const message of item.problems) console.error(`ПРОВАЛ ${item.id}: ${message}`)
  }

  let exitCode = technicalReady ? 0 : 1
  if (out && checks.find(item => item.id === 'output').ok) {
    try {
      if (logPath && path.resolve(out) === path.resolve(logPath)) throw Error('readiness output cannot overwrite the test log')
      fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
    } catch (error) {
      console.error(`ПРОВАЛ output: readiness.json не записан: ${out} (${error.message})`)
      exitCode = 1
    }
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(exitCode)
}

main()
