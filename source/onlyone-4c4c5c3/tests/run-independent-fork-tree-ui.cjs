'use strict'

// Независимая сквозная проверка дерева связанных чатов (Ф-2) в настоящем окне.
//
// Создаём форк существующим прямым действием (кнопка «Создать форк чата»),
// смотрим настоящее дерево в боковике: родитель и ребёнок, поиск с путём,
// раскрытие/сворачивание с сохранением после перезапуска, переход к родителю,
// удалённый родитель помечен и не уносит ребёнка, двойной щелчок не создаёт
// дубль. Модель не вызывается: сценарный провайдер записывает каждый запрос, и
// журнал обязан остаться пустым.
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const dir = runDir('onlyone-independent-fork-tree')
const profile = path.join(dir, 'profile')
const providerFile = path.join(dir, 'provider.json')
const providerLog = path.join(dir, 'requests.log')
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(providerFile, JSON.stringify({ turns: [{ text: 'Ответ модели, которого быть не должно.' }] }))

const checks = []
function note (name, pass, detail = '') {
  checks.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 400) })
  console.log((pass ? '  ok     ' : '  ПРОВАЛ ') + name + (detail ? ' — ' + String(detail).slice(0, 260) : ''))
}

const seed = [
  { id: 'root', title: 'Root branch', createdAt: 1, updatedAt: 100, messages: [
    { role: 'user', content: 'Fork root question', timestamp: 1 },
    { role: 'assistant', content: 'Fork root answer', timestamp: 2 }
  ] },
  { id: 'mid', title: 'Middle parser', createdAt: 2, updatedAt: 90, fork: { version: 1, kind: 'text-snapshot', parentChatId: 'root' }, messages: [
    { role: 'user', content: 'Parser question', timestamp: 3 },
    { role: 'assistant', content: 'Parser answer', timestamp: 4 }
  ] },
  { id: 'leaf', title: 'Fix parser crash', createdAt: 3, updatedAt: 80, fork: { version: 1, kind: 'text-snapshot', parentChatId: 'mid' }, messages: [
    { role: 'user', content: 'Crash question', timestamp: 5 },
    { role: 'assistant', content: 'Crash answer', timestamp: 6 }
  ] },
  { id: 'other', title: 'Other branch', createdAt: 4, updatedAt: 70, messages: [
    { role: 'user', content: 'Other question', timestamp: 7 },
    { role: 'assistant', content: 'Other answer', timestamp: 8 }
  ] }
]

const PRELUDE = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(100) } return false }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail).slice(0, 400) })
  const chats = () => window.electronAPI.getConversations()
  const row = id => document.querySelector('#forkTreeSection .fork-tree-row[data-chat-id="' + id + '"]')
  const active = () => $('messagesList')?.dataset.chatId || ''
  const openChat = async id => {
    const title = document.querySelector('.history-item[data-chat-id="' + id + '"] .history-item-title')
    if (title) title.click()
    return until(() => active() === id)
  }
`

async function phase (name, body) {
  const script = path.join(dir, name + '.js')
  const resultFile = path.join(dir, name + '.json')
  fs.writeFileSync(script, `(async () => {${PRELUDE}${body}
    note('в окне нет ошибок', !window.__errors?.length, (window.__errors || []).join(' | '))
    return { ok: checks.every(item => item.pass), checks, facts: window.__facts || {} }
  })()`)
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: providerFile, ONECODE_PROVIDER_LOG: providerLog, ONECODE_SHOT: '' })
  })
  let tail = ''
  child.stdout.on('data', data => { tail = (tail + data).slice(-2500) })
  child.stderr.on('data', data => { tail = (tail + data).slice(-2500) })
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      if (process.platform === 'win32') {
        try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }) } catch {}
      }
      resolve('timeout')
    }, 90000)
    child.once('error', () => { clearTimeout(timer); resolve('error') })
    child.once('close', value => { clearTimeout(timer); resolve(value) })
  })
  const report = fs.existsSync(resultFile)
    ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    : { ok: false, checks: [], facts: {}, error: 'окно не отчиталось: ' + tail }
  if (report.error) note(name + ' · окно отчиталось', false, report.error)
  note(name + ' · код выхода 0', code === 0, String(code))
  for (const item of report.checks || []) note(name + ' · ' + item.name, item.pass, item.detail)
  return report.facts || {}
}

;(async () => {
  // Слой первый: связи уже лежат в переписке, как после прежнего запуска.
  const seedFacts = await phase('seed', `
    window.__errors = []
    window.addEventListener('error', event => window.__errors.push(String(event.message)))
    window.addEventListener('unhandledrejection', event => window.__errors.push('promise: ' + String(event.reason?.message || event.reason)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    await window.electronAPI.setConversations(${JSON.stringify(seed)})
    await until(() => document.querySelector('.history-item[data-chat-id="root"]'))
    window.__facts = { seeded: true }
  `)
  note('seed · переписка сохранена', Boolean(seedFacts.seeded))

  // Создание форка прямым действием и двойной щелчок.
  const createFacts = await phase('create', `
    window.__errors = []
    window.addEventListener('error', event => window.__errors.push(String(event.message)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    await until(() => document.querySelector('.history-item[data-chat-id="root"]'))
    await openChat('root')
    await until(() => row('root'))
    const section = $('forkTreeSection')
    note('дерево связано и видно в боковике', section && !section.hidden && section.querySelectorAll('.fork-tree-row').length === 4,
      section ? section.querySelectorAll('.fork-tree-row').length : 'нет секции')
    note('в дереве родитель и ребёнок', Boolean(row('root')) && Boolean(row('mid')) && Boolean(row('leaf')),
      [...document.querySelectorAll('#forkTreeSection .fork-tree-row')].map(item => item.dataset.chatId).join(','))
    note('глубина строк совпадает с веткой', row('root')?.getAttribute('aria-level') === '1' &&
      row('mid')?.getAttribute('aria-level') === '2' && row('leaf')?.getAttribute('aria-level') === '3',
      [row('root'), row('mid'), row('leaf')].map(item => item && item.getAttribute('aria-level')).join(','))
    note('счётчик называет связанные чаты', document.querySelector('#forkTreeSection .fork-tree-count')?.textContent === '3',
      document.querySelector('#forkTreeSection .fork-tree-count')?.textContent)
    const before = await chats()
    const button = $('chatForkBtn')
    note('кнопка форка доступна', Boolean(button) && !button.hidden)
    button.click(); button.click()
    await until(async () => (await chats()).length === before.length + 1, 15000)
    const after = await chats()
    const parent = after.find(item => item.id === 'root')
    const forks = after.filter(item => item.fork && item.fork.parentChatId === 'root')
    const created = forks.find(item => !before.some(old => old.id === item.id))
    note('двойной щелчок создал ровно один форк', Boolean(created) && after.length === before.length + 1,
      JSON.stringify({ before: before.length, after: after.length, rootForks: forks.length }))
    note('родитель не изменился', parent && parent.messages.length === 2, parent && parent.messages.length)
    note('ребёнок унаследовал просьбу родителя', created && created.title === 'Root branch' && created.fork.parentChatId === 'root',
      created && JSON.stringify({ title: created.title, parent: created.fork && created.fork.parentChatId }))
    await wait(900)
    note('новый ребёнок виден в дереве', Boolean(created) && Boolean(row(created.id)),
      created && row(created.id) && row(created.id).getAttribute('aria-level'))

    // Поиск дочернего чата: путь к родителю едет вместе с находкой.
    const search = document.querySelector('#forkTreeSection .fork-tree-search')
    search.value = 'Fix parser'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => document.querySelectorAll('#forkTreeSection .fork-tree-row').length === 1)
    const found = document.querySelectorAll('#forkTreeSection .fork-tree-row')
    note('поиск находит ребёнка', found.length === 1 && found[0].dataset.chatId === 'leaf',
      [...found].map(item => item.dataset.chatId).join(','))
    note('поиск показывает путь к родителю', found[0]?.querySelector('.fork-tree-path')?.textContent === 'Root branch / Middle parser',
      found[0]?.querySelector('.fork-tree-path')?.textContent)
    search.value = ''
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => document.querySelectorAll('#forkTreeSection .fork-tree-row').length === 5)

    // Раскрытие — настройка отображения.
    const caret = row('root')?.querySelector('.fork-tree-caret')
    note('у родителя есть кнопка раскрытия', Boolean(caret))
    caret.click()
    await until(() => !row('mid'))
    note('свёрнутая ветка прячет детей', !row('mid') && !row('leaf'), [...document.querySelectorAll('#forkTreeSection .fork-tree-row')].map(item => item.dataset.chatId).join(','))
    const collapsed = localStorage.getItem('1code_fork_tree_collapsed') || ''
    note('свёрнутость записана в настройку отображения', collapsed.includes('root'), collapsed)
    window.__facts = { createdId: created ? created.id : '', collapsed }
  `)
  note('create · форк создан прямым действием', Boolean(createFacts.createdId), createFacts.createdId)

  // Перезапуск: раскрытие и связи переживают закрытие окна.
  await phase('restart', `
    window.__errors = []
    window.addEventListener('error', event => window.__errors.push(String(event.message)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    await until(() => row('root'))
    note('после перезапуска ветка осталась свёрнутой', row('root')?.getAttribute('aria-expanded') === 'false' && !row('mid'),
      JSON.stringify({ expanded: row('root')?.getAttribute('aria-expanded'), mid: Boolean(row('mid')) }))
    row('root').querySelector('.fork-tree-caret').click()
    await until(() => row('mid') && row('leaf'))
    note('раскрытие после перезапуска возвращает детей', Boolean(row('mid')) && Boolean(row('leaf')) && Boolean(row(${JSON.stringify(createFacts.createdId) || 'null'})))

    // Переход к родителю из строки ребёнка.
    row('leaf').querySelector('.fork-tree-title').click()
    await until(() => active() === 'leaf')
    note('щелчок по строке открывает чат', active() === 'leaf', active())
    row('leaf').querySelector('.fork-tree-parent').click()
    await until(() => active() === 'mid')
    note('переход к родителю работает', active() === 'mid', active())
    row('mid').querySelector('.fork-tree-parent').click()
    await until(() => active() === 'root')
    note('переход на два уровня вверх работает', active() === 'root', active())

    // Удалённый родитель: ребёнок остаётся, связь помечена, переход недоступен.
    const before = await chats()
    await window.electronAPI.setConversations(before.filter(item => item.id !== 'root'))
    const after = await chats()
    note('удаление родителя не удаляет ребёнка', after.some(item => item.id === 'mid') && after.some(item => item.id === 'leaf') &&
      after.some(item => item.id === 'other'), after.map(item => item.id).join(','))

    // Двойной щелчок по строке — один переход и ни одного нового чата.
    const count = (await chats()).length
    row('leaf').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    row('leaf').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
    await wait(500)
    note('двойной щелчок по строке не создаёт дубль', (await chats()).length === count, count + ' → ' + (await chats()).length)
    note('двойной щелчок открывает чат один раз', active() === 'leaf', active())
  `)

  // Последний перезапуск: удаление и потерянный родитель не исчезли с диска.
  await phase('persist', `
    window.__errors = []
    window.addEventListener('error', event => window.__errors.push(String(event.message)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    await until(() => row('mid'))
    const list = await chats()
    note('после перезапуска ребёнок и родительская связь на месте',
      list.some(item => item.id === 'mid') && list.some(item => item.id === 'leaf') && !list.some(item => item.id === 'root'),
      list.map(item => item.id).join(','))
    note('после перезапуска метка удалённого родителя видна',
      row('mid')?.querySelector('.fork-tree-badge')?.textContent === 'родитель удалён',
      row('mid')?.querySelector('.fork-tree-badge')?.textContent)
    note('после перезапуска переход к удалённому родителю недоступен',
      row('mid')?.querySelector('.fork-tree-parent')?.disabled === true,
      row('mid')?.querySelector('.fork-tree-parent')?.disabled)
    await openChat('leaf')
    note('ребёнок открывается после перезапуска', active() === 'leaf', active())
  `)

  const providerCalls = fs.existsSync(providerLog)
    ? fs.readFileSync(providerLog, 'utf8').split('\n').filter(Boolean).length
    : 0
  note('модель не вызывалась ни разу', providerCalls === 0, 'запросов: ' + providerCalls)

  const failed = checks.filter(item => !item.pass)
  console.log('')
  if (failed.length) console.error(`ПРОВАЛ: ${failed.length} из ${checks.length}`)
  else console.log(`Дерево форков: ${checks.length} проверок, провалов 0`)
  settleRun(dir, failed.length === 0)
  process.exitCode = failed.length ? 1 : 0
})().catch(error => {
  console.error('харнесс упал: ' + (error && error.stack || error))
  settleRun(dir, false)
  process.exitCode = 2
})
