// Представление onlyone Ultra (план, 9.2) в настоящем окне: свежий профиль,
// весь сценарий в ускоренном темпе — пять сцен по порядку, финал «onlyone
// Ultra» с кнопкой; правило «один раз»; вызов из Настроек; Escape; английский
// без единой русской буквы. Кадр финала — в каталоге прогона.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const root = path.join(__dirname, '..')
const output = runDir('onlyone-ultra-intro-ui')
const out = path.join(output, 'checks.json')
const script = path.join(output, 'renderer.js')
// Кадр финала: в папку улик, если она задана (зелёный прогон свой каталог удаляет).
const evidence = process.env.ONECODE_EVIDENCE_DIR
if (evidence) fs.mkdirSync(evidence, { recursive: true })
const shot = path.join(evidence || output, 'ultra-intro-final.png')

fs.writeFileSync(script, `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 8000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(40) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })
  await until(() => document.documentElement.dataset.appReady === '1', 20000)
  await wait(300)
  const U = window.onlyoneUltraIntro
  const ux = () => document.getElementById('ultraIntro')
  note('модуль на месте', U && typeof U.show === 'function' && typeof U.maybeShow === 'function')
  localStorage.removeItem('onlyone.ultraIntro')
  note('новому человеку показывается', U.shouldShow() === true)

  const titles = []
  const watch = setInterval(() => {
    const h = ux() && ux().querySelector('.ux-cap.is-on h2')
    const text = h ? h.textContent : ''
    if (text && !titles.includes(text)) titles.push(text)
  }, 40)
  U.maybeShow({ pace: 0.18 })
  note('открылся диалог', await until(() => ux() && ux().classList.contains('is-in')) &&
    ux().getAttribute('role') === 'dialog' && ux().getAttribute('aria-modal') === 'true')
  note('фокус на «Пропустить»', document.activeElement === ux().querySelector('.ux-skip'), document.activeElement && document.activeElement.className)
  const bar = document.querySelector('.window-titlebar')
  note('строка заголовка окна остаётся доступной', Math.round(ux().getBoundingClientRect().top) === Math.round(bar ? bar.offsetHeight : 0))
  {
    const frame = ux().getBoundingClientRect()
    const stage = ux().querySelector('.ux-stage').getBoundingClientRect()
    note('сцена целиком в окне', stage.left >= frame.left - 1 && stage.right <= frame.right + 1 && stage.top >= frame.top - 1 && stage.bottom <= frame.bottom + 1,
      Math.round(stage.width) + '×' + Math.round(stage.height) + ' в ' + Math.round(frame.width) + '×' + Math.round(frame.height))
  }
  note('01: запрос — и все этапы работы отмечены', await until(() => ux().querySelectorAll('.ux-step.is-done').length === 5, 20000))
  note('02: блок прилипает к краю', await until(() => ux().querySelector('.ux-snap.is-on'), 15000))
  note('02: блок растягивается за край', await until(() => ux().querySelector('.ux-block').style.getPropertyValue('--clip') === '0px', 15000))
  note('02: блок сворачивается в плашку', await until(() => ux().querySelector('.ux-pill.is-on'), 15000))
  note('03: примерка — пунктир и «Оставить»', await until(() => ux().querySelector('.ux-block.is-trying') && ux().querySelector('.ux-try.is-on'), 20000))
  note('03: после «Оставить» — «Применено»', await until(() => ux().querySelector('[data-item="applied"].is-on'), 15000))
  note('04: граф — все этапы сделаны', await until(() => ux().querySelectorAll('.ux-node.is-done').length === 5, 20000))
  note('финал: onlyone Ultra, строка и кнопка', await until(() => ux().classList.contains('is-final'), 25000) &&
    ux().querySelector('.ux-final h2').textContent.replace(/ +/g, ' ').trim() === 'onlyone Ultra' && !!ux().querySelector('.ux-final p').textContent.trim())
  note('фокус на кнопке финала', await until(() => document.activeElement === ux().querySelector('.ux-cta'), 4000))
  clearInterval(watch)
  note('пять сцен по порядку', titles.length === 5, titles.join(' | '))
  {
    const text = ux().innerText
    const bad = ['GLM', 'GPT', 'Claude', 'Gemini', 'Nemotron', 'OpenRouter', 'pkwobler', 'Добрый'].filter(word => text.includes(word))
    note('в кадре нет моделей и имён', bad.length === 0, bad.join(', '))
  }
  ux().querySelector('.ux-cta').click()
  note('кнопка финала закрывает', await until(() => !ux(), 3000))
  note('больше само не показывается', U.shouldShow() === false && localStorage.getItem('onlyone.ultraIntro') === U.REV)
  U.maybeShow()
  await wait(300)
  note('maybeShow после просмотра — ничего', !ux())

  const button = document.getElementById('showUltraIntroBtn')
  note('кнопка в Настройках есть', !!button)
  button && button.click()
  note('из Настроек — открывается снова', await until(() => ux() && ux().classList.contains('is-in'), 3000))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  note('Escape закрывает', await until(() => !ux(), 3000))

  // По-английски: ни одной русской буквы от начала до финала.
  await window.__setLanguage('en')
  await wait(300)
  const seenText = []
  const watchEn = setInterval(() => { if (ux()) seenText.push(ux().innerText) }, 120)
  U.show({ pace: 0.18 })
  const enFinal = await until(() => ux() && ux().classList.contains('is-final'), 30000)
  await wait(900)
  clearInterval(watchEn)
  const cyrillic = seenText.join(' ').match(/[а-яё]+/gi) || []
  note('английский: без русских букв на всём пути', enFinal && cyrillic.length === 0, [...new Set(cyrillic)].slice(0, 8).join(' '))
  note('английский: финал по-английски', /Everything onlyone can do/.test(ux().querySelector('.ux-final p').textContent), ux().querySelector('.ux-final p').textContent)
  await window.__setLanguage('ru')
  return { ok: checks.every(c => c.pass), checks }
})()`)

const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(output, 'profile')], {
  cwd: root, timeout: 180000, stdio: 'inherit',
  env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SHOT: shot })
})
if (child.error) throw child.error
if (!fs.existsSync(out)) { console.error('окно не отчиталось: ' + out); process.exit(1) }
const report = JSON.parse(fs.readFileSync(out, 'utf8'))
for (const c of report.checks || []) console.log((c.pass ? 'ok     ' : 'ПРОВАЛ ') + c.name + (!c.pass && c.detail ? ' — ' + c.detail : ''))
if (report.error) console.log('ошибка окна: ' + report.error)
const passed = (report.checks || []).filter(c => c.pass).length
console.log(`Представление Ultra — проверок ${(report.checks || []).length}, успешно ${passed}`)
if (evidence) console.log('кадр: ' + shot)
settleRun(output, report.ok)
process.exit(report.ok ? 0 : 1)
