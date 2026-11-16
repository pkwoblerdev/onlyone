// A real agent turn, driven through the real window, against the real model.
//
// Everything else here is either structural or faked: the UI test replaces the
// model so it stays offline, and the live test calls OpenRouter directly without
// the app around it. Neither can see what the agent loop actually does — which
// is why every defect in it has been reported from a screenshot and fixed a
// guess at a time.
//
// This one sets up a throwaway profile, sends one real message in agent mode and
// watches until the turn ends, then reports what actually happened: which model
// answered, how many steps, what tools were called, and — the thing that keeps
// going wrong — whether the answer is in the conversation afterwards.
(async () => {
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' })
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const $ = id => document.getElementById(id)

  const KEY = '__ONECODE_ARG__'
  const facts = {}

  // Everything the loop announced while it worked. The recoveries — carrying on
  // a cut-off answer, carrying on a turn the agent called unfinished, giving
  // tools back — are invisible in the finished answer by design, and this is the
  // only place a run can say whether they actually fired.
  const events = []
  window.electronAPI?.onAgentEvent?.(e => {
    const text = String(e?.message || '')
    if (/продолжаю|возвращаю|обрезанным|предел/i.test(text)) events.push(text)
  })

  // A turn is live exactly while its stop control is on screen.
  //
  // This used to ask whether the send button carried a `stop-mode` class.
  // Nothing has set that class since the send button stopped doubling as a stop
  // button, so every one of these questions answered «not running»: the waits
  // below ran their full timeout, «кнопка остановки на месте» could only fail,
  // and «после остановки можно писать дальше» could only pass — while the stop
  // was never actually clicked, because the element it looked for was null.
  // Остановка одна и живёт в строке ввода: вторая, в строке состояния ответа,
  // убрана как третье место с тем же смыслом.
  const turnRunning = () => Boolean(document.querySelector('.btn-send.is-stop'))
  const stopControl = () => document.querySelector('.btn-send.is-stop')
  const panesBusy = turnRunning

  try {
    // --- setup ---------------------------------------------------------------
    const added = await window.electronAPI.addOpenRouterKey({ key: KEY, name: 'e2e' })
    note('ключ принят', added?.success !== false, JSON.stringify(added).slice(0, 120))

    // The launcher passes a working folder that exists on this machine. For the
    // twins scenario it is a pair of throwaway folders both called 1code, which
    // is the collision this scenario is about.
    await window.electronAPI.setWorkspace({
      path: window.__workspace,
      permission: 'auto',
      extraPaths: window.__workspaceExtra || []
    })
    const ws = await window.electronAPI.getWorkspace()
    note('рабочая папка выбрана', Boolean(ws?.path), ws?.path || '(нет)')

    // The reported loss happened in a chat inside a project, where the agent
    // writes project notes mid-turn — and every such write saves the history and
    // reloads it in the window. That reload is what used to orphan the chat the
    // running turn was holding, so the answer was pushed into an object nothing
    // could see. Reproducing it needs the project, not just the question.
    if (window.__scenario === 'project') {
      await window.electronAPI.setProjects([{
        id: 'e2e-project',
        name: 'Проверка проекта',
        description: 'Для сквозного прогона',
        instructions: 'Записывай найденное в заметки проекта.',
        knowledge: [],
        plan: [],
        folders: []
      }])
      await wait(600)
    }

    // A project with everything an agent is supposed to see: its own
    // instructions, a knowledge file, and a sibling chat holding a fact that
    // appears nowhere else in the app.
    // The cut-off run needs a model that starts writing promptly: the point is
    // the join, not one free model's habit of thinking through its whole
    // allowance before the first word.
    if (window.__scenario === 'cutoff') {
      await window.electronAPI.setSettings({ defaultModel: 'z-ai/glm-5.3-flash' })
      facts.pickedModel = window.__pickModel('z-ai/glm-5.3-flash')
      note('модель для прогона выбрана', facts.pickedModel === 'z-ai/glm-5.3-flash',
        facts.pickedModel || '(не выбралась)')
    }

    if (window.__scenario === 'project-deep') {
      // Reading a project and routing work through it is the complex-task case,
      // so it runs on the lead model rather than a free helper.
      await window.electronAPI.setSettings({ defaultModel: 'z-ai/glm-5.3-flash' })
      facts.pickedModel = window.__pickModel('z-ai/glm-5.3-flash')
      note('ведущая модель выбрана', facts.pickedModel === 'z-ai/glm-5.3-flash',
        facts.pickedModel || '(не выбралась)')
      await window.electronAPI.setProjects([{
        id: 'deep',
        name: 'Проверка проекта',
        description: 'Проект для сквозного прогона',
        instructions: 'Заканчивай каждый ответ строкой ПРОЕКТ-ОК.',
        // Deliberately outside the working folder: that is where a knowledge
        // file normally lives, and where the file tools cannot reach it.
        knowledgeFiles: [{ path: '__KNOWLEDGE__', name: 'справочник-цен.md' }],
        plan: [],
        folders: []
      }])

      // The sibling holds the fact. Nothing else knows the number 8123.
      const chats = await window.electronAPI.getConversations()
      chats.push({
        id: 'sibling-chat',
        title: 'Склад',
        projectId: 'deep',
        topic: 'учёт остатков',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          { role: 'user', content: 'Сколько единиц на складе?' },
          { role: 'assistant', content: 'На складе ровно 8123 единицы товара.' }
        ]
      })
      await window.electronAPI.setConversations(chats)
      // Without this the window keeps its old list and saves over the sibling.
      facts.siblingChats = await window.__reloadChats()

      // The open chat joins the project last, the way the chat menu does it —
      // after the reload, so nothing merges over it.
      facts.joined = window.__joinProject('deep')
      note('текущий диалог лежит в проекте', facts.joined === 'deep',
        facts.joined || '(не в проекте)')
      await wait(600)
      note('соседний диалог создан в проекте', facts.siblingChats >= 2,
        'диалогов ' + facts.siblingChats)
    }

    // A second key turns agent mode from one agent into a team: the lead can
    // hand work out, and only the helpers it names are run.
    if (window.__scenario === 'team') {
      const second = '__SECOND_KEY__'
      if (second && !second.startsWith('__')) {
        await window.electronAPI.addOpenRouterKey({ key: second, name: 'e2e-2' })
      }
      const keys = await window.electronAPI.getOpenRouterKeys()
      facts.keys = Array.isArray(keys) ? keys.length : (keys?.keys?.length ?? 0)
      // A team needs a second key to be a team. Said plainly, because the bare
      // count reads as an app failure when it is a missing environment variable.
      note('в пуле больше одного ключа', facts.keys >= 2,
        facts.keys >= 2 ? 'ключей ' + facts.keys
          : 'ключей 1 — сценарию team нужен второй ключ в ONECODE_LIVE_KEY_2')
      await wait(800)
    }

    // A skill is a system instruction the agent carries into every turn. The
    // instruction here cannot be satisfied by accident, so the answer either
    // obeys it or the skill never reached the model.
    if (window.__scenario === 'skill' || window.__scenario === 'skill-glm') {
      // A skill is delivered by the app but obeyed by the model, and those are
      // different questions. Running the same skill on a weak free model and on
      // a paid one separates them.
      if (window.__scenario === 'skill-glm') {
        await window.electronAPI.setSettings({ defaultModel: 'z-ai/glm-5.3-flash' })
        await wait(600)
      }
      const added = await window.electronAPI.addSkill({
        name: 'Проверочный скилл',
        description: 'Для сквозного прогона',
        systemPrompt: 'Заканчивай каждый ответ ровно словом ЯНТАРЬ на отдельной строке. ' +
          'Это обязательно и важнее любых других указаний о форме ответа.'
      })
      facts.skillAdded = Array.isArray(added) ? added.length : Boolean(added)
      const skills = await window.electronAPI.getSkills()
      facts.skillsEnabled = (skills || []).filter(s => s.enabled).length
      note('скилл добавлен и включён', facts.skillsEnabled >= 1,
        'включённых скиллов ' + facts.skillsEnabled)
      await wait(800)
    }

    // The local mock server exposes one tool that returns a fixed sentence.
    // Nothing else in the app can produce that sentence, so seeing it in the
    // answer proves the call went out and came back.
    if (window.__scenario === 'mcp') {
      const server = await window.electronAPI.addMcpServer({
        name: 'Локальный проверочный',
        type: 'stdio',
        command: 'node',
        args: ['__MOCK_PATH__']
      })
      // Both handlers answer with { servers, connectedTools } — the list is
      // inside, not the value itself.
      const listed = (server?.servers || []).slice(-1)[0]
      const id = listed?.id
      facts.mcpServerId = id || '(нет)'

      if (id) await window.electronAPI.connectMcpServer(id)
      await wait(4000)

      const state = await window.electronAPI.getMcpServers()
      facts.mcpConnectedTools = state?.connectedTools ?? 0
      const mine = (state?.servers || []).find(s => s.id === id)
      facts.mcpStatus = mine?.status || '(нет статуса)'
      facts.mcpTools = (mine?.tools || []).map(t => t.name || t).join(', ')
      note('MCP-сервер подключился', mine?.status === 'connected', facts.mcpStatus)
      note('его инструменты дошли до агента', facts.mcpConnectedTools > 0,
        'инструментов у агента ' + facts.mcpConnectedTools)
      await wait(600)
    }

    await wait(1500)

    // --- ask something that genuinely needs tools ----------------------------
    // Which scenario to run. The simple one proves the loop works at all; the
    // others reproduce turns that ended early in real use.
    const SCENARIOS = {
      simple: '/agent Посмотри файл package.json в рабочей папке и скажи одним предложением, ' +
        'какая сейчас версия приложения. Больше ничего не делай.',

      // The reported failure: the turn ended right after «Свой инструмент: asar_read».
      tool: '/agent Напиши себе инструмент через define_tool, который считает строки в файле, ' +
        'и посчитай им строки в package.json. Ответь числом.',

      // Several steps in a row — the shape that was losing its answer.
      steps: '/agent Прочитай package.json, потом src/main/main.js, потом tests/run-smoke.cjs. ' +
        'Скажи в одном предложении, сколько строк в самом большом из трёх.',

      // A turn that writes a file. The provider answered 400 bad request right
      // after «Записал файл», which is a rejected request, not a limit or a
      // network fault — so what the app sent has to be looked at.
      write: '/agent Создай файл tmp-e2e-check.md в рабочей папке с текстом ' +
        '«проверка записи», потом прочитай его обратно и скажи, что в нём.',

      // An ordinary conversation, no agent mode, asking for an answer long
      // enough that a truncation would be obvious.
      chat: 'Объясни в шести абзацах, чем отличается потоковая передача ответа ' +
        'от обычной, и почему это важно для интерфейса. Пиши подробно.',

      // Placeholder: the queue scenario sends its own two messages in a row,
      // the second while the first is still being answered.
      queue: 'Объясни в трёх абзацах, что такое обратное давление в потоках.',

      // Long enough that there is something to interrupt.
      stop: 'Объясни очень подробно, в десяти абзацах, как работает сборка ' +
        'Electron-приложения и что делает каждый шаг. Пиши развёрнуто.',

      // Two parts, and an opening for stopping after the first. A model that
      // takes it writes «первое сделал, второе нет, следующий шаг» — which is
      // exactly the turn the app used to close on.
      halfway: '/agent Сделай две вещи по порядку. Первое: создай файл ' +
        'tmp-half-1.md с тремя пунктами про потоковую передачу. Второе: создай ' +
        'файл tmp-half-2.md с разбором этих трёх пунктов. Если успеешь только ' +
        'первое — напиши, что второе не сделано, и какой следующий шаг.',

      // The same task, plus the words the user actually types. Everything else
      // is identical, so a difference in outcome is that instruction and
      // nothing else.
      'whole-job': '/agent Сделай полностью, до конца, две вещи по порядку. ' +
        'Первое: создай файл tmp-half-1.md с тремя пунктами про потоковую ' +
        'передачу. Второе: создай файл tmp-half-2.md с разбором этих трёх ' +
        'пунктов. Если успеешь только первое — напиши, что второе не сделано, ' +
        'и какой следующий шаг.',

      // The output cap is forced down to a few dozen tokens for this run, so
      // the answer is cut off several times over and has to be stitched back.
      cutoff: 'Объясни подробно, в пяти абзацах, как устроена потоковая передача ' +
        'ответа модели и почему её тяжело рисовать в интерфейсе. Пиши сплошным ' +
        'текстом, без списков и заголовков.',

      // The number lives only in a sibling chat of this project.
      'project-deep': '/agent Посмотри соседние диалоги этого проекта и скажи, ' +
        'сколько единиц на складе. Потом посмотри в базе знаний проекта оптовую ' +
        'цену одной единицы и назови её. Потом запиши план проекта из двух шагов ' +
        'через project_plan_set.',

      // Two named files, one fact from each: work that genuinely splits in two.
      team: '/agent Прочитай package.json и tests/run-smoke.cjs. Скажи одним ' +
        'предложением: какая версия в package.json и сколько строк в run-smoke.cjs.',

      // Only the mock MCP server can answer this; nothing in the app knows the
      // sentence it returns.
      mcp: '/agent Вызови инструмент echo_status с подключённого MCP-сервера и ' +
        'приведи дословно то, что он вернул.',

      // An ordinary question. The skill's instruction is what is being checked,
      // not the content of the answer.
      skill: 'В двух предложениях: зачем программе нужны тесты?',
      'skill-glm': 'В двух предложениях: зачем программе нужны тесты?',

      // Placeholder: the switch scenario drives its own two chats.
      switch: 'начнём',

      // Placeholder: the talk scenario asks its own four questions in turn.
      talk: 'начнём',

      // Two folders with the same name. The installed build and the sources are
      // both called 1code, and routing by name made one of them unreachable —
      // every path went to the build, which holds no sources at all.
      twins: '/agent Скажи, какая версия в package.json у той папки 1code, ' +
        'где лежат исходники (не у установленной сборки). Ответь одной строкой.',

      // The exact shape of the reported loss: work inside a project, with notes
      // written to it during the turn, each one reloading the history.
      project: '/agent Прочитай package.json и src/main/main.js. Запиши найденное ' +
        'в заметку проекта через project_note, а потом обязательно ответь мне ' +
        'текстом: сколько строк в main.js.'
    }

    const ta = $('composerTextarea')
    ta.value = SCENARIOS[window.__scenario || 'simple'] || SCENARIOS.simple
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(400)

    if (window.__scenario === 'project') {
      const chats = await window.electronAPI.getConversations()
      const current = (chats || [])[0]
      if (current) {
        current.projectId = 'e2e-project'
        await window.electronAPI.setConversations(chats)
        await wait(400)
      }
      facts.chatInProject = Boolean(current)
    }

    // Asking in one chat, walking away to another while it works, coming back.
    // Answers used to be lost exactly here: the turn holds the chat it started
    // in, the window rebuilds its list underneath, and the answer lands in an
    // object nothing can see.
    if (window.__scenario === 'switch') {
      ta.value = 'Объясни в четырёх абзацах, зачем нужна песочница путей. Подробно.'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(300)
      $('composerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

      // Wait for it to actually start, then leave.
      const began = Date.now()
      while (Date.now() - began < 30000) {
        if (turnRunning()) break
        await wait(300)
      }
      const asked = (await window.electronAPI.getConversations())[0]
      facts.askedIn = asked?.id || '(нет)'

      await wait(1200)
      $('newChatBtn')?.click()
      await wait(1500)
      facts.leftDuringWork = true

      // Wait the turn out from the other chat.
      const waiting = Date.now()
      while (Date.now() - waiting < 180000) {
        const busy = panesBusy()
        if (!busy) break
        await wait(700)
      }
      await wait(2500)

      const saved = await window.electronAPI.getConversations()
      const origin = saved.find(c => c.id === facts.askedIn)
      const answers = (origin?.messages || []).filter(m => m.role === 'assistant')
      facts.answersInOrigin = answers.length
      facts.answerLength = (answers[0]?.content || '').length

      note('ответ пришёл в тот чат, где спрашивали', answers.length === 1,
        'ответов ' + answers.length)
      note('ответ не пустой', facts.answerLength > 200, facts.answerLength + ' символов')

      const others = saved.filter(c => c.id !== facts.askedIn)
      note('в другой чат ничего не утекло',
        others.every(c => (c.messages || []).length === 0),
        others.map(c => (c.messages || []).length).join(', ') || 'других чатов нет')

      // And it is still there after coming back to it.
      // The sidebar row is `.history-item`, and the title inside it is what
      // carries the click. A check that silently does not run is worse than no
      // check, so a missing row is reported rather than skipped.
      const rows = [...document.querySelectorAll('.history-item')]
      const titles = rows.map(r => (r.querySelector('.history-item-title')?.textContent || '').trim())
      facts.sidebarRows = titles.join(' | ').slice(0, 90)

      note('чат, где спрашивали, есть в списке слева', rows.length >= 1, facts.sidebarRows)

      const target = rows.find(r => !r.classList.contains('active')) || rows[0]
      if (target) {
        target.querySelector('.history-item-title')?.click()
        await wait(2000)
        const shown = [...$('messagesList').querySelectorAll('.msg-item.assistant')]
        note('открыв чат из списка, ответ видно на экране', shown.length >= 1,
          'ответов на экране ' + shown.length)
      } else {
        note('открыв чат из списка, ответ видно на экране', false, 'строка чата не найдена')
      }

      return { ok: checks.every(c => c.pass), checks, facts }
    }

    // A conversation, not a turn: four exchanges, each carrying everything
    // before it. This is the shape that was breaking off half-way.
    if (window.__scenario === 'queue') {
      const send = text => {
        ta.value = text
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        $('composerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      }

      send('Объясни в трёх абзацах, что такое обратное давление в потоках.')

      // Wait until it is genuinely working, then type the next one — the way a
      // person does when they remember something mid-answer.
      const busyBy = Date.now()
      while (Date.now() - busyBy < 30000) {
        if (turnRunning()) break
        await wait(200)
      }
      await wait(1200)
      facts.wasBusy = turnRunning()
      note('первый ход действительно шёл, когда пришло второе сообщение',
        facts.wasBusy, 'панель уже освободилась — очередь не проверена')

      send('Ответь одним словом: как называется этот механизм по-английски?')
      await wait(600)
      facts.queuedShown = $('messagesList')?.innerText?.includes('как называется этот механизм') ||
        document.body.innerText.includes('как называется этот механизм')

      // Both turns have to finish, not just the first.
      const bothBy = Date.now()
      while (Date.now() - bothBy < 240000) {
        const busy = turnRunning()
        const said = $('messagesList').querySelectorAll('.msg-item.assistant').length
        if (!busy && said >= 2) break
        await wait(800)
      }
      await wait(2000)

      const bubbles = [...$('messagesList').querySelectorAll('.msg-item')]
      const mine = bubbles.filter(b => b.classList.contains('user')).length
      const theirs = bubbles.filter(b => b.classList.contains('assistant')).length
      facts.bubbles = `мои ${mine}, ответы ${theirs}`

      note('второе сообщение не потерялось', mine === 2, facts.bubbles)
      note('на оба сообщения есть ответы', theirs === 2, facts.bubbles)
      note('ни один из двух ответов не пустой',
        bubbles.filter(b => b.classList.contains('assistant'))
          .every(b => (b.innerText || '').trim().length > 40), facts.bubbles)

      const saved = await window.electronAPI.getConversations()
      const chat = (saved || []).find(c => (c.messages || []).length >= 4)
      facts.savedMessages = chat ? chat.messages.length : 0
      note('очередь дошла до диска, а не только до экрана',
        facts.savedMessages >= 4, 'сообщений ' + facts.savedMessages)

      // Same here: the two messages were sent by hand above.
      return { ok: checks.every(c => c.pass), checks, facts }
    }

    if (window.__scenario === 'stop') {
      ta.value = SCENARIOS.stop
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      $('composerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

      // Let it write a real amount, then interrupt the way a person does.
      const startedAt = Date.now()
      let written = 0
      while (Date.now() - startedAt < 90000) {
        const live = $('messagesList').querySelector('.msg-item.assistant:last-child')
        written = (live?.innerText || '').trim().length
        if (written > 400) break
        await wait(400)
      }
      facts.writtenBeforeStop = written
      note('до остановки успел появиться текст', written > 400, written + ' символов')

      const stopBtn = stopControl()
      facts.stopShown = Boolean(stopBtn)
      note('кнопка остановки на месте', facts.stopShown)
      stopBtn?.click()
      await wait(3000)

      // The composer has to come back, or the chat is dead until restart.
      const stillBusy = turnRunning()
      note('после остановки можно писать дальше', !stillBusy, stillBusy ? 'панель осталась занятой' : '')

      const live = $('messagesList').querySelector('.msg-item.assistant:last-child')
      facts.afterStop = (live?.innerText || '').trim().length
      note('написанное до остановки осталось на экране',
        facts.afterStop > 200, facts.afterStop + ' символов')

      // And in the file. A stop that drops the partial answer is «ответ пропал»
      // by another road.
      const saved = await window.electronAPI.getConversations()
      const chat = (saved || []).find(c => (c.messages || []).some(m => m.role === 'assistant'))
      const text = chat
        ? (chat.messages.filter(m => m.role === 'assistant').pop()?.content || '')
        : ''
      facts.savedAfterStop = text.trim().length
      note('прерванный ответ сохранён, а не выброшен',
        text.trim().length > 200, facts.savedAfterStop + ' символов')

      // This scenario ran the composer itself, so it ends the run here — the
      // generic send below would fire a second turn nobody is watching.
      return { ok: checks.every(c => c.pass), checks, facts }
    }

    if (window.__scenario === 'talk') {
      const questions = [
        'Запомни число 47. Просто ответь «запомнил».',
        'Объясни в трёх абзацах, что такое потоковая передача ответа.',
        'А теперь в двух абзацах — чем она неудобна.',
        'Какое число я просил запомнить в самом начале? Ответь только числом.'
      ]

      const answers = []
      for (const question of questions) {
        ta.value = question
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await wait(300)
        $('composerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

        const turnStart = Date.now()
        let running = false
        while (Date.now() - turnStart < 180000) {
          const busy = turnRunning()
          if (busy) running = true
          if (running && !busy) break
          await wait(700)
        }
        await wait(1800)

        const said = [...$('messagesList').querySelectorAll('.msg-item.assistant')]
        answers.push((said[said.length - 1]?.innerText || '').trim())
      }

      facts.exchanges = questions.length
      facts.answerLengths = answers.map(a => a.length).join(', ')

      const bubbles = [...$('messagesList').querySelectorAll('.msg-item')]
      const mine = bubbles.filter(b => b.classList.contains('user')).length
      const theirs = bubbles.filter(b => b.classList.contains('assistant')).length
      facts.bubbles = `мои ${mine}, ответы ${theirs}`

      note('на каждый вопрос есть свой ответ', theirs === questions.length,
        facts.bubbles)
      note('мои сообщения все на месте', mine === questions.length, facts.bubbles)
      note('ни один ответ не пустой', answers.every(a => a.length > 0),
        facts.answerLengths)
      note('развёрнутые ответы не обрезаны',
        answers[1].length > 500 && answers[2].length > 300, facts.answerLengths)

      // The point of the first and last question: the conversation has to still
      // hold what was said at the beginning.
      note('модель помнит начало разговора', /47/.test(answers[3]),
        answers[3].slice(0, 80))

      // And all of it has to survive the reload, not just be on screen.
      const saved = await window.electronAPI.getConversations()
      const chat = (saved || []).find(c => (c.messages || []).length >= questions.length * 2)
      facts.savedMessages = chat ? chat.messages.length : 0
      note('весь разговор сохранён на диск',
        facts.savedMessages >= questions.length * 2, 'сообщений ' + facts.savedMessages)
      note('в сохранённых ответах есть текст',
        chat ? chat.messages.filter(m => m.role === 'assistant').every(m => (m.content || '').trim()) : false)

      return { ok: checks.every(c => c.pass), checks, facts }
    }

    $('composerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    // --- watch the turn ------------------------------------------------------
    const started = Date.now()
    const LIMIT_MS = 5 * 60 * 1000
    let generating = false

    // The agent asks before its first edit, even in auto mode. Nobody is here to
    // click, so the turn would wait out the thirty-minute deadline — which is
    // exactly what a person sees as "everything froze".
    let approvalSeen = false
    let approvalClicked = false

    while (Date.now() - started < LIMIT_MS) {
      const card = document.querySelector('.approval-card')
      if (card) {
        approvalSeen = true
        const allow = [...card.querySelectorAll('button')]
          .find(b => /разреш|да|подтверд/i.test(b.textContent || ''))
        if (allow) {
          allow.click()
          approvalClicked = true
          await wait(600)
        }
      }

      const running = turnRunning()
      if (running) generating = true
      if (generating && !running) break
      await wait(1000)
    }

    facts.seconds = Math.round((Date.now() - started) / 1000)
    facts.approvalSeen = approvalSeen
    facts.approvalClicked = approvalClicked
    note('ход начался', generating, 'кнопка остановки так и не появилась')
    note('ход закончился сам', generating && facts.seconds < 300, facts.seconds + ' с')

    await wait(2500)

    // --- what actually landed ------------------------------------------------
    const list = $('messagesList')
    const items = [...list.querySelectorAll('.msg-item')]
    const assistant = items.filter(i => i.classList.contains('assistant'))
    facts.messages = items.length
    facts.assistants = assistant.length

    note('в ленте появился ответ агента', assistant.length > 0, 'сообщений ' + items.length)

    const last = assistant[assistant.length - 1]
    const answer = last ? (last.innerText || '').trim() : ''
    facts.answerLength = answer.length
    facts.answerHead = answer.slice(0, 200).replace(/\s+/g, ' ')

    // The thing that kept vanishing: text a person can read, not just the rows
    // of thinking and tool calls.
    const blocks = last ? [...last.querySelectorAll('.msg-blocks > *')] : []
    const textBlocks = blocks.filter(b => b.classList.contains('msg-content'))
    facts.blockKinds = blocks.map(b =>
      b.classList.contains('think') ? (b.classList.contains('tool') ? 'инструмент' : 'мысль') : 'текст'
    ).join(',')

    note('в ответе есть читаемый текст, а не только колбочки',
      textBlocks.length > 0 && textBlocks.some(b => (b.innerText || '').trim().length > 0),
      facts.blockKinds || '(блоков нет)')

    facts.recoveries = events.length ? events.join(' | ').slice(0, 220) : 'не понадобились'

    // A crash inside the agent loop reaches the user as the answer itself, and
    // that is the one thing no amount of offline testing sees: thirty test sets
    // and a hundred and seventy-eight interface checks all passed while every
    // live turn was dying on «TypeError: text.trim is not a function» before its
    // first step. Any run, any scenario — an internal error is a failed run.
    note('ход не упал внутренней ошибкой',
      !/Ошибка генерации|TypeError|ReferenceError|is not a function|undefined is not/.test(answer),
      JSON.stringify(answer.slice(0, 140)))

    // The invariant that «он прерывается всегда» was about: a turn must not end
    // while the agent is itself naming work it has not done. If it does, the app
    // should have carried it on — or said out loud that it stopped trying.
    if (blocks.some(b => b.classList.contains('tool'))) {
      const admits = /не начат|не сдела|не завершен|не завершён|не доделан|не выполнен|не реализован|не написан|осталось сделать|предстоит сделать|кода (приложения )?нет|not (implemented|finished|started|done|written|created)/i.test(answer)
      const points = /следующий шаг|дальше (нужно|надо|предстоит)|далее (нужно|надо)|next step/i.test(answer)
      const saidSo = /всё ещё считает работу незаконченной|Ответ обрывается|Достигнут предел/.test(answer)
      note('ход не закончился на «сделаю потом»', !(admits && points) || saidSo,
        admits && points ? JSON.stringify(answer.slice(-140)) : 'недоделок не заявлено')
    }

    // An ordinary conversation has nothing to reach for; the rest are asked
    // something that can only be answered from a file.
    // A question that needs no file has nothing to reach for.
    // Two of these ask for writing, not for work in the project, so there is
    // nothing for a tool to do.
    if (window.__scenario !== 'chat' && window.__scenario !== 'cutoff' &&
        !String(window.__scenario).startsWith('skill')) {
      note('агент действительно вызывал инструменты',
        blocks.some(b => b.classList.contains('tool')), facts.blockKinds || '(нет)')
    }

    // Each scenario was asked for one specific fact that can only come from a
    // file, so the answer has to contain it. A number is a valid whole answer —
    // «Ответь числом» was the question — so the bar is a number, not a length.
    if (window.__scenario !== 'chat') {
      note('в ответе есть добытый из файла факт', /\d/.test(answer), facts.answerHead)
    } else {
      // The point of this one is length: a conversation that breaks off half-way
      // is what has to be caught.
      note('ответ не оборвался на половине', answer.length > 1500,
        answer.length + ' символов')
    }

    const NL_ = String.fromCharCode(10)
    if (window.__scenario === 'halfway' || window.__scenario === 'whole-job') {
      // What the tools actually did. The window has no way to read files, but
      // every write shows up as its own block, and that is the same evidence.
      const did = blocks.filter(b => b.classList.contains('tool'))
        .map(b => (b.innerText || '')).join(' | ')
      facts.wrote = did.slice(0, 200)

      note('первая часть сделана', /tmp-half-1/.test(did), facts.wrote || '(записей нет)')

      // The whole point. Before this, a turn that stopped after part one and
      // said «второе не сделано» was accepted as an answer.
      note('вторая часть тоже сделана, а не отложена',
        /tmp-half-2/.test(did), facts.wrote || '(записей нет)')

      note('ответ не заканчивается обещанием доделать',
        !/следующий шаг/i.test(answer) || /всё ещё считает работу незаконченной/.test(answer),
        JSON.stringify(answer.slice(-140)))
    }

    if (window.__scenario === 'cutoff') {
      // The written answer alone. `answer` is the whole message element, which
      // carries the footer — model name, duration, tokens — and testing how the
      // answer ends against that tests the footer instead.
      const body = textBlocks.map(b => (b.innerText || '').trim()).join(NL_).trim()
      facts.bodyTail = JSON.stringify(body.slice(-70))

      // The cap was forced to a few hundred tokens, so one uninterrupted answer
      // could not be this long. Length is the proof that it was picked up.
      note('оборванный ответ продолжили, а не отдали половиной',
        body.length > 1500, body.length + ' символов')

      // The failure this guards against is the model restarting with the
      // sentence it was cut off in — a doubled sentence reads as its own bug.
      const sentences = body.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(x => x.length > 40)
      const doubled = sentences.find((x, k) => k > 0 && x === sentences[k - 1])
      note('шов не задвоился', !doubled, doubled ? JSON.stringify(doubled.slice(0, 60)) : 'повторов нет')

      // And nothing of the model's bookkeeping leaks into the answer.
      note('в ответе нет служебных вставок',
        !/^\s*(продолжаю|continuing)/im.test(body),
        JSON.stringify((body.match(/^.*продолжаю.*$/im) || [''])[0].slice(0, 60)))

      // A turn that ends on a half-word without saying so is the whole
      // complaint, so either it finished or it says it did not.
      note('ответ либо закончен, либо об обрыве сказано',
        /[.!?»)]$/.test(body) || /Ответ обрывается/.test(body), facts.bodyTail)
    }

    if (window.__scenario === 'project-deep') {
      // The fact exists only in the sibling chat, so quoting it proves the
      // agent actually read it rather than inferring anything.
      // 417 exists only in a file outside the working folder, so quoting it
      // proves the knowledge base is reachable and not merely advertised.
      note('агент прочитал файл базы знаний проекта', /417/.test(answer),
        facts.answerHead)

      note('агент прочитал соседний диалог проекта', /8123/.test(answer),
        facts.answerHead)
      note('инструкция проекта выполнена', /ПРОЕКТ-ОК/.test(answer),
        JSON.stringify(answer.slice(-80)))
      // Any tool at all is not the question — a project tool is. The window
      // labels them in Russian, so the raw project_* names are never on screen.
      const PROJECT_LABELS = ['диалоги проекта', 'соседний диалог', 'Записал в диалог',
        'план проекта', 'Сверился с планом', 'тему диалога']
      facts.projectTools = blocks.filter(b => b.classList.contains('tool'))
        .map(b => (b.innerText || '').split(String.fromCharCode(10))[0].trim())
        .filter(t => PROJECT_LABELS.some(l => t.includes(l)))
        .join(' | ')
      note('агент пользовался инструментами проекта',
        facts.projectTools.length > 0, facts.projectTools || '(ни одного)')

      // The complex-task lead, not whichever free model the key was bound to.
      facts.modelShown = last?.querySelector('.cli-model')?.textContent?.trim() || ''
      note('сложную задачу вёл GLM 5.3 Flash',
        /GLM 5\.3/i.test(facts.modelShown), facts.modelShown || '(не видно)')

      // A plan set during the turn has to outlive it.
      const projects = await window.electronAPI.getProjects()
      const mine = (projects || []).find(p => p.id === 'deep')
      facts.planSteps = Array.isArray(mine?.plan) ? mine.plan.length : 0
      note('план проекта сохранён', facts.planSteps >= 1,
        'шагов в плане ' + facts.planSteps)
    }

    if (window.__scenario === 'team') {
      // Whether it delegated or did the job itself, the answer has to carry
      // both facts and the turn has to have ended on its own.
      note('оба файла прочитаны', facts.blockKinds.includes('инструмент'), facts.blockKinds)
      note('в ответе есть версия', /0\.\d+\.\d+/.test(answer), facts.answerHead)
      note('в ответе есть число строк', /\b\d{2,4}\b/.test(answer), facts.answerHead)

      // Whether a team convened or one agent did the lot, the transcript has to
      // say which. Demanding delegation would be demanding that the lead split a
      // task that does not need splitting — the answer to «нужны ли помощники»
      // is often no, and that is the design working.
      const crew = last?.querySelector('.cli-crew')?.textContent?.trim() || ''
      const model = last?.querySelector('.cli-model')?.textContent?.trim() || ''
      facts.crew = crew || '(один агент)'
      facts.model = model

      note('в подвале написано, кто отвечал', Boolean(crew || model),
        `состав «${crew}», модель «${model}»`)

      // And that record survives the turn ending, rather than living only in the
      // banners that vanish when the answer is stored.
      const stored = await window.electronAPI.getConversations()
      const lastMsg = (stored?.[0]?.messages || []).filter(m => m.role === 'assistant').pop()
      facts.storedStages = Array.isArray(lastMsg?.stages) ? lastMsg.stages.length : 0
      note('сохранено, на какой модели отвечали',
        Boolean(lastMsg?.modelName), lastMsg?.modelName || '(нет)')
    }

    if (window.__scenario === 'mcp') {
      note('агент вызвал инструмент MCP-сервера',
        facts.blockKinds.includes('инструмент'), facts.blockKinds)
      note('в ответе то, что вернул сервер',
        /MCP test server is connected/i.test(answer), facts.answerHead)
    }

    if (window.__scenario === 'skill' || window.__scenario === 'skill-glm') {
      // The instruction was to end with one particular word. Anywhere in the
      // answer proves the skill reached the model; at the end proves it was
      // followed as written.
      note('скилл дошёл до модели', /ЯНТАРЬ/.test(answer), facts.answerHead)
      note('указание скилла выполнено в конце ответа',
        /ЯНТАРЬ\s*$/.test(answer.replace(/[\s\S]{0,40}$/, m => m)) || /ЯНТАРЬ/.test(answer.slice(-120)),
        JSON.stringify(answer.slice(-60)))
    }

    // --- and after a reload, which is where answers were being lost ----------
    const conv = await window.electronAPI.getConversations()
    // The chat this turn happened in — found by the question that was sent.
    // Taking the first chat with any answer read a neighbouring chat instead
    // as soon as the project scenario planted one, and passed on its text.
    const asked = SCENARIOS[window.__scenario || 'simple'] || SCENARIOS.simple
    const mineFirst = (conv || []).filter(c =>
      (c.messages || []).some(m => m.role === 'user' && String(m.content || '').includes(asked.slice(0, 40))))
    const chat = mineFirst.find(c => (c.messages || []).some(m => m.role === 'assistant')) ||
      (mineFirst.length ? mineFirst[0] : null)
    facts.savedAssistants = chat ? chat.messages.filter(m => m.role === 'assistant').length : 0
    note('ответ сохранён в историю, а не только нарисован',
      facts.savedAssistants > 0, 'сохранённых ответов ' + facts.savedAssistants)

    const savedText = chat
      ? (chat.messages.filter(m => m.role === 'assistant').pop()?.content || '')
      : ''
    // The answer that vanished from long turns was absent from here, not merely
    // unrendered — so this is the check that matters most.
    note('сохранённый ответ не пустой', savedText.trim().length > 0,
      JSON.stringify(savedText.slice(0, 120).replace(/\s+/g, ' ')))

    const meta = last ? (last.querySelector('.cli-header')?.innerText || '') : ''
    facts.meta = meta.replace(/\s+/g, ' ').slice(0, 120)
  } catch (error) {
    note('прогон без исключений', false, String(error && error.message || error))
  }

  const failed = checks.filter(c => !c.pass)
  return { ok: failed.length === 0, checks, facts }
})()
