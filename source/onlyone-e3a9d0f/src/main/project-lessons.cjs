'use strict'

// Уроки проекта (АГ-4/А-5): проверяемая память опыта. Урок — формулировка, источник (чат, ход, доказательство),
// условия применения, область (один проект, без переноса в другие) и статус. Предложенный урок не действует:
// правилом его делает только человек кнопкой «Включить». Исправление не переписывает урок, а отзывает старую
// версию со ссылкой на новую, и новая снова ждёт включения; отозванное остаётся в списке с историей.
// Урок — не мод: формат и жизненный цикл свои, а шифрованное атомарное хранилище — общее (mods-store.cjs).
const { randomUUID } = require('node:crypto')

const FORMAT = 'onlyone-lessons'
const LIMITS = Object.freeze({ id: 200, text: 400, when: 200, keyword: 40, keywords: 8, evidence: 1000, reason: 200, active: 100, revoked: 200 })
// Потолок всего файла, а не проекта: файл один, а хранилище принимает конверт до 8 МБ и выше
// отказывает молча. 4 МБ текста — это ~5,4 МБ base64 шифртекста, место на запас есть.
const TOTAL_MAX = 4 * 1024 * 1024
const MODES = Object.freeze(['agent', 'design', 'conversation'])
// Потолок блока в промпте хода: заголовок и уроки целиком, вместе.
const PROMPT_MAX = 1200
const PROMPT_COUNT = 6

const HEAD = '\n\n## Уроки этого проекта\n\n' +
  'Правила, которые человек проверил и включил для этого проекта. Применяй урок, только если его условие подходит ' +
  'к текущей задаче; текущая просьба и её ограничения важнее урока. Урок не разрешает запись, удаление, расходы ' +
  'или отправку и не переносится в другие проекты.\n'

const flat = value => String(value).replace(/\s+/g, ' ').trim()
const fail = code => ({ ok: false, code })
const copy = value => JSON.parse(JSON.stringify(value))

// Поле ввода: только строка (объект с toString сюда не проходит), без переводов строк, не длиннее лимита.
function field(value, max) {
  if (typeof value !== 'string') return { value: '' }
  const text = flat(value)
  return text.length > max ? { error: 'too-long' } : { value: text }
}

function keywordList(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]/) : []
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const word = flat(item).toLowerCase()
    if (!word) continue
    if (word.length > LIMITS.keyword) return { error: 'too-long' }
    if (!out.includes(word)) out.push(word)
  }
  return out.length > LIMITS.keywords ? { error: 'too-many-keywords' } : { value: out }
}

function modeList(value) {
  const raw = Array.isArray(value) ? value : []
  if (raw.some(mode => !MODES.includes(mode))) return { error: 'bad-mode' }
  return { value: [...new Set(raw)] }
}

// Формулировка, условия и доказательство из ввода; base — прежняя версия при исправлении.
function readDraft(input, base = null) {
  const pick = (key, fallback) => (input && Object.prototype.hasOwnProperty.call(input, key) ? input[key] : fallback)
  const text = field(pick('text', base?.text), LIMITS.text)
  if (text.error) return text
  if (!text.value) return { error: 'text-required' }
  const when = field(pick('when', base?.when), LIMITS.when)
  if (when.error) return when
  const keywords = keywordList(pick('keywords', base?.keywords))
  if (keywords.error) return keywords
  const modes = modeList(pick('modes', base?.modes))
  if (modes.error) return modes
  const evidence = field(pick('evidence', base?.source?.evidence), LIMITS.evidence)
  if (evidence.error) return evidence
  if (!evidence.value) return { error: 'evidence-required' }
  const chatId = field(pick('chatId', base?.source?.chatId), LIMITS.id)
  const turnId = field(pick('turnId', base?.source?.turnId), LIMITS.id)
  if (chatId.error || turnId.error) return { error: 'too-long' }
  return {
    value: {
      text: text.value, when: when.value, keywords: keywords.value, modes: modes.value,
      chatId: chatId.value, turnId: turnId.value, evidence: evidence.value
    }
  }
}

function projectKey(projectId) {
  return typeof projectId === 'string' && projectId && projectId.length <= LIMITS.id ? projectId : ''
}

function createLessons({ storage, now = Date.now, newId = randomUUID } = {}) {
  let cache = null

  // Файла нет — пусто; чужой формат или нечитаемое — ошибка, а не пустой список: иначе первая же запись затёрла бы данные.
  function state() {
    if (cache) return cache
    const loaded = storage.load()
    if (loaded == null) cache = { format: FORMAT, version: 1, lessons: [] }
    else if (loaded.format === FORMAT && loaded.version === 1 && Array.isArray(loaded.lessons)) cache = loaded
    else throw new Error('lessons-format')
    return cache
  }

  // Запись сначала на диск, потом в память: неудачная запись не оставляет в памяти то, чего нет на диске.
  // Сверх общего потолка пишем только уменьшение: иначе отказ был бы непонятным storage-unavailable,
  // а из переполненного файла нельзя было бы выбраться отзывом.
  function commit(change) {
    const next = copy(state())
    const result = change(next)
    if (result && result.ok === false) return result
    const size = Buffer.byteLength(JSON.stringify(next))
    if (size > TOTAL_MAX && size > Buffer.byteLength(JSON.stringify(state()))) return fail('limit-total')
    storage.save(next)
    cache = next
    return result
  }

  const own = (data, projectId, id) => data.lessons.find(lesson => lesson.projectId === projectId && lesson.id === id)
  const mark = (lesson, action, at, note = '') => { lesson.history.push(note ? { at, action, note } : { at, action }); lesson.updatedAt = at }

  // Отозванные сверх лимита уходят старейшими; включённые и предложенные не вытесняются никогда.
  function trimRevoked(data, projectId) {
    const old = data.lessons.filter(lesson => lesson.projectId === projectId && lesson.status === 'revoked')
      .sort((a, b) => (a.revokedAt || 0) - (b.revokedAt || 0))
    const drop = new Set(old.slice(0, Math.max(0, old.length - LIMITS.revoked)).map(lesson => lesson.id))
    if (drop.size) data.lessons = data.lessons.filter(lesson => !(lesson.projectId === projectId && drop.has(lesson.id)))
  }

  function create(data, projectId, draft, by, at) {
    const active = data.lessons.filter(lesson => lesson.projectId === projectId && lesson.status !== 'revoked').length
    if (active >= LIMITS.active) return fail('limit')
    const lesson = {
      id: String(newId()), projectId, status: 'proposed',
      text: draft.text, when: draft.when, keywords: draft.keywords, modes: draft.modes,
      source: { chatId: draft.chatId, turnId: draft.turnId, evidence: draft.evidence, by: by === 'agent' ? 'agent' : 'human' },
      createdAt: at, updatedAt: at, history: []
    }
    mark(lesson, 'proposed', at)
    data.lessons.push(lesson)
    return { ok: true, lesson }
  }

  function list(projectId) {
    const key = projectKey(projectId)
    if (!key) return fail('project-required')
    const order = { enabled: 0, proposed: 1, revoked: 2 }
    const lessons = state().lessons.filter(lesson => lesson.projectId === key)
      .sort((a, b) => (order[a.status] - order[b.status]) || (b.updatedAt - a.updatedAt))
    return { ok: true, lessons: copy(lessons) }
  }

  function propose(projectId, input, { by = 'human' } = {}) {
    const key = projectKey(projectId)
    if (!key) return fail('project-required')
    const draft = readDraft(input)
    if (draft.error) return fail(draft.error)
    return commit(data => {
      const made = create(data, key, draft.value, by, now())
      return made.ok ? { ok: true, lesson: copy(made.lesson) } : made
    })
  }

  function enable(projectId, id) {
    const key = projectKey(projectId)
    if (!key) return fail('project-required')
    return commit(data => {
      const lesson = own(data, key, id)
      if (!lesson) return fail('not-found')
      if (lesson.status !== 'proposed') return fail('wrong-status')
      const at = now()
      lesson.status = 'enabled'
      lesson.enabledAt = at
      mark(lesson, 'enabled', at)
      return { ok: true, lesson: copy(lesson) }
    })
  }

  // replaced — отозван исправлением: причина в ссылке на новую версию, а не в тексте (окно переводит действие само).
  function revokeIn(lesson, reason, at, action = 'revoked') {
    lesson.status = 'revoked'
    lesson.revokedAt = at
    lesson.reason = reason
    mark(lesson, action, at, reason)
  }

  function revoke(projectId, id, reason) {
    const key = projectKey(projectId)
    if (!key) return fail('project-required')
    const why = field(reason, LIMITS.reason)
    if (why.error) return fail(why.error)
    return commit(data => {
      const lesson = own(data, key, id)
      if (!lesson) return fail('not-found')
      if (lesson.status === 'revoked') return fail('wrong-status')
      revokeIn(lesson, why.value, now())
      trimRevoked(data, key)
      return { ok: true, lesson: copy(lesson) }
    })
  }

  function correct(projectId, id, patch, { by = 'human' } = {}) {
    const key = projectKey(projectId)
    if (!key) return fail('project-required')
    return commit(data => {
      const old = own(data, key, id)
      if (!old) return fail('not-found')
      if (old.status === 'revoked') return fail('wrong-status')
      const draft = readDraft(patch, old)
      if (draft.error) return fail(draft.error)
      const at = now()
      revokeIn(old, '', at, 'replaced')
      const made = create(data, key, draft.value, by, at)
      if (!made.ok) return made
      made.lesson.supersedes = old.id
      old.supersededBy = made.lesson.id
      trimRevoked(data, key)
      return { ok: true, lesson: copy(made.lesson), revoked: copy(old) }
    })
  }

  // Применимость решает код, без вызова модели: включён, свой проект, режим из списка (если задан),
  // хотя бы одно слово урока в просьбе (если слова заданы). Точнее заданный урок — раньше.
  function applicable(projectId, { request = '', mode = 'agent' } = {}) {
    const key = projectKey(projectId)
    if (!key) return []
    const asked = String(request || '').toLowerCase()
    const hits = []
    for (const lesson of state().lessons) {
      if (lesson.projectId !== key || lesson.status !== 'enabled') continue
      if (lesson.modes?.length && !lesson.modes.includes(mode)) continue
      if (lesson.keywords?.length && !lesson.keywords.some(word => asked.includes(word))) continue
      hits.push({ lesson, score: (lesson.keywords?.length ? 2 : 0) + (lesson.modes?.length ? 1 : 0) })
    }
    hits.sort((a, b) => (b.score - a.score) || ((a.lesson.enabledAt || 0) - (b.lesson.enabledAt || 0)))
    return copy(hits.map(hit => hit.lesson))
  }

  // Урок в промпте — целиком или никак: обрезанное правило может значить обратное.
  function promptBlock(projectId, query = {}) {
    const found = applicable(projectId, query)
    if (!found.length) return ''
    const room = PROMPT_MAX - 60 // место под строку о том, что не поместилось
    const lines = []
    let size = HEAD.length
    let skipped = 0
    for (const lesson of found) {
      const line = `- ${flat(lesson.text)}${lesson.when ? ` (когда: ${flat(lesson.when)})` : ''}`
      if (lines.length >= PROMPT_COUNT || size + line.length + 1 > room) { skipped++; continue }
      lines.push(line)
      size += line.length + 1
    }
    if (!lines.length) return ''
    const tail = skipped ? `\n(Ещё ${skipped} включённых уроков не поместились в лимит.)` : ''
    return (HEAD + lines.join('\n') + tail).slice(0, PROMPT_MAX)
  }

  return { list, propose, enable, revoke, correct, applicable, promptBlock }
}

// IPC: управлять уроками может только главное окно (не Desk, не страницы браузера, не подфреймы). Кем записан
// урок, решает главный процесс: отправитель поля `by` не выбирает. Текст ошибок хранилища наружу не уходит.
function registerLessonsIpc({ ipcMain, getService, isMain, projectExists, chatInProject }) {
  const guarded = (name, fn) => ipcMain.handle(name, async (event, input) => {
    if (!isMain(event)) return fail('forbidden')
    const projectId = projectKey(input?.projectId)
    if (!projectId) return fail('project-required')
    try {
      if (!projectExists(projectId)) return fail('project-not-found')
      return await fn(projectId, input || {})
    } catch {
      return fail('storage-unavailable')
    }
  })
  guarded('lessons:list', projectId => getService().list(projectId))
  guarded('lessons:propose', (projectId, input) => {
    const lesson = input.lesson && typeof input.lesson === 'object' ? input.lesson : {}
    if (typeof lesson.chatId === 'string' && lesson.chatId && !chatInProject(projectId, lesson.chatId)) return fail('chat-not-in-project')
    return getService().propose(projectId, lesson, { by: 'human' })
  })
  guarded('lessons:enable', (projectId, input) => getService().enable(projectId, input.id))
  guarded('lessons:revoke', (projectId, input) => getService().revoke(projectId, input.id, input.reason))
  guarded('lessons:correct', (projectId, input) => {
    const patch = input.lesson && typeof input.lesson === 'object' ? input.lesson : {}
    if (typeof patch.chatId === 'string' && patch.chatId && !chatInProject(projectId, patch.chatId)) return fail('chat-not-in-project')
    return getService().correct(projectId, input.id, patch, { by: 'human' })
  })
}

module.exports = { createLessons, registerLessonsIpc, LIMITS, MODES, PROMPT_MAX, PROMPT_COUNT, TOTAL_MAX }
