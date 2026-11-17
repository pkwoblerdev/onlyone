// Инициатива 8 (12.10.2026): директивы разработчика «.plan .compact .diff .watch» рядом с командами «/». Список команд
// вынесен из app.js в slash-commands.js (у app.js нулевой запас строк). `.sandbox` НЕ делается: без изоляции на уровне ОС
// имя обещало бы защиту, которой нет.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const palette = require('../src/renderer/slash-commands.js')

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

function fakeDeps(over = {}) {
  const calls = []
  const log = name => (...args) => { calls.push([name, ...args]); return undefined }
  const deps = {
    calls,
    toggleRemoteForChat: log('remote'), toggleSelfDevelopment: log('self'), openEffort: log('effort'), openSkills: log('skills'),
    openDesk: log('desk'), openMods: log('mods'), clearChat: log('clear'), openModels: log('models'), openSettings: log('settings'),
    t: s => s, showToast: log('toast'),
    permission: () => over.permission || 'acceptEdits',
    selectPermission: log('selectPermission'),
    forceCompactNext: log('forceCompact'),
    changeBlocks: () => over.blocks || [],
    send: log('send'),
    ...over.deps
  }
  return deps
}
const find = (list, cmd) => list.find(item => item.cmd === cmd)

check('все прежние команды «/» на месте и без изменений состава', () => {
  const list = palette.create(fakeDeps())
  const slash = list.filter(item => item.cmd.startsWith('/')).map(item => item.cmd)
  assert.deepEqual(slash, ['/desk', '/mods', '/agent', '/remote-control', '/self', '/effort', '/review', '/security', '/refactor', '/docs', '/tests', '/fix', '/explain', '/skills', '/clear', '/models', '/settings'])
  for (const item of list) { assert.ok(item.label && item.desc, item.cmd); assert.ok(item.prompt || item.action, item.cmd) }
})

check('прежние действия «/» зовут то, чем управляют', () => {
  const deps = fakeDeps(); const list = palette.create(deps)
  for (const cmd of ['/desk', '/mods', '/remote-control', '/self', '/effort', '/skills', '/clear', '/models', '/settings']) find(list, cmd).action()
  assert.deepEqual(deps.calls.map(c => c[0]), ['desk', 'mods', 'remote', 'self', 'effort', 'skills', 'clear', 'models', 'settings'])
})

check('директивы есть, «.sandbox» нет', () => {
  const list = palette.create(fakeDeps())
  assert.deepEqual(list.filter(i => i.cmd.startsWith('.')).map(i => i.cmd).sort(), ['.compact', '.diff', '.plan', '.sections', '.watch'])
  assert.ok(!find(list, '.sandbox'), 'без изоляции ОС это имя обещало бы защиту, которой нет')
  for (const i of list.filter(i => i.cmd.startsWith('.'))) assert.equal(i.directive, true, i.cmd + ' — директива: остаток строки не уходит модели')
})

check('меню открывается по «/» и по «.»+буквы, но не по обычному тексту', () => {
  for (const ok of ['/', '/cl', '.', '.pl', '.plan', '.gitignore']) assert.equal(palette.wantsMenu(ok), true, ok)
  for (const no of ['', 'привет', '.plan off', '. ', '.5 примеров', 'a.b', ' .plan']) assert.equal(palette.wantsMenu(no), false, JSON.stringify(no))
})

check('фильтр: «.» показывает только директивы, «/» только команды', () => {
  const list = palette.create(fakeDeps())
  assert.ok(palette.match(list, '.').every(i => i.cmd.startsWith('.')) && palette.match(list, '.').length === 5)
  assert.ok(palette.match(list, '/').every(i => i.cmd.startsWith('/')))
  assert.deepEqual(palette.match(list, '.pl').map(i => i.cmd), ['.plan'])
  assert.ok(palette.match(list, '/cl').some(i => i.cmd === '/clear'))
  assert.deepEqual(palette.match(list, '.gitignore'), [])
})

check('startsCommand: «/…» и «.…» — возможная команда, прочее — обычный текст', () => {
  for (const ok of ['/clear', '/agent сделай', '.plan', '.watch http://x']) assert.equal(palette.startsCommand(ok), true, ok)
  for (const no of ['привет', 'сделай .plan', '']) assert.equal(palette.startsCommand(no), false, JSON.stringify(no))
})

check('.plan: включает режим плана один раз; повтор ничего не меняет; «off» возвращает прежний', () => {
  const deps = fakeDeps({ permission: 'acceptEdits' })
  let mode = 'acceptEdits'
  deps.permission = () => mode
  deps.selectPermission = id => { deps.calls.push(['selectPermission', id]); mode = id }
  const plan = find(palette.create(deps), '.plan')
  plan.action('')
  plan.action('')
  assert.deepEqual(deps.calls.filter(c => c[0] === 'selectPermission'), [['selectPermission', 'plan']], 'второй вызов (меню и Enter) не должен переключать обратно')
  plan.action('off')
  assert.deepEqual(deps.calls.filter(c => c[0] === 'selectPermission').pop(), ['selectPermission', 'acceptEdits'])
  plan.action('off')
  assert.equal(deps.calls.filter(c => c[0] === 'selectPermission').length, 2, 'off без плана ничего не делает')
})

check('.plan off, когда план был включён раньше (прежний режим неизвестен): acceptEdits', () => {
  const deps = fakeDeps({ permission: 'plan' }); let mode = 'plan'
  deps.permission = () => mode; deps.selectPermission = id => { deps.calls.push(['selectPermission', id]); mode = id }
  find(palette.create(deps), '.plan').action('off')
  assert.deepEqual(deps.calls.filter(c => c[0] === 'selectPermission'), [['selectPermission', 'acceptEdits']])
})

check('.compact: следующее сообщение пойдёт со сжатой историей; назван честно', () => {
  const deps = fakeDeps(); find(palette.create(deps), '.compact').action('')
  assert.equal(deps.calls.filter(c => c[0] === 'forceCompact').length, 1)
  const toast = deps.calls.find(c => c[0] === 'toast')
  assert.match(String(toast[1]), /следующее сообщение/i)
})

check('.diff: открывает общий обзор, старый потребитель сохраняет прежнее поведение', () => {
  let opened = 0
  const review = fakeDeps({ deps: { openChangesReview: () => { opened++ } } })
  find(palette.create(review), '.diff').action('')
  assert.equal(opened, 1)
  const none = fakeDeps(); find(palette.create(none), '.diff').action('')
  assert.match(String(none.calls.find(c => c[0] === 'toast')[1]), /нет правок|ещё нет/i)

  const shown = []
  const block = id => ({ open: false, scrollIntoView: opts => shown.push([id, opts]), classList: { add() {}, remove() {} }, id })
  const first = block('a'), last = block('b')
  const deps = fakeDeps({ blocks: [first, last] }); find(palette.create(deps), '.diff').action('')
  assert.equal(last.open, true); assert.equal(first.open, false)
  assert.deepEqual(shown.map(s => s[0]), ['b'])
})

check('.watch: адрес обязателен; с адресом уходит просьба следить через watch_page', () => {
  const none = fakeDeps(); find(palette.create(none), '.watch').action('')
  assert.equal(none.calls.filter(c => c[0] === 'send').length, 0)
  assert.match(String(none.calls.find(c => c[0] === 'toast')[1]), /адрес/i)

  const file = fakeDeps(); find(palette.create(file), '.watch').action('src/main/main.js')
  assert.equal(file.calls.filter(c => c[0] === 'send').length, 0, 'за файлом слежения нет — не обещаем')
  assert.match(String(file.calls.find(c => c[0] === 'toast')[1]), /страниц/i)

  for (const url of ['http://localhost:5173', 'https://example.com/a?b=1']) {
    const ok = fakeDeps(); find(palette.create(ok), '.watch').action(url)
    const sent = ok.calls.find(c => c[0] === 'send')
    assert.ok(sent && sent[1].includes(url) && /watch_page/.test(sent[1]), url)
  }
})

check('app.js, index.html и main.js подключают палитру', () => {
  const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
  const app = read('src/renderer/app.js'), html = read('src/renderer/index.html'), main = read('src/main/main.js')
  assert.ok(/OnlyoneSlashCommands\.create\(/.test(app), 'app.js не собирает команды модулем')
  assert.ok(!/const SLASH_COMMANDS = \[/.test(app), 'список команд остался в app.js')
  assert.ok(/OnlyoneSlashCommands\.wantsMenu\(/.test(app) && /OnlyoneSlashCommands\.match\(/.test(app) && /OnlyoneSlashCommands\.startsCommand\(/.test(app), 'app.js не зовёт помощники палитры')
  assert.ok(/forceCompactNext/.test(app) && /forceCompression/.test(app), 'флаг .compact не уходит в запрос')
  assert.ok(html.indexOf('slash-commands.js') > 0 && html.indexOf('slash-commands.js') < html.indexOf('src="app.js"'), 'модуль не подключён до app.js')
  assert.ok(/forceCompression/.test(main), 'главный процесс не знает про принудительное сжатие')
})

if (failed) process.exit(1)
console.log('Палитра директив: проверки пройдены')
