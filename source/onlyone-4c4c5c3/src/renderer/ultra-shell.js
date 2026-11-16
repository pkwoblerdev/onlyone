/* Оболочка Ultra.

   Экран выбирается ЗНАЧЕНИЕМ версии из конфигурации интерфейса:
   `versionPreset` = default | pro | ultra. При `default` и `pro` модуль не
   делает ровно ничего — ни узлов, ни признака на корне, ни тронутых
   переменных: `pro` остаётся значением, а не раскладкой. При `ultra` оболочка
   строится в `deps.host`, вешает на `<html>` признак `data-version-preset`
   (тем же способом, что `data-app-ready` и `data-theme` в этом дереве) и гасит
   боковую панель и панель «Работа» ДВУМЯ СУЩЕСТВУЮЩИМИ переменными —
   `--sidebar-display` и `--work-panel-display`; третьего выключателя здесь нет.

   Живой фон-горизонт (макет 2.0, `drawUltra`) рисуется на холсте в слое, который
   уходит ЗА содержимое окна, — а слой с отрицательным `z-index` рисуется ПОД
   фоном `body` и `#app`. Поэтому база Ultra лежит на `<html>`, а предки холста
   под признаком пресета прозрачны: иначе фон невидим, хотя нарисован (на трёх
   кадрах он и был ровным).

   Три экрана, как в макете 2.0: вход (искра 56, приветствие, строка ввода и
   список «Сессии» в той же колонке 680, где первой стоит акцентная «Новая
   сессия»), пустая новая сессия (искра 44, приветствие, строка ввода 680, живой
   фон) и один чат (верхняя полоса 48 с кнопкой «‹ Сессии»; постоянной рейки с
   диалогами в Ultra нет). Название открытого диалога остаётся за шапкой чата:
   в оболочке список диалогов не появляется вторым.

   Модуль не знает ни про историю, ни про отправку: те же диалоги, то же
   «когда», то же приветствие и тот же `selectChat` приходят проводкой в
   `deps`. Ни моста, ни сети, ни настроек — как у `composer-menu.js`.
*/
(function (root) {
  'use strict'

  const ROOT_CLASS = 'ultra'
  const PRESET = 'ultra'
  const FLAG_ATTR = 'data-version-preset'
  // Панели прячутся переменными окна (см. toCssVariables в ui-config.js).
  const HIDE_VARS = ['--sidebar-display', '--work-panel-display']
  const STATE_CLASS = { entry: 'is-entry', empty: 'is-empty', chat: 'is-chat' }
  const SPARK_SIZE = { entry: 56, empty: 44 }
  // Ключ русские буквы: по-русски список
  // «Сессии», на английском та же строка через словарь («Sessions»).
  const SESSIONS = 'Сессии'
  const NEW_SESSION = 'Новая сессия'
  const THOUGHTS = 'Напишите свои мысли'
  // Папка и модель нужны до первого слова: без них Ultra не давал ни добавить
  // папку, ни выбрать модель. Обе подсказки уже есть в словаре окна.
  const FOLDER_TIP = 'Добавить папку'
  const MODEL_TIP = 'Каталог моделей и глубина рассуждений (Ctrl+M)'
  const NO_FOLDER = 'Без папки'
  const OPTIONS_MS = 800
  // Признак счётчика задач на корне: чужой узел оболочка не трогает, а стиль
  // под этим признаком решает, видна ли кнопка «Задачи» в Ultra.
  const TASKS_ATTR = 'data-ultra-tasks'
  // Знак «Цветок-искра»: та же геометрия, что `#appGlyph` в разметке окна, —
  // но собственный, чтобы оболочка не зависела от порядка подключения.
  const SPARK_VIEW = '9 9 46 46'
  const SPARK_PATH = 'M32 13.2l3.9 8.6 8.6 3.9-8.6 3.9-3.9 8.6-3.9-8.6-8.6-3.9 8.6-3.9z'
  const ICONS = {
    plus: 'M8 3.4v9.2M3.4 8h9.2',
    back: 'm9.8 4.2-4.2 3.8 4.2 3.8',
    settings: 'M2.6 5.4h10.8M2.6 10.6h10.8',
    send: 'M8 12.6V3.8M4.4 7.4 8 3.8l3.6 3.6',
    folder: 'M2.4 4.6a1 1 0 0 1 1-1h2.9l1.4 1.6h4.9a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z',
    model: 'M5.2 5.2h5.6v5.6H5.2zM8 2.6v2.6M8 10.8v2.6M2.6 8h2.6M10.8 8h2.6',
    down: 'm4.8 6.6 3.2 3 3.2-3',
    share: 'M8 10.4V3.6M5.2 6.4 8 3.6l2.8 2.8M3.6 12.8v4.6h10.8v-4.6',
    restore: 'M8 3.6v6.8M5.2 7.6 8 10.4l2.8-2.8M3.6 12.8v4.6h10.8v-4.6'
  }

  function create (deps) {
    const doc = deps.document
    const win = deps.window
    const host = deps.host
    const t = typeof deps.t === 'function' ? deps.t : value => String(value)

    let mode = 'off'
    let shell = null
    let config = null
    let saved = null            // чем были панели до Ultra — тем и вернём
    let wired = null            // один слушатель на весь экран: снять надо целиком
    let frame = 0
    let tasksWatcher = null     // наблюдатель за чужим счётчиком задач
    let blocksInstance = null   // свободные блоки результата: позиции живут в нём

    function say (text, ...args) {
      return typeof deps.t === 'function' ? deps.t(text, ...args) : String(text)
    }

    function ask (name, value) {
      const fn = deps[name]
      return typeof fn === 'function' ? fn(value) : undefined
    }

    function make (tag, className) {
      const node = doc.createElement(tag)
      if (className) node.className = className
      return node
    }

    function put (node, text) {
      node.appendChild(doc.createTextNode(String(text)))
      return node
    }

    // Подсказка — только `data-tooltip` (нативный `title` запрещён), имя для
    // чтения с экрана — `aria-label`.
    function name (node, text) {
      node.setAttribute('aria-label', say(text))
      node.setAttribute('data-tooltip', say(text))
      return node
    }

    function svg (className, view, size) {
      const mark = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      mark.setAttribute('class', className)
      mark.setAttribute('viewBox', view)
      mark.setAttribute('width', String(size))
      mark.setAttribute('height', String(size))
      mark.setAttribute('aria-hidden', 'true')
      return mark
    }

    function stroke (path, d) {
      const line = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      line.setAttribute('d', d)
      path.appendChild(line)
      return line
    }

    function icon (d, size) {
      const mark = svg('uico', '0 0 16 16', size || 16)
      stroke(mark, d)
      return mark
    }

    function spark (size) {
      const mark = svg('uspark spk', SPARK_VIEW, size)
      const petal = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      petal.setAttribute('class', 'uspark-mark')
      petal.setAttribute('fill-rule', 'evenodd')
      petal.setAttribute('d', sparkPath())
      mark.appendChild(petal)
      return mark
    }

    function sparkPath () {
      const glyph = typeof doc.getElementById === 'function' ? doc.getElementById('appGlyph') : null
      const path = glyph && typeof glyph.querySelector === 'function' ? glyph.querySelector('path') : null
      const d = path && typeof path.getAttribute === 'function' ? path.getAttribute('d') : ''
      return d || SPARK_PATH
    }

    // ─── живой фон: горизонт на холсте, зерно и виньетка ─────────────────────
    function aura () {
      const layer = make('div', 'ubg')
      layer.setAttribute('aria-hidden', 'true')
      const sky = make('canvas', 'ubg-sky')
      layer.appendChild(sky)
      layer.appendChild(make('div', 'ubg-grain'))
      layer.appendChild(make('div', 'ubg-vig'))
      return layer
    }

    function token (node, prop, fallback) {
      if (!node || typeof win.getComputedStyle !== 'function') return fallback
      const value = String(win.getComputedStyle(node).getPropertyValue(prop) || '').trim()
      return value || fallback
    }

    function paint (layer, sky) {
      const ctx = typeof sky.getContext === 'function' ? sky.getContext('2d') : null
      if (!ctx) return
      const box = typeof sky.getBoundingClientRect === 'function' ? sky.getBoundingClientRect() : null
      const wide = Math.max(1, Math.round((box && box.width) || win.innerWidth || 1280))
      const tall = Math.max(1, Math.round((box && box.height) || win.innerHeight || 760))
      const ratio = Math.max(1, Math.min(2, win.devicePixelRatio || 1))
      sky.width = Math.round(wide * ratio)
      sky.height = Math.round(tall * ratio)
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, wide, tall)
      const light = String(doc.documentElement.getAttribute('data-theme') || '') === 'light'
      const accent = token(layer, '--accent', '#e08c62')
      const base = token(layer, '--ubase', light ? '#f6f3ed' : '#0b0a09')
      const step = frozen() ? 0 : (Date.now() % 14000) / 14000
      const breath = 0.5 + 0.5 * Math.sin(step * Math.PI * 2)
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = base
      ctx.fillRect(0, 0, wide, tall)
      // Свет в цвете акцента: экран в Ultra один, и акцент на нём — только
      // горизонт. В тёмной теме света складывают, в светлой — умножают.
      ctx.globalCompositeOperation = light ? 'multiply' : 'screen'
      bloom(ctx, wide, tall, wide * 0.3, tall * (0.3 + 0.02 * breath), wide * 0.52, mix(accent, light ? 0.1 : 0.14))
      bloom(ctx, wide, tall, wide * 0.76, tall * (0.42 - 0.02 * breath), wide * 0.44, mix(accent, light ? 0.07 : 0.1))
      // Горизонт — под строкой ввода: свет над кромкой, тёмный диск и тонкая
      // акцентная линия там, где disk кончается.
      const rx = wide * 0.82
      const ry = Math.max(240, tall * 0.55)
      const cy = tall + ry - Math.max(120, tall * 0.22) - 3 * Math.sin(step * Math.PI * 2)
      bloom(ctx, wide, tall, wide * 0.5, cy - ry, rx * 0.9, mix(accent, (light ? 0.14 : 0.2) + 0.07 * breath))
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = shade(base, light ? 0.95 : 0.6)
      ctx.beginPath()
      ctx.ellipse(wide / 2, cy, rx, ry, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = mix(accent, light ? 0.75 : 1)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.ellipse(wide / 2, cy, rx, ry, 0, Math.PI * 1.12, Math.PI * 1.88)
      ctx.stroke()
    }

    function bloom (ctx, wide, tall, cx, cy, radius, color) {
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
      grad.addColorStop(0, color)
      grad.addColorStop(1, mix(color, 0))
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, wide, tall)
    }

    // Прозрачность от токена, без цвета мимо палитры в коде окна. Умеет и
    // `#rgb`/`#rrggbb`, и готовый `rgba(…)`: край градиента — тот же цвет, но
    // обнулённой альфы.
    function readColor (value) {
      const plain = String(value || '').trim()
      const hex = /^#([0-9a-f]{3,6})$/i.exec(plain)
      if (hex) {
        const short = hex[1].length === 3 ? hex[1].replace(/./g, pair => pair + pair) : hex[1]
        return [0, 2, 4].map(at => parseInt(short.slice(at, at + 2), 16))
      }
      const parts = /^rgba?\(([^)]+)\)$/i.exec(plain)
      if (parts) {
        const nums = parts[1].split(/[,/\s]+/).filter(Boolean).map(Number)
        if (nums.length >= 3 && nums.every(item => Number.isFinite(item))) return nums.slice(0, 3)
      }
      return null
    }

    function mix (color, alpha) {
      const share = Math.max(0, Math.min(1, alpha))
      const rgb = readColor(color)
      if (!rgb) {
        const plain = String(color).trim()
        return `color-mix(in srgb, ${plain} ${Math.round(share * 100)}%, transparent)`
      }
      return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${share.toFixed(3)})`
    }

    // Затемнение базы для диска горизонта: цвет берётся из того же токена,
    // нового цвета в палитре оболочки нет.
    function shade (color, factor) {
      const rgb = readColor(color)
      if (!rgb) return String(color)
      const share = Math.max(0, Math.min(1, factor))
      return `rgb(${rgb.map(item => Math.round(item * share)).join(', ')})`
    }

    // «Уменьшить движение» — фон замирает: один кадр, без петли.
    function frozen () {
      return !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches)
    }

    function animate (layer, sky) {
      if (typeof sky.getContext !== 'function') return
      paint(layer, sky)
      if (frozen() || typeof win.requestAnimationFrame !== 'function') return
      const step = () => {
        if (frozen()) { paint(layer, sky); return }
        paint(layer, sky)
        frame = win.requestAnimationFrame(step)
      }
      frame = win.requestAnimationFrame(step)
    }

    function halt () {
      if (frame && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(frame)
      frame = 0
    }

    // ─── строка ввода: та же форма с textarea, что у композера окна ───────────
    function composer () {
      const form = make('form', 'ucmp')
      const field = make('textarea', 'uint')
      field.setAttribute('rows', '1')
      field.setAttribute('placeholder', say(THOUGHTS))
      field.setAttribute('aria-label', say(THOUGHTS))
      field.setAttribute('autocomplete', 'off')
      form.appendChild(field)
      const send = make('button', 'usend')
      send.setAttribute('type', 'submit')
      name(send, 'Отправить')
      send.appendChild(icon(ICONS.send, 16))
      form.appendChild(send)
      form.addEventListener('submit', event => {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        const text = String(field.value || '').trim()
        if (!text) return
        field.value = ''
        deps.send(text)
        // Написанное уходит в чат: экрана пустой сессии больше не нужно.
        if (mode !== 'chat') setMode('chat')
      })
      return form
    }

    // ─── папка и модель под строкой ввода ─────────────────────────────────────
    // Обе кнопки зовут те же действия окна, что и обычная строка ввода: меню
    // папок и каталог моделей. Подписи читаются из окна и обновляются, пока
    // человек выбирает, — второй копии выбора нет.
    let optionsTimer = 0

    function optionButton (kind, glyph, tip) {
      const button = make('button', 'uopt-btn uopt-' + kind)
      button.setAttribute('type', 'button')
      button.setAttribute('data-tooltip', say(tip))
      button.setAttribute('aria-label', say(tip))
      button.appendChild(icon(glyph, 14))
      button.appendChild(make('span', 'uopt-text'))
      button.appendChild(icon(ICONS.down, 12))
      return button
    }

    function options () {
      const row = make('div', 'uopt')
      row.appendChild(optionButton('folder', ICONS.folder, FOLDER_TIP))
      row.appendChild(optionButton('model', ICONS.model, MODEL_TIP))
      paintOptions(row)
      return row
    }

    function paintOptions (row) {
      const box = row || (shell && typeof shell.querySelector === 'function' ? shell.querySelector('.uopt') : null)
      if (!box || typeof box.querySelector !== 'function') return
      const folder = box.querySelector('.uopt-folder .uopt-text')
      const model = box.querySelector('.uopt-model .uopt-text')
      let folderText = ''
      let modelText = ''
      try { folderText = typeof deps.folderLabel === 'function' ? String(deps.folderLabel() || '') : '' } catch (error) { folderText = '' }
      try { modelText = typeof deps.modelLabel === 'function' ? String(deps.modelLabel() || '') : '' } catch (error) { modelText = '' }
      // put() дописывает узел, а подпись обновляется каждые 0,8 с: сначала очистить.
      const swap = (node, text) => {
        if (!node || String(node.textContent || '') === text) return
        node.replaceChildren()
        put(node, text)
      }
      swap(folder, folderText || say(NO_FOLDER))
      swap(model, modelText)
    }

    function watchOptions () {
      unwatchOptions()
      if (!win || typeof win.setInterval !== 'function') return
      optionsTimer = win.setInterval(() => paintOptions(), OPTIONS_MS)
    }

    function unwatchOptions () {
      if (optionsTimer && win && typeof win.clearInterval === 'function') win.clearInterval(optionsTimer)
      optionsTimer = 0
    }

    // ─── вход: искра, приветствие, строка ввода, список Sessions ─────────────
    function entry () {
      const panel = make('div', 'uentry')
      panel.appendChild(spark(SPARK_SIZE.entry))
      put(panel.appendChild(make('h1', 'uhello')), String(ask('greeting') || ''))
      panel.appendChild(composer())
      panel.appendChild(options())

      const list = make('div', 'usess')
      list.setAttribute('role', 'group')
      list.setAttribute('aria-label', say(SESSIONS))
      put(list.appendChild(make('div', 'usess-label')), say(SESSIONS))

      const fresh = make('button', 'urow urow-new')
      fresh.setAttribute('type', 'button')
      fresh.appendChild(icon(ICONS.plus, 14))
      put(fresh, say(NEW_SESSION))
      list.appendChild(fresh)

      const chats = deps.chats()
      for (const chat of Array.isArray(chats) ? chats : []) {
        const row = make('button', 'urow')
        row.setAttribute('type', 'button')
        row.setAttribute('data-chat-id', String(chat.id))
        put(row, String(chat.title || ''))
        put(row.appendChild(make('span', 'urow-when')), String(ask('timeOf', chat) || ''))
        list.appendChild(row)
      }
      panel.appendChild(list)
      return panel
    }

    // ─── пустая новая сессия ──────────────────────────────────────────────────
    function empty () {
      const panel = make('div', 'uempty')
      panel.appendChild(spark(SPARK_SIZE.empty))
      put(panel.appendChild(make('h1', 'uhello')), String(ask('greeting') || ''))
      panel.appendChild(composer())
      panel.appendChild(options())
      return panel
    }

    // ─── полоса 48 px одного чата ─────────────────────────────────────────────
    function bar (title) {
      const strip = make('div', 'ubar')
      const back = make('button', 'ubk')
      back.setAttribute('type', 'button')
      back.appendChild(icon(ICONS.back, 14))
      put(back, say(SESSIONS))
      strip.appendChild(back)
      // Полоса входа несёт название; в одном чате имя диалога остаётся за
      // шапкой чата — второго списка и второго имени здесь нет.
      if (title) put(strip.appendChild(make('span', 'ut')), title)
      // Workspace. Две кнопки рядом с настройками — выгрузить и открыть.
      // Оболочка не знает, что внутри контейнера: она отдаёт своё (блоки и их
      // раскладку) и зовёт окно, а то, что вышло, окно и говорит само.
      for (const [kind, label, iconPath] of [
        ['export', 'Выгрузить Workspace', ICONS.share],
        ['import', 'Открыть Workspace', ICONS.restore]
      ]) {
        const action = make('button', 'ub-ws')
        action.setAttribute('type', 'button')
        name(action, label)
        action.dataset.workspace = kind
        action.appendChild(icon(iconPath, 16))
        action.addEventListener('click', () => {
          if (typeof deps.onWorkspace === 'function') deps.onWorkspace(kind)
        })
        strip.appendChild(action)
      }
      const set = make('button', 'ub-set')
      set.setAttribute('type', 'button')
      name(set, 'Настройки')
      set.appendChild(icon(ICONS.settings, 16))
      strip.appendChild(set)
      return strip
    }

    // ─── свободные блоки результата ───────────────────────────────────────────
    // Модуль отдаёт окно (`deps.blocks`), список результатов — `deps.results`,
    // открытие — `deps.openResult` тем же путём, что кнопка в ряду артефактов.
    // Экземпляр один на оболочку: в нём живут позиции, которые человек расставил.
    //
    // Тем же слоем открывается и экран «Задач» —
    // свободным блоком, а не панелью на пол-окна. Тело блока оболочка не
    // собирает: оно принадлежит окну (`deps.tasksBody`), а здесь только предмет
    // в списке, переключение и память места (`deps.loadLayout` /
    // `deps.saveLayout`).
    const TASKS_ID = 'ultra-tasks'
    const TASKS_W = 360
    const TASKS_H = 480
    let tasksOpen = false
    let tasksGeo = null

    function saveGeometry (api) {
      if (!api || typeof deps.saveLayout !== 'function') return
      try { deps.saveLayout(api.geometry()) } catch (error) { /* диск не вправе ронять экран */ }
    }

    function blocksApi () {
      const api = deps.blocks
      if (!api || typeof api.create !== 'function') return null
      if (!blocksInstance) {
        blocksInstance = api.create({
          document: doc,
          window: win,
          t: typeof deps.t === 'function' ? deps.t : undefined,
          open: item => ask('openResult', item),
          onCloseTasks: () => ask('onCloseTasks'),
          keepOut: () => ask('composerRect'),
          bodyFor: item => (item && item.id === TASKS_ID ? takeBody() : null),
          onChange: () => saveGeometry(blocksInstance)
        })
        // Что человек расставил в прошлый запуск — возвращается до первого
        // рисования: иначе блок мигнул бы на старом месте и переехал. Окно
        // может отдать сохранённое обещанием (оно читает диск у главного
        // процесса) — тогда слой принимает его, как только придёт.
        if (typeof deps.loadLayout === 'function') {
          const take = stored => {
            if (!stored || typeof stored !== 'object' || typeof blocksInstance?.restore !== 'function') return
            blocksInstance.restore(stored)
            showResults()
          }
          try {
            const stored = deps.loadLayout()
            if (stored && typeof stored.then === 'function') stored.then(take).catch(() => {})
            else take(stored)
          } catch (error) { /* без сохранённого блок встанет по умолчанию */ }
        }
      }
      return blocksInstance
    }

    // ─── что оболочка отдаёт в Workspace ─────────────────────────────────
    // Раскладку знает оболочка: блоки и их места живут на её слое, а не в окне.
    // Окно собирает из этого Workspace (агенты, инструменты, файлы, контекст) и
    // зовёт главный процесс — ядро контейнера отвечает и за то, что цело, и за
    // то, что не нашлось.
    function workspaceBlocks () {
      const api = blocksInstance
      const geometry = api && typeof api.geometry === 'function' ? api.geometry() : {}
      const rows = []
      const titles = new Map()
      for (const node of doc.querySelectorAll('.ublock[data-block-id]')) {
        const title = String(node.querySelector('.ublock-title')?.textContent || '')
          .replace(/\s+/g, ' ').trim()
        if (title) titles.set(String(node.getAttribute('data-block-id')), title)
      }
      for (const [id, one] of Object.entries(geometry || {})) {
        rows.push({
          id: String(id),
          // Название берётся с экрана, а не из геометрии: в раскладке его нет, и
          // контейнер без названий собрал бы Workspace из безытых блоков.
          title: titles.get(String(id)) || String(id),
          role: String(id) === TASKS_ID ? 'tasks' : 'block',
          x: Number(one && one.x) || 0,
          y: Number(one && one.y) || 0,
          w: Number(one && one.w) || 0,
          h: Number(one && one.h) || 0,
          zone: String((one && one.zone) || 'free'),
          min: Boolean(one && one.min)
        })
      }
      return { rows, count: rows.length }
    }

    // Развернутый Workspace возвращает блоки на места. Геометрия пришла из
    // главного процесса, и её надо отдать слою — иначе импорт «прошёл», а экран
    // остался старым, и человек решит, что чужий Workspace не работает.
    function setWorkspaceLayout (map) {
      if (!blocksInstance || typeof blocksInstance.restore !== 'function') return false
      try {
        blocksInstance.restore(map || {})
        showResults()
        return true
      } catch (error) {
        return false
      }
    }

    // Узел, который окно отдало как тело блока, живёт у оболочки, пока блок
    // открыт, и ОБЯЗАНА вернуть его домой: `dispose()` выбрасывает весь слой,
    // и оставшийся в нём экран пропал бы из окна. Учёт держится здесь, а не в
    // `app.js` (сторож 2d следит за размером окна).
    let bodyHome = null

    function takeBody () {
      if (typeof deps.tasksBody !== 'function') return null
      const node = deps.tasksBody()
      const parent = node && node.parentElement
      const insideLayer = parent && typeof parent.closest === 'function' && parent.closest('.ublocks')
      if (node && !bodyHome && parent && !insideLayer) {
        bodyHome = { parent, next: node.nextSibling }
      }
      return node
    }

    function giveBodyBack () {
      if (!bodyHome || typeof deps.tasksBody !== 'function') return
      const node = deps.tasksBody()
      if (!node || node.parentElement === bodyHome.parent) return
      bodyHome.parent.insertBefore(node, bodyHome.next || null)
    }

    // Предмет «Задачи»: мера своя, место — под кнопкой, если человек ещё
    // ничего не передвигал. Сохранённое важнее кнопки.
    function tasksItem (api) {
      const item = { id: TASKS_ID, title: say('Задачи'), kind: 'tasks', w: TASKS_W, h: TASKS_H }
      const known = api && typeof api.geometry === 'function' ? api.geometry()[TASKS_ID] : null
      if (known) return item
      const anchor = typeof deps.tasksAnchor === 'function' ? deps.tasksAnchor() : null
      // Прямоугольник скрытого узла — нули: на них блок уезжал к левому краю
      // окна (в Ultra кнопка «Задачи» спрятана при нулевом счётчике). Значит
      // считать по ней можно только по настоящему прямоугольнику; иначе
      // остаётся общая сетка раскладки.
      const real = anchor && Number(anchor.width) > 0 && Number(anchor.height) > 0 &&
        Number.isFinite(Number(anchor.right))
      if (real) {
        item.x = Math.round(Number(anchor.right) - TASKS_W)
        const bottom = Number(anchor.bottom)
        // Нижнего края кнопки нет — пусть блок встанет по общей сетке: лучше
        // привычное место, чем странный прыжок от нулевой координаты.
        if (Number.isFinite(bottom)) item.y = Math.round(bottom + 8)
      }
      return item
    }

    function withTasks (items) {
      const list = Array.isArray(items) ? items.slice() : []
      if (tasksOpen && !list.some(item => item && String(item.id) === TASKS_ID)) {
        list.push(tasksItem(blocksApi()))
      }
      return list
    }

    function showResults () {
      const api = blocksApi()
      if (!api || typeof deps.results !== 'function') return
      let listed = null
      try { listed = deps.results() } catch (error) { return }
      const apply = value => {
        const one = blocksApi()
        if (one) one.render(Array.isArray(value) ? value : [])
      }
      // Список пришёл обычным массивом — рисовать надо сразу: перерисовка
      // слоем через обещание отложила бы появление блока на кадр, и нажатие
      // «Задачи» выглядело бы промахнувшимся.
      if (Array.isArray(listed)) { apply(withTasks(listed)); return }
      // Список не пришёл — результаты остаются как были, но открытые по
      // нажатию «Задачи» обязаны доехать до экрана: их список не зависит от
      // артефактов диалога. Отказ при этом не прячется: чистый модуль журнала
      // не ведёт, он сообщает окну.
      Promise.resolve(listed).then(items => apply(withTasks(items)))
        .catch(error => {
          apply(withTasks([]))
          ask('resultsFailed', error)
        })
    }

    // Нажатие «Задачи»: true значит, что Ultra открыла свой блок и окну больше
    // ничего не делать. Вне экрана чата слоя блоков нет — там остаётся обычное
    // поведение окна.
    function tasksClicked () {
      if (mode !== 'chat') return false
      const api = blocksApi()
      if (!api) return false
      if (tasksOpen) {
        const one = api.geometry ? api.geometry() : null
        tasksGeo = (one && one[TASKS_ID]) || null
        tasksOpen = false
        showResults()
        // Экран, который блок держал у себя, возвращается на прежнее место в
        // окне: иначе закрытый блок оставил бы «Задачи» невидимыми до
        // перезапуска.
        giveBodyBack()
        ask('tasksHidden')
        saveGeometry(api)
        return true
      }
      if (tasksGeo && typeof api.restore === 'function') api.restore({ [TASKS_ID]: tasksGeo })
      tasksOpen = true
      showResults()
      ask('tasksShown')
      return true
    }

    function draw () {
      if (!host) return
      halt()
      host.replaceChildren()
      shell = make('div', ROOT_CLASS)
      const back = aura()
      shell.appendChild(back)
      if (mode === 'entry') {
        shell.classList.add(STATE_CLASS.entry)
        const set = make('button', 'ub-set ub-set2')
        set.setAttribute('type', 'button')
        name(set, 'Настройки')
        set.appendChild(icon(ICONS.settings, 16))
        shell.appendChild(set)
        shell.appendChild(entry())
      } else if (mode === 'empty') {
        shell.classList.add(STATE_CLASS.empty)
        shell.appendChild(bar(say(NEW_SESSION)))
        shell.appendChild(empty())
      } else if (mode === 'chat') {
        shell.classList.add(STATE_CLASS.chat)
        shell.appendChild(bar(''))
        // Свободные блоки результата живут в этом же слое: окно отдаёт список,
        // модуль расставляет их поверх ленты.
        const blocks = blocksApi()
        if (blocks) blocks.mount(shell)
        showResults()
      }
      host.appendChild(shell)
      // Живой фон рисуется после вставки: токены темы видны только что
      // построенному слою, а не документу целиком.
      const sky = back.firstChild
      if (sky) animate(back, sky)
    }

    // Одна проводка на весь экран: строки диалогов, «Новая сессия», возврат и
    // кнопка настроек слушаются на хосте и снимаются вместе с оболочкой.
    // `closest` вызывается по одному селектору: список через запятую понимает
    // не каждый DOM (и узловой харнесс, и старые движки).
    function onClick (event) {
      const target = event.target
      if (!target || typeof target.closest !== 'function') return
      const row = target.closest('[data-chat-id]')
      if (row) {
        openSession(row.getAttribute('data-chat-id'))
        return
      }
      const button = target.closest('button')
      if (!button || !button.classList) return
      if (button.classList.contains('ubk')) {
        showEntry()
        return
      }
      const optionBox = typeof button.getBoundingClientRect === 'function' ? button.getBoundingClientRect() : { left: 0, bottom: 0 }
      if (button.classList.contains('uopt-folder')) {
        if (typeof deps.openFolders === 'function') deps.openFolders(optionBox.left, optionBox.bottom + 4)
        return
      }
      if (button.classList.contains('uopt-model')) {
        if (typeof deps.openModels === 'function') deps.openModels(button)
        return
      }
      if (button.classList.contains('ub-set')) {
        if (typeof deps.openSettings === 'function') deps.openSettings()
        return
      }
      if (button.classList.contains('urow-new')) {
        if (typeof deps.newChat === 'function') deps.newChat()
        newSession()
      }
    }

    function setMode (next) {
      mode = next
      draw()
    }

    // Признак режима на `<html>` и две переменные панелей — всё, что оболочка
    // меняет вне своего узла.
    function flag () {
      doc.documentElement.setAttribute(FLAG_ATTR, PRESET)
      if (!saved) {
        saved = {}
        for (const key of HIDE_VARS) saved[key] = doc.documentElement.style.getPropertyValue(key)
      }
      for (const key of HIDE_VARS) doc.documentElement.style.setProperty(key, 'none')
    }

    function unflag () {
      if (doc.documentElement.getAttribute(FLAG_ATTR) === PRESET) {
        doc.documentElement.removeAttribute(FLAG_ATTR)
      }
      if (!saved) return
      for (const key of HIDE_VARS) {
        if (saved[key]) doc.documentElement.style.setProperty(key, saved[key])
        else doc.documentElement.style.removeProperty(key)
      }
      saved = null
    }

    // Счётчик задач — узел центра задач окна: оболочка его не трогает и только
    // переносит «ноль / не ноль» на корень. Дальше решает стиль.
    function tasksBadge () {
      return typeof deps.$ === 'function' ? deps.$('taskCenterBadge') : null
    }

    function syncTasks () {
      const badge = tasksBadge()
      // Узла счётчика нет — признака на корень нет, и стиль молчит: кнопка
      // «Задачи» остаётся такой, какой её делает окно.
      if (!badge) return
      const digits = String(badge.textContent || '').replace(/[^0-9]/g, '')
      doc.documentElement.setAttribute(TASKS_ATTR, Number(digits || 0) > 0 ? 'some' : 'zero')
    }

    function watchTasks () {
      syncTasks()
      if (tasksWatcher) return
      const Observer = deps.MutationObserver || (win && win.MutationObserver)
      const badge = tasksBadge()
      if (typeof Observer !== 'function' || !badge) return
      try {
        tasksWatcher = new Observer(() => syncTasks())
        tasksWatcher.observe(badge, { childList: true, characterData: true, subtree: true })
      } catch (error) {
        tasksWatcher = null
      }
    }

    function unwatchTasks () {
      if (tasksWatcher && typeof tasksWatcher.disconnect === 'function') tasksWatcher.disconnect()
      tasksWatcher = null
      doc.documentElement.removeAttribute(TASKS_ATTR)
    }

    function build () {
      if (mode === 'off') mode = 'entry'
      draw()
      flag()
      watchTasks()
      watchOptions()
      if (!wired && host && typeof host.addEventListener === 'function') {
        host.addEventListener('click', onClick)
        wired = host
      }
    }

    function clear () {
      halt()
      unflag()
      unwatchTasks()
      unwatchOptions()
      if (tasksOpen) {
        tasksOpen = false
        ask('tasksHidden')
      }
      giveBodyBack()
      bodyHome = null
      if (blocksInstance && typeof blocksInstance.dispose === 'function') blocksInstance.dispose()
      blocksInstance = null
      if (wired && typeof wired.removeEventListener === 'function') {
        wired.removeEventListener('click', onClick)
      }
      wired = null
      if (host) host.replaceChildren()
      shell = null
      mode = 'off'
    }

    function isUltra (candidate) {
      return !!(candidate && candidate.versionPreset === PRESET)
    }

    function apply (next) {
      config = next || config
      if (!isUltra(config)) {
        // Обычный вид и Pro: ни узлов, ни признака, ни тронутых переменных.
        if (shell || wired || mode !== 'off') clear()
        return
      }
      build()
    }

    function openSession (id) {
      // Полоса одного чата строится до провода: окно на выборе диалога
      // перерисовывает историю, а история зовёт пересборку оболочки — так
      // последний кадр рисует именно чат, а не мелькнувший вход.
      setMode('chat')
      deps.selectChat(id)
    }

    function newSession () {
      setMode('empty')
    }

    function showEntry () {
      setMode('entry')
    }

    return Object.freeze({
      mount: apply,
      update: apply,
      // Окно зовёт это, когда список результатов изменился (ход дописал
      // артефакт, панель что-то убрала): перерисовывать весь экран не нужно.
      refresh: showResults,
      state: () => (shell ? mode : 'off'),
      // Окно спрашивает, кто открывает «Задачи». true — Ultra показала
      // свободный блок, оконного экрана на пол-окна не было.
      tasksClicked,
      openSession,
      newSession,
      showEntry,
      // Раскладка для Workspace и приём раскладки обратно. Обе функции
      // принадлежат оболочке: блоки и их места живут на её слое.
      workspaceBlocks,
      setWorkspaceLayout,
      dispose: clear
    })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneUltraShell = api
})(typeof window === 'object' ? window : globalThis)
