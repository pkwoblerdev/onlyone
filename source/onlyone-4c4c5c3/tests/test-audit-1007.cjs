// Регрессии аудита 07.10.2026, которые проверяются без окна.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

let failed = 0
function test (name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '—', error.message) }
}

// ── 1. Команда агентов: «~vendor/…-latest» — настоящие id каталога ───────────────
test('команда агентов принимает id-псевдонимы каталога «~вендор/имя-latest»', () => {
  const { sanitizeAgentTeam } = require('../src/main/agent-team.cjs')
  const team = sanitizeAgentTeam({ count: 3, models: ['~anthropic/claude-fable-latest', 'openai/gpt-5:free'] })
  assert.deepEqual(team.models, ['~anthropic/claude-fable-latest', 'openai/gpt-5:free'])
  assert.equal(sanitizeAgentTeam({ models: ['../etc/passwd'] }).models.length, 0, 'мусор по-прежнему отсекается')
  assert.equal(sanitizeAgentTeam({ models: ['~/x'] }).models.length, 0, 'тильда без вендора — не id')
})

test('все id из кэша каталога проходят проверку команды агентов', () => {
  const sample = ['~deepseek/deepseek-pro-latest', '~openai/gpt-astra-latest', '~z-ai/glm-latest', 'inception/mercury-decide:free',
    'meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-235b-a22b-2507']
  const { sanitizeAgentTeam } = require('../src/main/agent-team.cjs')
  const kept = sanitizeAgentTeam({ models: sample }).models
  assert.deepEqual(kept, sample)
})

// ── 2. Названная модель: «не чат-модель» — только про настоящую не-чат-модель ───
test('метаданные модели различают чат-модель, помощника по решениям и чужой тип', () => {
  const { describeModelMeta, explainMissingModel } = require('../src/main/decisions.cjs')
  const chat = describeModelMeta({ data: { id: 'acme/new-chat', name: 'New Chat', architecture: { output_modalities: ['text'] } } })
  assert.equal(chat.chat, true)
  assert.equal(chat.decision, false)
  const decide = describeModelMeta({ data: { id: 'inception/mercury-decide:free', name: 'Mercury Decide', architecture: { output_modalities: ['decisions'] } } })
  assert.equal(decide.decision, true)
  assert.equal(decide.chat, false)
  const image = describeModelMeta({ data: { id: 'acme/painter', architecture: { output_modalities: ['image'] } } })
  assert.equal(image.chat, false)
  assert.equal(image.decision, false)
  assert.equal(typeof explainMissingModel, 'function')
  assert.equal(explainMissingModel(chat).kind, 'chat-not-in-catalog', 'настоящая чат-модель — не «не чат-модель»')
  assert.equal(explainMissingModel(decide).kind, 'decision')
  assert.equal(explainMissingModel(image).kind, 'not-chat')
  assert.equal(explainMissingModel({ found: false }).kind, 'missing')
  assert.equal(explainMissingModel({ found: null }).kind, 'unknown', 'сеть не ответила — не выдавать это за «нет в каталоге»')
})

// ── 3. Английский: каждая русская строка t()/L() имеет перевод, переводы без кириллицы ──
test('каждая русская строка в t()/L() окна есть в английском словаре', () => {
  const dir = path.join(root, 'src/renderer')
  const win = {}
  new Function('window', read('src/renderer/i18n.js'))(win)
  const en = win.__I18N__.en
  const norm = s => s.replace(/\s+/g, ' ').trim()
  const missing = []
  const calls = /(?<![A-Za-z0-9_$.])(t|L|tr)\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g
  for (const file of fs.readdirSync(dir)) {
    if (!/\.js$/.test(file) || file === 'i18n.js') continue
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
    for (const m of src.matchAll(calls)) {
      let s = m[3].replace(/\\n/g, ' ').replace(/\\'/g, "'").replace(/\\"/g, '"')
      if (m[2] === '`' && s.includes('${')) continue
      s = norm(s)
      if (!/[А-Яа-яЁё]/.test(s) || s in en) continue
      missing.push(file + ': ' + s.slice(0, 60))
    }
  }
  assert.deepEqual(missing, [])
})

test('английские переводы не содержат кириллицы', () => {
  const win = {}
  new Function('window', read('src/renderer/i18n.js'))(win)
  const bad = Object.entries(win.__I18N__.en).filter(([, v]) => /[А-Яа-яЁё]/.test(v)).map(([k]) => k.slice(0, 60))
  assert.deepEqual(bad, [])
})

test('подписи, собранные кодом без t(), заведены в словарь: «осталось», «недоступна», «моделей»', () => {
  const win = {}
  new Function('window', read('src/renderer/i18n.js'))(win)
  const en = win.__I18N__.en
  for (const key of ['осталось %s', 'недоступна', 'Развернуть боковую панель', 'Изменено %s', 'модель', 'моделей', 'ошибка']) {
    assert.ok(key in en, `нет перевода «${key}»`)
  }
  const app = read('src/renderer/app.js')
  assert.ok(!/\$\{filtered\.length\} моделей/.test(app), 'счётчик моделей собран без перевода и без склонения')
  assert.ok(!/`осталось \$\{/.test(app), '«осталось …» собрано без t()')
})

// ── 4. Токены: у каждого var(--x) без запасного значения есть определение ───────
test('в CSS нет var(--токен) без определения и без запасного значения', () => {
  const dir = path.join(root, 'src/renderer')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.css'))
  const defined = new Set()
  const texts = files.map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')])
  for (const [, t] of texts) for (const m of t.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1])
  for (const f of fs.readdirSync(dir).filter(f => /\.(js|html)$/.test(f))) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const m of t.matchAll(/setProperty\(\s*['"](--[A-Za-z0-9_-]+)/g)) defined.add(m[1])
    for (const m of t.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1])
  }
  const undefinedVars = []
  for (const [f, t] of texts) {
    for (const m of t.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g)) {
      if (!defined.has(m[1]) && m[2] === ')') undefinedVars.push(`${f}: ${m[1]}`)
    }
  }
  assert.deepEqual([...new Set(undefinedVars)], [])
})

// ── 5. Склейка проходов хода не должна слипать слова ────────────────────────────
test('граница прохода хода отделяется пустой строкой, обычные куски остаются встык', () => {
  const { joinStreamChunk } = require('../src/main/stream-join.js')
  assert.equal(joinStreamChunk('Первый ответ.', 'Второй.', true), '\n\nВторой.')
  assert.equal(joinStreamChunk('Первый ответ.\n', 'Второй.', true), '\nВторой.')
  assert.equal(joinStreamChunk('', 'Второй.', true), 'Второй.')
  assert.equal(joinStreamChunk('Перв', 'ый', false), 'ый', 'куски одного потока не разделяются')
})

test('каждый новый шаг цикла агента ставит границу перед своим первым текстом', () => {
  const src = read('src/main/main.js')
  const at = src.indexOf('for (let step = 0; step < MAX_AGENT_STEPS; step++) {')
  assert.ok(at > 0, 'цикл шагов агента не найден')
  const head = src.slice(at, at + 900)
  assert.match(head, /stepBoundaryPending = true/, 'текст нового шага клеится к тексту прошлого встык: «…заглушкиОТВЕТ…»')
})

// ── 6. Расход токенов: диета инструментов не читает служебные реплики приложения ─
test('диета инструментов пропускает реплики, вставленные самим приложением', () => {
  const { userTexts, GROUPS, SYNTHETIC, slimTools } = require('../src/main/tool-diet.cjs')
  const human = { role: 'user', content: 'Привет' }
  const auto = { [SYNTHETIC]: true, role: 'user', content: 'Твоя часть: открой файлы и проверь инструмент, отчёт сдай' }
  assert.deepEqual(userTexts([human, auto]), ['Привет'])
  assert.deepEqual(userTexts([human, { role: 'user', content: 'открой файлы' }]), ['Привет', 'открой файлы'], 'обычные реплики читаются')
  assert.deepEqual(userTexts([human, { ...auto }]), ['Привет'], 'копия реплики сохраняет признак')
  assert.equal(JSON.stringify(auto).includes('synthetic'), false, 'признак не уходит провайдеру')
  const names = GROUPS.flatMap(group => group.names)
  const tools = names.map(name => ({ function: { name } }))
  const quiet = slimTools(tools, { texts: userTexts([human, auto]) }).map(tool => tool.function.name)
  assert.deepEqual(quiet.filter(name => /browse|watch|define_tool|show_artifact/.test(name)), [], 'слова приложения включили браузер, свои инструменты и артефакты')
})

test('все места, где приложение вставляет реплику user в поручение, помечены как служебные', () => {
  const src = read('src/main/main.js')
  assert.ok((src.match(/\[Symbol\.for\('onlyone\.synthetic'\)\]: true/g) || []).length >= 4, 'поручения помощникам, критика, приёмка и круг ведущего')
})

// ── 7. Расход токенов: одно и то же замечание не отправляется заново, пока ход стоит на месте ──
test('доработка не повторяет то же замечание, если ход после прошлой не сделал ни одного вызова', () => {
  const { createCycle, planRework } = require('../src/main/agent-cycle.js')
  const cycle = createCycle({})
  const gaps = ['пункт t1 (Агент 2) никто не взял']
  const first = planRework(cycle, { gaps, tools: 3 })
  assert.equal(first.continue, true)
  const previous = { key: first.key, tools: first.tools }
  const again = planRework(cycle, { gaps, tools: 3, previous })
  assert.equal(again.continue, false)
  assert.equal(again.stalled, true, 'остановка названа остановкой, а не исчерпанным бюджетом')
  assert.equal(again.exhausted, true)
  assert.equal(cycle.left('reworks'), cycle.limits.reworks - 1, 'остановка не тратит бюджет')
  assert.equal(planRework(cycle, { gaps, tools: 4, previous }).continue, true, 'новый вызов — это движение')
  assert.equal(planRework(cycle, { gaps: ['другое замечание'], tools: 3, previous }).continue, true, 'другое замечание — не повтор')
})

test('главный цикл передаёт доработке память о прошлой попытке и говорит об остановке вслух', () => {
  const src = read('src/main/main.js')
  assert.match(src, /planRework\(cycle, \{[\s\S]{0,400}previous: reworkMemory/, 'память прошлой доработки не передаётся')
  assert.match(src, /reworkMemory = \{ key: rework\.key, tools: rework\.tools \}/)
  assert.match(src, /Приёмка повторила то же замечание/)
})

if (failed) { console.error(`\nне прошло: ${failed}`); process.exit(1) }
console.log('\nаудит 07.10 (без окна): всё прошло')
