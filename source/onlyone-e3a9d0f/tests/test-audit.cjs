// A sweep over the whole application, looking for the classes of defect that
// have actually bitten this project rather than a generic lint.
//
// Everything here is mechanical: it reads the four source files and reports what
// it can prove. A check that cannot distinguish a real defect from ordinary code
// is worse than no check, so each one is narrow and says why it exists.
const fs = require('fs')
const path = require('path')

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')

const main = read('src/main/main.js')
const app = read('src/renderer/app.js')
const preload = read('src/preload/preload.js')
const css = read('src/renderer/index.css')
const html = read('src/renderer/index.html')

let failed = 0
const problems = []
const check = (name, ok, detail) => {
  if (!ok) {
    failed++
    problems.push(name + (detail ? ' — ' + detail : ''))
    console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`)
  }
}

// --- the bridge: both directions have to line up -----------------------------
// A channel the window invokes with no handler behind it fails at the moment a
// person clicks something; a handler nobody invokes is dead weight that reads as
// a working feature.

const invoked = [...(preload + read('src/preload/desk.js')).matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1])
const handled = [...(main + read('src/main/desk-service.cjs') + read('src/main/run-configuration-restore.cjs') + read('src/main/mods-ipc.cjs') + read('src/main/project-lessons.cjs') + read('src/main/plugins-ipc.cjs')).matchAll(/(?:ipcMain\.handle|guarded)\('([^']+)'/g)].map(m => m[1])

const missingHandlers = invoked.filter(c => !handled.includes(c))
check('у каждого вызова из окна есть обработчик', missingHandlers.length === 0,
  missingHandlers.join(', '))

const unusedHandlers = handled.filter(c => !invoked.includes(c))
check('нет обработчиков, к которым никто не обращается', unusedHandlers.length === 0,
  unusedHandlers.join(', '))

// Events flow the other way: main sends, preload subscribes, the window listens.
// Main may send directly, or use the guarded sendToWindow helper when an
// event belongs to a turn that can outlive its BrowserWindow. Pushes that
// nobody asked for — a scheduler state change — go through broadcastToWindows,
// which takes the channel as its first literal argument.
// Отправитель может жить в модуле главного процесса: предложение связанного
// чата шлёт src/main/fork-proposal-tool.cjs, и без него канал выглядел бы
// мёртвым, хотя окно его слушает.
const mainEventSources = main + read('src/main/fork-proposal-tool.cjs')
const directSent = [...mainEventSources.matchAll(/\.send\('([a-z-]+)'/g)].map(m => m[1])
const guardedSent = [...mainEventSources.matchAll(/sendToWindow\([^,\r\n]+,\s*'([a-z-]+)'/g)].map(m => m[1])
const broadcastSent = [...main.matchAll(/broadcastToWindows\(\s*'([a-z-]+)'/g)].map(m => m[1])
const sent = [...new Set([...directSent, ...guardedSent, ...broadcastSent])]
const subscribed = [...new Set([...preload.matchAll(/ipcRenderer\.on\('([a-z-]+)'/g)].map(m => m[1]))]

const neverSent = subscribed.filter(c => !sent.includes(c))
check('окно не ждёт событий, которых никто не шлёт', neverSent.length === 0,
  neverSent.join(', '))

const neverHeard = sent.filter(c => !subscribed.includes(c))
check('всё, что шлёт главный процесс, кто-то слушает', neverHeard.length === 0,
  neverHeard.join(', '))

// --- the bridge surface: exposed but never called ----------------------------
// Optional chaining hides these from a naive grep, which is how a previous sweep
// produced seventeen false alarms.
const exposed = [...preload.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):/gm)].map(m => m[1])
// Runtime code can live in a page module, not only in app.js. Checking just the
// former monolith marked the live artifact panel bridge as dead code.
const runtimeScripts = [...html.matchAll(/<script\s+src="([^"]+\.js)"/g)]
  .map(match => match[1])
  .filter(src => !src.startsWith('vendor/'))
  .map(src => fs.readFileSync(path.join(__dirname, '..', 'src/renderer', src), 'utf8'))
  .join('\n')
const unusedApi = exposed.filter(name => {
  const used = new RegExp(`electronAPI\\??\\.${name}\\b`).test(app + runtimeScripts)
  return !used
})
check('в мосту нет методов, которыми никто не пользуется', unusedApi.length === 0,
  unusedApi.join(', '))

// --- elements the window looks for have to exist -----------------------------
// A missing id is silent: the handler is never attached and the button does
// nothing, which is exactly how two features shipped broken.
// Экраны живут своими модулями (план, 2d), и id панель может создать там, где
// она теперь рисуется, — искать надо по всем подключённым скриптам окна.
const windowCode = app + runtimeScripts
// Стили тоже разложены по экранам: у onboarding и ui-system свои файлы, и
// класс, которого нет в index.css, не обязан быть висяком.
const allCss = fs.readdirSync(path.join(__dirname, '..', 'src/renderer'))
  .filter(name => name.endsWith('.css'))
  .map(name => read(`src/renderer/${name}`))
  .join('\n')
const wantedIds = [...new Set([...windowCode.matchAll(/\$\('([a-zA-Z][\w]*)'\)/g)].map(m => m[1]))]
const presentIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))
// Ids the window creates for itself at runtime are legitimate too.
const createdIds = new Set([...windowCode.matchAll(/\.id = '([^']+)'/g)].map(m => m[1]))
const missingIds = wantedIds.filter(id => !presentIds.has(id) && !createdIds.has(id))
check('каждый запрашиваемый элемент есть в разметке', missingIds.length === 0,
  missingIds.join(', '))

// --- CSS classes the code sets have to be styled somewhere -------------------
// Not the reverse: a stylesheet may legitimately carry more than one screen.
const classesUsed = new Set()
for (const m of windowCode.matchAll(/classList\.(?:add|toggle|remove)\('([a-z][\w-]*)'/g)) classesUsed.add(m[1])
for (const m of windowCode.matchAll(/className = '([^']+)'/g)) {
  for (const part of m[1].split(/\s+/)) if (/^[a-z][\w-]*$/.test(part)) classesUsed.add(part)
}
const styled = new Set([...allCss.matchAll(/\.([a-z][\w-]*)/g)].map(m => m[1]))
// Класс из чужой зоны, найденный при расширении проверки ( audits/qoder-2026-09-22,
// Н26): `ui-system.js` ставит его, а в стилях его нет. Правка не наша — здесь
// список закреплён, чтобы новых таких не появлялось незаметно.
const FOREIGN_UNSTYLED = new Set(['ui-tooltip-text'])
// `live`, `open` and similar are modifiers used only in compound selectors.
const unstyled = [...classesUsed].filter(c => !styled.has(c) && !allCss.includes(c) && !FOREIGN_UNSTYLED.has(c))
check('классы, которые ставит код, описаны в стилях', unstyled.length === 0,
  unstyled.join(', '))

// --- swallowed failures ------------------------------------------------------
// `catch {}` is sometimes right — a best-effort cleanup — and sometimes the
// reason a bug took a week to find. The count is pinned so new ones are noticed.
const silentCatches = (main.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g) || []).length +
  (app.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g) || []).length
check('число проглоченных ошибок не растёт', silentCatches <= 32, String(silentCatches))

// --- promises nobody waits for ----------------------------------------------
// An un-awaited write is a race: the next read may or may not see it.
const unawaitedWrites = [...main.matchAll(/^\s+fs\.(writeFile|mkdir|rm|rename|appendFile)\(/gm)]
  .filter(m => !/await\s*$/.test(main.slice(Math.max(0, m.index - 8), m.index)))
check('файловые записи не остаются без await', unawaitedWrites.length === 0,
  unawaitedWrites.map(m => m[1]).join(', '))

// --- the window's own safety --------------------------------------------------
check('nodeIntegration выключен', /nodeIntegration:\s*false/.test(main))
check('contextIsolation включён', /contextIsolation:\s*true/.test(main))
check('окно грузит локальный файл, а не сеть', !/loadURL\(['"]https?:/.test(main))
check('внешние ссылки не открываются внутри окна',
  /setWindowOpenHandler/.test(main), 'нет обработчика окон')
check('главный экран не забит карточками команд',
  !/class="starter-grid"|class="starter-card"/.test(html),
  'на пустом экране остались карточки slash-команд')
check('slash-команды остаются доступны через меню ввода',
  ['/review', '/security', '/refactor', '/docs'].every(command => read('src/renderer/slash-commands.js').includes(`cmd: '${command}'`)),
  'встроенная команда случайно удалена')
// План, 3.10: строку списка рисует composer-menu.js, описание — его подсказка
// справа, а не глобальная на строке. Прежняя проверка смотрела на тело строки
// в app.js и требовала data-tooltip на ней — то есть берегла форму, которую
// владелец снял. Смысл тот же: описания в строке нет, меню остаётся компактным.
check('slash-меню показывает команды компактно, описание — подсказкой справа',
  ['/review', '/security'].every(command => read('src/renderer/slash-commands.js').includes(`cmd: '${command}'`)) &&
    /\.composer-menu-hint\b/.test(read('src/renderer/composer-menu.css')) &&
    !/class="slash-item-desc"/.test(app) && !/\.slash-item-desc\s*\{/.test(css) &&
    !/setAttribute\('data-tooltip', description\)/.test(app),
  'описания должны открываться подсказкой, а не занимать строку меню')
check('список чатов не сжимает строки и даёт раскрыть остаток',
  /flex:\s*0\s+0\s+3[12]px/.test(css) && /Показать все \(%s\)/.test(read('src/renderer/chat-list.js')) &&
    /Показать все \(%s\)'.*View all \(%s\)/.test(read('src/renderer/i18n.js')),
  'строки должны сохранять высоту, View all — работать в английском интерфейсе')

// --- the sandbox --------------------------------------------------------------
check('запись файла проходит проверку пути',
  /assertSafeWorkspacePath/.test(main) && (main.match(/assertSafeWorkspacePath/g) || []).length >= 5,
  'проверок ' + (main.match(/assertSafeWorkspacePath/g) || []).length)
check('символические ссылки проверяются по реальному пути',
  /realpath/.test(main))
check('удаление всегда спрашивает подтверждение',
  /if \(risk === 'destructive'\) return true/.test(main))

// --- MCP processes ------------------------------------------------------------
check('MCP-серверы запускаются без оболочки', !/shell:\s*true/.test(main))

// --- network ------------------------------------------------------------------
const fetches = [...main.matchAll(/await fetch\(/g)].length
check('в главном процессе есть сетевые вызовы', fetches > 0, String(fetches))
check('ответы проверяются на ok', (main.match(/\.ok\b/g) || []).length >= 3)

// --- what the previous sweeps found, so it cannot come back ------------------
check('нет прямой записи в захваченный чат', !/\bchat\.messages\.push\(\{/.test(app))
check('содержимое сообщений приводится к строке на выходе',
  /normalizeOutgoingMessages\(body\.messages\)/.test(main))
check('бюджет считается по запрошенному лимиту, а не по потолку',
  /const maxTokens = requestedMaxTokens\(record\)/.test(main))
// There is one mode now, so there is nothing to normalise and nothing to
// choose. What has to stay true is that no switch grew back: a picker for a
// mode that does not exist is worse than none.
check('режимов чата больше не существует',
  !/agentMode|setAgentMode|normalizeAgentMode/.test(app),
  'в окне остался переключатель режима')

// --- second pass: what the first set could not see ---------------------------

// Functions defined and never called. Dead code that looks live is how a fix
// gets applied to the copy nobody runs — it has happened here twice.
// Counts every mention of the name, not just calls: half of this codebase
// hands functions over by name — `safely('цитирование', setupQuoting)`,
// `addEventListener(…, onMenuKey)`, `.map(taskCard)`. Counting only `name(`
// called eighteen live functions dead.
//
// Counting every mention has one blind spot, and it hid a function for weeks:
// a local variable of the same name. `function leadResult()` was dead, but
// `let leadResult` inside runAgentMode was read five times, and those five
// mentions of the local made the top-level function look alive. So mentions are
// counted per scope: inside a function that declares its own binding of the
// name, every mention is that binding, and says nothing about the function.
const deadFunctions = (text, pattern, indent = '') => {
  const lines = text.split('\n')
  const closer = indent + '}'
  const opener = new RegExp('^' + indent + '(?:async )?function ([a-zA-Z]\\w*)\\(')

  // Which top-level function owns each line, and which names that function
  // declares for itself. A body that ends early — a bare closing brace inside a
  // template literal — only leaves lines unowned, which counts them, so the
  // worst this can do is under-report.
  const owner = new Array(lines.length).fill(null)
  let open = null
  for (let i = 0; i < lines.length; i++) {
    const started = open ? null : opener.exec(lines[i])
    if (started) open = { name: started[1], from: i, locals: new Set() }
    if (!open) continue
    for (const m of lines[i].matchAll(/\b(?:let|const|var)\s+([a-zA-Z]\w*)/g)) open.locals.add(m[1])
    if (!started && lines[i] === closer) {
      for (let j = open.from; j <= i; j++) owner[j] = open
      open = null
    }
  }

  const names = [...text.matchAll(pattern)].map(m => m[1])
  return names.filter(name => {
    const word = new RegExp('\\b' + name + '\\b', 'g')
    let mentions = 0
    for (let i = 0; i < lines.length; i++) {
      const block = owner[i]
      if (block && block.name !== name && block.locals.has(name)) continue
      mentions += (lines[i].match(word) || []).length
    }
    return mentions <= 1
  })
}

// The check is itself checked, on the shape it used to miss and on the shape it
// must not start flagging. Without this, «проверка работает» rests on somebody
// having tried it by hand once.
const TOP_LEVEL_FN = /^(?:async )?function ([a-zA-Z]\w*)\(/gm
const probe = [
  'function ghost(a) {',            // dead: every other mention is the local below
  '  return a',
  '}',
  '',
  'function used(b) {',             // live: called from a scope that shadows something else
  '  return b',
  '}',
  '',
  'function live() {',              // live: called at the bottom
  '  let ghost = null',
  '  ghost = used(ghost)',
  '  return ghost',
  '}',
  '',
  'live()'
].join('\n')
const found = deadFunctions(probe, TOP_LEVEL_FN).join(', ')
check('проверка мёртвого кода видит функцию за одноимённой переменной',
  found === 'ghost', found || 'не нашла ничего')

const deadInMain = deadFunctions(main, /^(?:async )?function ([a-zA-Z]\w*)\(/gm)
check('в главном процессе нет функций, которые никто не зовёт',
  deadInMain.length === 0, deadInMain.join(', '))

const deadInApp = deadFunctions(app, /^  (?:async )?function ([a-zA-Z]\w*)\(/gm, '  ')
check('в окне нет функций, которые никто не зовёт',
  deadInApp.length === 0, deadInApp.join(', '))

// A tool the model is told about has to be executable, and one that executes
// has to be described — otherwise the agent either calls nothing or is refused.
const describedTools = [...new Set(
  [...main.matchAll(/name: '([a-z_]+)',\s*\n\s*description:/g)].map(m => m[1])
)]
const runnableTools = new Set([
  ...[...main.matchAll(/name === '([a-z_]+)'/g)].map(m => m[1]),
  ...[...main.matchAll(/toolName === '([a-z_]+)'/g)].map(m => m[1])
])
const unrunnable = describedTools.filter(t =>
  !runnableTools.has(t) && !t.startsWith('project_') && t !== 'assign_work')
check('каждый описанный инструмент можно выполнить', unrunnable.length === 0,
  unrunnable.join(', '))

// Secrets must never reach the window or a log.
check('ключ не уходит в окно целиком',
  !/keyEncrypted/.test(preload) && !/keyEncrypted/.test(app),
  'зашифрованный ключ виден окну')
check('ключи не печатаются в лог',
  !/console\.(log|warn|error)\([^)]*\bkeyEncrypted\b/.test(main))

// Every window the app can open has to be as locked down as the main one, so
// there had better be only the one.
const windowCount = (main.match(/new BrowserWindow\(/g) || []).length
check('окно ровно одно', windowCount === 1, 'окон ' + windowCount)

// A stray debugger would ship.
check('нет debugger в исходниках', !/^\s*debugger\b/m.test(main + app))

// Русский текст в интерфейсе не должен ломаться в сборке.
for (const [name, text] of [['main', main], ['app', app], ['css', css], ['html', html]]) {
  check(`${name}: текст читается как UTF-8`,
    !text.includes('\uFFFD'), 'нашёлся символ замены')
}

// Прогон, поднимающий настоящее окно, зовёт общий запуск из app-launch.cjs.
// Один раз имя функции уже было подставлено без require — прогон падал на
// ReferenceError, и это увидел не тест, а живая проверка агентов, которой в
// `npm test` нет вовсе.
let launchers = 0
for (const file of fs.readdirSync(path.join(__dirname))) {
  if (!file.endsWith('.cjs')) continue
  const text = fs.readFileSync(path.join(__dirname, file), 'utf8')
  if (!/\b(electronBinary|guiEnv)\(/.test(text)) continue
  launchers++
  check(`${file}: общий запуск подключён`, /require\(['"]\.\/app-launch\.cjs['"]\)/.test(text))
}
// Проверка, никого не нашедшая, ничего и не проверила: один раз она уже
// молча пропускала все прогоны из-за испорченного регулярного выражения.
check('проверка запуска кого-то нашла', launchers >= 3, 'прогонов найдено: ' + launchers)

console.log(JSON.stringify({ ok: failed === 0, failed, problems }))
process.exit(failed ? 1 : 0)
