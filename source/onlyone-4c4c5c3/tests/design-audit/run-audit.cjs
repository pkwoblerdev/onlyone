// Аудит расхождений дизайна.
//
// Окно запускается заново на каждое состояние: пустой чат, ответ, меню,
// настройки по вкладкам, разделы, окна. В каждом снимаются стили всего
// видимого — текст, значки, кнопки, радиусы, тени, системные подсказки,
// символы и эмодзи — и делается снимок. Итог — raw.json для сводки.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const root = path.resolve(__dirname, '../..')
const { electronBinary, guiEnv } = require(root + '/tests/app-launch.cjs')
const here = __dirname
// Запуск: node tests/design-audit/run-audit.cjs [состояние,состояние] — затем
// node tests/design-audit/summarize.cjs. Снимки и сводка — во временной папке.
const outDir = path.join(os.tmpdir(), 'onlyone-design-audit')
const shots = path.join(outDir, 'shots')
fs.mkdirSync(shots, { recursive: true })
const only = process.argv[2] ? process.argv[2].split(',') : null

// Что сделать в окне, чтобы попасть в состояние. Код выполняется в окне.
const STATES = {
  'chat-empty': ``,
  'chat-answer': `await ask()`,
  'quote': `await ask()
    const p = [...document.querySelectorAll('#messagesList .msg-content p')].pop()
    if (p) { const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r) }
    await wait(500)`,
  'plus-menu': `document.getElementById('attachBtn').click(); await wait(400)`,
  'perm-menu': `document.getElementById('permModeBtn').click(); await wait(400)`,
  'model-modal': `document.getElementById('modelEffortPillBtn').click(); await wait(700)`,
  'settings-personal': `await openSettings('personal')`,
  'settings-personal-compact': `window.resizeTo(900, 640); await wait(300); await openSettings('personal')`,
  'settings-appearance': `await openSettings('appearance')`,
  'settings-appearance-compact': `window.resizeTo(900, 640); await wait(300); await openSettings('appearance')`,
  'settings-keys': `await openSettings('keys')`,
  'settings-keys-compact': `window.resizeTo(900, 640); await wait(300); await openSettings('keys')`,
  'settings-workspace': `await openSettings('workspace')`,
  'settings-workspace-compact': `window.resizeTo(900, 640); await wait(300); await openSettings('workspace')`,
  'settings-updates': `await openSettings('updates')`,
  'settings-updates-compact': `window.resizeTo(900, 640); await wait(300); await openSettings('updates')`,
  'settings-shortcuts': `await openSettings('shortcuts')`,
  'settings-shortcuts-compact': `window.resizeTo(900, 640); await wait(300); await openSettings('shortcuts')`,
  'settings-select-open': `await openSettings('personal')
    document.querySelector('#panel-personal .select-ui-trigger')?.click(); await wait(400)`,
  'settings-select-open-compact': `window.resizeTo(900, 640); await wait(300); await openSettings('personal')
    document.querySelector('#panel-personal .select-ui-trigger')?.click(); await wait(400)`,
  'projects': `document.getElementById('navProjects').click(); await wait(600)`,
  'projects-narrow-sidebar': `document.getElementById('sidebarToggle').click(); await wait(300)
    document.getElementById('navProjects').click(); await wait(600)`,
  'projects-light': `document.documentElement.dataset.theme = 'light'
    document.getElementById('navProjects').click(); await wait(600)`,
  'projects-compact': `window.resizeTo(900, 640); await wait(300)
    document.getElementById('navProjects').click(); await wait(600)`,
  'skills': `document.getElementById('navSkills').click(); await wait(600)`,
  'skills-light': `document.documentElement.dataset.theme = 'light'
    document.getElementById('navSkills').click(); await wait(600)`,
  'skills-compact': `window.resizeTo(900, 640); await wait(300)
    document.getElementById('navSkills').click(); await wait(600)`,
  'design': `document.getElementById('navDesign').click(); await wait(800)`,
  'design-narrow-sidebar': `document.getElementById('sidebarToggle').click(); await wait(300)
    document.getElementById('navDesign').click(); await wait(800)`,
  'design-light': `document.documentElement.dataset.theme = 'light'
    document.getElementById('navDesign').click(); await wait(800)`,
  'design-compact': `window.resizeTo(900, 640); await wait(300)
    document.getElementById('navDesign').click(); await wait(800)`,
  'design-compact-collapsed': `window.resizeTo(900, 640); await wait(300)
    document.getElementById('sidebarToggle').click(); await wait(300)
    document.getElementById('navDesign').click(); await wait(800)`,
  'mcp': `document.getElementById('navConnectors').click(); await wait(600)`,
  'mcp-light': `document.documentElement.dataset.theme = 'light'
    document.getElementById('navConnectors').click(); await wait(600)`,
  'mcp-compact': `window.resizeTo(900, 640); await wait(300)
    document.getElementById('navConnectors').click(); await wait(600)`,
  'project-editor': `document.getElementById('navProjects').click(); await wait(500)
    document.getElementById('newProjectBtn').click(); await wait(700)`,
  'skill-modal': `document.getElementById('navSkills').click(); await wait(500)
    document.getElementById('addSkillBtn').click(); await wait(600)`,
  'mcp-modal': `document.getElementById('navConnectors').click(); await wait(500)
    document.getElementById('addMcpServerBtn').click(); await wait(600)`,
  // Окно подтверждения: крестик удаления у первого скилла. Само удаление не
  // подтверждается — снимается только окно.
  'confirm': `document.getElementById('navSkills').click(); await wait(500)
    document.querySelector('.skill-delete-btn')?.click(); await wait(600)`
}

const renderer = body => `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  const until = async (fn, ms = 15000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(30) }
    return false
  }
  const timings = {}
  await until(() => document.documentElement.dataset.appReady === '1')
  await wait(500)

  async function ask() {
    const box = document.getElementById('composerTextarea')
    box.value = 'Сделай одностраничный сайт с пальмами'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(150)
    document.getElementById('composerForm').requestSubmit()
    await until(() => /Сайт с пальмами готов/.test(document.getElementById('messagesList')?.innerText || ''), 20000)
    await wait(1500)
  }

  async function openSettings(tab) {
    const button = document.querySelector('.btn-settings-footer') || document.querySelector('[data-open-settings]')
    const modal = document.getElementById('settingsModal')
    const t0 = performance.now()
    button.click()
    await until(() => getComputedStyle(modal).display !== 'none', 20000)
    const t1 = performance.now()
    await frame()
    timings.settingsOpenMs = Math.round(performance.now() - t0)
    timings.settingsVisibleMs = Math.round(t1 - t0)
    const tabButton = document.querySelector('[data-settings-tab="' + tab + '"]')
    const t2 = performance.now()
    tabButton.click()
    await frame()
    timings.tabSwitchMs = Math.round(performance.now() - t2)
    await wait(500)
  }

  ${body}

  // --- замер ------------------------------------------------------------------
  const ZONES = [
    ['.quote-btn', 'кнопка «Ответить»'],
    ['#settingsModal', 'настройки'],
    ['#modelModal', 'каталог моделей'],
    ['.modal-backdrop', 'окно'],
    ['#permModeMenu', 'меню режима'],
    ['#slashMenu', 'меню команд'],
    ['[role="menu"], .attach-menu, .plus-menu, .dropdown-menu, .context-menu', 'всплывающее меню'],
    ['.tasks-panel', 'панель задач'],
    ['#composerCard, #designComposerCard', 'строка ввода'],
    ['#chatHeader, .design-head', 'шапка'],
    ['#messagesList', 'сообщения'],
    ['#welcomeHero', 'приветствие'],
    ['.sidebar', 'боковая панель'],
    ['#projectsView', 'Projects'], ['#skillsView', 'Skills'],
    ['#designView', 'Design'], ['#connectorsView', 'MCP'],
    ['body', 'прочее']
  ]
  const activeTab = document.querySelector('.settings-nav-item.active, .settings-nav-item[aria-selected="true"]')?.dataset.settingsTab
  const zoneOf = el => {
    for (const [sel, name] of ZONES) {
      if (el.closest(sel)) return name === 'настройки' && activeTab ? 'настройки / ' + activeTab : name
    }
    return 'прочее'
  }
  const visible = el => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    let node = el
    while (node && node !== document.body) {
      const st = getComputedStyle(node)
      if (st.display === 'none' || Number(st.opacity) === 0) return false
      node = node.parentElement
    }
    return true
  }
  const px = v => Math.round(parseFloat(v) * 10) / 10
  const first = f => f.split(',')[0].replace(/["']/g, '').trim()
  const accessibleName = el => {
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      // Referenced labels intentionally remain valid when visually hidden in
      // the collapsed sidebar, so read their DOM text rather than innerText.
      .map(id => document.getElementById(id)?.textContent || '').join(' ').trim()
    const labels = [...(el.labels || [])].map(label => label.innerText || '').join(' ').trim()
    return (el.getAttribute('aria-label') || labelledBy || labels || el.innerText || el.value ||
      el.getAttribute('placeholder') || el.getAttribute('title') || '').trim()
  }
  const out = { texts: [], icons: [], controls: [], radii: [], shadows: [], titles: [], glyphs: [], emoji: [] }
  const GLYPH = /[\\u2190-\\u21FF\\u2300-\\u23FF\\u25A0-\\u25FF\\u2600-\\u26FF\\u2700-\\u27BF\\u00D7\\u2022\\u2026\\u00B7]/
  const EMOJI = /\\p{Extended_Pictographic}/u

  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'g'].includes(el.tagName)) continue
    if (el.closest('svg')) continue
    if (!visible(el)) continue
    const zone = zoneOf(el)
    const s = getComputedStyle(el)
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\\s+/g, ' ').trim()
    if (own) {
      out.texts.push({ zone, tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60),
        family: first(s.fontFamily), size: px(s.fontSize), weight: s.fontWeight, lh: s.lineHeight === 'normal' ? 'normal' : px(s.lineHeight),
        ls: s.letterSpacing, tt: s.textTransform, color: s.color, sample: own.slice(0, 40) })
      if (GLYPH.test(own)) out.glyphs.push({ zone, text: own.slice(0, 60), family: first(s.fontFamily), size: px(s.fontSize) })
      if (EMOJI.test(own)) out.emoji.push({ zone, text: own.slice(0, 60), family: s.fontFamily.slice(0, 120), size: px(s.fontSize) })
    }
    if (el.matches('button, input, select, textarea, [role="button"], [role="tab"], a.btn, .btn')) {
      const r = el.getBoundingClientRect()
      out.controls.push({ zone, tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60),
        h: Math.round(r.height), radius: s.borderTopLeftRadius, bg: s.backgroundColor, border: s.borderTopWidth + ' ' + s.borderTopColor,
        size: px(s.fontSize), weight: s.fontWeight, label: accessibleName(el).slice(0, 60) })
    }
    const radius = s.borderTopLeftRadius
    if (radius !== '0px' && (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.borderTopWidth !== '0px')) {
      out.radii.push({ zone, radius, cls: String(el.className || '').slice(0, 40) })
    }
    if (s.boxShadow && s.boxShadow !== 'none') out.shadows.push({ zone, shadow: s.boxShadow.slice(0, 120), cls: String(el.className || '').slice(0, 40) })
    if (el.hasAttribute('title') && el.getAttribute('title').trim()) out.titles.push({ zone, title: el.getAttribute('title').slice(0, 60), tag: el.tagName.toLowerCase() })
  }
  for (const svg of document.querySelectorAll('svg')) {
    if (svg.parentElement?.closest('svg') || !visible(svg)) continue
    const r = svg.getBoundingClientRect()
    const s = getComputedStyle(svg)
    const shape = svg.querySelector('path, circle, rect, line, polyline')
    const ss = shape ? getComputedStyle(shape) : s
    out.icons.push({ zone: zoneOf(svg), w: Math.round(r.width), h: Math.round(r.height),
      stroke: ss.strokeWidth, fill: ss.fill === 'none' ? 'нет' : 'есть', color: s.color,
      cls: String(svg.getAttribute('class') || '').slice(0, 40), parent: String(svg.parentElement?.className || '').slice(0, 40) })
  }
  const documentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  const horizontalOverflow = documentWidth > innerWidth + 1
  const unnamedControls = out.controls.filter(control => !control.label)
  const sidebarNav = [...document.querySelectorAll('.sidebar-nav .nav-item')].map(el => ({
    id: el.id, label: accessibleName(el)
  }))
  const namedSidebarNav = sidebarNav.filter(item => item.label)
  const accessible = unnamedControls.length === 0 && namedSidebarNav.length === sidebarNav.length
  return { ok: !horizontalOverflow && accessible, checks: [
    { name: 'аудит снят', pass: true },
    { name: 'нет горизонтального переполнения', pass: !horizontalOverflow, actual: documentWidth, expected: innerWidth },
    { name: 'у видимых элементов управления есть доступное имя', pass: unnamedControls.length === 0, actual: unnamedControls.length, expected: 0 },
    { name: 'все пункты навигации сайдбара имеют осмысленную подпись', pass: namedSidebarNav.length === sidebarNav.length,
      actual: namedSidebarNav.length + '/' + sidebarNav.length, expected: sidebarNav.length + '/' + sidebarNav.length }
  ], metrics: out, timings,
    layout: { documentWidth, bodyWidth: document.body.scrollWidth, viewportWidth: innerWidth, horizontalOverflow,
      unnamedControls: unnamedControls.map(control => ({ tag: control.tag, cls: control.cls })), sidebarNav },
    viewport: [innerWidth, innerHeight] }
})()`

const raw = {}
const names = Object.keys(STATES).filter(name => !only || only.includes(name))
for (const name of names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-audit-'))
  // Копия настоящего профиля — чтобы замерить отклик на накопленных данных.
  // Серверы MCP из копии убираются: окно не должно ничего запускать.
  if (process.env.AUDIT_COPY_PROFILE) {
    const appData = path.join(process.env.APPDATA, '1code')
    fs.copyFileSync(path.join(appData, 'Local State'), path.join(dir, 'Local State'))
    const settings = JSON.parse(fs.readFileSync(path.join(appData, '1code-settings.json'), 'utf8'))
    delete settings.mcpServers
    fs.writeFileSync(path.join(dir, '1code-settings.json'), JSON.stringify(settings))
  }
  const script = path.join(dir, 'renderer.js')
  fs.writeFileSync(script, renderer(STATES[name]))
  const result = path.join(dir, 'result.json')
  const started = Date.now()
  spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + dir], {
    cwd: root, stdio: 'ignore', timeout: 120000,
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_SHOT: path.join(shots, name + '.png'),
      ONECODE_SMOKE_FIXTURE: path.join(here, 'fixture.json') })
  })
  const seconds = Math.round((Date.now() - started) / 1000)
  if (fs.existsSync(result)) {
    const verdict = JSON.parse(fs.readFileSync(result, 'utf8'))
    raw[name] = verdict.error ? { error: verdict.error } : { metrics: verdict.metrics, timings: verdict.timings, layout: verdict.layout, checks: verdict.checks, viewport: verdict.viewport }
    const m = verdict.metrics || {}
    console.log(name.padEnd(20), seconds + ' с', verdict.error ? 'ОШИБКА ' + verdict.error :
      `текстов ${m.texts?.length} · значков ${m.icons?.length} · кнопок ${m.controls?.length} · title ${m.titles?.length}` +
      (verdict.layout?.horizontalOverflow ? ' · ГОРИЗОНТАЛЬНОЕ ПЕРЕПОЛНЕНИЕ' : ' · без переполнения') +
      (verdict.timings && Object.keys(verdict.timings).length ? ' · ' + JSON.stringify(verdict.timings) : ''))
  } else {
    raw[name] = { error: 'окно не отчиталось' }
    console.log(name.padEnd(20), seconds + ' с', 'окно не отчиталось')
  }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}
const file = path.join(outDir, only ? 'raw-partial.json' : 'raw.json')
fs.writeFileSync(file, JSON.stringify(raw, null, 1))
console.log('записано: ' + file)
