// Вступление первого запуска (макет 25.10) в настоящем окне: свежий профиль,
// весь путь — привет с примером работы, имя, занятие (и переключение языка),
// упор, модели, тема, конец = главный экран. Версий во вступлении нет.
// Ключ здесь не добавляется: проверка ключа идёт в сеть, а общий прогон от
// сети не зависит.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const root = path.join(__dirname, '..')
const output = runDir('onlyone-onboarding-ui')
const out = path.join(output, 'checks.json')
const script = path.join(output, 'renderer.js')
const visualOnly = process.env.ONECODE_ONBOARDING_VISUAL_ONLY === '1'
const evidence = process.env.ONECODE_EVIDENCE_DIR
if (visualOnly && evidence) fs.mkdirSync(evidence, { recursive: true })

fs.writeFileSync(script, `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 8000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (await fn()) return true } catch {} ; await wait(50) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })
  await until(() => document.documentElement.dataset.appReady === '1', 20000)
  const ob = () => $('onboarding')
  const stepName = () => ob()?.querySelector('.ob-step')?.dataset.step
  const next = () => ob().querySelector('.ob-next').click()
  const goNext = async to => { next(); return until(() => stepName() === to) }
  const title = () => ob()?.querySelector('#obTitle')?.textContent || ''
  const cardTop = () => Math.round(ob().querySelector('.ob-card').getBoundingClientRect().top)
  const side = document.querySelector('.sidebar')
  const seen = []
  const watch = setInterval(() => { const s = stepName(); if (s && seen[seen.length - 1] !== s) seen.push(s) }, 40)

  note('на свежем профиле открылось знакомство', await until(() => ob()?.classList.contains('is-in')))
  note('это диалог, и он подписан', ob()?.getAttribute('role') === 'dialog' && ob()?.getAttribute('aria-labelledby') === 'obTitle')
  note('вступление стоит в главной колонке окна', ob()?.parentElement?.classList.contains('main-content'), ob()?.parentElement?.className)
  note('строка заголовка окна открыта', !document.querySelector('.window-titlebar')?.closest('[inert]'))
  note('боковая панель настоящая, приглушена и недоступна', side?.classList.contains('ob-dim') && side?.inert === true)
  note('чат под вступлением недоступен', $('chatView')?.inert === true)

  // Привет: знак, заголовок, пример работы; один вопрос в карточке.
  note('сначала привет', stepName() === 'hello' && /onlyone/.test(title()), title())
  note('у привета нет счётчика вопросов', !ob().querySelector('.ob-count'))
  note('фокус на главной кнопке', document.activeElement === ob().querySelector('.ob-next'), document.activeElement?.className)
  note('нет окна в окне, полосы прогресса и «Назад»',
    !ob().querySelector('.app-shot, .ob-progress, .ob-back, .oi-tabs, .ob-glow'))
  note('пример работы: сообщение и ответ по словам', await until(() => ob().querySelector('.ob-bubble') &&
    (ob().querySelector('#obDemoAnswer')?.textContent || '').length > 40, 9000))
  {
    const filled = [...ob().querySelectorAll('.ob-btn.is-pri, .ob-send')].filter(n => n.offsetParent !== null)
    note('одна залитая кнопка', filled.length === 1, filled.length)
  }
  const helloTop = cardTop()

  // Имя.
  note('имя', await goNext('name'))
  note('вопрос встал на то же место', Math.abs(cardTop() - helloTop) <= 2, helloTop + ' → ' + cardTop())
  note('фокус в поле имени', document.activeElement === $('obName'))
  note('счётчик «1 из 5»', /1\\D+5/.test(ob().querySelector('.ob-count')?.textContent || ''), ob().querySelector('.ob-count')?.textContent)
  $('obName').value = 'Тест'
  $('obName').dispatchEvent(new Event('input', { bubbles: true }))
  $('obName').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  note('Enter в имени ведёт дальше', await until(() => stepName() === 'role'))
  note('заголовок обращается по имени', await until(() => /Тест/.test(title())), title())
  note('вопрос стоит на месте строки ввода', Math.abs(cardTop() - helloTop) <= 2, helloTop + ' → ' + cardTop())

  // Занятие: 12 ролей, всегда по-английски.
  const roles = [...ob().querySelectorAll('[data-role]')]
  note('12 вариантов занятия', roles.length === 12 &&
    ['developer', 'designer', 'product', 'analyst', 'marketing', 'founder', 'manager', 'consultant', 'operations', 'educator', 'student', 'other']
      .every(id => roles.some(role => role.dataset.role === id)), roles.map(r => r.dataset.role).join(','))
  note('занятия по-английски', roles.every(role => /^[A-Za-z /&-]+$/.test(role.textContent.trim())), roles.map(r => r.textContent.trim()).join(' · '))
  ob().querySelector('[data-role="product"]').click(); await wait(150)
  note('роль выбрана', ob().querySelector('[data-role="product"]').getAttribute('aria-checked') === 'true')

  // Язык прямо во вступлении.
  ob().querySelector('.ob-lang [data-lang="en"]').click()
  note('по-английски заголовок', await until(() => /Nice to meet you, Тест/.test(title())), title())
  note('по-английски кнопки', /Next/.test(ob().querySelector('.ob-next').textContent) && /Skip/.test(ob().querySelector('.ob-skip').textContent),
    ob().querySelector('.ob-next').textContent + ' / ' + ob().querySelector('.ob-skip').textContent)
  note('по-английски занятия те же', /Product Manager/.test(ob().querySelector('[data-role="product"]')?.textContent || ''))
  ob().querySelector('.ob-lang [data-lang="ru"]').click()
  note('обратно по-русски', await until(() => /Приятно познакомиться/.test(title())), title())

  // Упор: несколько, снимается повторным нажатием.
  note('упор', await goNext('focus'))
  ob().querySelector('[data-focus="design"]').click()
  ob().querySelector('[data-focus="research"]').click()
  ob().querySelector('[data-focus="code"]').click()
  ob().querySelector('[data-focus="code"]').click()
  let saved
  const savedPersonal = await until(async () => {
    saved = await window.electronAPI.getPersonal()
    return saved.name === 'Тест' && saved.role === 'product' && (saved.focus || []).join(',') === 'design,research'
  })
  note('имя, роль и упор сохранены', savedPersonal, JSON.stringify({ name: saved?.name, role: saved?.role, focus: saved?.focus }))
  const rowText = id => ob().querySelector('[data-edit="' + id + '"]')?.textContent.replace(/\\s+/g, ' ').trim() || ''
  note('ответ уехал вверх строкой', /Занятие\\s*Product Manager/.test(rowText('role')), rowText('role'))

  // Модели: без ключа — «Позже», «Проверить» выключена, пока поле пустое.
  note('модели', await goNext('key'))
  note('без ключа главная кнопка говорит «Позже»', /Позже/.test(ob().querySelector('.ob-next').textContent), ob().querySelector('.ob-next').textContent)
  note('«Проверить» выключена, пока поле пустое', $('obKeyAdd')?.disabled === true)
  const key = $('obKey')
  key.focus()
  key.value = 'sk-test'
  key.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(80)
  note('введённый ключ можно проверить, и залита только «Проверить»', $('obKeyAdd')?.disabled === false &&
    $('obKeyAdd').classList.contains('is-pri') && !ob().querySelector('.ob-next').classList.contains('is-pri'))
  note('каретка осталась в поле', document.activeElement === $('obKey'))
  $('obKey').value = ''
  $('obKey').dispatchEvent(new Event('input', { bubbles: true }))
  await wait(80)
  ob().querySelector('#obProvBtn').click()
  note('провайдер — меню, а не системный список', await until(() => ob().querySelectorAll('#obProvMenu [data-prov]').length >= 1) &&
    !ob().querySelector('select'))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  note('Esc закрывает меню и не закрывает вступление', await until(() => !ob().querySelector('#obProvMenu')) && stepName() === 'key')

  // Тема.
  note('тема', await goNext('theme'))
  note('счётчик «5 из 5»', /5\\D+5/.test(ob().querySelector('.ob-count')?.textContent || ''))
  note('модели отложены — строка «позже»', /Модели\\s*позже/.test(rowText('key')), rowText('key'))
  ob().querySelector('[data-theme-v="light"]').click(); await wait(300)
  note('тема меняется сразу', $('personalTheme')?.value === 'light', $('personalTheme')?.value)
  ob().querySelector('[data-theme-v="dark"]').click(); await wait(300)

  // Строка ответа возвращает к вопросу.
  ob().querySelector('[data-edit="role"]').click()
  note('строка ответа возвращает к вопросу', await until(() => stepName() === 'role') &&
    !ob().querySelector('[data-edit="role"]') && ob().querySelector('[data-role="product"]').getAttribute('aria-checked') === 'true')
  await goNext('focus'); await goNext('key'); await goNext('theme')

  // Конец: главный экран.
  note('конец', await goNext('done'))
  note('конец приветствует', /Приветствую в onlyone/.test(title()), title())
  await wait(500)
  note('боковая панель ожила', !side.classList.contains('ob-dim') && side.inert === false)
  note('язык и «Пропустить» ушли', getComputedStyle(ob().querySelector('.ob-top')).visibility === 'hidden')
  note('строк ответов в конце нет', !ob().querySelector('[data-edit]'))
  note('фокус в строке ввода', document.activeElement === $('obComposer'))
  note('версий во вступлении не было', seen.join(',') === 'hello,name,role,focus,key,theme,role,focus,key,theme,done', seen.join(','))
  clearInterval(watch)
  if ('__ONECODE_ARG__' === 'visual') return { ok: checks.every(c => c.pass), checks }

  $('obComposer').value = 'п'
  $('obComposer').dispatchEvent(new Event('input', { bubbles: true }))
  note('первое слово уходит в настоящую строку ввода', await until(() => !ob()) && $('composerTextarea').value === 'п' &&
    document.activeElement === $('composerTextarea'), $('composerTextarea').value)
  note('чат снова доступен', $('chatView')?.inert === false)
  note('знакомство запомнено вместе с его версией', localStorage.getItem('onlyone.onboarded') === '1' &&
    localStorage.getItem('onlyone.onboardingRev') === window.onlyoneOnboarding.REV)
  note('новый человек не следит за новыми вступлениями', localStorage.getItem('onlyone.onboardingFollow') === '0')
  $('composerTextarea').value = ''
  $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))

  // «Пропустить» — одно нажатие до главного экрана.
  window.onlyoneOnboarding.open()
  await until(() => ob()?.classList.contains('is-in'))
  ob().querySelector('.ob-skip').click()
  note('«Пропустить» сразу открывает приложение', await until(() => !ob()) && !side.classList.contains('ob-dim') && side.inert === false)

  $('openSettingsBtn')?.click(); await wait(400)
  document.querySelector('[data-settings-tab="appearance"]')?.click(); await wait(200)
  const settingsCards = [...document.querySelectorAll('#editionChoices .edition-card')]
  note('версии остались только в Настройках', settingsCards.length === 3 && settingsCards[1].getAttribute('aria-disabled') === 'true',
    settingsCards.map(c => c.dataset.edition + ':' + c.getAttribute('aria-checked')).join(','))
  await window.electronAPI.setPersonal({ name: '', role: '', focus: [] })
  await wait(300)
  return { ok: checks.every(c => c.pass), checks }
})()`)

const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(output, 'profile')], {
  cwd: root, timeout: 200000, stdio: 'inherit',
  env: guiEnv({
    ONECODE_SMOKE: script,
    ONECODE_SMOKE_OUT: out,
    ONECODE_ONBOARDING: '1',
    ...(visualOnly ? { ONECODE_ARG: 'visual' } : {}),
    ...(visualOnly && evidence ? { ONECODE_SHOT: path.join(evidence, 'onboarding-done.png') } : {})
  })
})
if (child.error) throw child.error
if (!fs.existsSync(out)) { console.error('окно не отчиталось: ' + out); process.exit(1) }
const report = JSON.parse(fs.readFileSync(out, 'utf8'))
for (const c of report.checks || []) console.log((c.pass ? 'ok     ' : 'ПРОВАЛ ') + c.name + (!c.pass && c.detail ? ' — ' + c.detail : ''))
if (report.error) console.log('ошибка окна: ' + report.error)
const passed = (report.checks || []).filter(c => c.pass).length
console.log(`Вступительный экран — проверок ${(report.checks || []).length}, успешно ${passed}`)
settleRun(output, report.ok)
process.exit(report.ok ? 0 : 1)
