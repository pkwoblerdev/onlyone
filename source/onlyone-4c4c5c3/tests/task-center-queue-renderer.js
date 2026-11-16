// Очередь фоновых задач в настоящем окне (план, 3.4).
//
// Здесь нет ни подставных часов, ни подставного процесса: карточки лежат в
// журнале профиля, их читает и исполняет настоящий планировщик настоящего
// главного процесса, а дочерние процессы — настоящие `node`, поднятые по
// `command` из журнала. Проверяется ровно то, что видит человек: предел
// одновременных, ожидание очереди, пауза, отмена, падение с причиной и
// «прервано» после перезапуска приложения.
//
// Состояние читается из класса карточки (`status-running`), а не из подписи:
// подпись живёт на двух языках, и проверка переезжала бы вместе с локалью.
(async () => {
  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decode('__ONECODE_ARG__')
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(60) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const list = () => document.querySelector('#taskCenterList')
  const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
  const rows = () => [...list().querySelectorAll('.task-center-row')]
  const card = row => (row ? row.querySelector('.task-center-item') : null)
  const titleOf = row => text(card(row)?.querySelector('.task-center-title'))
  const stateOf = row => (String(card(row)?.className || '').match(/status-([a-z]+)/) || [])[1] || ''
  const stateText = row => text(card(row)?.querySelector('.task-center-state'))
  const reasonOf = row => text(row?.querySelector('.task-center-error'))
  const buttons = row => [...(row ? row.querySelectorAll('.task-center-action') : [])].map(b => b.dataset.taskAction)
  const buttonLabels = row => [...(row ? row.querySelectorAll('.task-center-action') : [])].map(b => text(b))
  const percent = row => Number(row?.querySelector('.task-center-progress')?.getAttribute('aria-valuenow') || 'NaN')
  // Заголовок уходит в окно зачищенным: карточка с токеном в имени ищется по
  // началу строки, потому что сам токен человек читает как `***`.
  const byTitle = title => rows().find(row => titleOf(row) === title)
    || rows().find(row => titleOf(row).startsWith(title))
  const howMany = state => rows().filter(row => stateOf(row) === state).length
  const say = () => rows().map(row => `${titleOf(row)}=${stateOf(row)}`).join(', ')
  const anyOf = (...states) => rows().find(row => states.includes(stateOf(row)))

  async function clickAction(title, name) {
    const row = byTitle(title)
    const button = row && [...row.querySelectorAll('.task-center-action')].find(b => b.dataset.taskAction === name)
    if (!button) return false
    button.click()
    // Перерисовка после действия идёт не раньше следующего удара троттла.
    await wait(700)
    return true
  }

  // Пик одновременных берётся из наблюдений окна: человек видит список кадр за
  // кадром, и «никогда не больше трёх» обязано значить именно это.
  const seen = []
  let sampler = null
  const live = arg.mode === 'queue' || arg.mode === 'queue-en'

  async function run() {
    if (!await until(() => document.documentElement.dataset.appReady === '1')) {
      note('окно не поднялось', false)
      return
    }
    if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
    await wait(250)
    document.dispatchEvent(new CustomEvent('open-task-center'))
    const mounted = await until(() => rows().length >= arg.minRows, 15000)
    note('раздел показал карточки очереди', mounted, `строк: ${rows().length}, ждали не меньше ${arg.minRows}`)
    if (!mounted) return
    if (live) sampler = setInterval(() => { seen.push(howMany('running')) }, 60)

    note('каждая строка подписана очередью задач',
      rows().every(row => text(card(row).querySelector('.task-center-meta')).includes(arg.surfaceLabel)),
      rows().map(row => text(card(row).querySelector('.task-center-meta'))).join(' | ').slice(0, 120))
    note('командная строка задачи не уезжает в окно',
      !list().innerHTML.includes(arg.nodeExe) && !list().innerHTML.includes('setTimeout'),
      'в разметке нет ни пути к node, ни тела `-e`')
    note('секрета из журнала в окне нет', !list().innerHTML.includes(arg.secret))
    const masked = byTitle(arg.titles.secret)
    note('токен зачищен прямо в заголовке карточки',
      Boolean(masked) && !titleOf(masked).includes(arg.secret) && titleOf(masked).includes('***'),
      titleOf(masked))
    const withBar = rows().filter(row => Number.isFinite(percent(row)))
    note('полоса работы показана там, где назван процент', withBar.length >= 1,
      withBar.map(row => `${titleOf(row)}:${percent(row)}%`).join(', '))
    note('без числа полоса не выдумывается', rows().some(row => !Number.isFinite(percent(row))))

    if (live) {
      // Предельное число одновременных: в работе три, остальным ждать.
      const limited = await until(() => howMany('running') >= 3 && howMany('waiting') >= 1, 12000)
      note('при пределе в работе три, остальные ждут в очереди', limited, say())
      note('работа названа работой, ожидание — ожиданием',
        stateText(anyOf('running')) === arg.labels.running && stateText(anyOf('waiting')) === arg.labels.waiting,
        `${stateText(anyOf('running'))} / ${stateText(anyOf('waiting'))}`)

      // Пауза живой задачи: процесс снимается, кнопка паузы исчезает.
      const started = await until(() => stateOf(byTitle(arg.titles.pause)) === 'running', 12000)
      const pauseClicked = started && await clickAction(arg.titles.pause, 'pause')
      note('на работающей задаче есть кнопка паузы', pauseClicked, say())
      const pausedShown = await until(() => {
        const row = byTitle(arg.titles.pause)
        return Boolean(row) && stateOf(row) !== 'running' && !buttons(row).includes('pause') && buttons(row).includes('resume')
      }, 8000)
      note('пауза сняла процесс и предложила возобновить', pausedShown,
        `${stateOf(byTitle(arg.titles.pause))} · ${buttons(byTitle(arg.titles.pause)).join(',')}`)

      // Отмена ожидающей: она не успела начаться и закрывается по-человечески.
      const cancelClicked = await clickAction(arg.titles.cancel, 'cancel')
      note('на ожидающей задаче есть кнопка отмены', cancelClicked,
        buttons(byTitle(arg.titles.cancel)).join(','))
      const cancelled = await until(() => stateOf(byTitle(arg.titles.cancel)) === 'complete', 8000)
      note('отменённая задача ушла из очереди в завершённые', cancelled,
        `${stateOf(byTitle(arg.titles.cancel))} · ${stateText(byTitle(arg.titles.cancel))}`)

      // Падение с причиной: код возврата дочернего процесса человек читает словами.
      const crashed = await until(() => {
        const row = byTitle(arg.titles.crash)
        return Boolean(row) && stateOf(row) === 'problem' && reasonOf(row).includes(arg.crashCode)
      })
      note('падение показывает причину с кодом процесса', crashed,
        `${stateText(byTitle(arg.titles.crash))} · ${reasonOf(byTitle(arg.titles.crash))}`)
      const secretFell = await until(() => stateOf(byTitle(arg.titles.secret)) === 'problem')
      note('задача, упавшая с токеном в выводе, тоже названа падением', secretFell,
        reasonOf(byTitle(arg.titles.secret)))
      note('окно ни в один момент не показывало больше трёх работ',
        seen.length >= 5 && Math.max(0, ...seen) <= 3,
        `наблюдений: ${seen.length}, пик «в работе»: ${Math.max(0, ...seen)}`)
      // Долгая задача обязана дойти до запуска и остаться в работе на момент
      // выхода: журнал на диске сохранится со словом «running», и следующий
      // запуск превратит её в «прерванную».
      if (arg.mode === 'queue') {
        note('долгая задача взята в работу до конца прогона',
          await until(() => stateOf(byTitle(arg.titles.long)) === 'running'), say())
        // Кадр доказывает предел: под фильтром «Активные» три «В работе» и
        // ожидающие рядом видны целиком, а не разъехались по списку.
        document.querySelector('[data-task-filter="active"]')?.click()
        const narrowed = await until(() => howMany('running') >= 3 && howMany('waiting') >= 1, 6000)
        list()?.scrollIntoView({ block: 'start' })
        note('фильтр «Активные» держит предел в кадре', narrowed, say())
        await wait(400)
      }
    }

    if (arg.mode === 'interrupted') {
      // Та же «Долгая сборка», что в прошлом запуске ушла в работу и была там
      // застигнута выходом приложения: карточка читает её состояние с диска.
      const row = byTitle(arg.titles.long)
      note('задача, застигнутая закрытием приложения, названа прерванной',
        Boolean(row) && stateOf(row) === 'interrupted' && stateText(row) === arg.labels.interrupted,
        row ? `${stateOf(row)} · ${stateText(row)}` : 'карточки нет')
      note('у прерванной задачи названа причина', Boolean(row) && reasonOf(row).length > 0, reasonOf(row))
      note('прерванную планировщик поднимает сам, только если её вернут в очередь',
        !buttons(row).includes('pause') && buttons(row).includes('resume'), buttons(row).join(','))
      const resumed = await clickAction(arg.titles.long, 'resume')
      const backToWork = resumed && await until(() => stateOf(byTitle(arg.titles.long)) === 'running')
      note('возобновление прерванной задачи поднимает процесс', backToWork,
        `${stateOf(byTitle(arg.titles.long))} · ${say()}`)
      const again = await clickAction(arg.titles.crash, 'restart')
      const rerun = again && await until(() => {
        const one = byTitle(arg.titles.crash)
        return Boolean(one) && (stateOf(one) === 'running' || stateOf(one) === 'problem')
      })
      note('перезапуск упавшей задачи отправляет её в очередь заново', rerun,
        `${stateOf(byTitle(arg.titles.crash))} · ${reasonOf(byTitle(arg.titles.crash))}`)

      // Кадр обязан показывать то, что проверяется: прерванные карточки уходят
      // ниже видимой части списка, поэтому перед снимком — фильтр
      // «С проблемами» и прокрутка до прерванной.
      document.querySelector('[data-task-filter="problems"]')?.click()
      const filtered = await until(() => rows().length >= 2 &&
        rows().every(row => ['interrupted', 'problem'].includes(stateOf(row))), 6000)
      note('фильтр «С проблемами» оставляет прерванные и упавшие', filtered, say())
      byTitle(arg.titles.second)?.scrollIntoView({ block: 'center' })
      await wait(400)
    }

    if (arg.mode === 'queue-en') {
      const interrupted = stateOf(byTitle(arg.titles.long)) === 'interrupted'
      await window.__setLanguage('en')
      await wait(900)
      const line = rows().map(row => stateText(row)).join(' | ')
      note('состояния очереди переведены на английский',
        line.includes(arg.en.running) && line.includes(arg.en.waiting)
        && !/Ожидает|В работе|Прервано|Есть проблема|Завершено/.test(line),
        line.slice(0, 200))
      note('прерванная названа прерванной и на английском',
        interrupted && stateText(byTitle(arg.titles.long)) === arg.en.interrupted,
        stateText(byTitle(arg.titles.long)))
      const labels = rows().map(row => buttonLabels(row).join('/')).join(' | ')
      note('кнопки очереди переведены', /Pause|Resume|Restart|Cancel/.test(labels)
        && !/Пауза|Возобновить|Перезапустить|Отменить/.test(labels), labels.slice(0, 200))
      note('поверхность карточки названа по-английски',
        rows().every(row => text(card(row).querySelector('.task-center-meta')).includes('Task queue')),
        rows().map(row => text(card(row).querySelector('.task-center-meta'))).join(' | ').slice(0, 120))
      // Кадр: прерванная карточка в английской подписи, а не ниже видимой
      // части списка.
      byTitle(arg.titles.long)?.scrollIntoView({ block: 'center' })
      await wait(400)
    }

    if (sampler) clearInterval(sampler)
    await wait(200)
  }

  try {
    await run()
  } catch (error) {
    note('проверка упала', false, String((error && error.stack) || error).slice(0, 500))
  }
  return { ok: checks.every(c => c.pass), checks, peak: Math.max(0, ...seen) }
})()
