// Расход запросов и токенов агента (07.10.2026): команда по просьбе, независимый судья, стабильное начало промпта,
// параллельные чтения, правила команд. Всё, что проверяется без окна; оконный прогон — run-agent-economy-ui.cjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const main = read('src/main/main.js')

let failed = 0
function test (name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '—', error.message) }
}

// ── 1. Команда — по просьбе ──────────────────────────────────────────────────────
test('помощники из пула подбираются только когда команду попросили', () => {
  assert.match(main, /if \(isCollab && !helpers\.length && lead\.supportsTools/)
})

test('assign_work и бриф координатора даются только на командном ходе', () => {
  assert.match(main, /canAssign: lead\.supportsTools && helpers\.length > 0 && isCollab,/)
  assert.match(main, /isCollab \? \(payload\.designId \? leadDesignBrief\(helpers\.length, roundNote\) : leadBrief\(helpers\.length, roundNote\)\) : ''/)
})

test('заметка о помощнике по решениям не теряется под брифом координатора', () => {
  assert.match(main, /customSystemPrompt: \[payload\.customSystemPrompt,/)
})

test('раздел «Дизайн» не объявляет команду на каждое сообщение', () => {
  const renderer = read('src/renderer/app.js')
  const send = renderer.slice(renderer.indexOf("const requestId = `design_${activeDesign.id}"), renderer.indexOf('params: { useTools: true }', renderer.indexOf("const requestId = `design_${activeDesign.id}")))
  assert.ok(send.length > 200 && !/collaborative:\s*true/.test(send))
})

// ── 2. Независимый судья ─────────────────────────────────────────────────────────
test('судья — другая модель из списка проверяющих, а своя остаётся запасной', () => {
  const { pickJudgeModel } = require('../src/main/judge-model.cjs')
  const pool = ['a/one:free', 'b/two:free', 'c/three:free']
  assert.equal(pickJudgeModel({ lead: 'a/one:free', candidates: pool }), 'b/two:free')
  assert.equal(pickJudgeModel({ lead: 'x/lead', candidates: pool }), 'a/one:free')
  assert.equal(pickJudgeModel({ lead: 'a/one:free', candidates: pool, usable: id => id === 'c/three:free' }), 'c/three:free')
  assert.equal(pickJudgeModel({ lead: 'a/one:free', candidates: ['a/one:free'] }), 'a/one:free', 'других нет — судит та, что работала')
  assert.equal(pickJudgeModel({ lead: 'a/one:free', candidates: pool, usable: () => false }), 'a/one:free')
})

test('приёмка спрашивает другую модель, а при её молчании — ту, что работала', () => {
  assert.match(main, /require\('\.\/judge-model\.cjs'\)/)
  assert.match(main, /function judgeModelFor\(leadModel\)/)
  assert.match(main, /judgeModelFor\(model\) : model/)
  assert.match(main, /verdict\.done === null && judging !== model/)
})

test('у своего эндпоинта судья не подменяется: чужих id он не знает', () => {
  const body = main.slice(main.indexOf('function judgeModelFor(leadModel)'))
  assert.match(body.slice(0, 400), /customProviderChosen\(\)\) return leadModel/)
})

// ── 2б. Вид провайдеров собирается из одной выборки настроек ───────────────────────
test('снимок настроек объявлен через var: активный путь читается при загрузке, раньше этой строки', () => {
  // С `let` приложение не запускалось: «Cannot access 'settingsSnapshot' before initialization» (07.10, окно ошибки).
  assert.match(main, /\nvar settingsSnapshot = null\n/)
  assert.ok(!/\nlet settingsSnapshot\b/.test(main))
  assert.match(main, /return withSettingsSnapshot\(buildPublicCustomProvider\)/)
})

test('язык интерфейса для tr() читается из кэша и сбрасывается при записи, а не из файла на каждый вызов', () => {
  // Каждый tr() читал файл настроек целиком: вид провайдеров переводит сотни строк — это полсекунды на открытие настроек.
  assert.match(main, /let languageCache = null\nsetLanguageSource\(\(\) => \{\n  if \(languageCache === null\) languageCache = /)
  assert.match(main, /store\.set\('language', settings\.language === 'en' \? 'en' : 'ru'\)\n    languageCache = null/)
})

// ── 3. Начало промпта стоит на месте, лишнее не едет ─────────────────────────────
test('переменное по тексту просьбы стоит в хвосте промпта, после человека', () => {
  const modes = require('../src/main/mode-prompts')
  const ctx = { toolNames: ['read_file'], personal: '--- О пользователе ---\nИмя: Паша' }
  const one = modes.buildModePrompt('agent', ctx, ['РОЛЬ'], ['ПАМЯТКА-ПЕРВАЯ'])
  const two = modes.buildModePrompt('agent', ctx, ['РОЛЬ'], ['ПАМЯТКА-ВТОРАЯ, подлиннее'])
  assert.ok(one.indexOf('ПАМЯТКА-ПЕРВАЯ') > one.indexOf('--- О пользователе ---'), 'хвост встал раньше человека')
  const common = one.slice(0, one.indexOf('ПАМЯТКА-ПЕРВАЯ'))
  assert.ok(two.startsWith(common), 'начало промпта разное — кэш провайдера не сработает')
  assert.ok(common.length > 5000, 'общее начало подозрительно короткое')
})

test('памятки, «сделай полностью» и напоминание о длинном разговоре идут хвостом, а не в середине', () => {
  assert.match(main, /\], \[\n\s+\/\/ Меняется от сообщения к сообщению[^\n]*\n\s+buildWholeJobBlock\(task\),\n\s+buildLongConversationNote\(turnCount\),\n\s+buildCarryoverBlock\(agentName\),\n\s+buildLessonsBlock\(mode, request \|\| task\),\n\s+\/\/ Время меняется[^\n]*\n\s+clockNote\(new Date\(\), new Date\(\)\.getTimezoneOffset\(\)\),\n\s+\.\.\.tail\n\s+\]\)/)
  assert.match(main, /tail: \[buildGuideContext\(taskText, Boolean\(design\)/)
})

test('контракт качества без команды не говорит о команде, а с командой говорит', () => {
  const { qualityContract } = require('../src/main/agent-quality.js')
  assert.ok(!/<collaboration>/.test(qualityContract({ team: false })))
  assert.ok(/<collaboration>/.test(qualityContract({ team: true })))
  assert.ok(/<collaboration>/.test(qualityContract()), 'без параметров — прежний полный текст')
  assert.ok(qualityContract({ team: false }).length < qualityContract().length - 400)
})

test('«Качество визуальной работы» — только дизайну и визуальным просьбам', () => {
  const { designQuality } = require('../src/main/agent-quality.js')
  assert.equal(designQuality({ design: false, task: 'почини гонку данных в обработчике отмены' }), '')
  assert.equal(designQuality({ design: false, task: 'прочитай package.json и скажи версию' }), '')
  assert.ok(designQuality({ design: true, task: '' }).includes('Качество визуальной работы'))
  assert.ok(designQuality({ design: false, task: 'нарисуй лендинг для кофейни' }).includes('Качество визуальной работы'))
  assert.ok(designQuality({ design: false, task: 'поправь вёрстку карточки' }).includes('Качество визуальной работы'))
  assert.ok(designQuality().includes('Качество визуальной работы'), 'без параметров — прежний полный текст')
})

test('блок про собственные инструменты — только когда define_tool есть', () => {
  const { completionContract } = require('../src/main/agent-completion.js')
  assert.ok(!/Автономность и синтез инструментов/.test(completionContract({ defineTool: false })))
  assert.ok(/Автономность и синтез инструментов/.test(completionContract({ defineTool: true })))
  assert.ok(/Автономность и синтез инструментов/.test(completionContract()), 'без параметров — прежний полный текст')
  const lean = completionContract({ defineTool: false })
  assert.ok(/Менять решение — часть работы/.test(lean) && /Ровно та задача/.test(lean), 'обрезан не тот хвост')
})

test('правила сдачи работы не повторяют контракт завершения', () => {
  const { handoffRules } = require('../src/main/mode-prompts/shared.js')
  const text = handoffRules(['read_file'])
  assert.ok(text.length < 700, 'правила сдачи снова разрослись: ' + text.length)
  for (const keep of [/## Как сдаётся работа/, /Три пункта, а не три абзаца/, /«Сделал», «исправил»/, /не проверял/, /Не называй незавершённое завершённым/]) {
    assert.match(text, keep)
  }
})

test('исполнитель получает контракт по ходу дела: команда и визуальная часть передаются явно', () => {
  assert.match(main, /qualityContract\(\{ team: Boolean\(payload\.team \|\| payload\.canAssign \|\| slot\.index > 0\) \}\)/)
  assert.match(main, /designQuality\(\{ design: Boolean\(payload\.designId\), task: lastUserMessage\(payload\) \}\)/)
  assert.match(main, /payload = \{ \.\.\.payload, cycle, team: isCollab \}/)
})

// ── 4. Параллельные чтения ───────────────────────────────────────────────────────
test('независимые чтения стартуют вместе и обрываются на первом вызове с последствиями', () => {
  const at = main.indexOf("const parallelReads = new Set(['read_file', 'list_files', 'search_files', 'find_symbol'])")
  assert.ok(at > 0, 'набор параллельных чтений не найден')
  const block = main.slice(at, at + 1100)
  assert.match(block, /!parallelReads\.has\(name\)/)
  assert.match(block, /prefetched\.size >= 8/)
  assert.match(block, /\.catch\((?:\(\) => \{\}|err => \(\{ success: false)/)
  assert.match(main, /await \(prefetched\.get\(call\.id\) \|\| executeTool\(event, toolName, args, payload\.requestId, design, signal\)\)/)
})

// ── 5. edit_file подключён везде, где перечисляются изменяющие инструменты ───────
test('edit_file числится изменяющим инструментом в приёмке, доске, ленте и правах', () => {
  assert.match(read('src/main/agent-completion.js'), /'write_file', 'edit_file'/)
  assert.match(read('src/main/agent-board.js'), /'write_file', 'edit_file'/)
  const { toolAllowedForAssignment } = require('../src/main/agent-quality.js')
  assert.equal(toolAllowedForAssignment('edit_file', true), false, 'помощник «только чтение» получил правку')
  assert.equal(toolAllowedForAssignment('edit_file', false), true)
  const blocks = read('src/renderer/message-blocks.js')
  assert.ok((blocks.match(/edit_file/g) || []).length >= 5, 'лента не знает edit_file')
  assert.match(main, /name: 'edit_file'/)
  assert.match(main, /if \(name === 'edit_file'\) return await editWorkspaceFile/)
  const { READ_ONLY_TOOLS } = (() => { try { return require('../src/main/run-checkpoints.js') } catch { return {} } })()
  if (READ_ONLY_TOOLS) assert.ok(!READ_ONLY_TOOLS.has('edit_file'), 'правка записана как безобидное чтение')
})

if (failed) process.exit(1)
console.log('\nЭкономия агента: проверки пройдены')
