const assert = require('node:assert/strict')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  // Проверка поднимает по два настоящих окна на каждый случай — восемнадцать
  // за прогон. На занятой машине это ложится в тридцать секунд не всегда, и
  // тест краснел не из-за кода, а из-за загрузки. Лимит здесь только чтобы
  // повисший процесс не остался навсегда.
  const child = spawnSync(require('electron'), [__filename], { stdio: 'inherit', timeout: 180000 })
  if (child.error) throw child.error
  process.exit(child.status ?? 1)
} else {
  const { app, BrowserWindow, session, protocol } = require('electron')
  const { checkDesign } = require('../src/main/design/check')
  protocol.registerSchemesAsPrivileged([{ scheme: 'onecode-design', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
  app.on('window-all-closed', () => {})
  app.whenReady().then(async () => {
    const check = html => checkDesign({ BrowserWindow, session, designId: 'test', path: 'page.html',
      serveFile: () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) })
    assert.equal((await check('<div id="dc-root"><h1>Ready</h1></div>')).passed, true)
    assert.equal((await check('<div id="dc-root"></div>')).passed, false)
    assert.equal((await check('<div id="dc-root" style="display:none"><h1>Hidden</h1></div>')).passed, false)
    assert.equal((await check('<div id="dc-root"><button></button></div>')).passed, false)
    assert.equal((await check('<div id="dc-root"><button aria-label="Continue">→</button><input type="submit" value="Send"></div>')).passed, true)
    assert.equal((await check('<div id="dc-root"><span id="name">Name</span><input aria-labelledby="name"></div>')).passed, true)
    const overflow = await check('<div id="dc-root"><div style="width:2000px">Too wide</div></div>')
    assert.equal(overflow.passed, false)
    assert(overflow.screens.every(s => s.horizontalOverflow))
    const offline = await check('<div id="dc-root"><p>pending</p></div><script>fetch("https://example.com/").then(()=>document.querySelector("p").textContent="NETWORK OPEN").catch(()=>document.querySelector("p").textContent="network blocked")</script>')
    assert(offline.screens.every(s => s.textSample === 'network blocked'))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(checkDesign({ signal: controller.signal }), /отменена/)
    console.log(JSON.stringify({ ok: true, checks: ['render', 'empty', 'hidden', 'unnamed control', 'named controls', 'labelledby', 'overflow', 'network blocked', 'cancel'] }))
    app.exit(0)
  }).catch(error => { console.error(error); app.exit(1) })
}
