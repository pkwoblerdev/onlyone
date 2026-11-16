// Н37: нечитаемый конверт в файле настроек — адресный прогон на настоящем окне.
//
// `readStoreSecure` в `src/main/main.js` при любой ошибке чтения ключа делал так:
//
//     if (!store.has(`${key}.corrupt.bak`)) store.set(`${key}.corrupt.bak`, raw)
//
// Имя с точкой для `electron-store` — не имя, а вложенный путь (dot-prop), и от
// формы значения зависит, что случится:
//
//   • значение-объект (`{enc:'safeStorage', data:…}`, а это ровно legacy-переписка
//     до переноса в свои файлы) — копия вставляется ВНУТРЬ того же конверта, файл
//     настроек удваивается и остаётся удвоенным навсегда; перечитывается и
//     переписывается целиком на каждое `store.set`;
//   • значение-строка или массив (`mcpServers`, `projects`, `skills`) — dot-prop
//     сначала выбрасывает исходное значение и ставит на его место `{}`: живой ключ
//     уничтожается, а спасённая копия осиротевшим вложенным объектом висит в
//     подставном.
//
// Обратно ни то, ни кто не читает: ни очистки, ни пути восстановления нет.
//
// Прогон на временном профиле показывает три случая: удвоение legacy-переписки,
// порчу строкового ключа и уже испорченный прежней версией профиль, где копия
// лежит вложенным `corrupt.bak`. Сети, настоящих ключей и живой модели нет;
// красный прогон оставляет профиль на диске.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
// Общий helper: путь каталога виден в журнале с первой секунды, зелёный прогон
// убирает свой каталог, красный — оставляет улики.
const output = runDir('onlyone-settings-archive')
const report = []
const observations = []
const line = (group, name, pass, detail) => report.push({ group, name, pass: Boolean(pass),
  detail: detail === undefined ? '' : String(detail) })
const observe = text => observations.push(String(text))

// ~400 КБ base64: рост файла становится числом, а прогон — не ожиданием диска.
// Случайные байты нужны затем, чтобы у содержимого был узнаваемый отпечаток и
// можно было считать, СКОЛЬКО раз копия лежит в файле: на это и проверяется дубль.
const BLOB = require('crypto').randomBytes(300 * 1024).toString('base64')
const MARK_OF_BLOB = BLOB.slice(0, 40)
// Сколько копий отпечатка лежит в одном значении — именно это и удваивал прежний
// механизм, и именно так проверка не путает два разных ключа одного профиля.
const blobCopies = value => JSON.stringify(value === undefined ? null : value).split(MARK_OF_BLOB).length - 1
const MARK = 'НАСТРОЙКИ-НЕ-ТРОГАТЬ-' + process.pid
const sizeKb = file => (fs.existsSync(file) ? Math.round(fs.statSync(file).size / 1024) : -1)
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

function launch(name, profile, extraEnv = {}) {
  const script = path.join(output, name + '.js')
  const out = path.join(output, name + '.json')
  fs.writeFileSync(script, `(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 25000) => {
      const stop = Date.now() + ms
      while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(100) }
      return false
    }
    await until(() => document.documentElement.dataset.appReady === '1')
    // appReady means the renderer can be tested, not that the main-process
    // settings migration/write queue has finished. Let that queue settle before
    // closing this short-lived window, or the second launch may finish the
    // first launch's write and look like a duplicate migration.
    await wait(3000)
    return { ok: true }
  })()`)
  const child = spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile],
    { cwd: root, timeout: 120000, stdio: 'inherit',
      env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out,
        ONECODE_SHOT: path.join(output, name + '.png'), ...extraEnv }) })
  if (child.error) throw child.error
  return { reported: fs.existsSync(out), stderr: String(child.stderr || '') }
}

// Один профиль — один случай: так измерения не накладываются друг на друга.
function scenario(name, seed, body) {
  const profile = path.join(output, name)
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify(seed))
  const settingsFile = path.join(profile, '1code-settings.json')
  const archiveDir = path.join(profile, 'settings-corrupt')
  const before = sizeKb(settingsFile)
  const result = launch(name, profile)
  const after = readJson(settingsFile)
  line(name, 'окно открылось и закрылось', result.reported, result.stderr.slice(-160))
  body({ profile, settingsFile, archiveDir, before, after })
  return { profile, settingsFile, archiveDir, after }
}

// ---------------------------------------------------------------------------
// A. Legacy-переписка в настройках: значение-объект. Прежний механизм удваивал
// файл и оставлял копию внутри того же конверта.
// ---------------------------------------------------------------------------
scenario('legacy-conversations', { conversations: { enc: 'safeStorage', data: BLOB } }, ctx => {
  observe(`A: файл настроек ${ctx.before} КБ → ${sizeKb(ctx.settingsFile)} КБ`)
  observe(`A: ключи conversations после запуска: ${JSON.stringify(Object.keys(ctx.after?.conversations || {}))}`)
  observe(`A: копий конверта в значении conversations: ${blobCopies(ctx.after?.conversations)}`)
  observe(`A: архив: ${fs.existsSync(ctx.archiveDir) ? fs.readdirSync(ctx.archiveDir).join(', ') : 'папки нет'}`)
  // Размер файла сам по себе не показатель: на старте приложение пишет туда ещё и
  // каталог моделей (~330 КБ). Показатель — сколько раз один и тот же конверт
  // лежит в настройках: прежний механизм оставлял два.
  line('A legacy-переписка', 'в файле настроек осталась одна копия конверта, а не две',
    blobCopies(ctx.after?.conversations) === 1, `копий: ${blobCopies(ctx.after?.conversations)}`)
  line('A legacy-переписка', 'в самом конверте не появилось вложенного corrupt',
    !JSON.stringify(ctx.after?.conversations || {}).includes('"corrupt"'),
    JSON.stringify(Object.keys(ctx.after?.conversations || {})))
  line('A legacy-переписка', 'живой конверт на месте: его ещё можно прочитать, когда ключ вернётся',
    ctx.after?.conversations?.enc === 'safeStorage' && ctx.after?.conversations?.data === BLOB)
  const archived = readJson(path.join(ctx.archiveDir, 'conversations.json'))
  line('A legacy-переписка', 'нечитаемое сохранено вне настроек — в файле архива',
    archived?.enc === 'safeStorage' && archived?.data === BLOB,
    JSON.stringify(Object.keys(archived || {})))
})

// ---------------------------------------------------------------------------
// B. Строковый ключ: прежний механизм выбрасывал значение и ставил `{}`, а
// копию клал внутрь подставного объекта.
// ---------------------------------------------------------------------------
scenario('string-key', { mcpServers: BLOB, personal: { name: MARK } }, ctx => {
  const shape = value => (typeof value === 'string' ? `строка ${value.length} знаков`
    : Array.isArray(value) ? `массив ${value.length}`
      : value && typeof value === 'object' ? 'объект ' + JSON.stringify(Object.keys(value)) : String(value))
  observe(`B: mcpServers после запуска: ${shape(ctx.after?.mcpServers)}`)
  line('B строковый ключ', 'живое значение не уничтожено подменой формы',
    ctx.after?.mcpServers === BLOB, `после запуска: ${shape(ctx.after?.mcpServers)}`)
  line('B строковый ключ', 'в настройках нет вложенного corrupt',
    !JSON.stringify(ctx.after || {}).includes('"corrupt"'))
  const archived = readJson(path.join(ctx.archiveDir, 'mcpServers.json'))
  line('B строковый ключ', 'нечитаемое ушло в файл архива, а не в настройки',
    archived === BLOB || archived?.data === BLOB, JSON.stringify(archived || '').slice(0, 60))
  line('B строковый ключ', 'прочитанный успешно ключ не задет',
    ctx.after?.personal?.name === MARK, JSON.stringify(ctx.after?.personal || null))
})

// ---------------------------------------------------------------------------
// C. Профиль, уже испорченный прежней версией: копия лежит вложенным
// `corrupt.bak`. Правка обязана вынести её в архив и очистить настройки.
// ---------------------------------------------------------------------------
scenario('already-damaged', {
  conversations: { enc: 'safeStorage', data: BLOB, corrupt: { bak: { enc: 'safeStorage', data: BLOB } } },
  mcpServers: { corrupt: { bak: BLOB } }
}, ctx => {
  const after = sizeKb(ctx.settingsFile)
  observe(`C: файл настроек ${ctx.before} КБ → ${after} КБ`)
  observe(`C: копий в conversations: ${blobCopies(ctx.after?.conversations)}, в mcpServers: ${blobCopies(ctx.after?.mcpServers)}`)
  observe(`C: архив: ${fs.existsSync(ctx.archiveDir) ? fs.readdirSync(ctx.archiveDir).join(', ') : 'папки нет'}`)
  line('C прежний профиль', 'копия-конверт убрана из настроек',
    !JSON.stringify(ctx.after || {}).includes('"corrupt"'),
    JSON.stringify(Object.keys(ctx.after?.conversations || {})))
  line('C прежний профиль', 'дубль сократился до одной копии живого конверта',
    blobCopies(ctx.after?.conversations) === 1 && blobCopies(ctx.after?.mcpServers) === 1,
    `conversations: ${blobCopies(ctx.after?.conversations)}, mcpServers: ${blobCopies(ctx.after?.mcpServers)}`)
  line('C прежний профиль', 'вынесенные байты лежат в архиве этого профиля',
    fs.existsSync(path.join(ctx.archiveDir, 'conversations.json')) &&
    fs.existsSync(path.join(ctx.archiveDir, 'mcpServers.json')),
    fs.existsSync(ctx.archiveDir) ? fs.readdirSync(ctx.archiveDir).join(', ') : 'папки нет')
  const archived = readJson(path.join(ctx.archiveDir, 'conversations.json'))
  line('C прежний профиль', 'в архиве — прежняя копия, а не выдуманные байты',
    archived?.data === BLOB, JSON.stringify(Object.keys(archived || {})))
  line('C прежний профиль', 'живая часть конверта осталась в настройках',
    ctx.after?.conversations?.enc === 'safeStorage' && ctx.after?.conversations?.data === BLOB)
})

// ---------------------------------------------------------------------------
// D. Идемпотентность: второй запуск на том же профиле ничего не дописывает и
// не плодит.
// ---------------------------------------------------------------------------
{
  const profile = path.join(output, 'legacy-conversations')
  const settingsFile = path.join(profile, '1code-settings.json')
  const archiveDir = path.join(profile, 'settings-corrupt')
  const beforeSize = sizeKb(settingsFile)
  const beforeArchive = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir).map(name => `${name}:${fs.statSync(path.join(archiveDir, name)).size}`).sort().join(' ') : ''
  const again = launch('second', profile)
  line('D второй запуск', 'окно открылось повторно', again.reported, again.stderr.slice(-160))
  line('D второй запуск', 'файл настроек не растёт от запуска к запуску',
    sizeKb(settingsFile) <= beforeSize + 1, `${beforeSize} КБ → ${sizeKb(settingsFile)} КБ`)
  const afterArchive = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir).map(name => `${name}:${fs.statSync(path.join(archiveDir, name)).size}`).sort().join(' ') : ''
  line('D второй запуск', 'архив не плодится: тот же набор тех же размеров',
    afterArchive === beforeArchive && Boolean(afterArchive), `${beforeArchive} → ${afterArchive}`)
}

let failed = 0
for (const group of [...new Set(report.map(item => item.group))]) {
  console.log('\n# ' + group)
  for (const item of report.filter(entry => entry.group === group)) {
    if (!item.pass) failed++
    // Подробность только у провала: часть деталей — длинные перечисления, и в
    // зелёном прогоне они забивают отчёт.
    console.log((item.pass ? 'ok     ' : 'ПРОВАЛ ') + item.name +
      (!item.pass && item.detail ? ' — ' + item.detail.slice(0, 300) : ''))
  }
}
console.log('\n# видно сейчас')
for (const text of observations) console.log('· ' + text)
console.log(`\nпроверок: ${report.length}, провалов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, output }))
settleRun(output, failed === 0)
process.exit(failed === 0 ? 0 : 1)
