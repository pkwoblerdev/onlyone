// Экран «Расписания» живым окном (план, 3.5): что человек видит в каждом
// состоянии и как экран ведёт себя на английском. Модель — локальная заглушка
// (`ONECODE_SMOKE`), сеть и платные вызовы не нужны: здесь никто никуда не
// пишет, кроме подставного профиля в `%TEMP%`.
//
// Снимки остаются на диске после зелёного прогона (`ONECODE_RUN_EVIDENCE` не
// используется — кадры пишутся прямо в каталог аудита), потому что их смотрит
// Claude на дизайн-приёмку.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const commandRunner = require('../src/main/command-runner')

const root = path.join(__dirname, '..')
const output = runDir('onlyone-schedules')
const profile = path.join(output, 'profile')
const storeDir = path.join(profile, 'schedules')
const shots = path.join(root, 'audits', 'qoder-2-2026-09-27', 'schedules')
fs.mkdirSync(storeDir, { recursive: true })
fs.mkdirSync(shots, { recursive: true })

const report = []
const line = (group, name, pass, detail) => report.push({ group, name, pass: Boolean(pass),
  detail: detail === undefined ? '' : String(detail) })
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

const iso = hoursFromNow => new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString()
const record = (id, name, over = {}) => ({
  id, name, enabled: true, timeZone: 'Europe/Berlin', kind: 'daily', daily: { time: '07:30' },
  misfire: 'skip', action: { type: 'agent-turn', prompt: `просьба ${name}` }, ...over
})

function seed (records) {
  fs.mkdirSync(storeDir, { recursive: true })
  if (records === null) {
    fs.writeFileSync(path.join(storeDir, 'schedules.json'), '{"schemaVersion":1,"records":[{"id":"sch_good","name":"Целая запись","kind"', 'utf8')
    return
  }
  if (records === false) {
    fs.rmSync(path.join(storeDir, 'schedules.json'), { force: true })
    return
  }
  fs.writeFileSync(path.join(storeDir, 'schedules.json'), JSON.stringify({ schemaVersion: 1, savedAt: Date.now(), records }), 'utf8')
}

const PRELUDE = `
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const byId = id => document.getElementById(id)
  const until = async (fn, ms = 12000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(120) } return false }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  await until(() => document.documentElement.dataset.appReady === '1')
  await wait(1200)
  byId('openSettingsBtn')?.click()
  await until(() => byId('tab-schedules'))
  byId('tab-schedules').click()
  await wait(900)
  // Язык закрепляем: прогон идёт на одном профиле, и переключение в одном
  // запуске перетекло бы в следующий — проверки русского краснели бы молча.
  window.__setLang = value => {
    const lang = byId('languageSelect') || document.querySelector('select[id*="anguage"]')
    if (!lang) return false
    lang.value = value
    lang.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  note('переключатель языка найден', window.__setLang('ru'), 'иначе кадры не парны')
  await wait(900)
  const screen = document.querySelector('[data-schedule-screen]')
  note('вкладка открылась и экран смонтирован', Boolean(screen && screen.dataset.mounted === '1'), screen ? 'есть' : 'контейнера нет')
`

function launch (name, body) {
  const script = path.join(output, name + '.js')
  const out = path.join(output, name + '.json')
  const shot = path.join(shots, name + '.png')
  fs.writeFileSync(script, '(async () => {' + PRELUDE + body +
    '\n return { ok: checks.every(item => item.pass), checks } })()')
  // Скрипт окна рождается из шаблонных строк: потерянная кавычка иначе
  // превращается в «окно не отчиталось» через четыре минуты прогона.
  const syntax = require('node:child_process').spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
  if (syntax.status !== 0) throw new Error(`${name}: сгенерированный скрипт не читается: ${String(syntax.stderr).split('\n').slice(0, 3).join(' · ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile],
      { cwd: root, stdio: 'inherit', env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SHOT: shot }) })
    const timer = setTimeout(() => { commandRunner.killTree(child.pid, () => {}) }, 180000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      const verdict = readJson(out)
      const list = (verdict && verdict.checks) || []
      if (!list.length) list.push({ name: 'окно вернулось без единой проверки', pass: false, detail: 'код выхода ' + code })
      for (const check of list) line(name, check.name, check.pass, check.detail)
      line(name, 'кадр сохранён', fs.existsSync(shot) && fs.statSync(shot).size > 8000, shot)
      resolve(verdict)
    })
  })
}

const EMPTY = `
  const text = screen.innerText
  note('пустое состояние объясняет, что будет', /Расписаний пока нет/.test(text), text.slice(0, 90))
  note('кнопка создания над списком', Boolean(screen.querySelector('[data-new]')), 'есть')
`

const LIST = `
  const rows = [...screen.querySelectorAll('[data-schedule-row]')]
  note('список показал три расписания', rows.length === 3, String(rows.length))
  const on = rows[0].innerText
  note('срок словами, а не ISO-строкой', /(завтра|сегодня|следующий|\d{2}:\d{2})/.test(on), on.replace(/\\s+/g, ' ').slice(0, 120))
  note('выключенное помечено', /выключено/i.test(rows[1].innerText), rows[1].innerText.replace(/\\s+/g, ' ').slice(0, 120))
  note('просьба не показалась в списке', !/просьба /.test(screen.innerText), 'проверено')
  const key = ${JSON.stringify('sk-QoderTest')}
  note('ни ключа, ни текста просьбы в разметке нет', !screen.innerHTML.includes(key) && !screen.innerHTML.includes('просьба '), 'проверено')
  const sw = rows[0].querySelector('[data-toggle]')
  note('переключатель подписан aria-pressed', sw && (sw.getAttribute('aria-pressed') === 'true' || sw.getAttribute('aria-pressed') === 'false'), sw ? sw.getAttribute('aria-pressed') : 'нет')
  rows[0].querySelector('[data-ask]').click(); await wait(400)
  note('подтверждение удаления спрашивает имя', /Удалить «Утренний разбор»/.test(screen.innerText), screen.innerText.replace(/\\s+/g, ' ').slice(0, 160))
  screen.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(400)
  note('Esc снял подтверждение', !/Да, удалить/.test(screen.innerText), 'проверено')
  screen.querySelector('[data-new]').click(); await wait(400)
  note('форма открылась с полем имени', Boolean(document.querySelector('[data-f="name"]')), 'есть')
  screen.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(400)
  note('Esc закрыл форму', !document.querySelector('[data-f="name"]'), 'проверено')
`

const LIST_EN = `
  window.__setLang('en'); await wait(900)
  note('на английском вкладка переведена', /Scheduled runs/.test(screen.innerText), screen.innerText.replace(/\\s+/g, ' ').slice(0, 90))
  note('просьба не показалась и на английском', !/request /.test(screen.innerText) && !/просьба /.test(screen.innerText), screen.innerText.replace(/\\s+/g, ' ').slice(0, 120))
  // Слова о сроке собирает главный процесс — самое место им остаться русскими.
  // Имена записей не трогаем: это данные человека, а не текст интерфейса.
  const words = [...screen.querySelectorAll('[data-schedule-row]')]
    .map(one => ((one.querySelector('.settings-note') || {}).textContent || '').trim())
  note('срок словами переведён на английский', words.length > 0 && !words.some(one => /[А-Яа-яЁё]/.test(one)), words.join(' · ').slice(0, 160))
  note('переведённый срок остался понятным', words.every(one => /next|daily|every|once|cron/i.test(one)), words.join(' · ').slice(0, 160))
`

const FORM = `
  screen.querySelector('[data-new]').click(); await wait(400)
  document.querySelector('[data-save]').click(); await wait(500)
  const errs = [...screen.querySelectorAll('[data-error-for]')].map(one => one.dataset.errorFor + ':' + one.textContent.trim())
  note('пустая форма не ушла в сохранение, подписи у полей', errs.length >= 2, errs.join(' | '))
  note('сообщение об ошибке стоит рядом с полем, а не alert-ом', Boolean(document.querySelector('[data-error-for="name"]')), 'есть')
`

// Ход по сроке настоящим ходом (главная половина 3.5): планировщик будит окно,
// окно читает просьбу адресом и отправляет её тем же путём, что сообщение
// человека. Ответ даёт тестовый провайдер главного процесса (`smokeOnly`):
// внешней сети и настоящих ключей в прогоне нет.
const TURN = `
  const feed = () => ((document.getElementById('messagesList') || {}).textContent || '').replace(/\\s+/g, ' ')
  const before = feed()
  // Снимок срока берётся ДО нажатия: ручной запуск не должен его сдвинуть.
  const beforeRun = ((await window.electronAPI.getSchedules()).records || [])[0] || {}
  const row = screen.querySelector('[data-schedule-row]')
  const runBtn = row && row.querySelector('[data-run]')
  note('кнопка «Выполнить сейчас» найдена', Boolean(runBtn), runBtn ? 'есть' : 'нет')
  if (runBtn) runBtn.click()
  // Миг «идёт сейчас» под заглушкой ловить нельзя: ответ тестового провайдера
  // приходит быстрее, чем экран успевает перечитать состояние, — проверка
  // краснела бы молча. Здесь доказывается конец цикла: ход дошёл, итог сдан.
  await wait(500)
  const gotPrompt = await until(() => /просьба Ход по сроку/.test(feed()), 30000)
  note('просьба расписания вошла в чат', gotPrompt, feed().slice(0, 140))
  const gotAnswer = await until(() => /Ответ для /.test(feed()), 60000)
  note('ход кончился ответом модели в этом чате', gotAnswer, feed().slice(-140))
  note('в ленте добавился текст', feed().length > before.length, 'до ' + before.length + ' · после ' + feed().length)
  await wait(900)
  const list = await window.electronAPI.getSchedules()
  const one = (list.records || [])[0] || {}
  note('планировщик не ждёт итога вечно', !one.running, JSON.stringify(one).slice(0, 150))
  // Ручной запуск не имеет права съесть ближайший срок: он ничего не пишет в
  // lastRunAt и не двигает nextRunAt — проверка держит это правило живым.
  note('ручной запуск не съел ближайший срок', one.lastRunAt === beforeRun.lastRunAt && one.nextRunAt === beforeRun.nextRunAt,
    'было ' + String(beforeRun.nextRunAt) + ' · стало ' + String(one.nextRunAt))
  note('итог хода записан без ошибки', !one.lastError, String(one.lastError || '').slice(0, 120))
  note('экран вернулся к обычному виду', Boolean(screen.querySelector('[data-run]')), 'кнопка запуска на месте')
`

const CORRUPT = `
  const text = screen.innerText
  note('битый файл назван битым словами', /поврежд|не читается|damaged|unreadable/i.test(text), text.replace(/\s+/g, ' ').slice(0, 140))
  note('не притворяется пустым списком', !/Расписаний пока нет/.test(text), 'проверено')
  const copy = fs => fs
  note('копия битого файла осталась на диске', true, 'проверяется внешним списком каталога')
`

;
(async () => {
  seed(false)
  await launch('empty', EMPTY)
  seed([record('sch_a', 'Утренний разбор', { nextRunAt: Date.parse(iso(6)) }),
    record('sch_b', 'Вечерняя сверка', { enabled: false, nextRunAt: Date.parse(iso(4)) }),
    record('sch_c', 'Пропущенный', { nextRunAt: Date.parse(iso(-3)) })])
  await launch('list', LIST)
  await launch('list-en', LIST_EN)
  await launch('form-error', FORM)
  seed([record('sch_run', 'Ход по сроку', { nextRunAt: Date.parse(iso(6)) })])
  await launch('turn-in-chat', TURN)
  seed(null)
  await launch('corrupt-file', CORRUPT)
  const archived = fs.readdirSync(storeDir).filter(name => name.startsWith('schedules.corrupt-'))
  line('диск', 'битый файл пережил запуск копией', archived.length >= 1, archived.join(', '))

  const failed = report.filter(item => !item.pass)
  fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({ ok: !failed.length, report }, null, 2))
  console.log('\n' + report.map(item => `${item.pass ? 'ok  ' : 'ПРОВАЛ'} [${item.group}] ${item.name}${item.detail ? ' — ' + item.detail.slice(0, 120) : ''}`).join('\n'))
  console.log(`Проверок: ${report.length}, отказов: ${failed.length}`)
  console.log(JSON.stringify({ ok: !failed.length, checks: report.length, failed: failed.length, shots }))
  settleRun(output, !failed.length)
  process.exitCode = failed.length ? 1 : 0
})().catch(error => {
  console.error('ПРОГОН УПАЛ:', error && error.message)
  settleRun(output, false)
  process.exitCode = 1
})
