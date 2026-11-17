// Стенд окна Desk: настоящие desk.js + desk-transfer.js + ultra-blocks.js,
// подменные DOM и deskAPI. Разметка — из настоящего desk.html. Приём перенесён
// из ломающего разбора break-3 (desk-stand.cjs): модули исполняются без Electron.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { makeDom } = require('./dom-stand.cjs')
const ROOT = path.join(__dirname, '..', '..')
const R = f => path.join(ROOT, 'src/renderer', f)

function loadDesk (options = {}) {
  const dom = makeDom()
  // Настоящая разметка окна: берём body из desk.html (без <script>), чтобы все
  // id и вложенные span/button существовали, как в живом окне.
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/desk.html'), 'utf8')
  const bodyMarkup = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'))
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  dom.document.body.innerHTML = bodyMarkup
  // Запасной путь: если модуль спросит id, которого нет в разметке.
  const orig = dom.document.getElementById.bind(dom.document)
  const $ = id => {
    const found = orig(id)
    if (found) return found
    const el = dom.createElement('div')
    el.id = id
    dom.document.body.appendChild(el)
    return el
  }
  dom.document.getElementById = $
  const calls = { apply: [], hold: [], release: 0, state: [], guest: [], stopWatch: [], stopProcess: [], main: 0 }
  const listeners = {}
  let revision = 1
  const blocks = options.blocks || [
    { id: 'b1', kind: 'browser', title: 'Сайт', revision: 1, rect: { x: 16, y: 16, width: 400, height: 300, z: 1 } },
    { id: 'b2', kind: 'artifact', title: 'Инструмент', revision: 1, rect: { x: 432, y: 16, width: 400, height: 300, z: 2 } }
  ]
  const resources = options.resources || { b1: { type: 'browser', url: 'https://example.com' }, b2: { type: 'text', text: 'итог' } }
  const flags = { failWatches: false, failState: false, holdOk: true, applyResult: { ok: true }, failRead: false }
  const snapshot = () => ({ revision, title: 'Desk', blocks: blocks.map(b => ({ ...b })) })
  const api = {
    read: async () => { if (flags.failRead) throw new Error('ipc down'); return { ok: true, persistent: true, snapshot: snapshot(), runtime: {}, resources, agent: null, budget: null, settings: { language: 'ru', theme: 'dark' } } },
    apply: async cmd => { calls.apply.push(cmd); if (cmd.operations.some(o => o.type === 'remove')) { for (const op of cmd.operations) { const i = blocks.findIndex(b => b.id === op.id); if (i >= 0) blocks.splice(i, 1) } revision++ } return flags.applyResult },
    hold: async id => { calls.hold.push(id); return { ok: flags.holdOk } },
    release: async () => { calls.release++; return { ok: true } },
    state: async r => { calls.state.push(r); if (flags.failState) throw new Error('ipc down'); return { ok: true } },
    guest: async r => { calls.guest.push(r); return { ok: true } },
    watches: async () => flags.failWatches ? { ok: false } : { ok: true, watches: [], recent: [] },
    processes: async () => ({ ok: true, processes: [] }),
    stopWatch: async id => { calls.stopWatch.push(id); return { ok: true } },
    stopProcess: async id => { calls.stopProcess.push(id); return { ok: true } },
    main: async () => { calls.main++; return { ok: true } },
    pause: async () => ({ ok: true }), stopBuild: async () => ({ ok: true }),
    exportTemplate: async () => ({ ok: true, text: '{"desk":1}' }),
    legacyTemplate: async () => ({ ok: true, text: '{"desk":1}' }),
    previewTemplate: async () => ({ ok: true, preview: { title: 'Чужая', blocks: [] } }),
    importTemplate: async () => ({ ok: true, count: 0 }),
    copyTemplate: async () => ({ ok: true }),
    modsPanels: async () => ({ ok: true, mods: [] }),
    modAction: async () => ({ ok: true }),
    fit: async () => ({ ok: true }), activate: async () => ({ ok: true }),
    onChanged: fn => { listeners.changed = fn; return () => {} },
    onProcessesChanged: fn => { listeners.processes = fn; return () => {} },
    onModsChanged: fn => { listeners.mods = fn; return () => {} }
  }
  const win = {
    deskAPI: api, __I18N__: { en: {} },
    matchMedia: () => ({ matches: false }),
    addEventListener: (t, f) => { (listeners['win:' + t] = listeners['win:' + t] || []).push(f) },
    removeEventListener: () => {},
    innerWidth: 1400, innerHeight: 900,
    OnlyoneUltraBlocks: require(R('ultra-blocks.js'))
  }
  win.window = win
  const dialog = $('desk-transfer-dialog')
  dialog.open = false
  dialog.showModal = () => { dialog.open = true }
  dialog.close = () => { dialog.open = false; dom.fire(dialog, 'close') }
  const spark = dom.createElement('div'); spark.className = 'desk-spark'; dom.document.body.appendChild(spark)
  const ctx = {
    window: win, document: dom.document,
    navigator: { clipboard: { writeText: async () => {} } },
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
    CSS: { escape: s => String(s).replace(/["\\]/g, '\\$&') },
    ResizeObserver: class { observe () {} unobserve () {} disconnect () {} },
    requestAnimationFrame: fn => setTimeout(fn, 0),
    innerWidth: 1400, innerHeight: 900
  }
  const run = (file, extra = {}) => {
    let src = fs.readFileSync(R(file), 'utf8')
    // Отладка стенда: показываем, что проглотил catch (поведение не меняется).
    if (options.debug) src = src.replace(/catch\s*\{/g, "catch (e) { if (window.__dbg) console.log('CATCH', e && e.stack || e);")
    const keys = Object.keys({ ...ctx, ...extra })
    const vals = keys.map(k => ({ ...ctx, ...extra })[k])
    // eslint-disable-next-line no-new-func
    new Function(...keys, src)(...vals)
  }
  win.__dbg = Boolean(options.debug)
  run('desk-transfer.js')
  win.OnlyoneDeskTransfer = win.OnlyoneDeskTransfer // присваивается внутри модуля
  run('desk.js')
  return { dom, $, api, calls, listeners, flags, blocks, resources, win, ctx, snapshot }
}

module.exports = { loadDesk }