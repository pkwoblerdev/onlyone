// «Разговор обрывается на середине, а результата нет.»
//
// A model stops for one of two reasons: it finished, or it hit its own output
// cap. The second arrives as `finish_reason: "length"` and means the sentence is
// cut in half — there was more to say. The agent loop treated both the same: no
// tool calls, so break. The half-sentence went to the user as the answer, with
// nothing on screen to say it had been cut.
//
// This test covers the join, because that is the part that can go wrong quietly:
// a model told to carry on usually restates the sentence it was cut off in, and
// a doubled sentence reads as a bug of its own.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// --- the join, run for real --------------------------------------------------

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return src.slice(a, b)
}

// eslint-disable-next-line no-new-func
const join = new Function('SEAM_LOOKAHEAD',
  cut('function seamOverlap(sofar, next) {', 'async function runAgentLoop') +
  '\nreturn { seamOverlap, trimContinuation }'
)(400)

const sofar = 'Чтобы настроить прокси, сначала откройте файл конфигурации и найдите ' +
  'раздел listeners. В нём указывается порт, на котором клиент принимает'

// The usual case: the model restarts from the sentence it was cut off in.
const repeats = ' В нём указывается порт, на котором клиент принимает соединения. ' +
  'Значение по умолчанию — 1080.'
check('повтор на шве убирается',
  join.trimContinuation(sofar, repeats) === ' соединения. Значение по умолчанию — 1080.',
  JSON.stringify(join.trimContinuation(sofar, repeats)))

// A continuation that simply carries on is left exactly as it is.
const clean = ' соединения. Значение по умолчанию — 1080.'
check('чистое продолжение не трогают',
  join.trimContinuation(sofar, clean) === clean,
  JSON.stringify(join.trimContinuation(sofar, clean)))

// The opener a model adds of its own accord.
check('вступление «Продолжаю:» отбрасывается',
  join.trimContinuation(sofar, 'Продолжаю: соединения.') === ' соединения.',
  JSON.stringify(join.trimContinuation(sofar, 'Продолжаю: соединения.')))
check('многоточие в начале отбрасывается',
  join.trimContinuation(sofar, '... соединения.') === ' соединения.',
  JSON.stringify(join.trimContinuation(sofar, '... соединения.')))

// The dangerous direction: a short accidental match must not eat real text. The
// continuation genuinely starts with a word that also ends the previous part.
const risky = 'принимает — это важно.'
check('короткое случайное совпадение не режет ответ',
  join.trimContinuation(sofar, risky) === risky, JSON.stringify(join.trimContinuation(sofar, risky)))

// The whole continuation being a repeat leaves nothing to add, which is correct:
// better an answer that stops than the same paragraph twice.
const allRepeat = sofar.slice(-80)
check('полный повтор схлопывается в пустоту',
  join.trimContinuation(sofar, allRepeat) === '', JSON.stringify(join.trimContinuation(sofar, allRepeat)))

check('на пустых входах не падает',
  join.trimContinuation('', 'что-то') === 'что-то' && join.trimContinuation('что-то', '') === '')

// Longest overlap wins: a model may restate two sentences, and trimming only the
// shorter match would leave one of them doubled.
const twoSentences = 'Он читает конфиг. Потом слушает порт.'
const restated = 'Потом слушает порт. И пишет лог.'
check('берётся самое длинное совпадение, а не первое найденное',
  join.trimContinuation(twoSentences, restated) === ' И пишет лог.',
  JSON.stringify(join.trimContinuation(twoSentences, restated)))

// --- and the loop actually continues ----------------------------------------

const loop = cut('async function runAgentLoop(event, payload, preferredKeyId, signal) {',
  'function createWindow()')

check('обрыв по лимиту длины распознаётся',
  /stepResult\.finishReason === 'length'/.test(loop))

// The half-written answer and the answer that never started are different
// failures. The second was found only by a live run: when the whole allowance
// goes on thinking, `content` is empty and there is nothing to carry on from —
// which is «прервалось, а результата нет» exactly.
check('обрыв с текстом и обрыв без текста разведены',
  /if \(stepResult\.content\.trim\(\)\) \{[\s\S]{0,900}\} else \{/.test(loop),
  'пустой обрыв обрабатывается так же, как обрыв с текстом')
check('обрыв без текста тоже продолжают',
  /Ты израсходовал весь предел длины на размышления/.test(loop))

// Asking a model not to think does nothing: thinking is a parameter of the
// request. Measured — four rounds of asking produced four more empty answers.
check('размышление на повторе выключают, а не отговаривают',
  /effortNow = 'off'/.test(loop))
check('глубина размышления берётся живая, а не исходная',
  /applyModelParams\(bodyData, model, effortNow\)/.test(loop))
check('оборванный ответ продолжают, а не отдают половиной',
  /continuations < MAX_ANSWER_CONTINUATIONS/.test(loop) &&
  /continuations\+\+/.test(loop))
check('модели передают то, что она уже написала',
  /messages\.push\(\{ role: 'assistant', content: stepResult\.content \}\)/.test(loop))
check('и просят продолжить с того же места',
  /Продолжи ровно с того места/.test(loop))
check('продолжение проходит через склейку',
  /seam = \{ before: aggregateContent, pending: '' \}/.test(loop))
check('короткое продолжение не теряется',
  /if \(seam\) \{[\s\S]{0,200}trimContinuation/.test(loop))

// The cap has to exist, and running out of it has to be said out loud — ending
// on a half-word as if that were the whole answer is the original complaint.
check('число продолжений ограничено', /MAX_ANSWER_CONTINUATIONS = 4/.test(src))
check('исчерпав продолжения, приложение говорит об этом',
  /_Ответ обрывается: модель \$\{MAX_ANSWER_CONTINUATIONS\}/.test(loop))

// --- a call cut in half is not a call ----------------------------------------
// The same cap halves tool calls. Running one with `{}` invents a call the model
// never made, and the error that comes back is about the wrong thing.
check('обрезанные аргументы не превращаются в пустые',
  !/catch \{\s*args = \{\}\s*\}/.test(loop), 'пустой объект всё ещё подставляется')
// Разбор аргументов переехал в отдельный модуль — там его можно вызвать
// и проверить, а не срисовывать регуляркой с исходника.
const { parseToolArguments } = require('../src/main/tool-protocol.cjs')
const cutCall = parseToolArguments('{"path":"a.js","content":"начал')
check('обрезанный вызов не выполняется',
  cutCall.ok === false && /обрезанными/.test(cutCall.message))
check('и модель просят повторить вызов короче',
  /Повтори вызов с более коротким аргументом/.test(cutCall.message))
check('цикл пользуется этим разбором',
  /parseToolArguments\(call\.function\?\.arguments\)/.test(loop))

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
