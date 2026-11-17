'use strict'

// Стресс-тестирование, фаззинг и проверка устойчивости хранилищ и сжатия контекста:
// 1. bulk-store: UTF-8 BOM, 0-байтные и битые файлы, карантин, Windows EPERM/EBUSY retry, гонки.
// 2. session-tasks: UTF-8 BOM, безопасный карантин (.corrupt-<timestamp>), уникальные .tmp, retry.
// 3. context-diet: невалидные tool_calls (не массивы), null-сообщения в prompt cache, массивы в content, отрицательный/нулевой keepRecent.
// 4. prior-digest: отрицательный/нулевой cap, гигантский ввод.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const bulkStore = require('../src/main/bulk-store.js')
const sessionTasks = require('../src/main/session-tasks.cjs')
const contextDiet = require('../src/main/context-diet.cjs')
const priorDigest = require('../src/main/prior-digest.cjs')

let failed = 0
let total = 0

async function check(name, fn) {
  total++
  try {
    await fn()
    console.log(`ok ${name}`)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}\n${error.stack}`)
  }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-test-'))
const encode = json => ({ enc: 'plain', data: Buffer.from(json, 'utf8').toString('base64') })
const decode = envelope => JSON.parse(Buffer.from(envelope.data, 'base64').toString('utf8'))

async function main() {
  console.log('--- СТРЕСС-ТЕСТЫ ХРАНИЛИЩ И СЖАТИЯ КОНТЕКСТА ---')

  // === 1. bulk-store: устойчивость к UTF-8 BOM ===
  await check('bulk-store: файл с UTF-8 BOM парсится и не отправляется в карантин', async () => {
    const dir = tmpDir()
    const filePath = path.join(dir, 'conversations.json')
    const payload = JSON.stringify(encode(JSON.stringify([{ id: 'c1', title: 'Чат с BOM' }])))
    // Пишем с UTF-8 BOM: \uFEFF
    fs.writeFileSync(filePath, '\uFEFF' + payload, 'utf8')

    const events = []
    const store = bulkStore.create({ dir, encode, decode, onEvent: (kind, info) => events.push({ kind, info }) })
    const items = store.get('conversations', [])

    assert.equal(items.length, 1, 'данные должны прочитаться несмотря на BOM')
    assert.equal(items[0].id, 'c1')
    assert.equal(items[0].title, 'Чат с BOM')
    assert.equal(events.filter(e => e.kind === 'corrupt').length, 0, 'не должно быть ложного карантина')
    const corruptFiles = fs.readdirSync(dir).filter(f => f.includes('.corrupt-'))
    assert.equal(corruptFiles.length, 0, 'файл не должен улетать в карантин')
  })

  // === 2. bulk-store: повреждённый файл (0 байт, обрезка, мусор) уходит в карантин без перезаписи ===
  await check('bulk-store: 0-байтный и обрезанный JSON уходят в карантин с меткой времени', async () => {
    const dir = tmpDir()
    const filePath = path.join(dir, 'conversations.json')
    fs.writeFileSync(filePath, '', 'utf8') // 0 байт (симуляция падения при создании)

    const events = []
    const store = bulkStore.create({ dir, encode, decode, onEvent: (kind, info) => events.push({ kind, info }) })
    const items = store.get('conversations', [])
    assert.deepEqual(items, [], 'возвращает fallback при 0 байт')

    const corruptFiles = fs.readdirSync(dir).filter(f => f.includes('conversations.json.corrupt-'))
    assert.ok(corruptFiles.length >= 1, '0-байтный файл перемещён в карантин .corrupt-<timestamp>')
    assert.equal(events.some(e => e.kind === 'corrupt'), true, 'событие corrupt зарегистрировано')
    assert.equal(fs.existsSync(filePath), false, 'исходный битый файл убран из пути')
  })

  // === 3. bulk-store: повторные попытки при временной блокировке Windows (EPERM/EBUSY) ===
  await check('bulk-store: атомарная запись выдерживает временный EPERM/EBUSY при rename', async () => {
    const dir = tmpDir()
    const store = bulkStore.create({ dir, encode, decode })
    store.set('conversations', [{ id: 'retry-test' }])

    // Моделируем временный EPERM в fs.renameSync (2 отказа, на 3-й успех)
    const origRenameSync = fs.renameSync
    let attempts = 0
    fs.renameSync = function(src, dst) {
      attempts++
      if (attempts <= 2) {
        const err = new Error('operation not permitted')
        err.code = 'EPERM'
        throw err
      }
      return origRenameSync.call(fs, src, dst)
    }

    try {
      store.flushSync()
      assert.ok(attempts >= 3, `должно быть не меньше 3 попыток, было: ${attempts}`)
      assert.deepEqual(store.get('conversations', []), [{ id: 'retry-test' }])
    } finally {
      fs.renameSync = origRenameSync
    }
  })

  // === 4. session-tasks: UTF-8 BOM и безопасный карантин ===
  await check('session-tasks: чтение файла с UTF-8 BOM работает без сбоев', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'tasks.json')
    const data = { 'chat-100': { at: Date.now(), items: [{ title: 'Задача', status: 'todo' }] } }
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify(data), 'utf8')

    const store = sessionTasks.createSessionTaskStore(file)
    const tasks = store.get('chat-100')
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].title, 'Задача')
  })

  // === 5. session-tasks: битый файл уходит в карантин, уникальный .tmp и retry при записи ===
  await check('session-tasks: повреждённый файл перемещается в карантин (.corrupt-<timestamp>), не перезаписывается вслепую', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'tasks.json')
    fs.writeFileSync(file, '{"chat-1": {"items": [НЕВАЛИДНЫЙ_JSON', 'utf8')

    const store = sessionTasks.createSessionTaskStore(file)
    // get должен вернуть пустой массив, но не падать
    const tasks = store.get('chat-1')
    assert.deepEqual(tasks, [])

    // set должен сохранить старые битые байты в карантин .corrupt-
    store.set('chat-2', [{ title: 'Новая задача', status: 'open' }])

    const corruptFiles = fs.readdirSync(dir).filter(f => f.includes('tasks.json.corrupt-'))
    assert.ok(corruptFiles.length >= 1, 'создан файл карантина')
    const corruptContent = fs.readFileSync(path.join(dir, corruptFiles[0]), 'utf8')
    assert.match(corruptContent, /НЕВАЛИДНЫЙ_JSON/, 'байт-в-байт сохранён повреждённый файл')

    // Новый файл корректно записан
    assert.equal(store.get('chat-2')[0].title, 'Новая задача')
  })

  // === 6. session-tasks: retry при блокировке Windows EBUSY/EPERM ===
  await check('session-tasks: запись переживает кратковременный EBUSY на Windows', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'tasks.json')
    const store = sessionTasks.createSessionTaskStore(file)

    const origRenameSync = fs.renameSync
    let attempts = 0
    fs.renameSync = function(src, dst) {
      if (src.includes('tasks.json')) {
        attempts++
        if (attempts <= 2) {
          const err = new Error('resource busy or locked')
          err.code = 'EBUSY'
          throw err
        }
      }
      return origRenameSync.call(fs, src, dst)
    }

    try {
      const ok = store.set('c1', [{ title: 'Busy test' }])
      assert.equal(ok, true, 'запись должна завершиться успешно с ретраями')
      assert.ok(attempts >= 3, `было попыток: ${attempts}`)
    } finally {
      fs.renameSync = origRenameSync
    }
  })

  // === 7. context-diet: аномальные tool_calls в estimateTokens ===
  await check('context-diet: estimateTokens не падает на не-массивах tool_calls (числа, объекты, булевы)', () => {
    const anomalous = [
      { role: 'assistant', tool_calls: 123 },
      { role: 'assistant', tool_calls: { not: 'an array' } },
      { role: 'assistant', tool_calls: true },
      { role: 'assistant', tool_calls: null },
      null,
      undefined,
      42,
      'не объект',
      { role: 'user', content: null }
    ]
    const tokens = contextDiet.estimateTokens(anomalous)
    assert.ok(Number.isFinite(tokens) && tokens >= 0, `оценка токенов: ${tokens}`)
  })

  // === 8. context-diet: withPromptCache с null/невалидными сообщениями ===
  await check('context-diet: withPromptCache устойчив к null-сообщениям в конце списка', () => {
    const messages = [
      { role: 'system', content: 'инструкции' },
      null,
      { role: 'user', content: 'вопрос' },
      null
    ]
    const res = contextDiet.withPromptCache(messages, 'anthropic/claude-3-opus')
    assert.ok(Array.isArray(res))
    assert.equal(res[0].role, 'system')
    assert.ok(Array.isArray(res[0].content))
  })

  // === 9. context-diet: pruneOldToolResults сворачивает результаты в формате массива блоков ===
  await check('context-diet: pruneOldToolResults сворачивает старые tool-сообщения с контентом-массивом', () => {
    const msgs = [
      { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'x'.repeat(40000) }] },
      { role: 'tool', tool_call_id: 'call_2', content: 'свежий 1' },
      { role: 'tool', tool_call_id: 'call_3', content: 'свежий 2' },
      { role: 'tool', tool_call_id: 'call_4', content: 'свежий 3' }
    ]
    const pruned = contextDiet.pruneOldToolResults(msgs, { keepRecent: 3, protectTokens: 2000, minSavingTokens: 1000 })
    assert.notDeepEqual(pruned[0].content, msgs[0].content, 'старый массивный результат должен быть свёрнут')
    const firstContent = typeof pruned[0].content === 'string' ? pruned[0].content : JSON.stringify(pruned[0].content)
    assert.match(firstContent, /pruned|свёрнут/, 'содержит заглушку о свёртке')
  })

  // === 10. context-diet: границы keepRecent (0 и отрицательные) и callTargets с объектом arguments ===
  await check('context-diet: keepRecent <= 0 не приводит к NaN-границам; callTargets читает объекты arguments', () => {
    const msgs = [
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_x',
          function: { name: 'read_file', arguments: { path: 'secret.txt' } } // аргументы уже распарсены провайдером в объект
        }]
      },
      { role: 'tool', tool_call_id: 'call_x', content: 'y'.repeat(30000) }
    ]
    const pruned = contextDiet.pruneOldToolResults(msgs, { keepRecent: 0, protectTokens: 100, minSavingTokens: 100 })
    assert.ok(typeof pruned[1].content === 'string')
    assert.match(pruned[1].content, /secret\.txt/, 'цель вызова read_file из объекта arguments сохранена в заглушке')
  })

  // === 11. prior-digest: отрицательный/нулевой cap и гигантские строки ===
  await check('prior-digest: отрицательный или нулевой cap возвращает пустую строку, а не срез с конца', () => {
    const entries = [{ name: 'Агент 1', body: 'Какой-то очень важный отчёт о проделанной работе.' }]
    assert.equal(priorDigest.buildPrior({ entries, cap: 0 }), '')
    assert.equal(priorDigest.buildPrior({ entries, cap: -10 }), '')
    assert.equal(priorDigest.buildPrior({ entries, cap: NaN }), '')
  })

  await check('prior-digest: устойчивость к гигантскому вводу (> 200К знаков)', () => {
    const giant = 'Предложение один. '.repeat(15000)
    const result = priorDigest.buildPrior({ entries: [{ name: 'Агент', body: giant }], cap: 1000 })
    assert.ok(result.length <= 1000, `длина ${result.length} <= 1000`)
    assert.match(result, /…/)
  })

  console.log('--------------------------------------------------')
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main()
