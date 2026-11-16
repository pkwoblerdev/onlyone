'use strict'
// Сквозной оконный прогон: инструмент -> событие -> карточка -> принятие ->
// перезапуск. Настоящее приложение, настоящее хранилище переписок, настоящий
// инструмент `propose_linked_chat` (fixture.toolStream зовёт executeTool, а не
// подделывает событие).
//
// Три запуска на одном временном профиле:
//   1) ход с предложением, карточка, принятие — дочерний чат и статус на диске;
//   2) засев ожидающего и отклонённого предложений прямо в хранилище;
//   3) перезапуск: карточки собраны из прочитанной переписки, принятая открывает
//      дочерний чат, отклонённая не возвращается.
//
// Улики: ONECODE_EVIDENCE_DIR (форма D:/…), иначе каталог прогона.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun, acquireWindowLock } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-fork-proposal-restart')
const profile = path.join(out, 'profile')
fs.mkdirSync(profile, { recursive: true })
const evidence = process.env.ONECODE_EVIDENCE_DIR
const report = []
const shots = []

const line = (name, pass, detail = '') => {
  report.push({ name, pass: Boolean(pass), detail: String(detail == null ? '' : detail).slice(0, 400) })
  console.log(`  ${pass ? 'ok ' : 'ПРОВАЛ'} ${name}${detail ? ' — ' + detail : ''}`)
}

acquireWindowLock()

function launch (name, script, fixture) {
  const scriptFile = path.join(out, name + '.smoke.js')
  const outFile = path.join(out, name + '.json')
  const shot = path.join(out, name + '.png')
  fs.writeFileSync(scriptFile, script)
  shots.push(shot)
  const extra = { ONECODE_SMOKE: scriptFile, ONECODE_SMOKE_OUT: outFile, ONECODE_SHOT: shot }
  if (fixture) {
    const fixtureFile = path.join(out, name + '.fixture.json')
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2))
    extra.ONECODE_SMOKE_FIXTURE = fixtureFile
  }
  const child = spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile],
    { cwd: root, timeout: 240000, stdio: 'inherit', env: guiEnv(extra) })
  if (child.error) throw child.error
  if (!fs.existsSync(outFile)) return { ok: false, checks: [], error: 'окно не отчиталось, статус ' + child.status }
  return JSON.parse(fs.readFileSync(outFile, 'utf8'))
}

const PRELUDE = `
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: String(detail == null ? '' : detail).slice(0, 400) })
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms = 60000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(120) }
    return false
  }
  const $ = id => document.getElementById(id)
  const feed = () => String($('messagesList')?.textContent || '')
  const cards = () => [...document.querySelectorAll('#messagesList .fork-proposal-card')]
  const hash = value => {
    const text = String(value)
    let result = 0x811c9dc5
    for (let index = 0; index < text.length; index++) {
      result ^= text.charCodeAt(index)
      result = Math.imul(result, 0x01000193) >>> 0
    }
    return result.toString(16).padStart(8, '0')
  }
`

const ROUND_ONE = `(async () => {${PRELUDE}
  await until(() => document.documentElement.dataset.appReady === '1', 45000)
  $('newChatBtn')?.click()
  await wait(400)
  const box = $('composerTextarea')
  box.value = 'Предложи вынести эту тему отдельно'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm').requestSubmit()
  note('карточка пришла из настоящего инструмента', await until(() => cards().length > 0, 90000), feed().slice(-240))
  note('в карточке цель и причина', /Связанная задача/.test(feed()) && /Отдельная тема/.test(feed()), feed().slice(-240))
  note('ход закончился до принятия', await until(() => !document.querySelector('.btn-send.is-stop'), 90000))
  const before = await window.electronAPI.getConversations()
  const parent = before.find(chat => (chat.forkProposals || []).some(record => record.status === 'pending'))
  note('предложение сохранено до принятия', Boolean(parent),
    JSON.stringify(before.map(chat => ({ id: chat.id, ledger: (chat.forkProposals || []).map(record => record.status) }))))
  const accept = cards()[0]?.querySelector('[data-action="accept"]')
  note('у ожидающей карточки есть кнопка создания', Boolean(accept))
  accept?.click()
  // Приложение открывает дочерний чат, поэтому карточка уходит из видимой ленты.
  // Ждём записи на диск, затем возвращаемся в родителя: так проверяется и то,
  // что узел не потерялся при смене чата.
  let after = null
  const deadline = Date.now() + 40000
  while (Date.now() < deadline) {
    after = await window.electronAPI.getConversations()
    const created = after.find(chat => chat.fork?.proposalOperationId)
    const record = (after.find(chat => chat.id === parent?.id)?.forkProposals || [])
      .some(item => item.status === 'accepted' && item.childChatId === created?.id)
    if (created && record) break
    await wait(200)
  }
  const child = after.find(chat => chat.fork?.proposalOperationId)
  const parentAfter = after.find(chat => chat.id === parent?.id)
  note('дочерний чат записан на диск', Boolean(child))
  const parentRow = [...document.querySelectorAll('#chatHistoryList .history-item-title')]
    .find(element => element.textContent.trim() === parent?.title)
  parentRow?.click()
  note('лента родителя открывается снова', await until(() => $('messagesList')?.dataset.chatId === parent?.id, 20000))
  note('принятая карточка осталась в ленте родителя',
    await until(() => cards().some(card => card.classList.contains('is-created') || card.dataset.forkProposalStatus === 'accepted'), 20000),
    cards().map(card => card.dataset.forkProposalId + ':' + card.dataset.forkProposalStatus).join(', '))
  note('принятая карточка в сеансе открывает дочерний чат', cards().some(card => {
    const button = card.querySelector('[data-action="accept"]')
    return button && button.textContent === 'Открыть связанный чат' && !button.disabled
  }), cards().map(card => card.querySelector('[data-action="accept"]')?.textContent).join(', '))
  note('дочерний чат ровно один и связан с родителем',
    after.filter(chat => chat.fork?.proposalOperationId).length === 1 && child?.fork?.parentChatId === parent?.id,
    JSON.stringify(child?.fork || null))
  note('запись предложения стала accepted с id ребёнка',
    (parentAfter?.forkProposals || []).some(record => record.status === 'accepted' && record.childChatId === child?.id),
    JSON.stringify(parentAfter?.forkProposals || null))
  note('чат ребёнка сохранён на диск', child?.messages?.length > 0, String(child?.messages?.length))
  return { ok: checks.every(item => item.pass), checks, parentId: parent?.id, parentTitle: parent?.title, childId: child?.id }
})().catch(error => ({ ok: false, checks: [], error: String(error?.stack || error) }))`

const ROUND_SEED = `(async () => {${PRELUDE}
  await until(() => document.documentElement.dataset.appReady === '1', 45000)
  const list = await window.electronAPI.getConversations()
  const parent = list.find(chat => (chat.forkProposals || []).some(record => record.status === 'accepted'))
  if (!parent) return { ok: false, checks: [{ name: 'родитель с принятым предложением найден', pass: false }] }
  const end = 0
  const revision = 'h:' + hash(JSON.stringify(parent.messages.slice(0, end + 1)))
  const now = Date.now()
  const base = {
    version: 1, parentChatId: parent.id, title: 'Отложенная задача', goal: 'Проверить восстановление',
    reason: '', context: { mode: 'messages', end, revision, summary: '' },
    createdAt: now, updatedAt: now, status: 'pending', childChatId: null, decidedAt: null
  }
  parent.forkProposals = [
    ...(parent.forkProposals || []).filter(record => record.operationId !== 'fp_pending01' && record.operationId !== 'fp_rejected1'),
    { ...base, operationId: 'fp_pending01' },
    { ...base, operationId: 'fp_rejected1', title: 'Отклонённая задача', status: 'rejected', decidedAt: now }
  ]
  await window.electronAPI.setConversations(list)
  const written = (await window.electronAPI.getConversations()).find(chat => chat.id === parent.id)
  const statuses = (written?.forkProposals || []).map(record => record.operationId + ':' + record.status)
  return { ok: statuses.includes('fp_pending01:pending') && statuses.includes('fp_rejected1:rejected'),
    checks: [{ name: 'ожидающее и отклонённое предложения записаны в хранилище', pass: statuses.includes('fp_pending01:pending') && statuses.includes('fp_rejected1:rejected'), detail: statuses.join(', ') }],
    parentId: parent.id, parentTitle: parent.title }
})().catch(error => ({ ok: false, checks: [], error: String(error?.stack || error) }))`

const ROUND_TWO = `(async () => {${PRELUDE}
  await until(() => document.documentElement.dataset.appReady === '1', 45000)
  await wait(500)
  const list = await window.electronAPI.getConversations()
  const parent = list.find(chat => (chat.forkProposals || []).some(record => record.status === 'accepted'))
  const acceptedRecord = parent?.forkProposals?.find(record => record.status === 'accepted')
  note('переписка прочитана из хранилища после перезапуска', Boolean(parent && acceptedRecord?.childChatId),
    JSON.stringify(parent?.forkProposals?.map(record => record.operationId + ':' + record.status) || null))
  const title = [...document.querySelectorAll('#chatHistoryList .history-item-title')]
    .find(element => element.textContent.trim() === parent?.title)
  note('родитель есть в списке чатов', Boolean(title), parent?.title)
  title?.click()
  note('лента родителя отрисована', await until(() => $('messagesList')?.dataset.chatId === parent?.id, 20000))
  note('карточка принятого восстановлена', await until(() => cards().some(card => card.dataset.forkProposalStatus === 'accepted'), 20000),
    cards().map(card => card.dataset.forkProposalId + ':' + card.dataset.forkProposalStatus).join(', '))
  note('карточка ожидающего восстановлена', cards().some(card => card.dataset.forkProposalId === 'fp_pending01'))
  note('отклонённое предложение не вернулось', !cards().some(card => card.dataset.forkProposalId === 'fp_rejected1'))
  const acceptedCard = cards().find(card => card.dataset.forkProposalStatus === 'accepted')
  const open = acceptedCard?.querySelector('[data-action="accept"]')
  note('у принятой карточки кнопка «Открыть связанный чат»', open?.textContent === 'Открыть связанный чат', open?.textContent)
  open?.click()
  const opened = await until(() => $('messagesList')?.dataset.chatId === acceptedRecord?.childChatId, 20000)
  note('принятая карточка открыла существующий дочерний чат', opened,
    opened ? '' : String($('messagesList')?.dataset.chatId) + ' != ' + String(acceptedRecord?.childChatId))
  const child = (await window.electronAPI.getConversations()).find(chat => chat.id === acceptedRecord?.childChatId)
  note('дочерний чат пережил перезапуск', Boolean(child && child.fork?.parentChatId === parent?.id), JSON.stringify(child?.fork || null))
  // Итоговый кадр — на родителе: проверка выше уводила в дочерний чат.
  const backRow = [...document.querySelectorAll('#chatHistoryList .history-item-title')]
    .find(element => element.textContent.trim() === parent?.title)
  backRow?.click()
  note('возврат в родителя для кадра', await until(() => $('messagesList')?.dataset.chatId === parent?.id, 20000))
  return { ok: checks.every(item => item.pass), checks }
})().catch(error => ({ ok: false, checks: [], error: String(error?.stack || error) }))`

function collect (name, result, screenshot) {
  for (const check of result.checks || []) line(name + ' · ' + check.name, check.pass, check.detail)
  if (result.error) line(name + ' · окно отчиталось об ошибке', false, result.error)
  if (!result.checks?.length && !result.error) line(name + ' · проверок нет', false)
  if (screenshot && fs.existsSync(screenshot)) shots.push(screenshot)
}

try {
  const first = launch('round-1-propose-accept', ROUND_ONE, {
    content: 'Тему стоит вынести отдельно. Предлагаю связанный чат.',
    toolStream: {
      tool: 'propose_linked_chat',
      args: {
        title: 'Связанная задача',
        goal: 'Продолжить работу в отдельном чате',
        reason: 'Отдельная тема',
        context: { mode: 'messages', end: 0 }
      }
    }
  })
  collect('1', first, path.join(out, 'round-1-propose-accept.png'))
  if (!first.ok) throw new Error('первый запуск не прошёл: ' + (first.error || 'см. проверки'))

  const seed = launch('round-2-seed', ROUND_SEED)
  collect('2', seed)
  if (!seed.ok) throw new Error('засев не прошёл: ' + (seed.error || 'см. проверки'))

  const second = launch('round-3-restart', ROUND_TWO)
  collect('3', second, path.join(out, 'round-3-restart.png'))

  const failed = report.filter(item => !item.pass)
  console.log(`предложения связанного чата после перезапуска — проверок ${report.length}, не прошло ${failed.length}`)
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true })
    const summary = path.join(out, 'checks.json')
    fs.writeFileSync(summary, JSON.stringify(report, null, 2))
    for (const file of [summary, ...shots]) {
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, path.basename(file)))
    }
  }
  settleRun(out, failed.length === 0)
  process.exit(failed.length ? 1 : 0)
} catch (error) {
  console.error(error)
  if (evidence) {
    try {
      fs.mkdirSync(evidence, { recursive: true })
      fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify(report, null, 2))
      for (const file of shots) if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, path.basename(file)))
    } catch {}
  }
  settleRun(out, false)
  process.exit(1)
}
