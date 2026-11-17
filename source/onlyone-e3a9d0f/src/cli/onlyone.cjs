'use strict'

// onlyone из командной строки: разбор аргументов, права и результат хода.
//
//   onlyone run "<просьба>" --folder <путь> [--allow-write] [--profile <каталог>] [--log <файл>]
//
// Файл ДВА раздела, и граница между ними — не украшение:
//
// 1. ЧИСТЫЙ МОДУЛЬ (всё до `isMain`). Разбор входа, права хода, исход хода,
//    строка человеку и зачистка секретов. Ни файловой системы, ни процессов, ни
//    Electron, ни сети: набор `tests/test-cli-7-5.cjs` грузит этот файл в
//    песочнице, где такой `require` бросает, и потому имеет право требовать
//    поведение, а не догадываться о нём. Всё внешнее — через `deps`.
// 2. ЗАПУСКНИК (`require.main === module`) передаёт работу launcher.cjs.
// Он копирует настройки и Local State в отдельный временный профиль, затем
// запускает тот же агентный цикл через мост окна. История чатов не переносится;
// исходный профиль не изменяется. Ключи и их фрагменты удаляются из вывода.

// Коды выхода — лицо пункта: «код выхода = исход хода». Значения заморожены
// набором 7.5 и менять их нельзя молча: по ним судят скрипты человека.
const EXIT = Object.freeze({
  OK: 0,
  TURN_FAILED: 1,
  BAD_INPUT: 2,
  WRITE_REFUSED: 3,
  ABORTED: 4
})

// Читающий класс хода. Список СОЗНАТЕЛЬНО повторён из `READ_ONLY_TOOLS` в
// `src/main/run-checkpoints.js`: тот модуль поднимает `node:fs`, а чистый модуль
// CLI права на диск не имеет. Расхождение ловит набор — он сверяет каждое имя с
// настоящим списком ядра и краснеет, если здесь осталось имя, которое ядро
// считает записью.
const READ_ONLY_TOOLS = Object.freeze([
  'read_guide', 'task_plan', 'ask_user', 'board_update', 'agent_message',
  'board_read', 'assign_work', 'read_file', 'list_files', 'search_files', 'list_skills', 'use_skill',
  'skill_file', 'fetch_url', 'list_mcp_servers', 'artifacts_list', 'project_chats', 'project_chat',
  'project_file', 'project_plan_get', 'dc_read', 'dc_list', 'dc_comments', 'dc_check', 'dc_refs', 'dc_read_ref'
])

// Что даёт только `--allow-write`. Имена те же, что в реестре инструментов хода:
// обещать инструмент, которого в ядре нет, CLI не вправе.
const WRITE_TOOLS = Object.freeze([
  'write_file', 'create_directory', 'move_path', 'delete_path', 'run_command',
  'define_tool', 'add_mcp_server', 'add_skill', 'update_skill', 'delete_skill', 'toggle_skill',
  'update_artifact', 'dc_write', 'dc_set_entry', 'browse_click', 'browse_input', 'project_note',
  'project_topic_set', 'project_plan_set'
])

const USAGE = 'onlyone run "<просьба>" --folder <путь> [--allow-write] [--profile <каталог>] [--log <файл>]'

// Текст, который ядро ставит вместо ответа, когда модель промолчала
// (`src/main/main.js`, ветка пустого шага). Признак, а не цитата: ловим начало
// фразы, остальное — причина от провайдера.
const EMPTY_ANSWER = /^Модель ничего не вернула/i

// Так Electron заворачивает отказ обработчика ipcRenderer.invoke — всегда одной
// и той же строкой. Человеку за консолью нужна причина, а не имя нашего канала.
const IPC_PREFIX = /^Error invoking remote method '[^']+': Error: /

// Ключи, которым нужно значение, и флаг без значения.
const VALUE_FLAGS = Object.freeze({ '--folder': 'folder', '--profile': 'profile', '--log': 'log' })
const SWITCH_FLAGS = Object.freeze(['--allow-write'])

const clean = value => String(value == null ? '' : value).trim()

// Поля, где живёт ключ: имя записи, модель, путь и прочее секретом не является.
const KEY_FIELD = /(key|token|secret|password|passwd|pwd|authorization|apikey)/i

// Просьба приходит и словом после `run`, и после `--request`: человек делает и
// так, и так, а молча проигнорированный вариант — это потерянная половина строки.
function parseArgs (argv) {
  const args = Array.isArray(argv) ? argv.slice() : []
  const parsed = {
    command: '', request: '', folder: '', allowWrite: false,
    profile: '', log: '', error: null
  }
  parsed.command = clean(args.shift())
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i])
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    // `--folder=путь` и `--folder путь` — одна форма для человека.
    const eq = token.indexOf('=')
    const name = eq < 0 ? token : token.slice(0, eq)
    const inline = eq < 0 ? null : token.slice(eq + 1)
    if (SWITCH_FLAGS.includes(name)) {
      if (inline !== null && inline !== '') {
        parsed.error = `Флаг «${name}» ничего не принимает: он просто разрешает запись.`
        return parsed
      }
      parsed.allowWrite = name === '--allow-write'
      continue
    }
    const field = VALUE_FLAGS[name]
    if (!field) {
      parsed.error = `Неизвестный ключ «${name}». Так выглядит вызов: ${USAGE}`
      return parsed
    }
    const value = inline !== null ? inline : String(args[++i] ?? '')
    if (!clean(value)) {
      parsed.error = `После «${name}» ничего не стоит: нужно значение. Пример — ${USAGE}`
      return parsed
    }
    parsed[field] = clean(value)
  }
  parsed.request = positional.join(' ').trim()
  if (parsed.command !== 'run') {
    parsed.error = parsed.command
      ? `Команды «${parsed.command}» нет. Есть одна: ${USAGE}`
      : `Команда не названа. Есть одна: ${USAGE}`
    return parsed
  }
  if (positional.length > 1) {
    parsed.error = `Просьба должна быть одна строка, а пришло ${positional.length} слов подряд: ${positional.join(' | ')}. Возьмите её кавычками.`
    return parsed
  }
  if (!parsed.request) {
    parsed.error = `Не о чем просить: в вызове нет просьбы. Пример — ${USAGE}`
  } else if (!parsed.folder) {
    parsed.error = `Не указана рабочая папка: без неё ход не знает, где читать и писать. Пример — ${USAGE}`
  }
  return parsed
}

// Права хода. Без `--allow-write` CLI не имеет права быть «вторым набором
// правил»: список берётся из читающего класса ядра, а не из догадки.
function toolsFor (allowWrite) {
  return allowWrite ? [...READ_ONLY_TOOLS, ...WRITE_TOOLS] : [...READ_ONLY_TOOLS]
}

// Пишущий вызов, который не выполнился, — вот из чего рождается знак отказа по
// правам. Строка `pending` — вызов ещё идёт, судить по нему нельзя; успешная
// запись позже снимает признак (значит права были, и код 3 был бы ложью).
function writeRefusedByJournal (turn) {
  const rows = Array.isArray(turn.tools) ? turn.tools : []
  const settled = rows.filter(row => row && !row.pending)
  const writes = settled.filter(row => WRITE_TOOLS.includes(row.tool))
  return writes.some(row => row.ok === false) && !writes.some(row => row.ok === true)
}

// Исход хода — по знакам, которые ядро и так отдаёт окну. Измерено прогоном:
// ответ `send-message` несёт `{ ok, content, aborted, incomplete, error,
// execution }`, а отказ режима плана полем в нём НЕ помечен — он виден только
// в истории вызовов (`agent-tool-log`) как `ok: false` на пишущем инструменте.
// Приоритет нарочный: снятый ход остаётся снятым, даже если попутно упала
// техническая ошибка, а отказ по правам важнее общей ошибки — человеку нужно
// слово про `--allow-write`, а не «что-то упало».
function outcomeOf (turn) {
  const one = turn instanceof Error ? { ok: false, error: turn.message || String(turn) } : (turn || {})
  const text = clean(one.content) || clean(one.answer) || clean(one.text)
  const reason = clean(one.error && (one.error.message || one.error)).replace(IPC_PREFIX, '')
  if (one.aborted) return { code: EXIT.ABORTED, answer: text || 'Ход снят.' }
  const refused = one.denied === true || (one.readOnly === true && writeRefusedByJournal(one))
  if (refused) return { code: EXIT.WRITE_REFUSED, answer: text }
  if (one.ok === false || one.error) return { code: EXIT.TURN_FAILED, answer: reason || text || 'Ход не завершился.' }
  // Ответа как такового нет: ядро вернуло свой текст о том, что модель
  // промолчала. Для человека это исход «ход не состоялся», а не 0.
  if (EMPTY_ANSWER.test(text)) return { code: EXIT.TURN_FAILED, answer: reason || 'ход завершился без ответа' }
  if (one.ok) return { code: EXIT.OK, answer: text }
  return { code: EXIT.TURN_FAILED, answer: reason || text || 'Ядро не сказало, чем закончился ход.' }
}

// Что видит человек. Успех — сам ответ, без служебной обёртки: CLI читают
// пайпы и перенаправляют в файлы.
function lineFor (outcome) {
  const answer = clean(outcome && outcome.answer)
  switch (Number(outcome && outcome.code)) {
    case EXIT.OK:
      return answer || 'Ход завершён, ответ пуст.'
    case EXIT.WRITE_REFUSED:
      return `Запись не выполнена: прав нет. Повторите с --allow-write, если эти изменения нужны.${answer ? ` Ход сказал: ${answer}` : ''}`
    case EXIT.ABORTED:
      return `Ход снят${answer ? `: ${answer}` : ''}.`
    case EXIT.BAD_INPUT:
      return answer || `Вызов не понят: ${USAGE}`
    default:
      return `Ход не завершился: ${answer || 'причина не названа'}`
  }
}

// Секреты из профиля: форма записи не решающая (ядро хранит их по-разному на
// путях провайдера и пула), а значение всякая строка, похожая на ключ.
function secretValues (profile) {
  const found = []
  const seen = new Set()
  let currentName = ''
  const walk = (node, depth) => {
    if (!node || depth > 6) return
    if (typeof node === 'string') {
      const value = node.trim()
      // Секрет — значение ключевой записи, а не всякая длинная строка: путь к
      // папке и имя модели стирать нельзя, иначе зачистка съедает вывод человека.
      if (KEY_FIELD.test(currentName) && value.length >= 8 && !seen.has(value)) { seen.add(value); found.push(value) }
      return
    }
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return }
    for (const [key, value] of Object.entries(node)) {
      const previous = currentName
      currentName = key
      walk(value, depth + 1)
      currentName = previous
    }
  }
  walk(profile, 0)
  return found
}

const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const MASK = '[ключ скрыт]'

// Зачистка вывода. Живой сервер сокращает ключ в объяснении (`…abcd`), а
// человек, копируя отказ, кладёт в ленту и журнал и сам ключ, и его хвосты.
// Поэтому стирается не только значение целиком, но и любое его окно от 8
// знаков, и в верхнем регистре тоже. Меньше 8 знаков стирать нельзя: такие
// куски встречаются в обычной речи и в путях.
function redact (text, secrets) {
  let out = String(text == null ? '' : text)
  const list = Array.isArray(secrets) ? secrets : [secrets]
  for (const raw of list) {
    const secret = String(raw == null ? '' : raw).trim()
    if (secret.length < 8) continue
    const pieces = [secret]
    for (let i = 0; i + 8 <= secret.length; i++) pieces.push(secret.slice(i, i + 8))
    pieces.sort((a, b) => b.length - a.length)
    for (const piece of pieces) {
      out = out.replace(new RegExp(escapeRe(piece), 'gi'), MASK)
    }
  }
  return out
}

// ─── чистый прогон: один ход, один код, ни одного байта мимо deps ────────────
function createCli (deps = {}) {
  const {
    readProfile, folderExists, runTurn, out, err, log, t
  } = deps
  const say = text => { if (typeof out === 'function') out(String(text).endsWith('\n') ? String(text) : `${String(text)}\n`) }
  const shout = text => { if (typeof err === 'function') err(String(text).endsWith('\n') ? String(text) : `${String(text)}\n`) }
  const words = text => (typeof t === 'function' ? String(t(text)) : String(text))
  const note = entry => { if (typeof log === 'function') log(entry) }

  async function run (argv) {
    const parsed = parseArgs(argv)
    if (parsed.error) {
      say(words(parsed.error))
      note({ at: Date.now(), code: EXIT.BAD_INPUT, error: parsed.error })
      return { code: EXIT.BAD_INPUT }
    }
    if (typeof folderExists === 'function' && !folderExists(parsed.folder)) {
      const line = words(`Папки «${parsed.folder}» нет на диске — ход не начинался.`)
      say(line)
      note({ at: Date.now(), code: EXIT.BAD_INPUT, error: line, folder: parsed.folder })
      return { code: EXIT.BAD_INPUT }
    }

    // Ключи — из общего профиля, и только затем что-либо печатается: профиль
    // здесь ещё и источник секретов для зачистки вывода.
    const profile = typeof readProfile === 'function' ? await readProfile() : null
    const secrets = secretValues(profile)
    const printable = text => redact(text, secrets)

    const tools = toolsFor(parsed.allowWrite)
    const payload = {
      request: parsed.request,
      folder: parsed.folder,
      allowWrite: parsed.allowWrite,
      readOnly: !parsed.allowWrite,
      tools,
      profile: parsed.profile || null
    }
    note({ at: Date.now(), event: 'cli-run', request: parsed.request, folder: parsed.folder, allowWrite: parsed.allowWrite })

    let turn = null
    try {
      turn = await runTurn(payload)
    } catch (error) {
      turn = { ok: false, error: error && (error.message || String(error)) }
    }
    const outcome = outcomeOf(turn instanceof Error ? turn : Object.assign({}, turn, { readOnly: !parsed.allowWrite }))
    const line = words(printable(lineFor(outcome)))
    if (outcome.code === EXIT.OK) say(line)
    else shout(line)
    note({ at: Date.now(), code: outcome.code, request: redact(parsed.request, secrets), folder: parsed.folder })
    // В профиль CLI пишет только через deps.writeProfile — и только зачищенное:
    // открытый ключ в любой записи профиля был бы второй копией секрета.
    if (typeof deps.writeProfile === 'function') {
      deps.writeProfile(redact(JSON.stringify({ cli: { last: outcome.code, at: Date.now() } }), secrets))
    }
    return { code: outcome.code }
  }

  return Object.freeze({ run })
}

module.exports = { EXIT, USAGE, READ_ONLY_TOOLS, WRITE_TOOLS, parseArgs, toolsFor, outcomeOf, lineFor, redact, secretValues, createCli }

// ─── запускник: только когда файл вызвали как программу ──────────────────────
//
// В песочнице набора 7.5 эта ветка не исполняется (`require.main !== module`),
// поэтому чистый модуль остаётся чистым: диск, процесс и Electron появляются
// только здесь.
if (require.main === module) {
  require('./launcher.cjs').main(process.argv.slice(2))
    .then(code => { process.exitCode = code })
    .catch(() => { console.error('Не удалось завершить CLI.'); process.exitCode = EXIT.TURN_FAILED })
}
