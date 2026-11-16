// U-7: Workspace Ultra в окне — сбор, выгрузка, разворот.
//
// Отдельный модуль, а не часть `app.js`, по прямой причине: `app.js` стоит у
// своего потолка (`test-app-split` держит 11 900 строк, а вынос поведения в
// модуль — правило, а не вкус). Название Workspace уже занято в главном процессе
// рабочей ПАПКОЙ проекта, поэтому здесь оно означает ровно то, что сказал
// владелец 01.10: то, что человек КРАФТИТ в Ultra — расположение блоков,
// активных агентов, инструменты, подключённые файлы, контекст и сценарии — и чем
// делится.
//
// ЧТО ЗДЕСЬ И ЧТО НЕ ЗДЕСЬ. Здесь окно: собрать Workspace из настоящего
// состояния, показать человеку, что вышло, и сказать оболочке, где теперь стоят
// блоки. Ядро контейнера — `src/main/workspace-crate.js`, хранилище и перенос —
// `src/main/workspace-store.js`. Диалог выбора файла — главный процесс.
//
// ЧТО В ИСТОЧНИКЕ У КАЖДОЙ ЧАСТИ И ПОЧЕМУ ОТТУДА. Ни одна часть не выдумывается:
//   блоки       — раскладка слоя, её знает оболочка;
//   файлы       — что ход в этом диалоге действительно менял (`fileChanges`
//                 последнего ответа): единственное место, где список не выдуман;
//   агенты      — кто на самом деле отвечал (`stages` последнего ответа);
//   инструменты — что окно умеет сейчас: контейнер разворачивается у того, у
//                 кого эти инструменты есть;
//   контекст    — поля для него в Ultra нет, человек его не вводит. Пустое поле
//                 честнее выдуманного заголовка, и место в контейнере остаётся;
//   сценарии    — именованных сценариев в Ultra тоже пока нет.
(function (root) {
  'use strict'

  function create (deps) {
    const t = typeof deps.t === 'function' ? deps.t : value => String(value == null ? '' : value)
    const toast = typeof deps.toast === 'function' ? deps.toast : () => {}
    const electronAPI = deps.electronAPI || (typeof root !== 'undefined' && root.electronAPI) || {}
    // Раскладку знает оболочка: блоки и их места живут на её слое.
    const shell = () => (typeof deps.shell === 'function' ? deps.shell() : null)
    // Последний ответ текущего диалога — единственное место, где состав хода
    // известен целиком.
    const lastRecord = typeof deps.lastAssistantRecord === 'function' ? deps.lastAssistantRecord : () => null

    const fileNames = () => {
      const record = lastRecord()
      const out = new Set()
      for (const change of (record && record.fileChanges) || []) {
        // Имя, а не путь: у того, кто откроет контейнер, чужих путей всё равно нет.
        const clean = String((change && (change.file || change.path)) || '').split(/[\\/]/).pop().trim()
        if (clean) out.add(clean)
      }
      return [...out]
    }

    const agentNames = () => {
      const record = lastRecord()
      const out = new Set()
      for (const stage of (record && record.stages) || []) {
        const name = String((stage && (stage.name || stage.modelName)) || '').trim()
        if (name) out.add(name)
      }
      return [...out]
    }

    async function toolNames () {
      let capability = null
      try { capability = await electronAPI.getToolCapability?.() } catch (error) { /* нет моста — пустым */ }
      const list = capability && (capability.tools || capability.names)
      return (Array.isArray(list) ? list : []).map(one => String(one || '').trim()).filter(Boolean)
    }

    async function collect () {
      const view = shell()?.workspaceBlocks?.() || { rows: [] }
      const rows = Array.isArray(view.rows) ? view.rows : []
      return {
        name: t('Мой Workspace'),
        blocks: rows.map(one => ({
          title: one.title || one.id || t('Блок'),
          role: one.role || '',
          x: Number(one.x) || 0,
          y: Number(one.y) || 0,
          w: Number(one.w) || 360,
          h: Number(one.h) || 480,
          zone: one.zone || 'free',
          minimized: Boolean(one.min)
        })),
        agents: agentNames(),
        tools: await toolNames(),
        files: fileNames(),
        context: '',
        scenarios: []
      }
    }

    // Молчание здесь равно «человек не понял, куда делся его Workspace», а это
    // худший вид поломки: он уносит файл и решает, что кнопка сломалась.
    function say (result, what) {
      if (!result) { toast(t('Workspace не отвечает.'), true); return false }
      if (result.canceled) return false
      if (result.ok === false || result.reason) {
        toast(String(result.reason || result.error || t('Не получилось.')), true)
        return false
      }
      const missing = Array.isArray(result.missing) && result.missing.length
        ? t(' · не нашлось: ') + result.missing.join(', ')
        : ''
      toast(what + missing)
      return true
    }

    // Выгрузка: профиль сохраняется, потом человек выбирает файл. Сохранение
    // идёт первым не по привычке, а по смыслу: если выгрузить не выйдет, у
    // человека останется Workspace в профиле, а не пустота.
    async function load () { return electronAPI.getUltraWorkspace?.() }
    async function preview () { return electronAPI.previewUltraWorkspace?.() }

    async function run (kind) {
      try {
        if (kind === 'export') {
          const workspace = await collect()
          const saved = await electronAPI.saveUltraWorkspace?.(workspace, { author: '' })
          if (saved && saved.ok === false) { say(saved, ''); return false }
          return say(await electronAPI.exportUltraWorkspace?.(workspace, { author: '' }), t('Workspace выгружен.'))
        }
        if (kind === 'import') {
          const landed = await electronAPI.importUltraWorkspace?.()
          const told = say(landed, t('Workspace открыт.'))
          if (!told) return false
          // Раскладка вернулась в главный процесс и уже записана в общий файл;
          // оболочке надо её перечитать, иначе блоки останутся на старых местах
          // и «открылось то же самое» окажется неправдой.
          const view = await electronAPI.getUltraLayout?.()
          const took = shell()?.setWorkspaceLayout?.(view || {})
          if (!took) toast(t('Места блоков вернулись в файл, но экран их не взял.'), true)
          return took !== false
        }
        if (kind === 'save') {
          return say(await electronAPI.saveUltraWorkspace?.(await collect(), { author: '' }), t('Workspace сохранён.'))
        }
        return false
      } catch (error) {
        if (typeof deps.onError === 'function') deps.onError(error)
        say({ ok: false, reason: String((error && error.message) || error) }, '')
        return false
      }
    }

    return Object.freeze({ collect, run, say, load, preview })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneUltraWorkspace = api
})(typeof window === 'object' ? window : globalThis)
