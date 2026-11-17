// Помощник по решениям (Mercury Decide, Jev и подобные «decisions»-модели OpenRouter). Такая модель не пишет текст и не
// вызывает инструменты: ей отдают состояние и типизированные вопросы, она отвечает выбором, вероятностью «да» или позицией на
// шкале. В чат-канал /chat/completions её не пускают (ошибка 400), у неё свой endpoint POST /api/alpha/decisions.
//
// Здесь только чистое: разбор метаданных модели, проверка аргументов инструмента и перевод ответа в короткий текст для ведущего.
// Сеть и ключи — в main.js.

const MAX_QUESTIONS = 8
const MAX_STATE_CHARS = 12000
const TYPES = new Set(['choice', 'noul', 'score'])

// Метаданные модели из GET /api/v1/models/<id>/endpoints (публично, без ключа).
function describeModelMeta (body) {
  const data = body && body.data
  if (!data || typeof data !== 'object') return { found: false }
  const outputs = (data.architecture && data.architecture.output_modalities) || []
  return {
    found: true,
    id: String(data.id || ''),
    name: String(data.name || data.id || '').replace(/\s*\(free\)\s*$/i, ''),
    decision: Array.isArray(outputs) && outputs.includes('decisions'),
    // Обычная чат-модель: отвечает текстом. От неё зависит, что сказать человеку про модель, которой нет в каталоге.
    chat: Array.isArray(outputs) && outputs.includes('text') && !outputs.includes('decisions')
  }
}

// Что значит ответ метаданных для модели, названной человеком, но не найденной в локальном каталоге. Раньше любая
// найденная модель, не «decisions», объявлялась «не чат-моделью» — в том числе обычная чат-модель, которой просто нет
// в кэше каталога, и ход не начинался с неверной причиной.
function explainMissingModel(meta) {
  if (!meta || meta.found === null) return { kind: 'unknown' }
  if (!meta.found) return { kind: 'missing' }
  if (meta.decision) return { kind: 'decision' }
  if (meta.chat) return { kind: 'chat-not-in-catalog' }
  return { kind: 'not-chat' }
}

const TOOL = {
  type: 'function',
  function: {
    name: 'ask_decision',
    description: 'Спросить помощника по решениям (модель, которая отвечает не текстом, а выбором, вероятностью «да» или позицией на шкале). ' +
      'Используй в развилках, где нужно взвешенное решение по состоянию: «что делать дальше», «изменилось ли существенно», «насколько срочно». ' +
      'Он не видит ничего, кроме того, что ты передал в state, и не выполняет действий: работу делаешь ты. ' +
      'Вопросы типизированы: choice — выбрать один вариант из criteria {вариант: описание}; noul — да/нет, criteria {true: описание, false: описание}; ' +
      'score — позиция на упорядоченной шкале, criteria — список описаний от меньшего к большему.',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'object', description: 'Состояние, о котором спрашиваешь: факты и наблюдения (числа, тексты, что изменилось).' },
        questions: {
          type: 'object',
          description: 'Вопросы по id → {type: choice|noul|score, instructions, criteria}. Не больше восьми.',
          additionalProperties: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['choice', 'noul', 'score'] },
              instructions: { type: 'string', description: 'Сам вопрос одним предложением.' },
              criteria: { description: 'choice: {вариант: описание}; noul: {true: …, false: …}; score: [описания по возрастанию].' }
            },
            required: ['type', 'instructions', 'criteria']
          }
        }
      },
      required: ['state', 'questions']
    }
  }
}

const oneLine = (value, limit) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit)

// Проверка того, что прислала модель. Нормализованное тело уходит в endpoint; ошибка — ведущему словами, что поправить.
function buildRequest (modelId, args) {
  const state = args && args.state
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, error: 'state должен быть объектом: факты и наблюдения, о которых спрашиваешь.' }
  const stateText = JSON.stringify(state)
  if (stateText.length > MAX_STATE_CHARS) return { ok: false, error: `state слишком большой (${stateText.length} знаков, предел ${MAX_STATE_CHARS}): передай только существенное.` }
  const source = args.questions
  const ids = source && typeof source === 'object' && !Array.isArray(source) ? Object.keys(source) : []
  if (!ids.length) return { ok: false, error: 'Нужен хотя бы один вопрос: questions — объект id → {type, instructions, criteria}.' }
  if (ids.length > MAX_QUESTIONS) return { ok: false, error: `Вопросов не больше ${MAX_QUESTIONS}, пришло ${ids.length}.` }
  const questions = {}
  for (const id of ids) {
    const q = source[id] || {}
    const type = String(q.type || '')
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { ok: false, error: `Id вопроса «${oneLine(id, 30)}» должен быть из латиницы, цифр, «_» и «-».` }
    if (!TYPES.has(type)) return { ok: false, error: `Вопрос «${id}»: type — choice, noul или score.` }
    const instructions = oneLine(q.instructions, 600)
    if (!instructions) return { ok: false, error: `Вопрос «${id}»: нужен текст вопроса в instructions.` }
    if (type === 'score') {
      const list = Array.isArray(q.criteria) ? q.criteria.map(item => oneLine(item, 300)).filter(Boolean) : []
      if (list.length < 2 || list.length > 10) return { ok: false, error: `Вопрос «${id}» (score): criteria — список из 2–10 описаний шкалы по возрастанию.` }
      questions[id] = { type, instructions, criteria: list }
    } else {
      const criteria = q.criteria && typeof q.criteria === 'object' && !Array.isArray(q.criteria) ? q.criteria : null
      const keys = criteria ? Object.keys(criteria) : []
      if (type === 'noul' && !(keys.includes('true') && keys.includes('false'))) return { ok: false, error: `Вопрос «${id}» (noul): criteria — объект с ключами true и false.` }
      if (type === 'choice' && (keys.length < 2 || keys.length > 8)) return { ok: false, error: `Вопрос «${id}» (choice): в criteria от 2 до 8 вариантов.` }
      const clean = {}
      for (const key of keys) clean[oneLine(key, 60)] = oneLine(criteria[key], 300)
      questions[id] = { type, instructions, criteria: clean }
    }
  }
  return { ok: true, body: { model: modelId, state, questions } }
}

const percent = value => Math.round(Number(value) * 100) + '%'

// Ответ endpoint → короткий текст для ведущего. Вероятности остаются вероятностями: порог решает ведущий.
function formatAnswers (response) {
  const answers = response && response.answers
  if (!answers || typeof answers !== 'object') return 'Помощник по решениям не вернул ответов.'
  const lines = []
  for (const [id, answer] of Object.entries(answers)) {
    if (!answer || typeof answer !== 'object') continue
    if (answer.type === 'noul') lines.push(`${id}: вероятность «да» ${percent(answer.noul)}`)
    else if (answer.type === 'choice') {
      const odds = Object.entries(answer.probabilities || {}).sort((a, b) => b[1] - a[1]).map(([key, p]) => `${key} ${percent(p)}`).join(', ')
      lines.push(`${id}: выбор «${answer.choice}», уверенность ${percent(answer.confidence)} (${odds})`)
    } else if (answer.type === 'score') {
      const legend = answer.legend || {}
      const at = Math.round(Number(answer.score))
      lines.push(`${id}: позиция ${Number(answer.score).toFixed(2)} на шкале 0…${Math.max(0, Object.keys(legend).length - 1)}${legend[at] ? ` («${legend[at]}»)` : ''}, уверенность ${percent(answer.confidence)}`)
    }
  }
  return lines.length ? lines.join('\n') : 'Помощник по решениям вернул пустой ответ.'
}

module.exports = { describeModelMeta, explainMissingModel, buildRequest, formatAnswers, TOOL, MAX_QUESTIONS }
