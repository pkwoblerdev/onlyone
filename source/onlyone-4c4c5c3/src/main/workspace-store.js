// Хранилище Workspace (U-7): профиль на диске и перенос контейнера в файл.
//
// Ядро контейнера — `src/main/workspace-crate.js`: что кладётся в файл, чем
// проверяется целостность и как разворачивается чужой контейнер. Здесь другое:
// как Workspace живёт в профиле и как он уходит другому человеку.
//
// ПОЧЕМУ ВСЁ ПРИХОДИТ СНАРУЖИ. Файловая система, каталог и `protect`/`unprotect`
// — зависимостями. Иначе модуль знал бы про `app.getPath` и `safeStorage` и его
// нельзя было бы проверить без окна: набор подставил бы настоящее шифрование и
// настоящий каталог, и проверка «зашифровано ли» стала бы проверкой Electron. Всё
// это проверяется на временном каталоге набора, где «шифр» — просто ход туда и
// обратно.
//
// ЗАШИФРОВАНО ЛИ ВСЁ. Профиль лежит в `userData` рядом с историей, ключами и
// макетами, и в нём — имена файлов проекта, агенты и контекст работы. Всё, что
// в `userData`, идёт через `safeStorage`, и Workspace не исключение. Но если
// шифр недоступен (среда без кольца ключей, тестовый прогон), модуль НЕ
// роняет окно: пишет конверт только когда `protect` дан, а читает оба вида —
// иначе Workspace человека молча потерялся бы при первом же запуске.
//
// ЗАПИСЬ АТОМАРНА. Файл целиком переезжает через `.tmp` и `rename`: оборванная
// посреди записи запись не должна оставить после себя половину контейнера,
// которую потом не прочитать.
'use strict'

const path = require('node:path')
const crate = require('./workspace-crate')

const FILE = 'workspace.json'

function createWorkspaceStore (deps) {
  const options = deps || {}
  const fs = options.fs || require('node:fs')
  const dir = options.dir
  const protect = typeof options.protect === 'function' ? options.protect : null
  const unprotect = typeof options.unprotect === 'function' ? options.unprotect : null
  // Метка конверта — общая для всего профиля. Своя метка означала бы, что файл
  // забыли прикрыть тем же ключом, что остальное.
  const ENC = 'safeStorage'

  if (!dir) throw new Error('хранилищу Workspace нужен каталог профиля')

  const file = () => path.join(dir, FILE)

  // Тело, готовое к записи на диск. Конверт — только если шифр дан И вернул
  // строку: protect возвращает null без кольца ключей, и тогда пишем открытым
  // (обещание main.js у workspaceRead). Конверт с data:null терял содержимое
  // безвозвратно — save отвечал ok:true (break-5 Н10).
  const seal = text => {
    if (protect) {
      const data = protect(text)
      if (typeof data === 'string' && data) return JSON.stringify({ enc: ENC, data })
    }
    return text
  }

  const open = bytes => {
    const raw = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)
    let parsed = null
    try { parsed = JSON.parse(raw) } catch (error) { return { error: `не читается: ${String((error && error.message) || error).slice(0, 120)}` } }
    if (parsed && parsed.enc === ENC && typeof parsed.data === 'string') {
      if (!unprotect) return { error: 'файл зашифрован, а ключа на этой машине нет' }
      try { return { value: String(unprotect(parsed.data)) } } catch (error) {
        return { error: `не расшифровывается: ${String((error && error.message) || error).slice(0, 120)}` }
      }
    }
    return { value: raw }
  }

  // Запись атомарная и СИНХРОННАЯ. Синхронно — потому что так же устроены все
  // остальные хранилища главного процесса (`ultra-layout.json`, контрольные
  // точки): их читают обработчики, которые не ждут обещания, и ожидание здесь
  // означало бы, что место блока может оказаться не там, куда его положили.
  // `rename` на том же разделе атомарен, поэтому читатель либо видит прежний
  // файл, либо новый, но не половину.
  //
  // ПАПКА СОЗДАЁТСЯ ТОЛЬКО ДЛЯ ПРОФИЛЯ. Путь для выгрузки человек выбирает сам
  // в окне сохранения, и папка там уже есть. Создавать её молча значило бы
  // разложить файл там, куда человек не указывал, — и «выгрузилось» оказалось бы
  // правдой только наполовину.
  const writeAtomic = (target, text, ensureDir) => {
    if (ensureDir) fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${process.pid}`
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, target)
  }

  function load () {
    let bytes = null
    try { bytes = fs.readFileSync(file()) } catch (missing) {
      // Профиля ещё нет — это не поломка, а первый запуск. Только ENOENT:
      // EBUSY/EACCES/EISDIR от антивируса или сбоя диска — не первый запуск,
      // и пустой контейнер здесь дал бы окну сохранить пустоту поверх
      // настоящего Workspace (break-5 Н11).
      if (missing && missing.code === 'ENOENT') return { ok: true, workspace: crate.normalize({}), fresh: true }
      return { ok: false, reason: `Workspace не прочитан: ${String((missing && (missing.code || missing.message)) || missing).slice(0, 120)}` }
    }
    const opened = open(bytes)
    if (opened.error) return { ok: false, reason: `Workspace в профиле не прочитан — ${opened.error}` }
    let parsed = null
    try { parsed = JSON.parse(opened.value) } catch (error) {
      return { ok: false, reason: `Workspace в профиле не разобран — ${String((error && error.message) || error).slice(0, 120)}` }
    }
    // Профиль — тот же контейнер, и сумма проверяется тем же способом: файл,
    // который кто-то правил руками, не должен молча разворачиваться.
    const checked = crate.unpack(parsed)
    if (!checked.ok) return { ok: false, reason: `Workspace в профиле повреждён — ${checked.reason}` }
    return { ok: true, workspace: checked.workspace, meta: checked.meta }
  }

  function save (workspace, meta) {
    const packed = crate.pack(workspace, meta)
    try {
      const target = file()
      if (fs.existsSync(target)) {
        try {
          const existing = fs.readFileSync(target, 'utf8')
          let parsed = null
          try { parsed = JSON.parse(existing) } catch {}
          if (parsed && parsed.enc === ENC && typeof parsed.data === 'string') {
            let ok = false
            if (unprotect) {
              try { unprotect(parsed.data); ok = true } catch {}
            }
            if (!ok) {
              const aside = `${target}.corrupt-key-${Date.now()}`
              fs.writeFileSync(aside, existing, 'utf8')
            }
          }
        } catch {}
      }
      writeAtomic(target, seal(packed), true)
      return { ok: true, name: crate.normalize(workspace).name }
    } catch (error) {
      return { ok: false, reason: `Workspace не записан — ${String((error && error.message) || error).slice(0, 160)}` }
    }
  }

  // ЭКСПОРТ. Контейнер пишется ОТКРЫТЫМ текстом в файл, который человек уносит
  // сам, — и это осознанно. Внутри нет ни ключей, ни содержимого чужих файлов
  // (проверяет ядро), а шифровать файл, который получатель открывает на другой
  // машине, нечем: там чужой ключ. Что файл придётся записать открытым, человек
  // узнаёт из подписи окна сохранения, а не постфактум.
  function exportTo (target, workspace, meta) {
    if (!target) return { ok: false, reason: 'не выбран файл для Workspace' }
    const packed = crate.pack(workspace, meta)
    try {
      writeAtomic(target, packed)
      return { ok: true, file: target, bytes: Buffer.byteLength(packed, 'utf8') }
    } catch (error) {
      return { ok: false, reason: `Workspace не выгружен — ${String((error && error.message) || error).slice(0, 160)}` }
    }
  }

  // ИМПОРТ. Читает контейнер, проверяет его и СРАЗУ становится текущим
  // профилем: отдельного «принять» нет, потому что человек, открывший файл,
  // сказал этим действием, что хочет такое рабочее пространство. Что не
  // нашлось — возвращается списком, а не выбрасывается молча.
  function importFrom (source, options2) {
    if (!source) return { ok: false, reason: 'не выбран файл Workspace' }
    let bytes = null
    try { bytes = fs.readFileSync(source) } catch (error) {
      return { ok: false, reason: `файл Workspace не прочитан — ${String((error && error.message) || error).slice(0, 160)}` }
    }
    const opened = open(bytes)
    if (opened.error) return { ok: false, reason: `это не контейнер Workspace — ${opened.error}` }
    const parsed = crate.unpack(opened.value)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    const spread = crate.apply(parsed.workspace, (options2 && options2.available) || [])
    const written = save(spread.workspace, { author: spread.workspace.name })
    if (!written.ok) return written
    return {
      ok: true,
      workspace: spread.workspace,
      missing: spread.missing,
      report: spread.report,
      from: source,
      author: parsed.meta && parsed.meta.author
    }
  }

  // Список того, что человек может предложить: имя и сколько всего. Экспорт
  // одним куском в списке не помещается, поэтому окно зовёт `preview`.
  function preview () {
    const got = load()
    if (!got.ok) return { ok: false, reason: got.reason }
    const ws = got.workspace
    return {
      ok: true,
      name: ws.name,
      blocks: ws.blocks.length,
      agents: ws.agents.length,
      tools: ws.tools.length,
      files: ws.files.length,
      scenarios: ws.scenarios.length
    }
  }

  return { file: file(), load, save, exportTo, importFrom, preview }
}

module.exports = { createWorkspaceStore, FILE }
