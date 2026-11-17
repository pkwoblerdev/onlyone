// break-3 Н1+Н2: переименование артефакта и гонка двух показов панели.
//
// Н1: keydown с {once:true} съедался первым набранным символом — Escape/Enter
// умирали, следующий blur отправлял имя в хранилище против воли человека.
// Н2: два showArtifact без счётчика последовательности — шапка и версия от
// последнего начатого показа, текст от того, кто ответил позже.
//
// Стенд: настоящий artifact-panel.js (require), DOM из tests/fixtures/dom-stand.cjs,
// подменные electronAPI/fetch. Отрицательные контроли: Escape без ввода отменяет;
// порядок завершений fetch совпал — текст верный; правка без переключения открывается.

const assert = require('node:assert/strict')
const path = require('node:path')
const { makeDom, autoDom } = require('./fixtures/dom-stand.cjs')
const panel = require(path.join(__dirname, '..', 'src', 'renderer', 'artifact-panel.js'))

let failed = 0
let total = 0
async function check (name, fn) {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message))
  }
}

const tick = ms => new Promise(resolve => setTimeout(resolve, ms))

function makeStand ({ fetchDelayByVersion = {}, artifacts = [] } = {}) {
  const dom = makeDom()
  const { $ } = autoDom(dom)
  const renames = []
  const saves = []
  let menuItems = null
  const t = (s, ...args) => String(s).replace(/%s/g, () => String(args.shift()))
  const electronAPI = {
    getArtifacts: async () => ({ artifacts }),
    renameArtifact: async payload => { renames.push(payload); return { artifact: artifacts.find(a => a.id === payload.id) } },
    saveArtifactVersion: async payload => { saves.push(payload); return { ok: true } },
    onArtifactChanged: () => {},
    revealArtifact: () => {},
    archiveArtifact: () => {},
    exportArtifact: async () => ({ ok: true })
  }
  const realFetch = async url => {
    const m = /\/(v\d+)\.txt$/.exec(String(url))
    const version = m ? Number(m[1].slice(1)) : 0
    const delay = fetchDelayByVersion[version] || 0
    if (delay) await tick(delay)
    return { ok: true, text: async () => (version === 1 ? 'ВЕРСИЯ-ОДИН' : 'ВЕРСИЯ-ДВА') }
  }
  global.fetch = realFetch
  const api = panel.create({
    $, t, escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    enhanceSelect: () => {}, openContextMenu: (x, y, items) => { menuItems = items },
    askConfirm: async () => true, electronAPI, document: dom.document,
    getChatId: () => 'chat1'
  })
  api.bind()
  return { dom, $, api, renames, saves, getMenu: () => menuItems }
}

function makeArtifact () {
  return {
    id: 'a1', chatId: 'chat1', kind: 'code', title: 'Артефакт', current: 2, fileName: 'code.txt',
    versions: [
      { n: 1, file: 'v1.txt', chars: 12, at: 1700000000000 },
      { n: 2, file: 'v2.txt', chars: 9, at: 1700000001000 }
    ]
  }
}

async function startRename (stand) {
  stand.$('artifactMore').click()
  const item = (stand.getMenu() || []).find(i => i.label === 'Переименовать артефакт')
  assert.ok(item, 'пункт «Переименовать артефакт» есть в меню')
  item.onPick()
}

async function main () {
  // Н1: ввод символа, затем Escape — отмена, имя НЕ уходит в хранилище.
  await check('Н1: Escape после ввода отменяет переименование', async () => {
    const artifact = makeArtifact()
    const stand = makeStand({ artifacts: [artifact] })
    await stand.api.showArtifact(artifact)
    await startRename(stand)
    const title = stand.$('artifactTitle')
    assert.equal(title.isContentEditable, true, 'заголовок редактируется')
    title.textContent = 'Новое имя'
    stand.dom.fire(title, 'keydown', { key: 'a' })
    const ev = stand.dom.fire(title, 'keydown', { key: 'Escape' })
    title.blur()
    await tick(10)
    assert.equal(ev.defaultPrevented, true, 'Escape перехвачен (слушатель жив после ввода)')
    assert.equal(stand.renames.length, 0, 'renameArtifact не вызван: ' + JSON.stringify(stand.renames))
    assert.equal(title.isContentEditable, false, 'редактирование закрыто')
    assert.equal(title.textContent, 'Артефакт', 'прежнее имя на месте')
  })

  // Отрицательный контроль: без ввода Escape отменяет (работало и до правки).
  await check('Н1 контроль: Escape без ввода отменяет', async () => {
    const artifact = makeArtifact()
    const stand = makeStand({ artifacts: [artifact] })
    await stand.api.showArtifact(artifact)
    await startRename(stand)
    const title = stand.$('artifactTitle')
    const ev = stand.dom.fire(title, 'keydown', { key: 'Escape' })
    title.blur()
    await tick(10)
    assert.equal(ev.defaultPrevented, true)
    assert.equal(stand.renames.length, 0)
    assert.equal(title.isContentEditable, false)
  })

  // Н1: Enter после ввода подтверждает ровно один раз (и последующий blur не дублирует).
  await check('Н1: Enter после ввода подтверждает один раз', async () => {
    const artifact = makeArtifact()
    const stand = makeStand({ artifacts: [artifact] })
    await stand.api.showArtifact(artifact)
    await startRename(stand)
    const title = stand.$('artifactTitle')
    title.textContent = 'Новое имя'
    stand.dom.fire(title, 'keydown', { key: 'x' })
    const ev = stand.dom.fire(title, 'keydown', { key: 'Enter' })
    assert.equal(ev.defaultPrevented, true, 'Enter перехвачен после ввода')
    await tick(10)
    assert.equal(stand.renames.length, 1, 'ровно один вызов renameArtifact')
    assert.equal(stand.renames[0].title, 'Новое имя')
    title.blur()
    await tick(10)
    assert.equal(stand.renames.length, 1, 'blur после Enter не дублирует')
  })

  await check('IME Enter не завершает переименование', async () => {
    const artifact = makeArtifact()
    const stand = makeStand({ artifacts: [artifact] })
    await stand.api.showArtifact(artifact)
    await startRename(stand)
    const title = stand.$('artifactTitle')
    title.textContent = '新しい名前'
    stand.dom.fire(title, 'keydown', { key: 'Enter', isComposing: true })
    await tick(10)
    assert.equal(stand.renames.length, 0)
    assert.equal(title.isContentEditable, true)
  })

  await check('таймаут отменяет запрос артефакта', async () => {
    const artifact = makeArtifact()
    const stand = makeStand({ artifacts: [artifact] })
    const originalTimer = global.setTimeout
    let signal
    global.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === 8000 ? 5 : ms, ...args)
    global.fetch = (_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
    try {
      await stand.api.showArtifact(artifact)
      assert.ok(signal && signal.aborted)
    } finally { global.setTimeout = originalTimer }
  })

  // Н2: медленная v1 + быстрая v2 — шапка v2, текст обязан быть v2.
  await check('Н2: поздний ответ прежнего показа не перетирает содержимое', async () => {
    const artifact = makeArtifact()
    const stand = makeStand({ artifacts: [artifact], fetchDelayByVersion: { 1: 60, 2: 5 } })
    const p1 = stand.api.showArtifact(artifact, 1)
    const p2 = stand.api.showArtifact(artifact, 2)
    await Promise.all([p1, p2])
    await tick(120)
    const meta = stand.$('artifactMeta').textContent
    assert.ok(meta.includes('версия 2 из 2'), 'шапка от последнего показа: ' + meta)
    assert.equal(stand.$('artifactText').textContent, 'ВЕРСИЯ-ДВА',
      'текст обязан быть от версии 2, получено: ' + stand.$('artifactText').textContent)
  })

  // Отрицательный контроль: порядок завершений совпал — текст верный и до правки.
  await check('Н2 контроль: быстрый v1 + медленный v2 — текст v2', async () => {
    const artifact = makeArtifact()
    const stand = makeStand({ artifacts: [artifact], fetchDelayByVersion: { 1: 5, 2: 60 } })
    const p1 = stand.api.showArtifact(artifact, 1)
    const p2 = stand.api.showArtifact(artifact, 2)
    await Promise.all([p1, p2])
    await tick(120)
    assert.equal(stand.$('artifactText').textContent, 'ВЕРСИЯ-ДВА')
  })

  // Н2 (путь к порче): правка открыта на медленном чтении, показ переключился —
  // редактор не открывается с чужим содержимым (save ушёл бы в новый артефакт).
  await check('Н2: правка не открывается с содержимым прежнего показа', async () => {
    const artifact = makeArtifact()
    const stand = makeStand({ artifacts: [artifact], fetchDelayByVersion: { 1: 60, 2: 5 } })
    await stand.api.showArtifact(artifact, 1)
    stand.$('artifactVersion').value = '1'
    stand.$('artifactEdit').click() // editArtifact: медленное чтение v1
    await stand.api.showArtifact(artifact, 2) // переключение до ответа
    await tick(120)
    assert.equal(stand.$('artifactEditor').hidden, true,
      'редактор не открылся с телом v1 поверх показа v2')
  })

  // Контроль: правка без переключения открывается со своим содержимым.
  await check('Н2 контроль: правка без переключения открывается', async () => {
    const artifact = makeArtifact()
    const stand = makeStand({ artifacts: [artifact], fetchDelayByVersion: { 1: 5 } })
    await stand.api.showArtifact(artifact, 1)
    stand.$('artifactVersion').value = '1'
    stand.$('artifactEdit').click()
    await tick(40)
    assert.equal(stand.$('artifactEditor').hidden, false, 'редактор открыт')
    assert.equal(stand.$('artifactEditor').value, 'ВЕРСИЯ-ОДИН')
  })

  console.log(`\n${total - failed}/${total} ok`)
  if (failed) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })