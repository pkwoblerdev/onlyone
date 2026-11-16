// Two panes can generate at the same time — the send guard is `pane.generating`,
// which is per pane, not per window. Everything the running turn knows about
// where it stands (its chat, its project, its folders) used to live in module
// globals, so the second pane's send replaced the first pane's context while it
// was still running.
//
// The damage is quiet and specific: an agent halfway through a turn in one
// project starts resolving paths against another project's folders and filing
// its notes into another project's chats. This is the test that would have
// caught it, so it is written the way the failure happened — two turns
// overlapping, the second starting while the first is between tool calls.
const fs = require('fs')
const path = require('path')
const { AsyncLocalStorage } = require('async_hooks')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// --- the shape of the thing, read out of the file itself ---------------------
check('контекст хода живёт в AsyncLocalStorage',
  /const turnScope = new AsyncLocalStorage\(\)/.test(src),
  'контекст всё ещё глобальный')
check('обработчик открывает область на весь ход',
  /return turnScope\.run\(here, async \(\) => \{/.test(src))

// The old globals are what the bug was made of; a leftover one means some reader
// is still answering for whichever turn wrote last.
for (const gone of ['currentProjectIdForRun', 'currentChatIdForMemory',
  'currentChatFoldersForRun', 'currentProjectFoldersForRun']) {
  check(`глобальная ${gone} убрана`, !src.includes(gone),
    'осталось ' + (src.match(new RegExp(gone, 'g')) || []).length + ' упоминаний')
}

// Every reader has to go through the turn.
check('проект берётся из хода', /const \{ projectId \} = turnHere\(\)/.test(src))
check('папки берутся из хода',
  /const here = turnHere\(\)\s*\n\s*for \(const list of \[here\.projectFolders, here\.chatFolders\]\)/.test(src))
check('чат для памяти берётся из хода',
  /buildMemoryBlock\(turnHere\(\)\.chatId\)/.test(src))

// --- and that it actually holds under two overlapping turns ------------------
// The extracted pieces, run for real: one turn is started, a second turn starts
// while the first is suspended, and the first has to come back to its own.
const turnScope = new AsyncLocalStorage()
let lastTurnHere = { chatId: null, projectId: null, chatFolders: [], projectFolders: [] }
const turnHere = () => turnScope.getStore() || lastTurnHere

function startTurn(payload, body) {
  const here = {
    chatId: payload.chatId || null,
    projectId: payload.projectId || null,
    chatFolders: payload.chatFolders || [],
    projectFolders: payload.projectFolders || []
  }
  lastTurnHere = here
  return turnScope.run(here, body)
}

const wait = ms => new Promise(done => setTimeout(done, ms))

async function main() {
  const seen = {}

  const first = startTurn(
    { chatId: 'chat-A', projectId: 'магазин', projectFolders: ['D:/магазин'] },
    async () => {
      // A turn spends most of its life awaiting: a stream, a tool, a file read.
      await wait(40)
      seen.afterAwait = turnHere()
      await wait(40)
      seen.atEnd = turnHere()
      return 'первый'
    })

  await wait(15)

  const second = startTurn(
    { chatId: 'chat-B', projectId: 'бот', projectFolders: ['D:/бот'] },
    async () => {
      await wait(10)
      seen.other = turnHere()
      return 'второй'
    })

  await Promise.all([first, second])

  check('первый ход остаётся в своём проекте после ожидания',
    seen.afterAwait?.projectId === 'магазин', seen.afterAwait?.projectId)
  check('первый ход остаётся в своём проекте и в конце',
    seen.atEnd?.projectId === 'магазин', seen.atEnd?.projectId)
  check('первый ход остаётся в своём диалоге',
    seen.atEnd?.chatId === 'chat-A', seen.atEnd?.chatId)
  // The folders decide which files the agent may touch at all, so this is the
  // one that turns a mix-up into reading another project's code.
  check('первый ход не получает чужие папки',
    JSON.stringify(seen.atEnd?.projectFolders) === JSON.stringify(['D:/магазин']),
    JSON.stringify(seen.atEnd?.projectFolders))
  check('второй ход видит свой проект',
    seen.other?.projectId === 'бот', seen.other?.projectId)

  console.log(JSON.stringify({ ok: failed === 0, failed }))
  process.exit(failed ? 1 : 0)
}

main()
