// Several working folders share one sandbox, so the guarantee has to hold for
// each of them separately: a path may reach into any configured root and into
// nothing else. Getting this wrong would hand the agent the whole disk.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const start = src.indexOf('const turnScope = new AsyncLocalStorage()')
const end = src.indexOf("async function assertSafeWorkspacePath(relativePath = '.') {")
if (start < 0 || end < 0) throw new Error('workspaceRoots / rootForPath не найдены')

let workspace = { path: '', extraPaths: [] }
// Folders can also hang off the project being worked in and off one chat.
let projectFolders = []
let chatFolders = []

// eslint-disable-next-line no-new-func
const build = new Function('workspace', 'resolve', 'basename', 'projectFolders', 'chatFolders',
  src.slice(start, end)
    // The folders belong to the running turn now. Here the turn is the test.
    .replace('const turnScope = new AsyncLocalStorage()', 'const turnScope = null')
    .replace('const turnHere = () => turnScope.getStore() || lastTurnHere',
      'const turnHere = () => ({ projectFolders, chatFolders })') +
  '\nreturn { workspaceRoots, rootForPath, runFolders, rootLabels }'
)

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const api = () => build(workspace, path.resolve, path.basename, projectFolders, chatFolders)

// --- which folders exist ------------------------------------------------------
workspace = { path: '', extraPaths: [] }
check('без папок корней нет', api().workspaceRoots().length === 0)

workspace = { path: 'D:/proj', extraPaths: [] }
check('одна папка — один корень', api().workspaceRoots().length === 1)

workspace = { path: 'D:/proj', extraPaths: ['D:/docs', 'D:/design'] }
check('три папки — три корня', api().workspaceRoots().length === 3)

// A folder listed twice must not become two roots.
workspace = { path: 'D:/proj', extraPaths: ['D:/proj', 'D:/docs', 'D:/docs'] }
check('дубликаты схлопываются', api().workspaceRoots().length === 2,
  JSON.stringify(api().workspaceRoots()))

// Empty entries are ignored rather than resolving to the process directory.
workspace = { path: 'D:/proj', extraPaths: ['', '   '] }
check('пустые записи отброшены', api().workspaceRoots().length === 1,
  JSON.stringify(api().workspaceRoots()))

// --- which root a path belongs to --------------------------------------------
workspace = { path: 'D:/proj', extraPaths: ['D:/docs', 'D:/design'] }
const { rootForPath } = api()

const main = rootForPath('src/index.js')
check('путь без префикса — основная папка',
  path.basename(main.root) === 'proj' && main.rest === 'src/index.js',
  JSON.stringify(main))

const docs = rootForPath('docs/readme.md')
check('префикс уводит в свою папку',
  path.basename(docs.root) === 'docs' && docs.rest === 'readme.md',
  JSON.stringify(docs))

const design = rootForPath('design/tokens/colors.json')
check('вложенный путь во второй папке',
  path.basename(design.root) === 'design' && design.rest === 'tokens/colors.json',
  JSON.stringify(design))

// The prefix on its own means the folder itself, not an empty path.
const bare = rootForPath('docs')
check('голый префикс — сама папка',
  path.basename(bare.root) === 'docs' && bare.rest === '.', JSON.stringify(bare))

// Case should not decide which folder is meant.
const upper = rootForPath('DOCS/readme.md')
check('регистр префикса не важен', path.basename(upper.root) === 'docs', JSON.stringify(upper))

// A name that matches nothing stays with the main folder rather than escaping.
const unknown = rootForPath('elsewhere/file.txt')
check('незнакомый префикс остаётся в основной папке',
  path.basename(unknown.root) === 'proj' && unknown.rest === 'elsewhere/file.txt',
  JSON.stringify(unknown))

// With a single folder nothing is reinterpreted — old behaviour intact.
workspace = { path: 'D:/proj', extraPaths: [] }
const single = api().rootForPath('docs/readme.md')
check('с одной папкой префикс не срабатывает',
  path.basename(single.root) === 'proj' && single.rest === 'docs/readme.md',
  JSON.stringify(single))

// No folders at all: nothing to resolve against.
workspace = { path: '', extraPaths: [] }
check('без папок путь никуда не ведёт', api().rootForPath('a.txt') === null)

// --- папки проекта и одного чата ---------------------------------------------
// Один чат может охватывать бэкенд и фронтенд, и при этом остальные чаты этих
// папок не наследуют. Папки проекта, наоборот, следуют за ним везде.
workspace = { path: 'D:/proj', extraPaths: [] }
projectFolders.length = 0; projectFolders.push('D:/api', 'D:/web')
chatFolders.length = 0
check('папки проекта становятся корнями', api().workspaceRoots().length === 3,
  JSON.stringify(api().workspaceRoots()))

projectFolders.length = 0
chatFolders.length = 0
chatFolders.push('D:/scratch')
check('папка чата становится корнем', api().workspaceRoots().length === 2,
  JSON.stringify(api().workspaceRoots()))

projectFolders.length = 0; projectFolders.push('D:/api')
chatFolders.length = 0
chatFolders.push('D:/api', 'D:/scratch')
check('папка, названная и там и там, не задваивается',
  api().workspaceRoots().length === 3, JSON.stringify(api().workspaceRoots()))

// The same guard as everywhere else: a blank entry must never resolve to the
// app's own source tree.
projectFolders.length = 0; projectFolders.push('', '   ')
chatFolders.length = 0
chatFolders.push('')
check('пустые записи проекта и чата игнорируются',
  api().workspaceRoots().length === 1, JSON.stringify(api().workspaceRoots()))

// A path prefixed with a project folder's name lands in that folder.
projectFolders.length = 0; projectFolders.push('D:/api')
chatFolders.length = 0
const routed = api().rootForPath('api/server.js')
check('путь по имени папки проекта уходит в неё',
  routed.root === path.resolve('D:/api') && routed.rest === 'server.js',
  JSON.stringify(routed))

// A folder attached to the chat is sandboxed like any other root, not more.
projectFolders.length = 0
chatFolders.length = 0
chatFolders.push('D:/scratch')
const outside = api().rootForPath('scratch/../../etc/passwd')
check('выход за пределы папки чата не открывает диск',
  outside.root === path.resolve('D:/proj') || outside.root === path.resolve('D:/scratch'),
  JSON.stringify(outside))

projectFolders.length = 0
chatFolders.length = 0

// --- две папки с одинаковым именем ------------------------------------------
// Routing is by folder name, so two folders called the same thing left one of
// them unreachable: every path went to whichever came first, and nothing said
// so. Exactly what happened with an installed build and the sources — both
// called `app` — attached to one project. The agent could not read the second
// folder at all.
workspace = { path: 'D:/app', extraPaths: [] }
projectFolders.length = 0
projectFolders.push('D:/app', 'D:/work/app')
chatFolders.length = 0

const twins = api().rootLabels()
check('имена разведены', twins[0].label !== twins[1].label,
  twins.map(t => t.label).join(' | '))
check('главная папка сохранила короткое имя', twins[0].label === 'app', twins[0].label)
check('в имени второй нет буквы диска', !/^[a-z]:/i.test(twins[1].label), twins[1].label)

const installed = api().rootForPath('app/resources/app.asar')
check('короткое имя ведёт в главную папку',
  installed.root === path.resolve('D:/app') && installed.rest === 'resources/app.asar',
  JSON.stringify(installed))

const sources = api().rootForPath('work/app/src/main/main.js')
check('длинное имя ведёт во вторую папку',
  sources.root === path.resolve('D:/work/app') && sources.rest === 'src/main/main.js',
  JSON.stringify(sources))

// A path with no folder name still belongs to the main folder, as before.
const unprefixed = api().rootForPath('src/main/main.js')
check('путь без имени по-прежнему уходит в главную',
  unprefixed.root === path.resolve('D:/app'), JSON.stringify(unprefixed))

// Backslashes are what Windows models write; they have to route the same way.
const backslashes = api().rootForPath('work\\app\\src\\x.js')
check('обратные слэши маршрутизируются так же',
  backslashes.root === path.resolve('D:/work/app'), JSON.stringify(backslashes))

workspace = { path: '', extraPaths: [] }
projectFolders.length = 0

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
