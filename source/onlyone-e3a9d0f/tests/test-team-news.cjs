// Новости команды: работающий агент узнаёт, что сдали соседи.
//
// Два агента, идущие одновременно, раньше не узнавали друг о друге до конца
// круга: один находил причину ошибки, другой продолжал искать её же, и оба
// сдавали отчёты, противоречащие друг другу. Здесь проверяется, что сданное и
// письма доходят до агента на следующем шаге — один раз, без повторов, и без
// того, чтобы письмо считалось прочитанным раньше, чем его увидит приёмка.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const board = require('../src/main/agent-board')

const CR = String.fromCharCode(13)
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8').split(CR).join('')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const requestId = 'news-' + Date.now()
board.seedBoard(requestId, [
  { agent: 'Агент 2', task: 'Найти причину обрыва потока', acceptance: 'Причина', readOnly: true },
  { agent: 'Агент 3', task: 'Проверить отмену', acceptance: 'Проверка', readOnly: true }
], ['Агент 1', 'Агент 2', 'Агент 3'])

const seen3 = new Set()

check('в начале хода новостей нет — всё известно из поручения', () => {
  assert.equal(board.teamNews(requestId, 'Агент 3', seen3), '')
})

check('сданная соседом часть приходит с тем, чем она подтверждена', () => {
  board.updateItem(requestId, 'Агент 2', { id: 't1', status: 'done', note: 'Причина: продолжение теряет хвост буфера в parseSse' })
  const news = board.teamNews(requestId, 'Агент 3', seen3)
  assert.match(news, /Новости команды/)
  assert.match(news, /Агент 2, пункт t1: сделано — Причина: продолжение теряет хвост буфера/)
})

check('та же новость второй раз не приходит', () => {
  assert.equal(board.teamNews(requestId, 'Агент 3', seen3), '')
})

check('своя часть новостью не считается', () => {
  const seen2 = new Set()
  const news = board.teamNews(requestId, 'Агент 2', seen2)
  assert.doesNotMatch(news, /пункт t1/)
})

check('застрявшая часть соседа — тоже новость', () => {
  board.updateItem(requestId, 'Агент 3', { id: 't2', status: 'blocked', note: 'Нет доступа к тестовому серверу' })
  const seen2 = new Set()
  assert.match(board.teamNews(requestId, 'Агент 2', seen2), /Агент 3, пункт t2: заблокировано — Нет доступа/)
})

check('вопрос соседа приходит с тем, как ответить', () => {
  const sent = board.postMessage(requestId, 'Агент 2', { to: 'Агент 3', kind: 'question', body: 'Отмена срабатывает до первого куска?' })
  assert.equal(sent.success, true)
  const news = board.teamNews(requestId, 'Агент 3', seen3)
  assert.match(news, /Письмо тебе от Агент 2 \(вопрос\): Отмена срабатывает до первого куска\?/)
  assert.match(news, new RegExp(`replyTo: ${sent.id}`))
})

check('новость не помечает письмо прочитанным — его ещё увидит приёмка', () => {
  const letters = board.boardSnapshot(requestId).messages.filter(m => m.to === 'Агент 3')
  assert(letters.every(m => m.read === false))
})

check('без доски новостей нет', () => {
  assert.equal(board.teamNews('no-board-' + Date.now(), 'Агент 2', new Set()), '')
})

check('цикл агента узнаёт уже известное до первого шага и приносит новое на следующих', () => {
  assert.match(main, /const teamSeen = new Set\(\)\s*if \(agentName\) teamNews\(payload\.requestId, agentName, teamSeen\)/)
  assert.match(main, /if \(step > 0 && agentName\) \{\s*const news = teamNews\(payload\.requestId, agentName, teamSeen\)/)
})

board.clearBoard(requestId)
console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
