// Одиннадцать ошибок, найденных в 0.83.0 сторонним аудитом, и защита от их
// возвращения. Каждая проверка описывает не «как написан код», а что именно
// теряло данные или врало пользователю.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log('  ok  ' + name) }
  catch (err) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message)) }
}

const cut = (source, from, to) => {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  assert.ok(a >= 0 && b > a, 'не найдено: ' + from)
  return source.slice(a, b)
}

// --- потеря файла --------------------------------------------------------------
// Файл читался до окна подтверждения, а писался после. Человек успевал поправить
// его в редакторе — правку затирало, и, что хуже, в снимок для «отменить»
// попадало прочитанное до неё содержимое: откат уничтожал работу окончательно.
const writeTool = cut(main, "if (name === 'write_file') {", "if (name === 'move_path')")

check('запись сверяет файл после подтверждения', () => {
  assert.match(writeTool, /const nowContent = nowExists \? await fs\.readFile/)
  assert.match(writeTool, /nowExists !== exists \|\| nowContent !== oldContent/)
})
check('при расхождении запись не выполняется', () => {
  const conflict = writeTool.slice(writeTool.indexOf('nowExists !== exists'))
  const stop = conflict.indexOf('snapshotBeforeWrite')
  assert.match(conflict.slice(0, stop), /return \{[\s\S]*success: false/)
  assert.match(conflict.slice(0, stop), /изменился, пока запись ждала подтверждения/)
})
check('проверка стоит до снимка, а не после', () => {
  assert.ok(writeTool.indexOf('nowContent !== oldContent') < writeTool.indexOf('snapshotBeforeWrite'),
    'снимок делается раньше проверки — в него попадёт устаревшее содержимое')
})

// --- безопасность отката --------------------------------------------------------
const undo = cut(main, "ipcMain.handle('undo-agent-changes'", '// Self-development')

check('снимок не удаляется после неудачного отката', () => {
  // Раньше папка снимка стиралась безусловно: одна ошибка доступа — и последняя
  // копия того, что агент затёр, исчезала навсегда.
  assert.match(undo, /snapshotKept = Boolean\(failed\.length \|\| conflicts\.length \|\| entries\.some\(entry => !entry\.undone\)\)/)
  assert.match(undo, /if \(!snapshotKept\) \{[\s\S]{0,120}fs\.rm\(root/)
})
check('откат не трогает файл, изменённый после агента', () => {
  assert.match(undo, /if \(entry\.wrote\)/)
  assert.match(undo, /contentFingerprint\(current\) !== entry\.wrote/)
  assert.match(undo, /conflicts\.push/)
})
check('в снимок записан отпечаток того, что оставил агент', () => {
  const snapshot = cut(main, 'async function snapshotBeforeWrite(', "ipcMain.handle('undo-agent-changes'")
  assert.match(snapshot, /wrote = next === undefined \? null : contentFingerprint\(next\)/)
  assert.match(snapshot, /action: 'created', wrote/)
  assert.match(snapshot, /action: 'updated', backup: name, wrote/)
})
check('окно сообщает о пропущенных файлах и не гасит кнопку', () => {
  assert.match(renderer, /result\.conflicts\?\.length/)
  assert.match(renderer, /if \(!result\.snapshotKept\) \{[\s\S]{0,120}msg\.undoId = undefined/)
})

// --- скрытый обрыв ответа ---------------------------------------------------------
const textStream = cut(main, 'async function streamChatOpenRouter(', '// Agent roster')

check('ошибка провайдера в потоке не тонет в пустом catch', () => {
  // Ошибка бросалась внутри того же try, чей catch был пуст: половина ответа,
  // тайм-аут — и ход возвращался как удачный.
  assert.match(textStream, /try \{ data = JSON\.parse\(jsonStr\) \} catch \{ continue \}/)
  const errorCheck = textStream.indexOf('if (data.error)')
  const guardedTry = textStream.indexOf('try {', errorCheck)
  assert.ok(errorCheck >= 0 && errorCheck < guardedTry,
    'проверка ошибки снова оказалась внутри try с пустым catch')
})
check('пустого catch без пояснения не осталось', () => {
  assert.doesNotMatch(textStream, /\} catch \(e\) \{\}/)
})

// --- обрезка истории ----------------------------------------------------------------
// Мерилом стал объём, а не число сообщений: сорок коротких реплик весят меньше
// одного прочитанного файла, и выбрасывать из них середину было незачем. Поэтому
// заготовки здесь тяжёлые, а бюджет передаётся явно — так видно, что именно
// проверяется.
// Бюджет объявлен внутри самого вырезанного куска, поэтому передавать его
// параметром нельзя — только оценщик объёма.
const trim = new Function('messagesRoughTokens',
  cut(main, 'const DEFAULT_HISTORY_BUDGET = 24000', 'function repairToolPairs(') + '\nreturn trimHistory')(
  list => (list || []).reduce((sum, m) => sum + Math.ceil(String(m?.content || '').length / 3.2), 0))

// Каждое сообщение весит под четыре сотни токенов, поэтому восемьдесят таких в бюджет
// не помещаются, а десять — помещаются.
const bulky = count => Array.from({ length: count },
  (_, i) => ({ role: 'assistant', content: ('шаг ' + i + ' ').padEnd(1200, 'x') }))

check('короткая переписка не трогается', () => {
  const short = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: String(i) }))
  assert.equal(trim(short), short)
})

check('переписка из многих коротких реплик тоже не трогается', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'реплика ' + i }))
  assert.equal(trim(many), many, 'середину выбросили там, где всё помещается')
})

check('задача переживает обрезку', () => {
  const long = [
    { role: 'system', content: 'инструкция' },
    { role: 'user', content: 'ИСХОДНАЯ ЗАДАЧА' },
    ...bulky(80)
  ]
  const out = trim(long)
  assert.ok(out.length < long.length, 'обрезка не сработала')
  assert.equal(out[0].content, 'инструкция')
  assert.equal(out[1].content, 'ИСХОДНАЯ ЗАДАЧА',
    'первый вопрос пользователя выброшен — модель перестала знать, что просили')
})

check('о выброшенной середине сказано прямо', () => {
  const long = [
    { role: 'system', content: 'инструкция' },
    { role: 'user', content: 'задача' },
    ...bulky(80)
  ]
  const out = trim(long)
  const note = out.find(m => /опущено сообщений/.test(m.content || ''))
  assert.ok(note, 'пропуск остался молчаливым: ' + JSON.stringify(out.slice(0, 4).map(m => m.role)))
  assert.equal(note.role, 'system')
  assert.match(note.content, /опущено сообщений: \d+/)
})

check('хвост сохранён целиком', () => {
  const long = [
    { role: 'system', content: 'инструкция' },
    { role: 'user', content: 'задача' },
    ...bulky(80)
  ]
  const out = trim(long)
  assert.equal(out[out.length - 1], long[long.length - 1],
    'последнее сообщение переписки не дошло до модели')
})

// --- пары вызовов инструментов ---------------------------------------------------------
const repair = new Function(
  cut(main, 'function repairToolPairs(', 'function buildSkillsSystemPrompt(') + '\nreturn repairToolPairs')()

check('результат без своего вызова отбрасывается', () => {
  const out = repair([
    { role: 'tool', tool_call_id: 'сирота', content: 'итог' },
    { role: 'user', content: 'вопрос' }
  ])
  assert.deepEqual(out.map(m => m.role), ['user'])
})

check('вызов без результата не остаётся висеть', () => {
  const out = repair([
    { role: 'assistant', content: 'смотрю', tool_calls: [{ id: 'x' }] },
    { role: 'user', content: 'дальше' }
  ])
  assert.ok(!out.some(m => m.tool_calls), 'повисший вызов сохранён — провайдер отклонит запрос')
  assert.ok(out.some(m => m.content === 'смотрю'), 'текст вызова потерян')
})

check('целая пара сохраняется', () => {
  const out = repair([
    { role: 'assistant', content: '', tool_calls: [{ id: 'x' }] },
    { role: 'tool', tool_call_id: 'x', content: 'итог' }
  ])
  assert.equal(out.length, 2)
})

check('сводка берёт задачу и чинит пары, а не режет вслепую', () => {
  const summarise = cut(main, 'async function summariseTurnSoFar(', 'async function runAgentSlot(')
  assert.match(summarise, /const firstUser = messages\.slice\(head\.length\)\.find\(m => m\.role === 'user'\)/)
  assert.match(summarise, /repairToolPairs\(messages\.slice\(/)
  assert.doesNotMatch(summarise, /messages\.slice\(1\)\.slice\(-24\)/,
    'вернулся слепой срез: запрос на сводку может уйти с половиной пары')
})

// --- индикатор контекста ------------------------------------------------------------------
check('занятость учитывает только что сгенерированный ответ', () => {
  const loop = cut(main, 'const stepPrompt = Number(stepResult.usage', 'if (stepResult.answeredModel')
  assert.match(loop, /contextTokens = stepPrompt \+ stepCompletion/)
  const text = cut(main, 'const promptTokens = Number(data.usage.prompt_tokens', 'if (data.model)')
  assert.match(text, /promptTokens \+ Number\(data\.usage\.completion_tokens/)
})

// --- инструменты --------------------------------------------------------------------------
check('созданный инструмент становится вызываемым в том же ходе', () => {
  // Ответ на создание обещает «доступен со следующего шага», а список
  // инструментов собирался один раз за ход — и следующий вызов отвергался.
  assert.match(main, /const buildToolList = async \(\)/)
  assert.match(main, /toolName === 'define_tool' \|\| toolName === 'add_mcp_server'/)
  assert.match(main, /allTools = await buildToolList\(\)/)
  assert.doesNotMatch(main, /^  const allTools = \(design/m, 'набор снова неизменяем на весь ход')
})

check('ошибка MCP не выдаётся за успех', () => {
  const mcp = cut(main, 'async function executeMcpTool(', 'async function executeTool(')
  assert.match(mcp, /if \(result && result\.isError\)/)
  const errorBranch = mcp.slice(mcp.indexOf('result.isError'))
  assert.match(errorBranch.slice(0, 400), /success: false/)
})

// --- Design: замечание к элементу -------------------------------------------------------------
check('window.prompt в окне не используется', () => {
  // Electron его не поддерживает: вызов ничего не показывает и возвращает null,
  // поэтому «Замечание» исчезало молча — режим выбора уже выключен, окна нет.
  assert.doesNotMatch(renderer, /window\.prompt\(/)
})
check('своя форма ввода есть в разметке и в коде', () => {
  assert.match(html, /id="promptModal"/)
  assert.match(html, /id="promptInput"/)
  assert.match(renderer, /function askText\(/)
  assert.match(renderer, /askText\('Что поправить в этом элементе\?'/)
})
check('замечание не уходит в чужой дизайн', () => {
  assert.match(renderer, /activeDesign\?\.id !== design\.id\) return/)
})

// --- статус хода ------------------------------------------------------------------------------
check('вместо номера шага показывается происходящее', () => {
  assert.doesNotMatch(main, /message: step === 0 \? 'Анализ задачи…' : `Шаг \$\{step \+ 1\}`/)
  // И не «Ожидаю ответ модели…»: это шло на каждом шаге и возвращало
  // строку агента к ожиданию после каждого сделанного дела. Шаг — это факт,
  // он идёт отдельным полем и ничего не затирает.
  assert.doesNotMatch(main, /'Ожидаю ответ модели…'/)
  assert.match(main, /phase: 'step',[\s\S]{0,60}step: step \+ 1/)
  assert.match(renderer, /if \(event\?\.phase === 'step'\)/)
})
check('вызов инструмента описан словами', () => {
  const describe = new Function(
    cut(main, 'const TOOL_VERBS = {', 'async function executeMcpTool(') + '\nreturn describeToolCall')()
  assert.equal(describe('read_file', { path: 'src/main.js' }), 'Читаю: src/main.js')
  assert.equal(describe('write_file', { path: 'a.txt' }), 'Пишу: a.txt')
  assert.equal(describe('dc_check', {}), 'Проверяю превью')
  assert.match(describe('mcp_github_search', { query: 'x' }), /внешнему серверу/)
  assert.match(describe('own_deploy', {}), /свой инструмент deploy/)
  assert.doesNotMatch(describe('read_file', { path: 'a' }), /Вызов:/)
})

// --- правка на ходу ----------------------------------------------------------------------------
check('сообщение во время хода встаёт в очередь, а не пропадает', () => {
  const send = cut(renderer, 'async function handleSendMessage(pane, rawText, {', 'const turnModel =')
  assert.match(send, /pane\.queuedMessage = text/)
  assert.match(send, /Уточнение уйдёт/)
  assert.doesNotMatch(send, /if \(!text \|\| pane\.generating \|\| pane\.preparing\) return/,
    'сообщение снова молча отбрасывается')
})
check('очередь уходит после хода и только в тот же чат', () => {
  assert.match(renderer, /if \(pane\.queuedMessage && pane\.chatId === chat\.id\)/)
  assert.match(renderer, /handleSendMessage\(pane, queued\)/)
})
check('ожидающее уточнение видно в окне', () => {
  assert.match(renderer, /function renderQueuedNotice\(pane\)/)
  assert.match(renderer, /После ответа: /)
})

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
