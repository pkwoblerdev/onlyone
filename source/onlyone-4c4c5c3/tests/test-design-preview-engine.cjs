// Движок, который главный процесс внедряет в страницу макета.
//
// Кадр превью живёт в `sandbox="allow-scripts"` без `allow-same-origin`, то есть
// со своим собственным началом отсчёта: окно не заглянет в него и не вынет из
// него ни байта. Всё, что движок знает о наведении и нажатиях, он обязан сам
// принести родителю сообщением — и ровно то, что не делает лишнего канала из
// подконтрольной модели страницы в привилегированное окно.
//
// Проверить это со стороны окна нельзя (тот же sandbox), поэтому берётся
// настоящий текст внедряемого скрипта из `src/main/main.js` и исполняется на
// заглушке DOM — тот же приём, что и в `tests/test-design-100-regressions.cjs`
// с вырезанными кусками `app.js`.
//
// Проверки «клавиши» и «уход курсора» красные намеренно: нажатия движок наружу
// не пересылает, а слушателя ухода из кадра нет ни на ком.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (err) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message))
  }
}

// Вырезается блок `const DESIGN_PICKER = \`…\`` — то, что реально попадает в
// страницу макета, а не копия в тесте: копия устарела бы в тот же вечер.
const block = /const DESIGN_PICKER = `([\s\S]*?)`/.exec(mainSource)
assert.ok(block, 'не найден блок DESIGN_PICKER в src/main/main.js — проверять становится нечего')
const engineBody = block[1]
  .replace(/^[\s\S]*?<script>/, '')
  .replace(/<\/script>[\s\S]*$/, '')

// Цвет подсветки читается из самого движка: поменяется палитра — проверка
// останется про поведение, а не покраснеет из-за константы.
const OUTLINE = /var OUTLINE = '([^']+)'/.exec(engineBody)?.[1] || '2px solid #E08C62'
const OUTLINE_COLOR = /#[0-9a-f]{3,8}/i.exec(OUTLINE)?.[0] || '#E08C62'

// Семья событий «указатель покинул кадр»: реализация вправе выбрать любой из
// этих слушателей. Отсутствуют все — тот самый дефект, из-за которого рыжая
// рамка продолжает висеть на элементе, когда мышь давно вне превью.
const LEAVE_EVENTS = ['mouseleave', 'mouseout', 'pointerleave', 'pointerout']

// --- заглушка DOM --------------------------------------------------------------
// Нарочно минимальная: движок не обращается ни к чему, кроме перечисленного.
// Если реализация потянется к API, которого здесь нет, проверка покраснеет с
// внятным «X is not defined» — это сигнал дописать заглушку, а не отменить
// поведение.
function makeElement (tagName, props = {}) {
  return {
    nodeType: 1,
    tagName,
    id: props.id || '',
    className: props.className || '',
    innerText: props.innerText || '',
    style: { outline: props.outline || '' },
    parentElement: props.parentElement || null,
    getAttribute: () => '',
    closest: () => null
  }
}

function makeStage () {
  const listeners = []
  const posted = []
  const on = owner => (type, fn) => listeners.push({ type, fn, owner })

  const body = makeElement('BODY')
  const documentElement = makeElement('HTML')
  const document = {
    body,
    documentElement,
    addEventListener: on('document'),
    removeEventListener () {},
    // `reportSize` читает props страницы; в этом прогоне размер не сообщается.
    querySelector: () => null
  }
  const parent = { postMessage: message => posted.push(message) }
  const window = {
    parent,
    document,
    innerWidth: 900,
    innerHeight: 700,
    addEventListener: on('window'),
    removeEventListener () {}
  }

  const stage = {
    listeners,
    posted,
    body,
    document,
    window,
    parent,
    element: makeElement,
    // Есть ли слушатель события — и на окне, и на документе, и назначенный
    // свойством: где вешать, решает реализация.
    has: type => listeners.some(listener => listener.type === type) ||
      Boolean(type === 'keydown' && (window.onkeydown || document.onkeydown)),
    call: (type, event) => {
      const full = { type, ...event }
      let calls = 0
      for (const listener of listeners.filter(item => item.type === type)) {
        listener.fn(full)
        calls++
      }
      const inline = type === 'keydown' ? (document.onkeydown || window.onkeydown) : null
      if (inline) {
        inline(full)
        calls++
      }
      return calls
    },
    keyMessages: () => posted.filter(message => message && message.type === 'onecode-design-key'),
    // Вызывает слушателя «ушли из кадра». `required: false` — для охранных
    // проверок, которым есть что терять только тогда, когда такой слушатель уже
    // появился: иначе они краснеют за отсутствие чужого поведения.
    fireLeave: (event, { required = true } = {}) => {
      const found = LEAVE_EVENTS.filter(type => stage.has(type))
      if (!found.length) {
        assert.equal(required, false,
          `нет ни одного слушателя ухода курсора (${LEAVE_EVENTS.join(', ')})`)
        return 0
      }
      let calls = 0
      for (const type of found) calls += stage.call(type, { ...event, type })
      return calls
    }
  }
  return stage
}

function boot () {
  const stage = makeStage()
  // Инжектируются только те имена, к которым движок обращается как к свободным:
  // `addEventListener`, `document`, `parent`, `window`. Остальное — обычные
  // глобальные средства JavaScript.
  const start = new Function('addEventListener', 'document', 'parent', 'window', 'setTimeout',
    'requestAnimationFrame', 'getComputedStyle', 'navigator', engineBody)
  function globalAddEventListener (type, fn) {
    stage.listeners.push({ type, fn, owner: 'window' })
  }
  start(globalAddEventListener, stage.document, stage.parent, stage.window,
    () => 0, () => 0, () => ({ outline: '' }), { platform: 'win32' })
  return stage
}

// Нажатие клавиши внутри кадра. `code` кладётся рядом с `key` специально:
// сравнение по символу ломается на русской раскладке (см. `comboOf` в app.js), и
// тест не должен мешать реализации посмотреть на оба поля.
function keyEvent (key, extra = {}) {
  return {
    key,
    code: extra.code || (/^[A-Za-z]$/.test(key) ? `Key${key.toUpperCase()}` : key),
    ctrlKey: Boolean(extra.ctrlKey),
    metaKey: Boolean(extra.metaKey),
    altKey: Boolean(extra.altKey),
    shiftKey: Boolean(extra.shiftKey),
    repeat: false,
    isComposing: false,
    target: makeElement('DIV'),
    preventDefault () {},
    stopPropagation () {}
  }
}

// Включаем режим выбора так, как его включает окно — сообщением в кадр.
const pickOn = stage => stage.call('message', { data: { type: 'onecode-design-pick', on: true, purpose: 'remove' } })

// --- клавиши -------------------------------------------------------------------

check('движок слушает нажатия клавиш в кадре', () => {
  // Без этого клавиатура в превью мертва: кадр кросс-ориджинный, и родительское
  // `keydown` его нажатий не увидит — оно приходит лишь тогда, когда фокус
  // остался на кнопке «Выбрать».
  assert.ok(boot().has('keydown'), 'внедряемый скрипт не подписан на keydown')
})

check('Delete, Backspace и Escape пересылаются родителю', () => {
  const stage = boot()
  // Именно то состояние, в котором клавиши и нужны: выбор уже сделан, режим
  // выбора погас, а фокус после клика остался внутри кадра.
  for (const key of ['Delete', 'Backspace', 'Escape']) {
    const before = stage.keyMessages().length
    stage.call('keydown', keyEvent(key))
    const sent = stage.keyMessages().slice(before)
    assert.equal(sent.length, 1, `${key}: родителю ушло ${sent.length} сообщений вместо одного`)
    assert.equal(sent[0].type, 'onecode-design-key')
    assert.equal(sent[0].key, key, `${key}: в сообщении пришла другая клавиша — ${sent[0].key}`)
  }
})

check('Ctrl+Z и Meta+Z уходят родителю вместе с состоянием модификаторов', () => {
  // Родитель различает «отменить правку» и «набирают букву z», поэтому
  // модификаторы обязаны приехать в сообщении, а не додумываться на месте.
  const stage = boot()
  for (const extra of [{ ctrlKey: true }, { metaKey: true }]) {
    const before = stage.keyMessages().length
    stage.call('keydown', keyEvent('z', extra))
    const sent = stage.keyMessages().slice(before)
    assert.equal(sent.length, 1, `сочетание ${extra.ctrlKey ? 'Ctrl' : 'Meta'}+Z не переслано`)
    assert.equal(sent[0].key, 'z')
    assert.equal(Boolean(sent[0].ctrlKey), Boolean(extra.ctrlKey))
    assert.equal(Boolean(sent[0].metaKey), Boolean(extra.metaKey))
  }
})

check('лишние клавиши в привилегированное окно не уходят', () => {
  // Единственный канал из страницы, которую собирает модель, — сообщения.
  // Каждый лишний ключ в нём — предложение окну отреагировать на то, что
  // напечатал кто-то в макете: стрелки, пробел и буквы пересылать нельзя.
  const stage = boot()
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab',
    'Shift', 'Control', ' ', 'a', 'x', 'y', 'PageUp', 'Home', 'End', 'F5']) {
    const before = stage.keyMessages().length
    stage.call('keydown', keyEvent(key))
    assert.equal(stage.keyMessages().length, before,
      `клавиша «${key === ' ' ? 'пробел' : key}» ушла родителю: ${JSON.stringify(stage.keyMessages()[before])}`)
  }
  // С модификаторами — тем более: Ctrl+C не обязан становиться сигналом окну.
  const before = stage.keyMessages().length
  for (const key of ['c', 'v', 'x', 'a', 's', 'f', 'w', 'r']) {
    stage.call('keydown', keyEvent(key, { ctrlKey: true }))
  }
  assert.equal(stage.keyMessages().length, before, 'сочетания с Ctrl пересылаются наружу')
})

check('одно нажатие — одно сообщение', () => {
  // Два сообщения на одно нажатие родитель обслужит дважды, а модальное
  // подтверждение вторым открытием не остановить.
  const stage = boot()
  stage.call('keydown', keyEvent('Delete'))
  assert.equal(stage.keyMessages().length, 1,
    `одно нажатие дало ${stage.keyMessages().length} сообщений`)
})

// --- наведение и уход курсора ----------------------------------------------------

check('наведение подсвечивает, клик выделяет — старое поведение цело', () => {
  const stage = boot()
  pickOn(stage)
  const card = makeElement('DIV', { className: 'card', innerText: 'Заголовок' })
  stage.call('mouseover', { target: card })
  assert.equal(card.style.outline, OUTLINE, 'наведение не подсветилось')
  stage.call('click', { target: card, preventDefault () {}, stopPropagation () {} })
  assert.ok(stage.posted.some(message => message && message.type === 'onecode-design-element-selected'),
    'клик не сообщил о выбранном элементе')
  assert.equal(card.style.outline, OUTLINE, 'выбранный элемент остался без выделения')
})

check('ушедший курсор снимает подсветку с наведённого элемента', () => {
  const stage = boot()
  pickOn(stage)
  const card = makeElement('DIV', { className: 'card', innerText: 'Кнопка' })
  stage.call('mouseover', { target: card })
  assert.equal(card.style.outline, OUTLINE, 'наведение не подсветилось')
  // Мышь ушла из кадра: нового mouseover не будет, и рамка обязана уйти сама.
  stage.fireLeave({ target: card, relatedTarget: null })
  assert.notEqual(card.style.outline, OUTLINE, 'подсветка осталась после ухода курсора')
  assert.equal(String(card.style.outline).toLowerCase().includes(OUTLINE_COLOR.toLowerCase()), false,
    'цвет подсветки остался на элементе: ' + card.style.outline)
})

check('уход курсора не стирает собственный контур элемента', () => {
  // Снимать надо подсветку приложения, а не обводку макета: страницу пишет
  // человек, и «навёл мышь — потерял рамку» правит чужой результат.
  const stage = boot()
  pickOn(stage)
  const card = makeElement('DIV', { className: 'box', innerText: 'Плашка', outline: '1px dotted green' })
  stage.call('mouseover', { target: card })
  assert.equal(card.style.outline, OUTLINE)
  stage.fireLeave({ target: card, relatedTarget: null })
  assert.equal(card.style.outline, '1px dotted green', 'авторская обводка стёрта или заменена')
})

check('уход курсора не снимает выделение выбранного элемента', () => {
  // Выбор переживает мышь: человек мог убрать курсор и всё ещё собираться
  // удалять. Отменять этим событием можно только наведение.
  const stage = boot()
  pickOn(stage)
  const card = makeElement('DIV', { className: 'card', innerText: 'Меню' })
  stage.call('click', { target: card, preventDefault () {}, stopPropagation () {} })
  assert.equal(card.style.outline, OUTLINE, 'клик не выделил элемент')
  stage.fireLeave({ target: card, relatedTarget: null }, { required: false })
  assert.equal(card.style.outline, OUTLINE, 'выделение пропало вместе с курсором')
})

// --- сторона окна: где живёт обработчик ----------------------------------------
//
// Соседний набор `tests/test-design-100-regressions.cjs` вырезает из
// `src/renderer/app.js` блок превью между маркерами и исполняет его в `new
// Function` с фиксированным списком имён. Если обработчик клавиш заведётся
// вне этого блока — сосед его просто не увидит; если внутри, но с верхнеуровневым
// `window.addEventListener` — песочница соседа падает на `window is not defined`.
// Проверка держит и то, и другое на месте.
const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')

check('обработчик клавиш превью объявлен в вырезаемом блоке и собирается в песочнице', () => {
  const start = appSource.indexOf('// Превью само вписывает макет')
  const end = appSource.indexOf('// --- review comments', start)
  assert.ok(start >= 0 && end > start, 'маркеры блока превью разъехались — соседний набор сломан')
  const block = appSource.slice(start, end)
  assert.match(block, /function handleDesignPreviewKey/,
    'handleDesignPreviewKey не объявлен внутри блока превью')
  const sandbox = new Function('$', 'setElementPicking', 't', 'initialDesign', 'initialComponent',
    `${block}\nreturn typeof handleDesignPreviewKey`)
  assert.equal(sandbox(() => null, () => {}, value => value, { id: 'design-a' }, 'Landing.dc.html'), 'function',
    'блок превью собирается в песочнице соседа только вместе с новым обработчиком')
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exit(failed ? 1 : 0)
