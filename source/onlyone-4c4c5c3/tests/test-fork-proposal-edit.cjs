'use strict'
// Правка ожидающего предложения до создания: устойчивый id операции,
// пересчёт ревизии по текущей истории, отказы без мутации описи, встроенная
// форма карточки и тот же путь инструмента, которым пользуется мод или навык.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const model = require('../src/renderer/fork-proposal.js')
const store = require('../src/renderer/fork-proposal-store.js')
const contextApi = require('../src/renderer/fork-proposal-context.js')

const messages = [
  { role: 'user', content: 'First question', timestamp: 1 },
  { role: 'assistant', content: 'First answer', timestamp: 2 },
  { role: 'user', content: 'Second question', timestamp: 3 }
]
const proposal = model.normalize({
  title: 'Parser subtask',
  goal: 'Fix the parser',
  reason: 'Separate area',
  context: { mode: 'messages', end: 0 }
}, { parentChatId: 'parent', messages, now: 100 })
const id = proposal.operationId

// ── Store.update: правка до создания ──────────────────────────────────────
assert.equal(store.LIMITS.maxProposals, 20)
assert.equal(store.LIMITS.maxPending, 5)

const chat = { id: 'parent', messages }
assert.equal(store.put(chat, proposal, { now: 200 }).ok, true)
const edited = store.update(chat, id, {
  title: '  Parser and lexer  ',
  goal: 'Fix the parser and the lexer',
  reason: '',
  context: { mode: 'messages', end: 1 }
}, { now: 300 })
assert.equal(edited.ok, true)
assert.equal(edited.record.operationId, id, 'editing keeps the operation id')
assert.equal(edited.record.parentChatId, 'parent', 'editing keeps the parent')
assert.equal(edited.record.createdAt, 200, 'creation time survives the edit')
assert.equal(edited.record.updatedAt, 300)
assert.equal(edited.record.title, 'Parser and lexer', 'title is trimmed')
assert.equal(edited.record.goal, 'Fix the parser and the lexer')
assert.equal(edited.record.reason, '')
assert.equal(edited.record.status, 'pending')
assert.equal(edited.record.context.end, 1)
assert.notEqual(edited.record.context.revision, proposal.context.revision, 'a new boundary is a new revision')
assert.equal(edited.record.context.revision, contextApi.revisionOf(messages, 1), 'revision recomputed like fork-proposal.js')
assert.equal(store.get(chat, id).context.revision, contextApi.revisionOf(messages, 1))
assert.equal(store.read(chat).skipped, 0)

// Ревизию даёт магазин, а не вызывающий.
const supplied = store.update(chat, id, { context: { mode: 'messages', end: 1, revision: 'h:00000000' } }, { now: 400 })
assert.equal(supplied.ok, true)
assert.notEqual(supplied.record.context.revision, 'h:00000000', 'caller-supplied revision is ignored')
assert.equal(supplied.record.context.revision, contextApi.revisionOf(messages, 1))

// Потолки текста те же, что у записи; время без `now` не берётся с часов.
const capped = store.update(chat, id, { title: 'x'.repeat(300), goal: 'g'.repeat(5000), reason: 'r'.repeat(2000) })
assert.equal(capped.record.title.length, 200)
assert.equal(capped.record.goal.length, 4000)
assert.equal(capped.record.reason.length, 1000)
assert.equal(capped.record.updatedAt, 400, 'time only comes from the argument')

// Чужие поля патча не меняют личность записи.
const stubborn = store.update(chat, id, { operationId: 'fp_other001', parentChatId: 'other', createdAt: 1, status: 'accepted' })
assert.equal(stubborn.record.operationId, id)
assert.equal(stubborn.record.parentChatId, 'parent')
assert.equal(stubborn.record.createdAt, 200)
assert.equal(stubborn.record.status, 'pending')

// Некорректная граница и пустой текст: отказ без единого байта изменений.
const beforeBad = JSON.stringify(chat)
assert.deepEqual(store.update(chat, id, { context: { mode: 'messages', end: messages.length } }), { ok: false, reason: 'invalid-context' })
assert.equal(store.update(chat, id, { context: { mode: 'messages', end: null } }).reason, 'invalid-context')
assert.equal(store.update(chat, id, { context: { mode: 'messages', end: -1 } }).reason, 'invalid-context')
assert.equal(store.update(chat, id, { context: { mode: 'messages', end: '1' } }).reason, 'invalid-context')
assert.equal(store.update(chat, id, { context: { mode: 'summary', end: 1, summary: '   ' } }).reason, 'invalid-context')
assert.equal(store.update(chat, id, { context: { mode: 'weird', end: 0 } }).reason, 'invalid-context')
assert.equal(store.update(chat, id, { title: '   ' }).reason, 'invalid-patch')
assert.equal(store.update(chat, id, null).reason, 'invalid-patch')
assert.equal(store.update(chat, 'fp_absent0', { title: 'x' }).reason, 'not-found')
assert.equal(store.update(chat, 'bad id', { title: 'x' }).reason, 'invalid-operation-id')
assert.equal(JSON.stringify(chat), beforeBad, 'refused edits leave the ledger byte-identical')

// Выжимка: без границы ревизии нет, с границей — считается по ней.
const summaryChat = { id: 'parent', messages }
const summaryProposal = model.normalize({
  title: 'Summary task',
  goal: 'Continue parser work',
  context: { mode: 'summary', summary: 'Old summary' }
}, { parentChatId: 'parent', messages, now: 500 })
store.put(summaryChat, summaryProposal, { now: 500 })
const summaryEdit = store.update(summaryChat, summaryProposal.operationId, { context: { mode: 'summary', end: 2, summary: 'New summary' } }, { now: 600 })
assert.equal(summaryEdit.ok, true)
assert.equal(summaryEdit.record.context.summary, 'New summary')
assert.equal(summaryEdit.record.context.revision, contextApi.revisionOf(messages, 2))
const noBoundary = store.update(summaryChat, summaryProposal.operationId, { context: { mode: 'summary', end: null } })
assert.equal(noBoundary.ok, true)
assert.equal(noBoundary.record.context.revision, '', 'summary without a boundary has nothing to check')
assert.equal(noBoundary.record.context.summary, 'New summary', 'an untouched summary field survives')

const switched = store.update(chat, id, { context: { mode: 'summary', end: 2, summary: 'Only the summary' } })
assert.equal(switched.ok, true)
assert.equal(switched.record.context.mode, 'summary')
assert.equal(switched.record.context.summary, 'Only the summary')
assert.equal(switched.record.context.revision, contextApi.revisionOf(messages, 2))

// Принятое и отклонённое не правятся.
const decided = { id: 'parent', messages }
store.put(decided, proposal, { now: 10 })
store.setStatus(decided, id, 'accepted', { childChatId: 'child-1', now: 20 })
const acceptedBefore = JSON.stringify(decided)
assert.deepEqual(store.update(decided, id, { title: 'Late' }), { ok: false, reason: 'not-allowed' })
assert.equal(JSON.stringify(decided), acceptedBefore, 'an accepted proposal cannot be edited')

const rejectedChat = { id: 'parent', messages }
store.put(rejectedChat, proposal, { now: 10 })
store.setStatus(rejectedChat, id, 'rejected', { now: 20 })
const rejectedBefore = JSON.stringify(rejectedChat)
assert.equal(store.update(rejectedChat, id, { title: 'Late' }).reason, 'not-allowed')
assert.equal(JSON.stringify(rejectedChat), rejectedBefore, 'a rejected proposal cannot be edited')

// Нечитаемая опись не перезаписывается правкой.
const corrupt = { id: 'parent', messages }
store.put(corrupt, proposal, { now: 1 })
corrupt.forkProposals[0].version = 2
const corruptBefore = JSON.stringify(corrupt)
assert.equal(store.update(corrupt, id, { title: 'Nope' }).ok, false)
assert.equal(store.update(corrupt, id, { title: 'Nope' }).reason, 'unknown-version')
assert.equal(JSON.stringify(corrupt), corruptBefore, 'an unknown ledger stays byte-identical')
const brokenShape = { id: 'parent', messages, forkProposals: 'nope' }
assert.equal(store.update(brokenShape, id, { title: 'Nope' }).reason, 'invalid-shape')

// ── Карточка: встроенная правка ожидающего предложения ────────────────────
// Маленький DOM-двойник: только то, что зовёт mountCard, плюс click().
function fakeDom () {
  const document = {
    activeElement: null,
    createElement (tag) { return new Element(String(tag).toLowerCase(), document) }
  }
  function Element (tag, doc) {
    this.tagName = tag.toUpperCase()
    this.ownerDocument = doc
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.dataset = {}
    this.className = ''
    this._text = ''
    this._classes = new Set()
    this._listeners = {}
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.type = ''
    this.maxLength = 0
    this.rows = 0
    this.min = 0
    this.step = 1
    const owner = this
    this.classList = {
      add (...names) { names.forEach(name => owner._classes.add(name)) },
      remove (...names) { names.forEach(name => owner._classes.delete(name)) },
      contains (name) { return owner._classes.has(name) }
    }
  }
  Element.prototype = {
    get textContent () { return this._text + this.children.map(child => child.textContent).join('') },
    set textContent (value) {
      this._text = String(value == null ? '' : value)
      this.children.forEach(child => { child.parentNode = null })
      this.children = []
    },
    appendChild (child) { child.parentNode = this; this.children.push(child); return child },
    append (...nodes) { nodes.forEach(node => this.appendChild(node)) },
    removeChild (child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      child.parentNode = null
    },
    remove () { if (this.parentNode) this.parentNode.removeChild(this) },
    setAttribute (name, value) { this.attributes.set(name, String(value)) },
    getAttribute (name) { return this.attributes.has(name) ? this.attributes.get(name) : null },
    addEventListener (type, handler) { (this._listeners[type] = this._listeners[type] || []).push(handler) },
    dispatch (type) {
      const event = { type, target: this, preventDefault () {} }
      for (const handler of this._listeners[type] || []) handler(event)
    },
    click () { this.dispatch('click') },
    focus () { this.ownerDocument.activeElement = this },
    matches (selector) {
      const attr = /^\[([a-z-]+)(?:="(.*)")?\]$/.exec(selector)
      if (attr) {
        const key = attr[1]
        if (key.startsWith('data-')) {
          const camel = key.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())
          const value = this.dataset[camel]
          return value !== undefined && (attr[2] === undefined || String(value) === attr[2])
        }
        const value = this.attributes.get(key)
        return value !== undefined && (attr[2] === undefined || value === attr[2])
      }
      if (selector.startsWith('.')) {
        const name = selector.slice(1)
        return this._classes.has(name) || this.className.split(/\s+/).includes(name)
      }
      return this.tagName === selector.toUpperCase()
    },
    querySelectorAll (selector) {
      const found = []
      const walk = node => {
        for (const child of node.children) {
          if (child.matches(selector)) found.push(child)
          walk(child)
        }
      }
      walk(this)
      return found
    },
    querySelector (selector) { return this.querySelectorAll(selector)[0] || null }
  }
  return document
}

const flush = () => new Promise(resolve => setTimeout(resolve, 5))

function recordFor (source, now = 100) {
  return {
    version: 1,
    operationId: 'fp_1a2b3c4d',
    parentChatId: source.id,
    title: 'Parser subtask',
    goal: 'Fix the parser',
    reason: 'Separate area',
    context: { mode: 'messages', end: 1, revision: contextApi.revisionOf(source.messages, 1), summary: '' },
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    childChatId: null,
    decidedAt: null
  }
}

;(async () => {
  const doc = fakeDom()
  const source = { id: 'parent', messages }
  const container = doc.createElement('div')
  const record = recordFor(source)
  const calls = []
  let answer = { saved: true, record: { ...record, title: 'Parser and lexer', context: { ...record.context } } }
  const card = model.mountCard(container, record, {
    t: text => text,
    parentTitle: 'Parent chat',
    onEdit: async item => { calls.push(item); return answer },
    onAccept: async () => ({ saved: true, chat: { id: 'child-1' } }),
    onReject: async () => ({ saved: true })
  })
  const editButton = card.querySelector('[data-action="edit"]')
  const saveButton = card.querySelector('[data-action="save-edit"]')
  const cancelButton = card.querySelector('[data-action="cancel-edit"]')
  const titleNode = card.querySelector('.fork-proposal-title')
  const goalNode = card.querySelector('.fork-proposal-goal')
  const reasonNode = card.querySelector('.fork-proposal-reason')
  const statusLine = card.querySelector('.fork-proposal-status')
  const titleInput = card.querySelector('.fork-proposal-input-title')
  const boundaryInput = card.querySelector('.fork-proposal-input-end')

  assert.ok(editButton && !editButton.hidden, 'a pending card offers editing')
  assert.equal(editButton.textContent, 'Изменить')
  assert.equal(titleNode.textContent, 'Parser subtask')
  assert.equal(card.querySelector('.fork-proposal-edit').hidden, true, 'the form starts closed')

  editButton.click()
  const form = card.querySelector('.fork-proposal-edit')
  assert.equal(form.hidden, false, 'edit opens inline fields')
  assert.equal(editButton.hidden, true)
  assert.equal(titleInput.value, 'Parser subtask', 'title is prefilled')
  assert.equal(card.querySelector('.fork-proposal-goal-input').value, 'Fix the parser')
  assert.equal(reasonNode.textContent, 'Separate area')
  assert.equal(boundaryInput.value, '2', 'boundary is shown one-based')

  titleInput.value = 'Parser and lexer'
  saveButton.click()
  await flush()
  assert.equal(calls.length, 1, 'save calls the edit handler once')
  assert.equal(calls[0].operationId, record.operationId, 'the record keeps its id')
  assert.equal(calls[0].title, 'Parser and lexer')
  assert.equal(calls[0].context.end, 1, 'the boundary travels as a zero-based index')
  assert.equal(titleNode.textContent, 'Parser and lexer', 'the card shows the saved text')
  assert.equal(statusLine.textContent, 'Изменения сохранены.')
  assert.equal(form.hidden, true, 'the form closes on success')
  assert.equal(editButton.hidden, false, 'the card can be edited again')
  assert.equal(saveButton.disabled, false)

  // Отмена возвращает прежний текст и ничего не сохраняет.
  editButton.click()
  titleInput.value = 'Discarded title'
  cancelButton.click()
  assert.equal(form.hidden, true)
  assert.equal(titleNode.textContent, 'Parser and lexer', 'cancel keeps the saved text')
  assert.equal(calls.length, 1, 'cancel does not call the handler')

  // Ошибка сохранения: строка ошибки, старое название, никакой лжи об успехе.
  answer = { saved: false }
  editButton.click()
  titleInput.value = 'Not saved'
  saveButton.click()
  await flush()
  assert.equal(calls.length, 2)
  assert.equal(titleNode.textContent, 'Parser and lexer', 'a failed edit does not claim success')
  assert.equal(statusLine.textContent, 'Не удалось сохранить изменения.')
  assert.equal(form.hidden, false, 'the form stays open after a failure')
  assert.equal(saveButton.disabled, false, 'a retry is possible')

  // Брошенное исключение — та же ошибка, без выдуманного успеха.
  answer = null
  const throwing = model.mountCard(doc.createElement('div'), { ...record, operationId: 'fp_1a2b3c4e' }, {
    t: text => text,
    parentTitle: 'Parent chat',
    onEdit: async () => { throw Error('disk-full') }
  })
  throwing.querySelector('[data-action="edit"]').click()
  throwing.querySelector('[data-action="save-edit"]').click()
  await flush()
  assert.equal(throwing.querySelector('.fork-proposal-title').textContent, 'Parser subtask')
  assert.equal(throwing.querySelector('.fork-proposal-status').textContent, 'Не удалось сохранить изменения.')

  // Пока идёт сохранение, форма и решения выключены.
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = model.mountCard(doc.createElement('div'), { ...record, operationId: 'fp_1a2b3c4f' }, {
    t: text => text,
    parentTitle: 'Parent chat',
    onEdit: async item => { await gate; return { saved: true, record: { ...item } } }
  })
  slow.querySelector('[data-action="edit"]').click()
  slow.querySelector('[data-action="save-edit"]').click()
  await flush()
  const slowSave = slow.querySelector('[data-action="save-edit"]')
  const slowAccept = slow.querySelector('[data-action="accept"]')
  assert.equal(slowSave.disabled, true, 'save is disabled while busy')
  assert.equal(slowAccept.disabled, true, 'decisions are disabled while busy')
  assert.equal(slow.querySelector('.fork-proposal-input-title').disabled, true)
  release()
  await flush()
  assert.equal(slowSave.disabled, false, 'the form unlocks after saving')

  // Нечего править: не ожидающее предложение и карточка без обработчика.
  const acceptedCard = model.mountCard(doc.createElement('div'), { ...record, operationId: 'fp_1a2b3c50' }, {
    t: text => text,
    parentTitle: 'Parent chat',
    status: 'accepted',
    onOpenChild: () => {},
    onEdit: async () => ({ saved: true })
  })
  assert.equal(acceptedCard.querySelector('[data-action="edit"]').hidden, true, 'an accepted card cannot be edited')
  const noHandler = model.mountCard(doc.createElement('div'), { ...record, operationId: 'fp_1a2b3c51' }, { t: text => text, parentTitle: 'Parent chat' })
  assert.equal(noHandler.querySelector('[data-action="edit"]').hidden, true, 'without a handler there is no edit action')

  // Разметка модели остаётся текстом и в форме.
  const unsafe = { ...record, operationId: 'fp_1a2b3c52', title: '<img src=x onerror="window.pwned=1">' }
  const unsafeCard = model.mountCard(doc.createElement('div'), unsafe, { t: text => text, parentTitle: 'Parent chat', onEdit: async () => ({ saved: true }) })
  assert.equal(unsafeCard.querySelector('img'), null, 'model markup is never parsed')
  assert.equal(unsafeCard.querySelector('.fork-proposal-title').textContent, unsafe.title)

  // ── Мод/навык: тот же путь инструмента, статическая проверка ────────────
  // Доказывает: схема инструмента лежит в общем списке TOOL_DEFINITIONS, имя
  // разбирается в executeTool, подсказка режима его называет, диета инструментов
  // его не прячет, а действие мода лишь добавляет текст навыка в тот же payload.
  // Не доказывает: что живой запуск мода/навыка действительно породил карточку —
  // для этого нужен оконный прогон с настоящим модом, его здесь нет.
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  const modsRun = fs.readFileSync(path.join(__dirname, '../src/main/mods-run.cjs'), 'utf8')
  const tool = require('../src/main/fork-proposal-tool.cjs')
  const diet = require('../src/main/tool-diet.cjs')
  const prompts = require('../src/main/mode-prompts/tools.js')
  const quality = require('../src/main/agent-quality.js')

  assert.equal(model.TOOL_NAME, 'propose_linked_chat')
  assert.equal(tool.TOOL_NAME, model.TOOL_NAME)
  assert.equal(tool.TOOL_DEFINITION.function.name, 'propose_linked_chat')
  assert.match(main, /\n  FORK_PROPOSAL_TOOL,\n/, 'the schema rides the shared TOOL_DEFINITIONS list')
  assert.match(main, /name === 'propose_linked_chat'\) return await createForkProposalTool/, 'the name dispatches in executeTool')
  assert.ok(!diet.GROUPS.some(group => group.names.includes('propose_linked_chat')), 'the tool diet never hides it')
  assert.equal(diet.slimTools([tool.TOOL_DEFINITION], { texts: 'hello' }).length, 1, 'it needs no trigger word')
  assert.ok(prompts.GUIDANCE.has('propose_linked_chat'), 'the mode prompt knows the tool')
  assert.match(prompts.renderToolManifest(['propose_linked_chat']), /propose_linked_chat/)
  assert.equal(quality.toolAllowedForAssignment('propose_linked_chat', true), true, 'a read-only role may still propose')
  assert.match(main, /mods-run\.cjs'\)\.prepare\(payload, modsBridge\)/, 'a mod action prepares the same payload')
  assert.match(modsRun, /payload = \{ \.\.\.payload, modSkill:/, 'a mod adds only the skill prompt')
  assert.doesNotMatch(modsRun, /TOOL_DEFINITIONS|slimTools|\.tools\b/, 'a mod neither replaces nor filters the tool list')
  assert.match(main, /payload\.modSkill\?\.prompt \|\| ''/, 'the skill prompt joins the same request')

  console.log('PASS: fork proposal edit: stable id, recomputed revision, refusals, inline card form, mod/skill tool path')
})().catch(error => { console.error(error); process.exitCode = 1 })
