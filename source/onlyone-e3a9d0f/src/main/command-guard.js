'use strict'

// Граница для запуска команд агентом (план, 6.1).
//
// Условие владельца: агенту можно всё, что не угрожает самому приложению — он не
// должен иметь возможности стереть папку установки, профиль с историей и ключами
// или завершить процесс onlyone и его обновление.
//
// Это политика, а не песочница. Команда — произвольный текст, который исполняет
// оболочка, и по тексту нельзя гарантировать, чего он не сделает: `node -e …` не
// содержит ни одного запрещённого слова и при этом удалит что угодно. Поэтому
// правила ловят то, что делается в лоб (защищённый корень, массовое удаление,
// убийство приложения), а остальное доделывает карточка подтверждения: в ручных
// режимах человек видит строку команды целиком до запуска. Границу, которую можно
// обойти кавычками в строке, честнее называть проверкой, а не изоляцией.

const path = require('path')

// Изменение данных, а не чтение. ffmpeg/yt-dlp пишут файлы выходами, которых
// может быть несколько: без них запись в профиль проходила мимо проверки путей.
const MUTATION = /(?:^|[\s;|&(])(?:del|erase|rd|rmdir|rm|unlink|move|mv|ren|rename|copy|cp|xcopy|robocopy|format|diskpart|attrib|icacls|chmod|chown|dd|ffmpeg|yt-dlp|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Rename-Item|Clear-Content)(?:\s|$)/i
// Перенаправление вывода в файл — тоже запись.
const REDIRECT = />>?\s*["'`]?(?:[a-z]:[\\/]|\\\\|\/)/i

// Массовое удаление отклоняется всегда, даже с подтверждением, — как в
// delete_path и в инструментах MCP: удалять по одной записи, только по просьбе.
const MASS_DELETE = [
  { re: /(?:^|[\s;|&])(?:rd|rmdir)\s/i, need: /\s\/s\b/i, what: 'рекурсивное удаление папки' },
  { re: /(?:^|[\s;|&])del\s/i, need: /\s\/s\b/i, what: 'рекурсивное удаление файлов' },
  { re: /(?:^|[\s;|&])rm\s/i, need: /\s-[a-z]*r[a-z]*f|\s-[a-z]*f[a-z]*r/i, what: 'rm -rf' },
  { re: /Remove-Item\s/i, need: /-(?:Recurse|r)\b/i, what: 'Remove-Item -Recurse' },
  { re: /\bfind\b[^\n;|]*-delete\b/i, need: /[\s\S]/, what: 'find … -delete' },
  { re: /\bgit\s+clean\b/i, need: /(?:-[a-z]*f|--force)/i, what: 'git clean -f' }
]

const KILL_APP = /(?:^|[\s;|&])(?:taskkill|stop-process|killall|pkill)(?:\s|$)/i
const SHUTDOWN = /(?:^|[\s;|&])(?:shutdown|logoff|Restart-Computer|Stop-Computer)(?:\s|$)/i
// Публикация и сборка самого onlyone разрешены только человеку (план, 7.3).
const SELF_DEV_PUBLISH = /(?:^|[\s;|&(])(?:npm\s+run\s+build(?::[a-z0-9_-]+)?|npm\s+publish|electron-builder|gh\s+release|git\s+push)(?:\s|$)/i

const lower = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// %APPDATA%\1code, $env:APPDATA\1code и ~/… — один и тот же путь для оболочки.
// Без подстановки самый прямой способ добраться до профиля обходил бы проверку.
function expandVars(text, env) {
  return String(text || '')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (all, name) => env[name.toUpperCase()] || all)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (all, name) => env[name.toUpperCase()] || all)
    .replace(/(^|\s)~(?=[\\/])/, (all, edge) => edge + (env.USERPROFILE || env.HOME || '~'))
}

// Только явно абсолютные пути и явные переходы: относительный путь разрешается
// внутри рабочей папки, и в этом весь смысл инструмента.
function pathCandidates(text, cwd, env) {
  const expanded = expandVars(text, env)
  const patterns = [
    /["'`]?([a-z]:[\\/][^\s"'`;|&)<>]*)/gi,
    /(^|[\s;|&(])(\/[^\s"'`;|&)<>"']*)/g,
    /(^|[\s;|&(])((?:\.\.|\.\/)[^\s"'`;|&)<>"']*)/g
  ]
  const found = new Set()
  for (const re of patterns) {
    for (const match of expanded.matchAll(re)) {
      // У второго и третьего шаблона группа 1 — разделитель перед путём (пробел), а сам путь — группа 2. Раньше брали
      // группу 1, и любой путь после пробела («rm ../x», «> /etc/x») отбрасывался как «слишком короткий».
      const raw = (match[2] !== undefined ? match[2] : (match[1] || '')).replace(/[),;]+$/, '')
      if (raw.length < 2) continue
      found.add(path.resolve(cwd, raw))
    }
  }
  return [...found]
}

function insideAny(candidate, roots) {
  const probe = lower(candidate)
  return roots.map(lower).some(root => probe === root || probe.startsWith(root + '/'))
}

// cd/pushd меняет каталог, от которого оболочка считает относительные пути, а
// set задаёт переменные, которые подставляет следующая часть той же команды.
// Без этого «cd /d %APPDATA%\1code & echo x > settings.json» и
// «set "P=…" & echo x > %P%\f» писали в профиль мимо проверок (break-5 Н2).
function shellState(text, cwd, env) {
  const local = {}
  let current = cwd
  for (const segment of String(text).split(/[&;|]+/)) {
    const expanded = expandVars(segment, { ...env, ...local })
    const assignment = /^\s*set\s+["']?([A-Za-z_][A-Za-z0-9_]*)=([^"']*)["']?\s*$/i.exec(expanded)
    if (assignment) { local[assignment[1].toUpperCase()] = assignment[2]; continue }
    const move = /^\s*(?:cd|pushd|chdir|Set-Location)(?:\s+\/d)?\s+(.+?)\s*$/i.exec(expanded)
    if (move) {
      const target = move[1].trim().replace(/^["'`]+|["'`]+$/g, '')
      if (target) current = path.resolve(current, target)
    }
  }
  return { cwd: current, env: { ...env, ...local } }
}

function checkCommand({ command, cwd = process.cwd(), protectedRoots = [], appNames = [], pid = process.pid, env = process.env, selfDev = false } = {}) {
  const raw = String(command || '')
  if (!raw.trim()) return { ok: false, reason: 'Пустая команда.' }
  // Раскрываем переменные оболочки до проверок: иначе «> %APPDATA%\1code\файл»
  // прошёл бы мимо, потому что пути в строке ещё нет. Переменные из set самой
  // команды и каталог после cd — тоже часть этого раскрытия.
  const state = shellState(raw, cwd, env)
  const text = expandVars(raw, state.env)

  const roots = protectedRoots.filter(Boolean)

  if (insideAny(cwd, roots)) {
    return { ok: false, reason: 'Команда не может запускаться из папки onlyone: текущий каталог совпадает с установкой или профилем.' }
  }
  if (insideAny(state.cwd, roots)) {
    return { ok: false, reason: 'Команда не может запускаться из папки onlyone: cd/pushd ведёт в установку или профиль, а относительные пути считаются от него.' }
  }

  if (selfDev && SELF_DEV_PUBLISH.test(text)) {
    return { ok: false, reason: 'Сборка дистрибутива, публикация релиза и отправка кода (git push) агенту запрещены политикой безопасности. Публикация разрешена только владельцу вручную.' }
  }

  for (const rule of MASS_DELETE) {
    if (rule.re.test(text) && rule.need.test(text)) {
      return { ok: false, reason: `Массовое удаление отклонено (${rule.what}). Удаляй по одному файлу и только через delete_path.` }
    }
  }

  if (SHUTDOWN.test(text)) {
    return { ok: false, reason: 'Выключение или перезагрузка машины отклонены: это снимает и onlyone, и его обновление.' }
  }

  if (KILL_APP.test(text)) {
    const haystack = text.toLowerCase()
    const names = appNames.filter(Boolean).map(name => String(name).toLowerCase())
    if (names.some(name => haystack.includes(name)) || haystack.includes(`/pid ${pid}`)) {
      return { ok: false, reason: 'Завершение процесса onlyone отклонено. Остановить ход — кнопкой «Стоп», убивать приложение изнутри нельзя.' }
    }
  }

  // Чтение защищённых папок не запрещено: там логи, и смотреть их можно.
  // Запрещено всё, что в них пишет.
  if (MUTATION.test(text) || REDIRECT.test(text)) {
    const hit = pathCandidates(text, state.cwd, state.env).find(candidate => insideAny(candidate, roots))
    if (hit) {
      return { ok: false, reason: `Команда пишет внутри папки onlyone (${hit}). Установка и профиль недоступны агенту на запись.` }
    }
  }

  return { ok: true }
}

module.exports = { checkCommand, expandVars, pathCandidates }
