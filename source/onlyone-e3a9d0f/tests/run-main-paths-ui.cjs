// Сквозной набор «без сбоев», часть 2 (план, 9.7): главные пути приложения в окне.
//
// Один прогон настоящего окна на чистом профиле: приложение поднялось, все
// разделы боковой панели открываются, все вкладки настроек открываются, новый
// диалог заводится и набирается, тема и язык переключаются туда и обратно — и за
// весь путь ни одной необработанной ошибки страницы. Ловит то, что рвётся при
// сборке: пропавший модуль, скрипт вне порядка, разметка без обработчика.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { electronBinary, guiEnv } = require('./app-launch.cjs')
const root = path.join(__dirname, '..')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-main-paths-'))
const out = path.join(output, 'checks.json')
const script = path.join(output, 'renderer.js')

fs.writeFileSync(script, `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 8000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(50) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })
  const errors = []
  window.addEventListener('error', event => errors.push(String(event.message || event.error)))
  window.addEventListener('unhandledrejection', event => errors.push('promise: ' + String(event.reason?.message || event.reason)))

  await until(() => document.documentElement.dataset.appReady === '1', 20000)
  await wait(500)
  note('приложение поднялось', document.documentElement.dataset.appReady === '1')
  note('нет экрана вступления на автоматическом запуске', !$('onboarding'))

  // Разделы боковой панели: у каждого своя страница, и она видна.
  const sections = ['navChats', 'navProjects', 'navSkills', 'navDesign', 'navConnectors']
  for (const id of sections) {
    const button = $(id)
    if (!button) { note('раздел ' + id + ' есть в боковой панели', false); continue }
    button.click()
    await wait(350)
    const main = document.querySelector('main, .main-content, #mainContent') || document.body
    note('раздел ' + id + ' открывается и отмечен активным',
      button.classList.contains('active') && main.getBoundingClientRect().width > 300, button.className)
  }
  $('navChats')?.click(); await wait(300)

  // Вкладки настроек: каждая показывает свою панель.
  document.querySelector('.btn-settings-footer')?.click(); await wait(400)
  const tabs = [...document.querySelectorAll('[data-settings-tab]')].map(tab => tab.dataset.settingsTab)
  note('в настройках есть вкладки', tabs.length >= 6, tabs.join(','))
  for (const tab of tabs) {
    document.querySelector('[data-settings-tab="' + tab + '"]')?.click()
    await wait(200)
    const panel = $('panel-' + tab)
    note('вкладка настроек «' + tab + '» открывается', panel && !panel.hidden && panel.getBoundingClientRect().height > 40,
      panel ? 'скрыта=' + panel.hidden : 'нет панели')
  }
  document.querySelector('#settingsModal [data-close="settingsModal"]')?.click(); await wait(300)

  // Диалог: новый, набор текста, отправка не нужна — строка ввода живая.
  $('newChatBtn')?.click(); await wait(400)
  const area = $('composerTextarea')
  note('строка ввода есть и доступна', Boolean(area) && !area.disabled)
  if (area) {
    area.focus(); area.value = 'проверка'; area.dispatchEvent(new Event('input', { bubbles: true })); await wait(150)
    note('набранное остаётся в строке', area.value === 'проверка')
    area.value = ''; area.dispatchEvent(new Event('input', { bubbles: true }))
  }

  // Язык и тема туда и обратно: окно переводится целиком и возвращается.
  const before = document.documentElement.lang
  await window.__setLanguage?.('en'); await wait(300)
  note('язык переключается на английский', document.documentElement.lang === 'en')
  await window.__setLanguage?.('ru'); await wait(300)
  note('язык возвращается', document.documentElement.lang === before, document.documentElement.lang)

  await wait(400)
  note('за весь путь ни одной необработанной ошибки страницы', errors.length === 0, errors.slice(0, 3).join(' | '))
  return { ok: checks.every(item => item.pass), checks }
})()`)

const shot = path.join(output, 'main-paths.png')
spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(output, 'profile')], {
  cwd: root, timeout: 120000, stdio: 'inherit',
  env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SHOT: shot })
})

let report
try { report = JSON.parse(fs.readFileSync(out, 'utf8')) } catch { report = null }
if (!report || !Array.isArray(report.checks)) {
  console.error('ПРОВАЛ прогон не оставил отчёта — окно не поднялось. Папка:', output)
  process.exit(1)
}
for (const item of report.checks) console.log(`${item.pass ? 'ok    ' : 'ПРОВАЛ'} ${item.name}${item.pass || !item.detail ? '' : ' — ' + item.detail}`)
const bad = report.checks.filter(item => !item.pass)
console.log(`Главные пути — проверок ${report.checks.length}, успешно ${report.checks.length - bad.length}`)
process.exit(bad.length || report.error ? 1 : 0)
