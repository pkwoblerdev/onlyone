// Оконный прогон границы своих инструментов (план, 6.7, шаг 1).
//
// Разбор ответа раннера проверяется в `test-tool-isolation.cjs` на настоящем
// детском процессе. Здесь проверяется другое: что ход с настоящим `own_*`
// инструментом доходит до человека целым — приложение не спутало напечатанную
// инструментом строку с ответом и не приняло подделанный конверт за успех.
/* global document, window */
(async () => {
  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decode('__ONECODE_ARG__')
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms = 45000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch { /* окно ещё не досчитало */ }
      await wait(120)
    }
    return false
  }
  const checks = []
  const note = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail })
  const rows = () => {
    for (const group of document.querySelectorAll('#messagesList .thought-group')) if (!group.open) group.open = true
    return [...document.querySelectorAll('#messagesList .tool')]
  }
  const said = el => String(el?.textContent || '').replace(/\s+/g, ' ')
  const feed = () => said($('messagesList'))

  await until(() => document.documentElement.dataset.appReady === '1')
  await wait(400)

  // Рабочая папка — свой временный каталог прогона: инструмент не должен иметь
  // доступа ни к чему настоящему, и чужие файлы тут не при чём.
  await window.electronAPI.setWorkspace({ path: arg.workspace, permission: 'auto', extraPaths: [] })
  const ws = await window.electronAPI.getWorkspace()
  note('ход идёт во временной рабочей папке прогона', ws?.path === arg.workspace, String(ws?.path))

  $('newChatBtn')?.click()
  await wait(300)
  const box = $('composerTextarea')
  box.value = 'Вызови свой инструмент и покажи ответ'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm').requestSubmit()

  const row = () => rows().find(item => new RegExp(arg.tool).test(said(item)))
  const called = await until(() => Boolean(row()))
  note(`свой инструмент «${arg.tool}» вызван настоящим процессом`, called,
    rows().map(said).join(' | ').slice(0, 220))
  note('строка показывает запуск или результат своего инструмента',
    /Запускаю|Запустил|Не выполнено/.test(said(row())), said(row()).slice(0, 160))
  const finished = await until(() => !document.querySelector('.btn-send.is-stop'), 60000)
  note('ход закончился', finished)

  // Законченный ход стоит свёрнутым блоком с итогом: строки вызовов появляются при раскрытии.
  const failedRow = () => {
    for (const group of document.querySelectorAll('#messagesList .thought-group')) if (!group.open) group.open = true
    return Boolean(row()?.classList.contains('tone-err'))
  }

  if (arg.mode === 'noisy') {
    // Инструмент печатает в stdout свою строку и возвращает результат. Если
    // вывод и ответ снова смешаны, ход обязан свалиться в «не вернул ответа».
    // Строка снимается после того, как ход кончился: до этого она «ещё пишется».
    note('вызов не помечен отказом', !failedRow(), said(row()))
    note('напечатанная строка не сломала ответ: итог дошёл до ленты',
      /Печать не мешает ответу/.test(feed()), feed().slice(-160))
    note('приложение не пожаловалось на формат ответа',
      !/вернул не JSON|не вернул ответа|только собственный вывод/.test(feed()), feed().slice(-200))
    note('служебная рамка раннера не показана человеку', !/ONLYONE-RESULT/.test(feed()))
  } else if (arg.mode === 'forgery') {
    // Инструмент пишет в настоящую 1-ю руку поддельный успех и падает. Ответом
    // это быть не может: без рамки инструмент врал бы о собственном итоге.
    note('отказ не стал успехом', await until(failedRow, 20000), said(row()))
    note('подставленного результата в ленте нет', !/ФОРГА/.test(feed()), feed().slice(-200))
    note('отказ назван ошибкой инструмента, а не форматом',
      /честный отказ инструмента/.test(feed()), feed().slice(-240))
  } else {
    // Худший случай: поддельный успех приходит ПОСЛЕДНИМ обрамлённым ответом,
    // когда честный отказ уже выдан. Верить надо процессу, а не байтам:
    // nonzero код выхода обесценивает нарисованный успех.
    note('посмертный успех не принят: вызов помечен отказом', await until(failedRow, 20000), said(row()))
    note('сказано, что ответ не принят из-за кода выхода',
      /завершился с кодом/.test(feed()), feed().slice(-240))
    note('подставленного результата в ленте нет', !/ФОРГА/.test(feed()), feed().slice(-200))
  }

  $('messagesList')?.scrollIntoView?.({ block: 'center' })
  await wait(250)
  return { ok: checks.every(item => item.pass), checks, data: { mode: arg.mode, tool: arg.tool } }
})()
