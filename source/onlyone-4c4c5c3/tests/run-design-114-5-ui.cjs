'use strict'
// Типографика в настоящем окне (план, 1.14 часть 5).
//
// Страж по исходникам не знает, что вышло на экране: каскад, `!important` и
// наследование решают сами. Здесь меряется вычисленный стиль: одна ли это
// семейство на панели, в сообщении, на кнопке и в подписи настройки; есть ли
// жирнее 500; есть ли текст мельче 12 px.
//
// Кадр — доказательство: правка меняет вид каждого экрана, поэтому он снимается
// в двух языках и на настройках отдельно.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-design-114-5')
const evidence = process.env.ONECODE_EVIDENCE_DIR
  || path.join(root, 'audits', 'qoder-2-2026-09-29', 'design-114-5')
const profile = path.join(out, 'profile')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(profile, { recursive: true })

function writeSettings (lang) {
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    language: lang,
    openrouterKeys: [{ id: 'k', name: 'Тест', keyEncrypted: 'Q1RFU1Qt', modelId: 'z-ai/glm-5.2:free', enabled: true }],
    defaultModel: 'z-ai/glm-5.2:free',
    activeProvider: 'openrouter',
    legacyStoragePurged: true,
    workspace: { path: workspace, permission: 'acceptEdits' }
  }))
}
writeSettings('ru')

function launch (name, body) {
  const script = path.join(out, name + '.js')
  const resultFile = path.join(out, name + '.json')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 60000) => {
      const stop = Date.now() + ms
      while (Date.now() < stop) { try { if (fn()) return true } catch {}; await wait(120) }
      return false
    }
    const checks = []
    const note = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    const errors = []
    window.addEventListener('error', e => errors.push(String(e.message).slice(0, 160)))
    await until(() => document.documentElement.dataset.appReady === '1')
    await wait(900)
    // Одна семья для всего интерфейсного текста: сравниваются вычисленные
    // стеки, а не имена токенов — каскад может подменить семейство молча.
    const probes = {
      panel: '.nav-item', title: '.hero-title, .chat-header-title', chat: '.msg-content',
      button: '.btn-primary', label: '.row-title', hint: '.row-hint', meta: '.msg-meta'
    }
    const families = {}
    for (const key of Object.keys(probes)) {
      const el = document.querySelector(probes[key])
      // Пустой диалог не имеет msg-content, а row-title живёт только в
      // настройках: сравниваются те пробы, что реально есть на этом экране.
      if (el) families[key] = getComputedStyle(el).fontFamily
    }
    const uniq = [...new Set(Object.values(families))]
    note('один шрифт на панель, сообщение, кнопку и подпись',
      Object.keys(families).length >= 3 && uniq.length === 1,
      Object.keys(families).length + ' проб, семейств: ' + uniq.length + ' · ' + JSON.stringify(families))
    const visible = el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0
    const textNodes = () => [...document.querySelectorAll('body *')].filter(el =>
      visible(el) && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))
    // Макет 21.10: заголовкам (имя продукта, приветствие, заголовки страниц и окон) — вес
    // --fw-head, 600; всему остальному по-прежнему не жирнее 500
    const head = Number(getComputedStyle(document.documentElement).getPropertyValue('--fw-head')) || 500
    const isHead = el => /^H[1-3]$/.test(el.tagName) || /brand-name|hero-greeting|modal-title|page-title|settings-group-title|settings-page-title/.test(el.className || '')
    const heavy = () => textNodes().filter(el => { const w = Number(getComputedStyle(el).fontWeight); return w > 500 && !(isHead(el) && w <= head) })
      .map(el => (el.className || el.tagName) + '=' + getComputedStyle(el).fontWeight)
    const tiny = () => textNodes().filter(el => {
      const px = parseFloat(getComputedStyle(el).fontSize)
      if (px >= 12) return false
      // Служебные цифры и глифы: счётчики, клавиши, номера — карточка Текст
      // оставляет им право быть мелкими.
      return !/kbd|count|badge|num|avatar|del|stage-num|line-number/i.test(el.className || '')
    }).map(el => (el.className || el.tagName) + '=' + getComputedStyle(el).fontSize)
    const mono = () => textNodes().filter(el => /Fira Code|monospace/i.test(getComputedStyle(el).fontFamily)
      && !/code|pre|kbd|diff|editor|terminal|console/i.test((el.closest('pre, code, kbd, .msg-code, .code-block, .approval-diff') || {}).className || el.tagName))
      .map(el => (el.className || el.tagName) + ' :: ' + el.textContent.trim().slice(0, 24))
${body}
    note('ошибок в окне нет', !errors.length, errors.join(' | ') || 'нет')
    return { ok: checks.every(item => item.pass), checks }
  })()`)

  // Скрипт собирается подстановкой: обратная кавычка в комментарии внутри
  // шаблона разрывает его пополам, и `node --check` самого прогона этого не
  // видит — валидится именно сгенерированный файл.
  const check = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
  if (check.status !== 0) {
    console.error('ПРОВАЛ ' + name + ': сгенерированный скрипт не разобран\n' + (check.stderr || '').slice(0, 600))
    return { ok: false, checks: [{ label: 'скрипт прогона разобран', pass: false, detail: (check.stderr || '').slice(0, 200) }] }
  }
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 240000, stdio: 'inherit',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_SHOT: path.join(out, name + '.png') })
  })
  if (!fs.existsSync(resultFile)) {
    console.error('ПРОВАЛ ' + name + ': окно не отчиталось (status ' + child.status + ')')
    return { ok: false, checks: [] }
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  for (const one of report.checks || []) {
    console.log((one.pass ? '  ok  ' : 'ПРОВАЛ ') + name + ' · ' + one.label + (one.detail ? ' — ' + one.detail.slice(0, 200) : ''))
  }
  return report
}

const screens = `
  note('жирнее 500 на экране нет, кроме заголовков', heavy().length === 0, heavy().slice(0, 6).join(' | ') || 'нет')
  note('текста мельче 12 px нет', tiny().length === 0, tiny().slice(0, 6).join(' | ') || 'нет')
  note('моноширинный только в коде', mono().length === 0, mono().slice(0, 6).join(' | ') || 'нет')
  $('openSettingsBtn')?.click(); await wait(900)
  $('tab-keys')?.click(); await wait(700)
  note('в настройках жирнее 500 нет, кроме заголовков', heavy().length === 0, heavy().slice(0, 6).join(' | ') || 'нет')
  note('в настройках текст не мельче 12 px', tiny().length === 0, tiny().slice(0, 6).join(' | ') || 'нет')
  const fam2 = {}
  for (const key of Object.keys(probes)) {
    const el = document.querySelector(probes[key])
    if (el) fam2[key] = getComputedStyle(el).fontFamily
  }
  note('в настройках тот же шрифт, что и везде',
    Object.keys(fam2).length >= 3 && [...new Set(Object.values(fam2))].length === 1,
    JSON.stringify(fam2))
  // Кадр — на главном экране: лента и панель показываются лучше, чем вкладка
  // настроек, а съёмка делается сразу после возврата промиса.
  document.querySelector('[data-close="settingsModal"]')?.click()
  await wait(500)
`

const ru = launch('screens-ru', screens)
writeSettings('en')
const en = launch('screens-en', screens)

const reports = [ru, en]
const failed = reports.flatMap(one => (one.checks || []).filter(check => !check.pass))
for (const name of ['screens-ru', 'screens-en']) {
  const shot = path.join(out, name + '.png')
  if (fs.existsSync(shot)) {
    fs.mkdirSync(evidence, { recursive: true })
    fs.copyFileSync(shot, path.join(evidence, name + '.png'))
  }
}
const ok = failed.length === 0
settleRun(out, ok)
console.log(JSON.stringify({ ok, checks: reports.reduce((n, one) => n + (one.checks || []).length, 0), failed: failed.length }))
process.exitCode = ok ? 0 : 1
