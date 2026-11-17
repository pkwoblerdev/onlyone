// Runs one agent-authored tool in its own process and prints the result as JSON.
//
// A separate process is the point: a tool that loops forever, throws, or eats
// memory takes itself down and not the app. The parent kills it on timeout.
//
// Contract for a tool file: `module.exports = async function (args) { ... }`,
// returning anything JSON-serialisable.
//
// Граница ставится до загрузки чужого кода: файлы — только внутри канонических
// корней (через `realpath`, чтобы junction не обходил проверку), сеть,
// подпроцессы, потоки и внешние хранилища — запрещены. Корня приходят одним
// аргументом и замораживаются: свой код не должен иметь возможности расширить
// периметр через окружение.

const path = require('path')
const Module = require('module')
const realFs = require('fs')
const sandbox = require('./tool-sandbox.cjs')
const { frameResult } = require('./tool-protocol.cjs')

// Сколько текста инструмента отдаётся наружу: лог нужен модели, но не ценой
// окна контекста.
const TOOL_LOG_CAP = 8000

// Ответ раннера и текст инструмента разделяются до того, как чужой код получит
// руки: на stdout уходит одна обрамлённая строка, всё остальное — поле `log`.
// Инструмент может написать и в обход нашей обёртки
// (`Writable.prototype.write.call(process.stdout, …)`) — эти байты родитель не
// примет за ответ, потому что ответа без рамки не бывает.
const realWrite = process.stdout.write.bind(process.stdout)
let toolLog = ''
function emit (payload) {
  const body = { ...payload }
  if (toolLog.trim()) body.log = toolLog
  realWrite(frameResult(body))
}
process.stdout.write = (chunk, ...rest) => {
  const text = typeof chunk === 'string' ? chunk
    : (chunk && typeof chunk.toString === 'function') ? chunk.toString('utf8') : String(chunk)
  if (toolLog.length < TOOL_LOG_CAP) toolLog = (toolLog + text).slice(0, TOOL_LOG_CAP)
  return true
}
process.stderr.write = process.stdout.write

function readRoots() {
  const token = process.argv[3]
  if (!token) throw new Error('Граница не задана: не передан список разрешённых папок.')
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(String(token), 'base64').toString('utf8'))
  } catch {
    throw new Error('Граница задана неверно: список папок не читается.')
  }
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('Граница пуста: рабочая папка не задана.')
  return parsed
}

async function main() {
  const file = process.argv[2]
  if (!file) throw new Error('Не передан путь к инструменту.')

  const denied = []
  // Корень забирается в этот момент и больше не перечитывается: что бы
  // инструмент потом ни сделал с окружением, периметр уже заморожен в jail.
  const jail = sandbox.create({ roots: readRoots(), fs: realFs, cwd: process.cwd(), onDeny: info => denied.push(info) })
  // Граница ставится и на то, что не ходит через `require`: встроенные модули
  // напрямую, внутренние связки, загрузку нативных библиотек, сигнал чужому
  // процессу. Без этого одна строчка `process.getBuiltinModule('child_process')`
  // обходила весь остальной периметр.
  sandbox.guardProcess({ jail, onDeny: info => denied.push(info) })

  const blockedLoad = new Set()
  const originalLoad = Module._load
  Module._load = function guarded(request, parent, isMain) {
    const name = String(request || '')
    if (jail.blocked(name)) {
      blockedLoad.add(name.replace(/^node:/, ''))
      const error = new Error(`Свой инструмент не может использовать «${name.replace(/^node:/, '')}»: `
        + 'сеть, подпроцессы и внешние хранилища закрыты границей onlyone.')
      error.code = 'ERR_ACCESS_DENIED'
      throw error
    }
    const jailed = jail.for(name)
    if (jailed) return jailed
    return originalLoad.apply(this, arguments)
  }
  // Сетевые входы глобальные, а не модульные: `fetch` есть в Node без единого
  // require, и без этого дыра оставалась бы открытой.
  for (const name of ['fetch', 'WebSocket', 'EventSource']) {
    try { delete globalThis[name] } catch { /* some globals are non-configurable */ }
  }

  const input = await new Promise(resolve => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { raw += chunk })
    process.stdin.on('end', () => resolve(raw))
    // No stdin at all is the same as no arguments.
    if (process.stdin.isTTY) resolve('')
  })

  let args = {}
  if (input.trim()) {
    try {
      args = JSON.parse(input)
    } catch {
      throw new Error('Аргументы пришли не в формате JSON.')
    }
  }

  jail.assertAllowed(path.resolve(file), 'read')
  const loaded = require(path.resolve(file))
  const run = typeof loaded === 'function' ? loaded : loaded?.run ?? loaded?.default
  if (typeof run !== 'function') {
    throw new Error('Файл инструмента должен экспортировать функцию: module.exports = async (args) => {…}')
  }

  const result = await run(args)
  emit({
    ok: true,
    result: result === undefined ? null : result,
    // О том, что граница сработала, должно быть видно и человеку, и модели:
    // иначе «пустой» ответ инструента выглядит как его собственная логика.
    boundary: { denied, blocked: [...blockedLoad] }
  })
}

main().catch(error => {
  emit({
    ok: false,
    error: String((error && error.message) || error),
    // The stack names the tool's own line, which is what the agent needs to fix it.
    where: String((error && error.stack) || '').split('\n').slice(1, 4).join(' | ')
  })
  process.exitCode = 1
})
