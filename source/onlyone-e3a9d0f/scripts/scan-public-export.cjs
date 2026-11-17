#!/usr/bin/env node
// Скан текстовых файлов публичного экспорта: секреты, локальные пути, почта, следы авторства
// моделей и внутренние заметки. Это грубая сеть с подсчётом, не замена ручному аудиту.
//   node scripts/scan-public-export.cjs --dir <export-dir> [--json]
// Совпадения печатаются замаскированными: значения секретов и имена в путях не раскрываются.
// Код выхода 1 — есть находка уровня block; 0 — только review или ничего.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const LIMIT = 2 * 1024 * 1024

// severity block — публикация останавливается; review — человек смотрит сам (примеры, фикстуры).
const RULES = [
  // Секреты.
  { id: 'private-key', label: 'блок приватного ключа', severity: 'block', mask: 'secret',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  { id: 'openai-key', label: 'ключ OpenAI/Anthropic/OpenRouter вида sk-', severity: 'block', mask: 'secret',
    re: /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{16,}\b/ },
  { id: 'aws-key', label: 'ключ доступа AWS', severity: 'block', mask: 'secret', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', label: 'токен GitHub', severity: 'block', mask: 'secret',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { id: 'google-key', label: 'ключ Google API', severity: 'block', mask: 'secret', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack-token', label: 'токен Slack', severity: 'block', mask: 'secret', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'stripe-key', label: 'ключ Stripe', severity: 'block', mask: 'secret', re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { id: 'npm-token', label: 'токен npm', severity: 'block', mask: 'secret', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'telegram-token', label: 'токен Telegram-бота', severity: 'block', mask: 'secret', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { id: 'jwt', label: 'JWT', severity: 'block', mask: 'secret',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'bearer', label: 'литеральный Bearer-токен', severity: 'block', mask: 'secret',
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  // Присваивание секрета литералом; значения-заглушки отсеиваются ниже.
  { id: 'secret-literal', label: 'секрет литералом в присваивании', severity: 'block', mask: 'secret',
    re: /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*['"]([^'"\s]{16,})['"]/i },
  // Локальные пути и почта.
  { id: 'win-user-path', label: 'путь Windows с именем пользователя', severity: 'review', mask: 'path',
    re: /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|]+/i },
  { id: 'drive-path', label: 'абсолютный путь с буквой диска', severity: 'review', mask: 'path',
    re: /\b[A-Za-z]:[\\/]+[A-Za-z0-9_.-][^\s"'<>|]*/ },
  { id: 'unix-home', label: 'домашний путь Unix', severity: 'review', mask: 'path',
    re: /\/(?:Users|home)\/[A-Za-z0-9._-]+/ },
  { id: 'email', label: 'адрес почты', severity: 'review', mask: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  // Следы авторства моделей — те же формулы, что в verify-public-readiness.cjs.
  { id: 'attribution', label: 'формула авторства модели', severity: 'block', mask: 'none',
    re: /\bco-authored-by\s*:|\b(?:generated|written|authored|created|implemented|reviewed)\s+by\s+(?:claude|codex|gemini|qoder|deepseek|copilot|gpt)\b|(?:claude|codex|gemini|qoder|deepseek)\s+(?:wrote|decided|measured|implemented|reviewed)\b|(?:поручени[ея]|приёмк[аи]|решение|снято с|замер(?:ил|ено)|проверил[аи]?)\s+(?:claude|codex|gemini|qoder|deepseek)\b|(?:claude|codex|gemini|qoder|deepseek)\s+(?:написал[аи]?|сделал[аи]?|измерил[аи]?|решил[аи]?|поручил[аи]?|проверил[аи]?)\b/i },
  // Внутренние заметки и имена веток агентов.
  { id: 'agent-branch', label: 'ветка с именем агента', severity: 'block', mask: 'none',
    re: /\b(?:feature|integration)\/(?:[a-z]+-)?(?:qoder|deepseek|codex|claude|gemini|copilot|antigravity)-\S+/i },
  { id: 'private-dir', label: 'путь к приватной папке', severity: 'block', mask: 'path',
    re: /(?:^|[\\/\s"'(])_private[\\/]/ },
  { id: 'report-name', label: 'имя отчёта или плана работ', severity: 'block', mask: 'none',
    re: /Отчёты по работам|План работ над onlyone|RESULTS\.md/ },
  { id: 'obsidian-path', label: 'путь к хранилищу заметок', severity: 'block', mask: 'path',
    re: /\b[A-Za-z]:[\\/]obsidian\b/i },
  { id: 'worktree-path', label: 'путь рабочего дерева', severity: 'review', mask: 'path',
    re: /(?:^|[\\/\s"'(])worktrees[\\/]/i }
]

// Ожидаемые в публичном дереве адреса: тестовые домены и адреса апстрима.
const ALLOW_EMAIL = [
  'example.com', 'example.org', 'example.invalid', 'invalid', 'local', 'localhost',
  'npmjs.com', 'w3.org', 'schema.org', 'izs.me', 'users.noreply.github.com', 'onlyone.dev'
]
// Заглушки вместо секретов: имя значения говорит само за себя.
const PLACEHOLDER = /(test|fixture|example|sample|fake|dummy|placeholder|your|xxx|redacted|changeme|invalid|evil|abcdef|a{8,}|мишен|секрет|secret|onecode|not-a-real-key|Q[A-Za-z0-9]?7z2Lm4|PROFILE|window|7a8b9c|Ab3Cd4)/i
const ALLOW = [
  // Verifier сам содержит эти шаблоны и тест, который их проверяет.
  { file: 'scripts/scan-public-export.cjs', rule: 'attribution' },
  { file: 'scripts/scan-public-export.cjs', rule: 'private-key' },
  { file: 'scripts/scan-public-export.cjs', rule: 'report-name' },
  { file: 'scripts/scan-public-export.cjs', rule: 'agent-branch' },
  { file: 'tests/test-public-readiness.cjs', rule: 'email' },
  // Тест экспортёра держит `_private` строкой, чтобы проверить исключение.
  { file: 'tests/test-export-public-safety.cjs', rule: 'private-dir' },
  // Тест маскирования секретов держит фикстуры форматов, чтобы проверить зачистку.
  { file: 'tests/test-redact-secrets.cjs', rule: 'private-key' },
  { file: 'tests/test-redact-secrets.cjs', rule: 'slack-token' },
  { file: 'tests/test-redact-secrets.cjs', rule: 'jwt' },
  { file: 'tests/test-redact-secrets.cjs', rule: 'bearer' }
]

function walk (dir) {
  const out = []
  const rec = rel => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) rec(child)
      else if (entry.isFile()) out.push(child)
    }
  }
  rec('')
  return out.sort()
}

const mask = (rule, value) => {
  if (rule.mask === 'secret') return value.slice(0, 10) + `…[${value.length} символов]`
  if (rule.mask === 'email') return value.replace(/^[^@]*(?=@)/, '<почта>')
  if (rule.mask === 'path') return value.replace(/([\\/]Users[\\/])[^\\/]+/i, '$1<имя>')
  return value
}

function scanned (file, buffer) {
  if (buffer.length > LIMIT) return null
  if (buffer.subarray(0, 8192).includes(0)) return null
  return buffer.toString('utf8')
}

function selfCheck () {
  const assert = require('node:assert/strict')
  const rule = id => RULES.find(item => item.id === id).re
  assert.ok(rule('openai-key').test("const KEY = 'sk-or-v1-" + 'a'.repeat(32) + "'"))
  assert.ok(rule('private-key').test('-----BEGIN OPENSSH PRIVATE KEY-----'))
  assert.ok(rule('attribution').test(['Co', 'Authored', 'By: Someone <x@y.z>'].join('-')))
  assert.ok(rule('agent-branch').test('branch feature/qoder-1028-public'))
  assert.ok(rule('win-user-path').test('C:\\Users\\alice\\file.txt'))
  assert.ok(PLACEHOLDER.test('sk-fixture-desk-header-private-1234567890'))
  assert.equal(rule('openai-key').test('sk-(?:ant-|proj-)?'), false, 'шаблон самого сканера не должен совпадать')
  assert.equal(mask({ mask: 'secret' }, 'abcdefghijklmnop'), 'abcdefghij…[16 символов]')
  console.log('self-check ok')
}

function main () {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-check')) return selfCheck()
  const dirArg = argv[argv.indexOf('--dir') + 1]
  if (!dirArg || dirArg.startsWith('--')) {
    console.error('ОТКАЗ: нужен --dir <папка экспорта>')
    process.exit(1)
  }
  const dir = path.resolve(dirArg)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`ОТКАЗ: нет папки: ${dir}`)
    process.exit(1)
  }
  const allowed = new Set(ALLOW.map(item => item.file + '\0' + item.rule))
  const findings = new Map(RULES.map(rule => [rule.id, { ...rule, re: undefined, count: 0, files: [], samples: [] }]))
  const files = walk(dir)
  let textFiles = 0

  for (const file of files) {
    let text
    try { text = scanned(file, fs.readFileSync(path.join(dir, ...file.split('/')))) } catch { continue }
    if (text === null) continue
    textFiles++
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (!line || line.length < 8) continue
      for (const rule of RULES) {
        if (allowed.has(file + '\0' + rule.id)) continue
        const match = rule.re.exec(line)
        if (!match) continue
        const value = match[1] && rule.id === 'secret-literal' ? match[1] : match[0]
        if ((rule.id === 'secret-literal' || rule.id === 'openai-key' || rule.id === 'bearer') && PLACEHOLDER.test(value)) continue
        if (rule.id === 'email' && ALLOW_EMAIL.some(domain => value.toLowerCase().endsWith('@' + domain) || value.toLowerCase().endsWith('.' + domain))) continue
        const found = findings.get(rule.id)
        found.count++
        if (!found.files.includes(file)) found.files.push(file)
        if (found.samples.length < 5) found.samples.push({ file, line: index + 1, value: mask(rule, value) })
      }
    }
  }

  const report = {
    dir,
    filesScanned: textFiles,
    total: files.length,
    rules: [...findings.values()].filter(item => item.count),
    clean: [...findings.values()].every(item => item.count === 0),
    blocking: [...findings.values()].some(item => item.count && item.severity === 'block')
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.blocking ? 1 : 0)
}

main()
