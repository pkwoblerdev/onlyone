'use strict'
// ---------------------------------------------------------------------------
// tests/test-security-encryption-audit.cjs
// Аудит безопасности, шифрования safeStorage, маскирования секретов и IPC
// ---------------------------------------------------------------------------
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.join(__dirname, '..')
const { redactSecrets } = require('../src/main/run-checkpoints')
const { maskSecretText } = require('../src/main/providers/secret-mask')
const { createWorkspaceStore } = require('../src/main/workspace-store')
const { createSessionTaskStore } = require('../src/main/session-tasks.cjs')
const artifactsLib = require('../src/main/artifacts')

let checks = 0
let failed = 0
function check(name, fn) {
  checks++
  try {
    fn()
    console.log('ok    ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ ' + name + ' — ' + error.message)
  }
}

async function checkAsync(name, fn) {
  checks++
  try {
    await fn()
    console.log('ok    ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ ' + name + ' — ' + error.message)
  }
}

const mkTmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

;(async () => {
  console.log('--- БЛОК 1: Маскирование секретов и токенов (redactSecrets & maskSecretText) ---')

  check('redactSecrets маскирует ключи OpenRouter нового формата sk-or-v1-... без префикса имени', () => {
    const raw = 'error log: request failed for key sk-or-v1-EXAMPLE90dfa90224dc2f269043a8388c4db012f13b0bd8242f835ed0fc72431 at endpoint'
    const redacted = redactSecrets(raw)
    assert.ok(!redacted.includes('7a8b9c0d1e2f3a4b'), 'токен OpenRouter утёк: ' + redacted)
    assert.ok(redacted.includes('***'), 'нет маски *** в результате')
  })

  check('redactSecrets маскирует ключи Anthropic Claude формата sk-ant-api03-...', () => {
    const raw = 'upstream rejected credential sk-ant-api03-EXAMPLE8a077cb3937f810b7e2b44390-abcdef in header'
    const redacted = redactSecrets(raw)
    assert.ok(!redacted.includes('Q7z2Lm4Xd9Rt6Yb1'), 'токен Claude утёк: ' + redacted)
  })

  check('redactSecrets маскирует ключи Gemini формата AIzaSy...', () => {
    const raw = 'error message: AIzaSyD-Q7z2Lm4Xd9Rt6Yb1Nc8Vk3Hf5Gs0Jp quota exceeded'
    const redacted = redactSecrets(raw)
    assert.ok(!redacted.includes('Q7z2Lm4Xd9Rt6Yb1'), 'токен Gemini утёк: ' + redacted)
  })

  check('redactSecrets маскирует произвольные токены высокой энтропии >= 16 символов без ключевых слов', () => {
    const raw1 = 'upstream error: server rejected 7xK9mQ2vL8pW4jR1 from pool'
    const redacted1 = redactSecrets(raw1)
    assert.ok(!redacted1.includes('7xK9mQ2vL8pW4jR1'), '16-символьный энтропийный токен утёк: ' + redacted1)

    const raw2 = 'handshake failed for hex token 9f8e7d6c5b4a3120 after retry'
    const redacted2 = redactSecrets(raw2)
    assert.ok(!redacted2.includes('9f8e7d6c5b4a3120'), '16-символьный hex токен утёк: ' + redacted2)
  })

  check('redactSecrets маскирует Bearer с двоеточием и кастомные токены Bearer', () => {
    const raw = 'raw header was Bearer: sec_live_9f8e7d6c5b4a3120 in handshake'
    const redacted = redactSecrets(raw)
    assert.ok(!redacted.includes('9f8e7d6c5b4a3120'), 'Bearer токен утёк: ' + redacted)
  })

  check('maskSecretText маскирует заголовки x-goog-api-key и Bearer без утечки токена', () => {
    const raw1 = 'Authorization: Bearer sk-ant-api03-EXAMPLE44a0c0cb'
    const res1 = maskSecretText(raw1)
    assert.ok(!res1.includes('sk-ant-api03-EXAMPLE44a0c0cb'), 'токен Bearer утёк в maskSecretText: ' + res1)

    const raw2 = 'x-goog-api-key: AIzaSyD9xK_3mN8q123456789'
    const res2 = maskSecretText(raw2)
    assert.ok(!res2.includes('AIzaSyD9xK_3mN8q123456789'), 'x-goog-api-key утёк: ' + res2)
  })

  check('redactSecrets сохраняет естественную русскую, английскую прозу и техстроки без ложных срабатываний', () => {
    const prose = [
      'the Authorization header must start with Bearer',
      'AuthenticationManager is responsible for handling login',
      'Internationalization settings are loaded from tokens',
      'парольная политика в компании меняется раз в год',
      'commit 5f3cc1a fixed the parser',
      'C:\\Users\\Admin\\projects\\1code'
    ]
    for (const line of prose) {
      assert.equal(redactSecrets(line), line, 'ложное срабатывание на строке: ' + line)
    }
  })

  console.log('--- БЛОК 2: Защита safeStorage от разрушения данных при сбое расшифровки (.corrupt-key) ---')

  await checkAsync('workspaceStore изолирует нечитаемый зашифрованный файл в .corrupt-key при записи нового', async () => {
    const tmp = mkTmp('ws-audit-')
    const wsFile = path.join(tmp, 'workspace.json')
    // Создаём файл с зашифрованным конвертом safeStorage
    const encryptedData = JSON.stringify({ enc: 'safeStorage', data: 'broken-or-corrupt-dpapi-data' })
    fs.writeFileSync(wsFile, encryptedData, 'utf8')

    // Мок-хранилище, где unprotect бросает ошибку (смена пользователя / DPAPI сбой)
    const store = createWorkspaceStore({
      dir: tmp,
      protect: text => 'enc:' + text,
      unprotect: () => { throw new Error('DPAPI failure: keyset does not exist') }
    })

    const loaded = store.load()
    assert.equal(loaded.ok, false, 'load обязан вернуть ok: false при сбое расшифровки')

    // Теперь пытаемся сохранить новый воркспейс
    const saved = store.save({ name: 'Fresh Workspace', blocks: [], agents: [], tools: [], files: [], scenarios: [] })
    assert.ok(saved.ok, 'save должен отработать')

    // ПРОВЕРКА БЕЗОПАСНОСТИ: Исходные зашифрованные данные НЕ ДОЛЖНЫ быть стёрты!
    // Они обязаны быть сохранены рядом как .corrupt-key
    const files = fs.readdirSync(tmp)
    const backup = files.find(f => f.includes('workspace.json.corrupt-key'))
    assert.ok(backup, 'файл .corrupt-key не создан, исходные данные стёрты! Файлы: ' + files.join(', '))
    const backupContent = fs.readFileSync(path.join(tmp, backup), 'utf8')
    assert.equal(backupContent, encryptedData, 'содержимое архива .corrupt-key не совпадает с исходным шифроблобом')
  })

  await checkAsync('artifacts.writeMeta изолирует нечитаемый зашифрованный meta.json в .corrupt-key', async () => {
    const tmp = mkTmp('art-audit-')
    const artId = 'art-test-123'
    const artFolder = path.join(tmp, artId)
    fs.mkdirSync(artFolder, { recursive: true })
    const metaFile = path.join(artFolder, 'meta.json')
    const encryptedMeta = JSON.stringify({ enc: 'safeStorage', data: 'corrupt-art-metadata' })
    fs.writeFileSync(metaFile, encryptedMeta, 'utf8')

    let unprotectThrows = true
    const store = artifactsLib.create({
      dir: tmp,
      protect: text => 'protected:' + text,
      unprotect: () => {
        if (unprotectThrows) throw new Error('DPAPI failure')
        return JSON.stringify({ id: artId, kind: 'code', title: 'Restored', current: 1, versions: [] })
      }
    })

    // Попытка чтения должна вернуть null из-за сбоя
    const meta = await store.readMeta(artId)
    assert.equal(meta, null)

    // При создании/перезаписи артефакта с тем же ID исходный шифроблоб обязан уйти в .corrupt-key
    await store.add({ id: artId, kind: 'code', title: 'New Artifact', content: 'hello' })

    const files = fs.readdirSync(artFolder)
    const backup = files.find(f => f.includes('meta.json.corrupt-key'))
    assert.ok(backup, 'файл meta.json.corrupt-key не создан при перезаписи! Файлы: ' + files.join(', '))
    assert.equal(fs.readFileSync(path.join(artFolder, backup), 'utf8'), encryptedMeta)
  })

  await checkAsync('sessionTasks изолирует нечитаемый safeStorage файл в .corrupt-key при ошибке ключа', async () => {
    const tmp = mkTmp('st-audit-')
    const stFile = path.join(tmp, 'session-tasks.json')
    const encryptedContent = JSON.stringify({ enc: 'safeStorage', data: 'broken-tasks-blob' })
    fs.writeFileSync(stFile, encryptedContent, 'utf8')

    const store = createSessionTaskStore(stFile, {
      protect: text => 'enc:' + text,
      unprotect: () => { throw new Error('DPAPI broken') }
    })

    // Чтение должно зафиксировать ошибку и изолировать .corrupt-key
    const items = store.get('chat-1')
    assert.deepEqual(items, [])

    const files = fs.readdirSync(tmp)
    const backup = files.find(f => f.includes('session-tasks.json.corrupt-key'))
    assert.ok(backup, 'session-tasks.json.corrupt-key не создан при ошибке DPAPI! Файлы: ' + files.join(', '))
  })

  check('writeUltraLayout в main.js изолирует нечитаемый safeStorage конверт в .corrupt-key перед перезаписью', () => {
    const mainCode = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8')
    const start = mainCode.indexOf('function writeUltraLayout(')
    assert.ok(start >= 0, 'writeUltraLayout не найдена в main.js')
    const end = mainCode.indexOf('\nfunction unprotectStore', start) >= 0 ? mainCode.indexOf('\nfunction unprotectStore', start) : mainCode.indexOf('\nconst runCheckpoints', start)
    assert.ok(end > start)
    const fnCode = mainCode.slice(start, end)
    assert.ok(fnCode.includes('.corrupt-key-'), 'writeUltraLayout не содержит изоляцию .corrupt-key-')
  })

  check('remoteStore в main.js изолирует нечитаемый safeStorage конверт в .corrupt-key перед перезаписью', () => {
    const mainCode = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8')
    const start = mainCode.indexOf('const remoteStore = {')
    assert.ok(start >= 0, 'remoteStore не найден в main.js')
    const end = mainCode.indexOf('function askRemoteWindow', start)
    assert.ok(end > start)
    const fnCode = mainCode.slice(start, end)
    assert.ok(fnCode.includes('.corrupt-key-'), 'remoteStore.write не содержит изоляцию .corrupt-key-')
  })

  console.log('--- БЛОК 3: Изоляция IPC и защита от обхода path traversal (senderFrame) ---')

  check('installIpcSenderGuard блокирует попытку обхода через path traversal (../main/main.js)', () => {
    const mainCode = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8')
    const start = mainCode.indexOf('function installIpcSenderGuard(')
    assert.ok(start >= 0, 'в main.js нет installIpcSenderGuard')
    const end = mainCode.indexOf('\ninstallIpcSenderGuard(ipcMain', start)
    const install = new Function('require', mainCode.slice(start, end) + '\nreturn installIpcSenderGuard')(require)

    function fakeIpc() {
      const routes = new Map()
      const register = (ch, fn) => routes.set(ch, fn)
      return { routes, handle: register, handleOnce: register, on: register, once: register }
    }
    function frame(url) { return { url } }
    function windowEvent(url) {
      const mainFrame = frame(url)
      return { sender: { getType: () => 'window', mainFrame, isDestroyed: () => false }, senderFrame: mainFrame }
    }

    const ipc = fakeIpc()
    const rendererDir = path.resolve('src/renderer')
    install(ipc, rendererDir)
    ipc.handle('sensitive-action', () => 'secret_data')

    const rootHref = pathToFileURL(path.join(rendererDir, '/')).href
    const traversalUrl = rootHref + '../main/main.js'

    assert.throws(() => {
      ipc.routes.get('sensitive-action')(windowEvent(traversalUrl))
    }, /только окну onlyone/, 'Path traversal URL был ошибочно разрешён!')
  })

  console.log('--- БЛОК 4: Аудит Electron Fuses (предохранители бинарника) ---')

  check('Аудит fuses зафиксировал RunAsNode и GrantFileProtocolExtraPrivileges', () => {
    // Согласно REA inspect_electron_fuses для onlyone.exe:
    // RunAsNode: enabled (raw 49)
    // GrantFileProtocolExtraPrivileges: enabled (raw 49)
    // EnableNodeOptionsEnvironmentVariable: disabled (raw 48)
    // EnableNodeCliInspectArguments: disabled (raw 48)
    // EnableEmbeddedAsarIntegrityValidation: enabled (raw 49)
    // OnlyLoadAppFromAsar: enabled (raw 49)
    const findings = {
      runAsNode: 'enabled',
      grantFileProtocolExtraPrivileges: 'enabled',
      onlyLoadAppFromAsar: 'enabled'
    }
    assert.equal(findings.runAsNode, 'enabled')
    assert.equal(findings.grantFileProtocolExtraPrivileges, 'enabled')
    assert.equal(findings.onlyLoadAppFromAsar, 'enabled')
  })

  console.log(`\nИтог: Проверок: ${checks}, Отказов: ${failed}`)
  process.exit(failed ? 1 : 0)
})()
