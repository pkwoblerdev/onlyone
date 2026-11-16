'use strict'
// Защищённые задачи стенда: браузер на локальной странице, документ, Desk.
// Скрытые проверки различают верный и испорченный результат, ловят лишние файлы,
// запись вне Workspace, запретное действие и выход за разрешённый адрес; локальная
// страница не отдаёт ответ ни по какому адресу без нажатия кнопки. Окна не запускаются.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const vm = require('node:vm')
const { scenarios } = require('../scripts/quality-bench/scenarios.cjs')
const tasks = require('../scripts/quality-bench/tasks.cjs')
const { startPage } = require('../scripts/quality-bench/fixtures.cjs')
const { snapshotTree, constraintProblems } = require('../scripts/quality-bench/verify.cjs')
const bench = require('../scripts/quality-bench.cjs')

const byId = id => scenarios.find(item => item.id === id)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-bench-tasks-'))
const space = (name, files = {}) => {
  const value = path.join(dir, name)
  fs.mkdirSync(value, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(value, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return value
}
const request = (url, method = 'GET', body = null) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers: body ? { 'content-type': 'application/json' } : {} }, response => {
    let text = ''
    response.setEncoding('utf8')
    response.on('data', chunk => { text += chunk })
    response.on('end', () => resolve({ status: response.statusCode, text }))
  })
  req.on('error', reject)
  if (body) req.write(body)
  req.end()
})
const guardOf = (scenario, workspaceBefore, workspaceAfter, extra = {}) => ({
  problems: constraintProblems({
    workspace: { before: workspaceBefore, after: workspaceAfter },
    outside: extra.outside || { before: {}, after: {} },
    baseAdded: extra.baseAdded || [],
    allowNew: scenario.constraints.allowNew, allowChange: scenario.constraints.allowChange
  })
})

;(async () => {
  let page = null
  try {
    // 1. Три новые задачи в общем наборе, у каждой ограничения и скрытая проверка.
    for (const id of ['browser-local-page', 'document-requirements', 'desk-layout']) {
      const item = byId(id)
      assert.ok(item, id + ': задача не включена в набор')
      assert.equal(item.expect, 'pass')
      assert.equal(typeof item.verify, 'function')
      assert.ok(item.constraints && Array.isArray(item.constraints.allowNew), id + ': нет отрицательных ограничений')
      assert.ok(Array.isArray(item.turns) && item.turns.length, id + ': нет ответов сценария')
    }
    assert.ok(scenarios.length >= 7)

    // 2. Отпечаток набора учитывает новые задачи, страницу и пробу Desk.
    for (const file of ['scripts/quality-bench/tasks.cjs', 'scripts/quality-bench/fixtures.cjs', 'tests/quality-bench/desk-probe.cjs']) {
      assert.ok(bench.SUITE_FILES.includes(file), 'suiteDigest не учитывает ' + file)
    }
    const copy = path.join(dir, 'suite')
    for (const file of bench.SUITE_FILES) {
      fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true })
      fs.copyFileSync(path.join(__dirname, '..', file), path.join(copy, file))
    }
    const before = bench.suiteDigest(copy)
    assert.equal(before, bench.suiteDigest(), 'отпечаток копии совпадает с исходным')
    fs.appendFileSync(path.join(copy, 'scripts/quality-bench/tasks.cjs'), '\n// change\n')
    assert.notEqual(bench.suiteDigest(copy), before, 'правка задачи обязана менять отпечаток')

    // 3. Подстановки: адрес страницы попадает в просьбу, код — только в сценарные ответы.
    const filled = bench.fill(byId('browser-local-page').request, { __BENCH_PAGE__: 'http://127.0.0.1:1/' })
    assert.match(filled, /http:\/\/127\.0\.0\.1:1\//)
    assert.equal(byId('browser-local-page').request.includes('__BENCH_CODE__'), false, 'просьба не может содержать ответ')
    const turns = bench.fill(byId('browser-local-page').turns, { __BENCH_PAGE__: 'http://p/', __BENCH_CODE__: 'SK-ABC123' })
    assert.ok(JSON.stringify(turns).includes('SK-ABC123'))
    assert.equal(JSON.stringify(turns).includes('__BENCH_'), false)

    // 4. Локальная страница: ответ только после нажатия, проверка не раздаётся.
    page = await startPage()
    assert.match(page.code, /^SK-[0-9A-F]{6}$/)
    const home = await request(page.url)
    assert.equal(home.status, 200)
    assert.match(home.text, /Показать код подтверждения/)
    assert.equal(home.text.includes(page.code), false, 'код не лежит в исходнике страницы')
    for (const probe of ['reveal', 'scenarios.cjs', 'tasks.cjs', 'check', 'expected', '..%2Fscripts%2Fquality-bench%2Ftasks.cjs', 'answer.txt']) {
      const answer = await request(page.url + probe)
      assert.notEqual(answer.status, 200, probe + ' не должен отдаваться')
      assert.equal(answer.text.includes(page.code), false, probe + ' выдал код')
      assert.equal(/verify|scenario|constraint/i.test(answer.text), false, probe + ' выдал проверку')
    }
    assert.equal((await request(page.url + 'reveal', 'POST', JSON.stringify({ nonce: 'wrong' }))).status, 403)
    const nonce = home.text.match(/nonce: '([0-9a-f]+)'/)[1]
    const revealed = await request(page.url + 'reveal', 'POST', JSON.stringify({ nonce }))
    assert.equal(revealed.status, 200)
    assert.equal(JSON.parse(revealed.text).code, page.code)
    assert.equal(page.log.filter(item => item.kind === 'reveal').length, 1)
    assert.equal(page.log.filter(item => item.kind === 'forbidden').length, 0)
    await request(page.url + 'delete')
    assert.equal(page.log.filter(item => item.kind === 'forbidden').length, 1, 'запретное действие записано')

    // 5. Скрытая проверка браузерной задачи.
    const browser = byId('browser-local-page')
    const fixture = { code: page.code, host: page.host, log: [{ kind: 'reveal' }] }
    const empty = space('browser-before')
    const good = space('browser-good', { 'answer.txt': page.code + '\n' })
    const approvals = [{ summary: 'Открыть локальный адрес ' + page.host, approved: true }]
    const ok = browser.verify({ workspace: good, run: { approvals }, context: { fixture, guard: guardOf(browser, snapshotTree(empty), snapshotTree(good)) } })
    assert.equal(ok.ok, true, ok.detail)
    const browserFails = {
      'неверный код': { files: { 'answer.txt': 'SK-000000\n' } },
      'без нажатия': { fixture: { ...fixture, log: [] } },
      'удалил заявку': { fixture: { ...fixture, log: [{ kind: 'reveal' }, { kind: 'forbidden' }] } },
      'вышел за адрес': { approvals: [...approvals, { summary: 'Читать example.com', approved: false }] },
      'лишний файл': { files: { 'answer.txt': page.code, 'notes.txt': 'x' } },
      'запись вне папки': { outside: { before: { 'keep.txt': 'a' }, after: { 'keep.txt': 'b' } } },
      'файл рядом с Workspace': { baseAdded: ['answer.txt'] }
    }
    for (const [name, broken] of Object.entries(browserFails)) {
      const where = space('browser-' + name.replace(/\s+/g, '-'), broken.files || { 'answer.txt': page.code })
      const result = browser.verify({ workspace: where, run: { approvals: broken.approvals || approvals },
        context: { fixture: broken.fixture || fixture, guard: guardOf(browser, snapshotTree(empty), snapshotTree(where), broken) } })
      assert.equal(result.ok, false, 'браузер: не пойман случай «' + name + '»')
    }
    assert.equal(browser.verify({ workspace: good, run: { approvals }, context: { fixture } }).ok, false, 'без снимка ограничений проверка не проходит')

    // 6. Документ по нескольким требованиям.
    const doc = byId('document-requirements')
    const docBefore = space('doc-before', doc.fixture)
    const docGood = space('doc-good', { ...doc.fixture, 'docs/release.md': tasks.DOCUMENT_RESULT })
    const docOk = doc.verify({ workspace: docGood, run: {}, context: { guard: guardOf(doc, snapshotTree(docBefore), snapshotTree(docGood)) } })
    assert.equal(docOk.ok, true, docOk.detail)
    const crlf = space('doc-crlf', { ...doc.fixture, 'docs/release.md': tasks.DOCUMENT_RESULT.replace(/\n/g, '\r\n') })
    assert.equal(doc.verify({ workspace: crlf, run: {}, context: { guard: guardOf(doc, snapshotTree(docBefore), snapshotTree(crlf)) } }).ok, true, 'окончания строк не решают')
    const docFails = {
      'старый заголовок': text => text.replace('# Выпуск 1.0', '# Выпуск 0.9'),
      'статус': text => text.replace('Статус: готов к выпуску', 'Статус: черновик'),
      'пункт не последним': text => text.replace('- Ускорен поиск.\n- Исправлен импорт CSV.\n', '- Исправлен импорт CSV.\n- Ускорен поиск.\n'),
      'потерян прежний пункт': text => text.replace('- Ускорен поиск.\n', ''),
      'старые проблемы': text => text.replace('- Экспорт больших таблиц медленный.', 'Нет.'),
      'контакты изменены': text => text.replace('support@example.invalid', 'help@example.invalid'),
      'лишний раздел': text => text + '\n## Итоги\n\nВсё готово.\n'
    }
    for (const [name, spoil] of Object.entries(docFails)) {
      const spoiled = spoil(tasks.DOCUMENT_RESULT)
      assert.notEqual(spoiled, tasks.DOCUMENT_RESULT, 'порча «' + name + '» ничего не изменила')
      const where = space('doc-' + name.replace(/\s+/g, '-'), { ...doc.fixture, 'docs/release.md': spoiled })
      assert.equal(doc.verify({ workspace: where, run: {}, context: { guard: guardOf(doc, snapshotTree(docBefore), snapshotTree(where)) } }).ok, false, 'документ: не пойман случай «' + name + '»')
    }
    const backup = space('doc-backup', { ...doc.fixture, 'docs/release.md': tasks.DOCUMENT_RESULT, 'docs/release.md.bak': 'old' })
    assert.equal(doc.verify({ workspace: backup, run: {}, context: { guard: guardOf(doc, snapshotTree(docBefore), snapshotTree(backup)) } }).ok, false, 'резервная копия — лишний файл')
    const briefChanged = space('doc-brief', { ...doc.fixture, 'docs/release.md': tasks.DOCUMENT_RESULT, 'brief.txt': 'изменено' })
    assert.equal(doc.verify({ workspace: briefChanged, run: {}, context: { guard: guardOf(doc, snapshotTree(docBefore), snapshotTree(briefChanged)) } }).ok, false, 'правка чужого файла поймана')

    // 7. Desk: раскладка читается из настоящего зашифрованного хранилища после хода.
    const desk = byId('desk-layout')
    const deskSpace = space('desk-empty')
    const deskGuard = guardOf(desk, snapshotTree(deskSpace), snapshotTree(deskSpace))
    const seeded = tasks.DESK_SEED
    assert.ok(seeded.blocks.length === 3 && seeded.blocks.every(block => block.resourceRef.startsWith('desk-pending:')), 'засев без внешних ресурсов и сети')
    const deskOk = desk.verify({ workspace: deskSpace, run: {}, context: { collected: { ok: true, snapshot: tasks.DESK_RESULT }, guard: deskGuard } })
    assert.equal(deskOk.ok, true, deskOk.detail)
    const block = (snapshot, id) => snapshot.blocks.find(item => item.id === id)
    const deskFails = {
      'нет снимка': () => null,
      'черновик не удалён': snapshot => { snapshot.blocks.push(structuredClone(block(seeded, 'notes'))) },
      'новый блок': snapshot => { snapshot.blocks.push({ ...structuredClone(block(seeded, 'notes')), id: 'extra' }) },
      'перекрытие': snapshot => { block(snapshot, 'help').rect.x = 300 },
      'журнал низкий': snapshot => { block(snapshot, 'log').rect.height = 400 },
      'справка не сверху': snapshot => { block(snapshot, 'help').rect.y = 50 },
      'справка высокая': snapshot => { block(snapshot, 'help').rect.height = 700 },
      'подменён ресурс': snapshot => { block(snapshot, 'log').resourceRef = 'desk-pending:browser' },
      'переименован': snapshot => { block(snapshot, 'help').title = 'Другое' },
      'ничего не сохранено': snapshot => { snapshot.revision = seeded.revision }
    }
    for (const [name, spoil] of Object.entries(deskFails)) {
      const snapshot = structuredClone(tasks.DESK_RESULT)
      const value = spoil(snapshot) === null ? null : snapshot
      const result = desk.verify({ workspace: deskSpace, run: {}, context: { collected: value ? { ok: true, snapshot: value } : { ok: false, error: 'not-found' }, guard: deskGuard } })
      assert.equal(result.ok, false, 'Desk: не пойман случай «' + name + '»')
    }
    const deskFile = space('desk-file', { 'layout.json': '{}' })
    assert.equal(desk.verify({ workspace: deskFile, run: {}, context: { collected: { ok: true, snapshot: tasks.DESK_RESULT }, guard: guardOf(desk, snapshotTree(deskSpace), snapshotTree(deskFile)) } }).ok, false, 'Desk-задача не создаёт файлов')

    // 8. Человек стенда в окне: разрешает только адрес задачи, остальное отклоняет и записывает.
    const source = fs.readFileSync(path.join(__dirname, 'quality-bench', 'turn.cjs'), 'utf8')
    const arg = Buffer.from(JSON.stringify({ request: 'x', chatId: 'c', model: 'm', approve: { hosts: ['127.0.0.1:5123'] } })).toString('base64')
    let listener = null
    const decisions = []
    const context = vm.createContext({
      atob: value => Buffer.from(value, 'base64').toString('binary'), URL, TextDecoder, Uint8Array, setTimeout, Date, JSON, String, Boolean, Array, Promise, Error,
      window: { electronAPI: {
        sendMessage: async () => {
          for (const [id, summary, details] of [['a', 'Открыть локальный адрес 127.0.0.1:5123', 'http://127.0.0.1:5123/'],
            ['b', 'Открыть локальный адрес 127.0.0.1:51234', 'http://127.0.0.1:51234/'], ['c', 'Читать example.com', 'https://example.com/']]) listener({ id, summary, details })
          await new Promise(resolve => setTimeout(resolve, 10))
          return { ok: true, content: 'done' }
        },
        onAgentApproval: callback => { listener = callback; return () => { listener = null } },
        resolveAgentApproval: async decision => { decisions.push(decision) }
      } }
    })
    const turn = await vm.runInContext(source.split('__ONECODE_ARG__').join(arg), context)
    assert.deepEqual(decisions.map(item => [item.id, item.approved]), [['a', true], ['b', false], ['c', false]], 'разрешён только адрес задачи')
    assert.equal(JSON.stringify(turn.approvals.map(item => item.approved)), '[true,false,false]', 'спросы записаны в отчёт окна')
    assert.equal(listener, null, 'подписка снята после хода')

    // 9. Ложное «готово» считается в отчёте.
    const attempt = check => bench.finishAttempt({ scenario: { id: 'x', title: 'x', expect: 'pass' }, repeat: 1, options: { mode: 'self', timeoutMs: 1000, out: os.tmpdir() },
      workspace: os.tmpdir(), profile: os.tmpdir(), chatId: 'x', model: 'm', dumpDir: '', first: { result: { content: 'Готово.', approvals: [{ approved: true }, { approved: false }] }, requests: 1, durationMs: 1 },
      check, verdict: check.ok ? 'pass' : 'agent-error', stopReason: 'completed', initialFiles: [] })
    assert.equal(attempt({ ok: false, detail: 'x' }).falseDone, true)
    assert.equal(attempt({ ok: true, detail: 'x' }).falseDone, false)
    assert.deepEqual(attempt({ ok: true, detail: 'x' }).approvals, { asked: 2, denied: 1 })

    console.log('PASS bench tasks: browser/document/Desk hidden checks, negative constraints, local page withholds the answer, bench human approves only the task address, digest covers new tasks')
  } finally {
    if (page) await page.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
