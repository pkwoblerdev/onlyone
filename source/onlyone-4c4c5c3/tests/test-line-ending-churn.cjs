// test-line-ending-churn.cjs — находка Н91: правка окончаний строк должна быть
// видна как правка, а не прятаться в шуме диффа.
//
// Кириллица в этом проекте живёт в UTF-8, а файлы хранятся смешанно: где-то
// CRLF, где-то отдельные LF-строки (`app.js` — 13 LF на 11 831 CRLF). Инструмент,
// который «вежливо» выравнивает окончания, оставляет дифф вида 1883/1901 там,
// где человек изменил 18 строк, — и в этом шуме теряется настоящая правка.
//
// Метр один и он же арбитр: `git diff --numstat` против
// `git diff --numstat --ignore-cr-at-eol`. Разница между числами — строки,
// изменённые ТОЛЬКО окончанием. Их не должно быть ни в коммитах ветки, ни в
// незакоммиченном состоянии.
//
// Проверка обязана краснеть на исчезновении поведения, поэтому сначала она
// меряет себя на подставном репозитории: файл переписан только по окончаниям →
// шум обязан найтись; файл изменён по содержимому → шума быть не должно.

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { RAW, resolveBaseline, isVerified, describeBaseline, failureText } = require('./eol-baseline.cjs')

const repo = path.join(__dirname, '..')

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

// numstat → карта файл: {added, removed}. Бинарные звенья (`-`) не считаются.
// Измерение всегда по сырым байтам: в проекте стоит `* -text`, а в подставном
// репозитории иначе говорил бы авто-CRLF машины, а не правка.
function numstat (cwd, args) {
  const out = git(cwd, ...RAW, 'diff', '--numstat', ...args)
  const rows = new Map()
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [added, removed, ...rest] = line.split('\t')
    const file = rest.join('\t')
    if (added === '-' || removed === '-') continue
    rows.set(file, { added: Number(added), removed: Number(removed) })
  }
  return rows
}

// Строки, изменённые одним окончанием: то, что пропало при `--ignore-cr-at-eol`.
function churn (cwd, diffArgs) {
  const plain = numstat(cwd, diffArgs)
  const noCr = numstat(cwd, ['--ignore-cr-at-eol', ...diffArgs])
  const found = []
  for (const [file, one] of plain) {
    const other = noCr.get(file) || { added: 0, removed: 0 }
    const added = one.added - other.added
    const removed = one.removed - other.removed
    if (added > 0 || removed > 0) found.push({ file, added, removed })
  }
  return found
}

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

// --- прибор: подставной репозиторий, где заведомо есть и нет шума ------------

function scratchRepo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-eol-guard-'))
  git(dir, 'init', '-q', '--initial-branch=main')
  return dir
}

// В подставном репозитории окончания должны доходить до индекса байт в байт:
// на машине с `core.autocrlf=true` git иначе сам переписал бы LF в CRLF, и
// второго коммита вовсе не стало бы. Те же локальные (-c) значения — в RAW
// из eol-baseline.cjs, глобальный конфиг не трогаем.
function fixtureGit (dir, ...args) {
  return git(dir, ...RAW, ...args)
}

function commitAll (dir, message) {
  fixtureGit(dir, '-c', 'user.name=Тест', '-c', 'user.email=test@onlyone.local',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message)
}

function fixture () {
  const dir = scratchRepo()
  const file = path.join(dir, 'ru.txt')
  fs.writeFileSync(file, 'первая строка\r\nвторая строка\r\n')
  fixtureGit(dir, 'add', 'ru.txt')
  commitAll(dir, 'база: файл с CRLF')
  const base = git(dir, 'rev-parse', 'HEAD').trim()

  // Тот же текст, другие окончания: содержимое не менялось вовсе.
  fs.writeFileSync(file, 'первая строка\nвторая строка\n')
  fixtureGit(dir, 'add', 'ru.txt')
  commitAll(dir, 'шум: только окончания')
  const onlyEol = churn(dir, [base, 'HEAD'])

  // Настоящая правка: добавлена строка. Меряется ПОСЛЕДНИМ коммитом, а не
  // накопленным диффом от базы: шум первых двух строк из предыдущего коммита
  // никуда не делся, и проверка «содержимое — не шум» на накопленном диффе
  // меряла бы совсем другое.
  fs.writeFileSync(file, 'первая строка\nвторая строка\nтретья строка\n')
  fixtureGit(dir, 'add', 'ru.txt')
  commitAll(dir, 'правка по содержимому')
  const realEdit = churn(dir, ['HEAD~1', 'HEAD'])
  return { dir, onlyEol, realEdit }
}

const probe = fixture()
check('прибор видит правку одним окончанием как шум',
  probe.onlyEol.length === 1 && probe.onlyEol[0].added === 2 && probe.onlyEol[0].removed === 2,
  JSON.stringify(probe.onlyEol))
check('прибор не считает шумом правку по содержимому',
  probe.realEdit.length === 0, JSON.stringify(probe.realEdit))
try { fs.rmSync(probe.dir, { recursive: true, force: true }) } catch { /* Temp чистит система */ }

// --- само дерево: коммиты ветки и незакоммиченное состояние ------------------

// База — та же, что у test-crlf-hygiene (общий resolver eol-baseline.cjs):
// release/*-build, ONECODE_EOL_BASE, tests/eol-base.json, иначе корневой
// коммит. Недействительная или отсутствующая база — провал, а не pass.
const base = resolveBaseline(repo)
const short = list => list.map(item => `${item.file} +${item.added}/-${item.removed}`).join(' | ')

if (base.mode === 'archive') {
  console.error('archive: history not verified — .git нет: ни коммиты, ни рабочая копия не проверены')
} else if (base.mode === 'no-base' || base.mode === 'invalid') {
  check('есть действительная база для проверки окончаний', false, failureText(base))
} else {
  const from = describeBaseline(base)
  const committed = churn(repo, [base.base, 'HEAD'])
  check(`в коммитах от ${from} нет строк, изменённых только окончанием`,
    committed.length === 0, short(committed))

  const dirty = churn(repo, [])
  check('в рабочей копии (unstaged) нет строк, изменённых только окончанием',
    dirty.length === 0, short(dirty))

  const staged = churn(repo, ['--cached'])
  check('в подготовленных к коммиту изменениях нет строк, изменённых только окончанием',
    staged.length === 0, short(staged))
}

console.log(JSON.stringify({ ok: failed === 0, verified: isVerified(base), base, checks: ran, failed, problems }))
process.exitCode = failed ? 1 : 0
