// The agent writes into the history from the main process while the window is
// still holding messages it has not saved yet. Reloading wholesale threw the
// user's own message away — the one asking for the work that was being done.
// This is the guard against losing it again.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')

const start = src.indexOf('  function mergeConversations(local, fromDisk) {')
const end = src.indexOf('  async function loadConversations() {')
if (start < 0 || end < 0) throw new Error('mergeConversations не найдена')

// eslint-disable-next-line no-new-func
const mergeConversations = new Function(src.slice(start, end) + '\nreturn mergeConversations')()

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}
const find = (list, id) => list.find(c => c.id === id)

// The exact loss that was reported: the user sends a message, the agent files a
// note elsewhere, the window reloads, and the message is gone.
const local = [
  { id: 'a', title: 'Рентабельность', updatedAt: 5, messages: [
    { role: 'user', content: 'сделай другой чат' },
    { role: 'assistant', content: 'делаю' }
  ] }
]
const disk = [
  { id: 'a', title: 'Рентабельность', updatedAt: 4, messages: [
    { role: 'user', content: 'сделай другой чат' }
  ] },
  { id: 'b', title: 'Новый от агента', updatedAt: 6, messages: [
    { role: 'assistant', content: 'итог', fromAgentNote: true }
  ] }
]

const merged = mergeConversations(local, disk)
check('ничего не потеряно', merged.length === 2, 'чатов ' + merged.length)
check('сообщение пользователя на месте',
  find(merged, 'a').messages.length === 2,
  JSON.stringify(find(merged, 'a').messages.map(m => m.role)))
check('чат, созданный агентом, виден', !!find(merged, 'b'))

// The other direction: the agent appended, this window has not caught up.
const merged2 = mergeConversations(
  [{ id: 'a', updatedAt: 1, messages: [{ role: 'user', content: 'вопрос' }] }],
  [{ id: 'a', updatedAt: 2, messages: [
    { role: 'user', content: 'вопрос' },
    { role: 'assistant', content: 'заметка агента', fromAgentNote: true }
  ] }]
)
check('дозапись агента подхватывается',
  find(merged2, 'a').messages.length === 2,
  JSON.stringify(find(merged2, 'a').messages.map(m => m.content)))

// A chat created here and not yet saved must survive the reload.
const merged3 = mergeConversations(
  [{ id: 'fresh', updatedAt: 9, messages: [{ role: 'user', content: 'первое' }] }],
  []
)
check('несохранённый чат не исчезает', !!find(merged3, 'fresh'))

// Metadata the other side learned about — a title, a topic — comes across even
// when the local message list wins.
const merged4 = mergeConversations(
  [{ id: 'a', title: 'Старое', updatedAt: 1, messages: [{ role: 'user', content: '1' }, { role: 'user', content: '2' }] }],
  [{ id: 'a', title: 'Новое', topic: 'только оплата', updatedAt: 2, messages: [{ role: 'user', content: '1' }] }]
)
check('новое название подхватывается', find(merged4, 'a').title === 'Новое', find(merged4, 'a').title)
check('тема подхватывается', find(merged4, 'a').topic === 'только оплата')
check('при этом сообщения не потеряны', find(merged4, 'a').messages.length === 2)

// Deleting a chat elsewhere must not be undone by a stale local copy — but a
// chat the window still holds messages for is not a deletion, it is a race.
// Both sides empty means nothing to argue about.
const merged5 = mergeConversations([], [{ id: 'x', updatedAt: 1, messages: [] }])
check('пустой список не ломает слияние', merged5.length === 1)

// --- обе стороны дописали одновременно ---------------------------------------
// Здесь терялось сообщение. Пользователь отправляет вопрос — он есть только в
// окне; в ту же секунду агент дописывает заметку — она есть только на диске.
// Длины сравнялись, и правило «берём ту сторону, что длиннее» отдавало победу
// диску: вопрос исчезал, а на его месте оставалась чужая заметка.
const bothWrote = mergeConversations(
  [{ id: 'a', updatedAt: 10, messages: [
    { role: 'user', content: 'первое', timestamp: 1 },
    { role: 'user', content: 'мой новый вопрос', timestamp: 20 }
  ] }],
  [{ id: 'a', updatedAt: 11, messages: [
    { role: 'user', content: 'первое', timestamp: 1 },
    { role: 'assistant', content: 'заметка агента', timestamp: 15 }
  ] }]
)
const bothMessages = find(bothWrote, 'a').messages
check('при одинаковой длине сохраняются обе стороны', bothMessages.length === 3,
  JSON.stringify(bothMessages.map(m => m.content)))
check('вопрос пользователя не потерян',
  bothMessages.some(m => m.content === 'мой новый вопрос'))
check('заметка агента не потеряна',
  bothMessages.some(m => m.content === 'заметка агента'))
check('порядок восстановлен по времени',
  bothMessages.map(m => m.timestamp).join(',') === '1,15,20',
  bothMessages.map(m => m.timestamp).join(','))

// Одно и то же сообщение с обеих сторон не должно задвоиться.
const noDupes = mergeConversations(
  [{ id: 'a', updatedAt: 1, messages: [{ role: 'user', content: 'вопрос', timestamp: 7 }] }],
  [{ id: 'a', updatedAt: 2, messages: [
    { role: 'user', content: 'вопрос', timestamp: 7 },
    { role: 'assistant', content: 'ответ', timestamp: 8 }
  ] }]
)
check('одинаковые сообщения не дублируются',
  find(noDupes, 'a').messages.length === 2,
  JSON.stringify(find(noDupes, 'a').messages.map(m => m.content)))

// Ответ, который печатается прямо сейчас, опознаётся по времени создания, а не
// по содержимому: содержимое растёт с каждым чанком, и по нему копия не совпала
// бы сама с собой — в ленте появился бы второй, обрезанный ответ.
const streaming = mergeConversations(
  [{ id: 'a', updatedAt: 2, messages: [
    { role: 'user', content: 'вопрос', timestamp: 1 },
    { role: 'assistant', content: 'уже напечатано половину', timestamp: 2 }
  ] }],
  [{ id: 'a', updatedAt: 1, messages: [
    { role: 'user', content: 'вопрос', timestamp: 1 },
    { role: 'assistant', content: '', timestamp: 2 }
  ] }]
)
check('идущий ответ не раздваивается',
  find(streaming, 'a').messages.length === 2,
  JSON.stringify(find(streaming, 'a').messages.map(m => m.content)))

// Newest first, so the sidebar order stays right.
const merged6 = mergeConversations(
  [{ id: 'old', updatedAt: 1, messages: [] }],
  [{ id: 'new', updatedAt: 99, messages: [] }]
)
check('порядок — свежие сверху', merged6[0].id === 'new', merged6.map(c => c.id).join(','))


// --- ссылки, захваченные идущим ходом ---------------------------------------
//
// This is where answers were disappearing. A turn captures the chat object when
// it starts. Over twenty minutes the agent writes project notes, each write
// fires conversations-changed, the window reloads and merges — and the merge
// used to hand back NEW objects with NEW message arrays. The captured reference
// became an orphan, and the answer pushed into it at the end was lost from the
// screen and from the file at once.

const held = { id: 'a', title: 'Идёт ход', updatedAt: 1, messages: [{ role: 'user', content: 'вопрос' }] }
const heldMessages = held.messages

const afterReload = mergeConversations([held], [
  { id: 'a', title: 'Новое имя', topic: 'тема', updatedAt: 2, messages: [{ role: 'user', content: 'вопрос' }] }
])

check('объект чата не подменяется', find(afterReload, 'a') === held,
  'вернулась копия, а не тот же объект')
check('массив сообщений тот же самый', find(afterReload, 'a').messages === heldMessages,
  'массив подменён')
check('при этом новое имя подхвачено', held.title === 'Новое имя', held.title)
check('и тема тоже', held.topic === 'тема')

// The answer arrives after the reload — into the reference the turn has held
// all along. It has to be visible in the merged list.
heldMessages.push({ role: 'assistant', content: 'вот ответ' })
check('ответ, дописанный после перезагрузки, виден в списке',
  find(afterReload, 'a').messages.some(m => m.content === 'вот ответ'),
  JSON.stringify(find(afterReload, 'a').messages.map(m => m.role)))

// The other direction: the disk copy is fuller, so its messages win — but the
// array the running turn holds must be the one that receives them.
const behind = { id: 'b', updatedAt: 1, messages: [{ role: 'user', content: 'вопрос' }] }
const behindMessages = behind.messages
const caughtUp = mergeConversations([behind], [
  { id: 'b', updatedAt: 5, messages: [
    { role: 'user', content: 'вопрос' },
    { role: 'assistant', content: 'заметка агента' }
  ] }
])
check('догоняя диск, объект остаётся прежним', find(caughtUp, 'b') === behind)
check('догоняя диск, массив остаётся прежним', behind.messages === behindMessages)
check('и в него попало то, что было на диске', behindMessages.length === 2,
  JSON.stringify(behindMessages.map(m => m.content)))

// --- правило, а не память о нём ---------------------------------------------
// Anything that writes to a chat after an await looks it up by id first. The
// merge above keeps references valid, but that is one function protecting
// another function's assumption, and the assumption is invisible where it
// matters. These check the rule is actually in the code.
const app = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')

check('ответ пишется в чат, найденный по id',
  /const target = conversations\.find\(c => c\.id === chat\.id\) \|\| chat[\s\S]{0,80}target\.messages\.push/.test(app))
check('время обновляется у него же',
  /target\.updatedAt = Date\.now\(\)/.test(app))
check('название тоже пишется по найденному',
  /const target = conversations\.find\(c => c\.id === chat\.id\)[\s\S]{0,200}target\.title = title/.test(app))
check('исчезнувший чат не переименовывается',
  /if \(!target\) return/.test(app))
check('никто больше не дописывает в захваченную ссылку',
  !/chat\.messages\.push\(\{/.test(app), 'нашлась прямая запись в chat.messages')

// Moving a chat into a project happens in the window and is saved a moment
// later. If an agent files a note in that moment, the reload it triggers used
// to write the older row back over the new one and the chat left the project
// on its own — which read as «проект то есть, то нет».
const moved = [{ id: 'm', title: 'Склад', projectId: 'магазин', updatedAt: 90, messages: [] }]
const onDisk = [{ id: 'm', title: 'Склад', projectId: null, updatedAt: 40, messages: [] }]
const afterMove = mergeConversations(moved, onDisk)
check('свежий перенос в проект переживает перезагрузку',
  find(afterMove, 'm').projectId === 'магазин', find(afterMove, 'm').projectId)

// The other direction has to keep working: what an agent wrote from the main
// process is newer, and the window has to take it.
const stale = [{ id: 'm', title: 'Склад', topic: null, updatedAt: 40, messages: [] }]
const written = [{ id: 'm', title: 'Склад', topic: 'учёт остатков', updatedAt: 90, messages: [] }]
const afterWrite = mergeConversations(stale, written)
check('тема, записанная агентом, доходит до окна',
  find(afterWrite, 'm').topic === 'учёт остатков', find(afterWrite, 'm').topic)

// Same timestamp means the window has nothing newer to protect, so disk wins.
const tieLocal = [{ id: 'm', title: 'Старое', updatedAt: 70, messages: [] }]
const tieDisk = [{ id: 'm', title: 'Новое', updatedAt: 70, messages: [] }]
check('при равном времени берётся диск',
  find(mergeConversations(tieLocal, tieDisk), 'm').title === 'Новое')

// The narrow case the newer-wins rule would otherwise break: the window is
// newer because the user just sent something, and the agent set a topic the
// window has never had one for. A field with nothing on this side cannot be an
// unsaved edit, so it comes across regardless of the clock.
const busy = [{ id: 'm', title: 'Склад', projectId: 'магазин', updatedAt: 120, messages: [] }]
const topical = [{ id: 'm', title: 'Склад', projectId: 'магазин', topic: 'учёт остатков', updatedAt: 90, messages: [] }]
const both = mergeConversations(busy, topical)
check('новая тема доходит, даже когда окно свежее',
  find(both, 'm').topic === 'учёт остатков', String(find(both, 'm').topic))
check('и свежий перенос при этом на месте',
  find(both, 'm').projectId === 'магазин', String(find(both, 'm').projectId))


// --- повтор остаётся повтором ------------------------------------------------
// У старых записей метки времени нет, и сообщение опознаётся по началу текста.
// Два одинаковых ответа подряд — «да», «да» — давали один ключ, и второе
// пропадало при каждом слиянии: переписка молча укорачивалась сама.
const twice = mergeConversations(
  [{ id: 'r', updatedAt: 2, messages: [
    { role: 'user', content: 'да' },
    { role: 'user', content: 'да' }
  ] }],
  [{ id: 'r', updatedAt: 1, messages: [] }]
)
check('два одинаковых сообщения не схлопываются в одно',
  find(twice, 'r').messages.length === 2,
  JSON.stringify(find(twice, 'r').messages.map(m => m.content)))

const thrice = mergeConversations(
  [{ id: 'r', updatedAt: 2, messages: [
    { role: 'user', content: 'да' }, { role: 'user', content: 'да' }, { role: 'user', content: 'да' }
  ] }],
  [{ id: 'r', updatedAt: 1, messages: [{ role: 'user', content: 'да' }] }]
)
check('повторы считаются, а не отмечаются',
  find(thrice, 'r').messages.length === 3,
  JSON.stringify(find(thrice, 'r').messages.map(m => m.content)))

// И обратное: одна и та же запись с двух сторон не должна задвоиться.
const sameBoth = mergeConversations(
  [{ id: 's', updatedAt: 1, messages: [{ role: 'user', content: 'вопрос', timestamp: 7 }] }],
  [{ id: 's', updatedAt: 2, messages: [{ role: 'user', content: 'вопрос', timestamp: 7 }] }]
)
check('одинаковая запись с двух сторон не задваивается',
  find(sameBoth, 's').messages.length === 1,
  JSON.stringify(find(sameBoth, 's').messages.map(m => m.content)))

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
