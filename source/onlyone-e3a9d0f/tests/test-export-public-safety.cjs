// Безопасность scripts/export-public.cjs: отказ не должен удалять прежний экспорт.
// Владелец воспроизвёл: неверная ревизия + --force → exit 1, а marker-файл исчез.
// Тест headless: свои временные каталоги в os.tmpdir(), репозиторий и чужие папки не трогаем.
'use strict'

const assert = require('node:assert/strict')
const { spawnSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const script = path.join(ROOT, 'scripts', 'export-public.cjs')
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-export-safety-'))
const INVALID = 'onlyone-no-such-revision-for-export-safety-test'
const MARKER = 'прежний экспорт\n'

let failed = 0
let skipped = 0

const run = (file, args) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' })
const detail = result => (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' | ').slice(0, 300)

const putMarker = dir => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'marker.txt'), MARKER)
}
const assertMarker = dir => assert.equal(fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8'), MARKER, 'прежний marker пропал')
const leftovers = dir => fs.readdirSync(dir).filter(name => /\.(?:staging|backup|tmp)-/.test(name))
const assertNoLeftovers = dir => assert.deepEqual(leftovers(dir), [], 'остались staging/backup/tmp: ' + leftovers(dir).join(', '))

const check = (name, fn) => {
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.log('ПРОВАЛ ' + name + ' — ' + error.message)
  }
}
const skip = (name, reason) => {
  skipped++
  console.log('  skip ' + name + ' — ' + reason)
}

// Копия скрипта в песочнице: ROOT — временный «репозиторий», даже сломанная
// проверка границ не доберётся до настоящего репозитория.
const sandbox = name => {
  const repo = path.join(base, name, 'repo')
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
  fs.copyFileSync(script, path.join(repo, 'scripts', 'export-public.cjs'))
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'репозиторий\n')
  return repo
}

check('1. неверная ревизия + --force: exit 1, прежний экспорт жив', () => {
  const dir = path.join(base, 'case1')
  const out = path.join(dir, 'out')
  putMarker(out)
  const result = run(script, ['--revision', INVALID, '--out', out, '--force'])
  assert.equal(result.status, 1, 'код ' + result.status + ': ' + detail(result))
  assertMarker(out)
  assertNoLeftovers(dir)
})

check('2. непустой out без --force: отказ, marker жив', () => {
  const dir = path.join(base, 'case2')
  const out = path.join(dir, 'out')
  putMarker(out)
  const result = run(script, ['--revision', 'HEAD', '--out', out])
  assert.equal(result.status, 1, 'код ' + result.status + ': ' + detail(result))
  assertMarker(out)
  assertNoLeftovers(dir)
})

check('3a. out = корень репозитория: отказ, файлы репозитория целы', () => {
  const repo = sandbox('case3a')
  const result = run(path.join(repo, 'scripts', 'export-public.cjs'), ['--out', repo, '--force'])
  assert.equal(result.status, 1, 'код ' + result.status + ': ' + detail(result))
  assert.equal(fs.readFileSync(path.join(repo, 'keep.txt'), 'utf8'), 'репозиторий\n', 'файл репозитория пропал')
})

check('3b. out внутри репозитория: отказ, marker жив', () => {
  const repo = sandbox('case3b')
  const out = path.join(repo, 'sub')
  putMarker(out)
  const result = run(path.join(repo, 'scripts', 'export-public.cjs'), ['--out', out, '--force'])
  assert.equal(result.status, 1, 'код ' + result.status + ': ' + detail(result))
  assertMarker(out)
  assert.equal(fs.existsSync(path.join(repo, 'keep.txt')), true, 'файл репозитория пропал')
})

check('3c. out = родитель репозитория + --force: отказ, ничего не удалено', () => {
  const repo = sandbox('case3c')
  const parent = path.dirname(repo)
  fs.writeFileSync(path.join(parent, 'marker.txt'), MARKER)
  const result = run(path.join(repo, 'scripts', 'export-public.cjs'), ['--out', parent, '--force'])
  assert.equal(result.status, 1, 'код ' + result.status + ': ' + detail(result))
  assertMarker(parent)
  assert.equal(fs.existsSync(path.join(repo, 'keep.txt')), true, 'репозиторий пострадал')
})

check('4. out — существующий файл, не каталог: отказ, файл жив', () => {
  const dir = path.join(base, 'case4')
  const out = path.join(dir, 'out.txt')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(out, MARKER)
  const result = run(script, ['--out', out, '--force'])
  assert.equal(result.status, 1, 'код ' + result.status + ': ' + detail(result))
  assert.equal(fs.readFileSync(out, 'utf8'), MARKER, 'файл out изменён или удалён')
})

const linkCase = () => {
  const dir = path.join(base, 'case5')
  const target = path.join(dir, 'target')
  const link = path.join(dir, 'out-link')
  putMarker(target)
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    return error
  }
  return null
}
const linkError = linkCase()
if (linkError) {
  skip('5. out — symlink/junction на каталог: отказ, ссылка и marker целы', 'среда не даёт создать ссылку: ' + linkError.message)
} else {
  check('5. out — symlink/junction на каталог: отказ, ссылка и marker целы', () => {
    const dir = path.join(base, 'case5')
    const target = path.join(dir, 'target')
    const link = path.join(dir, 'out-link')
    const result = run(script, ['--revision', 'HEAD', '--out', link, '--force'])
    assert.equal(result.status, 1, 'код ' + result.status + ': ' + detail(result))
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'ссылка заменена настоящим каталогом')
    assertMarker(target)
    assertNoLeftovers(dir)
  })
}

// Случаи 6–8 идут через свой временный репозиторий: проверка обязана работать и в
// чистом экспортированном каталоге, где .git нет.
check('6. валидная ревизия + --force: экспорт заменяет marker, exit 0', () => {
  const repo = sandbox('case6')
  commitFixture(repo)
  const dir = path.join(base, 'case6')
  const out = path.join(dir, 'out')
  putMarker(out)
  const result = run(path.join(repo, 'scripts', 'export-public.cjs'), ['--revision', 'HEAD', '--out', out, '--force'])
  assert.equal(result.status, 0, 'код ' + result.status + ': ' + detail(result))
  assert.equal(fs.existsSync(path.join(out, 'marker.txt')), false, 'прежний marker остался в новом экспорте')
  assert.equal(fs.existsSync(path.join(out, 'keep.txt')), true, 'в экспорте нет файла репозитория')
  assert.equal(fs.existsSync(out + '.manifest.json'), true, 'манифест не записан рядом с out')
  assertNoLeftovers(dir)
})

check('7. сбой записи манифеста после подготовки: exit 1, прежний экспорт восстановлен', () => {
  const repo = sandbox('case7')
  commitFixture(repo)
  const dir = path.join(base, 'case7')
  const out = path.join(dir, 'out')
  const blocked = path.join(dir, 'manifest-dir')
  putMarker(out)
  fs.mkdirSync(blocked)
  const result = run(path.join(repo, 'scripts', 'export-public.cjs'), ['--revision', 'HEAD', '--out', out, '--force', '--manifest', blocked])
  assert.equal(result.status, 1, 'код ' + result.status + ': ' + detail(result))
  assertMarker(out)
  assert.equal(fs.lstatSync(blocked).isDirectory(), true, 'каталог манифеста подменён файлом')
  assertNoLeftovers(dir)
})

check('8. --manifest внутри out: режим сохранён, экспорт пишется транзакционно', () => {
  const repo = sandbox('case8')
  commitFixture(repo)
  const dir = path.join(base, 'case8')
  const out = path.join(dir, 'out')
  const manifest = path.join(out, 'manifest.json')
  putMarker(out)
  const result = run(path.join(repo, 'scripts', 'export-public.cjs'), ['--revision', 'HEAD', '--out', out, '--force', '--manifest', manifest])
  assert.equal(result.status, 0, 'код ' + result.status + ': ' + detail(result))
  assert.equal(fs.existsSync(path.join(out, 'keep.txt')), true, 'в экспорте нет файла репозитория')
  assert.equal(fs.existsSync(manifest), true, 'манифест внутри out не записан')
  assert.equal(fs.existsSync(path.join(out, 'marker.txt')), false, 'прежний marker остался')
  assertNoLeftovers(dir)
})

function fixtureGit (repo, ...args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-C', repo, ...args], { encoding: 'utf8' }).trim()
}
function commitFixture(repo) {
  fixtureGit(repo, 'init', '-q')
  fixtureGit(repo, 'add', '.')
  fixtureGit(repo, '-c', 'user.name=Test', '-c', 'user.email=test@onlyone.local', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
}
check('9. nested private files are excluded, including mixed-case directories', () => {
  const repo = sandbox('nested-private')
  for (const name of ['nested/_private/notes.md', 'nested/NODE_MODULES/module.js', 'nested/.ENV.local', 'profile/1code-settings.json', 'resources/mark-source.png', 'resources/1code-icon_original.png']) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.writeFileSync(path.join(repo, name), 'synthetic private fixture')
  }
  commitFixture(repo)
  const out = path.join(base, 'nested-private', 'out')
  const result = run(path.join(repo, 'scripts/export-public.cjs'), ['--out', out])
  assert.equal(result.status, 0, detail(result))
  for (const name of ['nested/_private/notes.md', 'nested/NODE_MODULES/module.js', 'nested/.ENV.local', 'profile/1code-settings.json', 'resources/mark-source.png', 'resources/1code-icon_original.png']) assert.equal(fs.existsSync(path.join(out, name)), false, name)
})
check('10. Unicode Git paths retain their actual filename', () => {
  const repo = sandbox('unicode'), name = 'заметки о проекте.txt'
  fs.writeFileSync(path.join(repo, name), 'unicode contents')
  commitFixture(repo)
  const out = path.join(base, 'unicode', 'out')
  const result = run(path.join(repo, 'scripts/export-public.cjs'), ['--out', out])
  assert.equal(result.status, 0, detail(result))
  assert.equal(fs.readFileSync(path.join(out, name), 'utf8'), 'unicode contents')
})
check('11. manifest cannot replace a source repository file', () => {
  const repo = sandbox('manifest-source')
  commitFixture(repo)
  const out = path.join(base, 'manifest-source', 'out')
  const result = run(path.join(repo, 'scripts/export-public.cjs'), ['--out', out, '--manifest', path.join(repo, 'keep.txt')])
  assert.equal(result.status, 1, detail(result))
  assert.equal(fs.readFileSync(path.join(repo, 'keep.txt'), 'utf8'), 'репозиторий\n')
  assert.equal(fs.existsSync(out), false)
})
check('12. Git symlink mode is refused before replacing an existing export', () => {
  const repo = sandbox('git-link')
  commitFixture(repo)
  const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: '../outside', encoding: 'utf8' }).trim()
  fixtureGit(repo, 'update-index', '--add', '--cacheinfo', '120000,' + blob + ',shortcut')
  fixtureGit(repo, '-c', 'user.name=Test', '-c', 'user.email=test@onlyone.local', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'link fixture')
  const out = path.join(base, 'git-link', 'out')
  putMarker(out)
  const result = run(path.join(repo, 'scripts/export-public.cjs'), ['--out', out, '--force'])
  assert.equal(result.status, 1, detail(result))
  assertMarker(out)
})
check('13. verification refuses an export root replaced by a junction', () => {
  const repo = sandbox('verify-link')
  commitFixture(repo)
  const out = path.join(base, 'verify-link', 'out'), real = out + '-real'
  const entry = path.join(repo, 'scripts/export-public.cjs')
  assert.equal(run(entry, ['--out', out]).status, 0)
  fs.renameSync(out, real)
  fs.symlinkSync(real, out, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(run(entry, ['--verify', out, '--manifest', out + '.manifest.json']).status, 1)
})
check('14. a worktree exporter cannot replace the shared Git directory', () => {
  const repo=sandbox('common-git');commitFixture(repo)
  const worktree=path.join(base,'common-git','worktree'),metadata=path.join(repo,'.git')
  fixtureGit(repo,'worktree','add','-q','--detach',worktree,'HEAD')
  const result=run(path.join(worktree,'scripts/export-public.cjs'),['--out',metadata,'--force'])
  assert.equal(result.status,1,detail(result))
  assert.ok(fs.existsSync(path.join(metadata,'HEAD')))
  assert.equal(fixtureGit(repo,'rev-parse','--is-inside-work-tree'),'true')
})

// Вымышленный ключ: значение нигде не должно появиться в экспорте, а подложенный
// в готовую копию файл обязана поймать проверка целостности.
const SYNTHETIC_KEY = ['sk', 'live', 'SYNTHETIC', '0123456789'].join('-')
const PRIVATE_FILES = {
  '.env': 'ONLYONE_KEY=' + SYNTHETIC_KEY + '\n',
  'profile/1code-settings.json': JSON.stringify({ apiKey: SYNTHETIC_KEY }),
  'profile/Local State': JSON.stringify({ os_crypt: { encrypted_key: SYNTHETIC_KEY } }),
  'audits/2026-10-28/private-report.md': SYNTHETIC_KEY + '\n',
  'logs/app.log': SYNTHETIC_KEY + '\n',
  'nested/worktrees/agent/notes.md': SYNTHETIC_KEY + '\n',
  'dist/app.asar': SYNTHETIC_KEY,
  'keys/service.key': SYNTHETIC_KEY,
  'mobile/android/app/build/outputs/report.txt': SYNTHETIC_KEY
}
check('15. synthetic secrets excluded, verify catches an injected file', () => {
  const repo = sandbox('synthetic-secrets')
  for (const [name, text] of Object.entries(PRIVATE_FILES)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.writeFileSync(path.join(repo, name), text)
  }
  commitFixture(repo)
  const entry = path.join(repo, 'scripts', 'export-public.cjs'), out = path.join(base, 'synthetic-secrets', 'out')
  const manifestPath = out + '.manifest.json'
  const result = run(entry, ['--out', out])
  assert.equal(result.status, 0, detail(result))
  for (const name of Object.keys(PRIVATE_FILES)) {
    assert.equal(fs.existsSync(path.join(out, name)), false, 'приватный файл попал в экспорт: ' + name)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const excluded = new Set(manifest.excluded.map(item => item.path))
  for (const name of Object.keys(PRIVATE_FILES)) assert.ok(excluded.has(name), 'нет в исключениях: ' + name)
  assert.equal(run(entry, ['--verify', out, '--manifest', manifestPath]).status, 0, 'чистая копия не прошла проверку')
  const injected = path.join(out, 'profile', 'Local State')
  fs.mkdirSync(path.dirname(injected), { recursive: true })
  fs.writeFileSync(injected, JSON.stringify({ os_crypt: { encrypted_key: SYNTHETIC_KEY } }))
  fs.writeFileSync(path.join(out, 'rogue.txt'), SYNTHETIC_KEY)
  const refusal = run(entry, ['--verify', out, '--manifest', manifestPath])
  assert.equal(refusal.status, 1, 'подложенный файл не поймали')
  assert.ok(/лишний файл/.test(refusal.stderr), 'нет причины «лишний файл»: ' + detail(refusal))
  assert.ok(refusal.stderr.includes('Local State'), 'исключённый профиль не назван: ' + detail(refusal))
})

check('16. manifest binds files to the revision and refuses doctored blob ids', () => {
  const repo = sandbox('revision-binding')
  commitFixture(repo)
  const entry = path.join(repo, 'scripts', 'export-public.cjs'), out = path.join(base, 'revision-binding', 'out')
  const manifestPath = out + '.manifest.json'
  assert.equal(run(entry, ['--out', out]).status, 0)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.revision, fixtureGit(repo, 'rev-parse', 'HEAD'))
  assert.equal(manifest.tree, fixtureGit(repo, 'rev-parse', 'HEAD^{tree}'))
  assert.ok(manifest.files.length > 0)
  for (const file of manifest.files) {
    assert.match(String(file.gitBlob), /^[0-9a-f]{40}$/, 'нет git blob: ' + file.path)
    assert.match(String(file.gitMode), /^100(?:644|755)$/, 'нет git mode: ' + file.path)
  }
  assert.equal(run(entry, ['--verify', out, '--manifest', manifestPath]).status, 0)
  const doctored = path.join(base, 'revision-binding', 'doctored.json')
  manifest.files[0].gitBlob = '0'.repeat(40)
  fs.writeFileSync(doctored, JSON.stringify(manifest, null, 2) + '\n')
  const refusal = run(entry, ['--verify', out, '--manifest', doctored])
  assert.equal(refusal.status, 1, 'подменённый blob id принят')
  assert.ok(/git blob/.test(refusal.stderr), 'нет причины «git blob»: ' + detail(refusal))
})

fs.rmSync(base, { recursive: true, force: true })
console.log(JSON.stringify({ ok: failed === 0, failed, skipped }))
process.exit(failed ? 1 : 0)
