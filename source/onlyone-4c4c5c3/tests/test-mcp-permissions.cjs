// Reading through MCP should be free in auto mode; deleting must never be
// covered by a blanket yes, and wiping several things at once is refused
// outright — the owner asked that removals happen one at a time, on request.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

function lift(startMarker, endMarker, returns) {
  const start = src.indexOf(startMarker)
  const end = src.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error(`не найдено: ${startMarker}`)
  // eslint-disable-next-line no-new-func
  return src.slice(start, end) + '\nreturn ' + returns
}

const scope = new Function('workspace', 'sessionApprovalGranted',
  lift('function approvalRequired', 'async function requestApproval',
    '{ approvalRequired, classifyMcpTool, bulkDeleteRefusal }'))

let failed = 0
const check = (name, got, want) => {
  if (got !== want) { failed++; console.error(`ПРОВАЛ [${name}]: ${JSON.stringify(got)}, ожидалось ${JSON.stringify(want)}`) }
}

// --- what a tool is ---------------------------------------------------------
const { classifyMcpTool } = scope({ permission: 'auto' }, true)

for (const name of ['delete_note', 'notes_delete', 'purge_all', 'remove_file', 'drop_table', 'unlink_notes', 'archive_note']) {
  check('разрушительный ' + name, classifyMcpTool(name, {}), 'destructive')
}
for (const name of ['get_note', 'list_notes', 'search_knowledge', 'read_file', 'recent_activity', 'whoami', 'get_graph']) {
  check('чтение ' + name, classifyMcpTool(name, {}), 'read')
}
for (const name of ['create_note', 'update_note', 'upload_file', 'link_notes']) {
  check('изменение ' + name, classifyMcpTool(name, {}), 'external')
}
check('описание выдаёт удаление',
  classifyMcpTool('notes_op', { description: 'Безвозвратно удаляет запись' }), 'destructive')

// --- who has to confirm what ------------------------------------------------
const MODES = ['plan', 'manual', 'auto', 'acceptEdits']

for (const mode of MODES) {
  const granted = scope({ permission: mode }, true)
  const fresh = scope({ permission: mode }, false)

  // Deleting always asks, in every mode, even after a session-wide yes.
  check(`удаление спрашивает в ${mode}`, granted.approvalRequired('destructive'), true)
  check(`удаление спрашивает в ${mode} без гранта`, fresh.approvalRequired('destructive'), true)

  // Reading never asks. That is the whole point of the modes above plan.
  check(`чтение не спрашивает в ${mode}`, granted.approvalRequired('read'), false)
}

// Auto means auto. It used to ask once per session before the first write, and
// that single question was enough to stall a whole turn: the agent waits up to
// half an hour for a click, and a card that goes unnoticed is indistinguishable
// from a frozen app — measured as a five-minute stall that finished in 187
// seconds the moment the click happened.
check('auto не спрашивает про обычный вызов',
  scope({ permission: 'auto' }, false).approvalRequired('external'), false)
check('auto не спрашивает и про правку',
  scope({ permission: 'auto' }, false).approvalRequired('edit'), false)
check('auto не спрашивает и с грантом',
  scope({ permission: 'auto' }, true).approvalRequired('external'), false)

// The one thing auto does not cover, and must never cover: destroying data.
check('auto всё равно спрашивает про удаление',
  scope({ permission: 'auto' }, true).approvalRequired('destructive'), true)
check('и без гранта тоже',
  scope({ permission: 'auto' }, false).approvalRequired('destructive'), true)
check('manual спрашивает всегда',
  scope({ permission: 'manual' }, true).approvalRequired('external'), true)
check('plan запрещает запись',
  scope({ permission: 'plan' }, true).approvalRequired('edit'), true)

// --- bulk deletes are refused, not merely confirmed -------------------------
const { bulkDeleteRefusal } = scope({ permission: 'auto' }, true)

const refused = [
  ['список из нескольких', { ids: ['a', 'b', 'c'] }],
  ['слово all', { target: 'all' }],
  ['слово всё', { scope: 'всё' }],
  ['флаг bulk', { bulk: true, id: 'x' }]
]
for (const [what, args] of refused) {
  if (!bulkDeleteRefusal(args)) { failed++; console.error(`ПРОВАЛ: массовое удаление пропущено — ${what}`) }
}

const allowed = [
  ['одна запись', { id: 'note-1' }],
  ['список из одной', { ids: ['note-1'] }],
  ['пусто', {}]
]
for (const [what, args] of allowed) {
  if (bulkDeleteRefusal(args)) { failed++; console.error(`ПРОВАЛ: одиночное удаление отклонено — ${what}`) }
}

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
