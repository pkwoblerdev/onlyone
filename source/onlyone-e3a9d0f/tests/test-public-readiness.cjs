// Технический verifier публичной подготовки: подставные экспорт, манифест и прогон
// во временных каталогах os.tmpdir(). Сети нет, репозиторий и чужие папки не трогаются.
// Проверяется только техника: лицензии и право публикации verifier не решает.
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const script = path.join(ROOT, 'scripts', 'verify-public-readiness.cjs')
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-readiness-'))
const REV = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')

// Минимальный, но полный набор обязательных файлов публичного экспорта:
// документы и notices, установщик и CLI, точки входа, mobile/server.
const FILES = {
  'README.md': '# onlyone\n',
  'THIRD-PARTY-NOTICES.md': '# Third-party notices\n',
  'LICENSES/OFL-1.1.txt': 'SIL OFL 1.1\n',
  'src/renderer/vendor/react-LICENSE.txt': 'MIT\n',
  'src/renderer/vendor/react-dom-LICENSE.txt': 'MIT\n',
  'package.json': JSON.stringify({ name: 'onlyone', version: '0.0.0', main: 'src/main/main.js', scripts: { build: 'x', 'build:win': 'x', test: 'x', 'test:public-record': 'x' } }) + '\n',
  'package-lock.json': '{"lockfileVersion":3}\n',
  'electron-builder.config.cjs': "module.exports = { appId: 'com.onecode.workspace', productName: 'onlyone' }\n",
  'build/installer.nsh': '!macro fixture\n!macroend\n',
  'resources/1code.ico': 'icon fixture\n',
  'resources/cli/onlyone.cmd': '@echo off\n',
  'resources/cli/path.ps1': '# path fixture\n',
  'src/main/main.js': '// main\n',
  'src/preload/preload.js': '// preload\n',
  'src/renderer/index.html': '<!doctype html>\n',
  'src/renderer/app.js': '// app\n',
  'mobile/capacitor.config.json': JSON.stringify({ appId: 'best.pkwobler.onlyone', appName: 'onlyone', webDir: 'www' }) + '\n',
  'mobile/package.json': '{"name":"mobile","version":"0.0.0"}\n',
  'server/relay/package.json': '{"name":"relay","version":"0.0.0"}\n'
}
const gitBlobOf = text => {
  const data = Buffer.from(text)
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + data.length + '\0'), data])).digest('hex')
}

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.log('ПРОВАЛ ' + name + ' — ' + error.message)
  }
}

const manifestFor = (files = FILES) => {
  const entries = Object.entries(files).map(([file, text]) => {
    const data = Buffer.from(text)
    return { path: file, size: data.length, sha256: sha256(data), gitBlob: gitBlobOf(text), gitMode: '100644', category: 'test' }
  })
  return {
    revision: REV,
    tree: 'd'.repeat(40),
    generatedAt: '2026-10-26T00:00:00.000Z',
    source: 'test fixture',
    counts: {
      tracked: entries.length + 1,
      included: entries.length,
      excluded: 1,
      includedBytes: entries.reduce((sum, item) => sum + item.size, 0)
    },
    categories: {},
    internalDocsMode: 'public',
    files: entries,
    excluded: [{ path: 'AGENTS.md', reason: 'внутренняя инструкция' }],
    publicationBlocking: 'test fixture'
  }
}

const runFor = (dir, overrides = {}) => {
  const log = path.join(dir, 'full-test.log')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(log, 'pretest ok\ntest ok\n')
  return {
    runner: 'onlyone-public-tests/v1',
    command: ['npm', 'test'],
    ok: true,
    manifestSha256: sha256(JSON.stringify(manifestFor(), null, 2) + '\n'),
    sourceBefore: sha256(JSON.stringify(manifestFor().files.map(({path,size,sha256}) => ({path,size,sha256})).sort((a,b) => a.path.localeCompare(b.path, 'en')))),
    sourceAfter: sha256(JSON.stringify(manifestFor().files.map(({path,size,sha256}) => ({path,size,sha256})).sort((a,b) => a.path.localeCompare(b.path, 'en')))),
    checkoutBefore: 'c'.repeat(40),
    checkoutAfter: 'c'.repeat(40),
    statusBefore: '', statusAfter: '', changed: [],
    logSha256: sha256(fs.readFileSync(log)),
    revision: REV,
    startedAt: '2026-10-26T18:57:24.000Z',
    finishedAt: '2026-10-26T19:00:23.000Z',
    durationMs: 179000,
    code: 0,
    signal: null,
    log,
    ...overrides
  }
}

const scenario = (name, options = {}) => {
  const files = options.files || FILES
  const dir = path.join(base, name)
  const exportDir = path.join(dir, 'export')
  fs.mkdirSync(exportDir, { recursive: true })
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(exportDir, ...file.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
  }
  const manifestPath = path.join(dir, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(options.manifest || manifestFor(files), null, 2) + '\n')
  const runPath = options.runPath || path.join(dir, 'run.json')
  if (!options.noRun) fs.writeFileSync(runPath, JSON.stringify(options.run || runFor(dir), null, 2) + '\n')
  return { dir, exportDir, manifestPath, runPath }
}

const verify = (fixture, extra = []) => spawnSync(process.execPath, [
  script, '--export', fixture.exportDir, '--manifest', fixture.manifestPath,
  '--run', fixture.runPath, '--revision', REV, ...extra
], { encoding: 'utf8' })

const reportOf = result => {
  try { return JSON.parse(result.stdout) } catch { throw new Error('нет JSON в stdout: ' + (result.stdout || result.stderr).slice(0, 300)) }
}

const expectRefusal = (name, fixture, needle, extra = []) => check(name, () => {
  const result = verify(fixture, extra)
  assert.equal(result.status, 1, 'код ' + result.status + ': ' + (result.stderr || result.stdout).slice(0, 300))
  assert.equal(reportOf(result).technicalReady, false, 'technicalReady не false')
  assert.ok((result.stderr || '').includes(needle), 'в отказе нет «' + needle + '»: ' + result.stderr.slice(0, 300))
})

check('1. валидный экспорт, манифест и прогон: ready true, legal unresolved', () => {
  const fixture = scenario('valid')
  const result = verify(fixture)
  assert.equal(result.status, 0, 'код ' + result.status + ': ' + (result.stderr || result.stdout).slice(0, 300))
  const report = reportOf(result)
  assert.equal(report.technicalReady, true)
  assert.equal(report.revision, REV)
  assert.deepEqual(report.legal, { status: 'unresolved', publicationAllowed: false })
  assert.ok(report.checks.length >= 4, 'слишком мало проверок: ' + report.checks.length)
  assert.ok(report.checks.every(item => item.ok), 'в отчёте есть провалившиеся проверки')
})

check('2. LICENSE на месте, но legal всё равно unresolved и публикация запрещена', () => {
  const fixture = scenario('license')
  const report = reportOf(verify(fixture))
  assert.equal(report.legal.status, 'unresolved')
  assert.equal(report.legal.publicationAllowed, false)
  assert.equal(JSON.stringify(report).includes('"publicationAllowed":true'), false, 'verifier разрешил публикацию')
})

expectRefusal('3. ревизия в run расходится с --revision', scenario('rev-run', {
  run: runFor(path.join(base, 'rev-run'), { revision: OTHER })
}), 'ревизи')

expectRefusal('4. ревизия в манифесте расходится с --revision', (() => {
  const fixture = scenario('rev-manifest')
  const manifest = manifestFor()
  manifest.revision = OTHER
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return fixture
})(), 'ревизи')

check('5. --revision не совпадает с манифестом и прогоном', () => {
  const fixture = scenario('rev-flag')
  const result = spawnSync(process.execPath, [
    script, '--export', fixture.exportDir, '--manifest', fixture.manifestPath,
    '--run', fixture.runPath, '--revision', OTHER
  ], { encoding: 'utf8' })
  assert.equal(result.status, 1)
})

expectRefusal('6. полный прогон завершился с кодом 1', scenario('exit1', {
  run: runFor(path.join(base, 'exit1'), { code: 1 })
}), 'кодом 1')

expectRefusal('7. код прогона null — незавершённый прогон', scenario('code-null', {
  run: runFor(path.join(base, 'code-null'), { code: null })
}), 'кодом null')

expectRefusal('8. нет finishedAt', scenario('no-finished', {
  run: runFor(path.join(base, 'no-finished'), { finishedAt: undefined })
}), 'finishedAt')

expectRefusal('9. прогон прерван сигналом', scenario('signal', {
  run: runFor(path.join(base, 'signal'), { signal: 'SIGINT' })
}), 'сигнал')

expectRefusal('10. файл экспорта изменён после манифеста', (() => {
  const fixture = scenario('changed')
  fs.writeFileSync(path.join(fixture.exportDir, 'README.md'), '# onlyone changed\n')
  return fixture
})(), 'не совпал')

expectRefusal('11. counts манифеста не сходятся', (() => {
  const fixture = scenario('counts')
  const manifest = manifestFor()
  manifest.counts.tracked += 1
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return fixture
})(), 'counts')

expectRefusal('12. у файла манифеста нет sha256', (() => {
  const fixture = scenario('no-sha')
  const manifest = manifestFor()
  delete manifest.files[0].sha256
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return fixture
})(), 'sha256')

expectRefusal('13. дубль пути в манифесте', (() => {
  const fixture = scenario('duplicate')
  const manifest = manifestFor()
  const extra = { ...manifest.files[0] }
  manifest.files.push(extra)
  manifest.counts.included += 1
  manifest.counts.tracked += 1
  manifest.counts.includedBytes += extra.size
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return fixture
})(), 'дубль')

expectRefusal('14. лишний файл в экспорте', (() => {
  const fixture = scenario('extra')
  fs.writeFileSync(path.join(fixture.exportDir, 'extra.txt'), 'не из манифеста\n')
  return fixture
})(), 'лишний файл')

expectRefusal('15. node_modules в экспорте — экспорт изменён', (() => {
  const fixture = scenario('node-modules')
  fs.mkdirSync(path.join(fixture.exportDir, 'node_modules', 'ws'), { recursive: true })
  fs.writeFileSync(path.join(fixture.exportDir, 'node_modules', 'ws', 'index.js'), 'module.exports = {}\n')
  return fixture
})(), 'node_modules')

expectRefusal('16. нет файла run.json', scenario('no-run', { noRun: true }), 'не прочитан')

expectRefusal('17. нет лога прогона', scenario('no-log', {
  run: runFor(path.join(base, 'no-log'), { log: path.join(base, 'no-log', 'missing.log') })
}), 'лог')

check('18. --out пишет readiness.json с legal unresolved', () => {
  const fixture = scenario('out')
  const out = path.join(fixture.dir, 'readiness.json')
  const result = verify(fixture, ['--out', out])
  assert.equal(result.status, 0, 'код ' + result.status + ': ' + (result.stderr || result.stdout).slice(0, 300))
  const saved = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(saved.technicalReady, true)
  assert.equal(saved.revision, REV)
  assert.equal(saved.exportManifest.revision, REV)
  assert.deepEqual(saved.legal, { status: 'unresolved', publicationAllowed: false })
})

check('19. --out внутри экспорта — отказ, экспорт не пополняется', () => {
  const fixture = scenario('out-inside')
  const out = path.join(fixture.exportDir, 'readiness.json')
  const result = verify(fixture, ['--out', out])
  assert.equal(result.status, 1)
  assert.equal(fs.existsSync(out), false, 'readiness.json попал в экспорт')
})

check('20. без обязательных флагов — отказ', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(result.status, 1)
})

expectRefusal('21. an old handwritten exit-code record is insufficient', (() => {
  const fixture = scenario('legacy-record')
  const record = runFor(fixture.dir)
  delete record.runner
  fs.writeFileSync(fixture.runPath, JSON.stringify(record))
  return fixture
})(), 'runner')
expectRefusal('22. log changed since the recorded run', (() => {
  const fixture = scenario('changed-log')
  fs.appendFileSync(path.join(fixture.dir, 'full-test.log'), 'changed later')
  return fixture
})(), 'sha256')
expectRefusal('23. tested source digest differs', scenario('other-source', {run:runFor(path.join(base,'other-source'),{sourceAfter:'f'.repeat(64)})}), 'исходник')
expectRefusal('24. a successful command with dirty source is refused', scenario('dirty-source', {run:runFor(path.join(base,'dirty-source'),{statusAfter:' M package.json'})}), 'Git')
check('25. readiness output must not overwrite the test log', () => {
  const fixture=scenario('output-log'),log=path.join(fixture.dir,'full-test.log'),before=fs.readFileSync(log)
  assert.equal(verify(fixture,['--out',log]).status,1)
  assert.deepEqual(fs.readFileSync(log),before)
})
check('26. readiness refuses a symlink export root', () => {
  const fixture=scenario('linked-root'),real=fixture.exportDir+'-real'
  fs.renameSync(fixture.exportDir,real);fs.symlinkSync(real,fixture.exportDir,process.platform==='win32'?'junction':'dir')
  assert.equal(verify(fixture).status,1)
})
const without = (...paths) => Object.fromEntries(Object.entries(FILES).filter(([file]) => !paths.includes(file)))
expectRefusal('27. no third-party notices — export is not ready', scenario('no-notices', { files: without('THIRD-PARTY-NOTICES.md') }), 'THIRD-PARTY-NOTICES')
expectRefusal('28. no CLI launcher in resources/cli', scenario('no-cli', { files: without('resources/cli/onlyone.cmd') }), 'resources/cli/onlyone.cmd')
expectRefusal('29. mobile appId changed — integration identity broken', (() => {
  const files = { ...FILES, 'mobile/capacitor.config.json': JSON.stringify({ appId: 'com.example.other', webDir: 'www' }) + '\n' }
  return scenario('mobile-appid', { files })
})(), 'best.pkwobler.onlyone')
expectRefusal('30. authorship trace (Co-Authored-By) in an exported file', (() => {
  const files = { ...FILES, 'src/main/notes.js': ['// Co-Authored', 'By: Claude <noreply@anthropic.com>'].join('-') + '\n' }
  return scenario('authorship', { files })
})(), 'авторств')
expectRefusal('31. manifest without git blob ids is not bound to the revision', (() => {
  const fixture = scenario('no-blob')
  const manifest = manifestFor()
  delete manifest.files[0].gitBlob
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return fixture
})(), 'git blob')
expectRefusal('32. manifest without the revision tree is not bound to the revision', (() => {
  const fixture = scenario('no-tree')
  const manifest = manifestFor()
  delete manifest.tree
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return fixture
})(), 'дерев')
check('33. valid report names the revision tree', () => {
  const report = reportOf(verify(scenario('tree-report')))
  assert.equal(report.exportManifest.tree, 'd'.repeat(40))
})
fs.rmSync(base, { recursive: true, force: true })
console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
