// Три дефекта, воспроизведённые аудитом 0.86.0 и исправленные в 0.87.0.
//
// Раньше на их месте лежал диагностический скрипт, который эти дефекты
// показывал и выходил с кодом 1. Показывать больше нечего, а вот сторожить
// есть что: каждый из трёх — про молчаливый успех, то есть ровно про то, что
// пользователь замечает последним.
//
// Проверяется поведение, а не текст исходника: куски main.js достаются и
// запускаются с подставным окружением, без сети и без пользовательских данных.
const fs = require('node:fs')
const path = require('node:path')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr

const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')

// Отправка события хода — та же, что в главном процессе: вырезанные функции зовут
// её, а подставка молчала бы и на уничтоженном окне.
const GUARD_SRC = (() => {
  const a = source.indexOf('function sendToWindow(event, channel, body) {')
  const b = source.indexOf('async function runAgentMode(', a)
  if (a < 0 || b < a) throw new Error('не найдена точка отправки хода в main.js')
  return source.slice(a, b)
})()

function extract(start, end, deps) {
  const a = source.indexOf(start)
  const b = source.indexOf(end, a + start.length)
  if (a < 0 || b < 0) throw new Error('не найдена граница фрагмента: ' + start)
  const name = /function (\w+)/.exec(start)[1]
  return new Function(...Object.keys(deps),
    GUARD_SRC + '\n' + source.slice(a, b) + '\nreturn ' + name)(...Object.values(deps))
}

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// Настоящий склеиватель продолжений, а не заглушка: шов — половина смысла этой
// правки, и проверять его подделкой было бы проверкой подделки.
const seamModule = new Function('SEAM_LOOKAHEAD',
  source.slice(source.indexOf('function seamOverlap('), source.indexOf('async function runAgentLoop(')) +
  '\nreturn { seamOverlap, trimContinuation }')(400)

// ---------------------------------------------------------------------------
// 1. Обрезанный ответ в ветке без инструментов
// ---------------------------------------------------------------------------
// Ответ, упёршийся в предел длины, возвращался как ok:true. Половина фразы
// приходила пользователю как готовый ответ, и об обрыве не говорилось ничего.

// Настоящее чтение куска со сроком, а не заглушка: срок и есть то, чего
// ожиданию не хватало, и подменять его здесь значило бы проверять пустоту.
const readWithIdleTimeout = extract(
  'function readWithIdleTimeout(', '// Writes every SSE frame', { STREAM_IDLE_MS: 180000 })

async function streamCase({ passes, maxContinuations = 4 }) {
  let call = 0
  const stream = extract('async function streamChatOpenRouter(', '// Agent roster', {
    DEFAULT_MODEL: 'test',
    sanitizeMessages: x => x,
    buildSystemPrompt: () => 'rules',
    lastUserMessage: p => (p.messages || []).filter(m => m.role === 'user').pop()?.content || '',
    isTrivialMessage: () => false,
    buildModelChain: x => [x],
    applyModelParams: () => {},
    applyFilePlugin: () => {},
    modelBudget: () => 100000,
    SEAM_LOOKAHEAD: 400,
    MAX_ANSWER_CONTINUATIONS: maxContinuations,
    trimContinuation: seamModule.trimContinuation,
    readWithIdleTimeout,
    // Бюджета в этой проверке нет: допуск на отправку не нужен.
    createAttemptGuard: () => null,
    openRouterRequest: async () => new Response(passes[Math.min(call++, passes.length - 1)])
  })
  const events = []
  const result = await stream(
    { sender: { send: (name, data) => events.push({ name, data }) } },
    { model: 'test', messages: [], requestId: 'isolated' },
    undefined,
    new AbortController().signal)
  return { result, events, calls: call }
}

const chunk = (text, finish) =>
  'data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish || null }] }) + '\n\n' +
  'data: [DONE]\n\n'

async function run() {
  // Провайдер, замолчавший на середине ответа, выглядел как долго думающая
  // модель: сокет открыт, значит ждём. Ждать можно было до общего предела
  // запроса, и на экране это ровно то, что показал пользователь, — текст,
  // застывший на половине слова, при живом на вид ходе.
  {
    const silent = { read: () => new Promise(() => {}), cancel: () => {} }
    let message = ''
    try {
      await readWithIdleTimeout(silent, 60)
    } catch (error) {
      message = String(error && error.message)
    }
    check('молчащий поток обрывается по сроку', /idle timeout/.test(message), message || '(не оборвался)')
    // Слово в тексте не украшение: по нему восстановление узнаёт обрыв.
    check('обрыв по сроку опознаётся как обрыв, а не как ошибка запроса',
      /idle timeout|timed?\s*out/i.test(message), message)

    const alive = { read: async () => ({ done: true, value: undefined }), cancel: () => {} }
    const got = await readWithIdleTimeout(alive, 60)
    check('живой поток срок не трогает', got && got.done === true)
  }

  const carried = await streamCase({
    passes: [chunk('Первая половина ответа', 'length'), chunk(', и вот вторая половина.', 'stop')]
  })
  check('обрезанный ответ подхватывается, а не выдаётся за готовый',
    carried.calls === 2, 'запросов: ' + carried.calls)
  check('обе половины оказались в ответе',
    /Первая половина ответа, и вот вторая половина\./.test(carried.result.content),
    JSON.stringify(carried.result.content))
  check('о продолжении сказано в ленте событий',
    carried.events.some(e => e.name === 'agent-event' && /предел длины/.test(e.data.message)))

  // Модель примерно в половине случаев начинает продолжение с той же фразы, на
  // которой её оборвали. Склеенный ответ не должен заикаться.
  const stutter = await streamCase({
    passes: [chunk('Соединение принимает', 'length'), chunk('Соединение принимает запросы.', 'stop')]
  })
  check('повторённая фраза не задваивается на шве',
    stutter.result.content === 'Соединение принимает запросы.',
    JSON.stringify(stutter.result.content))

  // Короткое продолжение целиком помещается в придержанный буфер и склеивается
  // в конце потока. Длинное — переливается через край и склеивается прямо в
  // ходе передачи. Это разные ветки, и проверять надо обе.
  const tail = 'соединение принимает запросы'
  const long = await streamCase({
    passes: [
      chunk('Начало длинного ответа. ' + tail, 'length'),
      chunk(tail + ', пока не закончится очередь. ' + 'дальше идёт длинный текст. '.repeat(30), 'stop')
    ]
  })
  check('длинное продолжение тоже не заикается',
    long.result.content.indexOf(tail) === long.result.content.lastIndexOf(tail),
    JSON.stringify(long.result.content.slice(0, 120)))
  check('длинное продолжение дошло целиком',
    /пока не закончится очередь/.test(long.result.content) &&
    long.result.content.trim().endsWith('дальше идёт длинный текст.'),
    JSON.stringify(long.result.content.slice(-60)))

  // Предел продолжений существует, и на нём молчать нельзя.
  const endless = await streamCase({ passes: [chunk('Бесконечность', 'length')], maxContinuations: 2 })
  check('продолжения ограничены', endless.calls === 3, 'запросов: ' + endless.calls)
  check('на исчерпанном пределе об обрыве сказано вслух',
    /Ответ обрывается/.test(endless.result.content), JSON.stringify(endless.result.content))

  // Обычный ответ не должен платить ни одним лишним запросом.
  const plain = await streamCase({ passes: [chunk('Короткий ответ.', 'stop')] })
  check('законченный ответ не порождает второго запроса', plain.calls === 1, 'запросов: ' + plain.calls)
  check('законченный ответ дошёл целиком', plain.result.content === 'Короткий ответ.')

  // Когда весь предел длины уходит на размышления, продолжение просит ответ без
  // них. Тело запроса при этом переиспользуется, а applyModelParams только
  // присваивает — прежнее значение пережило бы вызов, и второй заход упёрся бы
  // ровно в тот же предел.
  const params = extract('function applyModelParams(', 'async function fetchOpenRouterModels(', {
    findModelRecord: () => ({ supportsReasoning: true, supportedEfforts: ['high', 'low'] }),
    resolveEffort: (model, requested) => (!requested || requested === 'off') ? null : 'high',
    requestedMaxTokens: () => 4000
  })
  const body = { model: 'x', models: ['x'] }
  params(body, 'x', 'max')
  check('глубина попадает в запрос', Boolean(body.reasoning))
  params(body, 'x', 'off')
  check('повторный вызов действительно снимает размышления',
    body.reasoning === undefined, JSON.stringify(body.reasoning))

  // ---------------------------------------------------------------------------
  // 2. Середина переписки
  // ---------------------------------------------------------------------------
  // Мерилом было число сообщений: на сорок первом середина выбрасывалась, каким
  // бы крошечным ни был разговор. Ограничение, названное пользователем в
  // середине, исчезало без всякой нужды.
  const trim = extract('function trimHistory(', '// Пара «вызов инструмента', {
    DEFAULT_HISTORY_BUDGET: 24000,
    messagesRoughTokens: list => (list || []).reduce((sum, m) =>
      sum + Math.ceil(String(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '')).length / 3.2), 0)
  })

  const short = Array.from({ length: 55 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'сообщение ' + i }))
  short[4].content = 'ОГРАНИЧЕНИЕ_ПОЛЬЗОВАТЕЛЯ'
  const keptShort = trim(short)
  check('короткая переписка из 55 сообщений не режется',
    keptShort.length === short.length, 'осталось: ' + keptShort.length)
  check('ограничение из середины на месте',
    JSON.stringify(keptShort).includes('ОГРАНИЧЕНИЕ_ПОЛЬЗОВАТЕЛЯ'))

  // Но объём по-прежнему имеет предел, и переполненная переписка режется.
  const heavy = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(5000) }))
  heavy.unshift({ role: 'system', content: 'правила' })
  const keptHeavy = trim(heavy)
  check('тяжёлая переписка всё же режется', keptHeavy.length < heavy.length,
    'осталось: ' + keptHeavy.length + ' из ' + heavy.length)
  check('начало разговора сохраняется', keptHeavy[0].role === 'system')
  check('о выброшенной середине сказано прямо',
    keptHeavy.some(m => /опущено сообщений/.test(String(m.content || ''))))
  check('последняя просьба остаётся всегда',
    keptHeavy[keptHeavy.length - 1] === heavy[heavy.length - 1])

  // Один огромный последний вопрос не должен обнулить переписку целиком.
  const giant = [{ role: 'user', content: 'x'.repeat(400000) }, { role: 'assistant', content: 'ответ' }]
  check('переписка не схлопывается в пустоту', trim(giant).length >= 2, String(trim(giant).length))

  // ---------------------------------------------------------------------------
  // 3. Полуготовое окно
  // ---------------------------------------------------------------------------
  // Разметка появляется сразу, а обработчики — в конце длинной асинхронной
  // инициализации. Снаружи эти два состояния неотличимы, и Enter в поле ввода до
  // подключения обработчика вызывал настоящую отправку формы: попытку увести
  // страницу. Спасала политика безопасности, единственным следом была её ругань
  // в консоли, а нажатие пропадало молча.
  const ui = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8')
  const flow = fs.readFileSync(path.join(__dirname, 'design-flow-renderer.js'), 'utf8')

  // Порядок сравнивается внутри самой инициализации: имена этих функций
  // встречаются в файле и раньше, в объявлениях, и сравнение по всему тексту
  // измеряло бы не то.
  const initBody = ui.slice(ui.indexOf('async function init() {'), ui.indexOf('init().catch('))
  check('браузерная отправка форм запрещена синхронно',
    /document\.addEventListener\('submit', event => event\.preventDefault\(\), true\)/.test(initBody))
  check('запрет ставится до подключения панелей и обработчиков',
    initBody.indexOf("document.addEventListener('submit'") < initBody.indexOf('buildPanes()'))

  // Признак готовности обязан стоять последним: поставленный раньше, он обещает
  // то, чего ещё нет, и проверки снова начнут угадывать момент.
  check('признак готовности ставится после подключения раздела Design',
    initBody.indexOf('setupDesignEvents()') < initBody.indexOf("dataset.appReady = '1'"))
  check('признак готовности ставится в конце инициализации',
    initBody.indexOf("dataset.appReady = '1'") > initBody.indexOf('loadModelsCatalog()'))

  check('проверка Design ждёт готовности, а не миллисекунд',
    /dataset\.appReady === '1'/.test(flow))
  check('в проверке Design не осталось угаданной паузы на старте',
    !/await wait\(1200\)/.test(flow))

  // --- ход обязан кончиться -----------------------------------------------------
  //
  // Живой прогон Дизайна: восемь минут, 804 тысячи токенов, тридцать с лишним
  // шагов — и ни ответа, ни остановки. Ход резать нельзя, иначе пропадёт
  // сделанное, поэтому по сроку у агента забирают инструменты и требуют итог.
  {
    const loopStart = source.indexOf('for (let step = 0; step < MAX_AGENT_STEPS; step++) {')
    const loop = source.slice(loopStart, source.indexOf('  return {', loopStart))

    check('у хода есть срок', /const TURN_SOFT_LIMIT_MS = /.test(source))
    check('срок считается от начала хода',
      /const turnStartedAt = payload\.runContext\?\.startedAt \?\? Date\.now\(\)/.test(source) &&
      /Date\.now\(\) - turnStartedAt > TURN_SOFT_LIMIT_MS/.test(loop))
    check('по сроку инструменты забираются', /if \(toolsEnabled && !wrappingUp\)/.test(source))
    check('требование итога уходит один раз', /if \(!wrappingUp && Date\.now\(\)/.test(loop))
    check('человеку говорят, что время вышло', /Время хода вышло/.test(loop))
    check('срок хода длиннее срока одной части',
      (() => {
        const turn = /const TURN_SOFT_LIMIT_MS = (\d+) \* 60 \* 1000/.exec(source)
        const part = /const PART_DEADLINE_MS = (\d+) \* 60 \* 1000/.exec(source)
        return turn && part && Number(turn[1]) > Number(part[1])
      })())
  }

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

run().catch(error => { console.error(error); process.exitCode = 2 })
