'use strict'

// Исполнение команды: отдельный процесс, таймаут, снятие всего дерева, обрезка
// вывода. Разрешения и правила решает вызывающий (main.js), здесь — запуск.
//
// Модуль отдельно от главного процесса потому, что иначе его не проверить:
// «агент сам прогоняет тесты» — пункт приёмки, а значит убийство по таймауту и
// обрезка вывода должны работать, а не выглядеть правдоподобно.

const { spawn } = require('child_process')
const { TextDecoder } = require('util')

const HEAD_CHARS = 3000
const TAIL_CHARS = 20000

// Что человек и модель читают, когда снятие процесса не подтвердилось. Формулировка
// намеренно не утверждает ни что процесс умер, ни что он жив: мы этого не знаем.
// Ошибкой это тоже не называется — команда остановлена насколько умели, но
// считать её завершённой и начинать новую поверх нельзя.
const UNCONFIRMED_WARNING = '[onlyone] снятие процесса не подтверждено: он мог остановиться, а мог работать дальше и писать в проект. Не считай команду выполненной и не запускай её повторно, пока не проверишь.'

// Начало и конец отдельно: у упавшего прогона тестов решающие строки — в конце
// (кто упал и почему), а начало говорит, что вообще запускалось. Буфер, который
// хранит только начало, отдал бы модели первые 3000 знаков и смолчал об итоге.
const KEEP_CHARS = HEAD_CHARS + TAIL_CHARS
// Пока вывод короче этого, режем ничего: иначе на границе начала и конца
// перекрывались бы одними и теми же строками.
const FOLD_AT_CHARS = KEEP_CHARS * 3

function collector() {
  let pending = ''
  let head = ''
  let tail = ''
  let size = 0
  let folded = false

  const fold = () => {
    folded = true
    head = pending.slice(0, HEAD_CHARS)
    tail = pending.slice(-TAIL_CHARS)
    pending = ''
  }

  return {
    push(chunk) {
      const text = String(chunk)
      size += text.length
      if (!folded) {
        pending += text
        if (pending.length > FOLD_AT_CHARS) fold()
        return
      }
      if (head.length < HEAD_CHARS) head += text.slice(0, HEAD_CHARS - head.length)
      tail = (tail + text).slice(-TAIL_CHARS)
    },
    value() {
      if (!folded) return { text: pending, dropped: 0 }
      const dropped = Math.max(0, size - head.length - tail.length)
      if (!dropped) return { text: head + tail, dropped: 0 }
      return {
        text: `${head}\n\n… здесь выпало ${dropped} знаков середины …\n\n${tail}`,
        dropped
      }
    }
  }
}

function shapeOutput(text) {
  const target = collector()
  target.push(text)
  return target.value()
}

function incompleteUtf8Tail(buffer) {
  let start = buffer.length - 1
  while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--
  if (start < 0) return 0
  const lead = buffer[start]
  const expected = lead >= 0xc2 && lead <= 0xdf ? 2
    : lead >= 0xe0 && lead <= 0xef ? 3
      : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0
  const present = buffer.length - start
  return expected > present ? present : 0
}

// cmd.exe встроенные команды могут писать OEM CP866 в перенаправленный pipe,
// даже после `chcp 65001`; внешние процессы обычно пишут UTF-8. Обе кодировки
// бывают в одном потоке (`dir & node build.js`), поэтому кодек выбирается для
// каждой строки отдельно строгой проверкой байтов, а не запоминается по первой:
// иначе UTF-8 потомка после строки `dir` читался бы как CP866. Незавершённый
// UTF-8 символ в конце чанка удерживается до следующего чанка.
//
// Строка CP866 вроде «раб.txt» (e0 a0 a1) формально тоже верный UTF-8 — но тогда
// выходит письмо из Самаритянского блока. Раз в потоке уже была строка CP866,
// такую «находку» считаем CP866.
const IMPLAUSIBLE_UTF8 = /[ࠀ-῿⠀-⣿㐀-䶿]/
function createOutputDecoder({ windows = process.platform === 'win32', enabled = true } = {}) {
  const plain = !(windows && enabled)
  let sawOem = false
  let pending = Buffer.alloc(0)
  let ended = false
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  const cp866 = new TextDecoder('ibm866')

  const join = chunk => pending.length ? Buffer.concat([pending, chunk]) : chunk

  const oem = buffer => { sawOem = true; return cp866.decode(buffer) }

  // Отрезок без перевода строки в конце может оборваться посреди UTF-8 символа:
  // тогда хвост остаётся до следующего чанка (`open`), а не читается как OEM.
  function segment(buffer, open) {
    if (!buffer.some(byte => byte >= 0x80)) return buffer.toString('ascii')
    try {
      const text = utf8.decode(buffer)
      if (sawOem && IMPLAUSIBLE_UTF8.test(text)) return oem(buffer)
      return text
    } catch {
      const incomplete = open ? incompleteUtf8Tail(buffer) : 0
      if (incomplete) {
        const boundary = buffer.length - incomplete
        try {
          const text = utf8.decode(buffer.subarray(0, boundary))
          pending = Buffer.from(buffer.subarray(boundary))
          return text
        } catch { /* invalid byte before the possible suffix: use OEM below */ }
      }
      return oem(buffer)
    }
  }

  return {
    push(chunk) {
      if (ended) return ''
      if (!Buffer.isBuffer(chunk)) return String(chunk)
      if (plain) return chunk.toString('utf8')
      const buffer = join(chunk)
      pending = Buffer.alloc(0)
      let text = ''
      let start = 0
      for (let nl = buffer.indexOf(0x0a, start); nl >= 0; nl = buffer.indexOf(0x0a, start)) {
        text += segment(buffer.subarray(start, nl + 1), false)
        start = nl + 1
      }
      if (start < buffer.length) text += segment(buffer.subarray(start), true)
      return text
    },
    end() {
      if (ended) return ''
      ended = true
      if (!pending.length) return ''
      const rest = pending
      pending = Buffer.alloc(0)
      // Оборванный на конце UTF-8 символ — испорченный вывод: показываем
      // замену, а не выдаём его за символ OEM.
      return new TextDecoder('utf-8').decode(rest)
    }
  }
}

// Снятие дерева. Подтверждением считается только успешный `taskkill /T`: он
// убирает и cmd.exe, и его детей. Откат на `process.kill(pid)` снимает ОДНОГО
// cmd.exe, а node-потомок (сам npm, сборка, тест) остаётся живым и продолжает
// писать в проект — после этого объявить команду остановленной значит соврать и
// человеку, и модели. Поэтому результат снятия возвращается вызывающему, а не
// теряется: `onConfirmed(true|false)`.
function killTree(pid, onConfirmed) {
  const done = fn => { try { fn() } catch { /* снятие не должно ронять ход */ } }
  if (pid == null) return done(() => onConfirmed && onConfirmed(false))
  try {
    if (process.platform === 'win32') {
      // У cmd.exe дети — сами npm и node. Без /T после «остановлено» в проекте
      // остаётся процесс, который продолжает писать. Сначала убираем всё дерево,
      // пока корневой cmd ещё существует: если убить его первым, Windows может
      // потерять связь родитель→потомок и taskkill уже не найдёт оставшийся node.
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => {
        try { process.kill(pid, 'SIGKILL') } catch {}
        done(() => onConfirmed && onConfirmed(false))
      })
      killer.once('close', code => {
        if (code !== 0) { try { process.kill(pid, 'SIGKILL') } catch {} }
        done(() => onConfirmed && onConfirmed(code === 0))
      })
      return killer
    } else {
      process.kill(-pid, 'SIGKILL')
      done(() => onConfirmed && onConfirmed(true))
    }
  } catch {
    // Процесс мог уйти сам раньше, чем дошла очередь; подтверждением это не считается.
    done(() => onConfirmed && onConfirmed(false))
  }
  return null
}

// Реестр всех активных дочерних процессов для защиты от зомби-процессов
const activeProcesses = new Set()

function trackProcess(child) {
  if (!child) return
  activeProcesses.add(child)
  const unregister = () => activeProcesses.delete(child)
  child.once('close', unregister)
  child.once('error', unregister)
}

function killAllActiveProcesses() {
  for (const child of activeProcesses) {
    try {
      if (child.pid != null) killTree(child.pid)
    } catch { /* процесс мог уже завершиться */ }
  }
  activeProcesses.clear()
}

function getActiveProcessCount() {
  return activeProcesses.size
}

function run({ command, cwd, env, timeoutMs = 120000, signal, utf8 = true, killGraceMs = 1500 } = {}) {
  return new Promise(resolve => {
    const started = Date.now()
    // Снятый до запуска сигнал — не «отменить сразу после старта», а «не
    // запускать вовсе»: ход уже отменён, и команда, которая пишет файлы после
    // «останови», — это ровно тот побочный эффект, которого человек уже не ждал.
    if (signal?.aborted) {
      resolve({ ok: false, aborted: true, timedOut: false, exitCode: null, output: '', dropped: 0, ms: 0, notStarted: true })
      return
    }
    // Русская cmd.exe пишет в кодовой странице консоли (CP866), а мы разбираем
    // вывод как UTF-8 — и вместо «Сборка завершена» получается каша. Переключаем
    // страницу на 65001 перед командой: тогда и сообщения оболочки, и вывод npm
    // приходят в одной кодировке с остальным приложением.
    const shellCommand = utf8 && process.platform === 'win32' ? `chcp 65001>nul & ${command}` : command
    let child
    try {
      child = spawn(shellCommand, { cwd, shell: true, windowsHide: true, env, detached: process.platform !== 'win32' })
    } catch (spawnError) {
      resolve({ ok: false, failedToStart: true, error: spawnError.message, exitCode: null, output: '', dropped: 0, ms: Date.now() - started })
      return
    }
    trackProcess(child)
    const out = collector()
    const err = collector()
    const outDecoder = createOutputDecoder({ enabled: utf8 })
    const errDecoder = createOutputDecoder({ enabled: utf8 })
    let timedOut = false
    let aborted = false
    let settled = false
    let timer = null
    let grace = null
    let stopStarted = false
    let childClosed = false
    let childCloseCode = null

    const merged = () => {
      const head = out.value()
      const tailPart = err.value()
      return { output: [head.text, tailPart.text].filter(Boolean).join('\n'), dropped: head.dropped + tailPart.dropped }
    }

    const finish = result => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (grace) clearTimeout(grace)
      signal?.removeEventListener?.('abort', onAbort)
      out.push(outDecoder.end())
      err.push(errDecoder.end())
      const body = merged()
      // Предупреждение идёт и в вывод: главный процесс пересылает модели `output`
      // и не пересылает новых полей результата, а молчаливое «остановлена» читается
      // как «можно начинать заново». Когда `main.js` начнёт показывать `warning`,
      // эту строку отсюда снимут.
      if (result.warning && !body.output.includes(result.warning)) {
        body.output = [body.output, result.warning].filter(Boolean).join('\n')
      }
      resolve({ ...body, ...result, ms: Date.now() - started })
    }

    // Снятие процесса и всего дерева. Отдельно — жёсткий дедлайн: `close`
    // приходит, только когда закрыты ручки вывода, а их может держать потомок
    // или само снятие дерева может оказаться недоступно (ограничение прав).
    // Без дедлайна ход ждал бы чужого конца — ровно то, что измерено как
    // 30 с вместо 500 мс.
    // Снятие дерева подтверждается асинхронно (код выхода `taskkill`), поэтому в
    // момент жёсткого дедлайна оно может быть ещё неизвестно. Неизвестность
    // трактуется как «не подтверждено»: лучше честное «может продолжать
    // работать», чем «остановлено», под которым сборка дописывает файлы в проект.
    let treeKilled = null
    const finishStopped = (exitCode, truncated) => finish({
      ok: false, exitCode, timedOut, aborted,
      killed: treeKilled === true,
      killUnconfirmed: treeKilled !== true,
      truncated,
      warning: treeKilled === true ? '' : UNCONFIRMED_WARNING
    })
    const stop = () => {
      stopStarted = true
      const confirm = confirmed => {
        treeKilled = confirmed
        // The shell can close before taskkill reports whether its descendants
        // were removed. Keep the result pending until both facts are known.
        if (childClosed) {
          if (grace) clearTimeout(grace)
          finishStopped(childCloseCode, false)
        }
      }
      if (process.platform === 'win32') {
        killTree(child.pid, confirm)
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); confirm(true) } catch {
          try { child.kill('SIGKILL') } catch { /* процесс мог уйти сам */ }
          confirm(false)
        }
      }
      grace = setTimeout(() => {
        try {
          child.stdout?.destroy()
          child.stderr?.destroy()
          child.unref?.()
        } catch { /* ручки уже закрыты */ }
        finishStopped(null, true)
      }, killGraceMs)
      grace.unref?.()
    }

    timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    const onAbort = () => {
      aborted = true
      // Таймер снимаем: он мог пережить ход и убить по истечении `timeoutMs`
      // уже чужой процесс — pid к этому времени перераздают.
      if (timer) clearTimeout(timer)
      stop()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stdout?.on('data', chunk => out.push(outDecoder.push(chunk)))
    child.stderr?.on('data', chunk => err.push(errDecoder.push(chunk)))

    child.on('error', error =>
      finish({ ok: false, failedToStart: true, error: error.message, exitCode: null }))

    child.on('close', code => {
      childClosed = true
      childCloseCode = code
      if (stopStarted) {
        if (treeKilled !== null) {
          if (grace) clearTimeout(grace)
          finishStopped(code, false)
        }
        return
      }
      finish({ ok: code === 0, exitCode: code, timedOut, aborted })
    })
  })
}

// Несколько последних непустых строк одной строкой: по ним видно, что именно
// упало, не открыв карточку шага.
function lastLines(text, count = 2, maxChars = 220) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return lines.slice(-count).join(' ⋄ ').slice(-maxChars)
}

// Долгий процесс для консоли панели «Задачи» (start_process): не ждёт конца, отдаёт рукоятку
// планировщику — построчный вывод в UTF-8 или CP866, on('close'|'error') и kill() всего дерева.
function spawnLong({ command, cwd, env, utf8 = true } = {}) {
  const { EventEmitter } = require('events')
  const shellCommand = utf8 && process.platform === 'win32' ? `chcp 65001>nul & ${command}` : command
  let child
  try {
    child = spawn(shellCommand, { cwd, shell: true, windowsHide: true, env, detached: process.platform !== 'win32' })
  } catch (spawnError) {
    const stdout = new EventEmitter(), stderr = new EventEmitter()
    const errorChild = {
      pid: null, stdout, stderr,
      on(name, cb) {
        if (name === 'error') process.nextTick(() => cb(spawnError))
        return this
      },
      kill() { return false }
    }
    return errorChild
  }
  trackProcess(child)
  const outDecoder = createOutputDecoder({ enabled: utf8 }), errDecoder = createOutputDecoder({ enabled: utf8 })
  const stdout = new EventEmitter(), stderr = new EventEmitter()
  child.stdout?.on('data', chunk => stdout.emit('data', outDecoder.push(chunk)))
  child.stderr?.on('data', chunk => stderr.emit('data', errDecoder.push(chunk)))
  return {
    pid: child.pid, stdout, stderr,
    on(name, cb) { child.on(name, cb); return this },
    kill() { killTree(child.pid); return true }
  }
}

module.exports = { run, spawnLong, shapeOutput, collector, createOutputDecoder, killTree, lastLines,
  killAllActiveProcesses, getActiveProcessCount,
  UNCONFIRMED_WARNING, HEAD_CHARS, TAIL_CHARS }
