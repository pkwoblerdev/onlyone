// Сквозной сценарий: приложение умерло посреди работы — на настоящем окне.
//
// Прежние прогоны продолжения (`run-resume-ui.cjs`, `run-design-resume-ui.cjs`)
// подкладывают файл контрольной точки руками, а между процессами никого не
// убивают. Здесь — настоящий Electron на временном профиле и три запуска:
//
//   1. разогрев: чат заводится, один ход доходит до конца, окно закрывается
//      само — так профиль успевает записать `Local State` с ключом шифрования
//      (Chromium пишет его не сразу, и на совсем свежем профиле жёсткая смерть
//      унесла бы ключ вместе с историей: это отдельная находка, не правки);
//   2. смерть: тот же чат, новый ход, и процесс убивается снаружи ровно тогда,
//      когда файл хода лежит на диске;
//   3. продолжение: карточка «Работа прервалась» в том же чате, исходная
//      просьба в ней читаема (то есть расшифрована настоящим safeStorage после
//      перезапуска — DPAPI живёт только в главном процессе), «Продолжить» уводит
//      ход дальше и снимает прежнюю запись.
//
// На сам файл по ходу смотрит и родительский процесс: просьба обязана лежать
// шифром с пометкой `enc:v1:`, а не текстом.
//
// Сети, ключей и живой модели нет. Профиль — временная папка; красные прогоны
// остаются на диске ради разбора, зелёные удаляются. Снимки — в
// ONECODE_EVIDENCE_DIR, если он задан.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { electronBinary, guiEnv } = require('./app-launch.cjs')
const history = require('./history-store.cjs')

const root = path.join(__dirname, '..')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-resume-secure-'))
const profile = path.join(output, 'profile')
const runsDir = path.join(profile, 'runs')
const localState = path.join(profile, 'Local State')
const ASK = 'Собери отчёт по пальмам и выложи его на сайт'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = []
const line = (group, name, pass, detail) => report.push({ group, name, pass: Boolean(pass),
  detail: detail === undefined ? '' : String(detail) })

// Длинный ответ тестового провайдера нужен затем, чтобы ход был ещё жив, когда
// процесс умирает: короткий успел бы закрыться сам и снял бы файл.
const fixture = path.join(output, 'fixture.json')
fs.writeFileSync(fixture, JSON.stringify({
  content: 'Отчёт о пальмах. ' + 'Ничего не считается сделанным дважды. '.repeat(220)
}))

const PRELUDE = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 25000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(100) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass),
    detail: detail === undefined ? '' : String(detail) })
  // Ожидание инициализации раньше было молчаливым: ждали 25 с и шли дальше
  // независимо от результата. На загруженной машине окно не укладывается, и
  // прогон краснел строкой «карточка не появилась» там, где на самом деле не
  // успела подняться сама программа. Теперь это отдельная проверка со временем.
  const readyStarted = Date.now()
  const ready = await until(() => document.documentElement.dataset.appReady === '1')
  note('окно завершило инициализацию до начала проверок', ready, (Date.now() - readyStarted) + ' мс')
  const openChat = id => {
    const row = document.querySelector('.history-item[data-chat-id="' + id + '"] .history-item-title')
    if (row) row.click()
    return wait(300)
  }
`

const ARGS = ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile]

// Замер фаз. Нужен затем, чтобы серия прогонов отвечала не только «зелёный /
// красный», но и где именно уходит время: в 5/13 чужих сбоев без этого не понять,
// дохнет ли прогон на старте окна, на убийстве процесса или на продолжении.
const phases = {}
const timed = async (name, fn) => {
  const started = Date.now()
  try { return await fn() } finally { phases[name] = Date.now() - started }
}

function envFor(script, out, shot) {
  return guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SHOT: shot,
    ONECODE_SMOKE_FIXTURE: fixture })
}

// Запуск с ожиданием отчёта окна и выхода приложения.
function launch(name, body) {
  const started = Date.now()
  const script = path.join(output, name + '.js')
  const out = path.join(output, name + '.json')
  const shot = path.join(output, name + '.png')
  fs.writeFileSync(script, `(async () => {${PRELUDE}${body}})()`)
  const child = spawnSync(electronBinary(), ARGS, { cwd: root, timeout: 150000, stdio: 'inherit',
    env: envFor(script, out, shot) })
  if (child.error) throw child.error
  // Если отчёта нет — важно не только «не отчиталось», но и чем это кончилось:
  // убито по потолку или вышло без записи. Разные причины, и первая — загрузка
  // машины, а не приложение.
  if (!fs.existsSync(out)) {
    return { ok: false, checks: [{ name: 'окно не отчиталось', pass: false,
      detail: `ждало ${Date.now() - started} мс при потолке 150000, код выхода ${child.status}, сигнал ${child.signal || 'нет'}` }] }
  }
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}

// Запуск, который не должен дожить до конца хода: окно начинает работу, а
// родительский тест убивает процесс снаружи, когда файл хода уже на диске.
// Штатный `finally` при этом не отрабатывает — это и есть «закрыл приложение
// посреди работы».
async function launchAndKill(name, body) {
  const script = path.join(output, name + '.js')
  fs.writeFileSync(script, `(async () => {${PRELUDE}${body}})()`)
  const logFile = path.join(output, name + '.log')
  const log = fs.openSync(logFile, 'w')
  const child = spawn(electronBinary(), ARGS, { cwd: root,
    env: envFor(script, path.join(output, name + '-unwritten.json'), path.join(output, name + '.png')),
    stdio: ['ignore', log, log] })
  const died = new Promise(resolve => child.once('exit', (code, signal) => resolve(signal || code)))
  let failure = ''
  child.once('error', error => { failure = error.message })

  const deadline = Date.now() + 90000
  let found = []
  while (Date.now() < deadline && !found.length) {
    if (failure) break
    try { found = fs.readdirSync(runsDir).filter(file => file.endsWith('.json')) } catch { /* папки ещё нет */ }
    if (!found.length) await sleep(50)
  }
  const bytes = found.length ? fs.readFileSync(path.join(runsDir, found[0])) : null
  if (bytes) fs.writeFileSync(path.join(output, 'crash-run.json'), bytes)
  let stateBefore = false
  try { stateBefore = fs.existsSync(localState) } catch {}
  // Убить обязан любой исход разбора файла: живое окно, оставшееся после
  // провала, стартует следующим прогоном на том же профиле, и дальше уже
  // непонятно, что горит — приложение или его труп.
  try { child.kill('SIGKILL') } catch { /* уже мёртв */ }
  const exited = await Promise.race([died, sleep(20000).then(() => 'не закрылся')])
  fs.closeSync(log)
  return { runFile: found[0] || '', bytes, exited, error: failure, stateBefore,
    log: fs.readFileSync(logFile, 'utf8') }
}

// 1 — разогрев: чат, один завершённый ход, штатный выход.
// Ждём не по признаку кнопки: ход тестового провайдера доходит до окна чуть
// позже, чем снимается «стоп», и прежняя проверка успевала закрыть приложение на
// середине потока (assistant-сообщение тогда в историю не попадало).
//
// Финальное ожидание — не «на всякий случай», а часть проверки: окно пишет
// историю с паузой 400 мс, главный процесс — фоном ещё через 120 мс, а тестовый
// прогон закрывается `app.exit(0)`, который проходит мимо `before-quit` и его
// синхронного флеша. Без ожидания разогрев оставил бы на диске пустой чат, и
// дальше проверялась бы не устойчивость продолжения, а эта гонка.
const WARM_BODY = `
  $('newChatBtn')?.click()
  await wait(400)
  const chatId = document.querySelector('.history-item.active')?.dataset.chatId || ''
  note('чат найден в списке', Boolean(chatId), chatId)
  const box = $('composerTextarea')
  box.value = 'Разогрев профиля: покажи, что временный профиль живой'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm').requestSubmit()
  let saved = 0
  for (let i = 0; i < 160 && saved < 2; i++) {
    const list = await window.electronAPI.getConversations()
    saved = ((list || []).find(item => item.id === chatId)?.messages || []).length
    if (saved < 2) await wait(250)
  }
  note('переписка появилась в хранилище главного процесса', saved >= 2, saved)
  await wait(1500)
  note('ответ появился в ленте', Boolean(document.querySelector('#messagesList .msg-item.assistant')))
  return { ok: checks.every(c => c.pass), checks, chatId }
`

// 2 — ход, на котором процесс умрёт. Скрипт не возвращается: окно живёт, пока
// его не убьют.
const CRASH_BODY = chatId => `
  await openChat(${JSON.stringify(chatId)})
  const box = $('composerTextarea')
  box.value = ${JSON.stringify(ASK)}
  box.dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm').requestSubmit()
  await until(() => Boolean(document.querySelector('.btn-send.is-stop')), 15000)
  await new Promise(() => {})
`

// 3а — карточка после перезапуска: её видно, просьба читается, и выход с
// открытой карточкой ход не стирает (3б найдёт её заново).
const CARD_BODY = chatId => `
  await openChat(${JSON.stringify(chatId)})
  // Список истории заполняется не мгновенно: без ожидания это чистая гонка,
  // которая и давала плавающие провалы в чужой серии.
  note('в списке есть чат, переживший смерть',
    await until(() => Boolean(document.querySelector('.history-item[data-chat-id="${chatId}"]')), 15000),
    [...document.querySelectorAll('.history-item')].map(item => item.dataset.chatId).join(', ').slice(0, 160))
  const card = () => document.querySelector('#messagesList .approval-card.kind-resume')
  note('карточка появилась в том же чате', await until(card, 25000),
    document.querySelectorAll('.approval-card.kind-resume').length)
  note('просьба расшифровалась настоящим safeStorage',
    /Собери отчёт по пальмам/.test(card()?.querySelector('.resume-ask')?.textContent || ''),
    (card()?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160))
  const runs = await window.electronAPI.interruptedRuns()
  note('главный процесс отдал одну оборванную запись', (runs || []).length === 1,
    JSON.stringify(runs || []).slice(0, 220))
  const record = (runs || [])[0] || {}
  note('запись относится к этому чату', record.chatId === ${JSON.stringify(chatId)}, record.chatId)
  const budgetLine = (record.prompt || '').split('\\n').find(text => /доработка/.test(text)) || ''
  // Ход тестового провайдера бюджет приёмки не тратит, поэтому строки может не
  // быть вовсе. Если она есть — число обязано браться из LIMITS, а не из файла:
  // прежний вид описи обещал модели 998 доработок при реальных двух.
  note('опись не обещает попыток больше, чем есть',
    !budgetLine || (/доработка [1-6]\\b/.test(budgetLine) && !/\\b(9[0-9]|1[0-9]\\d|[1-9]\\d{2,})\\b/.test(budgetLine)),
    budgetLine)
  note('история чата после смерти читаема (ответ прежнего хода в ленте)',
    /Отчёт о пальмах/.test($('messagesList').textContent || ''),
    ($('messagesList').textContent || '').replace(/\\s+/g, ' ').slice(0, 80))
  card()?.querySelector('.approval-toggle')?.click()
  await wait(300)
  return { ok: checks.every(c => c.pass), checks }
`

// 3б — то же окно, но с нажатым «Продолжить». Между 3а и 3б приложение
// закрывалось штатно: карточка обязана пережить и это закрытие.
const RESUME_BODY = chatId => `
  await openChat(${JSON.stringify(chatId)})
  const card = () => document.querySelector('#messagesList .approval-card.kind-resume')
  note('карточка дожилась второго перезапуска', await until(card, 25000))
  card()?.querySelector('.approval-allow')?.click()
  const users = () => [...document.querySelectorAll('#messagesList .msg-item.user')]
  const sent = await until(() => users().some(item => /Продолжить прерванную работу/.test(item.innerText || item.textContent)), 20000)
  const feed = (users().pop()?.innerText || '').replace(/\\s+/g, ' ')
  note('по «Продолжить» ушла короткая фраза, опись скрыта', sent && !/Уже сделано|не повторяй/.test(feed), feed.slice(0, 140))
  const stopGone = () => !document.querySelector('.btn-send.is-stop')
  // Прежняя проверка «дошёл до конца» спрашивала отсутствие кнопки «стоп» сразу
  // после клика: класс ещё не успевал появиться, и проверка зелёная за 0 мс даже
  // на том месте, где ход не начинался. Теперь сначала видим, что ход пошёл,
  // и только потом — что он кончился.
  note('продолженный ход начался', await until(() => !stopGone(), 5000))
  await wait(300)
  note('карточка ушла из ленты', !card())
  const after = await window.electronAPI.interruptedRuns()
  note('прежняя запись снята с учёта', Array.isArray(after) && after.length === 0, JSON.stringify(after || []).slice(0, 160))
  note('продолженный ход дошёл до конца', await until(stopGone, 60000))
  return { ok: checks.every(c => c.pass), checks }
`

function collect(group, result) {
  const list = result?.checks || []
  if (!list.length) list.push({ name: 'прогон не состоялся', pass: false,
    detail: 'окно вернулось без единой проверки' })
  for (const check of list) {
    line(group, check.name, check.pass, check.detail)
  }
}

function copyShots() {
  const dir = process.env.ONECODE_EVIDENCE_DIR
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  for (const name of ['warm', 'crash', 'resume-card', 'resume']) {
    const shot = path.join(output, name + '.png')
    if (fs.existsSync(shot)) fs.copyFileSync(shot, path.join(dir, `resume-secure-${name}.png`))
  }
}

async function main() {
  const warm = await timed('warm', async () => launch('warm', WARM_BODY))
  collect('разогрев профиля', warm)
  // Не кэш главного процесса, а диск: `getConversations` читает память, а
  // закрывается тестовое окно через `app.exit`, минуя флеш при выходе.
  // Порог не «больше нуля»: пустой скелет чата весит 291 Б, а чат с ответом —
  // 1,2 КБ (замер warm-timeline.cjs). 200 Б пропускали скелет и давали зелёный
  // прогон там, где на диске ничего нет.
  line('разогрев профиля', 'история легла на диск до смерти процесса',
    history.historyBytes(profile) > 900,
    history.historyPresent(profile) ? history.historyLayout(profile) + ', ' + history.historyBytes(profile) + ' Б' : 'набора истории нет')
  const chatId = warm?.chatId
  if (!warm?.ok || !chatId) {
    line('смерть процесса', 'дальнейший прогон невозможен: нет разогретого чата', false,
      JSON.stringify(warm || null).slice(0, 300))
    return
  }

  const killed = await timed('crash', () => launchAndKill('crash', CRASH_BODY(chatId)))
  const raw = killed.bytes ? killed.bytes.toString('utf8') : ''
  let file = null
  try { file = killed.bytes ? JSON.parse(raw) : null } catch { file = null }

  line('смерть процесса', 'окно запустилось', !killed.error, killed.error)
  line('смерть процесса', 'процесс убит извне, а не завершился сам', killed.exited === 'SIGKILL',
    String(killed.exited))
  line('смерть процесса', 'файл контрольной точки остался на диске', Boolean(killed.runFile), killed.runFile)
  line('смерть процесса', 'запись читается и принадлежит тому же чату',
    file?.schemaVersion === 1 && file?.chatId === chatId, `${file?.chatId} против ${chatId}`)
  line('смерть процесса', 'ключ шифрования был в профиле до смерти (иначе история не читается)',
    killed.stateBefore)
  line('шифрование', 'просьба лежит шифром с пометкой enc:v1:',
    Boolean(file?.ask?.startsWith('enc:v1:')), (file?.ask || '').slice(0, 24))
  line('шифрование', 'в файле нет просьбы открытым текстом', Boolean(raw) && !raw.includes(ASK),
    raw.slice(0, 120))
  line('шифрование', 'идентификаторы хода и чата остались читаемыми (иначе список пуст)',
    Boolean(file?.runId && file?.chatId))
  if (!file?.chatId) {
    line('продолжение', 'дальнейший прогон невозможен', false, killed.log.slice(-1200))
    return
  }

  collect('карточка после перезапуска', await timed('resume-card', async () => launch('resume-card', CARD_BODY(chatId))))
  collect('продолжение', await timed('resume', async () => launch('resume', RESUME_BODY(chatId))))
  const left = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(name => name.endsWith('.json')) : []
  line('после продолжения', 'ни одного висящего файла хода не осталось', left.length === 0, left.join(', '))
  const quarantined = fs.existsSync(path.join(profile, 'data'))
    ? fs.readdirSync(path.join(profile, 'data')).filter(name => /corrupt|key-lost/.test(name))
    : []
  line('после продолжения', 'история не ушла в карантин или в архив нечитаемого', quarantined.length === 0,
    quarantined.join(', '))
}

main().then(() => {
  copyShots()
  let failed = 0
  for (const group of [...new Set(report.map(item => item.group))]) {
    console.log('\n# ' + group)
    for (const item of report.filter(entry => entry.group === group)) {
      if (!item.pass) failed++
      console.log((item.pass ? 'ok     ' : 'ПРОВАЛ ') + item.name + (item.detail && !item.pass ? ' — ' + item.detail : ''))
    }
  }
  console.log(`\nпроверок: ${report.length}, провалов: ${failed}`)
  console.log(`фазы, мс: ${Object.entries(phases).map(([k, v]) => k + '=' + v).join(' ')}`)
  console.log(JSON.stringify({ ok: failed === 0, output, phases }))
  // Красный прогон остаётся на диске: без профиля и логов окна непонятно, что
  // именно не сошлось. Зелёный — временная папка не нужна.
  if (!failed) fs.rmSync(output, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}).catch(error => {
  console.error('харнесс упал: ' + error.stack)
  console.error('профиль прогона: ' + output)
  process.exit(2)
})
