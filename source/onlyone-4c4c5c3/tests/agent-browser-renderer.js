// agent-browser-renderer.js — проверки живого вида браузера агента ВНУТРИ окна
// (план, 3.6б, вариант 2). Запускается главным процессом по ONECODE_SMOKE; режим,
// язык и адрес заглушки приходят base64-аргументом (`__ONECODE_ARG__`), как в
// `tests/design-task-renderer.js`.
//
// Путь настоящий, подделанных событий нет: человек пишет просьбу в чат, ход ведёт
// тестовый провайдер из файла-сценария, инструменты `browse_*` исполняет главный
// процесс, в окно идут НАСТОЯЩИЕ `agent-approval` и `agent-browser-event`.
// Локальный адрес заглушки главный процесс сегодня отвергает как SSRF — поэтому
// прогон красный по отсутствию хука разрешений, а не по поломке харнесса.
//
// Снимок окно делает ПОСЛЕ возврата этого скрипта, поэтому каждый режим
// возвращается ровно в том состоянии, которое доказывает.
(async () => {
  const decodeArg = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decodeArg('__ONECODE_ARG__')
  const mode = arg.mode || 'granted'
  const lang = arg.lang || 'ru'
  const MARKER = arg.marker || 'МИШЕНА36Б'
  const SECRET = arg.secret || 'СОВЕРШЕННО-СЕКРЕТНО-TEST-731'
  const url = String(arg.url || '')
  const deniedUrl = String(arg.deniedUrl || '')
  const port = url.replace(/^https?:\/\/127\.0\.0\.1:/, '').replace(/\/$/, '')
  const deniedPort = deniedUrl.replace(/^https?:\/\/127\.0\.0\.1:/, '').replace(/\/$/, '')
  const HOST = `127.0.0.1:${port}`
  // Подписи страницы и реплики сценария приходят аргументом: страница-заглушка
  // говорит на языке кадра, и искать на английском кадре русскую строку было бы
  // проверкой не того, что заявлено.
  const L = arg.labels || {}
  const ask = L.ask || 'Открой страницу из оконного прогона и посмотри её'
  const pressName = L.press || 'Нажать кнопку'
  const pressedName = L.pressed || 'Кнопка нажата'
  const echoPrefix = L.echo || 'Эхо:'
  const typedText = L.typed || 'Введённый текст'
  const echoSecret = L.echoSecret || 'Эхо пароля'
  const deniedName = L.denied || 'ЗАПРЕЩЁННАЯ-СТРАНИЦА'
  const doneWord = L.done || 'Ход окончен'
  const refusalWords = L.refusal || 'отказ|отклон|не разреш|запрещ|отмен'
  const secretWords = L.secretWords || 'секрет|парол|токен|ключ'
  const sizeUnit = L.size || 'пикселов'
  const byteUnit = L.bytes || 'байт'
  // Размер кадра ищется числом со своей единицей: в английском кадре «пикселов»
  // нет, и проверка на русский текст там была бы проверкой языка, а не вида.
  const unitRx = unit => new RegExp('\\d+\\s*' + unit)
  // Порт сравнивается с границей: случай `5123` внутри `51234` прочёл бы один
  // адрес как другой, и отказ пришёлся бы не туда, где надо.
  const mentions = (text, value) => {
    const escaped = String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!escaped) return false
    return new RegExp(escaped + '(?![0-9])').test(String(text))
  }
  const mentionsHost = text => mentions(text, HOST)
  const mentionsDenied = text => mentions(text, `127.0.0.1:${deniedPort}`)

  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const until = async (fn, ms = 20000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch { /* состояние ещё не собрано */ }
      await wait(80)
    }
    return false
  }
  // `TEXT` обязан работать и на пустоте: карточки живого вида может ещё не быть,
  // а падение харнесса не должно притворяться отказом приложения.
  const TEXT = el => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim()
  const CYRILLIC = /[а-яё]/i
  const bodyText = () => TEXT(document.body)
  const feed = () => TEXT($('messagesList'))
  // Отказ и причина обязаны быть СКАЗАНЫ, а не мелькнуть словом: ищем целую
  // реплику ленты (между точками) длиной не меньше десяти знаков, в которой
  // есть нужное слово. Прежний regex с `[^.\n]{10,200}` перед словом спотыкался
  // о точку в адресе и в конце предыдущей фразы.
  const sentenceWith = words => {
    const rx = new RegExp(words, 'i')
    return feed().split(/[.!?]/).map(part => part.trim()).find(part => part.length >= 10 && rx.test(part)) || ''
  }

  const findCard = () => {
    const byClass = document.querySelector('.agent-browser-view')
    if (byClass) return byClass
    const hits = [...document.querySelectorAll('div,aside,section')].filter(el => /браузера агента|browser agent|кадр пуст/i.test(TEXT(el)))
    return hits.length ? hits[hits.length - 1] : null
  }
  const framesIn = card => [...(card ? card.querySelectorAll('iframe') : [])]
  const stopButton = card => [...(card ? card.querySelectorAll('button') : [])]
    .find(el => /останов|stop/i.test(TEXT(el) + ' ' + (el.getAttribute('aria-label') || '')))
  const busy = () => $('sendBtn')?.classList.contains('is-stop') === true

  const asks = []
  const answered = []
  const liveEvents = []
  let frameLoaded = false
  let frameError = false
  let frameSrc = ''
  let frameBox = { width: 0, height: 0 }
  let cardSawElements = false

  function finish (error) {
    if (error) note('харнесс окна упал на проверке', false, (error && error.message) || error)
    return {
      ok: checks.every(item => item.pass) && !error,
      checks,
      extra: {
        mode, lang, asks: asks.length, answered, liveEvents: liveEvents.length,
        summaries: asks.map(a => String(a && a.summary)), tail: feed().slice(-400),
        card: TEXT(findCard()).slice(0, 400), frameSrc
      }
    }
  }

  // Весь прогон — под одним защитным контекстом: упавшая проверка обязана отдать
  // в отчёт накопленные строки, а не один короткий «error» без них.
  try {
    const ready = await until(() => document.documentElement.dataset.appReady === '1', 30000)
    note('окно сообщило о готовности', ready)
    if (!ready) return finish()

    if (lang === 'en' && typeof window.__setLanguage === 'function') {
      try { await window.__setLanguage('en') } catch { /* переключатель языка разберётся сам */ }
      await wait(400)
    }

    const api = window.electronAPI || {}
    note('мост отдаёт подписку на спрос человека', typeof api.onAgentApproval === 'function')
    note('мост отдаёт подписку на события живого вида', typeof api.onAgentBrowserEvent === 'function')

    // --- спрос человека: ловим и отвечаем по-настоящему -------------------------

    const decide = payload => {
      // Отказ человека — режим `refused`; и всегда отказ для второго адреса,
      // который человек не разрешал (находка Н87).
      const text = JSON.stringify(payload || {})
      if (mode === 'refused') return false
      if (deniedPort && mentionsDenied(text)) return false
      return true
    }
    if (typeof api.onAgentApproval === 'function') {
      api.onAgentApproval(payload => {
        asks.push(payload)
        const approved = decide(payload)
        answered.push({ id: payload && payload.id, approved })
        Promise.resolve(api.resolveAgentApproval({ id: payload && payload.id, approved }))
          .catch(error => note('ответ окна не дошёл до главного процесса', false, error && error.message))
      })
    }
    if (typeof api.onAgentBrowserEvent === 'function') api.onAgentBrowserEvent(payload => liveEvents.push(payload))
    // Что живой вид показывал в списке элементов: событие со снимком перетирает
    // состояние, поэтому элементы собираем по всем событиям, а не по последнему.
    const elementSightings = () => liveEvents
      .filter(event => Array.isArray(event && event.elements))
      .map(event => event.elements.map(item => (item && item.name) || '').join(' '))
      .join(' ')

    // --- настоящий чат и настоящий ход -----------------------------------------

    $('newChatBtn')?.click()
    await wait(300)
    const box = $('composerTextarea')
    note('есть поле ввода чата', Boolean(box))
    if (!box) return finish()
    // В просьбе нет ни маркера, ни адреса: иначе поиск по ленте находил бы эхо
    // собственной строки вместо того, что сделала страница.
    box.value = ask
    box.dispatchEvent(new Event('input', { bubbles: true }))
    $('composerForm')?.requestSubmit()

    async function watchFrames (ms) {
      const stop = Date.now() + ms
      while (Date.now() < stop) {
        const card = findCard()
        if (TEXT(card).includes(pressName)) cardSawElements = true
        for (const frame of framesIn(card)) {
          if (!frame.dataset.watched) {
            frame.dataset.watched = '1'
            frame.addEventListener('load', () => {
              frameLoaded = true
              frameSrc = frame.getAttribute('src') || ''
              const rect = frame.getBoundingClientRect()
              frameBox = { width: Math.round(rect.width), height: Math.round(rect.height) }
            }, { once: true })
            frame.addEventListener('error', () => { frameError = true }, { once: true })
          }
        }
        if (frameLoaded && cardSawElements) return true
        await wait(100)
      }
      return frameLoaded
    }

    const asked = await until(() => asks.length > 0, 45000)
    note('человека спросили перед выходом в сеть (КРАСНАЯ: хука allow ещё нет)', asked,
      asked ? JSON.stringify(asks[0]).slice(0, 200) : 'спросов не было ни одного')
    if (!asked) {
      note('в ленте виден отказ по локальному адресу', /локальн|частн|SSRF|запрещ|local|private/i.test(feed()), feed().slice(-260))
      return finish()
    }
    note('в спросе назван адрес заглушки', mentionsHost(JSON.stringify(asks[0])), JSON.stringify(asks[0]).slice(0, 260))

    // --- режимы -----------------------------------------------------------------

    if (mode === 'refused') {
      const settled = await until(() => !busy(), 60000)
      await wait(400)
      note('ход завершился после отказа, карточка инструмента не зависла', settled,
        settled ? 'кнопка вернулась в «отправить»' : 'ход всё ещё идёт: ' + TEXT($('sendBtn')))
      const refusal = sentenceWith(refusalWords)
      note('отказ назван в ленте словами, а не молчанием', Boolean(refusal), refusal || feed().slice(-260))
      const card = findCard()
      const shownAddress = mentionsHost(TEXT(card))
      note('отказанная страница не открылась: живого вида с этим адресом нет',
        !card || (!shownAddress && framesIn(card).length === 0),
        card ? `текст: ${TEXT(card).slice(0, 200)}` : 'карточки живого вида нет')
      note('окно живо после отказа', document.documentElement.dataset.appReady === '1' && $('messagesList').children.length > 0)
      if (lang === 'en') {
        note('в ленте отказа нет ни одной русской строки (известный остаток 2.6б)', !CYRILLIC.test(feed()), feed().slice(-200))
      }
      return finish()
    }

    if (mode === 'redirect') {
      const settled = await until(() => !busy(), 60000)
      await wait(300)
      const card = findCard()
      const reachedDenied = bodyText().includes(deniedName) || mentionsDenied(TEXT(card))
      const askedSecond = asks.some(payload => mentionsDenied(JSON.stringify(payload)))
      note('адрес редиректа не проходит мимо спроса человека (Н87)', askedSecond || !reachedDenied,
        `спросов: ${asks.length}, про второй адрес спрашивали: ${askedSecond}, чужая страница показана: ${reachedDenied}; вид: ${TEXT(card).slice(0, 160)}`)
      note('ход дошёл до конца', settled)
      note('модель получила честный ответ, а не страницу запрещённого адреса', !reachedDenied || askedSecond,
        'конец ленты: ' + feed().slice(-220))
      return finish()
    }

    // Живой вид обязан появиться: до разрешения человека его нет вовсе.
    const cardShown = await until(() => Boolean(findCard()), 40000)
    const card = findCard()
    note('карточка живого вида появилась', cardShown, cardShown ? '' : 'ни узла, ни текста про браузер агента')
    if (!cardShown) return finish()
    if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center' })
    await wait(200)

    if (mode === 'granted') {
      const listed = await until(() => TEXT(findCard()).includes(pressName), 30000)
      const cardText = TEXT(findCard())
      note('живой вид называет адрес разрешённой страницы', mentionsHost(cardText), cardText.slice(0, 240))
      note('живой вид называет заголовок страницы', /Кадр страницы/.test(cardText) || cardText.includes(MARKER), cardText.slice(0, 240))
      note('живой вид в состоянии «идёт работа»', /идёт|работ|live/i.test(cardText), cardText.slice(0, 160))
      note('список элементов живой: видны кнопка и оба поля',
        listed && /Поле для текста/.test(cardText) && /Поле пароля/.test(cardText), cardText.slice(0, 260))
      note('карточка стоит в панели «Работа», а не где попало',
        Boolean(card.closest && card.closest('#tasksPanel')),
        'родитель: ' + (card.parentElement ? card.parentElement.tagName + '#' + card.parentElement.id : 'нет'))
      const rect = card.getBoundingClientRect()
      note('карточка видна на экране', rect.width > 40 && rect.height > 40 && rect.bottom > 0 && rect.top < (window.innerHeight || 0),
        `${Math.round(rect.width)}×${Math.round(rect.height)} при окне ${window.innerHeight}`)
      note('спрос на один адрес был одним спросом', asks.length === 1,
        `спросов: ${asks.length} — ${asks.map(a => String(a && a.summary)).join(' / ')}`)
      note('ход продолжается после разрешения, а не встал', busy() || /Кликаю|Ввожу|Снимаю/.test(feed()),
        'кнопка в состоянии хода: ' + busy())
      return finish()
    }

    if (mode === 'stopped') {
      await until(() => framesIn(findCard()).length > 0 || unitRx(sizeUnit).test(TEXT(findCard())), 30000)
      const pressed = stopButton(findCard())
      note('в живом виде есть кнопка «Остановить»', Boolean(pressed), pressed ? TEXT(pressed) : TEXT(findCard()).slice(0, 200))
      if (!pressed) return finish()
      const before = liveEvents.length
      pressed.click()
      const stoppedState = await until(() => /останов|stopped/i.test(TEXT(findCard())), 8000)
      note('после нажатия вид перешёл в состояние «остановлено»', stoppedState, TEXT(findCard()).slice(0, 200))
      const stillBusy = busy()
      await wait(2000)
      note('новых событий живого вида после остановки нет', liveEvents.length === before,
        `до: ${before}, после: ${liveEvents.length}`)
      note('ход не прерван остановкой вида', stillBusy || feed().includes(doneWord),
        'кнопка в состоянии хода сразу после нажатия: ' + stillBusy)
      return finish()
    }

    // mode === 'frame'
    const loaded = await watchFrames(40000)
    const liveCard = findCard()
    const liveFrames = framesIn(liveCard)
    note('кадр страницы появился в живом виде', liveFrames.length > 0, `iframe в карточке: ${liveFrames.length}`)
    const src = liveFrames.length ? (liveFrames[0].getAttribute('src') || '') : ''
    note('адрес кадра — схема живого вида agent-browser-shot://', /agent-browser-shot:/i.test(src), src.slice(0, 160))
    note('кадр действительно загрузился: событие load было', loaded, `load=${loaded}, error=${frameError}, src=${src.slice(0, 80)}`)
    note('кадр занимает место на экране: он ненулевого размера',
      frameBox.width > 50 && frameBox.height > 50, JSON.stringify(frameBox))
    const cardText = TEXT(liveCard)
    note('живой вид называет размер кадра и число байт', unitRx(sizeUnit).test(cardText) && unitRx(byteUnit).test(cardText),
      cardText.slice(0, 260))
    note('живой вид показывал список элементов страницы', cardSawElements || elementSightings().includes(pressName),
      `видел элементы: ${cardSawElements}, в событиях: ${elementSightings().slice(0, 200)}`)
    note('клик и ввод прошли по живой странице: на ней виден след',
      elementSightings().includes(pressedName) && elementSightings().includes(echoPrefix + ' ' + typedText),
      elementSightings().slice(0, 260))
    note('поле-секрет отклонено: следа ввода пароля на странице нет', !bodyText().includes(echoSecret), bodyText().slice(-200))
    note('текст пароля не появился ни в кадре, ни в ленте, ни в причине отказа',
      !bodyText().includes(SECRET), bodyText().includes(SECRET) ? 'секрет виден в окне' : 'секрета в окне нет')
    const secretRefusal = sentenceWith(secretWords)
    note('причина отказа по полю-секрету названа словами', Boolean(secretRefusal),
      secretRefusal || feed().slice(-240))
    if (lang === 'en') {
      note('в живом виде нет ни одной русской строки', !CYRILLIC.test(cardText), cardText.slice(0, 200))
      const stopLabel = TEXT(stopButton(liveCard))
      note('кнопка «Остановить» подписана по-английски', Boolean(stopLabel) && !CYRILLIC.test(stopLabel), stopLabel)
    }
    await wait(300)
    return finish()
  } catch (error) {
    return finish(error)
  }
})()
