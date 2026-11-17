// Ожидание разрешения и вопроса слушает сигнал своей части.
//
// Аудит 1.1.0, находка F5: у всех агентов одного хода общий requestId, и общая
// кнопка Stop снимала ожидания по нему. Но часть, прерванная по собственному
// сроку (PART_DEADLINE_MS), обрывала только свой сигнал — обещание оставалось
// висеть, а карточка в ленте ждала ответа, которого уже никто не даст.
//
// Проверяется настоящий код main.js, вынутый из файла, а не его пересказ.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr

const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
const cut = (from, to) => {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  assert(a >= 0 && b > a, 'не найдена область: ' + from)
  return source.slice(a, b)
}

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  return Promise.resolve().then(fn).catch(error => {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  })
}

function build() {
  const sent = []
  const pendingApprovals = new Map()
  const event = { sender: { send: (channel, body) => sent.push({ channel, body }), isDestroyed: () => false } }
  const requestApproval = new Function('pendingApprovals', 'crypto', 'APPROVAL_TIMEOUT_MS',
    'approvalRequired', 'selfDevActive', 'workspace',
    // Настоящая точка отправки хода: подставка не отличила бы живое окно от
    // уничтоженного, а различие здесь и проверяется.
    cut('function sendToWindow(event, channel, body)', 'async function runAgentMode(') + '\n' +
    cut('async function requestApproval(event, {', '// A destroyed renderer can never answer') +
    '; return requestApproval')(
    pendingApprovals, require('node:crypto'), 60000,
    () => true, () => false, { permission: 'manual' })
  return { requestApproval, pendingApprovals, sent, event }
}

async function main() {
  await check('прерванная часть не начинает ждать разрешения', async () => {
    const { requestApproval, pendingApprovals, event } = build()
    const controller = new AbortController()
    controller.abort()
    const answer = await requestApproval(event, { summary: 'Записать файл', requestId: 'r1', signal: controller.signal })
    assert.equal(answer, false, 'ответ должен быть отказом')
    assert.equal(pendingApprovals.size, 0, 'ожидание не должно заводиться')
  })

  await check('обрыв части снимает её ожидание', async () => {
    const { requestApproval, pendingApprovals, sent, event } = build()
    const controller = new AbortController()
    const waiting = requestApproval(event, { summary: 'Записать файл', requestId: 'r1', signal: controller.signal })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(pendingApprovals.size, 1, 'ожидание должно появиться')

    controller.abort()
    const answer = await waiting
    assert.equal(answer, false, 'прерванное ожидание отвечает отказом')
    assert.equal(pendingApprovals.size, 0, 'запись об ожидании должна исчезнуть')
    assert(sent.some(message => message.channel === 'agent-approval-done'),
      'окну не сказали снять карточку: ' + sent.map(m => m.channel).join(', '))
  })

  await check('чужое ожидание того же хода не трогается', async () => {
    const { requestApproval, pendingApprovals, event } = build()
    const mine = new AbortController()
    const other = new AbortController()
    const first = requestApproval(event, { summary: 'Часть 1', requestId: 'r1', signal: mine.signal })
    requestApproval(event, { summary: 'Часть 2', requestId: 'r1', signal: other.signal })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(pendingApprovals.size, 2)

    mine.abort()
    await first
    assert.equal(pendingApprovals.size, 1, 'у соседней части ожидание должно остаться')
    other.abort()
  })

  await check('сигнал доходит до инструментов', () => {
    assert.match(source, /async function executeTool\(event, name, args, requestId, design = null, signal = null\)/)
    assert.match(source, /(?:await|\|\|) executeTool\(event, toolName, args, payload\.requestId, design, signal\)/)
    assert.match(source, /async function askUser\(event, args, requestId, signal = null\)/)
  })
  await check('принудительное подтверждение сохраняет сигнал отмены', async () => {
    let captured
    const approve = new Function('requestApproval', 'workspace',
      cut('async function requireMutationApproval(', '// ---------------------------------------------------------------------------') + '; return requireMutationApproval')(
      async (_event, options) => { captured = options; return true }, { permission: 'manual' })
    const signal = new AbortController().signal
    assert.equal(await approve({}, 'Start', 'Test process', null, 'edit', 'request', signal, true), true)
    assert.equal(captured.signal, signal)
    assert.equal(captured.force, true)
  })

  // Сигнал в executeTool бесполезен, если отдельный вызов его не передаёт:
  // запись, перенос и удаление долго обходились без него.
  await check('каждое подтверждение внутри инструментов слушает сигнал', () => {
    const body = cut('async function executeTool(event, name, args, requestId', '\nfunction ')
    const calls = []
    let at = body.indexOf('requireMutationApproval(')
    while (at >= 0) {
      let depth = 0
      let end = at + 'requireMutationApproval'.length
      do {
        if (body[end] === '(') depth++
        else if (body[end] === ')') depth--
        end++
      } while (depth > 0 && end < body.length)
      calls.push(body.slice(at, end))
      at = body.indexOf('requireMutationApproval(', end)
    }
    assert(calls.length >= 8, 'подтверждений найдено подозрительно мало: ' + calls.length)
    // The optional force argument follows signal for actions that always need confirmation.
    const deaf = calls.filter(call => !/,\s*signal\s*(?:,\s*(?:true|false|workspace\.permission === 'auto' && config\.type === 'http')\s*)?\)$/.test(call))
    assert.equal(deaf.length, 0, 'без сигнала: ' + deaf.map(call => call.split('\n').slice(0, 3).join(' ').slice(0, 90)).join(' | '))
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main()
