'use strict'

// Правила команд агента: «разрешить / спрашивать / запретить» по маске, как у opencode (`"git *": "ask"`).
//
// Раньше run_command в ручном режиме спрашивал про каждую команду, включая `git status` и `ls`, а в режиме «Не спрашивать
// про запись» не спрашивал ни про одну, включая `git push`. Правила дают середину: безобидное чтение идёт без карточки,
// а то, что человек назвал опасным, спрашивается или запрещается в любом режиме.
//
// Осторожность важнее удобства. Разрешение действует только на простую команду внутри рабочих папок — без перенаправлений,
// подстановок и вывода в файл — и только когда разрешён КАЖДЫЙ кусок составной команды. Запрет и «спрашивать» срабатывают
// на любом куске. Это не песочница (см. command-guard.js): политика безопасности работает до правил и правилами не снимается.

const path = require('node:path')
const { pathCandidates, expandVars } = require('./command-guard')

const ACTIONS = { allow: 'allow', ask: 'ask', deny: 'deny', разрешить: 'allow', спрашивать: 'ask', запретить: 'deny' }

// Только чтение и справки. Ни одной команды, которая что-то меняет, ставит или отправляет.
const DEFAULT_RULES = [
  'git status*', 'git diff*', 'git log*', 'git show*', 'git blame*', 'git rev-parse*', 'git ls-files*', 'git describe*',
  'git branch', 'git branch --list*', 'git branch -a*', 'git branch -v*', 'git remote -v', 'git stash list*', 'git config --get*',
  'ls', 'ls *', 'dir', 'dir *', 'pwd', 'echo *', 'tree', 'tree *', 'Get-ChildItem*', 'Get-Location',
  'node -v', 'node --version', 'npm -v', 'npm --version', 'npm ls*', 'npm list*',
  'python --version', 'python -V', 'pip --version', 'pip list*', 'where *', 'which *'
].map(pattern => ({ pattern, action: 'allow' }))

function parseRules (text) {
  const rules = []
  const errors = []
  String(text || '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const match = /^(\S+)\s+(.+)$/.exec(line)
    const action = match && ACTIONS[match[1].toLowerCase()]
    if (!action) {
      errors.push({ line: index + 1, text: line, why: 'Строка должна начинаться с allow, ask или deny (разрешить, спрашивать, запретить), дальше — маска команды.' })
      return
    }
    rules.push({ pattern: match[2].trim().replace(/\s+/g, ' '), action })
  })
  return { rules, errors }
}

function formatRules (rules) {
  return (rules || []).map(rule => `${rule.action} ${rule.pattern}`).join('\n')
}

function compile (pattern) {
  const source = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  // «make *» подходит и к голой «make»: хвост из пробела и звёздочки необязателен.
  const body = source.endsWith(' *') ? source.slice(0, -2).replace(/\*/g, '.*') + '( .*)?' : source.replace(/\*/g, '.*')
  return new RegExp('^' + body + '$', 'i')
}

const compiled = new Map()
function matcher (pattern) {
  if (!compiled.has(pattern)) compiled.set(pattern, compile(pattern))
  return compiled.get(pattern)
}

// Режем по &&, ||, ;, |, & и переводу строки, но не внутри кавычек. Попутно замечаем то, что делает разрешение небезопасным.
function split (command) {
  const parts = []
  let current = ''
  let quote = ''
  let unsafe = false
  const text = String(command)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = ''
      else if (quote === '"' && (ch === '$' && text[i + 1] === '(')) unsafe = true
      else if (quote === '"' && ch === '`') unsafe = true
      continue
    }
    // Оболочка — cmd.exe: одинарная кавычка там не кавычка. Считая её кавычкой,
    // split прятал вторую команду от разбора: «echo 'ok & ren a b'» получал
    // авто-allow без карточки в любом режиме (break-5 Н3).
    if (ch === '"') { quote = ch; current += ch; continue }
    if (ch === '`' || (ch === '$' && (text[i + 1] === '(' || text[i + 1] === '{'))) unsafe = true
    if (ch === '>' || ch === '<') unsafe = true
    if (ch === '&' || ch === '|' || ch === ';' || ch === '\n') {
      if ((ch === '&' || ch === '|') && text[i + 1] === ch) i++
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  if (/\s--output\b/i.test(text)) unsafe = true
  return { segments: parts.map(part => part.trim().replace(/\s+/g, ' ')).filter(Boolean), unsafe }
}

const lower = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const inside = (candidate, roots) => roots.map(lower).some(root => lower(candidate) === root || lower(candidate).startsWith(root + '/'))

// action: 'allow' | 'ask' | 'deny' | null (правила молчат — решает режим прав).
function evaluateCommand (command, { rules = [], cwd = process.cwd(), roots = [], env = process.env, defaults = DEFAULT_RULES } = {}) {
  const { segments, unsafe } = split(command)
  if (!segments.length) return { action: null, rule: null }
  const all = [...defaults, ...rules]

  let asked = null
  let everyAllowed = true
  for (const segment of segments) {
    let found = null
    for (const rule of all) if (matcher(rule.pattern).test(segment)) found = rule
    if (found && found.action === 'deny') return { action: 'deny', rule: found }
    if (found && found.action === 'ask') asked = found
    if (!found || found.action !== 'allow') everyAllowed = false
  }
  if (asked) return { action: 'ask', rule: asked }
  if (!everyAllowed || unsafe) return { action: null, rule: null }

  // Разрешение — только для команды, которая смотрит внутрь рабочих папок.
  const text = expandVars(String(command), env)
  const outside = pathCandidates(text, cwd, env).some(candidate => !inside(candidate, roots.length ? roots : [cwd]))
  if (outside) return { action: null, rule: null }
  return { action: 'allow', rule: null }
}

module.exports = { parseRules, formatRules, evaluateCommand, DEFAULT_RULES, ACTIONS, path }
