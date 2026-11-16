// Регрессия Н91 для публичного репозитория: проверки окончаний строк должны
// иметь явную базу и там, где нет приватных веток `release/*-build`, и не
// выдавать отсутствие истории за pass.
//
// Проверки гоняются как есть — копией в подставной репозиторий. Так регрессия
// ловит именно поведение test-line-ending-churn.cjs и test-crlf-hygiene.cjs,
// а не свою копию их алгоритма. Подставные репозитории самодостаточны: база
// задаётся либо файлом внутри них, либо переменной ONECODE_EOL_BASE; файл из
// рабочего дерева сюда не попадает.
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { RAW, resolveBaseline } = require('./eol-baseline.cjs')

const repoRoot = path.resolve(__dirname, '..')

let failed = 0
let ran = 0
const problems = []
const check = (name, ok, detail) => {
  ran++
  if (!ok) {
    failed++
    problems.push(detail ? `${name}: ${detail}` : name)
    console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`)
  } else {
    console.log(`  ok  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', [...RAW, ...args], { cwd, encoding: 'utf8' }).trim()
const commit = (cwd, message) => git(cwd, '-c', 'user.name=Тест', '-c', 'user.email=test@onlyone.local',
  '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message)

// Копия проверок в подставное дерево: cwd каждого теста — его `tests/..`.
function tempRepo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-eol-public-'))
  git(dir, 'init', '-q', '--initial-branch=main')
  fs.mkdirSync(path.join(dir, 'tests'))
  for (const name of ['test-line-ending-churn.cjs', 'test-crlf-hygiene.cjs', 'eol-baseline.cjs']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(dir, 'tests', name))
  }
  return dir
}

const file = dir => path.join(dir, 'ru.txt')
const baseFile = dir => path.join(dir, 'tests', 'eol-base.json')

function baseCommit (dir) {
  fs.writeFileSync(file(dir), 'первая строка\r\nвторая строка\r\n')
  git(dir, 'add', 'ru.txt')
  commit(dir, 'база: CRLF')
}

function contentCommit (dir) {
  fs.appendFileSync(file(dir), 'третья строка\r\n')
  git(dir, 'add', 'ru.txt')
  commit(dir, 'правка по содержимому')
}

// Тот же текст, другие окончания: содержимое не меняется.
function eolRewrite (dir) {
  fs.writeFileSync(file(dir), fs.readFileSync(file(dir), 'utf8').replace(/\r\n/g, '\n'))
}

// Шум, случившийся ДО публичной базы: старый файл переписан только по
// окончаниям. Именно такой шум в истории и заставляет вводить явную базу.
function preBaseNoise (dir) {
  const legacy = path.join(dir, 'legacy.txt')
  fs.writeFileSync(legacy, 'старая строка\nвторая старая строка\n')
  git(dir, 'add', 'legacy.txt')
  commit(dir, 'старая история: LF')
  fs.writeFileSync(legacy, 'старая строка\r\nвторая старая строка\r\n')
  git(dir, 'add', 'legacy.txt')
  commit(dir, 'старая история: шум окончаний до публичной базы')
  return git(dir, 'rev-parse', 'HEAD')
}

// Публичная база файлом — внутри подставного репозитория, а не из рабочего дерева.
function writeBaseFile (dir, sha, message = 'проверка: публичная база') {
  fs.writeFileSync(baseFile(dir), JSON.stringify({
    base: sha,
    reason: 'публичная база окончаний; более ранняя история не входит в проверяемый диапазон'
  }, null, 2) + '\n')
  git(dir, 'add', 'tests/eol-base.json')
  commit(dir, message)
}

// env по умолчанию гасит ONECODE_EOL_BASE машины: иначе ambient-переменная
// подменила бы базу во всех случаях, кроме тех, где она задана явно.
function run (dir, name, env = {}) {
  const result = spawnSync(process.execPath, [path.join('tests', name)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ONECODE_EOL_BASE: '', ...env }
  })
  let json = null
  try { json = JSON.parse(result.stdout.trim().split('\n').pop()) } catch { /* тест упал до итога */ }
  return { code: result.status, out: result.stdout, err: result.stderr, json }
}

function withRepo (fn) {
  const dir = tempRepo()
  try { fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

const detailOf = run => JSON.stringify({ code: run.code, json: run.json, err: run.err.trim() })

// 1. Коммит от базы публичной истории (корневой коммит) — обнаружен.
withRepo(dir => {
  baseCommit(dir)
  contentCommit(dir)
  eolRewrite(dir)
  git(dir, 'add', 'ru.txt')
  commit(dir, 'шум: только окончания')

  const churn = run(dir, 'test-line-ending-churn.cjs')
  check('коммит от корня: churn обнаружен и база явная',
    churn.code === 1 && churn.json?.verified === true && churn.json?.base?.mode === 'root' &&
    /корневого коммита/.test(churn.json.problems.join(' ')), detailOf(churn))

  const hygiene = run(dir, 'test-crlf-hygiene.cjs')
  check('коммит от корня: гигиена тоже обнаруживает',
    hygiene.code === 1 && hygiene.json?.verified === true &&
    /корневого коммита/.test(hygiene.json.problems.join(' ')), detailOf(hygiene))
})

// 2. Рабочая копия (unstaged) — обнаружена.
withRepo(dir => {
  baseCommit(dir)
  contentCommit(dir)
  eolRewrite(dir)

  const churn = run(dir, 'test-line-ending-churn.cjs')
  check('рабочая копия: churn обнаружен',
    churn.code === 1 && /рабочей копии/.test(churn.json.problems.join(' ')), detailOf(churn))
})

// 3. Staged — обнаружен (раньше `git diff` без --cached его не видел вовсе).
withRepo(dir => {
  baseCommit(dir)
  contentCommit(dir)
  eolRewrite(dir)
  git(dir, 'add', 'ru.txt')

  const churn = run(dir, 'test-line-ending-churn.cjs')
  check('staged: churn обнаружен',
    churn.code === 1 && /подготовленных к коммиту/.test(churn.json.problems.join(' ')), detailOf(churn))
})

// 4. Один коммит: истории нет — явный провал, а не pass.
withRepo(dir => {
  baseCommit(dir)

  const churn = run(dir, 'test-line-ending-churn.cjs')
  check('один коммит: churn — «нет базы», exit 1',
    churn.code === 1 && churn.json?.verified === false && churn.json?.base?.mode === 'no-base' &&
    /нет базы для проверки/.test(churn.json.problems.join(' ')), detailOf(churn))

  const hygiene = run(dir, 'test-crlf-hygiene.cjs')
  check('один коммит: гигиена — «нет базы», exit 1',
    hygiene.code === 1 && hygiene.json?.verified === false &&
    /нет базы для проверки/.test(hygiene.json.problems.join(' ')), detailOf(hygiene))
})

// 5. Архив без .git: exit 0 только как verified:false с предупреждением.
withRepo(dir => {
  baseCommit(dir)
  contentCommit(dir)
  eolRewrite(dir) // даже с шумом на диске проверить нечем
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true })

  const churn = run(dir, 'test-line-ending-churn.cjs')
  check('архив: churn — verified:false и предупреждение, не «ok checked»',
    churn.code === 0 && churn.json?.verified === false && churn.json?.base?.mode === 'archive' &&
    /archive: history not verified/.test(churn.err), detailOf(churn))

  const hygiene = run(dir, 'test-crlf-hygiene.cjs')
  check('архив: гигиена — verified:false и предупреждение',
    hygiene.code === 0 && hygiene.json?.verified === false &&
    /archive: history not verified/.test(hygiene.err), detailOf(hygiene))
})

// 6. Строгий путь: локальная release/*-build важнее и env, и публичного файла.
withRepo(dir => {
  baseCommit(dir)
  const base = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'branch', 'release/1.0-build', base)
  eolRewrite(dir)
  git(dir, 'add', 'ru.txt')
  commit(dir, 'шум: только окончания')

  const churn = run(dir, 'test-line-ending-churn.cjs')
  check('release-ветка: база — release/1.0-build, churn обнаружен',
    churn.code === 1 && churn.json?.base?.mode === 'release' &&
    churn.json?.base?.ref === 'release/1.0-build' && /release\/1\.0-build/.test(churn.json.problems.join(' ')),
    detailOf(churn))
})

// 7. Корневая база недостаточна: шум ДО явной базы она видит и краснеет.
withRepo(dir => {
  preBaseNoise(dir)
  baseCommit(dir)
  eolRewrite(dir)
  git(dir, 'add', 'ru.txt')
  commit(dir, 'шум: только окончания после старой истории')

  const churn = run(dir, 'test-line-ending-churn.cjs')
  check('корневая база: исторический шум до базы краснеет (root)',
    churn.code === 1 && churn.json?.base?.mode === 'root' &&
    /legacy\.txt/.test(churn.json.problems.join(' ')), detailOf(churn))
})

// 8. Публичный файл: шум до базы игнорируется, EOL-правка после базы видна.
withRepo(dir => {
  preBaseNoise(dir)
  baseCommit(dir)
  const base = git(dir, 'rev-parse', 'HEAD')
  writeBaseFile(dir, base)

  const clean = run(dir, 'test-line-ending-churn.cjs')
  check('публичный файл: шум до базы не считается, база — public',
    clean.code === 0 && clean.json?.verified === true && clean.json?.base?.mode === 'public' &&
    clean.json?.base?.base === base, detailOf(clean))

  eolRewrite(dir)
  git(dir, 'add', 'ru.txt')
  commit(dir, 'шум: только окончания после базы')

  const churn = run(dir, 'test-line-ending-churn.cjs')
  check('публичный файл: EOL-правка после базы обнаружена',
    churn.code === 1 && churn.json?.base?.mode === 'public' &&
    /публичной базы/.test(churn.json.problems.join(' ')), detailOf(churn))

  const hygiene = run(dir, 'test-crlf-hygiene.cjs')
  check('публичный файл: гигиена видит ту же базу',
    hygiene.code === 1 && hygiene.json?.base?.mode === 'public' &&
    /публичной базы/.test(hygiene.json.problems.join(' ')), detailOf(hygiene))
})

// 9. То же через env: подставной репозиторий не зависит от файла в дереве.
withRepo(dir => {
  preBaseNoise(dir)
  baseCommit(dir)
  const base = git(dir, 'rev-parse', 'HEAD')
  contentCommit(dir) // содержательная правка после базы: проверять есть что

  const clean = run(dir, 'test-line-ending-churn.cjs', { ONECODE_EOL_BASE: base })
  check('env-база: шум до базы не считается, база — env',
    clean.code === 0 && clean.json?.verified === true && clean.json?.base?.mode === 'env' &&
    clean.json?.base?.base === base, detailOf(clean))

  eolRewrite(dir)
  git(dir, 'add', 'ru.txt')
  commit(dir, 'шум: только окончания после базы')

  const churn = run(dir, 'test-line-ending-churn.cjs', { ONECODE_EOL_BASE: base })
  check('env-база: EOL-правка после базы обнаружена',
    churn.code === 1 && churn.json?.base?.mode === 'env' &&
    /ONECODE_EOL_BASE/.test(churn.json.problems.join(' ')), detailOf(churn))
})

// 10. Несуществующий SHA в env — явный отказ, не pass.
withRepo(dir => {
  baseCommit(dir)
  contentCommit(dir)

  const churn = run(dir, 'test-line-ending-churn.cjs',
    { ONECODE_EOL_BASE: '0123456789abcdef0123456789abcdef01234567' })
  check('неверный SHA в env: отказ (invalid, exit 1)',
    churn.code === 1 && churn.json?.verified === false && churn.json?.base?.mode === 'invalid' &&
    /ONECODE_EOL_BASE/.test(churn.json.problems.join(' ')), detailOf(churn))

  const hygiene = run(dir, 'test-crlf-hygiene.cjs',
    { ONECODE_EOL_BASE: '0123456789abcdef0123456789abcdef01234567' })
  check('неверный SHA в env: гигиена тоже отказывает',
    hygiene.code === 1 && hygiene.json?.verified === false && hygiene.json?.base?.mode === 'invalid',
    detailOf(hygiene))
})

// 11. Неверный SHA в публичном файле — отказ.
withRepo(dir => {
  baseCommit(dir)
  contentCommit(dir)
  writeBaseFile(dir, '0123456789abcdef0123456789abcdef01234567')

  const churn = run(dir, 'test-line-ending-churn.cjs')
  check('неверный SHA в файле: отказ (invalid, exit 1)',
    churn.code === 1 && churn.json?.verified === false && churn.json?.base?.mode === 'invalid' &&
    churn.json?.base?.source === 'file' &&
    /tests\/eol-base\.json/.test(churn.json.problems.join(' ')), detailOf(churn))
})

// 12. Коммит не из истории HEAD (чужая ветка) — отказ.
withRepo(dir => {
  baseCommit(dir)
  git(dir, 'checkout', '-q', '-b', 'side')
  contentCommit(dir)
  const side = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'checkout', '-q', 'main')

  const churn = run(dir, 'test-line-ending-churn.cjs', { ONECODE_EOL_BASE: side })
  check('коммит не предок HEAD: отказ (invalid, exit 1)',
    churn.code === 1 && churn.json?.base?.mode === 'invalid' &&
    /не предк|не является предком/.test(churn.json.problems.join(' ')), detailOf(churn))
})

withRepo(dir => {
  baseCommit(dir)
  writeBaseFile(dir, 'public-root')
  const clean = run(dir, 'test-line-ending-churn.cjs')
  check('portable public-root: no private commits required', clean.code === 0 && clean.json?.base?.mode === 'public', detailOf(clean))
  eolRewrite(dir)
  const dirty = run(dir, 'test-line-ending-churn.cjs')
  check('portable public-root: working EOL changes detected', dirty.code === 1 && dirty.json?.verified === true, detailOf(dirty))
  git(dir, 'add', 'ru.txt')
  commit(dir, 'EOL regression')
  const committed = run(dir, 'test-crlf-hygiene.cjs')
  check('portable public-root: committed EOL changes detected', committed.code === 1 && committed.json?.verified === true, detailOf(committed))
})

// 13. Реальное дерево: база явная; строгий путь, если release-ветки есть.
const real = resolveBaseline(repoRoot)
check('реальное дерево: база явная (release/*-build, env, публичный файл или корень)',
  ['release', 'env', 'public', 'root'].includes(real.mode), JSON.stringify(real))
if (real.mode === 'release') {
  check('реальное дерево: выбран строгий путь release/*-build', /-build$/.test(real.ref), real.ref)
} else if (real.mode === 'public') {
  check('реальное дерево: публичная база из tests/eol-base.json — коммит из истории HEAD',
    /^[0-9a-f]{40}$/.test(real.base), real.base)
} else {
  console.log(`  --  release/*-build нет: база — ${real.mode}`)
}

console.log(JSON.stringify({ ok: failed === 0, checks: ran, failed, problems }))
process.exitCode = failed ? 1 : 0
