// Сценарий проверки приложения телефона: одна и та же последовательность для окна Electron и для эмулятора Android.
// Принимает код спаривания, адреса посредника и провайдера; страница сверяется с «компьютером» через ручки проверки (__remoteCheck и др.).
module.exports = function scenario({ code, relayUrl, providerUrl }) {
  return `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 15000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(80) } return false }
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    const text = () => ($('screen') ? $('screen').innerText : '')
    const O = () => window.__onlyone
    const click = sel => { const el = document.querySelector(sel); if (el) el.click(); return Boolean(el) }
    const type = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })) }
    const errors = []
    window.addEventListener('error', event => errors.push(String(event.message)))

    async function run() {
      if (!await until(() => document.documentElement.dataset.appReady === '1')) { note('приложение не поднялось', false); return }

      // 1. Первый запуск: пустое состояние, ничего лишнего.
      note('первый запуск: пустой список с понятным действием', /Чатов пока нет/.test(text()) && Boolean(document.querySelector('[data-act="new-chat"]')), text().slice(0, 120))
      note('знак onlyone (искра) и название в шапке', Boolean(document.querySelector('.head .mark')) && /onlyone/.test(text()))
      note('цели нажатия не меньше 44 px', [...document.querySelectorAll('.icon-btn, .btn')].every(el => el.getBoundingClientRect().height >= 43.5), [...document.querySelectorAll('.icon-btn, .btn')].map(el => Math.round(el.getBoundingClientRect().height)).join(','))

      // 2. Спаривание по коду.
      click('[data-act="pair"]')
      await until(() => $('pair-code'))
      type($('pair-code'), '${code.toLowerCase().replace("-", "")}')
      note('код форматируется как ABCDE-FGHJK', $('pair-code').value === '${code}', $('pair-code').value)
      type($('pair-name'), 'Pixel проверки')
      type($('pair-relay'), '${relayUrl}')
      $('pair-go').click()
      note('после спаривания — общий список и компьютер в сети', await until(() => /Рабочий ПК/.test(text()) && /в сети/.test(text()), 20000), ($('pair-status') ? 'статус: ' + $('pair-status').textContent + ' | ' : '') + text().slice(0, 120))
      note('в списке чат компьютера с /remote-control, личного чата нет', await until(() => /Рефакторинг модуля оплаты/.test(text()), 10000) && !/Личные заметки/.test(text()), text().slice(0, 200))
      note('у чата компьютера значок компьютера', document.querySelectorAll('.chat-row .pc-badge').length === 2)

      // 3. Открыть чат: блоки хода.
      click('[data-id="pc1"]')
      note('чат открылся: сообщение человека и ответ', await until(() => /Разбей модуль оплаты/.test(text()), 15000))
      note('размышление свёрнуто в строку, шаги с глаголами', Boolean(document.querySelector('.thought')) && document.querySelectorAll('.step').length >= 4 && /Прочитал/.test(text()) && /Выполнил/.test(text()))
      note('чек-лист плана с прогрессом 1 / 3', /1 \\/ 3/.test(text()) && document.querySelectorAll('.plan-item').length === 3)
      note('Markdown: жирный, код, список', Boolean(document.querySelector('.prose strong')) && Boolean(document.querySelector('.prose code')) && document.querySelectorAll('.prose li').length === 2)
      note('снимок показан картинкой', Boolean(document.querySelector('img.shot')))
      note('шапка: название, компьютер, задачи, снимок', /Рабочий ПК/.test(document.querySelector('.head').innerText) && Boolean(document.querySelector('[data-act="tasks"]')) && Boolean(document.querySelector('[data-act="shot"]')))

      // 4. Разрешения: по одному, обычное — тапом, опасное — удержанием.
      note('запросы агента показаны по одному, со счётчиком', await until(() => /1 \\/ 3/.test($('asks').innerText) && document.querySelectorAll('#asks .ask').length === 1, 10000), $('asks').innerText.slice(0, 120))
      note('полное описание действия на экране', /новый файл, 58 строк/.test($('asks').innerText))
      click('[data-act="approve"]')
      note('«Разрешить» дошло до компьютера', await until(async () => (await window.__remoteCheck('a1')), 8000))
      note('следующий запрос — опасный: нет кнопки «разрешить», есть удержание', await until(() => document.querySelector('#asks .ask.danger .hold'), 8000) && !document.querySelector('#asks [data-act="approve"]'), $('asks').innerText.slice(0, 120))
      const hold = document.querySelector('#asks .hold')
      hold.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      await wait(300)
      hold.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      await wait(1200)
      note('короткое нажатие опасное не разрешает', !(await window.__remoteCheck('a2')))
      const hold2 = document.querySelector('#asks .hold')
      hold2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      note('удержание 1,2 секунды разрешает опасное', await until(async () => (await window.__remoteCheck('a2')), 6000))
      note('вопрос агента с вариантами: ответ одним нажатием', await until(() => /Какой стиль тестов/.test($('asks').innerText), 8000) && click('[data-act="answer"]') && await until(async () => (await window.__remoteCheck('q1')), 8000))
      note('когда запросов нет, панель убирается', await until(() => $('asks').innerHTML.trim() === '', 8000))

      // 5. Отправка с телефона.
      type($('composer-input'), 'Добавь README')
      $('send-btn').click()
      note('сообщение с телефона дошло до компьютера и ответ вернулся', await until(() => /Принято: Добавь README/.test(text()), 15000), text().slice(-120))

      // 6. Ход идёт: «Работает», остановка.
      await window.__startLive()
      note('идущий ход виден: живой текст и «Работает»', await until(() => /Работает/.test(text()) && /Пишу тесты/.test(text()), 10000))
      note('кнопка отправки стала «Остановить»', $('send-btn').dataset.act === 'stop')
      $('send-btn').click()
      note('остановка с телефона дошла до компьютера', await until(async () => (await window.__stopped()).some(item => item[0] === 'stop'), 8000))
      note('после остановки «Работает» исчезает', await until(() => !/Работает/.test(text()), 8000))

      // 7. Модель, глубина, задачи, снимок.
      click('[data-act="model-pc"]')
      note('список моделей компьютера открылся', await until(() => document.querySelector('.sheet [data-pick]'), 8000))
      document.querySelectorAll('.sheet [data-pick]')[1].click()
      note('выбранная модель сменилась на компьютере', await until(() => /openai\\/gpt-x/.test($('chips').innerText), 8000), $('chips').innerText)
      click('[data-act="effort-pc"]')
      await until(() => document.querySelector('.sheet [data-pick]'))
      document.querySelector('.sheet [data-pick="low"]').click()
      note('глубина рассуждений сменилась', await until(() => /low/.test($('chips').innerText), 8000))
      click('[data-act="tasks"]')
      note('«Задачи» показывают чек-лист компьютера', await until(() => /Вынести расчёт суммы/.test(document.body.innerText), 8000))
      click('[data-act="sheet-close"]')
      click('[data-act="shot"]')
      note('снимок экрана компьютера открывается на весь экран', await until(() => document.querySelector('.lightbox img'), 8000))
      document.querySelector('.lightbox').click()

      // 8. Свой провайдер и свой чат на телефоне.
      click('[data-act="back"]')
      await until(() => /Рабочий ПК/.test(text()))
      click('[data-act="settings"]')
      await until(() => /Провайдеры и ключи/.test(text()))
      click('[data-act="add-provider"]')
      await until(() => $('pv-key'))
      type($('pv-url'), '${providerUrl}')
      type($('pv-key'), 'sk-test-phone')
      type($('pv-model'), 'test/model')
      click('[data-act="provider-save"]')
      note('ключ сохранён', await until(() => /test\\/model/.test(text()), 8000))
      click('[data-act="back"]')
      await until(() => /Рабочий ПК/.test(text()))
      click('[data-act="new-chat"]')
      await until(() => $('composer-input'))
      type($('composer-input'), 'Привет от меня')
      $('send-btn').click()
      note('свой чат: ответ провайдера приходит потоком', await until(() => /Привет, это ответ с телефона/.test(text()), 15000), text().slice(-100))
      note('у своего чата нет значка компьютера, у модели есть метка', !document.querySelector('.head .pc-badge') && /test\\/model/.test(document.querySelector('.head').innerText))
      click('[data-act="back"]')
      await until(() => /Рабочий ПК/.test(text()))
      note('в общем списке: свой чат и чаты компьютера вместе', document.querySelectorAll('.chat-row').length === 3 && document.querySelectorAll('.chat-row .pc-badge').length === 2, document.querySelectorAll('.chat-row').length)

      // 9. Данные на диске зашифрованы.
      const stored = Object.keys(localStorage).filter(key => key.startsWith('ob1.')).map(key => localStorage.getItem(key)).join('|')
      note('в хранилище телефона нет открытого текста: ни ключа, ни сообщений, ни ключа устройства', stored.length > 100 && !/sk-test-phone|Привет от меня|deviceKey|Pixel/.test(stored), stored.length)
      note('ключ шифрования неизвлекаемый', await (async () => { const db = await new Promise(r => { const q = indexedDB.open('onlyone-keys', 1); q.onsuccess = () => r(q.result) }); const key = await new Promise(r => { const q = db.transaction('keys').objectStore('keys').get('data'); q.onsuccess = () => r(q.result) }); return key && key.extractable === false })())

      // 10. Язык.
      click('[data-act="settings"]')
      await until(() => /Язык/.test(text()))
      click('[data-act="set-lang"][data-value="en"]')
      note('английский: интерфейс переводится', await until(() => /Providers and keys/.test(text()) && /Computer/.test(text()), 5000), text().slice(0, 100))
      click('[data-act="set-lang"][data-value="ru"]')
      await until(() => /Провайдеры и ключи/.test(text()))
      click('[data-act="back"]')

      // 11. Перезапуск: всё на месте.
      window.__beforeReload = true
    }

    try { await run() } catch (error) { note('проверка упала', false, String((error && error.stack) || error).slice(0, 400)) }
    note('ошибок в окне нет', !errors.length, errors.join(' | '))
    return { ok: checks.every(c => c.pass), checks }
  })()`
}
