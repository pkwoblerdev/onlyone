// Потерянный ключ шифрования: данные не должны исчезать молча (план, Н33/Н35).
//
// На Windows ключ `safeStorage` лежит в <профиль>/Local State, и пишет его Chromium
// сам — примерно через 9 с после первого шифрования (замер в
// tests/run-key-loss-ui.cjs). Если в этот промежуток процесс убит снаружи, при
// следующем запуске файл истории цел, а расшифровать его нечем. Прежнее поведение:
// файл переименовывается в `*.corrupt-<ts>`, окно получает пустой список, через
// полсекунды туда же пишется пустая история, а человек видит «я потерял чаты» без
// всякой причины. Здесь проверяются две разные беды и граница между ними.
//
// Модуль `bulk-store.js` — настоящий. Из `main.js` вырезаны и вызваны по-настоящему
// `bulkKeyLost`, `noticeKeyLoss` и обработчик `dismiss-interrupted-run`: они и есть
// интеграция, о которой идёт речь. Заглушены только `dialog`, списки ходов и
// состояние хранилища.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
// Оба пути можно подменить только мутационному харнессу
// `audits/qoder-2-2026-09-24/key-loss-mutation.cjs`: он возвращает в копию прежние
// строки и проверяет, что этот набор краснеет именно своей проверкой. В общем
// прогоне переменные не выставлены, и читаются канонические исходники.
const BULK_PATH = process.env.ONECODE_BULK_UNDER_TEST || '../src/main/bulk-store'
const { create } = require(BULK_PATH)
const { createProfileNotice } = require('../src/main/profile-notice.cjs')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr
const main = fs.readFileSync(process.env.ONECODE_MAIN_UNDER_TEST ||
  path.join(root, 'src', 'main', 'main.js'), 'utf8')

function at(marker, from = 0) {
  const index = main.indexOf(marker, from)
  assert.ok(index >= 0, 'якорь пропал из main.js: ' + marker)
  return index
}
const cut = (from, to) => main.slice(at(from), at(to, at(from) + from.length))

const KEYS = {
  // Тот же предикат, что передаёт главный процесс: «наш» — только шифрованный
  // конверт, `{enc:'plain'}` с битым содержимым остаётся битым содержимым.
  isEnvelope: envelope => Boolean(envelope && typeof envelope === 'object'
    && envelope.enc === 'safeStorage' && typeof envelope.data === 'string')
}

let checks = 0
const failures = []
function check(name, fn) {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-key-loss-'))
// Как только в этом файле появился первый провал, убирать каталоги перестаём:
// без них «плавающая» проверка неразличима с проверкой сломанной, а содержимое
// здесь и есть доказательство (шифр, архив, отказ переноса). Путь печатается —
// иначе улики остаются только в принципе «где-то в %TEMP%».
const dropDir = (dir) => {
  if (failures.length) { console.error('улики оставлены: ' + dir); return }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (error) { console.error('не убран ' + dir + ': ' + error.message) }
}
const file = (dir, key) => path.join(dir, `${key}.json`)
const SECRET = 'Секретная переписка: токен sk-or-v1-EXAMPLE233cf8ed4'

// Шифр «работает», только когда у хранилища есть ключ: так эмулируется профиль,
// где Local State не дожил до диска.
function cipher(key) {
  return {
    encode: json => ({ enc: 'safeStorage', data: Buffer.from(json + '|' + key.value, 'utf8').toString('base64') }),
    decode: envelope => {
      const text = Buffer.from(envelope.data, 'base64').toString('utf8')
      const at = text.lastIndexOf('|')
      if (text.slice(at + 1) !== key.value) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return JSON.parse(text.slice(0, at))
    }
  }
}

try {
  // -------------------------------------------------------------------------
  // A. Модуль: две разные беды
  // -------------------------------------------------------------------------

  check('целый шифрованный конверт не переименовывается в .corrupt-*', () => {
    const dir = mkDir()
    try {
      const key = { value: 'ключ-1' }
      const store = create({ dir, ...cipher(key), isEnvelope: KEYS.isEnvelope })
      store.set('conversations', [{ id: 'c1', messages: [{ role: 'user', content: SECRET }] }])
      store.flushSync()
      const bytes = fs.readFileSync(file(dir, 'conversations'), 'utf8')

      // Новый процесс: ключ другой (Local State не дожил) — файл на месте.
      const orphan = create({ dir, ...cipher({ value: 'ключ-2' }), isEnvelope: KEYS.isEnvelope })
      assert.deepEqual(orphan.get('conversations', []), [], 'нечитаемый набор должен отдавать пустой список')
      assert.equal(fs.readFileSync(file(dir, 'conversations'), 'utf8'), bytes, 'байты сдвинуты или переименованы')
      assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('corrupt')), [],
        'файл ушёл в карантин, хотя он целый')
    } finally { dropDir(dir) }
  })

  check('набор с потерянным ключом назван по имени, а не просто пуст', () => {
    const dir = mkDir()
    try {
      const store = create({ dir, ...cipher({ value: 'k' }), isEnvelope: KEYS.isEnvelope })
      store.set('designs', [{ id: 'd1' }])
      store.flushSync()
      const broken = create({ dir, ...cipher({ value: 'другой' }), isEnvelope: KEYS.isEnvelope })
      broken.get('designs', [])
      assert.deepEqual(broken.integrity().keyLost, ['designs'], 'причина не названа')
      assert.deepEqual(broken.integrity().blocked, [],
        'набор заблокирован навсегда — авария превращается в кирпич')
      // Первое сохранение уводит файл в архив, и `keyLost` пустеет; сказать
      // человеку про отказ чтения нужно и после этого.
      broken.set('designs', [])
      broken.flushSync()
      assert.deepEqual(broken.integrity().keyLost, [], 'архивированный набор чисится нечитаемым сейчас')
      assert.deepEqual(broken.integrity().unreadable, ['designs'],
        'причина исчезла из отчёта вместе с файлом')
    } finally { dropDir(dir) }
  })

  check('первое сохранение уносит нечитаемое в архив, а не стирает', () => {
    const dir = mkDir()
    try {
      const key = { value: 'k1' }
      const store = create({ dir, ...cipher(key), isEnvelope: KEYS.isEnvelope })
      store.set('conversations', [{ id: 'c1', messages: [SECRET] }])
      store.flushSync()
      const bytes = fs.readFileSync(file(dir, 'conversations'), 'utf8')

      const broken = create({ dir, ...cipher({ value: 'k2' }), isEnvelope: KEYS.isEnvelope })
      assert.deepEqual(broken.get('conversations', []), [])
      assert.equal(fs.readFileSync(file(dir, 'conversations'), 'utf8'), bytes, 'чтение уже тронуло файл')
      broken.set('conversations', [])
      broken.flushSync()
      const aside = fs.readdirSync(dir).filter(name => name.includes('.key-lost-'))
      assert.equal(aside.length, 1, 'прежние байты не отложены в архив: ' + fs.readdirSync(dir).join(', '))
      assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), bytes, 'архив отличается от исходного шифра')
      assert.ok(!aside[0].includes('.corrupt-'), 'архив назван как порчу файла, а не как потерянный ключ')
      const next = create({ dir, ...cipher({ value: 'k2' }), isEnvelope: KEYS.isEnvelope })
      next.set('conversations', [{ id: 'c2' }])
      next.flushSync()
      assert.deepEqual(create({ dir, ...cipher({ value: 'k2' }), isEnvelope: KEYS.isEnvelope })
        .get('conversations', []), [{ id: 'c2' }], 'после аварии историю нельзя сохранить')
    } finally { dropDir(dir) }
  })

  check('ключ вернулся — то же содержимое читается само, без ручных переносов', () => {
    const dir = mkDir()
    try {
      const key = { value: 'k1' }
      const store = create({ dir, ...cipher(key), isEnvelope: KEYS.isEnvelope })
      const data = [{ id: 'c1', messages: [{ role: 'user', content: SECRET }] }]
      store.set('conversations', data)
      store.flushSync()
      const broken = create({ dir, ...cipher({ value: 'нет' }), isEnvelope: KEYS.isEnvelope })
      assert.deepEqual(broken.get('conversations', []), [])
      const healed = create({ dir, ...cipher(key), isEnvelope: KEYS.isEnvelope })
      assert.deepEqual(healed.get('conversations', []), data, 'данные не дожились возврата ключа')
      assert.deepEqual(healed.integrity().keyLost, [], 'целый набор числится потерянным')
    } finally { dropDir(dir) }
  })

  check('обрезанная запись по-прежнему уходит в карантин и не блокирует жизнь', () => {
    const dir = mkDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file(dir, 'conversations'), '{"enc":"safeStorage","data":"обр')
      const store = create({ dir, ...cipher({ value: 'k' }), isEnvelope: KEYS.isEnvelope })
      assert.deepEqual(store.get('conversations', []), [])
      assert.deepEqual(store.integrity().keyLost, [], 'обрубленный файл записан как потерянный ключ')
      store.set('conversations', [['заново']])
      store.flushSync()
      assert.ok(fs.readdirSync(dir).some(name => name.includes('.corrupt-')),
        'обрезанный файл не убран в сторону — прежняя ветка сломана')
    } finally { dropDir(dir) }
  })

  check('непонятная запись (не наш конверт) не блокирует хранилище навсегда', () => {
    const dir = mkDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file(dir, 'designs'), JSON.stringify([['совсем старое']]))
      const store = create({ dir, ...cipher({ value: 'k' }), isEnvelope: KEYS.isEnvelope })
      store.get('designs', [])
      assert.deepEqual(store.integrity().keyLost, [], 'чужой формат принят за потерю ключа')
      store.set('designs', [{ id: 'd1' }])
      store.flushSync()
      assert.deepEqual(create({ dir, ...cipher({ value: 'k' }), isEnvelope: KEYS.isEnvelope }).get('designs', []),
        [{ id: 'd1' }], 'после чужого формата запись не работает')
    } finally { dropDir(dir) }
  })

  check('открытая запись с битым содержимым — прежний карантин, не потеря ключа', () => {
    const dir = mkDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file(dir, 'conversations'), JSON.stringify({ enc: 'plain', data: 'X' }))
      const store = create({ dir, ...cipher({ value: 'k' }), isEnvelope: KEYS.isEnvelope })
      store.get('conversations', [])
      assert.deepEqual(store.integrity().keyLost, [], 'открытая запись с ошибкой принята за потерю ключа')
    } finally { dropDir(dir) }
  })

  // Общий аудит 01.11, Н1: карантин нечитаемого файла не учитывался нигде, кроме
  // журнала. Человек видел «у вас нет чатов», а первое сохранение затирало набор.
  check('карантин битого файла числится нечитаемым за запуск и назван порчей', () => {
    const dir = mkDir()
    try {
      const key = { value: 'k' }
      const store = create({ dir, ...cipher(key), isEnvelope: KEYS.isEnvelope })
      store.set('conversations', [{ id: 'c1', messages: [SECRET] }])
      store.flushSync()
      fs.writeFileSync(file(dir, 'conversations'), '{"enc":"safeStorage","data":"обр')
      const fresh = create({ dir, ...cipher(key), isEnvelope: KEYS.isEnvelope })
      assert.deepEqual(fresh.get('conversations', []), [])
      assert.deepEqual(fresh.integrity().unreadable, ['conversations'],
        'статит хранилища врёт: битый набор не назван нечитаемым')
      assert.deepEqual(fresh.integrity().corrupt, ['conversations'], 'причина не названа порчей файла')
      assert.deepEqual(fresh.integrity().keyLost, [], 'битый файл записан как потерянный ключ')
      // Тот же механизм для дизайнов: карантин должен учитываться одинаково.
      fs.writeFileSync(file(dir, 'designs'), 'совсем не json {{{')
      const withDesigns = create({ dir, ...cipher(key), isEnvelope: KEYS.isEnvelope })
      withDesigns.get('designs', [])
      assert.ok(withDesigns.integrity().unreadable.includes('designs'), 'дизайны пропали из отчёта')
      assert.ok(withDesigns.integrity().corrupt.includes('designs'), 'порча дизайнов не названа порчей')
    } finally { dropDir(dir) }
  })

  check('о битом наборе говорят человеку, и причина — порча файла, а не ключ', () => {
    const dir = mkDir()
    try {
      fs.writeFileSync(file(dir, 'conversations'), '{"enc":"safeStorage","data":"обр')
      const store = create({ dir, ...cipher({ value: 'k' }), isEnvelope: KEYS.isEnvelope })
      store.get('conversations', [])
      const dialogCalls = []
      const notice = createProfileNotice({
        bulk: () => store,
        bulkKeys: new Set(['conversations', 'designs']),
        dialog: { showMessageBox: options => { dialogCalls.push(options); return Promise.resolve({ response: 0 }) } },
        app: { getPath: () => dir },
        join: path.join,
        tr: globalThis.tr,
        latency: { write: () => {} },
        fs
      }).noticeKeyLoss
      notice()
      assert.equal(dialogCalls.length, 1, 'о битом файле молчат: окно показалось ' + dialogCalls.length + ' раз')
      const text = dialogCalls[0].message + ' ' + dialogCalls[0].detail
      assert.match(text, /не разобрал/i, 'причина названа потерянным ключом: ' + text.slice(0, 120))
      assert.match(text, /\.corrupt-/, 'не сказано, куда уехали байты')
      assert.match(text, /не удал/i, 'не сказано, что архив нельзя трогать')
      notice()
      assert.equal(dialogCalls.length, 1, 'окно повторяется на каждый запрос')
    } finally { dropDir(dir) }
  })

  // -------------------------------------------------------------------------
  // B. Конфиденциальность: в журнал не уходит ни содержимое, ни длинные тексты
  // -------------------------------------------------------------------------

  check('событие о потере ключа не несёт ни данных, ни текста ошибки', () => {
    const dir = mkDir()
    try {
      const key = { value: 'k1' }
      const first = create({ dir, ...cipher(key), isEnvelope: KEYS.isEnvelope })
      first.set('conversations', [{ id: 'c1', messages: [{ role: 'user', content: SECRET }] }])
      first.flushSync()
      const events = []
      const broken = create({ dir, ...cipher({ value: 'k2' }), isEnvelope: KEYS.isEnvelope,
        onEvent: (kind, info) => events.push({ kind, info }) })
      broken.get('conversations', [])
      const mismatch = events.filter(event => event.kind === 'key-mismatch')
      assert.equal(mismatch.length, 1, 'событие о потере ключа не единственное: ' + JSON.stringify(events.map(e => e.kind)))
      const dumped = JSON.stringify(mismatch[0].info)
      assert.ok(!/sk-or-v1|Секретная переписка|decrypting/.test(dumped), 'в журнал уехало содержимое: ' + dumped)
      assert.equal(mismatch[0].info.key, 'conversations')
    } finally { dropDir(dir) }
  })

  check('длинный текст ошибки укорачивается до того, как попадёт в журнал', () => {
    const dir = mkDir()
    try {
      const events = []
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file(dir, 'conversations'), '{' + 'x'.repeat(5000))
      const store = create({ dir, ...cipher({ value: 'k' }), isEnvelope: KEYS.isEnvelope,
        onEvent: (kind, info) => events.push({ kind, info }) })
      store.get('conversations', [])
      const corrupt = events.find(event => event.kind === 'corrupt')
      assert.ok(corrupt, 'обрезанная запись не описана событием')
      assert.ok(corrupt.info.error.length <= 200, 'в журнал уехало ' + corrupt.info.error.length + ' знаков')
    } finally { dropDir(dir) }
  })

  check('в модуле не осталось мест, где ошибка уходит в журнал без обрезки', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'bulk-store.js'), 'utf8')
    const raw = source.split('\n')
      .map((text, index) => ({ text, line: index + 1 }))
      .filter(item => /onEvent\([^)]*String\(error/.test(item.text))
    assert.deepEqual(raw, [], 'открытый текст ошибки в журнале: ' + raw.map(item => item.line).join(', '))
  })

  // -------------------------------------------------------------------------
  // C. Интеграция в главном процессе
  // -------------------------------------------------------------------------

  // Окно живёт в `profile-notice.cjs` (вынос А-3): проверяется настоящий модуль,
  // а не копия строк из main.js.
  function buildNotice(integrity, dialogCalls) {
    return createProfileNotice({
      bulk: () => ({ integrity }),
      bulkKeys: new Set(['conversations', 'designs']),
      dialog: { showMessageBox: options => { dialogCalls.push(options); return Promise.resolve({ response: 0 }) } },
      app: { getPath: () => 'C:\\profile' },
      join: path.join,
      tr: globalThis.tr,
      latency: { write: () => {} },
      fs
    }).noticeKeyLoss
  }

  check('пустой список чатов из-за ключа показывается человеку, а не молчит', () => {
    const dialogCalls = []
    const notice = buildNotice(() => ({ keyLost: ['conversations'], unreadable: ['conversations'], blocked: [] }), dialogCalls)
    notice()
    assert.equal(dialogCalls.length, 1, 'о потере ключа не сказано')
    const text = dialogCalls[0].message + ' ' + dialogCalls[0].detail
    assert.ok(/не открыл/i.test(text), 'формулировка не про отказ чтения: ' + text.slice(0, 80))
    assert.ok(/не удаляйте|не изменены/i.test(text), 'не сказано, что байты на месте: ' + text.slice(0, 200))
    notice()
    assert.equal(dialogCalls.length, 1, 'человек будет получать это окно на каждый запрос')
  })

  check('при живых наборах никакого окна нет', () => {
    const dialogCalls = []
    buildNotice(() => ({ keyLost: [], unreadable: [], blocked: [] }), dialogCalls)()
    assert.deepEqual(dialogCalls, [], 'пугающее окно на ровном месте')
  })

  check('в тексте объяснения нет ни содержимого, ни чужих путей', () => {
    const dialogCalls = []
    buildNotice(() => ({ keyLost: ['designs', 'conversations'], unreadable: ['designs', 'conversations'], blocked: [] }), dialogCalls)()
    const text = JSON.stringify(dialogCalls)
    assert.ok(!/sk-or-v1|Секретная/.test(text), 'в диалог уехало содержимое данных')
    assert.ok(/data/.test(text), 'не указано, где лежат файлы')
  })

  check('объяснение висит на обоих чтениях истории', () => {
    // Сами по себе эти строки — единственное, что превращает «пусто» в «не
    // открылось»: без вызова человек увидит молчаливую пустоту, каким бы хорошим
    // ни был обработчик ниже.
    const chats = cut("ipcMain.handle('get-conversations'", "ipcMain.handle('set-conversations'")
    const designs = cut("ipcMain.handle('get-designs'", "ipcMain.handle('set-designs'")
    assert.ok(chats.includes('noticeKeyLoss()'), 'чтение переписки молчит о причине')
    assert.ok(designs.includes('noticeKeyLoss()'), 'чтение дизайнов молчит о причине')
  })

  check('главный процесс отдаёт нечитаемые наборы по именам', () => {
    const status = cut("ipcMain.handle('get-storage-status'", "// Attachment IPCs")
    assert.ok(/unreadable: bulkIntegrity\(\)\.unreadable/.test(status),
      'в статусе не лежит список того, что не открылось')
  })

  const DISMISS = cut("ipcMain.handle('dismiss-interrupted-run'", "ipcMain.handle('abort-message'")

  function dismiss(run, keyLost) {
    let handler = null
    new Function('ipcMain', 'interruptedRunList', 'bulkKeyLost', 'runCheckpoints', DISMISS)(
      { handle: (_channel, fn) => { handler = fn } },
      () => [run],
      key => keyLost.includes(key),
      { dismiss: () => true })
    return handler(null, run.runId)
  }

  check('ход не снимается, когда его чат не найден из-за потерянного ключа', () => {
    const run = { runId: 'r1', chatId: 'c1', designId: null }
    assert.equal(dismiss(run, ['conversations']), false, 'память о прерванной работе стёрта вместе с историей')
    assert.equal(dismiss(run, []), true, 'при живом наборе снятие перестало работать')
  })

  check('ход Дизайна сверяется с набором Дизайнов, а не с чатами', () => {
    const run = { runId: 'r2', chatId: null, designId: 'd1' }
    assert.equal(dismiss(run, ['conversations']), true, 'дизайн-ход сняли из-за чужого набора')
    assert.equal(dismiss(run, ['designs']), false, 'дизайн-ход стёрся вместе с макетами')
  })

  check('если нечитаемое не унести, запись блокируется и говорит причину', () => {
    const dir = mkDir()
    const realRename = fs.renameSync
    try {
      const key = { value: 'k1' }
      const store = create({ dir, ...cipher(key), isEnvelope: KEYS.isEnvelope })
      store.set('conversations', [[SECRET]])
      store.flushSync()
      const bytes = fs.readFileSync(file(dir, 'conversations'), 'utf8')
      const broken = create({ dir, ...cipher({ value: 'k2' }), isEnvelope: KEYS.isEnvelope })
      broken.get('conversations', [])
      fs.renameSync = () => { throw new Error('файл занят другой программой') }
      let message = ''
      try { broken.set('conversations', []) } catch (error) { message = error.message }
      assert.ok(/не удалось убрать в сторону/.test(message), 'причина отказа не названа: ' + message)
      assert.ok(!/sk-or-v1|Секретная/.test(message), 'в текст ошибки уехало содержимое')
      assert.equal(fs.readFileSync(file(dir, 'conversations'), 'utf8'), bytes, 'нечитаемое перезаписано пустотой')
    } finally { fs.renameSync = realRename; dropDir(dir) }
  })

  check('ключ шифрования создаётся до первого сохранения, а не в его момент', () => {
    // Chromium пишет Local State сам, примерно через 9 с после первого
    // шифрования: чем раньше оно начнётся, тем раньше закрывается окно риска.
    const ready = at('app.whenReady().then(() => {')
    const warm = at('safeStorage.encryptString(', ready)
    const firstSave = at("ipcMain.handle('set-conversations'")
    assert.ok(warm > ready, 'ключ создаётся до готовности приложения — там safeStorage недоступен')
    assert.ok(warm < firstSave, 'окно риска начинается только с первой записи истории')
  })
} finally {
  if (failures.length) console.error(`\nпровалено проверок: ${failures.length} из ${checks + failures.length}`)
}
console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
process.exit(failures.length ? 1 : 0)
