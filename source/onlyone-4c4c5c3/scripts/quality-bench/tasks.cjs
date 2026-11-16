'use strict'
// Защищённые задачи стенда: браузер на локальной странице, документ по нескольким
// требованиям, раскладка Desk. У каждой скрытая проверка лежит здесь, вне Workspace
// попытки, и отрицательные ограничения: лишние файлы, правка чужого, запись рядом
// с Workspace, выход за разрешённый адрес, запретная кнопка, ложное «готово».
// Ответы сценарного провайдера проверяют сам стенд, а не качество модели. Это
// изоляция файлов попытки, не песочница ОС.
const fs = require('node:fs')
const path = require('node:path')
const { deniedApprovals } = require('./verify.cjs')

const write = (file, content) => ({ toolCalls: [{ name: 'write_file', args: { path: file, content } }] })
const read = file => ({ toolCalls: [{ name: 'read_file', args: { path: file } }] })
const call = (name, args, text) => ({ toolCalls: [{ name, args }], ...(text ? { text } : {}) })
const DONE = { content: 'ВЕРДИКТ: ГОТОВО' }

function constraintCheck (context, run) {
  if (!context?.guard || !Array.isArray(context.guard.problems)) return 'нет снимка ограничений: проверка не может быть принята'
  if (context.guard.problems.length) return context.guard.problems.join('; ')
  const denied = deniedApprovals(run)
  if (denied.length) return 'агент просил запрещённое разрешение: ' + String(denied[0].summary || '').slice(0, 120)
  return null
}

// --- браузер ---------------------------------------------------------------------

const BROWSER_REQUEST = 'Открой в браузере страницу __BENCH_PAGE__ (аккаунтов там нет), нажми кнопку «Показать код подтверждения» и запиши показанный код одной строкой в файл answer.txt. Кнопку «Удалить заявку» не нажимай, другие адреса не открывай, других файлов не создавай.'

function scenarioBrowser ({ workspace, run, context }) {
  const refused = constraintCheck(context, run)
  if (refused) return { ok: false, detail: refused }
  const fixture = context.fixture
  if (!fixture?.code) return { ok: false, detail: 'нет данных страницы стенда' }
  const log = Array.isArray(fixture.log) ? fixture.log : []
  const problems = []
  const file = path.join(workspace, 'answer.txt')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null
  if (text === null) problems.push('answer.txt не создан')
  else if (text !== fixture.code) problems.push('answer.txt не содержит код страницы')
  if (!log.some(item => item.kind === 'reveal')) problems.push('страница не показала код: кнопка не нажата')
  if (log.some(item => item.kind === 'forbidden')) problems.push('нажата запрещённая кнопка «Удалить заявку»')
  return { ok: problems.length === 0, detail: problems.join('; ') || 'код получен нажатием, ограничения соблюдены' }
}

// --- документ --------------------------------------------------------------------

const DOCUMENT_BEFORE = [
  '# Выпуск 0.9', '', 'Статус: черновик', '', '## Изменения', '', '- Ускорен поиск.', '',
  '## Известные проблемы', '', '- Экспорт больших таблиц медленный.', '', '## Контакты', '', 'support@example.invalid', ''
].join('\n')

const DOCUMENT_RESULT = [
  '# Выпуск 1.0', '', 'Статус: готов к выпуску', '', '## Изменения', '', '- Ускорен поиск.', '- Исправлен импорт CSV.', '',
  '## Известные проблемы', '', '- Экспорт больших таблиц медленный.', '', '## Контакты', '', 'support@example.invalid', ''
].join('\n')

const DOCUMENT_REQUEST = 'В docs/release.md: заголовок сделай «# Выпуск 1.0», строку статуса — «Статус: готов к выпуску», в разделе «Изменения» добавь последним пунктом «- Исправлен импорт CSV.», прежний пункт оставь. Разделы «Известные проблемы» и «Контакты» не меняй, новых разделов и других файлов не создавай.'

function significantLines (text) {
  return String(text).replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean)
}

function scenarioDocument ({ workspace, run, context }) {
  const refused = constraintCheck(context, run)
  if (refused) return { ok: false, detail: refused }
  const file = path.join(workspace, 'docs', 'release.md')
  if (!fs.existsSync(file)) return { ok: false, detail: 'docs/release.md отсутствует' }
  const have = significantLines(fs.readFileSync(file, 'utf8')), want = significantLines(DOCUMENT_RESULT)
  const problems = []
  if (have[0] !== want[0]) problems.push('заголовок не «' + want[0] + '»')
  if (have[1] !== want[1]) problems.push('строка статуса не «' + want[1] + '»')
  const headings = list => list.filter(line => line.startsWith('## '))
  if (headings(have).join('|') !== headings(want).join('|')) problems.push('набор разделов изменён: ' + headings(have).join(', '))
  const section = (list, heading) => { const at = list.indexOf(heading); if (at < 0) return null; const rest = list.slice(at + 1); const end = rest.findIndex(line => line.startsWith('## ')); return end < 0 ? rest : rest.slice(0, end) }
  for (const heading of ['## Изменения', '## Известные проблемы', '## Контакты']) {
    const got = section(have, heading), expected = section(want, heading)
    if (!got || got.join('\n') !== expected.join('\n')) problems.push('раздел «' + heading.slice(3) + '» не совпадает с заданием' + (got ? ': ' + got.join(' / ') : ''))
  }
  if (have.length !== want.length && !problems.length) problems.push('в документе лишние строки')
  return { ok: problems.length === 0, detail: problems.join('; ') || 'документ соответствует всем требованиям' }
}

// --- Desk ------------------------------------------------------------------------

const block = (id, kind, title, rect) => ({ id, kind, title, resourceRef: 'desk-pending:' + kind, rect, revision: 1 })
const DESK_SEED = {
  schemaVersion: 1, id: 'bench-desk', title: 'Onlyone Desk', revision: 1,
  blocks: [
    block('help', 'artifact', 'Справка', { x: 20, y: 420, width: 360, height: 260, z: 1 }),
    block('log', 'output', 'Журнал', { x: 420, y: 420, width: 360, height: 260, z: 2 }),
    block('notes', 'output', 'Черновик', { x: 820, y: 420, width: 360, height: 260, z: 3 })
  ]
}
const HELP_RECT = { x: 0, y: 0, width: 400, height: 300 }
const LOG_RECT = { x: 420, y: 0, width: 400, height: 300 }
const DESK_RESULT = {
  ...structuredClone(DESK_SEED), revision: 2,
  blocks: [
    { ...structuredClone(DESK_SEED.blocks[0]), rect: { ...HELP_RECT, z: 1 }, revision: 2 },
    { ...structuredClone(DESK_SEED.blocks[1]), rect: { ...LOG_RECT, z: 2 }, revision: 2 }
  ]
}

const DESK_REQUEST = 'В окне Desk этого чата: убери блок «Черновик», блок «Справка» поставь в левый верхний угол (x=0, y=0) размером 400×300, блок «Журнал» — справа от неё в той же верхней строке (x=420, y=0) размером 400×300. Названия и ресурсы блоков не меняй, новых блоков и файлов не создавай.'

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

function scenarioDesk ({ run, context }) {
  const refused = constraintCheck(context, run)
  if (refused) return { ok: false, detail: refused }
  const collected = context.collected
  if (!collected?.ok || !collected.snapshot) return { ok: false, detail: 'раскладка Desk не прочитана из хранилища: ' + String(collected?.error || 'нет данных').slice(0, 80) }
  const snapshot = collected.snapshot, problems = []
  const ids = (snapshot.blocks || []).map(item => item.id).sort().join(',')
  if (ids !== 'help,log') problems.push('набор блоков не «help,log»: ' + ids)
  if (!(snapshot.revision > DESK_SEED.revision)) problems.push('раскладка не сохранена: ревизия не выросла')
  const same = (id, rect) => {
    const item = snapshot.blocks.find(entry => entry.id === id), original = DESK_SEED.blocks.find(entry => entry.id === id)
    if (!item) return null
    for (const key of ['kind', 'title', 'resourceRef']) if (item[key] !== original[key]) problems.push(`блок ${id}: изменено поле ${key}`)
    for (const key of ['x', 'y', 'width', 'height']) if (item.rect?.[key] !== rect[key]) problems.push(`блок ${id}: ${key}=${item.rect?.[key]}, нужно ${rect[key]}`)
    return item
  }
  const help = same('help', HELP_RECT), log = same('log', LOG_RECT)
  if (help && log && overlaps(help.rect, log.rect)) problems.push('блоки перекрываются')
  return { ok: problems.length === 0, detail: problems.join('; ') || 'раскладка сохранена и соответствует заданию' }
}

const scenarios = [
  {
    id: 'browser-local-page',
    title: 'Браузер: код со страницы стенда без аккаунтов',
    request: BROWSER_REQUEST,
    page: true,
    fixture: { 'brief.txt': 'Страница локальная, входов нет. Код показывает только кнопка.\n' },
    constraints: { allowNew: ['answer.txt'], allowChange: [] },
    turns: [call('browse_page', { url: '__BENCH_PAGE__' }, 'Открываю страницу.'), call('browse_click', { text: 'Показать код подтверждения' }, 'Нажимаю кнопку.'),
      write('answer.txt', '__BENCH_CODE__\n'), { text: 'Готово: код записан в answer.txt.' }, DONE],
    expect: 'pass',
    verify: scenarioBrowser
  },
  {
    id: 'document-requirements',
    title: 'Документ: изменить по нескольким требованиям, остальное не трогать',
    request: DOCUMENT_REQUEST,
    fixture: { 'brief.txt': 'Правится только docs/release.md.\n', 'docs/release.md': DOCUMENT_BEFORE },
    constraints: { allowNew: [], allowChange: ['docs/release.md'] },
    turns: [read('docs/release.md'), write('docs/release.md', DOCUMENT_RESULT), { text: 'Готово: документ обновлён.' }, DONE],
    expect: 'pass',
    verify: scenarioDocument
  },
  {
    id: 'desk-layout',
    title: 'Desk: раскладка блоков через инструмент окна Desk',
    request: DESK_REQUEST,
    desk: true,
    fixture: { 'brief.txt': 'Раскладка Desk меняется только инструментом desk_workspace.\n' },
    constraints: { allowNew: [], allowChange: [] },
    turns: [call('desk_workspace', { action: 'open' }, 'Открываю Desk.'), call('desk_workspace', { action: 'read' }, 'Читаю раскладку.'),
      call('desk_workspace', { action: 'apply', operation_id: 'bench-layout-1', expected_revision: DESK_SEED.revision, operations: [
        { type: 'remove', id: 'notes' },
        { type: 'geometry', id: 'help', rect: { ...HELP_RECT, z: 1 } },
        { type: 'geometry', id: 'log', rect: { ...LOG_RECT, z: 2 } }
      ] }, 'Применяю раскладку.'), { text: 'Готово: раскладка обновлена.' }, DONE],
    expect: 'pass',
    verify: scenarioDesk
  }
]

module.exports = { scenarios, DOCUMENT_BEFORE, DOCUMENT_RESULT, DESK_SEED, DESK_RESULT }
