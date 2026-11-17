'use strict'

// Общий порядок «исполнитель → проверка → доработка → итог» (план, этап 6, 2a).
//
// Своего движка здесь нет и быть не должно: работу по-прежнему делает
// `runAgentLoop`, а цикл отвечает на три вопроса — сколько ещё можно продлевать
// ход, что уже проверено и чем это кончилось.
//
// До этого на каждый вход был свой счётчик. Продление приёмки (`gateContinues`)
// и вызовы судьи (`acceptanceChecks`) жили внутри одного прохода цикла, а круги
// команды — отдельно (`AGENT_MAX_ROUNDS`). У ведущего три продления, у каждого
// помощника ещё три своих, у команды два круга по три. Склада в один предел это
// не давало: ход команды мог продлеваться шесть и больше раз, и никто не знал,
// когда он остановится, кроме как по исчерпанном лимите шагов. Теперь бюджет
// один на ход, и тратят его все участники в общий котёл.
//
// Бюджет переживает перезапуск: он попадает в контрольную точку хода
// (`run-checkpoints.js`), а продолжение начинается с остатка, а не с нуля. Иначе
// «продолжить» после падения означало бы ещё три продления сверху, то есть ровно
// тот бесконечный ход, против которого лимиты и поставлены.

const LIMITS = {
  // Сколько раз приёмка продлевает ход.
  reworks: 3,
  // «Сделай полностью» — владелец просил доводить до конца, предел шире.
  reworksWholeJob: 6,
  // Отдельных запросов судье на ход. Каждый — платный и лишний секунды.
  judge: 2,
  // Кругов «критика → доработка» в команде.
  rounds: 2
}

// Кто проверил. Список закрыт: запись с диска с любым другим значением
// молча отбрасывается, иначе в итог попадёт выдуманное имя проверки.
const SOURCES = ['plan', 'claims', 'board', 'acceptance', 'design', 'review']
const VERDICTS = ['pass', 'fail', 'unknown']
const MAX_CHECKS = 40
const MAX_GAPS = 3
const GAP_CHARS = 300

// Как проверка называется по-человечески. Одно место: и итог хода, и опись
// продолжения после падения должны называть проверку одинаково.
const CHECK_LABELS = {
  plan: 'чек-лист',
  claims: 'слова против дел',
  board: 'доска команды',
  acceptance: 'приёмка по просьбе',
  design: 'проверка макета',
  review: 'приёмка итога'
}

// Стадии общего порядка. Отмечаются в трёх входах одинаково — тем и проверяется,
// что чат и Дизайн идут одним циклом, а не двумя похожими.
const STAGES = ['execute', 'check', 'rework', 'result']

// Чем доработка отличается в разных входах: правом на то или иное действие.
// Сообщение о переделке не имеет права обещать то, чего в режиме нет, — иначе
// приёмка гоняет ход делать запрещённое и упорно не проходит.
const MODE_NOTE = {
  chat: 'Файлы и команды — в пределах разрешённой рабочей папки.',
  design: 'Это Дизайн: файловых инструментов и запуска команд здесь нет, правь макет инструментами dc_* и проверяй dc_check.'
}

function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

// Пробел проверки — короткая строка, а не документ: в файл хода и в опись
// продолжения попадает только то, чем проверка недовольна.
function cleanGaps(gaps) {
  return (Array.isArray(gaps) ? gaps : []).slice(0, MAX_GAPS).map(gap => clip(gap, GAP_CHARS)).filter(Boolean)
}

function spentPair(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const num = key => (Number.isInteger(value[key]) && value[key] >= 0 ? value[key] : 0)
  return { used: num('used'), limit: num('limit') }
}

// Данные с диска — недоверенные: файл мог быть старым, обрезанным или
// поправленным другой локальной программой. Поэтому не «дочитаем и доверяем»,
// а собираем заново по белому списку.
function cleanCycle(raw) {
  if (!raw || typeof raw !== 'object') return null
  const checks = Array.isArray(raw.checks) ? raw.checks.slice(-MAX_CHECKS).map(item => {
    if (!item || typeof item !== 'object') return null
    if (!SOURCES.includes(item.source) || !VERDICTS.includes(item.verdict)) return null
    return {
      source: item.source,
      verdict: item.verdict,
      gaps: cleanGaps(item.gaps),
      agentIndex: Number.isInteger(item.agentIndex) ? item.agentIndex : 0,
      at: Number(item.at) || 0
    }
  }).filter(Boolean) : []
  return {
    schemaVersion: 1,
    wholeJob: raw.wholeJob === true,
    deadlineAt: Number(raw.deadlineAt) || 0,
    spent: { reworks: spentPair(raw.spent?.reworks), judge: spentPair(raw.spent?.judge), rounds: spentPair(raw.spent?.rounds) },
    // Предел живёт в LIMITS, а не в файле: «сделай полностью» меняет его по
    // тексту просьбы, а не по тому, что кто-то подставил в снимок.
    checks,
    // Стадии только из списка: файл хода мог лежать между версиями программы.
    stages: (Array.isArray(raw.stages) ? raw.stages : []).filter(stage => STAGES.includes(stage)).slice(-40),
    restoredFrom: clip(raw.restoredFrom || '', 64)
  }
}

// Один бюджет на ход. Объект передаётся ведущему и всем помощникам: тратят его
// они вместе, поэтому «помощник доделывает, а ведущему уже нечего продлевать» —
// это честное состояние, а не поломка.
function createCycle({ wholeJob = false, durationMs = 0, restored = null, now = Date.now, onSave = null } = {}) {
  const start = now()
  const limits = {
    reworks: wholeJob ? LIMITS.reworksWholeJob : LIMITS.reworks,
    judge: LIMITS.judge,
    rounds: LIMITS.rounds
  }
  const state = restored && typeof restored === 'object'
    ? cleanCycle(restored) || { spent: {}, checks: [], stages: [], wholeJob, deadlineAt: 0, restoredFrom: '' }
    : { spent: {}, checks: [], stages: [], wholeJob, deadlineAt: 0, restoredFrom: '' }

  for (const kind of Object.keys(limits)) {
    if (!state.spent[kind]) state.spent[kind] = { used: 0, limit: limits[kind] }
    // Остаток с диска не должен оказаться больше нового предела: «сделай
    // полностью» снимает ограничение, но не возвращает потраченное.
    state.spent[kind].limit = limits[kind]
    if (!Number.isInteger(state.spent[kind].used) || state.spent[kind].used < 0) state.spent[kind].used = 0
    if (state.spent[kind].used > limits[kind]) state.spent[kind].used = limits[kind]
  }

  const deadlineAt = Number(state.deadlineAt) || (durationMs > 0 ? start + durationMs : 0)
  // Продолжение после падения получает свой отсчёт заново: время хода
  // восстанавливать нельзя (процесса не было), а вот попытки — можно.
  const deadline = durationMs > 0 ? start + durationMs : deadlineAt
  const spent = state.spent
  const checks = state.checks.slice()
  const stages = state.stages.slice()
  const restoredFrom = state.restoredFrom || (restored ? 'run' : '')

  const persist = () => {
    try { onSave?.(snapshot()) } catch { /* диск не роняет ход */ }
  }

  function left(kind) {
    const pair = spent[kind]
    return pair ? Math.max(0, pair.limit - pair.used) : 0
  }

  // Правда — если на эту попытку бюджет ещё есть. Расход идёт сразу: счётчик,
  // который увеличивается только после успеха, позволяет зациклиться на отказе.
  function spend(kind) {
    const pair = spent[kind]
    if (!pair || pair.used >= pair.limit) return false
    pair.used += 1
    persist()
    return true
  }

  function record({ source, verdict, gaps = [], agentIndex = 0 } = {}) {
    if (!SOURCES.includes(source) || !VERDICTS.includes(verdict)) return null
    const entry = { source, verdict, agentIndex: Number.isInteger(agentIndex) ? agentIndex : 0,
      gaps: cleanGaps(gaps), at: now() }
    checks.push(entry)
    if (checks.length > MAX_CHECKS) checks.shift()
    persist()
    return entry
  }

  // Последняя запись проверки. С индексом исполнителя — последняя именно его:
  // без этого «приёмка пройдена» у второго агента затирала провал первого, и
  // общий отчёт врал при зелёных проверках одного участника.
  function last(source, agentIndex = null) {
    for (let i = checks.length - 1; i >= 0; i--) {
      const entry = checks[i]
      if (entry.source !== source) continue
      if (agentIndex === null || entry.agentIndex === agentIndex) return entry
    }
    return null
  }

  // Актуальные записи: по последней на каждую пару «проверка + исполнитель».
  function current() {
    const latest = new Map()
    for (const entry of checks) latest.set(`${entry.source} ${entry.agentIndex}`, entry)
    return [...latest.values()].sort((a, b) => a.at - b.at)
  }

  function openGaps() {
    const out = []
    for (const entry of current()) if (entry.verdict === 'fail') out.push(...entry.gaps)
    return out
  }

  // Что не сдано сейчас. Прежняя непройденная запись, которую тот же
  // исполнитель потом закрыл, в список не попадает.
  function failing() {
    return current().filter(entry => entry.verdict === 'fail')
  }

  function timeLeftMs() {
    return deadline ? Math.max(0, deadline - now()) : Infinity
  }

  function outOfTime() {
    return deadline > 0 && now() >= deadline
  }

  // Отметка стадии общего порядка. Повтор той же стадии подряд не записывается:
  // «проверка → доработка → проверка» — это три отметки, а не шесть.
  function mark(stage) {
    if (!STAGES.includes(stage) || stages[stages.length - 1] === stage) return false
    stages.push(stage)
    if (stages.length > 40) stages.shift()
    persist()
    return true
  }

  function snapshot() {
    return {
      schemaVersion: 1,
      wholeJob: spent.reworks.limit === LIMITS.reworksWholeJob,
      deadlineAt: deadline,
      spent: { reworks: { ...spent.reworks }, judge: { ...spent.judge }, rounds: { ...spent.rounds } },
      checks: checks.map(entry => ({ ...entry, gaps: entry.gaps.slice() })),
      stages: stages.slice(),
      restoredFrom
    }
  }

  const SAID = { pass: 'пройдена', fail: 'не пройдена', unknown: 'без определённого вывода' }

  // Явный итог проверок. Молчаливое «готово» после непройденной приёмки — это
  // ровно то, на что владелец жаловался: просил яблоко, получил апельсин.
  function summary() {
    const lines = current().map(entry => {
      // Имя агента в записи всегда есть (в одиночном ходе это «Агент 1»), так
      // что метка ставится в любом случае: без неё две одноимённые проверки
      // разных участников не отличить друг от друга.
      const who = ` (Агент ${(Number.isInteger(entry.agentIndex) ? entry.agentIndex : 0) + 1})`
      const detail = entry.verdict === 'fail' && entry.gaps.length ? `: ${entry.gaps.join('; ')}` : ''
      return `- ${CHECK_LABELS[entry.source] || entry.source}${who} — ${SAID[entry.verdict]}${detail}`
    })
    const budget = Object.keys(spent).map(kind => {
      const pair = spent[kind]
      return `${kind === 'reworks' ? 'доработка' : kind === 'judge' ? 'проверок судьёй' : 'кругов переделки'} ${pair.used} из ${pair.limit}`
    }).join(', ')
    const carried = restoredFrom ? ' После перезапуска бюджет продолжен с остатка.' : ''
    return { lines, budget, carried, text: lines.length ? `${lines.join('\n')}\nБюджет хода: ${budget}.${carried}` : '' }
  }

  return Object.freeze({
    wholeJob: spent.reworks.limit === LIMITS.reworksWholeJob,
    limits: Object.freeze({ ...limits }),
    left, spend, record, mark, last, current, openGaps, failing, checks: () => checks.map(entry => ({ ...entry })),
    stages: () => stages.slice(),
    timeLeftMs, outOfTime, deadlineAt: deadline, snapshot, summary,
    restored: Boolean(restoredFrom)
  })
}

// Инструменты, которые меняют макет: проверка после них протухает.
const DC_MUTATION = ['dc_write', 'dc_html_str_replace', 'dc_js_str_replace', 'dc_set_props', 'dc_set_entry', 'dc_delete']

// Исход проверки макета по журналу вызовов. Различать надо два разных факта:
// проверка выполнилась (`success`, в журнале — `ok`) и макет её прошёл
// (`passed`). Взять только первое значит объявить успешной переполненную
// вёрстку. И то и другое считается по последней проверке: прежняя зелёная
// запись не греет, если после неё макет правили.
function designCheckOutcome(log) {
  const calls = Array.isArray(log) ? log : []
  const checks = []
  calls.forEach((entry, index) => { if (entry && entry.tool === 'dc_check') checks.push(index) })
  if (!checks.length) return { verdict: 'unknown', gaps: ['макет не проверен: dc_check за этот ход не вызывался'] }
  const at = checks[checks.length - 1]
  const last = calls[at]
  const gaps = []
  if (last.ok === false) gaps.push('последняя проверка макета не выполнилась')
  else if (last.passed === false) gaps.push('проверка макета не пройдена — исправь и проверь снова')
  if (calls.slice(at + 1).some(entry => DC_MUTATION.includes(entry && entry.tool))) {
    gaps.push('после последней проверки макет менялся — проверь заново')
  }
  return { verdict: gaps.length ? 'fail' : 'pass', gaps }
}

// Решение о доработке — тоже общее (план, 2c): три входа задают один и тот же
// вопрос и получают один и тот же ответ, различается только напоминание о правах
// режима. Возвращает `{ continue, exhausted, message }`; при снятом ходе ни
// решения, ни расхода бюджета не бывает.
//
// Расход токенов: каждая доработка — полный запрос модели (описание инструментов, системный промпт, переписка), а
// модель, получив то же замечание и не сделав после него ни одного вызова, отвечает тем же. `previous` — что было при
// прошлой доработке ({ key, tools }): тот же список замечаний при том же числе вызовов — ход стоит на месте, и
// отправлять тот же запрос в третий раз незачем. Бюджет при этом не тратится: остановка не исчерпание, и ход
// называет её вслух.
function planRework(cycle, { gaps = [], lead = '', mode = 'chat', aborted = false, tools = null, previous = null } = {}) {
  if (aborted) return { continue: false, exhausted: false, message: '' }
  if (!Array.isArray(gaps) || !gaps.length) {
    cycle.mark('result')
    return { continue: false, exhausted: false, message: '' }
  }
  cycle.mark('check')
  const key = gaps.join('\n')
  if (previous && previous.key === key && Number.isFinite(tools) && tools === previous.tools) {
    return { continue: false, exhausted: true, stalled: true, message: '' }
  }
  if (cycle.outOfTime() || !cycle.spend('reworks')) {
    return { continue: false, exhausted: true, message: '' }
  }
  cycle.mark('rework')
  const note = MODE_NOTE[mode] || MODE_NOTE.chat
  return {
    continue: true,
    exhausted: false,
    key,
    tools,
    message: `${lead || 'Проверка нашла незакрытое.'}\n${gaps.map(gap => `- ${gap}`).join('\n')}\n\n` +
      'Доведи названное до конца прямо сейчас, не пересказывая сделанное. ' +
      'Если пункт больше не нужен — скажи почему и обнови чек-лист через task_plan. ' +
      'Если он невозможен без пользователя — назови конкретно, чего не хватает, ' +
      `вместо того чтобы закрывать ход. ${note}`
  }
}

module.exports = { LIMITS, SOURCES, VERDICTS, STAGES, MODE_NOTE, CHECK_LABELS, DC_MUTATION,
  createCycle, cleanCycle, planRework, designCheckOutcome }
