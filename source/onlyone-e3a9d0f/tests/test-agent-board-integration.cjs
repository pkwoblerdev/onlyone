const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2] || path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
const board = require(path.join(root, 'src/main/agent-board.js'))
const cut = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start)
  assert(start >= 0 && end > start, 'missing production region: ' + from)
  return source.slice(start, end)
}
async function main() {
  const requestId = 'board-integration-test'
  board.seedBoard(requestId, [
    {agent: 'Агент 2', task: 'Правка', readOnly: false},
    {agent: 'Агент 3', task: 'Ревью', readOnly: true}
  ])
  try {
    // Both production tool-list builders, including the Design branch and
    // read-only assignments. No provider, Electron process or real workspace.
    const tools = ['read_file', 'write_file', 'board_update', 'agent_message', 'board_read']
      .map(name => ({type: 'function', function: {name}}))
    // Разбор режима «Дизайн» стоит в main.js перед списком инструментов
    // (isPureDesign): берём его оттуда же, как есть.
    const modeCode = cut('  const isPureDesign = Boolean(', '  // Набор пересобирается')
    const snippet = modeCode + cut(source.includes('  const BOARD_TOOLS =') ? '  const BOARD_TOOLS =' : '  const buildToolList =', '  const taskText =')
    const build = new Function('design', 'payload', 'TOOL_DEFINITIONS', 'boardSnapshot',
      'toolAllowedForAssignment', 'designToolSchemas', 'mcpManager', 'customToolSchemas',
      'projectToolSchemas', 'assignTool', 'mcpTools', 'ownTools', 'projectTools', 'slimToolsFor',
      snippet + ';return {allTools, buildToolList}')
    for (const design of [null, {id: 'design'}]) {
      for (const live of [true, false]) {
        const current = build(design, {requestId, readOnlyAssignment: true}, tools,
          () => ({items: live ? [{}] : []}), name => name !== 'write_file',
          () => [{function: {name: 'dc_read'}}], null, async () => [], () => [], [], [], [], [], list => list)
        for (const list of [current.allTools, await current.buildToolList()]) {
          const names = list.map(t => t.function.name)
          assert.equal(names.includes('board_read'), live)
          assert.equal(names.includes('board_update'), live)
          assert(!names.includes('write_file'))
        }
      }
    }
    const first = board.postMessage(requestId, 'Агент 2', {to: 'Агент 3', kind: 'question', body: 'Проверь границы массива'})
    const second = board.postMessage(requestId, 'Агент 2', {to: 'Агент 3', kind: 'question', body: 'Проверь отмену операции'})
    const brief = board.boardBrief(requestId, 'Агент 3')
    assert(brief.includes('Проверь границы массива') && brief.includes('Проверь отмену операции'))
    assert(brief.includes('письмо ' + first.id))
    // Поручение помощнику считается один раз и кладётся в переменную. Считать
    // вызовы boardBrief по всему файлу больше нельзя: доску теперь получает и
    // критик — без неё он не знал ни одного настоящего id пункта и не мог
    // сослаться на то, что критикует.
    assert.match(source, /const boardContext = boardBrief\(payload\.requestId, slot\.name\)/)
    assert.match(source, /\(boardContext \? '\\n\\n' \+ boardContext : ''\)/)

    // Вопрос и возражение показываются, пока на них не ответили. Раньше письмо
    // доставлялось ровно один раз: упавший помощник не видел его больше
    // никогда, а в списке неотвеченного оно оставалось навсегда — и приёмка
    // требовала от ведущего закрыть то, чего он закрыть не мог.
    const again = board.boardBrief(requestId, 'Агент 3')
    assert(again.includes('Проверь границы массива'),
      'неотвеченное письмо обязано прийти снова')
    assert.equal(board.postMessage(requestId, 'Агент 3', {to: 'Агент 2', kind: 'answer',
      body: 'Ответ без конкретного адреса'}).success, false)
    assert.equal(board.unanswered(requestId).length, 2)
    assert.equal(board.postMessage(requestId, 'Агент 3', {to: 'Агент 2', kind: 'answer',
      replyTo: first.id, body: 'Границы массива проверены'}).success, true)
    assert.deepEqual(board.unanswered(requestId).map(m => m.id), [second.id])
    assert.equal(board.postMessage(requestId, 'Агент 2', {to: 'Агент 99', kind: 'question', body: 'Ответь на этот вопрос'}).success, false)
    board.postMessage(requestId, 'Агент 3', {to: 'Агент 2', kind: 'answer', replyTo: second.id, body: 'Отмена операции проверена'})
    board.updateItem(requestId, 'Агент 2', {id: 't1', status: 'done', note: 'Исправил файл index.html'})
    board.updateItem(requestId, 'Агент 3', {id: 't2', status: 'done', note: 'Проверил результат исправления'})
    board.recordToolEvidence(requestId, {agent: 'Агент 2', tool: 'read_file', path: 'index.html', ok: true})
    assert(board.boardGaps(requestId).some(g => g.includes('не изменён')))
    board.recordToolEvidence(requestId, {agent: 'Агент 3', tool: 'write_file', path: 'other.html', ok: true})
    assert(board.boardGaps(requestId).some(g => g.includes('не изменён')), 'other agent cannot supply missing proof')
    board.recordToolEvidence(requestId, {agent: 'Агент 2', tool: 'write_file', path: 'index.html', ok: false})
    assert(board.boardGaps(requestId).some(g => g.includes('не изменён')), 'failed write cannot supply proof')
    board.recordToolEvidence(requestId, {agent: 'Агент 2', tool: 'write_file', path: 'index.html', ok: true})
    assert.deepEqual(board.boardGaps(requestId, []), [], 'helper evidence survives an empty leader log')
    assert(source.includes('recordToolEvidence(payload.requestId, logEntry)'))
    console.log('Board integration: tool lists, mailbox delivery, reply correlation, participants, write evidence passed')
  } finally { board.clearBoard(requestId) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
