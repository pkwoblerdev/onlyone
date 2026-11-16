// Аудит вида приложения (вручную, не в общем прогоне): настоящее окно, свежий профиль, диалог с богатой лентой. Каждый экран
// и размер — отдельный запуск: снимок + замеры из audit-design-renderer.js (шрифты, перекрытия, обрезка, панели).
//   node tests/audit-design.cjs [папка снимков] [экран…]      например: node tests/audit-design.cjs C:/tmp/shots chat-rich settings
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const target = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-audit-'))
const only = process.argv.slice(3)
fs.mkdirSync(target, { recursive: true })
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-audit-run-'))
const profile = path.join(out, 'profile'); const workspace = path.join(out, 'workspace')
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
}))
const providerFile = path.join(out, 'provider.json')
fs.writeFileSync(providerFile, JSON.stringify({ turns: Array.from({ length: 4 }, (_, i) => ({ text: 'Ответ ' + i })) }))
const AUDIT = fs.readFileSync(path.join(__dirname, 'audit-design-renderer.js'), 'utf8')

const PRELUDE = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(100) } return false }
  await until(() => document.documentElement.dataset.appReady === '1', 30000)
  if ($('onboarding') && !$('onboarding').hidden) $('onboarding').hidden = true
  await wait(500)
  const size = async (w, h) => { window.resizeTo(w, h); await until(() => Math.abs(innerWidth - w) < 40, 4000); await wait(500) }
  const light = () => { const s = $('personalTheme'); if (s) { s.value = 'light'; s.dispatchEvent(new Event('change', { bubbles: true })) } }
  const dark = () => { const s = $('personalTheme'); if (s) { s.value = 'dark'; s.dispatchEvent(new Event('change', { bubbles: true })) } }
  const ask = async text => { const b = $('composerTextarea'); b.value = text; b.dispatchEvent(new Event('input', { bubbles: true })); await wait(150); $('composerForm').requestSubmit() }
  const openRich = async () => { const t = [...document.querySelectorAll('.history-item-title')].find(n => n.textContent.includes('Богатая лента')); t && t.click(); await until(() => document.querySelectorAll('#messagesList .msg-item').length >= 4, 15000); await wait(600) }
`

// Богатая лента: заголовки, таблица, код с длинной строкой, вложенные списки, цитата, блоки хода, правки файлов.
const SEED = `
  const md = [
    '## Итог работы', '', 'Сделано **три** вещи: \`parseConfig()\`, \`loadSkills()\` и *проверка* путей.', '',
    '- первый пункт', '  - вложенный пункт с длинным текстом, который должен перенестись на следующую строку без обрезки', '    - ещё глубже', '- второй пункт', '',
    '| Файл | Строк | Статус |', '|---|---|---|', '| src/main/main.js | 14749 | изменён |', '| src/renderer/app.js | 12019 | изменён |', '',
    '> Цитата: важное замечание о том, как это работает.', '', '\`\`\`js', 'const veryLongLine = "' + 'очень-длинная-строка-кода-'.repeat(8) + '"', 'function f() { return 1 }', '\`\`\`', '',
    'Ссылка на [документацию](https://example.com/docs) и путь \`D:/проект/src/очень/длинный/путь/к/файлу/модуля.js\` в тексте.'
  ].join('\\n')
  const now = Date.now()
  const messages = []
  for (let i = 0; i < 3; i++) {
    messages.push({ role: 'user', content: i === 0 ? 'Разбери конфигурацию и поправь загрузку навыков. ' + 'Подробности задачи. '.repeat(8) : 'Ещё уточнение номер ' + i, timestamp: now - (20 - i * 2) * 60000 })
    messages.push({ role: 'assistant', content: md, modelName: 'GLM 5.3 Flash', timestamp: now - (19 - i * 2) * 60000,
      blocks: [
        { kind: 'thinking', text: '**Смотрю структуру.**\\nНужно понять, что можно вынести.' },
        { kind: 'tool', parts: { verb: 'Прочитал', target: 'src/main/main.js', tone: 'read', tool: 'read_file' } },
        { kind: 'tool', parts: { verb: 'Записал', target: 'src/main/config.js', tone: 'ok', tool: 'write_file', meta: '+42 −3' } },
        { kind: 'tool', parts: { verb: 'Выполнил', target: 'npm test', tone: 'ok', tool: 'run_command' } },
        { kind: 'text', text: md }
      ],
      fileChanges: [{ file: 'src/main/config.js', action: 'updated', added: 42, removed: 3 }, { file: 'src/renderer/очень-длинное-имя-файла-для-проверки-переноса.js', action: 'created', added: 120, removed: 0 }] })
  }
  await window.electronAPI.setConversations([
    { id: 'rich', title: 'Богатая лента: таблица, код, списки', messages, createdAt: now - 3600000, updatedAt: now - 1000 },
    { id: 'fork-rich', title: 'Форк: таблица и код', messages: [{ role: 'user', content: 'Продолжи разбор' }], fork: { version: 1, kind: 'text-snapshot', parentChatId: 'rich', sourceMessageIndex: 0, createdAt: now - 500000 }, createdAt: now - 500000, updatedAt: now - 500000 },
    { id: 'c2', title: 'Сайт студии: главная страница', messages: [{ role: 'user', content: 'Сделай главную' }, { role: 'assistant', content: 'Готово.' }], createdAt: now - 7200000, updatedAt: now - 7000000 },
    { id: 'c3', title: 'Очень длинное название диалога, которое не помещается в строку боковой панели и обязано обрезаться многоточием', messages: [{ role: 'user', content: 'x' }], createdAt: now - 9000000, updatedAt: now - 9000000 }
  ])
  location.reload()
  await wait(20000)
`

// Ходы сценария: чек-лист + запись файла (панель «Работа») и показ страницы (панель артефакта).
const toolTurn = (text, name, args) => ({ text, toolCalls: [{ name, args }] })
const PLAN_TURNS = [
  toolTurn('Составляю план.', 'task_plan', { items: [{ id: 'a', title: 'Прочитать конфигурацию', status: 'done' }, { id: 'b', title: 'Поправить загрузку навыков', status: 'doing' }, { id: 'c', title: 'Прогнать тесты', status: 'todo' }] }),
  toolTurn('Пишу файл.', 'write_file', { path: 'config.js', content: 'module.exports = {}\n' }),
  { text: 'Готово: файл записан.' }, { content: 'ВЕРДИКТ: ГОТОВО' }, { text: 'Подсказка' }, { text: 'Название' }
]
const ART_TURNS = [
  toolTurn('Показываю страницу.', 'show_artifact', { title: 'Страница', kind: 'page', content: '<h1>Кофейня Север</h1><p>Открыто с 8 до 22.</p>' }),
  { text: 'Готово: страница показана рядом.' }, { content: 'ВЕРДИКТ: ГОТОВО' }, { text: 'Подсказка' }, { text: 'Название' }
]

const SCENES = [
  { name: 'chat-rich-top', size: [1240, 800], body: "await openRich(); const f = $('chatFeed') || $('messagesList'); f.scrollTop = 0; await wait(500)" },
  { name: 'chat-rich-mid', size: [1240, 800], body: "await openRich(); const f = $('chatFeed') || $('messagesList'); f.scrollTop = f.scrollHeight * 0.45; await wait(500)" },
  { name: 'chat-work-panel', size: [1240, 800], turns: PLAN_TURNS, body: "$('newChatBtn') && $('newChatBtn').click(); await wait(400); await ask('Сделай по плану'); await until(() => document.querySelector('.tasks-panel'), 40000); await wait(1500)" },
  { name: 'chat-work-panel-narrow', size: [900, 650], turns: PLAN_TURNS, body: "$('newChatBtn') && $('newChatBtn').click(); await wait(400); await ask('Сделай по плану'); await until(() => document.querySelector('.tasks-panel'), 40000); await wait(1500)" },
  { name: 'chat-artifact-panel', size: [1240, 800], turns: ART_TURNS, body: "$('newChatBtn') && $('newChatBtn').click(); await wait(400); await ask('Покажи страницу'); await until(() => document.querySelector('#artifactPanel.open, #artifactPanel:not([hidden])'), 40000); await wait(1500)" },
  { name: 'light-chat-rich', size: [1240, 800], body: "light(); await openRich()" },
  { name: 'light-chat-empty', size: [1240, 800], body: "light(); $('newChatBtn') && $('newChatBtn').click(); await wait(600)" },
  { name: 'light-settings', size: [1240, 800], body: "light(); $('openSettingsBtn').click(); await wait(700)" },
  { name: 'settings-budget', size: [1240, 800], body: "$('openSettingsBtn').click(); await wait(500); $('tab-agent') && $('tab-agent').click(); await wait(700)" },
  { name: 'dark-settings-budget', size: [1240, 800], body: "dark(); $('openSettingsBtn').click(); await wait(500); $('tab-agent') && $('tab-agent').click(); await wait(700)" },
  { name: 'dark-chat-rich', size: [1240, 800], body: "dark(); await openRich()" },
  { name: 'light-settings-budget', size: [1240, 800], body: "light(); $('openSettingsBtn').click(); await wait(500); $('tab-agent') && $('tab-agent').click(); await wait(700)" },
  { name: 'chat-empty', size: [1240, 800], body: "$('newChatBtn') && $('newChatBtn').click(); await wait(600)" },
  { name: 'chat-rich', size: [1240, 800], body: 'await openRich()' },
  { name: 'chat-rich-narrow', size: [760, 600], body: 'await openRich()' },
  { name: 'chat-rich-tasks-panel', size: [1240, 800], body: "await openRich(); $('taskPill') && $('taskPill').click(); await wait(800)" },
  { name: 'chat-rich-browser', size: [1240, 800], body: "await openRich(); $('openBrowserBtn') && $('openBrowserBtn').click(); await wait(900)" },
  { name: 'chat-rich-browser-narrow', size: [900, 650], body: "await openRich(); $('openBrowserBtn') && $('openBrowserBtn').click(); await wait(900)" },
  { name: 'model-popover', size: [1240, 800], body: "$('newChatBtn') && $('newChatBtn').click(); await wait(400); $('modelEffortPillBtn').click(); await wait(700)" },
  { name: 'slash-menu', size: [1240, 800], body: "$('newChatBtn') && $('newChatBtn').click(); await wait(400); const b = $('composerTextarea'); b.value = '/'; b.dispatchEvent(new Event('input', { bubbles: true })); await wait(500)" },
  { name: 'dot-menu', size: [1240, 800], body: "$('newChatBtn') && $('newChatBtn').click(); await wait(400); const b = $('composerTextarea'); b.value = '.'; b.dispatchEvent(new Event('input', { bubbles: true })); await wait(500)" },
  { name: 'projects', size: [1240, 800], body: "$('navProjects').click(); await wait(800)" },
  { name: 'skills', size: [1240, 800], body: "$('navSkills').click(); await wait(800)" },
  { name: 'design', size: [1240, 800], body: "$('navDesign').click(); await wait(1200)" },
  { name: 'connectors', size: [1240, 800], body: "$('navConnectors').click(); await wait(900)" },
  { name: 'task-center', size: [1240, 800], body: "$('navTasks').click(); await wait(900)" },
  { name: 'split-view', size: [1240, 800], body: "await openRich(); $('splitViewBtn') && $('splitViewBtn').click(); await wait(900)" },
  { name: 'settings', size: [1240, 800], body: "$('openSettingsBtn').click(); await wait(700)" }
]

function launch (name, body, size, turns) {
  const script = path.join(out, name + '.js'); const result = path.join(out, name + '.json')
  if (turns) fs.writeFileSync(providerFile, JSON.stringify({ turns }))
  else fs.writeFileSync(providerFile, JSON.stringify({ turns: Array.from({ length: 4 }, (_, i) => ({ text: 'Ответ ' + i })) }))
  const shot = path.join(target, name + '.png')
  fs.writeFileSync(script, `(async () => {${PRELUDE}\n${AUDIT}\nawait size(${size[0]}, ${size[1]})\n${body}\nawait wait(400)\nreturn { ok: true, audit: window.__audit() }})()`)
  spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 120000, stdio: 'ignore',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_SHOT: shot, ONECODE_E2E: '1', ONECODE_VERSIONS: '0', ONECODE_PROVIDER_FILE: providerFile })
  })
  return fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : null
}

// Засев: после перезагрузки страница умирает вместе со скриптом — отчёта нет, прогон обрывается по таймауту.
{
  const script = path.join(out, 'seed.js')
  fs.writeFileSync(script, `(async () => {${PRELUDE}${SEED}})()`)
  spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 45000, stdio: 'ignore',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: path.join(out, 'seed.json'), ONECODE_E2E: '1', ONECODE_VERSIONS: '0', ONECODE_PROVIDER_FILE: providerFile })
  })
}

const summary = []
for (const scene of SCENES.filter(s => !only.length || only.includes(s.name))) {
  const report = launch(scene.name, scene.body, scene.size, scene.turns)
  const a = report && report.audit
  if (!a) { console.log('ПРОВАЛ ' + scene.name + ': окно не отчиталось'); summary.push({ scene: scene.name, error: true }); continue }
  fs.writeFileSync(path.join(target, scene.name + '.json'), JSON.stringify(a, null, 1))
  const odd = a.badFonts.map(f => `${f.family}×${f.chars}`)
  const tiny = a.sizes.filter(s => s.px < 11 && s.chars > 3).map(s => `${s.px}px×${s.chars}`)
  if (a.headings && a.headings.length) console.log('   заголовки: ' + a.headings.slice(0, 5).map(h => `${h.text}[${h.size}/${h.weight}]`).join('  '))
  console.log(`${scene.name.padEnd(26)} шрифты: ${a.fonts.map(f => f.family + '×' + f.chars).join(', ')}`)
  if (odd.length) console.log(`   ✗ нестандартные шрифты: ${odd.join(', ')}  ← ${a.badFonts.map(f => f.samples[0]).join(' | ')}`)
  if (tiny.length) console.log(`   ✗ мелкий текст (<11px): ${tiny.join(', ')}`)
  if (a.pageOverflow) console.log(`   ✗ страница шире окна на ${a.pageOverflow}px`)
  if (a.overlapCount) console.log(`   ✗ наложений: ${a.overlapCount}; первые: ` + a.overlaps.slice(0, 4).map(o => `${o.a} × ${o.b} (${o.pct}% @${o.at})`).join(' ; '))
  if (a.clipped.length) console.log(`   ✗ текст обрезан без многоточия: ` + a.clipped.slice(0, 4).map(c => `${c.el} «${c.text}» ${c.client}/${c.scroll}`).join(' ; '))
  summary.push({ scene: scene.name, badFonts: odd.length, overlaps: a.overlapCount, clipped: a.clipped.length, overflow: a.pageOverflow })
}
fs.writeFileSync(path.join(target, 'summary.json'), JSON.stringify(summary, null, 1))
console.log('\nСнимки и замеры: ' + target)
