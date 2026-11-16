// Агент-режим на живых моделях: один ход в настоящем окне и разбор того, что
// произошло. Запускается из tests/run-e2e-agents.cjs; сценарий, модель и
// правильные ответы приходят первыми строками файла.
(async () => {
  const checks = []
  const facts = {}
  const note = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' })
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const $ = id => document.getElementById(id)
  const until = async (fn, ms) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(250) }
    return false
  }

  const KEY = '__ONECODE_ARG__'
  const scenario = window.__scenario
  const expect = window.__expect || {}
  const t0 = Date.now()
  const at = () => Math.round((Date.now() - t0) / 100) / 10

  // --- всё, что ход сообщает, пока идёт ------------------------------------------
  const stages = []     // { index, name, title, t }
  const completes = []  // { index, name, t, ok, aborted, incomplete, content }
  const plans = new Map()
  const events = []
  const chunkSpan = new Map() // index -> [first, last]
  const thrown = []
  window.addEventListener('error', e => thrown.push(String(e.message || e.error)))
  window.addEventListener('unhandledrejection', e => thrown.push('promise: ' + String(e.reason && (e.reason.message || e.reason))))

  const api = window.electronAPI
  api.onAgentStageStart?.(s => stages.push({ index: (s.stage || 1) - 1, name: s.agentName, title: s.taskTitle || '', t: at() }))
  api.onMessageComplete?.(r => completes.push({ index: r.agentIndex ?? 0, name: r.agentName || '', t: at(),
    ok: r.ok, aborted: r.aborted, incomplete: r.incomplete, content: String(r.content || '') }))
  api.onAgentPlan?.(p => plans.set(p.agentIndex ?? 0, (p.items || []).map(i => String(i.title || '').toLowerCase().trim())))
  api.onAgentEvent?.(e => { if (e?.message) events.push({ index: e.agentIndex ?? 0, text: String(e.message), t: at() }) })
  const streamed = new Map() // index -> весь текст ответа, пришедший потоком
  const span = (c) => {
    const index = c?.agentIndex ?? 0
    const now = at()
    const s = chunkSpan.get(index)
    if (s) s[1] = now; else chunkSpan.set(index, [now, now])
  }
  api.onMessageChunk?.(c => {
    span(c)
    const index = c?.agentIndex ?? 0
    streamed.set(index, (streamed.get(index) || '') + String(c?.choices?.[0]?.delta?.content || ''))
  })
  api.onMessageReasoningChunk?.(span)

  const turnRunning = () => Boolean(document.querySelector('.btn-send.is-stop'))

  try {
    // --- подготовка ------------------------------------------------------------------
    await until(() => $('composerTextarea') && $('attachBtn'), 20000)
    await wait(1500)
    if (window.__useStoredKeys) {
      const keys = await api.getOpenRouterKeys()
      const list = Array.isArray(keys) ? keys : (keys?.keys || [])
      facts.keys = list.length
      note('ключи приложения на месте', list.length > 0, 'ключей ' + list.length)
    } else {
      const added = await api.addOpenRouterKey({ key: KEY, name: 'e2e-agents' })
      note('ключ принят', added && !added.error, added?.error || '')
    }
    await api.setWorkspace({ path: window.__workspace, permission: 'auto', extraPaths: [] })

    // Каталог после нового ключа перечитывается; модель выбирается так же, как
    // её выбирает человек, — иначе окно отправит ход своей модели по умолчанию.
    let picked = ''
    await until(() => {
      picked = window.__pickModel?.(window.__liveModel) || ''
      return picked === window.__liveModel
    }, 30000)
    facts.model = picked || '(не выбралась)'
    note('модель выбрана', picked === window.__liveModel, picked)
    await wait(800)

    // --- сообщение -------------------------------------------------------------------
    const MESSAGES = {
      solo: 'Сколько будет 17 умножить на 23? Ответь одним числом.',
      team: 'Работайте вместе, двумя агентами одновременно: пусть один прочитает package.json и назовёт версию приложения, ' +
        'а другой в это же время посчитает, сколько строк в файле tests/run-smoke.cjs. ' +
        'Ничего не меняйте. В итоговом ответе — одна строка с обоими фактами.',

    }

    const ta = $('composerTextarea')
    ta.value = MESSAGES[scenario]
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(300)
    const sentAt = at()
    const answersBefore = $('messagesList').querySelectorAll('.msg-item.assistant').length
    $('composerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    // --- ход -------------------------------------------------------------------------
    // Быстрый ответ успевает начаться и кончиться между двумя опросами, и одной
    // кнопки остановки мало: ход считается начатым и по появившемуся ответу, а
    // законченным — когда кнопка остановки не возвращается три секунды подряд.
    const LIMIT = 12 * 60 * 1000
    const began = Date.now()
    let running = false
    let quietSince = 0
    while (Date.now() - began < LIMIT) {
      const card = document.querySelector('.approval-card')
      const allow = card && [...card.querySelectorAll('button')].find(b => /разреш/i.test(b.textContent || ''))
      if (allow) { allow.click(); facts.approvals = (facts.approvals || 0) + 1 }
      const ask = document.querySelector('.ask-card:not(.answered) .ask-option')
      if (ask) { ask.click(); facts.questionsAnswered = (facts.questionsAnswered || 0) + 1 }
      if (turnRunning()) running = true
      if ($('messagesList').querySelectorAll('.msg-item.assistant').length > answersBefore) running = true
      if (running && !turnRunning()) {
        quietSince = quietSince || Date.now()
        if (Date.now() - quietSince > 3000) break
      } else {
        quietSince = 0
      }
      await wait(500)
    }
    facts.seconds = Math.round((Date.now() - began) / 1000)
    note('ход начался', running)
    note('ход закончился сам', running && !turnRunning(), facts.seconds + ' с')
    await wait(3000)

    // --- что вышло -------------------------------------------------------------------
    const list = $('messagesList')
    const answerEl = [...list.querySelectorAll('.msg-item.assistant')].pop()
    const holder = answerEl?.querySelector('.msg-blocks')
    const nodes = holder ? [...holder.children] : []
    const reports = nodes.filter(n => n.classList.contains('agent-report'))
    const leadText = nodes.filter(n => n.classList.contains('msg-content')).map(n => n.innerText || '').join('\n').trim()
    const helperStages = stages.filter(s => s.index > 0)
    const helperDone = completes.filter(c => c.index > 0)

    facts.stages = stages.map(s => `${s.name}@${s.t}${s.title ? '(' + s.title + ')' : ''}`).join(' ; ') || '(нет)'
    facts.completes = completes.map(c => `${c.name || 'Агент ' + (c.index + 1)}@${c.t}${c.ok === false ? '!' : ''}`).join(' ; ') || '(нет)'
    facts.reports = reports.map(r => (r.querySelector('summary')?.innerText || '').replace(/\s+/g, ' ')).join(' | ') || '(нет)'
    facts.answer = leadText.replace(/\s+/g, ' ').slice(0, 300) || '(пусто)'
    facts.blocks = nodes.map(n => n.classList.contains('agent-report') ? 'помощник'
      : n.classList.contains('tool') ? 'инструмент' : n.classList.contains('think') ? 'мысль'
      : n.classList.contains('plan-inline') ? 'чек-лист' : 'текст').join(',')
    const news = events.filter(e => /новости команды/.test(e.text))
    facts.teamNews = news.length
    const problems = events.filter(e => /\b(400|401|402|403|429|500|502|503)\b|Bad Request|rate.?limit|лимит|не ответил|оборвал/i.test(e.text))
    facts.providerTrouble = problems.map(e => e.text).slice(0, 6).join(' | ') || 'нет'
    facts.leadEvents = events.filter(e => e.index === 0).map(e => `${e.t}: ${e.text}`).slice(0, 25).join(' | ')
    // Что делали помощники и сколько это заняло — по каждому отдельно.
    for (const index of [...new Set(events.filter(e => e.index > 0).map(e => e.index))].sort()) {
      facts['agent' + (index + 1) + 'Events'] = events.filter(e => e.index === index)
        .map(e => `${e.t}: ${e.text}`).slice(-18).join(' | ')
    }

    note('ход не упал внутренней ошибкой', !/TypeError|ReferenceError|is not a function|Ошибка генерации/.test(leadText),
      leadText.slice(0, 120))
    note('в окне не было исключений', thrown.length === 0, thrown.join(' | ').slice(0, 300))
    note('в ответе есть текст', leadText.length > 0, facts.blocks)

    // Слова помощника не должны оказаться в тексте ведущего: ради этого дорожки.
    const flat = text => String(text || '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ')
    const leadOwn = flat(streamed.get(0))
    // Кто подменял ведущего: его слова в итоге — не протечка, а сам ответ.
    // Ведущий на бесплатной модели отказывает регулярно, и работу за него
    // доделывает помощник; раньше такой ход выглядел бы нарушением дорожек.
    const standIns = new Set()
    for (const event of events) {
      const found = String(event.text || '').match(/переходит к (Агент \d+)/)
      if (found) standIns.add(found[1])
    }
    const leaked = helperDone.filter(c => {
      if (standIns.has(String(c.name || '').split(' · ')[0])) return false
      const words = flat(c.content).trim()
      if (words.length < 60) return false
      const probe = words.slice(Math.floor(words.length / 3), Math.floor(words.length / 3) + 40)
      // Протечка — чужие слова в ленте ведущего, которых нет в его собственном потоке.
      return flat(leadText).includes(probe) && !leadOwn.includes(probe)
    })
    const helperThoughts = nodes.filter(n => n.classList.contains('think') && !n.classList.contains('tool') &&
      /^Агент (?!1\b)\d/.test(n.dataset.agent || ''))

    if (scenario === 'solo') {
      note('команда не собиралась', helperStages.length === 0 && reports.length === 0,
        `стартов помощников ${helperStages.length}, строк помощников ${reports.length}`)
      note('ответ верный', /\b391\b/.test(leadText), facts.answer)
    }

    if (scenario === 'team') {
      note('помощники действительно работали', helperDone.length >= 1,
        `стартов ${helperStages.length}, сдали ${helperDone.length}`)
      note('каждый сдавший помощник оставил в ленте одну строку', reports.length === helperDone.length,
        `строк ${reports.length}, сдали ${helperDone.length}`)
      note('мысли помощников не рассыпаны по ленте', helperThoughts.length === 0, 'блоков ' + helperThoughts.length)
      note('слова помощников не попали в ответ ведущего', leaked.length === 0,
        leaked.map(c => c.name).join(', '))

      // Одновременность — по отрезкам «начал — сдал» разных помощников.
      const spans = new Map()
      // Объявление состава («Ожидает назначения») — не запуск части.
      for (const s of helperStages.filter(stage => stage.title !== 'Ожидает назначения')) {
        const done = completes.find(c => c.index === s.index && c.t >= s.t && !spans.get('used:' + completes.indexOf(c)))
        if (done) {
          spans.set('used:' + completes.indexOf(done), true)
          if (!spans.has(s.index)) spans.set(s.index, [])
          spans.get(s.index).push([s.t, done.t, s.title])
        }
      }
      const intervals = [...spans.entries()].filter(([k]) => typeof k === 'number')
      let overlap = false
      for (let i = 0; i < intervals.length; i++) {
        for (let j = i + 1; j < intervals.length; j++) {
          for (const a of intervals[i][1]) for (const b of intervals[j][1]) {
            if (a[0] < b[1] && b[0] < a[1]) overlap = true
          }
        }
      }
      facts.parallel = overlap ? 'да' : 'нет'
      facts.intervals = intervals.map(([k, list]) => `Агент ${k + 1}: ` + list.map(x => `${x[0]}–${x[1]}${x[2] ? ' ' + x[2] : ''}`).join(', ')).join(' ; ')
      // Без сдавших помощников одновременность не доказуема — честный провал,
      // а не «ок» из-за пустого множества интервалов.
      note('разные помощники работали одновременно', helperDone.length >= 2 && overlap, facts.intervals)

      // Один агент — одна часть за раз.
      let doubleBooked = false
      for (const [, list] of intervals) {
        const sorted = [...list].sort((a, b) => a[0] - b[0])
        for (let i = 1; i < sorted.length; i++) if (sorted[i][0] < sorted[i - 1][1]) doubleBooked = true
      }
      note('ни один агент не вёл две части сразу', !doubleBooked, facts.intervals)

      // Чек-листы разных агентов не должны быть копиями.
      const lists = [...plans.entries()].filter(([, items]) => items.length)
      facts.checklists = lists.map(([k, items]) => `Агент ${k + 1}: ${items.join(' / ')}`).join(' ; ') || '(никто не заводил)'
      let copies = false
      for (let i = 0; i < lists.length; i++) {
        for (let j = i + 1; j < lists.length; j++) {
          const a = new Set(lists[i][1]), b = new Set(lists[j][1])
          const common = [...a].filter(x => b.has(x)).length
          const union = new Set([...a, ...b]).size
          if (union && common / union > 0.5) copies = true
        }
      }
      note('чек-листы агентов не копии друг друга', !copies, facts.checklists)

      const stored = await api.getConversations()
      const chat = (stored || []).find(c => (c.messages || []).some(m => m.role === 'user' && String(m.content || '').startsWith(MESSAGES[scenario].slice(0, 30))))
      const saved = chat ? chat.messages.filter(m => m.role === 'assistant').pop() : null
      facts.savedRunAgents = saved?.agentRun?.agents?.length || 0
      note('работа команды сохранена в истории', facts.savedRunAgents >= 2, 'агентов в записи ' + facts.savedRunAgents)
      note('история доступна из заголовка', Boolean(document.querySelector('#chatHeader .tasks-header-btn')))
    }

    if (scenario === 'team') {
      note('в ответе верная версия', leadText.includes(expect.version), `ждали ${expect.version}: ${facts.answer}`)
      const numbers = (leadText.match(/\d{2,5}/g) || []).map(Number)
      note('в ответе верное число строк', numbers.some(n => Math.abs(n - expect.smokeLines) <= 2),
        `ждали ${expect.smokeLines}: ${facts.answer}`)
    }

    facts.sentAt = sentAt
  } catch (error) {
    note('прогон без исключений', false, String(error && (error.stack || error.message) || error).slice(0, 400))
  }

  return { ok: checks.every(c => c.pass), checks, facts }
})()
