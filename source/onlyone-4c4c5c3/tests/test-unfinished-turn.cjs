// «Он прерывается всегда.»
//
// Not truncation: the answer ends on a complete sentence. The model does part of
// the work, writes «Сделано / Не вышло / Следующий шаг: …» and hands back a
// progress report. `finish_reason: "stop"`, nothing cut off — so the app closed
// the turn and waited, and the user typed «доделай». Every time.
//
// A turn that ends with the agent naming work it has not done is not finished.
// This is the guard on the one judgement in that: deciding, from the agent's own
// words, that it stopped short.
//
// The cost of the two mistakes is not symmetric. Missing a case leaves things as
// they were — the user types «доделай». Firing wrongly runs the model on work
// nobody asked for, on the user's money. So the bar is the agent admitting an
// omission out loud, not merely pointing at a next step.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return src.slice(a, b)
}

// Both readers take whatever a message happens to be, so the extraction carries
// the one place that turns it into text.
const messageTextSrc = cut('// The words in a message, whatever shape it arrived in.',
  '// ---------------------------------------------------------------------------')

// eslint-disable-next-line no-new-func
const { saysUnfinished, messageText } = new Function(
  messageTextSrc +
  cut('const UNFINISHED_MARKS = [', '// A model told to carry on usually restarts') +
  '\nreturn { saysUnfinished, messageText }'
)()

// A message with attachments arrives as an array of parts, not a string. Reading
// it as text and calling .trim() killed the turn before its first step: the
// answer in the chat was «TypeError: text.trim is not a function» and not one
// tool ran. A whole live sweep was lost to it.
check('содержимое-массив не роняет разбор',
  saysUnfinished([{ type: 'text', text: 'Модуль не написан. Следующий шаг: написать.' }]) === true)
check('массив без текста ничего не ломает',
  saysUnfinished([{ type: 'image_url', image_url: { url: 'x' } }]) === false)
check('объект вместо строки не роняет разбор',
  saysUnfinished({ text: 'Не реализован. Следующий шаг: реализовать.' }) === true)
check('текст собирается из частей сообщения',
  messageText([{ text: 'Не начато.' }, { text: 'Следующий шаг: начать.' }]) ===
    'Не начато. Следующий шаг: начать.')
check('строка проходит как есть', messageText('просто текст') === 'просто текст')
check('пустые входы дают пустую строку',
  messageText(null) === '' && messageText(undefined) === '' && messageText(42) === '')

// --- the report that started this -------------------------------------------
// Shortened from the real one, keeping the two things that matter: an omission
// admitted, and a next step named.
const realReport = `Сделано:
1. Все три репозитория скачаны и распакованы в proX/_research.
2. Рабочие инструменты заведены и проверены.

Не вышло / честные оговорки:
1. Скриншоты я в плане пометил done преждевременно.
4. Архитектура, роадмап и скелет proX не начаты — кода приложения нет.

Следующий шаг: визуальный разбор 6 скриншотов Karing, затем фиксация
архитектуры и создание скелета приложения.`

check('отчёт «сделано / не начато / следующий шаг» распознан',
  saysUnfinished(realReport) === true)

// --- and the ones that must not fire ----------------------------------------

// A finished job. Nothing here says anything is missing.
check('законченная работа не продолжается',
  saysUnfinished('Готово. Собрал проект, тесты проходят, установщик лежит в release.') === false)

// A genuine handover: the next step belongs to the user, not to the agent. This
// is the expensive mistake — continuing here starts work nobody asked for.
check('передача хода человеку не считается недоделкой',
  saysUnfinished('Ключ добавлен. Следующий шаг за вами: выберите модель в каталоге.') === false)

// An omission with no next step is a statement of scope, not an unfinished job.
check('оговорка без следующего шага не продолжается',
  saysUnfinished('Тесты я не писал — вы просили только разбор. На этом всё.') === false)

// Both halves, phrased differently.
check('«осталось сделать» + «дальше нужно» распознаны',
  saysUnfinished('Осталось сделать миграцию базы. Дальше нужно поднять сиды.') === true)
check('английская формулировка тоже распознана',
  saysUnfinished('The parser is not implemented yet. Next step: write it.') === true)

check('пустой ответ не считается недоделкой',
  saysUnfinished('') === false && saysUnfinished(null) === false &&
  saysUnfinished('   ') === false)

// --- and the loop acts on it -------------------------------------------------

const loop = cut('async function runAgentLoop(event, payload, preferredKeyId, signal) {',
  'function createWindow()')

check('ход продолжается, когда агент сам сказал, что не доделал',
  /saysUnfinished\(stepResult\.content\)/.test(loop))
check('число самопродолжений ограничено',
  /selfContinues < selfContinueLimit/.test(loop) && /MAX_SELF_CONTINUES = 3/.test(src))

// The guard that keeps this off ordinary conversation: only a turn that actually
// did something can be unfinished. An answer discussing what could be done next
// is an answer, and continuing it invents a task.
//
// It has to read the turn's own journal, not the conversation. The conversation
// loses every `role: 'tool'` entry when the context overflows and is rebuilt
// from the task plus a summary — so a long turn that compacted and then admitted
// an omission was closed silently, which is where the work was longest.
const guardArea = loop.slice(loop.indexOf('saysUnfinished(stepResult.content)'),
  loop.indexOf('saysUnfinished(stepResult.content)') + 400)
check('продолжают только ход, в котором была работа',
  /toolLog\.length/.test(guardArea),
  'ход без единого вызова инструмента тоже продолжался бы')
check('признак работы переживает сворачивание контекста',
  !/messages\.some\(m => m\.role === 'tool'\)/.test(guardArea),
  'признак читается из переписки, а её сворачивание стирает записи инструментов')
check('журнал хода заполняется на каждом вызове',
  /toolLog\.push\(logEntry\)/.test(loop) && /const toolLog = \[\]/.test(loop))

check('агента просят делать, а не отчитываться',
  /Не пересказывай/i.test(loop) && /выполняй следующий безопасный шаг/.test(loop) && /критериях приёмки или конкретном блокере/.test(loop))
check('человеку видно, что ход продолжили',
  /Работа не закончена по словам самого агента/.test(loop))

// --- «сделай полностью» как отдельное указание --------------------------------
// Point six of the protocol already said «работай до конца задачи» and it did
// not hold: it sits at position zero of the prompt, and by step forty the
// context is almost entirely tool output. So the user saying it out loud is
// treated as its own instruction — restated in the prompt as theirs, and the
// turn is allowed to carry itself on further.

// eslint-disable-next-line no-new-func
const { wantsWholeJob } = new Function(
  messageTextSrc +
  cut('const WHOLE_JOB_MARKS = [', "// Does the agent's own answer say") +
  '\nreturn { wantsWholeJob }'
)()

// The crash landed here first: this one reads the user's own message, and that
// carries an array whenever anything is attached to it.
check('указание в сообщении с вложением распознаётся',
  wantsWholeJob([{ type: 'text', text: 'сделай полностью' }]) === true)
check('вложение без слов не роняет разбор',
  wantsWholeJob([{ type: 'image_url', image_url: { url: 'x' } }]) === false)

for (const said of [
  'сделай полностью приложение',
  'Сделай это полностью',
  'доведи до конца',
  'доделай',
  'прочитай целиком и перепиши',
  'не останавливайся, пока не закончишь',
  'do it fully',
  'finish the whole thing'
]) {
  check(`«${said}» распознано как «делай до конца»`, wantsWholeJob(said) === true)
}

// The expensive mistake is the other direction: a raised ceiling on an ordinary
// question means the agent grinds on work nobody set.
for (const said of [
  'посмотри, что в этом файле',
  'объясни, как это работает',
  'я до конца не понял, объясни ещё раз',
  'до конца дня надо решить, какой стек брать',
  'что тут можно улучшить?'
]) {
  check(`«${said}» не считается указанием доделать`, wantsWholeJob(said) === false)
}

check('пустая задача ничего не включает',
  wantsWholeJob('') === false && wantsWholeJob(null) === false)

// --- и это доходит до модели -------------------------------------------------
const promptBlock = cut('function buildWholeJobBlock(task) {', 'function buildSystemPrompt')
check('без такого указания блок не добавляется',
  /if \(!wantsWholeJob\(task\)\) return ''/.test(promptBlock))
check('указание передано как слова пользователя, а не правило приложения',
  /Пользователь сказал сделать работу полностью/.test(promptBlock))
check('завершение ограничено разрешённым объёмом',
  /Заверши весь разрешённый объём/.test(promptBlock))
check('реальный блокер не скрывается ради автономности',
  /честно сообщи блокер/.test(promptBlock) && !/важнее твоей осторожности/.test(promptBlock))
check('блок доходит до собранной подсказки',
  // С пункта 6.2 режим собирается в ./mode-prompts, а «самодоработка» и
  // «сделай полностью» приходят слоями: проверка смотрит, что сборщик их
  // действительно вызывает, а не на порядок подстановок в шаблоне.
  /selfDevelopment: selfDevActive\(\)/.test(src) &&
  /buildWholeJobBlock\(task\)/.test(cut('function buildSystemPrompt({', '// PDFs need')))
// Проверяется передача задачи, а не дословный вид вызова: у buildSystemPrompt
// со временем прибавляются параметры, и привязка к точной строке ломает тест на
// каждом таком добавлении, ничего при этом не защищая.
check('подсказка знает задачу',
  /buildSystemPrompt\(\{[\s\S]{0,900}?task: taskText/.test(src))

// The abstract rule stays, but the shape of the failure is now named next to it.
const sharedRules = require('fs').readFileSync(
  require('node:path').join(__dirname, '..', 'src', 'main', 'mode-prompts', 'shared.js'), 'utf8')
check('запрещена именно та форма отказа, которая случалась',
  /Отчёт о недоделанном — не ответ/.test(sharedRules) &&
  /Строка «следующий шаг» уместна там, где решение за пользователем/.test(sharedRules))

check('потолок самопродолжений поднимается по указанию',
  /MAX_SELF_CONTINUES_WHOLE_JOB = 8/.test(src) &&
  /wantsWholeJob\(taskText\)[\s\S]{0,80}MAX_SELF_CONTINUES_WHOLE_JOB/.test(src))

require('node:child_process').execFileSync(process.execPath, [require('node:path').join(__dirname, 'test-stream-recovery.cjs')], {stdio:'inherit'})
console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
