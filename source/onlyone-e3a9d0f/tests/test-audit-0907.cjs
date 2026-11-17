const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
// Код окна теперь разложен по модулям (план, 2d) — проверяем весь исполняемый текст.
const renderer = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
function cut(source, from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a)
  assert(a >= 0 && b > a, `Missing function: ${from}`)
  return source.slice(a, b)
}
const normalize = new Function(cut(renderer, '  const PLAN_STATUS =', '  function openProjectEditor(') + ';return normalizePlanSteps')()
assert.deepEqual(normalize({ bad: true }), [])
assert.deepEqual(normalize([null, [], 1]), [])
const malformed = { id: 'a', title: '<img src=x>', status: 'todo" onclick="bad()', dependsOn: 'broken' }
assert.equal(normalize([malformed])[0].status, 'todo')
assert.deepEqual(normalize([malformed])[0].dependsOn, [])
assert.equal(malformed.status, 'todo" onclick="bad()', 'normalization must not mutate stored data')
const blockElement = new Function('document', 'normalizePlanSteps', 'PLAN_STATUS', 'escapeHtml',
  cut(renderer, '  function blockElement(', '  // Incremental:') + ';return blockElement'
)({ createElement: () => ({}) }, normalize, { todo: 'ждёт' }, value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'))
assert(!blockElement({ kind: 'plan', text: JSON.stringify([malformed]) }).innerHTML.includes('onclick='))
assert(blockElement({ kind: 'plan', text: '{}' }).innerHTML.includes('0 / 0'))

async function run() {
  let click, copied, selector
  const copyButton = { dataset: {}, classList: { add() {}, remove() {} }, querySelector: () => ({}),
    addEventListener: (_, fn) => { click = fn },
    closest: () => ({ querySelector: value => { selector = value; return value.includes(', pre') ? {textContent:'plain pre'} : null } }) }
  // Кнопка копирования (макет 21.10) говорит «Код скопирован»; провал — только уведомление-ошибка
  const bind = new Function('navigator', 'setTimeout', 'showToast', 't',
    cut(renderer, '  function bindCopyButtons(', '  // Whole seconds,') + ';return bindCopyButtons'
  )({clipboard:{writeText: async text => {copied = text}}}, () => {}, (_text, isError) => { if (isError) assert.fail('copy failed') }, text => text)
  bind({querySelectorAll: () => [copyButton]}); await click()
  assert.equal(copied, 'plain pre', 'raw pre blocks must be copyable without a code child')
  assert(selector.includes(', pre'))
  const pending = new Map()
  const refs = new Function('window', `let activeDesign = {id:'a'}, designRefs = []; function renderDesignRefs() {}
    ${cut(renderer, '  async function refreshDesignRefs()', '  // Адрес приложенного файла')}
    return { refreshDesignRefs, select(id) {activeDesign = id ? {id} : null}, read() {return designRefs} }`
  )({ electronAPI: { designRefs: id => new Promise(resolve => pending.set(id, resolve)) } })
  const first = refs.refreshDesignRefs()
  refs.select('b')
  const second = refs.refreshDesignRefs()
  pending.get('b')({ ok: true, refs: ['B.png'] }); await second
  pending.get('a')({ ok: true, refs: ['A.png'] }); await first
  assert.deepEqual(refs.read(), ['B.png'], 'old refs must not replace the current design')

  let finishRead, writtenTo, touched
  const paste = new Function('window', 'FileReader', 'touchDesignById', `let activeDesign = {id:'a'};
    const showToast = () => {}; const cleanErrorText = e => e.message; const refreshDesignRefs = async () => {};
    ${cut(renderer, '  async function pasteDesignRefs(', '  function renderDesignModelPill(')}
    return { pasteDesignRefs, select(id) {activeDesign = {id}} }`
  )({ electronAPI: { designPasteRef: async id => { writtenTo = id; return {ok:true, refs:[{}]} } } },
    class { readAsDataURL() { finishRead = () => { this.result = 'data:image/png;base64,AA=='; this.onload() } } },
    id => { touched = id })
  const pasting = paste.pasteDesignRefs({ items: [{kind:'file', getAsFile: () => ({name:'a.png'})}] })
  paste.select('b'); finishRead(); await pasting
  assert.equal(writtenTo, 'a', 'switching designs during FileReader must not redirect writes')
  // Приложенный файл поднимает дизайн в списке недавних — и именно тот, в
  // который писали. Взять здесь activeDesign значило бы пометить чужой дизайн,
  // если пользователь переключился, пока файл читался.
  assert.equal(touched, 'a', 'recency must be marked on the design that received the file')

  const dir = path.resolve(__dirname, 'fixture-design')
  let fetched, outside = false, missing = false
  // С шифрованием на диске файл читается fs.readFile и при нужде расшифровывается
  // (не net.fetch); здесь хранилища нет — как на машине без safeStorage.
  const tableOf = name => new Function(cut(main, 'const ' + name + ' = {', '\n}') + '\n}; return ' + name)()
  const serve = new Function('ensureDesignStore', 'join', 'require', 'fs', 'net', 'DESIGN_PICKER', 'safeStorageAvailable', 'unprotectStore',
    'extname', 'IMAGE_MIME', 'DESIGN_FILE_MIME', 'unwrapProtectedBytes',
    cut(main, 'async function serveDesignFile(', '// Runs inside the sandboxed preview frame.') + ';return serveDesignFile'
  )(() => ({folder: () => dir}), path.join, require,
    {realpath: async name => { if (missing) throw Error('ENOENT'); return name === dir ? dir : outside ? path.join(path.dirname(dir), 'secret.txt') : name },
     readFile: async name => { fetched = name; return Buffer.from('hello') }},
    {fetch: async url => { fetched = url; return new Response('hello') }}, '', () => false, text => text,
    path.extname, tableOf('IMAGE_MIME'), tableOf('DESIGN_FILE_MIME'), bytes => bytes)
  assert.equal((await serve({url:'onecode-design://d/bad%ZZ.png'})).status, 400)
  assert.equal((await serve({url:'onecode-design://d/a%23b%3Fc.png'})).status, 200)
  assert(path.basename(fetched) === 'a#b?c.png', 'a name with hash and question mark must be read whole, not cut at # or ?')
  // Макет с отдельными стилями и скриптами: без своего типа браузер их не применит.
  assert.match((await serve({url:'onecode-design://d/site.css'})).headers.get('content-type'), /^text\/css/)
  assert.match((await serve({url:'onecode-design://d/app.js'})).headers.get('content-type'), /^text\/javascript/)
  assert.match((await serve({url:'onecode-design://d/a.png'})).headers.get('content-type'), /^image\/png/)
  outside = true
  assert.equal((await serve({url:'onecode-design://d/link.txt'})).status, 403, 'symlink cannot expose outside files')
  outside = false; missing = true
  assert.equal((await serve({url:'onecode-design://d/missing.png'})).status, 404)
  console.log('Audit 0907: malformed plans, stale refs, paste ownership, preview paths passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
