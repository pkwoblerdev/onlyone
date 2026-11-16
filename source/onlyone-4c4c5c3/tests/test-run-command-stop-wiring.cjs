// Проводка Stop-контракта команды в главном процессе (Н39).
//
// `command-runner.js` умеет различать «снятие подтверждено» и «перестали ждать»
// (`killed` / `killUnconfirmed` / `warning`), но решение о том, что увидят человек
// в ленте и модель в результате инструмента, принимает `main.js`. Проверка берёт
// настоящий участок `runCommand` из `main.js` и вызывает его на четырёх исходах:
// снятие подтверждено, снятие не подтверждено, отмена пользователем и обычный
// код возврата. Модуль `command-runner` — настоящий (берётся `lastLines`),
// подставлены только окно, журнал и путь до проекта.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(process.env.ONECODE_MAIN_UNDER_TEST ||
  path.join(root, 'src', 'main', 'main.js'), 'utf8')
const commandRunner = require('../src/main/command-runner')

// Keep the production sender contract in this isolated runCommand harness.
// runCommand now routes its feed event through this shared helper; passing a
// no-op would hide a missing send, while omitting it makes the extracted body
// fail before the stop-result assertions can run.
const SEND_START = main.indexOf('function sendToWindow(event, channel, body) {')
const SEND_END = main.indexOf('\nasync function runAgentMode(', SEND_START)
assert.ok(SEND_START >= 0 && SEND_END > SEND_START, 'sendToWindow helper anchor missing from main.js')
const sendToWindow = new Function(`${main.slice(SEND_START, SEND_END)}; return sendToWindow`)()

function at(marker, from = 0) {
  const index = main.indexOf(marker, from)
  assert.ok(index >= 0, 'якорь пропал из main.js: ' + marker)
  return index
}

// Тело `runCommand` после вызова runner-а: от результата до возврата инструмента.
const BODY = main.slice(at('  const reviewed = await reviewSectionsService().beginCommand('),
  at('async function searchWorkspaceFiles'))
const BODY_TRIMMED = BODY.slice(0, BODY.lastIndexOf('}'))

let checks = 0
const failures = []
// Проверки асинхронные: синхронный try/catch не поймал бы отклонённое обещание,
// и красная проверка записалась бы как зелёная.
async function check(name, fn) {
  try { await fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

// Один прогон настоящего участка main.js на подставном исходе runner-а.
// Конструктор именно async: вырезанный участок содержит `await`.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
function runTail(result, extra = {}) {
  const events = [], logs = []
  // `queueReport` — рукоятка Центра задач (план, 3.4б): вырезанный участок
  // сообщает ей исход команды. В этом песочном прогоне очереди нет, поэтому
  // передан пустой объект: `close` не зарегистрирован, сообщение молча не идёт.
  // `queued` — карточка консоли «Задач»: её нет, вывод в неё не пишется.
  const out = new AsyncFunction('commandRunner', 'sendToWindow', 'event', 'latency', 'relativeDisplay', 'command', 'cwd',
    'timeoutMs', 'requestId', 'signal', 'runnerResult', 'queueReport', 'queued', 'taskManager',
    'reviewSectionsService', 'workspaceRoots',
    `${BODY_TRIMMED.replace('await commandRunner.run({ command, cwd, env, timeoutMs, signal })',
      'await runnerResult')}`)(
    commandRunner,
    sendToWindow,
    { sender: { send: (channel, payload) => events.push({ channel, payload }) } },
    { write: text => logs.push(text) },
    value => `проект/${String(value).split(/[\\/]/).pop()}`,
    'npm run build', 'C:\\proj', extra.timeoutMs || 5000, 'req-1', new AbortController().signal,
    Promise.resolve(result), {}, null, { appendLog () {} },
    () => ({ beginCommand: async () => ({ finish: async () => ({ ok: false }) }) }), () => [])
  return out.then(toolResult => ({ events, logs, toolResult }))
}

const base = { ok: false, exitCode: null, timedOut: true, aborted: false, truncated: true,
  output: 'сборка прервана', dropped: 0, ms: 1200 }

async function runChecks() {
  await check('снятие без подтверждения: лента говорит, что процесс может жить', async () => {
    const { events, toolResult } = await runTail({ ...base,
      killed: false, killUnconfirmed: true, warning: commandRunner.UNCONFIRMED_WARNING })
    const feed = events.map(event => event.payload.message || '').join('\n')
    // Главное в этой проверке — отрицание: ни «остановлена», ни «остановила».
    // Утверждать, что команда стоит, нечем: именно это и врал прежний текст.
    assert.ok(!/остановлен/i.test(feed), `лента утверждает, что команда остановлена: ${feed}`)
    assert.ok(/не подтвержд/i.test(feed), `в ленте нет про неподтверждённое снятие: ${feed}`)
    assert.ok(/мог остановиться|мог работать дальше/i.test(feed),
      `лента не говорит, чего именно мы не знаем: ${feed}`)
    assert.equal(toolResult.stopped, false, 'ответ инструмента не отрицает остановку')
    assert.equal(toolResult.killUnconfirmed, true, 'модель не получает это структурой')
    assert.ok(toolResult.warning && toolResult.warning.length > 20, 'в результате нет текста предупреждения')
    assert.equal(toolResult.success, false, 'такой ход не может быть успехом')
    assert.ok(!/остановлен/i.test(toolResult.warning),
      `предупреждение само утверждает остановку: ${toolResult.warning}`)
  })

  await check('подтверждённое снятие: ответ говорит stopped явно', async () => {
    const { toolResult } = await runTail({ ...base, killed: true })
    assert.equal(toolResult.stopped, true, 'подтверждённое снятие не отражено в ответе')
    assert.equal(toolResult.killUnconfirmed, undefined)
  })

  await check('подтверждённое снятие: ложной тревоги в ленте нет', async () => {
    const { events, toolResult } = await runTail({ ...base, killed: true })
    const feed = events.map(event => event.payload.message || '').join('\n')
    assert.ok(/не уложилась в 5 с и остановлена/.test(feed), `прежняя формулировка пропала: ${feed}`)
    assert.ok(!/не подтвержд/i.test(feed), 'лента пугает там, где дерево снято: ' + feed)
    assert.equal(toolResult.killUnconfirmed, undefined, 'в результате появился лишний флаг')
    assert.equal(toolResult.timedOut, true)
  })

  await check('отмена пользователем отличается от таймаута и не врёт о снятии', async () => {
    const { events, toolResult } = await runTail({ ...base, timedOut: false, aborted: true, killed: true })
    const feed = events.map(event => event.payload.message || '').join('\n')
    assert.ok(/остановлена пользователем/.test(feed), feed)
    assert.ok(!/не уложилась/.test(feed), 'отмена описана как таймаут: ' + feed)
    assert.equal(toolResult.aborted, true)
    assert.equal(toolResult.killUnconfirmed, undefined)
  })

  await check('обычный код возврата идёт как шёл', async () => {
    const { events, toolResult } = await runTail({ ...base, ok: true, exitCode: 0,
      timedOut: false, truncated: false, output: 'работа сделана' })
    const feed = events.map(event => event.payload.message || '').join('\n')
    assert.ok(/вернула код 0/.test(feed), feed)
    assert.equal(toolResult.success, true, 'успешная команда помечена провалом')
    assert.equal(toolResult.killUnconfirmed, undefined)
    assert.match(toolResult.output, /работа сделана/)
  })

  await check('журнал не врёт о снятии', async () => {
    const unconfirmed = await runTail({ ...base, killed: false, killUnconfirmed: true,
      warning: commandRunner.UNCONFIRMED_WARNING })
    const confirmed = await runTail({ ...base, killed: true })
    assert.ok(/"killUnconfirmed":true/.test(unconfirmed.logs.join('\n')), 'в журнал не попало')
    assert.ok(!/"killUnconfirmed":true/.test(confirmed.logs.join('\n')), 'журнал рисует проблему там, где её нет')
  })

  await check('в журнале нет ни вывода команды, ни секретов из него', async () => {
    const { logs } = await runTail({ ...base, output: 'токен sk-or-v1-EXAMPLE233cf8ed4 в выводе' })
    const line = logs.find(text => text.startsWith('run_command')) || ''
    assert.ok(!/sk-or-v1|токен/.test(line), 'в журнал уехал вывод команды: ' + line)
    assert.ok(line.includes('npm run build'), 'из журнала пропала сама команда')
  })

  await check('main.js читает подтверждение в двух местах, а не одно', () => {
    const reads = (BODY_TRIMMED.match(/result\.killUnconfirmed/g) || []).length
    assert.ok(reads >= 2, `полей, зависящих от подтверждения: ${reads} — должно быть минимум два (лента и результат)`)
    assert.ok(/success:\s*result\.ok/.test(BODY_TRIMMED),
      'успех перестал зависеть от runner-а: проваленная команда может стать «успешной»')
  })
  if (failures.length) console.error(`\nпровалено проверок: ${failures.length} из ${checks + failures.length}`)
  console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
  process.exit(failures.length ? 1 : 0)
}

runChecks().catch(error => { console.error('харнесс упал: ' + error.stack); process.exit(2) })
