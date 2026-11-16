// Общая база сравнения для проверок окончаний строк (Н91).
//
// История проекта содержит участки, где окончания строк переписывались
// массово (до публикации исходников). Проверка «корневой коммит..HEAD» видит
// этот шум и краснеет на нём, хотя рабочая ветка чиста, — поэтому база
// задаётся явно, а не угадывается:
//
//   1. `release/*-build` — строгий путь рабочего репозитория (как раньше):
//      свежайшая локальная ветка, база — merge-base с HEAD. Проверяется
//      первым, чтобы рабочий репозиторий нельзя было ослабить переменной
//      окружения или файлом;
//   2. `ONECODE_EOL_BASE` — явная переменная для тестов и чужих репозиториев;
//   3. `tests/eol-base.json` — публичная база: файл едет вместе с
//      репозиторием и не зависит от приватных release-веток;
//   4. корневой коммит — обратная совместимость: истории нет, но она есть.
//
// Env и файл не «подставляют» базу молча: несуществующий коммит, коммит не из
// истории HEAD или база, равная HEAD, — явный отказ (mode: invalid), а не pass.
// Отсутствие файла не превращается в безусловный pass: без release-веток, env
// и файла остаётся корневая база с явным mode: root.
//
// Состояния:
//   release / env / public / root — история проверена (verified: true);
//   invalid — база объявлена, но недействительна: провал, а не pass;
//   no-base — .git есть, но проверять не с чем (один коммит): провал;
//   archive — .git нет (архив/экспорт): verified: false и предупреждение.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const RAW = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false']
const git = (cwd, ...args) => execFileSync('git', [...RAW, ...args], { cwd, encoding: 'utf8' }).trim()

const BASE_FILE = 'tests/eol-base.json' // в выводе и отчётах — всегда прямой слэш

const REASONS = {
  'bad-sha': 'ожидается SHA-1 коммита (7–40 hex-символов)',
  'missing-commit': 'коммита нет в этом клоне',
  'not-ancestor': 'коммит не является предком HEAD',
  'base-is-head': 'база совпадает с HEAD — проверять нечего',
  'bad-json': 'файл не читается как JSON с непустым полем base',
  'no-head': 'HEAD не указывает на коммит'
}

// Проверка объявленной базы: коммит существует, он предок HEAD и не равен ему.
function checkCommit (cwd, sha) {
  const value = String(sha || '').trim()
  if (!/^[0-9a-f]{7,40}$/i.test(value)) return { ok: false, reason: 'bad-sha' }
  try { git(cwd, 'cat-file', '-e', `${value}^{commit}`) } catch { return { ok: false, reason: 'missing-commit' } }

  let full = ''
  let head = ''
  try {
    full = git(cwd, 'rev-parse', `${value}^{commit}`)
    head = git(cwd, 'rev-parse', 'HEAD')
  } catch { return { ok: false, reason: 'no-head' } }

  try { git(cwd, 'merge-base', '--is-ancestor', full, 'HEAD') } catch { return { ok: false, reason: 'not-ancestor' } }
  if (full === head) return { ok: false, reason: 'base-is-head' }
  return { ok: true, base: full }
}

function fromCommit (cwd, mode, source, ref, sha, note) {
  const checked = checkCommit(cwd, sha)
  if (!checked.ok) {
    return { mode: 'invalid', source, ref, base: String(sha || '').trim(), reason: checked.reason }
  }
  return { mode, source, ref, base: checked.base, note }
}

function resolveBaseline (cwd, env = process.env) {
  if (!fs.existsSync(path.join(cwd, '.git'))) return { mode: 'archive' }

  // 1. Строгий путь рабочего репозитория — до env и файла.
  let refs = []
  try {
    refs = git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/release/')
      .split('\n').map(line => line.trim()).filter(line => line.endsWith('-build')).sort().reverse()
  } catch { /* git есть, но молчит — решит rev-list ниже */ }

  for (const ref of refs) {
    try {
      const base = git(cwd, 'merge-base', 'HEAD', ref)
      if (base) return { mode: 'release', ref, base }
    } catch { /* эта ветка не из нашей истории */ }
  }

  // 2. Явная переменная: тесты и чужие репозитории.
  const envBase = String((env && env.ONECODE_EOL_BASE) || '').trim()
  if (envBase) return fromCommit(cwd, 'env', 'env', 'ONECODE_EOL_BASE', envBase)

  // 3. Публичная база: файл едет вместе с репозиторием.
  const file = path.join(cwd, 'tests', 'eol-base.json')
  if (fs.existsSync(file)) {
    let data = null
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* ниже — bad-json */ }
    if (!data || typeof data.base !== 'string' || !data.base.trim()) {
      return { mode: 'invalid', source: 'file', ref: BASE_FILE, base: '', reason: 'bad-json' }
    }
    let declared = data.base
    if (declared === 'public-root') {
      try { declared = git(cwd, 'rev-list', '--max-parents=0', 'HEAD').split('\n')[0] } catch { declared = '' }
    }
    return fromCommit(cwd, 'public', 'file', BASE_FILE, declared, data.reason)
  }

  // 4. Обратная совместимость: корневой коммит публичной истории.
  let base = ''
  try { base = git(cwd, 'rev-list', '--max-parents=0', 'HEAD').split('\n')[0] } catch { /* пустой репозиторий */ }
  if (!base) return { mode: 'no-base', reason: 'no-head' }

  const head = git(cwd, 'rev-parse', 'HEAD')
  if (head === base) return { mode: 'no-base', reason: 'single-commit', base }
  return { mode: 'root', base }
}

const isVerified = baseline => ['release', 'env', 'public', 'root'].includes(baseline.mode)

function describeBaseline (baseline) {
  switch (baseline.mode) {
    case 'release': return String(baseline.ref)
    case 'env': return `ONECODE_EOL_BASE (${String(baseline.base).slice(0, 7)})`
    case 'public': return `публичной базы tests/eol-base.json (${String(baseline.base).slice(0, 7)})`
    case 'root': return 'корневого коммита (публичная история)'
    default: return baseline.mode
  }
}

// Единая формулировка провала для обеих проверок.
function failureText (baseline) {
  if (baseline.mode === 'no-base') {
    if (baseline.reason === 'no-head') return 'нет базы для проверки: HEAD не указывает на коммит'
    return `нет базы для проверки: HEAD — корневой коммит (${String(baseline.base || '—').slice(0, 7)}), истории для сравнения нет`
  }
  const what = baseline.source === 'env' ? 'ONECODE_EOL_BASE' : (baseline.ref || 'база')
  return `база окончаний недействительна: ${what} → ${String(baseline.base || '—').slice(0, 7)}: ` +
    `${REASONS[baseline.reason] || baseline.reason}`
}

module.exports = { RAW, BASE_FILE, REASONS, git, resolveBaseline, isVerified, describeBaseline, failureText }
