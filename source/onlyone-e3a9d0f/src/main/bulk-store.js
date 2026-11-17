'use strict'

// Большие наборы данных — история переписки и дизайны — в своих файлах.
//
// Раньше они лежали внутри файла настроек, и файл дорос до 18 МБ. Хранилище
// настроек на каждом обращении синхронно читает и разбирает файл целиком
// (70–85 мс в главном процессе), а каждое сохранение чата заново собирало и
// писало все 18 МБ. Теперь у каждого набора свой файл, чтение — из памяти,
// запись — в фоне и атомарно: сначала временный файл, потом переименование,
// так что оборванная запись не оставит полфайла.
//
// Шифрование не меняется: вызывающий передаёт encode/decode — тот же конверт
// safeStorage, что и раньше, только в своём файле.

const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

const WRITE_DELAY_MS = 120

function create({ dir, encode, decode, legacy = null, onEvent = () => {}, isEnvelope = null }) {
  if (typeof encode !== 'function' || typeof decode !== 'function') throw new Error('bulk-store: нужны encode и decode')
  const cache = new Map()
  const dirty = new Set()
  const revisions = new Map()
  // Ключи, данные которых мы не смогли прочитать и не смогли убрать в сторону.
  // Писать в такой файл — значит стёреть то, что не удалось спасти: пусть лучше
  // сохранение вернёт ошибку, и человек увидит её, чем потеряет молча.
  const blocked = new Map()
  // Ключи с целым, но нечитаемым конвертом: это не испорченные данные, а потерянный
  // или чужой ключ шифрования. Отдельный признак нужен затем, чтобы главный процесс
  // мог объяснить причину человеку и не стирать память о прерванных ходах.
  const keyLost = new Set()
  // То же, но за всю сессию: как только нечитаемое уезжает в архив и на его место
  // ложится новое, `keyLost` пустеет, а сказать человеку «в этом запуске часть
  // данных не открылась» нужно и позже.
  const lostThisSession = new Set()
  // То же, что `lostThisSession`, но с причиной «файл не разобрался» (карантин),
  // а не «ключ не подошёл»: окну нужно назвать беду правильно, а не врать
  // человеку про потерянный ключ поверх битого JSON (общий аудит 01.11, Н1).
  const corruptThisSession = new Set()
  // Как выглядит запись, которую сделал этот модуль. Различить «файл обрезан» и
  // «файл цел, но расшифровать нечем» по одной только ошибке нельзя, и решение
  // принимает вызывающий: он знает свой конверт.
  const envelopeShape = typeof isEnvelope === 'function'
    ? isEnvelope
    : value => Boolean(value && typeof value === 'object' && typeof value.data === 'string')
  let syncEpoch = 0
  let timer = null
  let writing = null
  // Кто ждёт склеенной записи. Обработчик отдаёт окну ответ только после того,
  // как последний set лёг на диск, — но ждёт общую запись, а не пишет весь
  // набор на каждое сообщение (Н21).
  let idleWaiters = []
  let idlePromise = null

  // Текст ошибки — в журнал, и только короткий: Node успевает вставить в сообщение
  // начало разобранных байт, а журнал лежит открытым текстом.
  const reason = error => String(error?.message || error).slice(0, 200)

  const fileOf = key => path.join(dir, `${key}.json`)

  // Целый конверт, который нечем расшифровать: ключ этого профиля потерян (или
  // файл пришёл с другой учётной записи Windows). На чтении байт не трогаем:
  // причина запоминается и называется вызывающему, а молча переименовать файл —
  // значит через секунду позволить записать поверх пустой список.
  function loseKey(key, file) {
    keyLost.add(key)
    lostThisSession.add(key)
    // Без текста ошибки: в него Node вставляет начало разобранных байт.
    onEvent('key-mismatch', { key, file: path.basename(file) })
    return { found: false, keyLost: true }
  }

  function renameWithRetrySync(src, dst, maxAttempts = 6) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fs.renameSync(src, dst)
        return
      } catch (error) {
        const code = error && error.code
        const isLocked = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
        if (!isLocked || attempt === maxAttempts) throw error
        const delayMs = attempt * 15
        const start = Date.now()
        while (Date.now() - start < delayMs) { /* sync wait on lock */ }
      }
    }
  }

  // Перед первой записью поверх нечитаемого набора уносим прежние байты под именем,
  // которое объясняет, что случилось. Молча перезаписать — значит оставить человека
  // думать, что он сам стёр переписку; запретить запись навсегда — значит превратить
  // аварию в кирпич, потому что ключ к этим байтам уже не вернётся.
  function archiveKeyLost(key) {
    if (!keyLost.has(key)) return
    const file = fileOf(key)
    keyLost.delete(key)
    if (!fs.existsSync(file)) return
    const aside = `${file}.key-lost-${Date.now()}-${randomUUID().slice(0, 8)}`
    try {
      renameWithRetrySync(file, aside)
      onEvent('key-lost-archived', { key, aside: path.basename(aside) })
    } catch (error) {
      keyLost.add(key)
      blocked.set(key, `нечитаемые данные в ${path.basename(file)} не удалось убрать в сторону: ${reason(error)}`)
      onEvent('key-lost-archive-failed', { key, error: reason(error) })
      throw new Error(`Не удалось сохранить ${key}: ${blocked.get(key)}; запись заблокирована, чтобы сохранить исходные данные.`)
    }
  }

  // Файл на диске есть, а разобрать его не удалось. Уносим в сторонку, чтобы
  // разобрать руками, и продолжаем с тем, что уцелело. Если унести не удалось
  // — файл всё ещё на месте, и этот ключ блокируется на запись.
  function quarantine(key, file, error) {
    // Тот же учёт, что у потерянного ключа: для окна и статуса хранилища набор
    // не прочитался в этом запуске, и человек обязан услышать об этом, а не
    // пустой список (общий аудит 01.11, Н1). Причина — отдельная, `corrupt`.
    lostThisSession.add(key)
    corruptThisSession.add(key)
    const aside = `${file}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`
    try {
      renameWithRetrySync(file, aside)
      onEvent('corrupt', { key, aside, error: reason(error) })
    } catch (renameError) {
      blocked.set(key, `испорченный файл ${path.basename(file)} не удалось убрать в сторону: ${reason(renameError)}`)
      onEvent('corrupt-rename-failed', { key, aside, error: reason(renameError) })
    }
    return { found: false, corrupt: true }
  }

  function readFile(key) {
    const file = fileOf(key)
    if (!fs.existsSync(file)) return { found: false }
    let envelope
    try {
      let raw = fs.readFileSync(file, 'utf8')
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
      envelope = JSON.parse(raw)
    } catch (error) {
      return quarantine(key, file, error)
    }
    try {
      return { found: true, value: decode(envelope) }
    } catch (error) {
      // Раздели две разные беды. Наш конверт, который не разобрался, — это потерянный
      // ключ: байты остаются на месте до первой записи (см. archiveKeyLost), а
      // причина называется сразу. Непонятная запись — прежняя ветка: унести в
      // сторонку и начать с чистого.
      if (envelopeShape(envelope)) return loseKey(key, file)
      return quarantine(key, file, error)
    }
  }

  function writeFileSync(key, value) {
    fs.mkdirSync(dir, { recursive: true })
    const file = fileOf(key)
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(encode(JSON.stringify(value))))
      renameWithRetrySync(tmp, file)
    } finally {
      try { fs.unlinkSync(tmp) } catch (error) { if (error.code !== 'ENOENT') onEvent('tmp-cleanup-failed', { key }) }
    }
  }

  async function writeFileAsync(key, value, epoch) {
    await fs.promises.mkdir(dir, { recursive: true })
    const file = fileOf(key)
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(encode(JSON.stringify(value))))
      // No await between the epoch check and commit: flushSync cannot interleave
      // and an old asynchronous snapshot cannot replace the exit snapshot.
      if (epoch !== syncEpoch) return
      renameWithRetrySync(tmp, file)
    } finally {
      try { await fs.promises.unlink(tmp) } catch (error) { if (error.code !== 'ENOENT') onEvent('tmp-cleanup-failed', { key }) }
    }
  }

  // Перенос из старого места. Старое удаляется только после того, как новое
  // прочитано обратно и совпало байт в байт; до тех пор оно остаётся на месте.
  function migrate(key, fallback) {
    if (!legacy || !legacy.has(key)) return { value: fallback, migrated: false }
    const unreadable = Symbol('unreadable')
    const value = legacy.read(key, unreadable)
    if (value === unreadable) {
      blocked.set(key, 'старое значение в файле настроек не читается')
      onEvent('migration-unreadable', { key })
      return { value: fallback, migrated: false, keepLegacy: true }
    }
    try {
      writeFileSync(key, value)
      const back = readFile(key)
      if (!back.found || JSON.stringify(back.value) !== JSON.stringify(value)) throw new Error('прочитанное обратно не совпало')
      legacy.backup?.()
      legacy.drop(key)
      onEvent('migrated', { key, bytes: fs.statSync(fileOf(key)).size })
      return { value, migrated: true }
    } catch (error) {
      try { fs.rmSync(fileOf(key), { force: true }) } catch (rmError) { onEvent('migrate-cleanup-failed', { key, error: reason(rmError) }) }
      onEvent('migrate-failed', { key, error: reason(error) })
      return { value, migrated: false, keepLegacy: true }
    }
  }

  const stayLegacy = new Set()

  function get(key, fallback) {
    if (cache.has(key)) return cache.get(key)
    // Набор с потерянным ключом перечитывать бессмысленно: файл цел, причина до
    // перезапуска не изменится, а перечитывать 10 МБ на каждое обращение окна —
    // это ещё и тормоза. Пустой ответ здесь честен: он отдаётся вместе с
    // integrity(), по которому главный процесс говорит человеку, что случилось.
    if (keyLost.has(key)) return fallback
    if (stayLegacy.has(key)) return legacy.read(key, fallback)
    const read = readFile(key)
    if (read.found) {
      cache.set(key, read.value)
      return read.value
    }
    // Файл остался на диске нечитаемым. Перенос из старого места пишет новый
    // файл поверх него, поэтому сюда не идём: читаем старое место, если оно
    // что-то хранит, и оставляем ключ заблокированным для записи.
    if (blocked.has(key)) {
      if (legacy?.has(key)) {
        stayLegacy.add(key)
        return legacy.read(key, fallback)
      }
      return fallback
    }
    const moved = migrate(key, fallback)
    if (moved.keepLegacy) {
      // Перенести не удалось — продолжаем работать со старым местом, как
      // раньше. Хуже по скорости, но ничего не теряется.
      stayLegacy.add(key)
      return moved.value
    }
    cache.set(key, moved.value)
    return moved.value
  }

  function set(key, value) {
    const blockedBecause = blocked.get(key)
    if (blockedBecause) throw new Error(`Не удалось сохранить ${key}: ${blockedBecause}; запись заблокирована, чтобы сохранить исходные данные.`)
    archiveKeyLost(key)
    if (stayLegacy.has(key)) return legacy.write(key, value)
    cache.set(key, value)
    revisions.set(key, (revisions.get(key) || 0) + 1)
    dirty.add(key)
    clearTimeout(timer)
    timer = setTimeout(() => { flush().catch(error => onEvent('write-failed', { error: reason(error) })) }, WRITE_DELAY_MS)
    timer.unref?.()
  }

  // Записи идут по очереди: пока пишется одна, следующая ждёт и потом пишет
  // самое свежее. Две записи одного файла одновременно — это гонка за .tmp.
  async function flush() {
    if (writing) return writing
    clearTimeout(timer)
    const run = (async () => {
      while (dirty.size) {
        const errors = []
        for (const key of [...dirty]) {
          if (!dirty.has(key)) continue
          const revision = revisions.get(key), epoch = syncEpoch
          const started = Date.now()
          try {
            await writeFileAsync(key, cache.get(key), epoch)
            if (epoch === syncEpoch && revisions.get(key) === revision) dirty.delete(key)
            onEvent('written', { key, ms: Date.now() - started })
          } catch (error) {
            // Keep this and every unattempted key dirty. Continue other datasets.
            errors.push(error)
          }
        }
        if (errors.length) throw new AggregateError(errors, 'bulk-store: запись не завершена')
      }
    })()
    writing = run
    try {
      await run
      settleIdle()
    } catch (error) {
      // Ожидающий узнаёт ту же причину, что и журнал: иначе окно решает, что
      // история сохранена, и человек теряет написанное молча.
      settleIdle(error)
      throw error
    } finally { if (writing === run) writing = null }
  }

  function settleIdle(error) {
    const waiters = idleWaiters
    idleWaiters = []
    idlePromise = null
    for (const waiter of waiters) error ? waiter.reject(error) : waiter.resolve()
  }

  // Ждать склеенную запись, а не запускать новую: несколько set подряд делят
  // одну запись, и все ожидающие получают её исход.
  function whenIdle() {
    if (!dirty.size && !writing) return Promise.resolve()
    if (!idlePromise) idlePromise = new Promise((resolve, reject) => { idleWaiters.push({ resolve, reject }) })
    const wait = idlePromise
    // После неудачной записи таймера уже нет: не оставлять ожидающего навсегда.
    if (dirty.size && !timer && !writing) flush().catch(() => {})
    return wait
  }

  // При выходе ждать нельзя: всё несохранённое пишется синхронно.
  function flushSync() {
    clearTimeout(timer)
    syncEpoch++
    const errors = []
    for (const key of [...dirty]) {
      try {
        writeFileSync(key, cache.get(key))
        dirty.delete(key)
      } catch (error) { errors.push(error) }
    }
    if (errors.length) {
      const failure = new AggregateError(errors, 'bulk-store: сохранение при выходе не завершено')
      settleIdle(failure)
      throw failure
    }
    settleIdle()
  }

  // Что не читается и почему — для главного процесса: он обязан сказать человеку
  // причину вместо молча пустого списка чатов. `unreadable` — за всю сессию,
  // `keyLost` — что не читается прямо сейчас (пока это не уложено в архив),
  // `corrupt` — из тех, что не открылись за сессию, какие: файлы, которые не
  // удалось разобрать (карантин), а не целые конверты с чужим ключом.
  function integrity() {
    return { keyLost: [...keyLost], unreadable: [...lostThisSession], blocked: [...blocked.keys()], corrupt: [...corruptThisSession] }
  }

  return { get, set, flush, flushSync, whenIdle, fileOf, pending: () => dirty.size, integrity }
}

module.exports = { create, WRITE_DELAY_MS }
