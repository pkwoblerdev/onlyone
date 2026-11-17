// Вопрос пользователю прямо в переписке.
//
// Промпт дизайна полгода обещал модели инструмент `ask_user`, которого не было:
// модель звала его, получала «инструмента нет» и дальше решала молча — ровно то
// поведение, на которое жаловались («выбрал сам и не сказал»). Здесь проверяется
// не текст обещания, а цепочка целиком: схема, исполнение, карточка в окне,
// ответ обратно и что происходит, когда никто не отвечает.
//
// Главное правило, которое легко потерять при следующей правке: спросить — не
// значит изменить. Поэтому вопрос доступен и в обычной переписке, и в команде,
// и в дизайне, и помощнику с доступом только на чтение.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr

const root = path.join(__dirname, '..')
// Исходники лежат с CRLF, а образцы здесь пишутся обычными переводами строк:
// без приведения любой многострочный поиск молча ничего не находит.
const CR = String.fromCharCode(13)
const read = (...parts) =>
  fs.readFileSync(path.join(root, ...parts), 'utf8').split(CR).join('')
const main = read('src', 'main', 'main.js')
const preload = read('src', 'preload', 'preload.js')
const renderer = read('src', 'renderer', 'app.js')
const quality = read('src', 'main', 'agent-quality.js')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + error.message) }
}

// --- инструмент объявлен и объявлен честно ---------------------------------------

check('инструмент объявлен моделям', () => {
  const at = main.indexOf("name: 'ask_user'")
  assert.ok(at > 0, 'ask_user нет среди инструментов')
  const schema = main.slice(at, at + 3000)
  assert.ok(/required: \['question', 'options'\]/.test(schema), 'вопрос и варианты должны быть обязательными')
  assert.ok(/colors/.test(schema) && /svg/.test(schema), 'вариант должен уметь нести палитру и набросок')
})

check('описание говорит, что ход останавливается', () => {
  const at = main.indexOf("name: 'ask_user'")
  const schema = main.slice(at, at + 3000)
  // Иначе модель спрашивает на каждой мелочи и человек сидит на карточках.
  assert.ok(/ход стоит/.test(schema), 'модель должна знать цену вопроса')
  assert.ok(/сделай всё, что от ответа не зависит/.test(schema), 'сначала независимая работа, потом вопрос')
})

// --- сама функция ----------------------------------------------------------------

const cut = (from, to) => {
  const a = main.indexOf(from)
  const b = main.indexOf(to, a)
  assert.ok(a >= 0 && b > a, 'не найдено: ' + from)
  return main.slice(a, b)
}

// Настоящие функции из main.js, а не их пересказ. Отправку события хода тоже
// берут настоящую: с подставкой песочница не отличила бы «окно живо» от «окно
// уничтожено», а это ровно то, что теперь держит ход.
const sandbox = new Function('crypto', 'APPROVAL_TIMEOUT_MS', 'pendingQuestions', `
  ${cut('function sendToWindow(event, channel, body)', 'async function runAgentMode(')}
  ${cut('const COLOR_ONLY =', '\n\nfunction ')}
  ${cut('function normalizeAskOptions(raw)', 'async function askUser')}
  ${cut('async function askUser(event, args, requestId, signal = null)', '\n\n// Plan mode refuses')}
  return { askUser, normalizeAskOptions }
`)

const pendingQuestions = new Map()
const { askUser, normalizeAskOptions } = sandbox(
  { randomUUID: () => 'q' + (pendingQuestions.size + 1) }, 50, pendingQuestions)

const windowOf = () => {
  const sent = []
  return { sent, sender: { send: (channel, body) => sent.push({ channel, body }), isDestroyed: () => false } }
}

check('вариант без названия отбрасывается целиком', () => {
  const clean = normalizeAskOptions([{ label: 'Светлая' }, { label: '   ' }, { detail: 'без названия' }])
  assert.strictEqual(clean.length, 1)
})

check('в палитру проходит только цвет', () => {
  const [option] = normalizeAskOptions([
    { label: 'Тёплая', colors: ['#ff8800', 'rgb(10, 20, 30)', 'url(javascript:alert(1))', 'red; position:fixed'] },
    { label: 'Холодная' }
  ])
  assert.deepStrictEqual(option.colors, ['#ff8800', 'rgb(10, 20, 30)'])
})

check('вариантов не больше шести', () => {
  const many = normalizeAskOptions(Array.from({ length: 12 }, (_, i) => ({ label: 'Вариант ' + i })))
  assert.strictEqual(many.length, 6)
})

// --- цепочка вопрос → ответ -------------------------------------------------------

const asked = async () => {
  const one = windowOf()
  const promise = askUser(one, {
    question: 'Какое направление?',
    asker: 'Агент 3',
    options: [{ label: 'Строгое' }, { label: 'Праздничное' }]
  }, 'r2')
  await new Promise(resolve => setImmediate(resolve))
  return { one, promise }
}

const scenarios = []

scenarios.push(['ответ одному участнику не снимает ожидание остальных', async () => {
  const first = await asked(), second = await asked()
  const firstId = first.one.sent[0].body.id, secondId = second.one.sent[0].body.id
  pendingQuestions.get(firstId).resolve('A'); pendingQuestions.delete(firstId)
  await first.promise
  assert.strictEqual(first.one.sent.at(-1).body.awaitingApproval, true)
  pendingQuestions.get(secondId).resolve('B'); pendingQuestions.delete(secondId)
  await second.promise
  assert.strictEqual(second.one.sent.at(-1).body.awaitingApproval, false)
}])

scenarios.push(['ответ принимает только исходное окно и только непустой', async () => {
  let handler
  new Function('ipcMain', 'pendingQuestions',
    cut("ipcMain.handle('resolve-agent-question'", "ipcMain.handle('resolve-agent-approval'"))(
      { handle: (_, fn) => { handler = fn } }, pendingQuestions)
  const { one, promise } = await asked()
  const id = one.sent.find(item => item.channel === 'agent-question').body.id
  await assert.rejects(handler({ sender: {} }, { id, answer: 'Да' }), /другому окну/)
  await assert.rejects(handler(one, { id, answer: ' ' }), /пустым/)
  assert.ok(pendingQuestions.has(id), 'неверный ответ не должен закрыть вопрос')
  await handler(one, { id, answer: ' Строгое ' })
  assert.strictEqual((await promise).answer, 'Строгое')
  await assert.rejects(handler(one, { id, answer: 'Да' }), /больше не ждёт/)
}])

scenarios.push(['вопрос без вариантов не задаётся', async () => {
  const one = windowOf()
  const result = await askUser(one, { question: 'Как лучше?', options: [{ label: 'Так' }] }, 'r1')
  assert.strictEqual(result.success, false)
  assert.ok(/два различимых варианта/.test(result.error))
  assert.strictEqual(one.sent.length, 0, 'ничего не должно было уйти в окно')
}])

scenarios.push(['карточка уходит в окно и ход объявляет ожидание', async () => {
  const { one, promise } = await asked()
  const card = one.sent.find(item => item.channel === 'agent-question')
  assert.ok(card, 'карточка не отправлена')
  assert.strictEqual(card.body.asker, 'Агент 3', 'человек должен видеть, кто именно спрашивает')
  assert.strictEqual(card.body.options.length, 2)
  const waiting = one.sent.find(item => item.channel === 'agent-event' && item.body.awaitingApproval === true)
  assert.ok(waiting, 'без этого ход выглядит зависшим, а не спрашивающим')

  pendingQuestions.get(card.body.id).resolve('Праздничное')
  pendingQuestions.delete(card.body.id)
  const result = await promise
  assert.strictEqual(result.answered, true)
  assert.strictEqual(result.answer, 'Праздничное')
  const closed = one.sent.filter(item => item.channel === 'agent-event').at(-1)
  assert.strictEqual(closed.body.awaitingApproval, false, 'ожидание должно сниматься')
}])

scenarios.push(['молчание не вешает ход, а возвращает решение модели', async () => {
  const { one, promise } = await asked()
  const result = await promise
  assert.strictEqual(result.success, true)
  assert.strictEqual(result.answered, false)
  assert.ok(/не согласие/.test(result.message), 'молчание не даёт разрешения действовать')
  assert.ok(/второй раз не задавай/.test(result.message), 'иначе следующий ход начнётся тем же вопросом')
  assert.strictEqual(one.sent.filter(item => item.channel === 'agent-question' && !item.body.closed).length, 1)
}])

// --- доступность -----------------------------------------------------------------

check('вопрос исполняется раньше запрета инструментов дизайна', () => {
  const body = cut('async function executeTool(event, name, args, requestId, design = null, signal = null)', 'if (name === \'list_files\')')
  const ask = body.indexOf("name === 'ask_user'")
  const designGate = body.indexOf('В разделе «Дизайн» инструмент')
  assert.ok(ask > 0, 'ask_user не исполняется')
  assert.ok(ask < designGate, 'в дизайне вопрос отсекался бы общим запретом')
})

check('вопрос есть в наборе дизайна', () => {
  const lists = main.match(/'read_guide', 'task_plan', 'ask_user'/g) || []
  assert.strictEqual(lists.length, 2, 'оба набора инструментов дизайна должны содержать вопрос')
})

check('спрашивать может и помощник с доступом только на чтение', () => {
  assert.ok(/'read_guide', 'task_plan', 'ask_user'/.test(quality),
    'вопрос ничего не меняет, отбирать его у проверяющего незачем')
})

check('ведущий и помощник знают про вопрос', () => {
  // Брифы — данными в ./mode-prompts/team.js (план, 6.2).
  const team = require('../src/main/mode-prompts/team')
  const lead = team.leadBrief(2, '')
  const helper = team.helperBrief(3, 'проверить часть')
  assert.ok(/ask_user/.test(lead), 'ведущий не знает, что может спросить')
  assert.ok(/ask_user/.test(helper), 'помощник не знает, что может спросить')
  assert.ok(/asker/.test(helper), 'иначе человек не поймёт, кто из агентов спрашивает')
})

check('очередь больше не обещана брифу ведущего', () => {
  const lead = require('../src/main/mode-prompts/team').leadBrief(2, '')
  assert.ok(!/выполняют назначения последовательно/.test(lead),
    'фраза из времён очереди отменяла абзац про одновременную работу')
})

// --- мост и окно -------------------------------------------------------------------

check('мост проводит вопрос в обе стороны', () => {
  assert.ok(/onAgentQuestion: callback =>/.test(preload), 'окно не услышит вопрос')
  assert.ok(/ipcRenderer\.on\('agent-question'/.test(preload))
  assert.ok(/resolveAgentQuestion: answer => ipcRenderer\.invoke\('resolve-agent-question'/.test(preload),
    'ответ не дойдёт обратно')
})

check('главный процесс принимает ответ', () => {
  assert.ok(/ipcMain\.handle\('resolve-agent-question'/.test(main))
  assert.ok(/Этот вопрос больше не ждёт ответа/.test(main), 'повторный ответ должен объясняться словами')
})

check('окно рисует карточку и подпись спрашивающего', () => {
  assert.ok(/onAgentQuestion\?\.\(request =>/.test(renderer))
  assert.ok(/ask-asker/.test(renderer), 'без подписи непонятно, кто из агентов спросил')
  assert.ok(/resolveAgentQuestion\(\{ id: request\.id, answer: text \}\)/.test(renderer))
})

check('набросок принимается только безопасный', () => {
  const at = renderer.indexOf('const sketch = svg =>')
  const body = renderer.slice(at, at + 600)
  assert.ok(/<script\|javascript:/.test(body), 'скрипты и внешние ссылки должны отбрасываться')
})

check('закрытое окно и отменённый ход не оставляют висящих вопросов', () => {
  // Маркер без списка параметров: у отклонения появился идентификатор окна, и
  // текст якоря не должен краснить соседний набор из-за выросшей сигнатуры.
  const reject = cut('function rejectPendingApprovals(', '// Plan mode refuses')
  assert.ok(/pendingQuestions/.test(reject), 'уничтоженное окно не ответит никогда')
  const abort = cut("ipcMain.handle('abort-message'", 'Under the smoke test')
  assert.ok(/pendingQuestions/.test(abort), 'отменённый ход оставлял бы карточку, которая никого не ждёт')
})

;(async () => {
  for (const [name, fn] of scenarios) {
    total++
    try { await fn() } catch (error) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + error.message) }
  }
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
})()
