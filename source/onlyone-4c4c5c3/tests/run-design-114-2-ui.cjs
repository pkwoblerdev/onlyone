'use strict'
// Значки вне панели в настоящем окне (план, 1.14 часть 2).
//
// Меряется то, чего не видно по исходнику: в каких единицах нарисована линия и
// в каком поле. Атрибут `stroke-width="1.5"` в поле 24, показанном в 16 px,
// рисует 1.0 px — именно из-за этого владелец и видел «толщину 1.2–1.8». После
// переноса на эталонное поле 16 линия обязана быть 1.5 единицами на каждом
// экране, где есть значки, в обоих языках.
//
// Размер показа меряется отдельно и с потолком: icon.small показывает знак в
// 12 px, а ряд по карточке Icons — 14/16/20. Менять размер владелец в этом
// пункте не просил, поэтому долг посчитан и не имеет права расти.
//
// Отрицательный контроль: квадрат «стоп» во время хода обязан остаться
// залитым — если правка сняла с него заливку, проверка это поймает.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-design-114-2')
const evidence = process.env.ONECODE_EVIDENCE_DIR
  || path.join(root, 'audits', 'qoder-2-2026-09-29', 'design-114-2')
const profile = path.join(out, 'profile')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(profile, { recursive: true })

function makeProfile(lang) {
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    language: lang,
    openrouterKeys: [{ id: 'k', name: 'Тест', keyEncrypted: 'Q1RFU1Qt', modelId: 'z-ai/glm-5.2:free', enabled: true }],
    defaultModel: 'z-ai/glm-5.2:free',
    activeProvider: 'openrouter',
    legacyStoragePurged: true,
    workspace: { path: workspace, permission: 'acceptEdits' }
  }))
  return profile
}

const notes = []
function claim(name, pass, detail) {
  notes.push({ name, pass: Boolean(pass), detail: String(detail === undefined ? '' : detail) })
  console.log((pass ? '  ok  ' : 'ПРОВАЛ ') + 'диск · ' + name + (detail ? ` — ${detail}` : ''))
}

function launch(name, body, opts = {}) {
  const script = path.join(out, `${name}.js`)
  const resultFile = path.join(out, `${name}.json`)
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
    // Линия мерится в единицах viewBox (эталон — 1.5 в поле 16), размер — в
    // пикселях показа: 14/16/20 по карточке Icons. Чужой размер (например
    // icon.small = 12 px) делает ту же эталонную линию тоньше на экране,
    // поэтому считается отдельно и имеет потолок.
    const measure = root => [...(root || document).querySelectorAll('svg[class*="icon"]')]
      .filter(svg => svg.getBoundingClientRect().width > 0)
      .map(svg => {
        const box = svg.getBoundingClientRect()
        const field = Number((/viewBox="[^"]*\\s([\\d.]+)\\s/.exec(svg.getAttribute('viewBox') || '') || [])[1] || 16)
        const unit = parseFloat(getComputedStyle(svg).strokeWidth) || 0
        return {
          field, unit: Math.round(unit * 100) / 100, shown: Math.round(box.width),
          cls: svg.getAttribute('class') || '', id: (svg.closest('[id]') || {}).id || ''
        }
      })
    const offUnits = list => list.filter(one => one.unit < 1.4 || one.unit > 1.6)
      .map(one => one.cls + '#' + one.id + '=' + one.unit)
    const offField = list => list.filter(one => one.field !== 16).map(one => one.cls)
    const offSizes = list => list.filter(one => [14, 16, 20].every(size => Math.abs(one.shown - size) > 0.6))
      .map(one => one.shown + 'px:' + one.cls)
${body}
    note('ошибок в окне нет', !errors.length, errors.join(' | ') || 'нет')
    return { ok: checks.every(item => item.pass), checks }
  })()`)

  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 300000, stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: script,
      ONECODE_SMOKE_OUT: resultFile,
      ONECODE_E2E: opts.e2e ? '1' : undefined,
      ONECODE_PROVIDER_FILE: opts.provider,
      ONECODE_SHOT: path.join(out, `${name}.png`)
    })
  })
  if (!fs.existsSync(resultFile)) {
    console.error(`ПРОВАЛ ${name}: окно не отчиталось (status ${child.status})`)
    return { ok: false, checks: [], name }
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (report.error) console.error(`окно упало ${name}: ${report.error}`)
  for (const one of report.checks || []) {
    console.log((one.pass ? '  ok  ' : 'ПРОВАЛ ') + `${name} · ${one.label}` + (one.detail ? ` — ${one.detail.slice(0, 200)}` : ''))
  }
  report.name = name
  return report
}

// Экран, который человек видит первым: панель, лента, строка ввода. Потом
// открываем панель «Работа» и настройки — там свои значки.
const screens = `
  const side = measure(document.querySelector('.sidebar') || document)
  note('панель: линия 1.5 единиц и поле 16',
    offUnits(side).length === 0 && offField(side).length === 0,
    (offUnits(side).slice(0, 5).join(' | ') || 'единицы верны') + ' · поле: ' + (offField(side).slice(0, 5).join(' | ') || 'везде 16'))
  const chatIcons = measure($('messagesList'))
  note('в ленте значки в поле 16', offField(chatIcons).length === 0, offField(chatIcons).slice(0, 6).join(' | ') || 'лента пуста или вся в поле 16')
  $('openSettingsBtn')?.click(); await wait(800)
  $('tab-keys')?.click(); await wait(600)
  const settings = measure($('panel-keys'))
  note('в настройках нет значка вне поля 16', offField(settings).length === 0, offField(settings).slice(0, 8).join(' | '))
  note('в настройках линия эталонная', offUnits(settings).length === 0, offUnits(settings).slice(0, 8).join(' | '))
  const all = measure(document.body)
  note('на экране остались только поименованные исключения из поля 16',
    offField(all).length <= 8, offField(all).slice(0, 10).join(' | '))
  // Долг по размерам: класс icon.small показывает тот же знак в 12 px — вне
  // ряда 14/16/20. Эталонная линия при этом выглядит тоньше. Правку размера
  // владелец не заказывал, поэтому здесь только потолок: больше не должно.
  const sizes = offSizes(all)
  note('размеров вне ряда 14/16/20 не больше потолка',
    sizes.length <= 60, sizes.length + ' шт · ' + sizes.slice(0, 6).join(' | '))
  document.querySelector('[data-close="settingsModal"]')?.click()
  await wait(400)
`

const ru = launch('screens-ru', screens)
makeProfile('en')
const en = launch('screens-en', screens)

// Отрицательный контроль залитого знака: во время хода квадрат «стоп» обязан
// быть виден заливкой, а не контуром.
makeProfile('ru')
const provider = path.join(out, 'provider.json')
fs.writeFileSync(provider, JSON.stringify({ turns: [{ text: 'Иду по плану.', delayMs: 4000 }, { text: 'Готово.' }] }))
const stop = launch('stop-filled', `
  const box = $('composerTextarea')
  box.value = 'Проверка залитого знака'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(200)
  $('composerForm').requestSubmit()
  await until(() => $('sendBtn')?.classList.contains('is-stop'), 20000)
  await wait(300)
  const stopIcon = $('sendBtn').querySelector('.stop-icon')
  const visible = stopIcon && stopIcon.getBoundingClientRect().width > 0
  const fill = stopIcon ? getComputedStyle(stopIcon.querySelector('rect') || stopIcon).fill : ''
  note('квадрат «стоп» показан во время хода', Boolean(visible), fill)
  note('он залит, а не обведён', fill && fill !== 'none', String(fill))
  await until(() => !$('sendBtn')?.classList.contains('is-stop'), 60000)
`, { e2e: true, provider })

const reports = [ru, en, stop]
const failed = notes.filter(one => !one.pass)
  .concat(reports.flatMap(one => (one.checks || []).filter(check => !check.pass)))

for (const name of ['screens-ru', 'screens-en', 'stop-filled']) {
  const shot = path.join(out, `${name}.png`)
  if (fs.existsSync(shot)) {
    fs.mkdirSync(evidence, { recursive: true })
    fs.copyFileSync(shot, path.join(evidence, `${name}.png`))
  }
}

const ok = failed.length === 0
settleRun(out, ok)
console.log(JSON.stringify({ ok, checks: notes.length + reports.reduce((n, one) => n + (one.checks || []).length, 0), failed: failed.length }))
process.exitCode = ok ? 0 : 1
