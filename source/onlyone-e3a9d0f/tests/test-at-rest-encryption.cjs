// test-at-rest-encryption.cjs: независимый тест шифрования данных на диске (П-1 и П-1б, «Всё на диске зашифровано»).
// Проверяет, что:
// 1. Контрольные точки ходов (run-checkpoints.js) шифруются.
// 2. Артефакты (artifacts.js) версиями и метаданными шифруются и не оставляют открытого текста.
// 3. Файлы макетов и референсы (design/store.js) шифруются и не содержат открытого текста на диске.
// 4. Расписания (schedule-store.js) шифруют текст просьб и историю.
// 5. Поддерживается бесшовная миграция старых открытых файлов при первом чтении.
// 6. Сквозной canary-тест: после полного цикла в userData нет ни одного вхождения секретной фразы.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createCheckpointStore } = require('../src/main/run-checkpoints')
const artifactsLib = require('../src/main/artifacts')
const { DesignStore } = require('../src/main/design/store')
const { createScheduleStore } = require('../src/main/schedule-store')

let checks = 0
const failures = []

function check(name, fn) {
  try {
    const res = fn()
    if (res && typeof res.then === 'function') {
      throw new Error(`Тест "${name}" вернул промис, используйте checkAsync`)
    }
    checks++
    console.log('ok    ', name)
  } catch (err) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', err.message)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    checks++
    console.log('ok    ', name)
  } catch (err) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', err.message)
  }
}

// Заглушка безопасного хранилища (обратимый mock safeStorage)
function createMockCipher({ ok = true } = {}) {
  let encryptCount = 0
  let decryptCount = 0
  return {
    protect(text) {
      encryptCount++
      if (!ok) throw new Error('safeStorage unavailable')
      return Buffer.from(text, 'utf8').toString('base64')
    },
    unprotect(base64) {
      decryptCount++
      if (!ok) throw new Error('safeStorage unavailable')
      return Buffer.from(base64, 'base64').toString('utf8')
    },
    protectBuffer(buf) {
      encryptCount++
      if (!ok) throw new Error('safeStorage unavailable')
      return Buffer.from(buf).toString('base64')
    },
    unprotectBuffer(base64) {
      decryptCount++
      if (!ok) throw new Error('safeStorage unavailable')
      return Buffer.from(base64, 'base64')
    },
    counts: () => ({ encrypt: encryptCount, decrypt: decryptCount })
  }
}

const tmpBase = path.join(os.tmpdir(), `1code-at-rest-test-${Date.now()}-${process.pid}`)
fs.mkdirSync(tmpBase, { recursive: true })

async function runAll() {
  try {
    // ---------------------------------------------------------------------------
    // Блок 1: Контрольные точки (run-checkpoints.js)
    // ---------------------------------------------------------------------------
    check('run-checkpoints: при наличии protect файл на диске зашифрован и не содержит открытого текста', () => {
      const dir = path.join(tmpBase, 'runs-chk-1')
      const cipher = createMockCipher()
      const store = createCheckpointStore({
        dir,
        protect: cipher.protect,
        unprotect: cipher.unprotect
      })

      const runId = '11112222-3333-4444-5555-666677778888'
      const secretTarget = 'deploy --token sk-or-v1-EXAMPLE0260c226abd381'
      const secretAsk = 'Пожалуйста, выполни релиз SECRET_REST_ASK_888'

      const run = store.start({
        runId,
        ask: secretAsk
      })
      run.begin('run_command', { command: secretTarget })

      const filePath = path.join(dir, `${runId}.json`)
      assert.ok(fs.existsSync(filePath), 'файл контрольной точки должен существовать на диске')

      const rawDisk = fs.readFileSync(filePath, 'utf8')
      assert.ok(!rawDisk.includes('SECRET_REST_TOKEN_777'), 'сырой файл не должен содержать открытый токен в target')
      assert.ok(!rawDisk.includes('SECRET_REST_ASK_888'), 'сырой файл не должен содержать открытый ask')

      const parsed = JSON.parse(rawDisk)
      assert.ok(parsed.ask.startsWith('enc:v1:'), 'поле ask должно быть запечатано enc:v1:')
      assert.ok(parsed.actions.length > 0, 'действие должно быть записано')
      assert.ok(!parsed.actions[0].target.includes('SECRET_REST_TOKEN_777'), 'секрет в target должен быть очищен')

      const interrupted = store.interrupted()
      assert.equal(interrupted.length, 1)
      assert.equal(interrupted[0].runId, runId)
      assert.ok(interrupted[0].ask.includes('SECRET_REST_ASK_888'), 'ask должен расшифровываться')
      assert.ok(interrupted[0].unknown.some(a => a.tool === 'run_command'), 'действие должно быть в unknown')
    })

    check('run-checkpoints: миграция старого открытого файла контрольной точки в зашифрованный при чтении', () => {
      const dir = path.join(tmpBase, 'runs-chk-migrate')
      fs.mkdirSync(dir, { recursive: true })

      const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000'
      const legacyPath = path.join(dir, `${runId}.json`)
      const legacyData = {
        schemaVersion: 1,
        runId,
        ask: 'СТАРЫЙ_ОТКРЫТЫЙ_ЗАПРОС_12345',
        startedAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        actions: [
          { seq: 1, tool: 'run_command', target: 'npm test', status: 'started', at: Date.now() }
        ]
      }
      fs.writeFileSync(legacyPath, JSON.stringify(legacyData))

      const cipher = createMockCipher()
      const store = createCheckpointStore({
        dir,
        protect: cipher.protect,
        unprotect: cipher.unprotect
      })

      const interrupted = store.interrupted()
      assert.equal(interrupted.length, 1)
      assert.equal(interrupted[0].runId, runId)
      assert.ok(interrupted[0].ask.includes('СТАРЫЙ_ОТКРЫТЫЙ_ЗАПРОС_12345'))

      const rawAfterMigration = fs.readFileSync(legacyPath, 'utf8')
      assert.ok(!rawAfterMigration.includes('СТАРЫЙ_ОТКРЫТЫЙ_ЗАПРОС_12345'), 'после миграции файл не должен содержать открытый ask на диске')
      const migrated = JSON.parse(rawAfterMigration)
      assert.ok(migrated.ask.startsWith('enc:v1:'))
    })

    check('run-checkpoints: запись «enc:v1: + открытый текст» читается и перешифровывается', () => {
      // Отпущенный код ставил метку и тогда, когда шифр вернул вход как есть:
      // после `enc:v1:` лежит открытый текст. Считать такую запись шифром —
      // значит отдать человеку мусор вместо просьбы и оставить текст на диске.
      const dir = path.join(tmpBase, 'runs-chk-sealed-plain')
      fs.mkdirSync(dir, { recursive: true })
      const runId = 'dddddddd-eeee-ffff-aaaa-bbbbbbbb0000'
      const ask = 'Перезапусти сборку и проверь порт 8080'
      const legacyPath = path.join(dir, `${runId}.json`)
      fs.writeFileSync(legacyPath, JSON.stringify({
        schemaVersion: 1,
        runId,
        ask: `enc:v1:${ask}`,
        startedAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        // Требования задачи отпущенный код запечатывал той же меткой поверх
        // открытого текста: они обязаны читаться так же, как просьба.
        task: { schemaVersion: 1, requirements: [{ id: 'r1', expected: 'enc:v1:Кнопка отмены работает', state: 'in_progress' }] },
        actions: []
      }))

      const cipher = createMockCipher()
      const store = createCheckpointStore({ dir, protect: cipher.protect, unprotect: cipher.unprotect })
      const [run] = store.interrupted()
      assert.equal(run.askUnreadable, false, 'открытый текст под меткой приняли за нечитаемый шифр')
      assert.equal(run.ask, ask, 'просьба прочиталась неверно: ' + run.ask)
      assert.equal(run.task.requirements[0].expected, 'Кнопка отмены работает', 'требование задачи потерялось')
      assert.equal(run.task.requirements[0].unreadable, undefined, 'требование пометили нечитаемым')

      const rawAfter = fs.readFileSync(legacyPath, 'utf8')
      assert.ok(!rawAfter.includes(ask), 'после чтения просьба осталась открытой на диске')
      const migrated = JSON.parse(rawAfter)
      assert.ok(migrated.ask.startsWith('enc:v1:'), 'метка шифра пропала')
      assert.equal(cipher.unprotect(migrated.ask.slice('enc:v1:'.length)), ask, 'перешифровка не читается своим же ключом')
      assert.ok(!rawAfter.includes('Кнопка отмены работает'), 'текст требования остался открытым на диске')
      assert.equal(cipher.unprotect(migrated.task.requirements[0].expected.slice('enc:v1:'.length)), 'Кнопка отмены работает')
    })

    check('run-checkpoints: без шифра «enc:v1: + открытый текст» читается, а файл не переписывается', () => {
      const dir = path.join(tmpBase, 'runs-chk-sealed-plain-nokey')
      fs.mkdirSync(dir, { recursive: true })
      const runId = 'cccccccc-dddd-eeee-ffff-000011112222'
      const ask = 'Почини тест отката и покажи diff'
      const legacyPath = path.join(dir, `${runId}.json`)
      const raw = JSON.stringify({
        schemaVersion: 1,
        runId,
        ask: `enc:v1:${ask}`,
        startedAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        actions: []
      })
      fs.writeFileSync(legacyPath, raw)

      const [run] = createCheckpointStore({ dir }).interrupted()
      assert.equal(run.askUnreadable, false, 'без шифра просьба потерялась')
      assert.equal(run.ask, ask, 'без шифра просьба прочиталась неверно: ' + run.ask)
      assert.equal(fs.readFileSync(legacyPath, 'utf8'), raw, 'без шифра файл переписали молча')
    })

    // ---------------------------------------------------------------------------
    // Блок 3: Артефакты (artifacts.js) - Шаг П-1б
    // ---------------------------------------------------------------------------
    await checkAsync('artifacts: при наличии protect/unprotect версии артефактов зашифрованы на диске', async () => {
      const dir = path.join(tmpBase, 'artifacts-enc-1')
      const cipher = createMockCipher()
      const store = artifactsLib.create({
        dir,
        protect: cipher.protect,
        unprotect: cipher.unprotect
      })

      const secretArtifactContent = '<html><body>СЕКРЕТНЫЙ_АРТЕФАКТ_HTML_77777</body></html>'
      const added = await store.add({
        chatId: 'chat-art-1',
        title: 'Секретный отчёт',
        kind: 'page',
        content: secretArtifactContent
      })

      const folder = store.folderOf(added.id)
      const versionFile = path.join(folder, added.versions[0].file)
      assert.ok(fs.existsSync(versionFile), 'файл версии должен быть на диске')

      const rawDisk = fs.readFileSync(versionFile, 'utf8')
      assert.ok(!rawDisk.includes('СЕКРЕТНЫЙ_АРТЕФАКТ_HTML_77777'), 'версия артефакта на диске не должна содержать открытый текст')

      // Чтение через versionText возвращает исходный текст
      const text = await store.versionText(added.id, 1)
      assert.equal(text, secretArtifactContent, 'versionText должен вернуть расшифрованный текст')
    })

    await checkAsync('artifacts: миграция старых незашифрованных версий при чтении', async () => {
      const dir = path.join(tmpBase, 'artifacts-migrate')
      const artId = 'legacyart001'
      const folder = path.join(dir, artId)
      fs.mkdirSync(folder, { recursive: true })

      const legacyContent = 'Легаси незашифрованный артефакт 88888'
      const versionFileName = '1-index.html'
      fs.writeFileSync(path.join(folder, versionFileName), legacyContent, 'utf8')
      const meta = {
        id: artId,
        kind: 'page',
        title: 'Легаси',
        chatId: 'chat-1',
        current: 1,
        versions: [{ n: 1, at: Date.now(), file: versionFileName, chars: legacyContent.length }]
      }
      fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta), 'utf8')

      const cipher = createMockCipher()
      const store = artifactsLib.create({
        dir,
        protect: cipher.protect,
        unprotect: cipher.unprotect
      })

      const text = await store.versionText(artId, 1)
      assert.equal(text, legacyContent, 'должен вернуть текст старого артефакта')

      // После чтения файл на диске должен стать зашифрованным!
      const rawAfter = fs.readFileSync(path.join(folder, versionFileName), 'utf8')
      assert.ok(!rawAfter.includes('88888'), 'после миграции файл версии артефакта должен быть зашифрован')
    })

    // ---------------------------------------------------------------------------
    // Блок 4: Дизайны и референсы (design/store.js) - Шаг П-1б
    // ---------------------------------------------------------------------------
    await checkAsync('design/store: при наличии protect/unprotect макеты и референсы зашифрованы на диске', async () => {
      const dir = path.join(tmpBase, 'designs-enc-1')
      const cipher = createMockCipher()
      const store = new DesignStore(dir, {
        protect: cipher.protect,
        unprotect: cipher.unprotect
      })

      const designId = 'secret-design-01'
      const secretHtml = '<p>СЕКРЕТНЫЙ_МАКЕТ_ДИЗАЙНА_12345</p>'
      await store.write(designId, 'Home', { template: secretHtml })

      const componentFile = path.join(store.folder(designId), 'Home.dc.html')
      assert.ok(fs.existsSync(componentFile), 'компонент должен быть на диске')

      const rawDisk = fs.readFileSync(componentFile, 'utf8')
      assert.ok(!rawDisk.includes('СЕКРЕТНЫЙ_МАКЕТ_ДИЗАЙНА_12345'), 'компонент на диске не должен содержать открытый текст')

      const component = await store.read(designId, 'Home')
      assert.ok(component.template.includes('СЕКРЕТНЫЙ_МАКЕТ_ДИЗАЙНА_12345'), 'read() должен вернуть расшифрованный шаблон')

      // Референс
      const secretRefData = 'СЕКРЕТНЫЙ_РЕФЕРЕНС_КАРТИНКА_67890'
      await store.writeRef(designId, 'logo.txt', Buffer.from(secretRefData, 'utf8'))
      const refFile = path.join(store.refsFolder(designId), 'logo.txt')
      assert.ok(fs.existsSync(refFile), 'файл референса должен существовать')

      const rawRefDisk = fs.readFileSync(refFile, 'utf8')
      assert.ok(!rawRefDisk.includes('СЕКРЕТНЫЙ_РЕФЕРЕНС_КАРТИНКА_67890'), 'референс на диске не должен быть открытым')

      const readRefRes = await store.readRef(designId, 'logo.txt')
      const readRefText = (readRefRes && typeof readRefRes === 'object' && readRefRes.text) ? readRefRes.text : readRefRes
      assert.equal(readRefText, secretRefData, 'readRef должен вернуть расшифрованные данные')
    })

    await checkAsync('design/store: экспорт (.png / .pdf) шифруется через store.writeExport и не оставляет открытого текста на диске (Н83)', async () => {
      const dir = path.join(tmpBase, 'designs-export-enc')
      const cipher = createMockCipher()
      const store = new DesignStore(dir, {
        protect: cipher.protect,
        unprotect: cipher.unprotect
      })

      const designId = 'export-design-01'
      const secretPngData = 'СЕКРЕТНЫЙ_PNG_СНИМОК_МАКЕТА_99999'
      const secretPdfData = 'СЕКРЕТНЫЙ_PDF_ДОКУМЕНТ_МАКЕТА_88888'

      const savedPng = await store.writeExport(designId, 'Home.png', Buffer.from(secretPngData, 'utf8'))
      assert.ok(fs.existsSync(savedPng.file), 'файл экспорта png должен существовать')

      const rawPngDisk = fs.readFileSync(savedPng.file, 'utf8')
      assert.ok(!rawPngDisk.includes('СЕКРЕТНЫЙ_PNG_СНИМОК_МАКЕТА_99999'), 'экспорт png на диске не должен быть открытым')
      const parsedPng = JSON.parse(rawPngDisk)
      assert.equal(parsedPng.enc, 'safeStorage')
      assert.equal(parsedPng.b64, true)

      const readPngBuf = await store.readExport(designId, 'Home.png')
      assert.equal(readPngBuf.toString('utf8'), secretPngData, 'readExport png должен вернуть исходный буфер')

      const savedPdf = await store.writeExport(designId, 'Home.pdf', Buffer.from(secretPdfData, 'utf8'))
      const rawPdfDisk = fs.readFileSync(savedPdf.file, 'utf8')
      assert.ok(!rawPdfDisk.includes('СЕКРЕТНЫЙ_PDF_ДОКУМЕНТ_МАКЕТА_88888'), 'экспорт pdf на диске не должен быть открытым')

      const readPdfBuf = await store.readExport(designId, 'Home.pdf')
      assert.equal(readPdfBuf.toString('utf8'), secretPdfData, 'readExport pdf должен вернуть исходный буфер')
    })

    // ---------------------------------------------------------------------------
    // Блок 5: Расписания (schedule-store.js) - Шаг П-1б
    // ---------------------------------------------------------------------------
    check('schedule-store: при наличии protect/unprotect файл schedules.json зашифрован на диске', () => {
      const dir = path.join(tmpBase, 'schedules-enc-1')
      const cipher = createMockCipher()
      const store = createScheduleStore({
        dir,
        protect: cipher.protect,
        unprotect: cipher.unprotect
      })

      const secretPrompt = 'ЕЖЕДНЕВНЫЙ_СЕКРЕТНЫЙ_ПРОМПТ_РАСПИСАНИЯ_555'
      store.upsert({
        id: 'sch-sec-1',
        name: 'Ночной бэкап',
        prompt: secretPrompt,
        cron: '0 3 * * *'
      })

      const schFile = path.join(dir, 'schedules.json')
      assert.ok(fs.existsSync(schFile), 'schedules.json должен быть на диске')

      const rawDisk = fs.readFileSync(schFile, 'utf8')
      assert.ok(!rawDisk.includes('ЕЖЕДНЕВНЫЙ_СЕКРЕТНЫЙ_ПРОМПТ_РАСПИСАНИЯ_555'), 'schedules.json не должен содержать открытый текст промпта')

      const list = store.list()
      assert.equal(list.length, 1)
      assert.equal(list[0].prompt, secretPrompt, 'store.list() должен вернуть расшифрованный промпт')
    })

    // ---------------------------------------------------------------------------
    // Блок 6: Сквозной Canary-тест по всей структуре userData - Шаг П-1б
    // ---------------------------------------------------------------------------
    await checkAsync('сквозной canary-тест: после полного цикла контрольной секретной фразы нет ни в одном файле userData', async () => {
      const mockUserData = path.join(tmpBase, 'canary-user-data')
      fs.mkdirSync(mockUserData, { recursive: true })

      const CANARY = 'CANARY_ULTRA_SECRET_TOKEN_2026_XYZ'
      const cipher = createMockCipher()

      // 1. Контрольная точка (валидный UUID)
      const chkStore = createCheckpointStore({
        dir: path.join(mockUserData, 'runs'),
        protect: cipher.protect,
        unprotect: cipher.unprotect
      })
      const r = chkStore.start({ runId: '11112222-3333-4444-5555-666677778888', ask: `Помоги с ${CANARY}` })
      r.begin('custom_tool', { param: `arg-${CANARY}` })

      // 3. Артефакт
      const artStore = artifactsLib.create({
        dir: path.join(mockUserData, 'artifacts'),
        protect: cipher.protect,
        unprotect: cipher.unprotect
      })
      await artStore.add({
        chatId: 'c1',
        title: `Отчёт ${CANARY}`,
        kind: 'code',
        content: `const secret = "${CANARY}";`
      })

      // 4. Дизайн
      const dStore = new DesignStore(path.join(mockUserData, 'designs'), {
        protect: cipher.protect,
        unprotect: cipher.unprotect
      })
      await dStore.write('d1', 'Page', { template: `<div>${CANARY}</div>` })
      await dStore.writeRef('d1', 'ref.txt', Buffer.from(`Ref data ${CANARY}`, 'utf8'))
      await dStore.writeExport('d1', 'canary-export.png', Buffer.from(`CANARY_PNG_${CANARY}`, 'utf8'))
      await dStore.writeExport('d1', 'canary-export.pdf', Buffer.from(`CANARY_PDF_${CANARY}`, 'utf8'))

      // 5. Расписание
      const schStore = createScheduleStore({
        dir: path.join(mockUserData, 'schedules'),
        protect: cipher.protect,
        unprotect: cipher.unprotect
      })
      schStore.upsert({ id: 'sch1', prompt: `Запусти ${CANARY}` })

      // Рекурсивный обход всех файлов mockUserData
      function findCanaryFiles(dir) {
        const found = []
        if (!fs.existsSync(dir)) return found
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            found.push(...findCanaryFiles(fullPath))
          } else if (entry.isFile()) {
            const content = fs.readFileSync(fullPath)
            if (content.includes(CANARY)) {
              found.push({ file: fullPath, content: content.toString('utf8').slice(0, 100) })
            }
          }
        }
        return found
      }

      const leaks = findCanaryFiles(mockUserData)
      assert.equal(leaks.length, 0, `В файлах userData обнаружены утечки открытого текста: ${JSON.stringify(leaks)}`)
    })

    // ---------------------------------------------------------------------------
    // Блок 7: Отказоустойчивость при отсутствии safeStorage
    // ---------------------------------------------------------------------------
    check('отказоустойчивость: все хранилища работают штатно, если protect/unprotect не переданы', () => {
      const dir = path.join(tmpBase, 'plain-fallback')
      const storeChk = createCheckpointStore({ dir: path.join(dir, 'runs') })
      const run = storeChk.start({ runId: '22223333-4444-5555-6666-777788889999', ask: 'Простой запрос' })
      run.begin('test_tool', { path: '/tmp/test' })
      assert.equal(storeChk.interrupted().length, 1)

      const storeSch = createScheduleStore({ dir: path.join(dir, 'sch') })
      storeSch.upsert({ id: 's1', prompt: 'plain prompt' })
      assert.equal(storeSch.list()[0].prompt, 'plain prompt')
    })

  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    } catch { /* clean up best effort */ }
  }

  console.log(`\nИтог test-at-rest-encryption: ${checks} успешно, ${failures.length} провалов.`)
  if (failures.length > 0) {
    process.exit(1)
  }
}

runAll().catch(err => {
  console.error('Непредвиденная ошибка в наборе тестов:', err)
  process.exit(1)
})
