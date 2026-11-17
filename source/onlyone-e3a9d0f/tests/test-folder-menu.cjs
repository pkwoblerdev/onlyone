// Working across several folders at once is what the folder button is for, and
// all of it — folders for every chat, for this chat, for the project — lived
// behind a right-click on a button that gave no sign of it. It looked, to the
// person who asked for the feature, exactly like it had not been built.
//
// План, 2.2: папки всех чатов — равноправный список, без «основной», которую
// можно только сменить, и без отдельного «работать без папки».
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')

const start = src.indexOf('    function folderMenuItems({ folders = [], chatFolders = [], project = null }) {')
const end = src.indexOf('    function openFolderMenu(x, y) {')
if (start < 0 || end < 0) throw new Error('folderMenuItems не найдена')

// eslint-disable-next-line no-new-func
const folderMenuItems = new Function('folderLeaf',
  src.slice(start, end) + '\nreturn folderMenuItems'
)(p => String(p).split(/[\\/]/).filter(Boolean).pop() || p)

// withGlobalFolders — та же функция, что хранит список: первая в path, остальные в extraPaths.
const helpersAt = src.indexOf('  function globalFolders(state = workspaceState) {')
const helpersEnd = src.indexOf('  async function addGlobalFolder() {')
if (helpersAt < 0 || helpersEnd < 0) throw new Error('globalFolders / withGlobalFolders не найдены')
// eslint-disable-next-line no-new-func
const helpers = new Function('workspaceState',
  src.slice(helpersAt, helpersEnd) + '\nreturn { globalFolders, withGlobalFolders }')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}
const labels = items => items.map(i => i.label || i.heading || '—').join(' | ')
const has = (items, re) => items.some(i => re.test(i.label || i.heading || ''))

// Nothing attached yet: every level offers to add, and nothing else.
const empty = folderMenuItems({})
check('без папок видно, как добавить папку всем чатам', has(empty, /^Добавить папку…$/), labels(empty))
check('без папок видно, как добавить папку только в чат', has(empty, /Только для этого чата/), labels(empty))
check('меню — один список без заголовков', !empty.some(i => i.heading), labels(empty))
check('«основной папки» больше нет', !has(empty, /основн/i), labels(empty))
check('отдельного «работать без папки» нет', !has(empty, /без папки/i), labels(empty))
check('без проекта пункта про проект нет', !has(empty, /проекта/), labels(empty))

// Folders for every chat are one list: each listed, each removable the same way.
const two = folderMenuItems({ folders: ['D:/proj', 'D:/docs'] })
check('обе папки всех чатов перечислены и отключаются одинаково',
  ['D:/proj', 'D:/docs'].every(f => two.some(i => i.action === 'drop-global' && i.folder === f)), labels(two))
check('у папки всех чатов пометка «все чаты», счётчиков «+N» нет', two.filter(i => i.action === 'drop-global').every(i => i.hint === 'все чаты') && !two.some(i => /^\+\d/.test(i.hint || '')), labels(two))

// Inside a project both offers are there, named so they cannot be confused.
const inProject = folderMenuItems({ folders: ['D:/proj'], project: { id: 'p1', name: 'Магазин', folders: ['D:/api'] } })
check('в проекте видно, как добавить папку проекту', has(inProject, /Для проекта/), labels(inProject))
check('пункт проекта называет проект по имени', inProject.some(i => i.action === 'add-project' && i.hint === 'Магазин'), labels(inProject))
check('папка проекта показана, чтобы её можно было убрать',
  inProject.some(i => i.action === 'drop-project' && i.folder === 'D:/api'), labels(inProject))

const many = folderMenuItems({
  folders: ['D:/proj', 'D:/docs'],
  chatFolders: ['D:/web', 'D:/api'],
  project: { id: 'p1', name: 'П', folders: ['D:/shared'] }
})
check('все подключённые папки перечислены',
  ['drop-global', 'drop-chat', 'drop-project'].every(a => many.some(i => i.action === a)),
  many.filter(i => i.action).map(i => i.action).join(','))
check('у папок чата пометка «этот чат»', many.filter(i => i.action === 'drop-chat').every(i => i.hint === 'этот чат'), labels(many))
check('в списке показано короткое имя папки', many.some(i => i.label === 'web'), labels(many))
check('у каждого действия есть обработчик',
  many.filter(i => i.label && !i.separator && !i.heading).every(i => Boolean(i.action)),
  many.filter(i => i.label && !i.action).map(i => i.label).join(','))

// Хранение: старый формат, первая — path. Отключили первую — её место заняла следующая.
const { globalFolders, withGlobalFolders } = helpers({ path: 'D:/proj', extraPaths: ['D:/docs', 'D:/web'], permission: 'auto' })
check('список читается из path и extraPaths', globalFolders().join(',') === 'D:/proj,D:/docs,D:/web', globalFolders().join(','))
const dropped = withGlobalFolders(['D:/docs', 'D:/web'])
check('отключили первую — следующая стала первой, остальное не потерялось',
  dropped.path === 'D:/docs' && dropped.extraPaths.join(',') === 'D:/web' && dropped.permission === 'auto', JSON.stringify(dropped))
const none = withGlobalFolders([])
check('последнюю отключили — папок нет', none.path === '' && none.extraPaths.length === 0, JSON.stringify(none))
check('повтор не задваивается', withGlobalFolders(['D:/a', 'D:/a', 'D:/b']).extraPaths.join(',') === 'D:/b')

// Поломка 30.09: пункт «Добавить папку» в меню «+» звал openFolderMenu, которая
// живёт внутри setupEventListeners и из обработчика «+» не видна, — нажатие не
// делало ничего. Пункт обязан звать то, что видно из его области.
const attachAt = src.indexOf("pane.dom.attachBtn?.addEventListener('click'")
const attachEnd = src.indexOf('event.stopPropagation()', attachAt)
const attachBlock = attachAt >= 0 && attachEnd > attachAt ? src.slice(attachAt, attachEnd) : ''
const addLine = attachBlock.split(/\r?\n/).find(line => line.includes("t('Добавить папку')")) || ''
check('меню «+»: обработчик найден', attachBlock.length > 0)
check('меню «+»: «Добавить папку» не зовёт openFolderMenu из чужой области видимости', addLine !== '' && !/openFolderMenu/.test(addLine), addLine.trim())
check('меню «+»: «Добавить папку» ведёт к выбору папки (addGlobalFolder)', /addGlobalFolder\s*\(/.test(addLine), addLine.trim())

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
