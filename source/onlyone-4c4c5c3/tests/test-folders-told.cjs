// Several folders were plumbed all the way through — the sandbox let paths into
// them, `rootForPath` routed by folder name — and nothing ever told the agent
// they were there. The rule for addressing them lived only in the self-editing
// block, which appears when the app's own sources are attached and never
// otherwise. So the feature worked and could not be used: this checks that it is
// actually said out loud.
// Про текст режима. Раньше он собирался функцией buildAgentProtocol внутри
// главного процесса; теперь промпты режимов — данные, и проверяется настоящий
// режим «чат-агент».
const path = require('path')
const modePrompts = require('../src/main/mode-prompts')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// Labels are what the agent is told to type. Two folders with the same name are
// unreachable unless their labels differ, so the stub grows the second one — the
// same rule the app uses.
const leaf = p => String(p).split(/[\\/]/).filter(Boolean).pop() || p
const labelsFor = roots => {
  const seen = new Map()
  for (const r of roots) seen.set(leaf(r), (seen.get(leaf(r)) || 0) + 1)
  return roots.map((root, i) => {
    const parts = String(root).split(/[\\/]/).filter(Boolean)
    const clash = i > 0 && seen.get(leaf(root)) > 1 && parts.length > 1
    return { root, label: clash ? parts.slice(-2).join('/') : leaf(root) }
  })
}

const build = roots => modePrompts.buildModePrompt('agent', {
  toolNames: ['list_files', 'read_file', 'write_file', 'search_files'],
  rootLabels: labelsFor(roots),
  workspace: roots.length ? `Рабочая папка проекта: "${roots[0]}".` : '',
  mcpCount: 0, personal: '', language: ''
})

// One folder: nothing extra to say, and nothing extra is said.
const single = build(['D:/proj'])
check('с одной папкой лишнего блока нет',
  !/Рабочих папок несколько/.test(single), single.slice(0, 80))

// Several: every one named, with its full path, and the rule for reaching them.
const many = build(['D:/proj', 'D:/api', 'D:/web'])
check('сказано, что папок несколько', /Рабочих папок несколько/.test(many))
check('каждая папка названа',
  ['proj', 'api', 'web'].every(name => many.includes(name)), many.slice(0, 300))
check('у каждой указан полный путь',
  ['D:/proj', 'D:/api', 'D:/web'].every(p => many.includes(p)))
check('объяснено, как обратиться к файлу в другой папке',
  /начни путь с её имени из списка выше/.test(many))
check('пример использует настоящее имя второй папки',
  /api\/src\/index\.js/.test(many), many.slice(many.indexOf('начни путь'), many.indexOf('начни путь') + 120))
check('сказано, куда уходит путь без имени папки',
  /Путь без имени уходит в первую/.test(many) && /proj/.test(many))
check('сказано, что править можно в любой',
  /читать и править можно в любой/.test(many))

// The block has to sit with the tool rules, where the agent is told how to act,
// not somewhere it can be skimmed past.
check('блок стоит рядом с правилами инструментов',
  many.indexOf('Рабочих папок несколько') < many.indexOf('Не проси человека прислать'),
  'позиции ' + many.indexOf('Рабочих папок несколько') + ' и ' + many.indexOf('Не проси человека прислать'))

// No folders at all: no claims about folders that are not there.
const none = build([])
check('без папок про папки не сочиняется', !/Рабочих папок несколько/.test(none))

// Two folders with the same name used to make one of them unreachable: every
// path went to whichever came first, silently. That is exactly what happened
// with an installed build and the sources both called `app` and attached at
// once — the agent could not read the second folder at all.
const twins = build(['D:/app', 'D:/work/app'])
check('одинаковые имена разведены',
  /work\/app/.test(twins), twins.slice(0, 400))
check('короткое имя осталось у главной папки',
  /`app` — D:\/app/.test(twins), twins.slice(0, 300))
check('сказано, что при совпадении имя длиннее',
  /у второй имя длиннее/.test(twins))

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
