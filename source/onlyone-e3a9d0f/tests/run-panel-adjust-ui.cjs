// Регулировка панели «Браузер» в настоящем окне: ширина (тянуть за левый край, стрелки, двойной щелчок), масштаб страницы
// (− / % / +, действует на настоящий webview) и память выбора после перезагрузки окна.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-panel-adjust')

async function main () {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Страница</title><h1>Масштаб</h1>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const script = path.join(out, 'renderer.js')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 15000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(100) } return false }
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    const errors = []
    window.addEventListener('error', event => errors.push(String(event.message)))
    const panel = () => $('artifactPanel')
    const widthNow = () => Math.round(panel().getBoundingClientRect().width)
    const pointer = (el, type, x) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: 200, pointerId: 1, button: 0 }))

    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
    await wait(300)
    $('openBrowserBtn').click()
    note('панель браузера открылась', await until(() => !panel().hidden))
    note('у панели есть край для ширины, у браузера — кнопки масштаба', Boolean($('artifactResizer')) && Boolean($('browserZoomOut')) && Boolean($('browserZoomIn')) && Boolean($('browserZoomLevel')))
    note('край доступен с клавиатуры и подписан', $('artifactResizer').tabIndex === 0 && $('artifactResizer').getAttribute('role') === 'separator' && Boolean($('artifactResizer').getAttribute('aria-label')))

    // Ширина: тянем влево — панель шире; тянем вправо — уже; границы держатся.
    const base = widthNow()
    const bar = $('artifactResizer')
    const x0 = Math.round(bar.getBoundingClientRect().left + 2)
    pointer(bar, 'pointerdown', x0)
    pointer(bar, 'pointermove', x0 - 120)
    pointer(bar, 'pointerup', x0 - 120)
    await wait(150)
    note('потянули влево на 120 px — панель шире', widthNow() > base + 80, base + ' → ' + widthNow())
    const wide = widthNow()
    pointer(bar, 'pointerdown', x0 - 120)
    pointer(bar, 'pointermove', x0 + 5000)
    pointer(bar, 'pointerup', x0 + 5000)
    await wait(150)
    note('потянули слишком далеко вправо — панель не уже минимума (320 px)', widthNow() >= 320 && widthNow() < wide, widthNow())
    bar.focus()
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await wait(100)
    const stepped = widthNow()
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await wait(100)
    note('стрелка влево расширяет панель по шагам', widthNow() > stepped, stepped + ' → ' + widthNow())
    note('ширина запомнена', Number(localStorage.getItem('onlyone.artifactWidth')) === widthNow(), localStorage.getItem('onlyone.artifactWidth'))
    bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(150)
    note('двойной щелчок возвращает обычную ширину', Math.abs(widthNow() - base) <= 2 && !localStorage.getItem('onlyone.artifactWidth'), widthNow() + ' vs ' + base)

    // Масштаб на настоящей странице.
    const input = $('browserAddress'); input.focus(); input.value = 'http://127.0.0.1:${port}/'
    $('browserForm').requestSubmit()
    const view = () => [...document.querySelectorAll('#browserViews webview')].find(v => !v.hidden)
    note('страница открылась в webview', await until(() => view() && /127\\.0\\.0\\.1/.test(view().getAttribute('src') || '')))
    // executeJavaScript до dom-ready не отвечает вовсе, поэтому ждём с таймаутом, а не навсегда.
    await until(async () => { try { return /Масштаб/.test(await Promise.race([view().executeJavaScript('document.body.innerText'), new Promise(r => setTimeout(() => r(''), 1500))])) } catch { return false } }, 20000)
    await wait(300)
    note('масштаб по умолчанию 100%', $('browserZoomLevel').textContent === '100%' && Math.abs((await view().getZoomFactor()) - 1) < 0.01, $('browserZoomLevel').textContent)
    $('browserZoomIn').click()
    await wait(200)
    note('«+» увеличивает: 110% и у страницы тот же масштаб', $('browserZoomLevel').textContent === '110%' && Math.abs((await view().getZoomFactor()) - 1.1) < 0.01, $('browserZoomLevel').textContent + ' / ' + (await view().getZoomFactor()))
    $('browserZoomOut').click(); $('browserZoomOut').click()
    await wait(200)
    note('«−» уменьшает: 90%', $('browserZoomLevel').textContent === '90%' && Math.abs((await view().getZoomFactor()) - 0.9) < 0.01, $('browserZoomLevel').textContent)
    note('масштаб запомнен', localStorage.getItem('onlyone.browserZoom') === '0.9', localStorage.getItem('onlyone.browserZoom'))
    $('browserZoomLevel').click()
    await wait(200)
    note('щелчок по проценту возвращает 100%', $('browserZoomLevel').textContent === '100%' && Math.abs((await view().getZoomFactor()) - 1) < 0.01)
    for (let i = 0; i < 12; i++) $('browserZoomIn').click()
    await wait(200)
    note('верхний предел 200%: «+» гаснет', $('browserZoomLevel').textContent === '200%' && $('browserZoomIn').disabled, $('browserZoomLevel').textContent)
    $('browserZoomLevel').click()
    note('ошибок в окне нет', !errors.length, errors.join(' | '))
    return { ok: checks.every(c => c.pass), checks }
  })()`)

  const profile = path.join(out, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  const resultFile = path.join(out, 'result.json')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, stdio: 'inherit',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_SHOT: path.join(out, 'panel.png') })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 170000)
  const code = await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  server.close()
  let ok = false
  if (!fs.existsSync(resultFile)) console.error('Окно не отчиталось (код ' + code + ')')
  else {
    const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    for (const item of report.checks || []) console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    ok = Boolean(report.ok)
  }
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
