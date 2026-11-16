// Адресный оконный прогон Н33: ключ шифрования мог не дожить до диска.
//
// Что здесь проверяется, а что нет — важно прочитать до правок.
//
// История и дизайны шифруются safeStorage (`src/main/bulk-store.js`), а ключ на
// Windows лежит в `<профиле>/Local State` и пишет его Chromium, не мы. Замер
// (2026-09-24, этим же прогоном и померено): после первого шифрования Chromium
// пишет `Local State` примерно через 9 секунд. Процесс, убитый извне раньше,
// уносит ключ вместе с собой: шифр на диске остался, а открыть его нечем.
//
// Поэтому прогон разделён на две части, и путать их нельзя:
//
//   (а) ФАКТ, не зависящий от фикса: ключ мог не дожить до диска. Он и создаёт
//       условие сценария — проверка «ключа нет в профиле в момент убийства».
//       Если Chromium когда-нибудь начнёт писать `Local State` сразу, эта
//       проверка покраснеет первой: значит сценарий больше не воспроизводится и
//       прогон надо пересматривать целиком, а не чинить чтение.
//
//   (б) ПОВЕДЕНИЕ ПРИ ЧТЕНИИ после перезапуска — тот самый контракт правки 24.09:
//       чтение целого, но нечитаемого файла ничего с ним не делает; главный
//       процесс называет причину (окно `get-storage-status` отдаёт нечитаемые
//       наборы по именам, человеку показывается объяснение); первое сохранение
//       уносит прежние байты в архив `.key-lost-<дата>`, а не стирает их и не
//       превращает приложение в кирпич.
//
// Если Chromium когда-нибудь начнёт писать `Local State` сразу, краснёт проверка
// из (а) — значит сценарий больше не воспроизводится и прогон надо пересматривать
// целиком, а не чинить чтение.
//
// Сети, настоящих ключей и живой модели нет: тестовый провайдер (ONECODE_SMOKE),
// временный профиль, и всё шифрование — настоящее, тем же safeStorage. Красный
// прогон оставляет профиль на диске ради разбора, зелёный удаляется.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const history = require('./history-store.cjs')

const root = path.join(__dirname, '..')
// Каталог заводит общий helper: путь печатается сразу (звено живёт минутами, и
// зависший прогон без строки RUN DIR не найти), зелёный забирает его, красный —
// оставляет вместе с профилем и журналом.
const output = runDir('onlyone-key-loss')
const profile = path.join(output, 'profile')
const dataDir = path.join(profile, 'data')
const MARK = 'КЛЮЧ-НЕ-ДОЖИЛ-ДО-ДИСКА-' + process.pid
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = []
const observations = []
const line = (group, name, pass, detail) => report.push({ group, name, pass: Boolean(pass),
  detail: detail === undefined ? '' : String(detail) })
const observe = text => observations.push(String(text))

const ARGS = ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile]

const PRELUDE = `
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 30000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(100) }
    return false
  }
  await until(() => document.documentElement.dataset.appReady === '1')
`

// Окно читает через те же IPC, что и живой интерфейс. Вызов может кончиться
// ошибкой — это тоже результат, и он не должен ронять прогон: всё ловится.
const READ_BODY = `
  const grab = async fn => { try { const v = await fn(); return { value: Array.isArray(v) ? v : null, threw: '' } }
    catch (e) { return { value: null, threw: String((e && e.message) || e) } } }
  const countMessages = list => (list || []).reduce((n, chat) => n + ((chat.messages || []).length), 0)
  const conv = await grab(() => window.electronAPI.getConversations())
  const des = await grab(() => window.electronAPI.getDesigns())
  const status = await window.electronAPI.getStorageStatus().catch(() => null)
  return { ok: true, mark: ${JSON.stringify(MARK)},
    chats: (conv.value || []).length, messages: countMessages(conv.value),
    chatsText: JSON.stringify(conv.value || []).slice(0, 4000),
    conversationsThrew: conv.threw,
    designs: (des.value || []).length, designsText: JSON.stringify(des.value || []).slice(0, 4000),
    designsThrew: des.threw, unreadable: (status && status.unreadable) || [], status }
`

// Отдельный запуск на ту же историю: попытка сохранить пустой список. Чтение не
// должно трогать файл, а вот первая запись обязана унести прежние байты в архив,
// который сам называется, что случилось.
const WRITE_BODY = `
  let threw = ''
  try { await window.electronAPI.setConversations([{ id: 'm1', title: 'пусто', messages: [] }]) }
  catch (e) { threw = String((e && e.message) || e) }
  const again = await window.electronAPI.getConversations().catch(() => null)
  return { ok: true, threw, savedBack: (again || []).length }
`

// --- состояние ключа в профиле: сам файл пишет Chromium, нам важно, есть ли в
// --- нём os_crypt.encrypted_key
function keyState () {
  const file = path.join(profile, 'Local State')
  if (!fs.existsSync(file)) return { file: false, key: false, bytes: 0 }
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch (error) { return { file: true, key: false, bytes: -1, error: error.code } }
  let key = false
  try { key = Boolean(JSON.parse(text).os_crypt?.encrypted_key) } catch { key = /encrypted_key/.test(text) }
  return { file: true, key, bytes: text.length }
}

function dataFiles () {
  try { return fs.readdirSync(dataDir) } catch { return [] }
}

// Ждём, пока оба шифра лягут на диск. Порядок записей в окне такой, что
// designs пишется раньше conversations, поэтому появление conversations.json
// означает «наш набор записан», а не «приложение само что-то сохранило на старте».
async function waitForCipher (timeoutMs) {
  const stop = Date.now() + timeoutMs
  while (Date.now() < stop) {
    // Раскладку набора выбирает хранилище (v1 — файл, v2 — индекс и шарды);
    // прогону важен шифр на диске, а не имена файлов.
    if (history.historyPresent(profile) && fs.existsSync(path.join(dataDir, 'designs.json'))) {
      await sleep(700)
      return {
        conversations: history.liveParts(profile),
        conversationsBytes: history.historyBytes(profile),
        designs: safeRead(path.join(dataDir, 'designs.json'))
      }
    }
    await sleep(50)
  }
  return { conversations: null, designs: null }
}

function safeRead (file) {
  try { return fs.readFileSync(file) } catch { return null }
}

// Запуск, который не должен дожить до штатного выхода: окно пишет историю и
// висит, родитель убивает процесс сразу после того, как шифр появился на диске —
// то есть заведомо раньше ~9-секундного коммита `Local State`.
async function runUntilDeath () {
  const script = path.join(output, 'writer.js')
  fs.writeFileSync(script, `(async () => {${PRELUDE}
    await window.electronAPI.getStorageStatus().catch(() => null)
    await window.electronAPI.setDesigns([{ id: 'd1', name: ${JSON.stringify(MARK)} }])
    await window.electronAPI.setConversations([{ id: 'm1', title: 'адресный прогон', updatedAt: Date.now(),
      messages: [{ role: 'user', content: ${JSON.stringify(MARK)} },
        { role: 'assistant', content: 'ответ, который нельзя потерять молча' }] }])
    await new Promise(() => {})
  })()`)
  const logFile = path.join(output, 'writer.stdout.log')
  const log = fs.openSync(logFile, 'w')
  const child = spawn(electronBinary(), ARGS, { cwd: root, stdio: ['ignore', log, log],
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SHOT: '',
      ONECODE_SMOKE_OUT: path.join(output, 'writer-never-written.json') }) })
  const died = new Promise(resolve => child.once('exit', (code, signal) => resolve(signal || code)))
  let spawnError = ''
  child.once('error', error => { spawnError = error.message })

  const cipher = await waitForCipher(60000)
  const stateBeforeKill = keyState()
  child.kill('SIGKILL')
  const exited = await Promise.race([died, sleep(20000).then(() => 'не закрылся')])
  fs.closeSync(log)
  return { ...cipher, stateBeforeKill, exited, spawnError }
}

// Обычный запуск окна с отчётом в файл.
function runAndReport (name, body, timeoutMs = 120000) {
  const script = path.join(output, name + '.js')
  const out = path.join(output, name + '.json')
  fs.writeFileSync(script, `(async () => {${PRELUDE}${body}})()`)
  const result = spawnSync(electronBinary(), ARGS, { cwd: root, timeout: timeoutMs, stdio: 'pipe',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SHOT: '' }) })
  if (result.error) return { harnessError: result.error.message }
  if (!fs.existsSync(out)) return { missing: true, stderr: String(result.stderr || '').slice(-400) }
  try { return JSON.parse(fs.readFileSync(out, 'utf8')) } catch (error) { return { broken: String(error.message) } }
}

// Конверт, который не читается из-за ключа, обязан быть целым: иначе это другой
// дефект — обрезанная запись, и лечить его надо иначе.
function envelopeIsWhole (bytes) {
  if (!bytes) return { whole: false, why: 'нет байт' }
  let envelope = null
  try { envelope = JSON.parse(bytes.toString('utf8')) } catch (error) { return { whole: false, why: 'JSON конверта не разобран: ' + error.message } }
  const body = Buffer.from(String(envelope?.data || ''), 'base64')
  const decodes = envelope?.enc === 'safeStorage' && body.length > 16 && !/[^A-Za-z0-9+/=]/.test(String(envelope.data))
  return { whole: decodes, why: decodes ? '' : `enc=${envelope?.enc} длина после base64=${body.length}` }
}

// Был ли исходный шифр сохранён в профиле (под любым именем — как именно его
// уносят, решает правка).
function cipherStillOnDisk (bytesOrParts) {
  const parts = Array.isArray(bytesOrParts) ? bytesOrParts
    : bytesOrParts ? [{ name: 'conversations.json', bytes: bytesOrParts }] : []
  if (!parts.length) return { found: false }
  const names = []
  for (const part of parts) {
    const name = history.findBytes(profile, part.bytes)
    if (!name) return { found: false, missing: part.name }
    names.push(name)
  }
  return { found: true, name: names.join(', ') }
}

// Лежат ли исходные байты именно под каноническим именем — то есть чтение их
// не тронуло.
function canonicalNote (parts) {
  const current = history.liveParts(profile)
  if (!current.length) return 'живого набора истории на диске нет'
  const shape = list => list.map(part => part.name + '=' + part.bytes.length).join(' + ')
  return shape(current) === shape(parts) ? 'набор = исходные ' + shape(current)
    : `набор перезаписан: ${shape(current)} вместо ${shape(parts)}`
}

const G_DEATH = 'смерть до того, как ключ дожил до диска'
const G_READ = 'перезапуск на том же профиле'
const G_CONTROL = 'контроль: ключ дожил до диска'

async function main () {
  fs.mkdirSync(profile, { recursive: true })

  // 1 — запись истории и смерть процесса до коммита `Local State`.
  const death = await runUntilDeath()
  line(G_DEATH, 'окно с записью истории запустилось', !death.spawnError, death.spawnError)
  line(G_DEATH, 'шифр истории и шифр дизайнов легли на диск до смерти процесса',
    Boolean(death.conversations && death.designs),
    dataFiles().join(', ') || 'папки data/ нет')
  line(G_DEATH, 'процесс убит извне, а не завершился штатно', death.exited === 'SIGKILL', String(death.exited))

  // (а) тот самый факт, который от поведения чтения не зависит
  line(G_DEATH, 'ключ шифрования НЕ дожил до диска: в профиле нет encrypted_key (условие сценария)',
    !death.stateBeforeKill.key, `Local State: файл=${death.stateBeforeKill.file} ключ=${death.stateBeforeKill.key}`)

  const convEnvelope = history.historyWholeParts(death.conversations)
  line(G_DEATH, 'файл истории цел: конверт разбирается, это «ключ не подошёл», а не «файл обрезан»',
    convEnvelope.whole, convEnvelope.why)
  const designsEnvelope = envelopeIsWhole(death.designs)
  line(G_DEATH, 'файл дизайнов цел: те же признаки', designsEnvelope.whole, designsEnvelope.why)

  // 2 — перезапуск: что человек видит и что осталось на диске.
  const read = runAndReport('reader', READ_BODY)
  line(G_READ, 'окно перезапуска отчиталось', !read.missing && !read.broken && !read.harnessError,
    read.harnessError || read.missing ? `нет отчёта окна; ${read.stderr || read.broken || ''}` : '')

  // Чтение само по себе файл не трогает; но окно на старте заводит новый пустой
  // чат и сохраняет его — и вот первая запись обязана унести прежний шифр в
  // архив, а не стёреть. Поэтому про «не уничтожено» здесь проверяется по
  // байтам, а не по имени.
  const convBytesAlive = cipherStillOnDisk(death.conversations)
  line(G_READ, 'шифр истории не уничтожен: байты лежат в профиле — под своим именем или в архиве',
    convBytesAlive.found, convBytesAlive.name || 'исходный конверт не найден')
  const designsUntouched = cipherStillOnDisk(death.designs)
  line(G_READ, 'чтение не тронуло конверт дизайнов: он на месте под своим именем',
    designsUntouched.name === 'designs.json', designsUntouched.name || 'исходный конверт не найден')
  line(G_READ, 'ничего не унесено под именем «испорченный»',
    !dataFiles().some(name => name.includes('.corrupt-')), dataFiles().join(', '))
  line(G_READ, 'причина названа: главный процесс отдаёт нечитаемые наборы по именам',
    read.unreadable?.includes('conversations') && read.unreadable?.includes('designs'),
    JSON.stringify(read.unreadable || []))
  const seesChats = String(read.chatsText || '').includes(MARK)
  line(G_READ, 'переписка не потеряна молча: окно либо видит запись, либо знает причину',
    seesChats || Boolean(read.conversationsThrew) || read.unreadable?.includes('conversations'),
    `чатов=${read.chats} сообщений=${read.messages} нечитаются=${JSON.stringify(read.unreadable || [])}`)
  const seesDesigns = String(read.designsText || '').includes(MARK)
  line(G_READ, 'дизайны не потеряны молча: то же условие',
    seesDesigns || Boolean(read.designsThrew) || read.unreadable?.includes('designs'),
    `дизайнов=${read.designs} нечитаются=${JSON.stringify(read.unreadable || [])}`)

  // 2б — первая запись: прежнее должно уехать в архив с внятным именем, а
  // приложение обязано остаться работоспособным (кирпич вместо аварии — тоже
  // потеря, только гарантированная).
  const wrote = runAndReport('writer-after', WRITE_BODY)
  line(G_READ, 'окно с первой записью отчиталось', wrote.ok === true, wrote.harnessError || wrote.stderr || '')
  const archived = fs.readdirSync(dataDir).filter(name => name.includes('.key-lost-'))
  line(G_READ, 'первая запись унесла нечитаемую историю в архив, а не стёрла её',
    archived.some(name => /^conversations(\.json)?\.key-lost-/.test(name)) &&
    cipherStillOnDisk(death.conversations).found, archived.join(', ') || 'архива нет')
  line(G_READ, 'архив называется причиной, а не «испорченный файл»',
    archived.length > 0 && !archived.some(name => name.includes('.corrupt-')), archived.join(', '))
  line(G_READ, 'после аварии можно сохранить новое', wrote.threw === '' && wrote.savedBack === 1,
    `${wrote.threw || 'запись прошла'}; чатов теперь ${wrote.savedBack}`)

  describeCurrentBehaviour(death, read, wrote)

  // 3 — контроль на том же профиле: теперь ключ успевает дожить до диска (окно
  // живёт дольше ~9-секундного коммита и выходит штатно), и та же история
  // читается. Это отделяет «ключ не подошёл» от «хранилище сломано вообще».
  const control = runAndReport('control-writer', `
    await window.electronAPI.setDesigns([{ id: 'd1', name: ${JSON.stringify(MARK)} }])
    await window.electronAPI.setConversations([{ id: 'm1', title: 'контроль', updatedAt: Date.now(),
      messages: [{ role: 'user', content: ${JSON.stringify(MARK)} },
        { role: 'assistant', content: 'ответ контроля' }] }])
    await wait(24000)
    return { ok: true }
  `, 150000)
  line(G_CONTROL, 'окно контроля отчиталось', control.ok === true, control.harnessError || control.stderr || '')
  const stateAfterControl = keyState()
  line(G_CONTROL, 'после штатного выхода ключ шифрования есть в профиле', stateAfterControl.key,
    `файл=${stateAfterControl.file}`)
  const rereread = runAndReport('reader-after-control', READ_BODY)
  const controlReadable = String(rereread.chatsText || '').includes(MARK)
  line(G_CONTROL, 'с живым ключом та же история читается после перезапуска', controlReadable,
    `чатов=${rereread.chats} сообщений=${rereread.messages} ошибка IPC=${rereread.conversationsThrew || 'нет'}`)
}

// То, что видно глазами на ТЕКУЩЕМ коде. Строки намеренно не участвуют в коде
// выхода: правка их переименует, а разбору они помогают.
function describeCurrentBehaviour (death, read, wrote) {
  observe(`момент смерти: Local State файл=${death.stateBeforeKill.file} ключ=${death.stateBeforeKill.key}; ` +
    `шифр истории ${death.conversations ? death.conversationsBytes + ' Б' : 'не записан'}`)
  observe(`после перезапуска в data/: ${dataFiles().join(', ') || 'пусто'}`)
  observe(`чтение: ${canonicalNote(death.conversations)}; нечитаются=${JSON.stringify(read.unreadable || [])}`)
  observe(`первая запись: ${wrote.threw || 'прошла'}; архивы: ` +
    (fs.readdirSync(dataDir).filter(name => name.includes('key-lost')).join(', ') || 'нет'))
  const logLines = latencyMentions('conversations')
  const notWritten = logLines.filter(text => !text.includes(' data written '))
  observe(`журнал главного процесса: строк про conversations — ${logLines.length}, из них не «успешная запись» — ${notWritten.length}` +
    (notWritten.length ? `; первая такая: ${notWritten[0].slice(0, 240)}` : ''))
  observe(`окно после перезапуска: чатов=${read.chats}, сообщений=${read.messages}, дизайнов=${read.designs}, ` +
    `ошибка IPC=${read.conversationsThrew || 'нет'}, encryptionAvailable=${read.status?.encryptionAvailable}`)
  const control = latencyMentions('designs')
  observe(`журнал про designs: строк ${control.length}${control.length ? `; последняя: ${control[control.length - 1].slice(0, 220)}` : ''}`)
}

function latencyMentions (needle) {
  const file = path.join(profile, 'logs', 'latency.log')
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(text => text.includes(needle))
  } catch { return [] }
}

main().then(() => {
  let failed = 0
  for (const group of [...new Set(report.map(item => item.group))]) {
    console.log('\n# ' + group)
    for (const item of report.filter(entry => entry.group === group)) {
      if (!item.pass) failed++
      console.log((item.pass ? 'ok     ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    }
  }
  if (observations.length) {
    console.log('\n# видно сейчас (не влияет на код выхода)')
    for (const text of observations) console.log('· ' + text)
  }
  console.log(`\nпроверок: ${report.length}, провалов: ${failed}`)
  console.log(JSON.stringify({ ok: failed === 0, failed, checks: report.length, output, profile }))
  // Красный прогон остаётся на диске: без профиля и журнала непонятно, какой из
  // двух исходов — «ключа не было» или «файл битый». Зелёный не нужен никому.
  settleRun(output, failed === 0)
  process.exit(failed === 0 ? 0 : 1)
}).catch(error => {
  console.error('харнесс упал: ' + error.stack)
  console.error('профиль прогона: ' + profile)
  console.log(JSON.stringify({ ok: false, error: String(error?.message || error), output, profile }))
  process.exit(2)
})
