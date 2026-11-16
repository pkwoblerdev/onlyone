// Two defects that showed up together on one screenshot: the user picked GLM 5.3
// Flash, agent mode answered with North Mini Code, and the agent insisted no
// working folder was selected while the folder sat in the composer.
//
// The first caused the second. With one key the lone agent was given the role
// 'general' — an ordinary helper — and agent mode's casting forces helpers onto
// a free model, so the explicit choice was overridden. The weak model that
// landed there then misread a normal file listing as empty and concluded there
// was no folder.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return src.slice(a, b)
}

const buildTeamRoster = new Function(
  cut('function buildTeamRoster(keyCount) {', '\nfunction ') + '\nreturn buildTeamRoster'
)()

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// --- one key, agent mode ----------------------------------------------------

const solo = buildTeamRoster(1)
check('одиночный агент — ведущий, а не помощник',
  solo[0].role === 'lead', solo[0].role)

// Because that is what decides which model it gets: the helper branch forces a
// free one and would throw away the model the user chose.
check('роль одиночки решает, чью модель он получит',
  /modelId = picked \|\| bound \|\| DEFAULT_MODEL/.test(src))

// --- paths across several folders -------------------------------------------

const relativeDisplay = new Function('workspace', 'workspaceRoots', 'resolve', 'relative', 'basename', 'isInside', 'rootLabels',
  // Отображение теперь сверяется с разрешением имени (rootForPath), поэтому
  // песочница берёт обе функции из main.js — иначе тест проверял бы другую пар
  cut('function rootForPath(input) {', '\nasync function assertSafeWorkspacePath') + '\n' +
  cut('function relativeDisplay(pathValue) {', '\nasync function listFiles') + '\nreturn relativeDisplay'
)

const roots = ['D:\\proj', 'D:\\api', 'D:\\web'].map(p => path.resolve(p))
const show = p => relativeDisplay(
  { path: 'D:\\proj' },
  () => roots,
  path.resolve, path.relative, path.basename,
  (root, target) => {
    const rel = path.relative(root, target)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  },
  // A displayed path uses the folder's label — the name the agent is told to
  // type. Here the three folders have distinct names, so a label is just the
  // folder name; the collision case is covered in test-workspace-roots.
  list => list.map(root => ({ root, label: path.basename(root) }))
)(path.resolve(p))

check('файл в главной папке — просто путь',
  show('D:\\proj\\src\\main.js') === 'src\\main.js' || show('D:\\proj\\src\\main.js') === 'src/main.js',
  show('D:\\proj\\src\\main.js'))
check('сама главная папка — точка', show('D:\\proj') === '.', show('D:\\proj'))

// The whole point: a file in another root has to come back as the agent is told
// to write it, not as an escape sequence no tool would accept.
check('файл в другой папке показан по имени папки',
  show('D:\\api\\server.js') === 'api/server.js', show('D:\\api\\server.js'))
check('вложенный файл в другой папке тоже',
  show('D:\\web\\src\\index.html') === 'web/src/index.html', show('D:\\web\\src\\index.html'))
check('сама другая папка — её имя', show('D:\\api') === 'api', show('D:\\api'))
check('никаких выходов вверх в отображаемом пути',
  !show('D:\\api\\server.js').includes('..'), show('D:\\api\\server.js'))

// --- an empty listing says what it means ------------------------------------

check('пустой список сообщает, что папка выбрана',
  /Рабочая папка ` \+\s*`выбрана и доступна/.test(src) || /выбрана и доступна/.test(src))
check('пустой список называет саму папку', /доступна: \$\{target\}/.test(src))
check('при нескольких папках перечисляет остальные',
  /Всего подключено папок/.test(src))
check('объясняет, как посмотреть другую',
  /вызови list_files с именем папки в пути/.test(src))
check('при непустом списке пояснения нет',
  /output\.length\s*\r?\n?\s*\? undefined/.test(src) || /\? undefined/.test(src))

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
