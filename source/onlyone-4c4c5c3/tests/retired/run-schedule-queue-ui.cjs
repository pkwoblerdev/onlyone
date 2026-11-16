// Расписание в Центре задач живым окном (план, 3.4б;
// 30.09 12:00 — «окно на подставных часах»).
//
// Модель в прогоне — тестовый провайдер главного процесса (`smokeOnly`): он
// отвечает по фикстуре длинной лентой, поэтому «Паузу» человек нажимает посреди
// настоящего хода, а не до него и не после. Внешней сети и настоящих ключей нет.
//
// Что этот прогон честен показать и что нет: снятие идёт каналом `abort-message`
// — тем же, каким чат снимает свой ход кнопкой остановки (отмена запроса к
// провайдеру доказана там). Тестовый провайдер сигнала не читает и дописывает
// фикстуру молча, поэтому здесь проверяется видимая человеку половина: карточка,
// состояние расписания, причина и остановившаяся лента.
//
// Три запуска, каждый на СВОЁМ профиле: и очередь, и переписка живут на диске,
// и на общем профиле второй запуск видел бы карточку первого — зелёный прогон
// рассказывал бы не о том, что произошло сейчас.
//   · `pause`   — срок наступил, карточка «в работе», человек жмёт «Пауза»:
//                 карточка встаёт «Ожидает» без обещания возобновить, расписание
//                 перестало быть занятым, снятие записано причиной, лента чата
//                 после нажатия не растёт, а поздний итог не переписал причину;
//   · `run`     — тот же срок без вмешательства: карточка доходит до
//                 «Завершено», чат получил ответ, расписание свободно;
//   · `english` — язык переключён ДО срабатывания: заголовок карточки переводит
//                 главный процесс, русская строка в очереди на английском окне —
//                 тот же дефект, что Н89.
//
// Кадры переживают зелёный прогон: их смотрит Claude на приёмку.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const commandRunner = require('../src/main/command-runner')

const root = path.join(__dirname, '..')
const output = runDir('onlyone-schedule-queue')
const shots = path.join(root, 'audits', 'qoder-2-2026-09-30', 'schedule-queue')
fs.mkdirSync(shots, { recursive: true })

const NAME = 'Ход по сроке'
const PROMPT = 'проверить сводку и прислать итог, ключ sk-QueTest'
const ANSWER_MARK = 'Проверка хода расписания'
// Конец ленты — отдельная, ни на что не похожая фраза: «ход дописался» и
// «ход оборвался на середине» различаются её присутствием. По длине или по
// началу ответа этого не увидеть — лента стримится сверху, и первые абзацы
// есть в обоих случаях.
const END_MARK = 'Точка ответа теста 4к9у'
// Ответ тестовой модели стримится кусками по 8 знаков с паузой 10 мс между
// ними: 12000 знаков — ход секунд на пятнадцать. Нужно ровно затем, чтобы
// «Паузу» нажали посреди хода, а не после него.
const LONG_ANSWER = 12000
const SHORT_ANSWER = 1200

const report = []
const line = (group, name, pass, detail) => report.push({ group, name, pass: Boolean(pass),
  detail: detail === undefined ? '' : String(detail) })
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

// Подставной срок: планировщик при подъёме пересчитывает `nextRunAt` из
// определения записи, поэтому сеять готовую дату бессмысленно — она бы
// переставилась. «Один раз» через N миллисекунд — настоящий близкий срок, и
// ход начинается сам, без нажатия человеком: ровно это и проверяется.
function fixtureFile(name, chars) {
  const file = path.join(output, `fixture-${name}.json`)
  // Никаких инструментов в фикстуре: ход обязан идти обычной лентой ответа,
  // иначе проверка ловила бы не снятие, а зависший инструмент.
  const paragraph = `${ANSWER_MARK}: абзац ответа модели идёт длинной лентой. `
  const body = paragraph.repeat(Math.ceil(chars / paragraph.length)).slice(0, chars)
  fs.writeFileSync(file, JSON.stringify({ content: body + END_MARK }), 'utf8')
  return file
}

const PRELUDE = `
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const byId = id => document.getElementById(id)
  const until = async (fn, ms = 30000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { let hit = false; try { hit = fn() } catch {} if (hit) return true; await wait(120) }
    return false
  }
  const checks = []
  const errors = []
  window.addEventListener('error', e => errors.push('окно: ' + String(e.message)))
  window.addEventListener('unhandledrejection', e => errors.push('обещание: ' + String((e.reason && e.reason.message) || e.reason)))
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  await until(() => document.documentElement.dataset.appReady === '1')
  await wait(900)
  const cards = () => [...document.querySelectorAll('#taskCenterView .task-center-item')]
  const openCenter = async () => {
    if (!document.body.classList.contains('task-center-open')) document.dispatchEvent(new CustomEvent('open-task-center'))
    await until(() => byId('taskCenterView') && document.body.classList.contains('task-center-open'), 8000)
    await wait(400)
  }
  const feed = () => ((document.getElementById('messagesList') || {}).textContent || '').replace(/\\s+/g, ' ')
  const card = () => cards().find(one => /Расписание: |Schedule: /.test(one.textContent))
  const cardText = () => (card() || { textContent: '' }).textContent.replace(/\\s+/g, ' ')
  // Кнопки очереди лежат РЯДОМ с карточкой, а не внутри неё: вложенная кнопка
  // в кнопке ломает и мышь, и клавиатуру — так устроено в экране задач.
  // Значит ищется действие по строке-родителю, а сама карточка остаётся тем,
  // что человек читает: заголовок и состояние.
  const row = () => { const one = card(); return one && one.closest ? one.closest('.task-center-row') : null }
  const rowText = () => (row() || card() || { textContent: '' }).textContent.replace(/\\s+/g, ' ')
  const action = name => (row() || document).querySelector('[data-task-action="' + name + '"]')
  const html = () => (row() || card() || { innerHTML: '' }).innerHTML
  // Просьба заводится из окна каналом set-schedule, а срок отсчитывается от
  // готовности окна, а не от посева файла: холодный первый старт съедал весь
  // запас, и карточка не успевала появиться — прогон краснел не о том.
  const arm = async seconds => {
    const at = new Date(Date.now() + seconds * 1000).toISOString()
    const got = await window.electronAPI.setSchedule({
      id: 'sch_queue', name: 'Ход по сроке', enabled: true, kind: 'once', once: { at },
      timeZone: 'Europe/Berlin', misfire: 'skip',
      action: { type: 'agent-turn', prompt: 'проверить сводку и прислать итог, ключ sk-QueTest' }
    })
    note('расписание заведено каналом окна', Boolean(got && got.ok), JSON.stringify(got).slice(0, 120))
  }
  await openCenter()
  note('проводка хода навешена один раз', window.__scheduleWired === 1, 'подписок: ' + String(window.__scheduleWired))
  note('Центр задач открыт', document.body.classList.contains('task-center-open'), 'карточки ищутся в нём')
`

function launch(name, body, opts = {}) {
  const profile = path.join(output, `profile-${name}`)
  fs.mkdirSync(profile, { recursive: true })
  const script = path.join(output, name + '.js')
  const out = path.join(output, name + '.json')
  const shot = path.join(shots, name + '.png')
  fs.writeFileSync(script, '(async () => {' + PRELUDE + body +
    // Немой отказ окна иначе выглядит как «проверка не дождались»: без этой
    // строки причина (сломанная проводка, исключение в обработчике) теряется.
    "\n  note('ошибок в окне нет', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300))" +
    '\n return { ok: checks.every(item => item.pass), checks } })()')
  // Скрипт окна рождается из шаблонных строк: потерянная кавычка иначе
  // всплывает через несколько минут прогона как «окно не отчиталось».
  const syntax = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
  if (syntax.status !== 0) throw new Error(`${name}: сгенерированный скрипт не читается: ${String(syntax.stderr).split('\n').slice(0, 3).join(' · ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile],
      { cwd: root, stdio: 'inherit', env: guiEnv({
        ONECODE_SMOKE: script,
        ONECODE_SMOKE_OUT: out,
        ONECODE_SHOT: shot,
        ONECODE_SMOKE_FIXTURE: fixtureFile(name, opts.answerChars || SHORT_ANSWER)
      }) })
    const timer = setTimeout(() => { commandRunner.killTree(child.pid, () => {}) }, 300000)
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

const PAUSE = `
  await arm(4)
  const appeared = await until(() => Boolean(card()), 30000)
  note('срабатывание расписания встало карточкой', appeared, cardText().slice(0, 120))
  note('карточка сказала «в работе»', /в работе/i.test(cardText()), cardText().slice(0, 120))
  note('ход расписания дошёл до чата', await until(() => /проверить сводку и прислать итог/.test(feed()), 15000), feed().slice(0, 120))
  const pauseBtn = action('pause')
  note('у карточки расписания есть «Пауза»', Boolean(pauseBtn), pauseBtn ? 'есть' : 'нет кнопки в строке: ' + rowText().slice(0, 120))
  if (pauseBtn) pauseBtn.click()
  await wait(1500)
  note('после паузы карточка ждёт, а не работает', /Ожидает/i.test(cardText()), cardText().slice(0, 120))
  // Присоединённую работу очередь обратно не поднимает: процесса нет, и кнопка,
  // которая всегда отказывает, хуже отсутствующей. Возобновляют ход расписания
  // там, где его ставят, — «Выполнить сейчас» на экране расписаний.
  note('снятую работу не обещают возобновить из очереди', !action('resume') && !action('restart'), rowText().slice(0, 140))
  const list = await window.electronAPI.getSchedules()
  const rec = (list.records || [])[0] || {}
  note('расписание перестало быть занятым', !rec.running, JSON.stringify(rec).slice(0, 150))
  note('пауза записана снятым ходом, а не успехом', /Центра задач/.test(String(rec.lastError || '')), String(rec.lastError || 'пусто'))
  // Отрицательный контроль по РОСТУ ленты, а не по отсутствию финальной фразы:
  // тестовый провайдер ответа на сигнал отмены не имеет и дописывает фикстуру
  // до конца, поэтому «хвоста нет» само по себе значило бы только «не успели».
  // Здесь же видно, что окно перестало показывать снятый ход: лента за восемь
  // секунд не сдвинулась ни на знак.
  const afterPause = feed().length
  await wait(8000)
  note('после паузы лента в чате перестала расти', feed().length === afterPause, 'до ' + afterPause + ' · после ' + feed().length)
  // Финальная фраза ответа не появилась: ход не дописался и в данных ленты.
  note('снятый ход не дописался', !feed().includes('${END_MARK}'), feed().slice(-150))
  await wait(10000)
  await openCenter()
  note('после снятия карточка не стала «выполнено»', !/Завершено/i.test(cardText()), cardText().slice(0, 120))
  // Поздний итог снятого хода (тестовый провайдер дописывает фикстуру молча)
  // не имеет права переписать причину: человек нажал «Паузу», и её словами он
  // обязан видеть и через минуту.
  const late = ((await window.electronAPI.getSchedules()).records || [])[0] || {}
  note('поздний итог не перекрыл снятие', /Центра задач/.test(String(late.lastError || '')) && !late.running, JSON.stringify(late).slice(0, 150))
`

const RUN = `
  await arm(4)
  const appeared = await until(() => Boolean(card()), 30000)
  note('карточка живёт, пока ход идёт', appeared, cardText().slice(0, 110))
  const done = await until(() => /Завершено/i.test(cardText()), 45000)
  note('ход закончился, карточка «Завершено»', done, cardText().slice(0, 130))
  note('чат получил ответ модели', new RegExp('${ANSWER_MARK}').test(feed()), feed().slice(-150))
  // Тот же маркер, по которому пауза требует тишины: без него «Завершено»
  // означало бы лишь то, что планировщик что-то себе решил.
  note('ответ дописан до конца', feed().includes('${END_MARK}'), feed().slice(-150))
  const list = await window.electronAPI.getSchedules()
  const rec = (list.records || [])[0] || {}
  note('исход записан без ошибки', !rec.running && !rec.lastError, JSON.stringify(rec).slice(0, 150))
  note('в карточке нет текста просьбы и ключа', !/sk-QueTest|проверить сводку/.test(html()), 'проверено')
`

// Язык меняется ДО срабатывания: иначе карточка была бы русским снимком
// прежнего состояния, а не переводом нового заголовка.
const ENGLISH = `
  window.__setLang = value => {
    const lang = byId('languageSelect') || document.querySelector('select[id*="anguage"]')
    if (!lang) return false
    lang.value = value
    lang.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  byId('openSettingsBtn')?.click()
  await until(() => byId('tab-schedules'), 8000)
  byId('tab-schedules').click(); await wait(700)
  note('переключатель языка найден', window.__setLang('en'), 'иначе кадр не парный')
  await wait(1500)
  document.querySelector('#settingsModal [data-close="settingsModal"]')?.click()
  await wait(600)
  await arm(4)
  const appeared = await until(() => Boolean(card()), 30000)
  note('на английском карточка заведена', appeared, cardText().slice(0, 120))
  const title = (card() && card().querySelector('.task-center-title')) || { textContent: '' }
  note('заголовок карточки переведён', /Schedule: /.test(title.textContent), title.textContent)
  // Имя записи — данные человека, оно переводу не подлежит: смотрим только
  // служебное слово перед двоеточием.
  note('служебная часть заголовка без кириллицы', !/[А-Яа-яЁё]/.test(title.textContent.split(':')[0]), title.textContent)
  const done = await until(() => /Completed|Завершено/i.test(cardText()), 45000)
  note('ход дошёл до конца и на английском экране', done, cardText().slice(0, 130))
`

;
(async () => {
  await launch('pause', PAUSE, { answerChars: LONG_ANSWER })
  await launch('run', RUN, { answerChars: SHORT_ANSWER })
  await launch('english', ENGLISH, { answerChars: SHORT_ANSWER })

  const failed = report.filter(item => !item.pass)
  fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({ ok: !failed.length, report }, null, 2))
  console.log('\n' + report.map(item => `${item.pass ? 'ok  ' : 'ПРОВАЛ'} [${item.group}] ${item.name}${item.detail ? ' — ' + item.detail.slice(0, 130) : ''}`).join('\n'))
  console.log(`Проверок: ${report.length}, отказов: ${failed.length}`)
  console.log(JSON.stringify({ ok: !failed.length, checks: report.length, failed: failed.length, shots }))
  settleRun(output, !failed.length)
  process.exitCode = failed.length ? 1 : 0
})().catch(error => {
  console.error('ПРОГОН УПАЛ:', (error && error.stack) || (error && error.message))
  settleRun(output, false)
  process.exitCode = 1
})
