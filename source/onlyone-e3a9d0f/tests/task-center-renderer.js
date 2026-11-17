// Центр задач в настоящем окне (план, 3.4).
//
// Первый запуск: раздел пустой, и он обязан сказать это словами; после этого
// в историю сеются два диалога с записями о ходе агентов. Второй запуск видит
// ту же историю плюс контрольную точку оборванного хода и проверяет список,
// поиск, фильтры, метку навигации, переход из карточки и то, что чужой текст
// не становится разметкой.
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
  const until = async (fn, ms = 15000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {}; await wait(100) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const cards = () => [...document.querySelectorAll('#taskCenterList .task-center-item')]
  const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
  const emptyLine = () => text(document.querySelector('#taskCenterList .task-center-empty'))

  function narrowComposer(width, split = false) {
    const host = document.createElement('div')
    host.className = split ? 'composer-container split-composer' : 'composer-container'
    host.style.cssText = `position:fixed;left:-2000px;top:0;width:${width}px;padding:0`
    host.innerHTML = '<div class="composer-card"><div class="composer-input-box"><textarea class="composer-textarea" rows="1"></textarea></div></div>'
    document.body.append(host)
    const area = host.querySelector('textarea')
    area.placeholder = $('composerTextarea')?.getAttribute('placeholder') || ''
    const metrics = { height: area.clientHeight, content: area.scrollHeight }
    host.remove()
    return metrics
  }

  async function run() {
    if (!await until(() => document.documentElement.dataset.appReady === '1')) {
      note('окно не поднялось', false)
      return
    }
    // Вступительный экран — чужая зона; если он показан, его убирают своей
    // кнопкой, иначе проверка раздела смотрит не на раздел.
    if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
    await wait(200)

    if (arg.mode === 'seed') {
      document.dispatchEvent(new CustomEvent('open-task-center'))
      const chatRect = $('chatView').getBoundingClientRect()
      const taskRect = $('taskCenterView').getBoundingClientRect()
      note('Tasks открывается справа рядом с чатом, не вместо него',
        $('navTasks').closest('.chat-header-actions') && $('chatView').classList.contains('active') &&
        taskRect.left >= chatRect.right - 1 && taskRect.width >= 300,
        `chat: ${Math.round(chatRect.width)}, tasks: ${Math.round(taskRect.width)}`)
      const searchHeight = $('taskCenterSearch').getBoundingClientRect().height
      note('поиск в правой панели не схлопывается до строки текста', searchHeight >= 36,
        `высота: ${Math.round(searchHeight)}px`)
      for (const [width, split] of [[380, false], [320, true]]) {
        const size = narrowComposer(width, split)
        note(`узкий ввод ${width}px показывает всю подсказку`, size.content <= size.height + 1,
          `${size.content}/${size.height}`)
      }
      const shown = await until(() => document.querySelector('#taskCenterList .task-center-empty'))
      note('пустой раздел говорит об этом словами', shown && emptyLine().includes('Пока нет задач'), emptyLine())
      note('в пустом разделе нет карточек', cards().length === 0)
      // Стартовый пустой диалог ставит отложенное сохранение истории; если
      // сеять сразу, оно выйдет поверх посева и второй запуск ничего не найдёт.
      await wait(1800)

      const now = Date.now()
      const chats = [
        {
          id: arg.chatA, title: 'Сборка', createdAt: now - 9000, updatedAt: now - 4000, messages: [
            { role: 'user', content: 'Собери проект и покажи результат', timestamp: now - 5000 },
            {
              role: 'assistant', content: 'Готово', timestamp: now - 4000,
              agentRun: { at: now - 4100, seconds: 12, ask: 'Собери проект и покажи результат',
                agents: [{ name: 'Агент 1', outcome: 'done', seconds: 12 }] }
            }
          ]
        },
        {
          id: arg.chatB, title: 'Тесты', createdAt: now - 8000, updatedAt: now - 3000, messages: [
            { role: 'user', content: 'Прогони тесты и почини падение', timestamp: now - 3500 },
            {
              role: 'assistant', content: 'Упалось', timestamp: arg.answerAt,
              agentRun: { at: now - 3200, seconds: 9, ask: 'Прогони тесты и почини падение',
                agents: [{ name: 'Агент 1', outcome: 'failed', seconds: 9 }] }
            }
          ]
        }
      ]
      const saved = await window.electronAPI.setConversations(chats)
      note('диалоги записаны в историю', saved?.ok === true, JSON.stringify(saved).slice(0, 60))
      const reloaded = await window.__reloadChats?.()
      note('история перечитана', reloaded >= 2, `диалогов: ${reloaded}`)
      // Окно при выходе пишет свою список, а не то, что лежит на диске: без
      // сохранённого изменения перечитанный посев пропал бы между запусками.
      // `__joinProject` — штатный путь окна, который это сохранение делает.
      window.__joinProject?.(null)
      await wait(1200)
      return
    }

    document.dispatchEvent(new CustomEvent('open-task-center'))
    const shown = await until(() => cards().length >= 3)
    note('раздел открыт и показал три хода', shown, `карточек: ${cards().length}`)
    const agentDetail = cards()[0]?.querySelector('.task-center-detail')
    note('в обзоре нет повторяющейся строки агента',
      !agentDetail || getComputedStyle(agentDetail).display === 'none')
    const titleStyle = getComputedStyle(cards()[0]?.querySelector('.task-center-title'))
    note('название задачи в панели читается и переносится',
      parseFloat(titleStyle.fontSize) >= 14 && titleStyle.whiteSpace === 'normal',
      `${titleStyle.fontSize}, ${titleStyle.whiteSpace}`)
    const all = cards().map(card => text(card))
    note('завершённый ход назван завершённым', all.some(line => line.includes('Собери проект') && line.includes('Завершено')))
    note('ход с отказом помечен проблемой', all.some(line => line.includes('Прогони тесты') && line.includes('Есть проблема')))
    note('прерванный ход помечен прерванным', all.some(line => line.includes('Дочитать лог') && line.includes('Прервано')),
      all.join(' || ').slice(0, 220))
    // С 04.10 метка на кнопке «Задачи» считает работающих агентов ЭТОГО чата, а общий счёт — в строке экрана.
    note('экран считает активное по всем чатам', /Активных 1/.test($('taskCenterCount')?.textContent || ''), $('taskCenterCount')?.textContent)

    const search = $('taskCenterSearch')
    search.value = 'почини'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    note('поиск оставляет одну работу', await until(() => cards().length === 1), `карточек: ${cards().length}`)
    search.value = 'дизайн'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(500)
    note('поиск по несуществующему слову объясняет пустоту',
      cards().length === 0 && emptyLine().includes('Ничего не найдено'), emptyLine())
    search.value = ''
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => cards().length === 3)

    document.querySelector('[data-task-filter="complete"]').click()
    note('фильтр «Завершённые» оставляет один ход', await until(() => cards().length === 1), cards().map(text).join(' || '))
    note('счёт показывает сужение', text($('taskCenterCount')).includes('Показано 1'), text($('taskCenterCount')))
    document.querySelector('[data-task-filter="all"]').click()
    await until(() => cards().length === 3)

    // Переход из карточки: диалог становится активным, а его ответ —
    // подсвеченным. `until` отдаёт флаг, поэтому сам узел забираем в замыкание.
    let flashed = null
    const target = cards().find(card => text(card).includes('Прогони тесты'))
    target?.click()
    const moved = await until(() => {
      if (!flashed) flashed = document.querySelector('#messagesList .msg-item.flash')
      return flashed && document.querySelector('.history-item.active')?.dataset.chatId === arg.chatB
    })
    note('карточка уводит в свой диалог и подсвечивает ответ',
      Boolean(moved) && flashed?.dataset?.at === String(arg.answerAt),
      `активный: ${document.querySelector('.history-item.active')?.dataset.chatId}, отметка: ${flashed?.dataset?.at || 'нет'}, ждали: ${arg.answerAt}`)
    note('после перехода к ответу задачи остаются рядом с чатом',
      document.body.classList.contains('task-center-open') && $('taskCenterView').classList.contains('active'))

    const nasty = cards().find(card => text(card).includes('<img'))
    note('карточка не разворачивает чужой текст в разметку',
      Boolean(nasty) && !document.querySelector('#taskCenterList img'),
      nasty ? text(nasty).slice(0, 90) : 'хода с <img> в списке нет')

    // Второй чат и задачи делят правое место, не превращаясь в три узких столбца.
    $('splitViewBtn').click()
    note('второй чат сменяет Tasks',
      await until(() => document.body.classList.contains('split-open') && !document.body.classList.contains('task-center-open')))
    document.dispatchEvent(new CustomEvent('open-task-center'))
    note('Tasks сменяет второй чат',
      await until(() => document.body.classList.contains('task-center-open') && !document.body.classList.contains('split-open')))
    $('taskCenterCloseBtn').click()
    note('панель задач закрывается без потери чата',
      !document.body.classList.contains('task-center-open') && $('chatView').classList.contains('active') &&
      $('navTasks').getAttribute('aria-expanded') === 'false')
    document.dispatchEvent(new CustomEvent('open-task-center'))
    await until(() => cards().length === 3)
    await wait(200)
  }

  try {
    await run()
  } catch (error) {
    // Без стека отчёт оставляет только «не удалось прочитать .at» — по нему
    // не понять, где именно упало.
    note('проверка упала', false, String((error && error.stack) || error).slice(0, 500))
  }
  return { ok: checks.every(c => c.pass), checks }
})()
