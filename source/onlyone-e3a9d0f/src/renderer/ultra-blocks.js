/* Свободные блоки результата в Ultra.

   Макет 2.0 (`onlyone-mockup.html`, `.upanel`/`.umin`/`.rh`, строки 675–685,
   1127–1157, 1487–1518): результат открытого разговора лежит в окне СВОБОДНЫМ
   блоком — его можно перетащить за заголовок, растянуть за любой край или угол,
   прилепить к зоне (левый край, правый край, низ, во весь экран) с подсветкой
   границы, свернуть в пилюлю и убрать совсем, оставив способ вернуть.

   Модуль знает ТОЛЬКО геометрию и свои узлы: список результатов ему отдаёт
   `deps.items`, открытие — `deps.open`. Он не читает историю, не ходит в сеть и
   не трогает чужих узлов. Координаты живут в `geo` по id результата и
   переживают перечитывание списка: человек расставил блоки — события окна не
   имеют права вернуть всё как было.

   Блоком может быть и чужой экран — «Задачи» в
   Ultra. Тогда тело блока модулю отдаёт `deps.bodyFor(item)` (узел от окна), а
   сам узел только перевешивает: при перечитывании списка в блоке обязан остаться
   ТОТ ЖЕ объект, иначе экран потерял бы фокус поля, прокрутку и слушателей. У
   такого блока нет кнопки «Открыть»: второго пути на экран на пол-окна нет.
   Место и размер наружу отдаёт `geometry()` и принимает `restore(map)` — диск
   по-прежнему не его дело.

   Движение: перетаскивание и размер меняют координаты по сетке 8 px и ничего
   не анимируют — раскладка окна не дёргается, а «уменьшить движение» здесь
   соблюдать нечем (свой слой холста и искра живут в `ultra-shell.css`).

   Прилипший к борту блок ложился
   поверх колонки разговора и строки ввода — человек терял возможность печатать.
   Модуль МЕРЯЕТ отступ (`insets()` → `{ left, right }` пикселями числом: ширина
   прилипшего блока плюс зазор 16, иначе 0; на одной стороне — по самому
   широкому, без сложения) и относит его на КОРЕНЬ двумя переменными
   `--ultra-block-inset-left` / `--ultra-block-inset-right`. Колонки читают их
   сами и отступают собой (ветка под признаком пресета в `ultra-shell.css`);
   инлайновых `padding`/`margin`/`width`/`left`/`right` модуль на чужих узлах не
   ставит — переменная на `<html>` это всё, что он пишет вне `.ublocks`.
   Меряется по факту зоны, в которой блок осел, поэтому свёрнутая в пилюлю и
   убранная «прилиплость» отступ отпускает, а возврат ставит его обратно.
*/
(function (root) {
  'use strict'

  const GRID = 8
  const GAP = 8
  const BAND = 56             // полоса Ultra: под ней начинается работа
  const MIN_W = 280
  const MIN_H = 200
  const DEFAULT_W = 416
  const DEFAULT_H = 300
  // Ролик — вертикальный кадр 9:16: блок такой формы (кратно сетке 8 px) показывает
  // его целиком, а не полосой посреди широкого окна.
  const VIDEO_W = 304
  const VIDEO_H = 568
  const FIRST = { x: 640, y: 128 }
  const SNAP_EDGE = 28        // как далеко от края ещё считается краем
  const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  // Зазор между прилипшим блоком и колонкой разговора («ширина прилипшего блока
  // + 16») и две переменные на КОРНЕ, из которых
  // колонки берут себе `padding-inline` (см. ветку пресета в `ultra-shell.css`).
  const INSET_PAD = 16
  const INSET_VARS = { left: '--ultra-block-inset-left', right: '--ultra-block-inset-right' }
  const INSET_SIDES = ['left', 'right']
  // Зоны прилипания — те же четыре, что в макете (`LAY`, `snapZone`).
  const ZONE_NAMES = Object.freeze(['left', 'right', 'bottom', 'full'])
  const KIND_WORDS = {
    page: 'страница', table: 'таблица', chart: 'график', code: 'код',
    image: 'изображение', diff: 'разница', file: 'файл', note: 'заметка', video: 'видео'
  }

  function create (deps) {
    const doc = deps.document
    const win = deps.window || {}
    // Верхняя граница работы: в Ultra под полосой окна, в Desk холст начинается
    // сразу под шапкой, и блоки встают от отступа.
    const TOP = Number.isFinite(deps.top) ? deps.top : BAND
    const say = (text, ...args) => (typeof deps.t === 'function' ? deps.t(text, ...args) : String(text))

    let host = null
    let layer = null
    let items = []
    let drag = null
    let zone = null
    let wired = false         // слушатели документа: снять надо целиком
    const geo = new Map()     // id результата → { x, y, w, h, min, closed }
    const providedBlocks = new Map()

    const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
    const grid = value => Math.round(value / GRID) * GRID

    // ─── меры окна ────────────────────────────────────────────────────────────
    function area () {
      const rect = host && typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null
      const wide = (rect && rect.width) || win.innerWidth || 1280
      const tall = (rect && rect.height) || win.innerHeight || 760
      return {
        left: (rect && rect.left) || 0,
        top: (rect && rect.top) || 0,
        width: Math.max(MIN_W + 2 * GAP, wide),
        height: Math.max(MIN_H + TOP + GAP, tall)
      }
    }

    function point (event) {
      const box = area()
      return {
        x: Number((event && event.clientX) || 0) - box.left,
        y: Number((event && event.clientY) || 0) - box.top
      }
    }

    // Зоны прилипания — те же четыре, что в макете (`LAY`, `snapZone`).
    function zones () {
      const box = area()
      const half = grid((box.width - 3 * GAP) / 2)
      const tall = box.height - TOP - GAP
      return {
        left: { x: GAP, y: TOP, w: half, h: tall },
        right: { x: box.width - GAP - half, y: TOP, w: half, h: tall },
        bottom: { x: GAP, y: grid(box.height * 0.55), w: box.width - 2 * GAP, h: box.height - GAP - grid(box.height * 0.55) },
        full: { x: GAP, y: TOP, w: box.width - 2 * GAP, h: tall }
      }
    }

    function zoneAt (at) {
      const box = area()
      if (at.x <= SNAP_EDGE) return 'left'
      if (at.x >= box.width - SNAP_EDGE) return 'right'
      if (at.y <= TOP + 8) return 'full'
      if (at.y >= box.height - SNAP_EDGE) return 'bottom'
      return null
    }

    // у какого борта блок стоит ПОСЛЕ того, как указатель отпущен. Отпущен
    // в зоне — та же зона; блок тянули за край или сдвигали свободно — сторона
    // остаётся, только если он и правда до сих пор у этого борта. Так отступ
    // следует за состоянием, а не за памятью о прошлом броске.
    function dockedSide (state, dropped) {
      if (dropped) return dropped
      const box = area()
      if (state.zone === 'left' && state.x <= SNAP_EDGE) return 'left'
      if (state.zone === 'right' && box.width - (state.x + state.w) <= SNAP_EDGE) return 'right'
      return null
    }

    // ─── узлы ─────────────────────────────────────────────────────────────────
    function make (tag, className) {
      const node = doc.createElement(tag)
      if (className) node.setAttribute('class', className)
      return node
    }

    function put (node, text) {
      node.appendChild(doc.createTextNode(String(text)))
      return node
    }

    function button (className, text) {
      const node = make('button', className)
      node.setAttribute('type', 'button')
      const label = say(text)
      node.setAttribute('aria-label', label)
      node.setAttribute('data-tooltip', label)
      put(node, label)
      return node
    }

    // Чем результат и сколько в нём версий — словами окна, а не сырым полем.
    // `versions` приходит и числом, и списком: окно отдаёт запись артефакта как
    // есть, потому что её же посылает в панель открывать.
    function countOf (item) {
      const list = item && item.versions
      if (Array.isArray(list)) return list.length
      const value = Number(list)
      return Number.isFinite(value) && value >= 0 ? value : null
    }

    function sizeOf (item) {
      const kind = kindWord(item)
      const versions = countOf(item)
      return versions === null ? kind : say('%s · версий %s', kind, versions)
    }

    function kindWord (item) {
      const kind = String((item && item.kind) || 'file')
      return say(KIND_WORDS[kind] || kind)
    }

    function place (id, index, item) {
      const known = geo.get(id)
      if (known) return known
      const column = Math.floor(index / 2)
      const row = index % 2
      const tall = Boolean(item && item.kind === 'video')
      // Меру блока задаёт сам предмет: «Задачи» просят 360×480, ролик —
      // вертикальный кадр 9:16, остальные результаты — общую меру. Высота не
      // выше окна: на низком окне блок сжимается, а не вылезает за край.
      const box = area()
      const wantedW = Number(item && item.w) > 0 ? Number(item.w) : (tall ? VIDEO_W : DEFAULT_W)
      const wantedH = Number(item && item.h) > 0 ? Number(item.h) : (tall ? VIDEO_H : DEFAULT_H)
      const w = clamp(wantedW, MIN_W, Math.max(MIN_W, box.width - 2 * GAP))
      const h = clamp(wantedH, MIN_H, Math.max(MIN_H, box.height - TOP - GAP))
      const state = {
        // Стартовое место может задать предмет (так «Задачи» садятся под своей
        // кнопкой), иначе — общая сетка раскладки.
        x: clamp(Number.isFinite(Number(item && item.x)) ? Number(item.x)
          : FIRST.x - column * (DEFAULT_W + GAP), GAP, Math.max(GAP, box.width - GAP - w)),
        y: clamp(Number.isFinite(Number(item && item.y)) ? Number(item.y)
          : FIRST.y + row * (DEFAULT_H + GAP), TOP, Math.max(TOP, box.height - GAP - h)),
        w,
        h,
        min: false,
        closed: false,
        zone: null            // в какой зоне блок осел; `null` — стоит свободно
      }
      geo.set(id, state)
      return state
    }

    function blockNode (item) {
      const state = geo.get(item.id)
      const node = make('div', 'ublock')
      node.setAttribute('data-block-id', item.id)
      // Тело блока может принадлежать окну (`deps.bodyFor`): так в Ultra
      // открывается экран, у которого уже есть свои узлы, слушатели и прокрутка.
      // Модуль берёт этот узел целиком и НЕ пересобирает его при перечитывании
      // списка — второй `render()` обязан вернуть тот же объект, иначе экран
      // потерял бы ввод.
      const provided = typeof deps.bodyFor === 'function' ? deps.bodyFor(item) : null
      const head = make('div', 'ublock-head')
      head.setAttribute('data-drag', 'block')
      put(head.appendChild(make('span', 'ublock-title')), (item && item.title) || '')
      head.appendChild(make('span', 'ublock-spacer'))
      // «Открыть» — второй путь к результату, к панели артефакта. У блока,
      // который и есть тот экран, такой кнопки нет: иначе «Задачи» в Ultra
      // открывались бы экраном на пол-окна.
      if (!provided) {
        const open = button('ublock-open', 'Открыть')
        open.addEventListener('click', () => {
          if (typeof deps.open === 'function') deps.open(item)
        })
        head.appendChild(open)
      }
      const min = button('ublock-min', 'Свернуть')
      min.addEventListener('click', () => {
        state.min = true
        draw()
      })
      head.appendChild(min)
      const close = button('ublock-close', 'Убрать')
      close.addEventListener('click', () => {
        state.closed = true
        state.min = false
        draw()
      })
      head.appendChild(close)
      node.appendChild(head)
      if (provided) {
        node.appendChild(provided)
      } else if (item && item.kind === 'video' && item.url) {
        // Ролик (9.8) — не карточка с подписью, а окно с плеером: блок рендерится
        // тем, что в нём лежит. Подпись вида остаётся под плеером.
        const body = node.appendChild(make('div', 'ublock-meta ublock-media'))
        const player = make('video', 'ublock-video')
        player.setAttribute('controls', '')
        player.setAttribute('preload', 'metadata')
        player.setAttribute('playsinline', '')
        player.setAttribute('aria-label', say('Ролик'))
        // #t=0.1 — в блоке виден кадр ролика, а не пустой прямоугольник до нажатия «играть».
        player.setAttribute('src', item.url + '#t=0.1')
        body.appendChild(player)
        put(body.appendChild(make('div', 'ublock-caption')), sizeOf(item))
      } else {
        put(node.appendChild(make('div', 'ublock-meta')), sizeOf(item))
      }
      for (const edge of EDGES) {
        const grip = make('span', 'ublock-grip')
        grip.setAttribute('data-edge', edge)
        grip.setAttribute('aria-hidden', 'true')
        node.appendChild(grip)
      }
      move(node, state)
      return node
    }

    function move (node, state) {
      node.style.left = `${state.x}px`
      node.style.top = `${state.y}px`
      node.style.width = `${state.w}px`
      node.style.height = `${state.h}px`
    }

    function pillNode (item) {
      const state = geo.get(item.id)
      const node = make('button', 'ublock-pill')
      node.setAttribute('type', 'button')
      node.setAttribute('data-block-id', item.id)
      node.setAttribute('aria-label', say('Развернуть'))
      node.setAttribute('data-tooltip', say('Развернуть'))
      put(node, (item && item.title) || '')
      node.style.left = `${state.x}px`
      node.style.top = `${state.y}px`
      node.addEventListener('click', () => {
        state.min = false
        draw()
      })
      return node
    }

    function restoreNode () {
      const node = make('button', 'ublock-restore')
      node.setAttribute('type', 'button')
      const label = say('Результат')
      node.setAttribute('aria-label', label)
      node.setAttribute('data-tooltip', label)
      put(node, label)
      node.addEventListener('click', () => {
        for (const state of geo.values()) state.closed = false
        draw()
      })
      return node
    }

    function ghostNode () {
      const box = zones()[zone]
      if (!box) return null
      const node = make('div', 'ublock-snap')
      node.setAttribute('aria-hidden', 'true')
      move(node, box)
      return node
    }

    // ─── отступ колонок под прилипший блок ────────────────────────────────
    // Точка сбора — два числа в пикселях. Пишутся они на КОРЕНЬ переменными, а
    // решают, что с ними делать, стили: `.feed-container` и `.composer-col` берут
    // из них собственный `padding-inline`. Узлы колонок модуль не трогает.
    // Свёрнутый в пилюлю и убранный блок край не занимает — отступ отпускает;
    // на одной стороне несколько блоков дают ширину САМОГО ШИРОКОГО, без сложения
    // (иначе колонка уехала бы за экран).
    function insets () {
      const out = { left: 0, right: 0 }
      for (const state of geo.values()) {
        if (state.min || state.closed) continue
        if (state.zone !== 'left' && state.zone !== 'right') continue
        const wide = Number(state.w)
        if (!(wide > 0)) continue
        out[state.zone] = Math.max(out[state.zone], wide + INSET_PAD)
      }
      return out
    }

    // Публикуется ВСЕГДА обе стороны — пустая сторона получает `0px`, а не
    // пропадает: `var(--x)` без значения колонка бы не увидела вовсе.
    function publish () {
      const html = doc && doc.documentElement
      if (!html || !html.style) return
      const at = insets()
      for (const side of INSET_SIDES) {
        if (typeof html.style.setProperty === 'function') {
          html.style.setProperty(INSET_VARS[side], `${at[side]}px`)
        }
      }
    }

    // Выход из Ultra: переменные уходят с корня вместе с признаком пресета,
    // иначе обычный вид остался бы с чужим отступом в колонках.
    function unpublish () {
      const html = doc && doc.documentElement
      if (!html || !html.style) return
      for (const side of INSET_SIDES) {
        if (typeof html.style.removeProperty === 'function') html.style.removeProperty(INSET_VARS[side])
      }
    }

    // Полная перекладка слоя из состояния: позиции при этом не меняются.
    function draw () {
      if (!layer) return
      const keep = new Set()
      const closed = []
      for (const item of items) {
        const state = geo.get(item.id)
        if (!state) continue
        if (state.closed) { closed.push(item); continue }
        const body = !state.min && typeof deps.bodyFor === 'function' ? deps.bodyFor(item) : null
        const cached = providedBlocks.get(item.id)
        let node
        if (body && cached && cached.body === body && cached.state === state) {
          node = cached.node
          node.querySelector('.ublock-title').textContent = item.title || ''
          for (const [selector, source] of [['.ublock-min', 'Свернуть'], ['.ublock-close', 'Убрать']]) {
            const control = node.querySelector(selector)
            const label = say(source)
            control.textContent = label
            control.setAttribute('aria-label', label)
            control.setAttribute('data-tooltip', label)
          }
          move(node, state)
        } else {
          node = state.min ? pillNode(item) : blockNode(item)
        }
        if (body) providedBlocks.set(item.id, { body, node, state })
        else providedBlocks.delete(item.id)
        keep.add(node)
        // Detaching an iframe destroys its browsing context even when the same node is reattached.
        if (node.parentElement !== layer) layer.appendChild(node)
      }
      for (const node of Array.from(layer.children)) if (!keep.has(node)) node.remove()
      for (const id of providedBlocks.keys()) if (!items.some(item => item.id === id && !geo.get(id)?.closed)) providedBlocks.delete(id)
      if (closed.length) layer.appendChild(restoreNode())
      if (zone) layer.appendChild(ghostNode())
      publish()
    }

    // ─── перетаскивание и размер ──────────────────────────────────────────────
    function onDown (event) {
      const target = event && event.target
      if (!target || typeof target.closest !== 'function') return
      const node = target.closest('.ublock')
      if (!node) return
      if (typeof target.closest === 'function' && target.closest('button')) return
      const id = node.getAttribute('data-block-id')
      const state = geo.get(id)
      if (!state) return
      const grip = target.closest('.ublock-grip')
      const edge = grip && grip.getAttribute('data-edge')
      const head = target.closest('.ublock-head')
      if (edge && EDGES.includes(edge)) {
        drag = { id, mode: 'resize', edge, from: point(event), o: { ...state }, node }
      } else if (head) {
        drag = { id, mode: 'move', from: point(event), o: { ...state }, node }
      } else {
        return
      }
      zone = null
      if (typeof event.preventDefault === 'function') event.preventDefault()
    }

    function onMove (event) {
      if (!drag) return
      const state = geo.get(drag.id)
      if (!state) { drag = null; return }
      const box = area()
      const at = point(event)
      const dx = at.x - drag.from.x
      const dy = at.y - drag.from.y
      const o = drag.o
      if (drag.mode === 'move') {
        state.x = clamp(grid(o.x + dx), GAP, Math.max(GAP, box.width - o.w - GAP))
        state.y = clamp(grid(o.y + dy), TOP, Math.max(TOP, box.height - o.h - GAP))
        zone = zoneAt(at)
      } else {
        if (drag.edge.includes('e')) state.w = clamp(grid(o.w + dx), MIN_W, box.width - o.x - GAP)
        if (drag.edge.includes('s')) state.h = clamp(grid(o.h + dy), MIN_H, box.height - o.y - GAP)
        if (drag.edge.includes('w')) {
          const x = clamp(grid(o.x + dx), GAP, o.x + o.w - MIN_W)
          state.w = o.w + (o.x - x)
          state.x = x
        }
        if (drag.edge.includes('n')) {
          const y = clamp(grid(o.y + dy), TOP, o.y + o.h - MIN_H)
          state.h = o.h + (o.y - y)
          state.y = y
        }
        zone = null
      }
      move(drag.node, state)
      const ghost = ghostNode()
      const old = layer.querySelector('.ublock-snap')
      if (old) old.remove()
      if (ghost) layer.appendChild(ghost)
    }

    // Полоса, которую блок закрывать не вправе (её называет окно — обычно это
    // строка ввода). При отпускании блок уходит вверх от полосы; если сверху не
    // помещается — становится под неё; если и там тесно — сжимается. Правит
    // только СВОЮ геометрию: чужие узлы модуль не трогает.
    function avoidKeepOut (state) {
      if (!state || typeof deps.keepOut !== 'function') return
      const raw = deps.keepOut()
      if (!raw || Number(raw.width) <= 0 || Number(raw.height) <= 0) return
      const host = layer && typeof layer.getBoundingClientRect === 'function'
        ? layer.getBoundingClientRect() : { left: 0, top: 0 }
      const dx = Number(host.left) || 0
      const dy = Number(host.top) || 0
      const band = {
        left: Number(raw.left) - dx, right: Number(raw.right) - dx,
        top: Number(raw.top) - dy, bottom: Number(raw.bottom) - dy
      }
      if (!(state.x < band.right && state.x + state.w > band.left &&
        state.y < band.bottom && state.y + state.h > band.top)) return
      const box = area()
      const above = band.top - GAP
      const below = band.bottom + GAP
      if (above - TOP >= MIN_H) {
        state.h = Math.min(state.h, Math.max(MIN_H, above - TOP))
        state.y = Math.max(TOP, Math.min(above - state.h, box.height - GAP - state.h))
        return
      }
      if (box.height - GAP - below >= MIN_H) {
        state.y = Math.max(TOP, Math.min(below, box.height - GAP - state.h))
        state.h = Math.max(MIN_H, Math.min(state.h, box.height - GAP - state.y))
        return
      }
      state.y = TOP
      state.h = MIN_H
    }

    function onUp () {
      if (!drag) return
      const node = drag.node
      const state = geo.get(drag.id)
      // Отправная мера берётся из самого жеста: `onMove` правит `state` на
      // ходу, и к моменту отпускания в нём уже новые координаты.
      const before = drag.o || null
      if (state && zone && zones()[zone]) {
        Object.assign(state, zones()[zone])
        state.x = grid(state.x)
        state.y = grid(state.y)
        state.w = grid(state.w)
        state.h = grid(state.h)
      }
      // здесь решается, у какого борта блок осел, — и сразу же уходит на
      // корень. Дальше колонки отступают сами, а этот узел остаётся там, где его
      // отпустили.
      if (state) state.zone = dockedSide(state, zone)
      // Зона прилипания уже посчитана: полоса ввода важнее свободной посадки,
      // но не важнее прилипшего края — там колонки отступают сами.
      if (state && !state.zone) avoidKeepOut(state)
      drag = null
      zone = null
      // Узел НЕ переставляется: пересборка слоя на каждом отпускании сбросила бы
      // фокус и заставила бы экран мигнуть. Достаточно дописать геометрию и
      // снять призрак зоны.
      if (state && node) move(node, state)
      const ghost = layer && layer.querySelector('.ublock-snap')
      if (ghost) ghost.remove()
      publish()
      // Окно извещается о ЛЮБОМ завершённом перемещении или новом размере, а не
      // только о прилипании: без этого память места не заведётся —
      // человек передвинул блок, а окно об этом не узнало.
      const changed = Boolean(state && before) && (before.x !== state.x || before.y !== state.y ||
        before.w !== state.w || before.h !== state.h || (before.zone || null) !== (state.zone || null))
      if (changed && typeof deps.onChange === 'function') deps.onChange()
    }

    // ─── жизнь модуля ─────────────────────────────────────────────────────────
    function wire (on) {
      if (!doc || typeof doc.addEventListener !== 'function') return
      if (on && !wired) {
        doc.addEventListener('pointermove', onMove)
        doc.addEventListener('pointerup', onUp)
        doc.addEventListener('pointercancel', onUp)
        wired = true
      } else if (!on && wired) {
        doc.removeEventListener('pointermove', onMove)
        doc.removeEventListener('pointerup', onUp)
        doc.removeEventListener('pointercancel', onUp)
        wired = false
      }
    }

    function mount (target) {
      const next = target || (deps.host && deps.host()) || host
      if (!next) return null
      if (layer && layer.parentElement === next) return layer
      host = next
      layer = make('div', 'ublocks')
      layer.setAttribute('aria-label', say('Результат'))
      layer.addEventListener('pointerdown', onDown)
      host.appendChild(layer)
      wire(true)
      draw()
      return layer
    }

    function render (next) {
      items = (Array.isArray(next) ? next : []).filter(item => item && item.id != null)
      const alive = new Set(items.map(item => String(item.id)))
      for (const id of [...geo.keys()]) if (!alive.has(id)) geo.delete(id)
      items.forEach((item, index) => place(String(item.id), index, item))
      draw()
    }

    function state () {
      return {
        blocks: items.map(item => {
          const one = geo.get(String(item.id)) || {}
          return {
            id: String(item.id), x: one.x, y: one.y, w: one.w, h: one.h,
            min: Boolean(one.min), closed: Boolean(one.closed)
          }
        }),
        zone: zone || null
      }
    }

    // Геометрия наружу и обратно (память места и размера между запусками).
    // Сам модуль диска не трогает — он отдаёт то, что знает, и принимает
    // сохранённое, укладывая в меры ТЕКУЩЕГО окна: блок, оставленный за краем
    // второго монитора, обязан вернуться туда, где его видно.
    function geometry () {
      const out = {}
      for (const [id, one] of geo) {
        out[id] = {
          x: one.x, y: one.y, w: one.w, h: one.h,
          min: Boolean(one.min), closed: Boolean(one.closed), zone: one.zone || null
        }
      }
      return out
    }

    function restore (saved) {
      const box = area()
      const source = saved && typeof saved === 'object' ? saved : {}
      for (const id of Object.keys(source)) {
        const one = source[id]
        if (!one || typeof one !== 'object') continue
        const w = clamp(Number(one.w) || DEFAULT_W, MIN_W, Math.max(MIN_W, box.width - 2 * GAP))
        const h = clamp(Number(one.h) || DEFAULT_H, MIN_H, Math.max(MIN_H, box.height - TOP - GAP))
        geo.set(id, Object.assign(geo.get(id) || {}, {
          x: clamp(Number(one.x) || GAP, GAP, Math.max(GAP, box.width - GAP - w)),
          y: clamp(Number(one.y) || TOP, TOP, Math.max(TOP, box.height - GAP - h)),
          w,
          h,
          min: Boolean(one.min),
          closed: Boolean(one.closed),
          zone: ZONE_NAMES.includes(one.zone) ? one.zone : null
        }))
      }
      return geometry()
    }

    function dispose () {
      drag = null
      zone = null
      providedBlocks.clear()
      unpublish()
      wire(false)
      if (layer && typeof layer.remove === 'function') layer.remove()
      layer = null
      host = null
    }

    return Object.freeze({
      mount,
      render,
      state,
      geometry,
      restore,
      dispose,
      insets
    })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneUltraBlocks = api
})(typeof window === 'object' ? window : globalThis)
