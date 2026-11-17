// Обычный ход — это обычный ход.
//
// Жалоба звучала так: «вообще к каждому сообщению применяется агент-режим, это
// ошибка». Так и было. Окно ставило в каждую отправку `collaborative: true`, а
// главный процесс читает этот флаг как прямую просьбу пользователя работать
// командой: ведущему запрещалось отвечать самому, и, если он всё-таки не звал
// assign_work, поручения выписывались за него принудительно. «Привет» уходило в
// работу трём моделям. Вдобавок панель работы на каждое сообщение рисовала двоих
// «Ожидает назначения», которые ничего не ждали.
//
// Команда собирается по двум причинам и только по ним: пользователь попросил её
// словами, либо ведущий сам решил, что задача делится. Всё остальное — один
// агент, один ответ.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const CR = String.fromCharCode(13)
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').split(CR).join('')
const main = read('src', 'main', 'main.js')
const renderer = read('src', 'renderer', 'app.js')

const cut = (from, to) => {
  const a = main.indexOf(from)
  const b = main.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return main.slice(a, b)
}

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// --- окно не объявляет каждый ход командным -------------------------------------

// Отправка обычного сообщения. Ровно тот вызов, который делает окно на Enter.
const chatSend = renderer.slice(
  renderer.indexOf('serverResponse = await window.electronAPI.sendMessage({'),
  renderer.indexOf('params: { useTools: true }',
    renderer.indexOf('serverResponse = await window.electronAPI.sendMessage({')))

check('обычная отправка не помечена командной',
  !/collaborative:\s*true/.test(chatSend),
  'флаг вернулся в обычную отправку — снова каждый ход командный')

// Решение владельца 07.10: команда — только по просьбе, и в Design тоже. Раздел сам по себе её не объявляет:
// раньше каждое сообщение там собирало ведущего и двух помощников.
const designSend = renderer.slice(
  renderer.indexOf('const response = await window.electronAPI.sendMessage({'),
  renderer.indexOf('params: { useTools: true }',
    renderer.indexOf('const response = await window.electronAPI.sendMessage({')))
check('в Design команда не объявляется на каждое сообщение', !/collaborative:\s*true/.test(designSend))

// --- что именно считается просьбой о команде ------------------------------------

const isCollaborativeRequest = new Function('lastUserMessage',
  cut('function isCollaborativeRequest(payload)', '// ---') + '; return isCollaborativeRequest')(
  payload => payload.messages.filter(m => m.role === 'user').at(-1)?.content || '')

const ask = (text, extra = {}) => isCollaborativeRequest({
  messages: [{ role: 'user', content: text }], ...extra
})

for (const text of [
  'привет',
  'спасибо, всё работает',
  'почини кнопку отправки',
  'что делает команда git rebase',
  'перепиши этот компонент на таблицу',
  'найди ошибку в main.js'
]) {
  check('обычная просьба остаётся одиночной: ' + text, ask(text) === false)
}

for (const text of [
  'работайте вместе над этим',
  'включи агент-режим',
  'подключи несколько моделей',
  'соберите команду и разберите проект',
  'устройте дискуссию и решите'
]) {
  check('просьба о команде слышна: ' + text, ask(text) === true)
}

check('прямое «сделай сам» сильнее всего', ask('работайте вместе — нет, сделай сам') === false)
check('Design без просьбы о команде — один агент', ask('поправь отступы', { designId: 'd1' }) === false)
check('Design с просьбой о команде — команда', ask('работайте вместе над макетом', { designId: 'd1' }) === true)

// --- панель работы не выдумывает участников --------------------------------------

const mode = cut('async function runAgentMode(event', '\n// A tool call written')

check('состав объявляется только для настоящей команды',
  /const roster = isCollab \? slots : \[lead\]/.test(mode),
  'снова объявляются все слоты — «Ожидает назначения» на каждом сообщении')

check('«Ожидает назначения» не достаётся тому, кого не позвали',
  !/slots\.forEach\(\(slot, i\) => \{[\s\S]{0,400}Ожидает назначения/.test(mode))

const launchStart = mode.indexOf('const launch = item => {')
const launchEnd = mode.indexOf('\n\n    // Часть ждёт только того', launchStart)
check('помощник объявляется в момент запуска, а не заранее',
  launchStart >= 0 && launchEnd > launchStart && /stage\(slot,/.test(mode.slice(launchStart, launchEnd)))

// --- бриф ведущего не требует делить всё подряд -----------------------------------
//
// Флаг из окна убрать мало: пока в самом брифе написано «ВСЕГДА командой»,
// ведущий продолжит раздавать поручения на «спасибо». Мандат на обязательное
// деление приходит отдельным абзацем и только когда пользователь попросил.

// Бриф ведущего — данными в ./mode-prompts/team.js (план, 6.2).
const lead = require('../src/main/mode-prompts/team').leadBrief(3, '')
check('ведущему не велено делить всегда', !/ВСЕГДА/.test(lead))
check('ведущему сказано, когда делить не нужно',
  /Задача на один шаг/.test(lead) && /решается тобой и заканчивается ответом/.test(lead))
check('деление названо условием, а не обязанностью',
  /\*\*Раздели работу, если она делится\.\*\*/.test(lead))
check('выдуманная часть названа вредной',
  /Выдуманная часть хуже её отсутствия/.test(lead))

// --- принуждение к раздаче — только по просьбе ------------------------------------

check('запрет отвечать самому привязан к просьбе пользователя',
  /const collabNote = \(round === 1 && isCollab\)/.test(mode))
check('требование делегировать привязано к просьбе пользователя',
  /requireDelegation: round === 1 && isCollab && helpers\.length > 0/.test(mode))
const fallbackStart = mode.indexOf('if (!plan?.assignments?.length &&')
const fallbackEnd = mode.indexOf(') {', fallbackStart)
const fallbackCondition = mode.slice(fallbackStart + 'if ('.length, fallbackEnd)
const shouldFallback = new Function('plan', 'round', 'isCollab', 'helpers', 'signal',
  `return Boolean(${fallbackCondition})`)
check('принудительная раздача только для явной просьбы в первом круге',
  shouldFallback(null, 1, true, [{}], null) &&
  !shouldFallback({assignments: [{}]}, 1, true, [{}], null) &&
  !shouldFallback(null, 2, true, [{}], null) &&
  !shouldFallback(null, 1, false, [{}], null) &&
  !shouldFallback(null, 1, true, [], null) &&
  !shouldFallback(null, 1, true, [{}], {aborted: true}))

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
