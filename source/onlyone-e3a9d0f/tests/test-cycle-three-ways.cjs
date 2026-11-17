'use strict'

// 2c: один контрольный сценарий проходит через чат и Дизайн.
//
// Проверяются четыре вещи, которые раньше держались каждая у себя:
//  1) стадии общего порядка в трёх входах — одни и те же;
//  2) отклонение первой попытки и успешная доработка — с расходом бюджета;
//  3) отмена и исчерпание бюджета — без новых попыток и с названным остатком;
//  4) перезапуск — продолжение на остатке, а не с полным комплектом.
// Плюс: сообщение о доработке не обещает того, чего в режиме нет (в Дизайне
// нет файловых инструментов), и права участников не меняются циклом.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createCycle, planRework, LIMITS, MODE_NOTE } = require('../src/main/agent-cycle')

let failed = 0
let total = 0
function check(name, fn) {
  total++
  try { fn() } catch (err) { failed++; console.error(`ПРОВАЛ [${name}]: ${err.message}`) }
}

// Ход, собранный ровно так же, как его собирает главный цикл: шаг исполнителя,
// записи проверок, решение о доработке. Движок здесь не подставной — подставлен
// только ответ модели, потому что проверяется порядок, а не провайдер.
function runTurn({ mode, attempts, aborted = false, restored = null }) {
  const cycle = createCycle({ restored })
  const sent = []
  for (const attempt of attempts) {
    cycle.mark('execute')
    cycle.record({ source: 'plan', verdict: attempt.plan === 'pass' ? 'pass' : 'fail',
      gaps: attempt.plan === 'pass' ? [] : ['пункт чек-листа не закрыт'] })
    cycle.record({ source: mode === 'design' ? 'design' : 'acceptance',
      verdict: attempt.verdict, gaps: attempt.gaps || [] })
    const decision = planRework(cycle, {
      gaps: cycle.openGaps(), lead: 'Не хватает:', mode, aborted
    })
    if (!decision.continue) return { cycle, sent, decision }
    sent.push(decision.message)
  }
  return { cycle, sent, decision: { continue: false, exhausted: false } }
}

const FIRST_REJECTED = [
  { plan: 'fail', verdict: 'fail', gaps: ['нет проверок'] },
  { plan: 'pass', verdict: 'pass' }
]

check('одинаковые стадии в чате и Дизайне', () => {
  const expected = ['execute', 'check', 'rework', 'execute', 'result']
  for (const mode of ['chat', 'design']) {
    const { cycle } = runTurn({ mode, attempts: FIRST_REJECTED })
    assert.deepEqual(cycle.stages(), expected, `стадии режима ${mode}`)
  }
})

check('отклонение первой попытки стоит одну попытку доработки', () => {
  const { cycle, sent } = runTurn({ mode: 'chat', attempts: FIRST_REJECTED })
  assert.equal(sent.length, 1, 'сообщений о переделке')
  assert.equal(cycle.left('reworks'), LIMITS.reworks - 1)
  assert.match(sent[0], /нет проверок/)
  assert.deepEqual(cycle.openGaps(), [], 'после успешной переделки не сданных проверок не остаётся')
})

check('итог хода называет каждую проверку явно', () => {
  const { cycle } = runTurn({ mode: 'chat', attempts: FIRST_REJECTED })
  const summary = cycle.summary()
  assert.match(summary.text, /чек-лист \(Агент 1\) — пройдена/)
  assert.match(summary.text, /приёмка по просьбе \(Агент 1\) — пройдена/)
  assert.match(summary.text, /доработка 1 из 3/)
})

check('отмена не тратит бюджет и не просит переделывать', () => {
  const { cycle, decision } = runTurn({ mode: 'chat', attempts: [FIRST_REJECTED[0]], aborted: true })
  assert.equal(decision.continue, false)
  assert.equal(cycle.left('reworks'), LIMITS.reworks, 'отменённый ход не израсходовал попыток')
})

check('на исчерпанном бюджете ход закрывается с названным остатком', () => {
  const stubborn = Array.from({ length: 6 }, () => ({ plan: 'pass', verdict: 'fail', gaps: ['не хватает результата'] }))
  const { cycle, sent, decision } = runTurn({ mode: 'chat', attempts: stubborn })
  assert.equal(sent.length, LIMITS.reworks, 'продлений ровно столько, сколько разрешено')
  assert.equal(decision.exhausted, true)
  assert.equal(cycle.left('reworks'), 0)
  assert.deepEqual(cycle.openGaps(), ['не хватает результата'], 'остаток называется, а не подметается')
})

check('перезапуск продолжает ход на остатке бюджета', () => {
  const first = runTurn({ mode: 'chat', attempts: [FIRST_REJECTED[0]] })
  assert.equal(first.cycle.left('reworks'), LIMITS.reworks - 1)
  const snapshot = first.cycle.snapshot()

  // После падения работа не сдана: продолжение тратит ещё одну попытку из
  // остатка. Без восстановления у него было бы столько же, сколько у целого
  // хода, — то есть лимит обнулялся бы каждым перезапуском.
  const second = runTurn({ mode: 'chat', attempts: FIRST_REJECTED, restored: snapshot })
  assert.equal(second.cycle.restored, true)
  assert.equal(second.cycle.left('reworks'), LIMITS.reworks - 2)
  assert.match(second.cycle.summary().text, /бюджет продолжен с остатка/)
  assert.deepEqual(second.cycle.stages().slice(-2), ['execute', 'result'])
})

check('бюджет один на ход: помощники тратят его вместе с ведущим', () => {
  const cycle = createCycle({})
  // Ведущий и два помощника работают одним и тем же объектом (так его и
  // передают: runAgentSlot собирает shared из payload).
  const participants = [{}, {}, {}]
  let allowed = 0
  for (const round of [1, 2, 3, 4]) {
    for (const participant of participants) {
      if (planRework(cycle, { gaps: ['не сдано'], mode: 'chat' }).continue) allowed++
    }
  }
  assert.equal(allowed, LIMITS.reworks, 'продлений на весь ход не больше общего предела')
})

check('сообщение о переделке знает права режима', () => {
  const design = planRework(createCycle({}), { gaps: ['x'], mode: 'design' }).message
  assert.match(design, /dc_check/)
  assert.match(design, /файловых инструментов/)
  assert.equal(/write_file|запиши файл/.test(design), false,
    'Дизайну нельзя обещать то, чего у него нет')
  assert.match(MODE_NOTE.chat, /рабочей папки/)
})

check('стадия неизвестного имени не записывается', () => {
  const cycle = createCycle({})
  assert.equal(cycle.mark('магия'), false)
  assert.deepEqual(cycle.stages(), [])
  assert.equal(cycle.mark('execute'), true)
  assert.equal(cycle.mark('execute'), false, 'повтор той же стадии подряд не дублируется')
})

// ---------------------------------------------------------------------------
// Проводка: три входа идут через один модуль, а не через три похожих блока.
// ---------------------------------------------------------------------------

const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
const loopStart = main.indexOf('async function runAgentLoop(')
const loop = main.slice(loopStart, main.indexOf('function createWindow()', loopStart))
const modeStart = main.indexOf('async function runAgentMode(')
const modeSrc = main.slice(modeStart, loopStart)

check('решение о доработке принимает общий модуль', () => {
  assert.equal(main.split('planRework(cycle,').length - 1, 1, 'вызов planRework должен быть один')
  assert.match(loop, /const rework = planRework\(cycle, \{/)
  assert.match(loop, /mode: design [?] 'design' : 'chat'/)
})

check('своих счётчиков продлений в цикле больше нет', () => {
  for (const gone of ['gateContinues', 'acceptanceChecks', 'MAX_GATE_CONTINUES', 'MAX_ACCEPTANCE_CHECKS', 'AGENT_MAX_ROUNDS']) {
    assert.equal(new RegExp(gone).test(main), false, `${gone} остался в главном процессе`)
  }
})

check('круги команды тратят тот же бюджет', () => {
  assert.match(modeSrc, /cycle\.spend\('rounds'\)/)
  assert.match(modeSrc, /const cycle = payload\.cycle \|\| createCycle/)
  assert.match(modeSrc, /payload = \{ \.\.\.payload, cycle(, team: isCollab)? \}/, 'one')
})

check('бюджет создаётся один на ход и попадает ко всем участникам', () => {
  // Держимся за смысл, а не за текст строки: в тот же spread кто-то добавил
  // своё поле, и дословное сравнение краснело бы без всякой поломки. Важно,
  // что все трое участников хода едут в payload одним объектом.
  const spreads = [...main.matchAll(/payload = \{ \.\.\.payload,[^}]*\}/g)].map(m => m[0])
  assert.ok(spreads.length, 'payload перед запуском хода не собирается заново')
  const trio = spreads.find(s => ['runContext', 'checkpoint', 'cycle']
    .every(key => new RegExp(`[{,:]\\s*${key}\\s*[,}]`).test(s)))
  assert.ok(trio, `ни один spread не несёт сразу runContext, checkpoint и cycle: ${spreads.join(' | ')}`)
  assert.match(main, /restored: resumed\?\.cycle \|\| null/)
  assert.match(main, /onSave: snapshot => checkpoint\.updateCycle\(snapshot\)/)
})

check('остаток читается до тестового провайдера — иначе прогон и жизнь разошлись бы', () => {
  const resumeAt = main.indexOf('const resumed = payload.resumeRunId')
  // Якорь — сам вызов тестового выхода, а не строка `return` целиком: у возврата
  // появляется поле (3.9 принёс окну запись о сжатии), и дословная строка
  // краснела бы без всякой поломки порядка. Смысл проверки тот же: чтение
  // остатка и завод контрольной точки обязаны быть ДО тестового провайдера.
  const smokeAt = main.indexOf('await replyForSmokeTest(')
  assert.ok(resumeAt > 0 && smokeAt > resumeAt, `чтение ${resumeAt}, тестовый выход ${smokeAt}`)
  // Сам тестовый выход теперь внутри жизненного цикла хода: контрольная точка
  // заведена, остаток унаследован, снимок прежней записи снят.
  const checkpointAt = main.indexOf('const checkpoint = runCheckpoints.start(')
  const cycleAt = main.indexOf('const cycle = createCycle({')
  const dismissAt = main.indexOf('runCheckpoints.dismiss(resumed.runId)')
  assert.ok(checkpointAt > 0 && cycleAt > checkpointAt && dismissAt > cycleAt && smokeAt > dismissAt,
    'прогон окна обязан проходить через тот же порядок, что и живая работа')
})

check('права режимов модуль цикла не трогает', () => {
  const quality = fs.readFileSync(path.join(__dirname, '..', 'src/main/agent-quality.js'), 'utf8')
  assert.match(quality, /function toolAllowedForAssignment\(name, readOnly\)/)
  assert.equal(/toolAllowedForAssignment|approvalRequired/.test(fs.readFileSync(path.join(__dirname, '..', 'src/main/agent-cycle.js'), 'utf8')), false,
    'общий цикл не должен решать, что разрешено')
})

console.log(`Общий цикл, три входа: ${total} проверок, ошибок ${failed}`)
process.exit(failed ? 1 : 0)
