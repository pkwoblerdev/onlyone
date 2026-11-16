'use strict'

// Состояние задачи (АГ-8, И-1): требования, критерии, действия, доказательства,
// версии входов и остаток. Своего файла у него нет: состояние живёт в
// контрольной точке хода (run-checkpoints.js) — там же, где журнал действий, и
// переживает падение тем же путём. Модуль чистый: ни диска, ни Electron.
//
// Правила, ради которых всё и заведено:
// - «Подтверждено» ставит приложение по доказательству, а не модель своим
//   «готово». Слово модели переводит требование только в «проверяется».
// - Доказательство помнит версии входов. Вход изменился — подтверждение
//   отзывается («устарело»), но история и само доказательство остаются.
//   Карта зависимостей неизвестна — перепроверяется всё, консервативно.
// - Агент не удаляет обязательное требование и не облегчает его условие:
//   отменяет только человек, повторное заведение не меняет текст.
// - Действие, начатое до сбоя и не дописанное, — неизвестный исход. Его
//   сверяют (наблюдением цели или осознанным повтором после предупреждения),
//   а не повторяют вслепую.

const { createTaskBudget, cleanBudgetState } = require('./task-budget.cjs')

const STATES = ['not_started', 'in_progress', 'verifying', 'confirmed', 'stale', 'blocked', 'cancelled']

const TRANSITIONS = Object.freeze({
  not_started: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['verifying', 'blocked', 'cancelled'],
  verifying: ['confirmed', 'in_progress', 'blocked', 'cancelled'],
  confirmed: ['stale', 'in_progress', 'cancelled'],
  stale: ['in_progress', 'verifying', 'confirmed', 'blocked', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  cancelled: []
})

// Чем можно подтвердить. Заявления модели («claim») здесь нет намеренно.
const EVIDENCE_SOURCES = ['command', 'observation', 'judge', 'human']
const VERDICTS = ['pass', 'fail', 'unknown']
const ACTION_STATUSES = ['started', 'done', 'failed', 'denied', 'unknown']
const RESOLUTIONS = ['observed', 'repeated']
const ORIGINS = ['plan', 'board', 'human', 'ask']
const ACTORS = ['agent', 'human', 'app']

const MAX_REQUIREMENTS = 80
const MAX_HISTORY = 20
const MAX_EVIDENCE = 60
const MAX_ACTIONS = 200

const ID = /^[A-Za-z0-9_.:-]{1,120}$/
const INPUT = /^[A-Za-z][A-Za-z0-9_.:-]{0,40}$/

function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

const validId = value => typeof value === 'string' && ID.test(value)
const validVersion = value => Number.isSafeInteger(value) || (typeof value === 'string' && value.length > 0 && value.length <= 64)
const timeOf = value => Number.isFinite(value) && value >= 0 ? value : 0

function cleanInputs(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [name, version] of Object.entries(raw)) {
    if (INPUT.test(name) && validVersion(version)) out[name] = version
  }
  return out
}

function cleanHistory(list) {
  return (Array.isArray(list) ? list : []).filter(entry => entry && STATES.includes(entry.from) && STATES.includes(entry.to))
    .slice(-MAX_HISTORY).map(entry => ({
      from: entry.from, to: entry.to, at: timeOf(entry.at),
      by: ACTORS.includes(entry.by) ? entry.by : 'app',
      ...(entry.reason ? { reason: clip(entry.reason, 160) } : {}),
      ...(validId(entry.evidenceId) ? { evidenceId: entry.evidenceId } : {})
    }))
}

function cleanEvidence(item) {
  if (!item || !validId(item.id) || !EVIDENCE_SOURCES.includes(item.source) || !VERDICTS.includes(item.verdict)) return null
  return {
    id: item.id, source: item.source, verdict: item.verdict, inputs: cleanInputs(item.inputs), at: timeOf(item.at),
    // Чья это проверка: без этого чужая зелёная проверка подтверждала чужую часть.
    agentIndex: Number.isSafeInteger(item.agentIndex) && item.agentIndex >= 0 ? item.agentIndex : 0,
    coverage: clip(item.coverage, 200), limits: clip(item.limits, 200),
    ...(validId(item.actionId) ? { actionId: item.actionId } : {}),
    requirementIds: (Array.isArray(item.requirementIds) ? item.requirementIds : []).filter(validId).slice(0, 40)
  }
}

function cleanAction(item, index) {
  if (!item || typeof item !== 'object') return null
  // Файлы прежней версии знали только порядковый номер: id собирается из него,
  // чтобы унаследованное действие осталось адресуемым.
  const id = validId(item.id) ? item.id : `old.${Number.isSafeInteger(item.seq) ? item.seq : index + 1}`
  const action = {
    id, tool: clip(item.tool, 80), target: clip(item.target, 200),
    agentIndex: Number.isSafeInteger(item.agentIndex) && item.agentIndex >= 0 ? item.agentIndex : 0,
    // Незнакомый статус — тоже неизвестный исход, а не «действия не было».
    status: ACTION_STATUSES.includes(item.status) ? item.status : 'unknown',
    startedAt: timeOf(item.startedAt ?? item.at)
  }
  if (Number.isSafeInteger(item.ground) && item.ground >= 0) action.ground = item.ground
  if (item.cycle === true) action.cycle = true
  if (item.cycleUsed === true) action.cycleUsed = true
  if (validId(item.requirementId)) action.requirementId = item.requirementId
  if (timeOf(item.endedAt)) action.endedAt = item.endedAt
  if (item.carried === true) action.carried = true
  if (item.verification === true) action.verification = true
  if (item.warned === true) action.warned = true
  if (RESOLUTIONS.includes(item.resolution)) action.resolution = item.resolution
  if (validId(item.resolvedBy)) action.resolvedBy = item.resolvedBy
  return action
}

// С диска приходит недоверенный объект: файл мог быть старым, обрезанным или
// поправленным соседним процессом. Собираем заново по белому списку.
function cleanTaskState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : []).map(cleanEvidence).filter(Boolean).slice(-MAX_EVIDENCE)
  const known = new Set(evidence.map(item => item.id))
  const requirements = []
  const rawRequirements = Array.isArray(raw.requirements) ? raw.requirements : []
  for (const item of rawRequirements.slice(0, MAX_REQUIREMENTS)) {
    if (!item || !validId(item.id) || !clip(item.expected, 1) || requirements.some(other => other.id === item.id)) continue
    // Незнакомое состояние и подтверждение без доказательства в файле
    // перепроверяются: считать их сделанными нечем.
    let state = STATES.includes(item.state) ? item.state : 'stale'
    if (state === 'confirmed' && !known.has(item.confirmedBy)) state = 'stale'
    requirements.push({
      id: item.id, expected: clip(item.expected, 300), criterion: clip(item.criterion, 600),
      required: item.required !== false,
      // Текст не расшифровался (чужой ключ): требование остаётся, помечается и
      // несёт исходный шифр — иначе продолжение затрёт его заглушкой.
      ...(item.unreadable === true ? { unreadable: true } : {}),
      ...(item.worked === true ? { worked: true } : {}),
      ...(typeof item.expectedSealed === 'string' && item.expectedSealed.length <= 4096 ? { expectedSealed: item.expectedSealed } : {}),
      ...(typeof item.criterionSealed === 'string' && item.criterionSealed.length <= 8192 ? { criterionSealed: item.criterionSealed } : {}),
      // Пустой массив — не «ни от чего не зависит», а неназванная карта:
      // перепроверяется всё, консервативно (break-4 Н10).
      dependsOn: Array.isArray(item.dependsOn) && item.dependsOn.length ? item.dependsOn.filter(name => typeof name === 'string' && INPUT.test(name)).slice(0, 16) : null,
      origin: ORIGINS.includes(item.origin) ? item.origin : 'plan',
      agentIndex: Number.isSafeInteger(item.agentIndex) && item.agentIndex >= 0 ? item.agentIndex : 0,
      state, createdAt: timeOf(item.createdAt),
      ...(state === 'confirmed' ? { confirmedBy: item.confirmedBy } : {}),
      history: cleanHistory(item.history),
      droppedHistory: Number.isSafeInteger(item.droppedHistory) && item.droppedHistory >= 0 ? item.droppedHistory : 0
    })
  }
  const count = key => Number.isSafeInteger(raw[key]) && raw[key] >= 0 ? raw[key] : 0
  const budget = raw.budget == null ? null : cleanBudgetState(raw.budget)
  return {
    schemaVersion: 1,
    inputs: cleanInputs(raw.inputs),
    requirements,
    evidence,
    actions: (Array.isArray(raw.actions) ? raw.actions : []).slice(-MAX_ACTIONS).map(cleanAction).filter(Boolean),
    budget,
    // Метка переживает повторную чистку: иначе испорченный бюджет после
    // второго прохода выглядел бы как «бюджета не было».
    budgetCorrupt: raw.budgetCorrupt === true || (raw.budget != null && !budget),
    droppedRequirements: count('droppedRequirements') + Math.max(0, rawRequirements.length - MAX_REQUIREMENTS),
    droppedEvidence: count('droppedEvidence'),
    droppedActions: count('droppedActions')
  }
}

const copy = value => JSON.parse(JSON.stringify(value))

function createTaskState({ restored = null, now = Date.now, idPrefix = 'run', budgetLimits = null, budgetDeadlineAt = undefined } = {}) {
  const prefix = String(idPrefix || 'run').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'run'
  const base = restored ? cleanTaskState(restored) : null
  const inputs = { workspace: 0, ...(base?.inputs || {}) }
  const requirements = base ? base.requirements : []
  const evidence = base ? base.evidence : []
  const actions = base ? base.actions.map(item => ({
    ...item,
    // Процесс, который начал действие, умер: исход неизвестен.
    status: item.status === 'started' ? 'unknown' : item.status,
    carried: true
  })) : []
  // Пределы бюджета не читаются из файла: их передаёт вызывающий явно, а
  // продолжение наследует только потраченное. Забыть их — ошибка, не сброс.
  // Повреждённый бюджет не превращается в новый: неизвестные траты не ноль.
  if (base?.budgetCorrupt) throw new TypeError('Повреждённое состояние бюджета задачи')
  if (base?.budget && !budgetLimits) throw new TypeError('Нужны явные пределы бюджета задачи')
  const budget = budgetLimits
    ? createTaskBudget({ limits: budgetLimits, deadlineAt: budgetDeadlineAt, restored: base?.budget || null, now })
    : null
  let droppedRequirements = base?.droppedRequirements || 0
  let droppedEvidence = base?.droppedEvidence || 0
  let droppedActions = base?.droppedActions || 0
  const own = new RegExp(`^${prefix}\\.e?(\\d+)$`)
  let sequence = Math.max(0, ...[...actions, ...evidence].map(item => Number(own.exec(item.id)?.[1]) || 0))

  const find = id => requirements.find(item => item.id === id) || null
  const unresolved = item => item.status === 'unknown' && !item.resolution

  function pushHistory(req, entry) {
    req.history.push(entry)
    if (req.history.length > MAX_HISTORY) { req.history.shift(); req.droppedHistory++ }
  }

  function shift(req, to, { by = 'app', reason = '', evidenceId = null } = {}) {
    const from = req.state
    req.state = to
    if (to === 'confirmed') req.confirmedBy = evidenceId
    else delete req.confirmedBy
    pushHistory(req, { from, to, at: now(), by, ...(reason ? { reason: clip(reason, 160) } : {}), ...(evidenceId ? { evidenceId } : {}) })
  }

  // Доказательство свежее, если входы, от которых требование зависит, с тех
  // пор не менялись. Карта не названа — сверяются все входы.
  function fresh(item, req) {
    const names = req.dependsOn || [...new Set([...Object.keys(inputs), ...Object.keys(item.inputs)])]
    return names.every(name => item.inputs[name] === inputs[name])
  }
  // Доказательство принадлежит тому, кто его добыл: действие помнит агента, а
  // без действия — названный вызывающим. Ведущий (0) сводит работу, поэтому его
  // проверка интеграционная и годится для любой части; помощник отвечает только
  // за свою, и его зелёный тест чужую параллельную часть не подтверждает.
  // Автоматическое доказательство команды (с действием) закрывает только части,
  // которые действительно делались: посторонний зелёный прогон не подтверждает
  // нетронутые требования. Проверка без действия (судья/человек/явная
  // интеграционная) сохраняет правило ведущего.
  const applies = (item, req) => {
    if (item.requirementIds.length) return item.requirementIds.includes(req.id)
    if (item.actionId && req.worked !== true) return false
    return item.agentIndex === 0 || item.agentIndex === req.agentIndex
  }

  // Решает последнее свежее доказательство: зелёное после красного на той же
  // версии подтверждает, красное после зелёного — нет.
  function settle() {
    for (const req of requirements) {
      if (req.state !== 'verifying' && req.state !== 'stale') continue
      let latest = null
      for (let i = evidence.length - 1; i >= 0; i--) {
        const item = evidence[i]
        if (item.verdict !== 'unknown' && applies(item, req) && fresh(item, req)) { latest = item; break }
      }
      if (latest?.verdict === 'pass') shift(req, 'confirmed', { reason: `${latest.source}: ${latest.coverage}`, evidenceId: latest.id })
    }
  }

  function require({ id, expected, criterion = '', required = true, dependsOn = null, origin = 'plan', agentIndex = 0 } = {}) {
    const existing = find(id)
    // Повторное заведение не меняет ни текста, ни обязательности: облегчить
    // условие ради зелёного статуса нельзя.
    if (existing) return copy(existing)
    if (!validId(id) || !clip(expected, 1)) return null
    if (requirements.length >= MAX_REQUIREMENTS) { droppedRequirements++; return null }
    const req = {
      id, expected: clip(expected, 300), criterion: clip(criterion, 600), required: required !== false,
      dependsOn: Array.isArray(dependsOn) && dependsOn.length ? dependsOn.filter(name => INPUT.test(String(name))).slice(0, 16) : null,
      origin: ORIGINS.includes(origin) ? origin : 'plan',
      agentIndex: Number.isSafeInteger(agentIndex) && agentIndex >= 0 ? agentIndex : 0,
      state: 'not_started', createdAt: now(), history: [], droppedHistory: 0
    }
    requirements.push(req)
    return copy(req)
  }

  function move(id, to, { by = 'agent', reason = '' } = {}) {
    const req = find(id)
    if (!req) return { ok: false, error: `Требования ${id} нет.` }
    if (!STATES.includes(to)) return { ok: false, error: `Неизвестное состояние ${to}.` }
    if (to === 'confirmed') return { ok: false, error: 'Подтверждает приложение по доказательству, а не переход.' }
    if (to === 'cancelled' && req.required && by !== 'human') return { ok: false, error: 'Обязательное требование отменяет только человек.' }
    if (!TRANSITIONS[req.state].includes(to)) return { ok: false, error: `Переход ${req.state} → ${to} недопустим.` }
    shift(req, to, { by: ACTORS.includes(by) ? by : 'agent', reason })
    if (to === 'verifying') settle()
    return { ok: true, state: req.state }
  }

  function setInput(name, version, reason = '') {
    if (!INPUT.test(String(name)) || !validVersion(version) || inputs[name] === version) return false
    const was = inputs[name]
    inputs[name] = version
    const why = `${name} ${was ?? '—'}→${version}${reason ? `: ${reason}` : ''}`
    for (const req of requirements) {
      if (req.state !== 'confirmed') continue
      if (req.dependsOn && !req.dependsOn.includes(name)) continue
      shift(req, 'stale', { reason: `входы изменились: ${why}` })
    }
    return true
  }

  function bumpInput(name, reason = '') {
    const was = inputs[name]
    return setInput(name, Number.isSafeInteger(was) ? was + 1 : 1, reason)
  }

  function addEvidence({ source, verdict, coverage = '', limits = '', actionId = null, requirementIds = [], agentIndex = 0 } = {}) {
    if (!EVIDENCE_SOURCES.includes(source) || !VERDICTS.includes(verdict)) return null
    const action = actionId ? actions.find(item => item.id === actionId) : null
    const owner = action ? action.agentIndex : (Number.isSafeInteger(agentIndex) && agentIndex >= 0 ? agentIndex : 0)
    const item = cleanEvidence({ id: `${prefix}.e${++sequence}`, source, verdict, inputs: { ...inputs }, at: now(),
      coverage, limits, actionId, requirementIds, agentIndex: owner })
    evidence.push(item)
    if (evidence.length > MAX_EVIDENCE) { evidence.shift(); droppedEvidence++ }
    // Провал по названному требованию — конкретный дефект: обратно в работу.
    if (verdict === 'fail') {
      for (const req of requirements) {
        if (item.requirementIds.includes(req.id) && ['verifying', 'confirmed', 'stale'].includes(req.state)) {
          shift(req, 'in_progress', { reason: `проверка не пройдена: ${item.coverage}`, evidenceId: item.id })
        }
      }
    }
    settle()
    return copy(item)
  }

  // Что агент выполняет сейчас: к этому требованию привязывается его действие.
  function current(agentIndex) {
    let best = null, at = -1
    for (const req of requirements) {
      if (req.state !== 'in_progress' || req.agentIndex !== agentIndex) continue
      const since = req.history.length ? req.history[req.history.length - 1].at : req.createdAt
      if (since >= at) { best = req; at = since }
    }
    return best
  }

  function beginAction({ tool, target = '', agentIndex = 0, verification = false } = {}) {
    const index = Number.isSafeInteger(agentIndex) && agentIndex >= 0 ? agentIndex : 0
    const action = { id: `${prefix}.${++sequence}`, tool: clip(tool, 80), target: clip(target, 200), agentIndex: index,
      status: 'started', startedAt: now(),
      // Основание монотонно: вытеснение доказательств не уменьшает счётчик,
      // иначе новая проверка при полном журнале выглядела бы как «основание не
      // изменилось» и легальный повтор блокировался бы как цикл (break-4 Н5).
      ground: evidence.length + droppedEvidence }
    const req = current(index)
    // Отметка работы остаётся на требовании и переживает вытеснение действий:
    // без неё интеграционная проверка не закроет часть на длинном ходу.
    if (req) { action.requirementId = req.id; req.worked = true }
    if (verification) action.verification = true
    // Повтор после предупреждения — осознанный: прежний неизвестный исход
    // сверен этим действием, ссылка на него остаётся. Сверяется только свой
    // исход: чужой повтор не даёт чужому агенту право на слепое действие.
    for (const item of actions) {
      if (unresolved(item) && item.warned && item.agentIndex === index && item.tool === action.tool && item.target === action.target) {
        item.resolution = 'repeated'
        item.resolvedBy = action.id
      }
    }
    // Осознанный повтор после предупреждения цикла и его прямые продолжения
    // несут отметку «проход использован»: иначе каждый новый круг A → B → A
    // получал бы новое предупреждение и новый проход — цикл крутился бы
    // бесконечно без новых доказательств (break-4 Н2). Основание то же —
    // проход один; новое доказательство меняет основание и открывает проход снова.
    for (let at = actions.length - 1; at >= 0; at--) {
      const prev = actions[at]
      if (prev.agentIndex !== index || prev.tool !== action.tool || prev.target !== action.target || unresolved(prev)) continue
      if ((prev.cycle || prev.cycleUsed) && prev.ground === action.ground) action.cycleUsed = true
      break
    }
    // Журнал ограничен, но неизвестный исход терять нельзя: место освобождает
    // самое старое действие с известным исходом. Если таких нет, журнал не
    // растёт — новый вызов только считается выпавшим.
    if (actions.length >= MAX_ACTIONS) {
      const at = actions.findIndex(item => item.status !== 'started' && !unresolved(item))
      if (at < 0) {
        droppedActions++
        return copy(action)
      }
      actions.splice(at, 1)
      droppedActions++
    }
    actions.push(action)
    return copy(action)
  }

  function endAction(id, outcome, { unconfirmed = false } = {}) {
    const action = actions.find(item => item.id === id)
    if (!action || action.status !== 'started') return null
    // Остановка без подтверждения конца процесса — неизвестный исход.
    action.status = unconfirmed ? 'unknown' : outcome === 'failed' || outcome === 'denied' ? outcome : 'done'
    action.endedAt = now()
    return copy(action)
  }

  function discardAction(id) {
    const at = actions.findIndex(item => item.id === id)
    if (at < 0) return false
    actions.splice(at, 1)
    return true
  }

  // Повтор A → B → A без нового доказательства — цикл: то же действие уже было,
  // после него поработали, а новых данных так и нет. Основание считается по
  // доказательствам: версия входов растёт от каждой правки сама по себе и
  // основанием повтора быть не может. Чтение в журнал действий не попадает, так
  // что B здесь виден, только если оставил след (правка, команда).
  function cycleOf(name, aim, index) {
    for (let at = actions.length - 1; at >= 0; at--) {
      const item = actions[at]
      if (item.agentIndex !== index || item.tool !== name || item.target !== aim || unresolved(item)) continue
      // Основание считается так же, как записано в действии: длина журнала плюс
      // выпавшие доказательства (break-4 Н5).
      if (item.ground !== evidence.length + droppedEvidence) return null
      const between = actions.slice(at + 1).some(other => other.agentIndex === index && (other.tool !== name || other.target !== aim))
      if (!between) return null
      // Проход после предупреждения открыт один раз на основание: осознанный
      // повтор уже был — тот же цикл без новых доказательств держится без
      // второго прохода (break-4 Н2). Однократность предупреждения сохранена.
      if (item.cycleUsed) return item
      // Уже предупредили — повтор после предупреждения решает модель.
      if (item.cycle) return null
      return item
    }
    return null
  }

  function admit({ tool, target = '', agentIndex = 0 } = {}) {
    const name = clip(tool, 80), aim = clip(target, 200)
    const index = Number.isSafeInteger(agentIndex) && agentIndex >= 0 ? agentIndex : 0
    // Неизвестный исход ищется только свой: чужой сбой не держит агента и не
    // даёт ему права на слепой повтор (break-4 Н3, атрибуция волны 10.11).
    const item = actions.find(entry => unresolved(entry) && entry.agentIndex === index && entry.tool === name && entry.target === aim)
    if (item && !item.warned) {
      item.warned = true
      return {
        allowed: false,
        actionId: item.id,
        reason: `Действие ${name}${aim ? `: ${aim}` : ''} уже запускалось до сбоя (${item.id}), его исход неизвестен. ` +
          'Сначала проверь, выполнилось ли оно (прочитай файл, посмотри состояние). Если после проверки повтор нужен — ' +
          'вызови то же действие ещё раз: повтор будет записан как сверенный.'
      }
    }
    if (item) return { allowed: true, actionId: item.id }
    const cycle = cycleOf(name, aim, index)
    if (!cycle) return { allowed: true }
    cycle.cycle = true
    return {
      allowed: false, cycle: true, actionId: cycle.id,
      reason: `Действие ${name}${aim ? `: ${aim}` : ''} уже выполнялось (${cycle.id}), после него шла другая работа, ` +
        'а нового основания не появилось — это повтор A → B → A. Сначала проверь результат или назови, что мешает, ' +
        'вместо повторения того же шага.'
    }
  }

  // Модель посмотрела на цель действия с неизвестным исходом (прочитала тот же
  // файл, открыла тот же путь) — исход сверен наблюдением. Наблюдение принадлежит
  // смотрящему: чужое чтение не сверяет исход помощника (break-4 Н3). Без
  // индекса — прежний контракт (все агенты), его держат унаследованные вызовы.
  function observe(target, agentIndex = null) {
    const aim = clip(target, 200)
    if (!aim) return 0
    const scoped = Number.isSafeInteger(agentIndex) && agentIndex >= 0
    let count = 0
    for (const item of actions) {
      if (unresolved(item) && item.target === aim && (!scoped || item.agentIndex === agentIndex)) { item.resolution = 'observed'; count++ }
    }
    return count
  }

  // Чек-лист модели — предложение: из него заводятся требования. «Сделано»
  // модели — «проверяется»; пропавший из списка пункт остаётся в остатке.
  const PLAN_TARGET = { doing: 'in_progress', done: 'verifying', blocked: 'blocked' }
  function syncPlan(items, agentIndex = 0) {
    const index = Number.isSafeInteger(agentIndex) && agentIndex >= 0 ? agentIndex : 0
    for (const item of Array.isArray(items) ? items : []) {
      const id = `plan:${index}:${String(item?.id || '')}`
      if (!require({ id, expected: item?.title, criterion: item?.detail || '', origin: 'plan', agentIndex: index })) continue
      const req = find(id)
      const target = PLAN_TARGET[item.status]
      if (!target || req.state === target) continue
      const step = to => TRANSITIONS[req.state].includes(to) && shift(req, to, { by: 'agent', reason: 'чек-лист агента' })
      if (target === 'verifying' && req.state === 'confirmed') continue
      if (target === 'verifying' && !TRANSITIONS[req.state].includes('verifying')) step('in_progress')
      if (target === 'blocked' && req.state === 'confirmed') continue
      step(target)
    }
    settle()
  }

  // `agentIndex` — остаток одной параллельной задачи. Без него видно всё, и так
  // считает ведущий: его итог — общий. Помощника чужая незакрытая часть не
  // держит: доделать её он всё равно не вправе.
  function remainder(agentIndex = null) {
    const own = Number.isSafeInteger(agentIndex) && agentIndex >= 0
    const scope = item => !own || item.agentIndex === agentIndex
    const brief = req => ({ id: req.id, expected: req.expected, state: req.state, required: req.required })
    const mine = requirements.filter(scope)
    return {
      open: mine.filter(req => req.required && req.state !== 'confirmed' && req.state !== 'cancelled').map(brief),
      claimed: mine.filter(req => req.state === 'verifying').map(brief),
      stale: mine.filter(req => req.state === 'stale').map(brief),
      blocked: mine.filter(req => req.state === 'blocked').map(brief),
      unknownActions: actions.filter(item => unresolved(item) && scope(item)).map(copy)
    }
  }

  // null — требований нет: простая задача идёт коротким путём, решают прежние проверки.
  function complete(agentIndex = null) {
    if (!requirements.length) return null
    const left = remainder(agentIndex)
    // Помощник без единого своего требования не получает «готово» от состояния:
    // подтверждать нечего — короткий путь, а не молчаливая калитка (break-4 Н4).
    // Неизвестный исход держит и без требований.
    const own = Number.isSafeInteger(agentIndex) && agentIndex >= 0
    if (own && !requirements.some(item => item.agentIndex === agentIndex)) return left.unknownActions.length ? false : null
    return !left.open.length && !left.unknownActions.length
  }

  function snapshot() {
    return copy({ schemaVersion: 1, inputs, requirements, evidence, actions,
      ...(budget ? { budget: budget.snapshot() } : {}),
      droppedRequirements, droppedEvidence, droppedActions })
  }

  // Действие с неизвестным исходом могло изменить входы: подтверждения,
  // полученные до сбоя, перепроверяются, но не стираются.
  if (actions.some(unresolved)) bumpInput('workspace', 'исход действия неизвестен после сбоя')

  return Object.freeze({
    require, move, setInput, bumpInput, addEvidence, beginAction, endAction, discardAction, admit, observe,
    syncPlan, remainder, complete, snapshot, budget,
    get: id => { const req = find(id); return req ? copy(req) : null },
    action: id => { const item = actions.find(entry => entry.id === id); return item ? copy(item) : null },
    inputs: () => ({ ...inputs })
  })
}

module.exports = { STATES, TRANSITIONS, EVIDENCE_SOURCES, MAX_ACTIONS, createTaskState, cleanTaskState }
