'use strict'
// Предложение связанного чата: точки подключения в общих файлах. Модель и
// карточка проверяются отдельно (test-fork-proposal.cjs, run-fork-proposal-ui.cjs);
// здесь — что инструмент объявлен и вызывается, событие доходит до окна, карточка
// возвращается после перерисовки ленты и создание не запускает модель.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8')
const main = read('src/main/main.js')
const app = read('src/renderer/app.js')
const preload = read('src/preload/preload.js')
const html = read('src/renderer/index.html')
const i18n = read('src/renderer/i18n.js')

assert.match(main, /require\('\.\/fork-proposal-tool\.cjs'\)/, 'main.js не подключает инструмент предложения')
assert.match(main, /\n  FORK_PROPOSAL_TOOL,\n/, 'схема инструмента не попала в TOOL_DEFINITIONS')
assert.match(main, /name === 'propose_linked_chat'\) return await createForkProposalTool\(\{ sendToWindow \}\)/,
  'вызов propose_linked_chat не доходит до транспорта')
assert.doesNotMatch(main, /DESIGN_TOOL_NAMES[\s\S]{0,200}propose_linked_chat/,
  'инструмент не должен входить в изолированный набор Дизайна')

assert.match(preload, /onForkProposal: callback =>/, 'preload не отдаёт onForkProposal')
assert.match(preload, /ipcRenderer\.on\('fork-proposal'/, 'preload не слушает канал fork-proposal')

assert.match(app, /onForkProposal\?\.\(payload => \{/, 'окно не слушает предложение')
assert.match(app, /const forkProposalCards = new Map\(\)/, 'нет карты карточек предложений')
assert.match(app, /forkProposalCards\.set\(key, \{ chatId: source\.id, card \}\)/, 'карточка не запоминается для перерисовки')
assert.match(app, /for \(const pending of forkProposalCards\.values\(\)\) \{[\s\S]{0,200}OnlyoneForkProposal\.placeCard\(pane\.dom\.list, pending\.card\)/,
  'карточка не возвращается после перерисовки ленты к своему сообщению')
assert.match(app, /for \(const node of list\.querySelectorAll\('\[data-fork-proposal-summary\]'\)\) node\.remove\(\)/,
  'сводная карточка не снимается перед пересборкой')
assert.match(app, /if \(!summary\.ok \|\| summary\.pending \+ summary\.created === 0\) \{/,
  'сводка не исчезает у чата без предложений')
assert.match(app, /OnlyoneForkProposal\.summaryOf\(source, conversations, OnlyoneForkProposalStore, running\)/,
  'сводка не читает опись')
assert.match(app, /onOpenChild: record => \{ if \(record\?\.chatId\) selectChat\(pane, record\.chatId\) \}/,
  'строка сводки не открывает созданный чат через selectChat')
assert.match(app, /forkProposalCards\.set\(key, \{ chatId: source\.id, card \}\)[\s\S]{0,60}refreshForkProposalSummary\(pane\)/,
  'сводка не обновляется после живого предложения')
assert.match(app, /if \(!source\.forkProposals && !Array\.isArray\(source\.forkProposalDismissed\)\) return/,
  'нечитаемая не-массивная опись должна доходить до предупреждения, а не молчать')
assert.match(app, /if \(!conversations\.some\(chat => chat\.id === record\.childChatId\)\) \{[\s\S]{0,120}showToast\(t\('Связанный чат удалён\.'\)/,
  'удалённый ребёнок не должен открывать пустую ленту с обещанием успеха')
assert.match(app, /onRun: item => runForkProposal\(item, source, pane\)/, 'карточка не передаёт явный запуск')
assert.ok(app.includes('selectChat(target, child.id)') && app.includes('await handleSendMessage(target, goal)'),
  'запуск не идёт существующим путём отправки')
assert.match(app, /onReturn: item => returnForkProposal\(item, source, pane\)/, 'карточка не передаёт возврат итога')
assert.match(app, /restoreForkReturns\(pane\)/, 'сохранённый итог не восстанавливается')
assert.match(read('src/renderer/fork-proposal-restore.js'), /onReturn:/, 'восстановленная карточка не умеет вернуть итог')
assert.match(html, /fork-return.js/, 'модуль возврата не подключён')
assert.match(read('src/renderer/fork-proposal.js'), /return placeCard\(container, card\)/,
  'карточка не ставится помощником к сообщению-границе')
assert.match(app, /OnlyoneForkProposal\.accept\(item, \{[\s\S]{0,200}forkApi: OnlyoneChatForks/,
  'принятие не создаёт чат тем же механизмом форка')
assert.doesNotMatch(app.slice(app.indexOf('onForkProposal?.('), app.indexOf('onAgentApproval(request => {')),
  /sendMessage|handleSendMessage|streamAgentStep/, 'создание связанного чата не должно запускать модель')

const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1])
assert.ok(scripts.indexOf('chat-forks.js') >= 0, 'chat-forks.js не подключён')
assert.equal(scripts.indexOf('fork-proposal.js'), scripts.indexOf('chat-forks.js') + 1,
  'fork-proposal.js должен идти сразу после chat-forks.js')
assert.ok(scripts.indexOf('fork-proposal.js') < scripts.indexOf('app.js'), 'app.js должен загружаться после модуля')
assert.match(html, /href="fork-proposal\.css"/, 'стили карточки не подключены')

for (const key of ['Создать связанный чат', 'Предложение связанного чата', 'Связанный чат создан. Модель не запускалась.']) {
  assert.ok(i18n.includes(key), 'в словаре нет строки: ' + key)
}

assert.match(read('src/main/run-checkpoints.js'), /'propose_linked_chat'/, 'инструмент должен быть в читающем классе контрольных точек')
assert.match(read('src/main/agent-quality.js'), /'propose_linked_chat'/, 'помощник с доступом только на чтение должен уметь предложить')
assert.match(read('src/main/mode-prompts/tools.js'), /propose_linked_chat:/, 'подсказка режима не знает инструмент')

console.log('PASS fork proposal wiring: tool, event, card redraw, no model start, assets and dictionaries')
