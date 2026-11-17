// Сканирование ленты хода на кириллицу при английском языке окна.
//
// В отличие от `en-no-cyrillic-renderer.js`, здесь смотрим ИМЕННО ленту:
// строки вызовов, чек-лист хода, paneль помощников и итог хода. Текст модели и
// человека исключить нельзя одним правилом — они и есть содержимое ленты, —
// поэтому фикстура называет ожидаемые русские вкрапления списком ниже.
/* global document, window */
(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms = 40000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch { /* лента ещё пишется */ }
      await wait(120)
    }
    return false
  }
  const CYR = /[а-яёА-ЯЁ]/
  const checks = []
  const note = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail })

  await until(() => document.documentElement.dataset.appReady === '1')
  await wait(400)
  if (typeof window.__setLanguage === 'function') await window.__setLanguage('en')
  await wait(400)
  note('язык окна английский', document.documentElement.lang === 'en', `lang=${document.documentElement.lang}`)

  $('newChatBtn')?.click()
  await wait(300)
  const box = $('composerTextarea')
  box.value = 'Прочитай файл и покажи результат'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm').requestSubmit()

  const rows = () => [...document.querySelectorAll('#messagesList .tool')]
  const said = el => String(el?.textContent || '').replace(/\s+/g, ' ').trim()

  // Пока ход идёт, в ленте стоит строка «ещё пишется», и её заголовок приходит
  // из главного процесса (`describeToolCall`, `TOOL_VERBS`): «Показываю
  // результат рядом с ответом». После итога строка перезаписывается, поэтому
  // снимать надо прямо во время хода, а не только его конец.
  const ALLOWED = [
    /^Прочитай файл и покажи результат$/,
    /^Готово: прочитал файл и показал результат\.$/,
    /^Проверить границы$/,
    /^Смотрю, где обрывается/,
    /^Границы проверены/,
    // Текст самой тестовой фикстуры (main.js, replyForSmokeTest), а не интерфейса.
    /^проверка хода мысли/,
    /^Показать результат$/
  ]
  const human = text => ALLOWED.some(rule => rule.test(text))

  const live = new Set()
  const seenVerbs = new Set()
  const sample = () => {
    // Только те части строки, которые принадлежат приложению: глагол и метка.
    // Цель вызова (имя артефакта, путь) и текст рассуждения — данные модели,
    // требовать от них английского было бы неправдой.
    document.querySelectorAll('#messagesList .rail-verb, #messagesList .rail-meta')
      .forEach(el => {
        const text = said(el)
        if (!text) return
        seenVerbs.add(text.slice(0, 60))
        if (CYR.test(text) && !human(text)) live.add(text.slice(0, 70))
      })
  }
  await until(() => rows().length > 0, 20000)
  for (let i = 0; i < 250; i++) {
    sample()
    if (!document.querySelector('.btn-send.is-stop') && seenVerbs.size) break
    await wait(60)
  }
  note('пока ход идёт, в ленте нет русских строк приложения', live.size === 0, 'видено: ' + [...seenVerbs].slice(0, 6).join(' ; '))

  // Законченный ход — свёрнутый блок с итогом: строки вызовов строятся при раскрытии.
  const openRuns = () => document.querySelectorAll('#messagesList .thought-group').forEach(group => { group.open = true })
  note('ход дал строки вызовов', await until(() => { openRuns(); return rows().length > 0 }, 20000), `${rows().length} строк`)
  note('ход закончился', await until(() => !document.querySelector('.btn-send.is-stop'), 60000))
  await wait(600)

  // Что в ленте имеет право быть по-русски: текст просьбы человека и ответ
  // модели из фикстуры. Всё остальное — строки приложения.

  const offenders = []
  const collect = (where, text) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim()
    if (!clean || !CYR.test(clean) || human(clean)) return
    offenders.push(`${where} «${clean.slice(0, 70)}»`)
  }
  // В строке вызова три части: глагол и метка времени — дело приложения, а
  // цель (имя артефакта, путь) — текст модели или человека. Требовать
  // английскости от всей строки значит ругаться на данные, поэтому смотрим по
  // частям.
  rows().forEach(row => {
    collect('глагол вызова', said(row.querySelector('.rail-verb')))
    collect('метка вызова', said(row.querySelector('.rail-meta')))
  })
  document.querySelectorAll('#messagesList .rail-step, #messagesList .agent-task, #messagesList .plan-item, #messagesList .msg-meta')
    .forEach(el => {
      if (el.matches('.tool')) return
      collect('лента', said(el))
    })
  document.querySelectorAll('#workPanel [class]').forEach(el => {
    if (el.children.length) return
    collect('панель работы', said(el))
  })

  note('в ленте хода на английском нет русских строк приложения', offenders.length === 0,
    offenders.slice(0, 12).join(' | '))

  return { ok: checks.every(item => item.pass), checks, data: { offenders, 'видено в ленте': [...seenVerbs].slice(0, 12) } }
})()
