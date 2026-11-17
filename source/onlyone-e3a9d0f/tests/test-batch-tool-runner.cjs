// Инициатива 4 (11.10.2026): независимые чтения одного шага стартуют разом, а не по очереди. Критерий спецификации — пачка из
// четырёх чтений отрабатывает за время одного вызова. Раньше это проверялось только по тексту main.js; здесь настоящий
// кусок цикла запускается с исполнителем, у которого каждый вызов стоит 120 мс.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parseToolArguments } = require('../src/main/tool-protocol.cjs')

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
const from = main.indexOf("    const parallelReads = new Set(")
const to = main.indexOf("    for (const call of stepResult.toolCalls) {\n      const toolName", from)
assert.ok(from > 0 && to > from, 'не найден блок параллельных чтений в main.js')
const prefetch = new Function('stepResult', 'allTools', 'signal', 'executeTool', 'parseToolArguments', 'event', 'payload', 'design',
  main.slice(from, to) + '\nreturn prefetched')

let failed = 0
const check = async (name, fn) => { try { await fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

const call = (id, name, args = { path: 'a.txt' }) => ({ id, function: { name, arguments: JSON.stringify(args) } })
const tools = ['read_file', 'list_files', 'search_files', 'find_symbol', 'write_file', 'run_command'].map(name => ({ function: { name } }))

function harness(calls, delay = 120) {
  const started = []
  const executeTool = (_e, name, args) => { started.push({ name, at: Date.now() }); return new Promise(r => setTimeout(() => r({ success: true, name }), delay)) }
  const t0 = Date.now()
  const prefetched = prefetch({ toolCalls: calls }, tools, undefined, executeTool, parseToolArguments, {}, { requestId: 'r' }, null)
  return { prefetched, started, t0 }
}

;(async () => {
  await check('четыре чтения стартуют вместе и готовы за время одного вызова', async () => {
    const { prefetched, started, t0 } = harness([call('1', 'read_file'), call('2', 'read_file', { path: 'b.txt' }), call('3', 'list_files', { path: '.' }), call('4', 'search_files', { query: 'x' })])
    assert.equal(prefetched.size, 4)
    assert.equal(started.length, 4, 'все четыре вызова должны уже идти')
    await Promise.all([...prefetched.values()])
    const took = Date.now() - t0
    assert.ok(took < 120 * 2, 'заняло ' + took + ' мс; последовательно было бы ~480')
  })

  await check('find_symbol идёт в той же пачке', async () => {
    const { prefetched } = harness([call('1', 'read_file'), call('2', 'find_symbol', { name: 'login' })])
    assert.equal(prefetched.size, 2)
    await Promise.all([...prefetched.values()])
  })

  await check('первый вызов с последствиями обрывает набор: чтение после записи не стартует заранее', async () => {
    const { prefetched, started } = harness([call('1', 'read_file'), call('2', 'write_file', { path: 'a.txt', content: 'x' }), call('3', 'read_file')])
    assert.equal(prefetched.size, 1)
    assert.deepEqual(started.map(s => s.name), ['read_file'])
    await Promise.all([...prefetched.values()])
  })

  await check('не больше восьми разом', async () => {
    const { prefetched } = harness(Array.from({ length: 12 }, (_, i) => call(String(i), 'read_file')))
    assert.equal(prefetched.size, 8)
    await Promise.all([...prefetched.values()])
  })

  await check('обрезанные аргументы не запускают вызов и обрывают набор', async () => {
    const bad = { id: 'x', function: { name: 'read_file', arguments: '{"path": "a.txt"' } }
    const { prefetched, started } = harness([call('1', 'read_file'), bad, call('3', 'read_file')])
    assert.equal(prefetched.size, 1)
    assert.equal(started.length, 1)
    await Promise.all([...prefetched.values()])
  })

  await check('инструмент, которого нет в наборе хода, не запускается', async () => {
    const { prefetched } = harness([call('1', 'read_file')], 10)
    const none = prefetch({ toolCalls: [call('1', 'find_symbol')] }, [{ function: { name: 'read_file' } }], undefined, () => Promise.resolve({}), parseToolArguments, {}, {}, null)
    assert.equal(none.size, 0)
    await Promise.all([...prefetched.values()])
  })

  if (failed) process.exit(1)
  console.log('Пакетный запуск чтений: проверки пройдены')
})()
