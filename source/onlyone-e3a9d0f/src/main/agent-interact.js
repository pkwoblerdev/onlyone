'use strict'

/* Движок действий над уже открытой страницей браузера агента (план, 3.6б).
 *
 * Открыванием страниц здесь не пахнет: адрес берётся у живого webContents и
 * спрашивается у подставленного сторожа на КАЖДОМ действии (в продуктиве это
 * validateBrowserUrl из agent-browser.js поверх web-fetch.js). Собственных
 * адресных списков у движка сознательно нет: второй сторож означал бы два
 * разных ответа на один вопрос, а расходились бы они молча.
 *
 * Три вещи держатся здесь отдельно от удобства:
 *  - любое несчастье оформляется ответом { ok:false, error }. Исключение
 *    наружу из инструмента — это сорванный ход агента, а не отказ ему;
 *  - поле-секрет не получает ввода ни при каких условиях, и введённый текст не
 *    упоминается ни в кадре, ни в описании элемента, ни в причине отказа:
 *    проверка секрета случается ДО первого обращения в страницу;
 *  - срок и отмена — на каждое действие свои, и снимаются в finally. На
 *    webContents движок не навешивает ровно ничего: адрес перечитывается
 *    getURL, а переход посреди сессии виден по сменившемуся адресу. Поэтому
 *    «сколько навесил, столько снял» выполняется здесь нулями, а не парой
 *    on/off, которую кто-нибудь однажды забудет.
 *
 * Прав на новые файлы и новые окна у движка нет: снимок остаётся в памяти
 * процесса и отдаётся проводке по ссылке, на диск не пишется ничего.
 */

const { randomUUID } = require('node:crypto')

const DEFAULT_TIMEOUT_MS = 15000
// Потолок одного ответа: страница целиком в модель не уезжает никогда,
// продолжение берётся тем же действием по offset.
const DEFAULT_MAX_CHARS = 8000
// Имя элемента — данные; длиннее строки оно полезнее не становится.
const NAME_CHARS = 120
const FRAME_ELEMENT_MAX = 200
const ADDRESS_MAX_CHARS = 160
const ERROR_MAX_CHARS = 380
// Снимок ограничен и по пикселям, и по байтам: целые байты модели не нужны,
// а потолок обязан быть назван в ответе, чтобы отказ читался отказом.
const SHOT_MAX_WIDTH = 2400
const SHOT_MAX_HEIGHT = 1800
const SHOT_MAX_BYTES = 2 * 1024 * 1024
// Сколько последних снимков живёт в памяти процесса, дожидаясь проводки.
const SHOT_KEEP = 3

const TEXT_KEYS = ['text', 'innerText', 'visibleText', 'pageText', 'body', 'content', 'value']

const PICK_SELECTOR = [
  'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
  '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="combobox"]',
  '[role="searchbox"]', '[role="checkbox"]', '[role="radio"]',
  '[contenteditable="true"]', '[onclick]', '[tabindex]'
].join(',')

/* Ниже — код, который выполняется В СТРАНИЦЕ. Он сериализуется через
 * toString(), поэтому каждая функция самодостаточна: всё, что ей нужно из
 * этого файла, уезжает аргументом или константой в преамбуле. Имена элементов
 * уходят как есть, разметкой не собираются: окно само решает, как их
 * экранировать. */
const PAGE_PRELUDE = 'const PICK = ' + JSON.stringify(PICK_SELECTOR) +
  '; const nodesOf = () => Array.prototype.slice.call(document.querySelectorAll(PICK));'

function collectPageFrame () {
  const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  const cut = (value, limit) => {
    const chars = Array.from(clean(value))
    return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('')
  }
  const FALLBACK_ROLE = { A: 'link', BUTTON: 'button', SELECT: 'combobox', INPUT: 'textbox', TEXTAREA: 'textbox' }
  const elements = []
  for (const el of nodesOf()) {
    if (el.disabled === true || el.getAttribute('aria-hidden') === 'true') continue
    const attribute = name => clean(el.getAttribute(name))
    const labelled = el.labels && el.labels.length
      ? Array.prototype.map.call(el.labels, label => clean(label.textContent)).join(' ')
      : ''
    const name = attribute('aria-label') || labelled || attribute('placeholder') ||
      attribute('title') || cut(el.textContent, 120) || attribute('alt')
    const rawHref = el.tagName === 'A' ? clean(el.href) : attribute('href')
    const type = attribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select-one' : '')
    const identity = { id: attribute('id'), name: attribute('name'), type, autocomplete: attribute('autocomplete') }
    elements.push({
      index: elements.length,
      tag: el.tagName.toLowerCase(),
      role: attribute('role') || FALLBACK_ROLE[el.tagName] || 'control',
      name: cut(name, 160),
      type: identity.type || null,
      // javascript: в кадр не попадает: это не адрес, это код чужой страницы.
      href: /^javascript:/i.test(rawHref) ? null : (rawHref ? cut(rawHref, 300) : null),
      id: identity.id || null,
      domName: identity.name || null,
      autocomplete: identity.autocomplete || null,
      attributes: identity
    })
    if (elements.length >= 400) break
  }
  const rawText = document.body ? (document.body.innerText || document.body.textContent || '') : ''
  const text = String(rawText).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return { ok: true, url: String(location.href || ''), title: clean(document.title), elements, text }
}

function pressPageElement (index) {
  const el = nodesOf()[index]
  if (!el) return { ok: false, error: 'Элемент исчез со страницы' }
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' })
  if (typeof el.focus === 'function') el.focus()
  el.click()
  return { ok: true }
}

function fillPageElement (index, value, submit) {
  const el = nodesOf()[index]
  if (!el) return { ok: false, error: 'Элемент исчез со страницы' }
  const editable = el.isContentEditable === true || el.getAttribute('contenteditable') === 'true'
  if (typeof el.focus === 'function') el.focus()
  if (editable) {
    el.textContent = value
  } else if ('value' in el) {
    // Значение ставится нативным сеттером: присваивание el.value полям React и
    // Vue об изменении не сообщает, и страница осталась бы с пустым полем при
    // внешнем признаке успеха.
    const owner = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    if (owner && owner.set) owner.set.call(el, value)
    else el.value = value
  } else {
    return { ok: false, error: 'Элемент не принимает ввод' }
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  if (submit) {
    if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit()
    else el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }))
  }
  return { ok: true }
}

function pageScript (fn, args) {
  const call = (args || []).map(item => JSON.stringify(item)).join(', ')
  return '(() => { ' + PAGE_PRELUDE + ' return (' + fn.toString() + ')(' + call + '); })()'
}

const FRAME_SCRIPT = pageScript(collectPageFrame, [])

// Текст поля уходит в страницу JSON-литералом: кавычка, скобка или перенос
// строки внутри человеческой фразы не должны превращаться в код страницы.
function clickScript (index) {
  return pageScript(pressPageElement, [index])
}

function typeScript (index, value, submit) {
  return pageScript(fillPageElement, [index, String(value), Boolean(submit)])
}

class AddressError extends Error {}
class StateError extends Error {}
class TargetError extends Error {}
class LimitError extends Error {}
class TimeoutError extends Error {}
class AbortedError extends Error {}

const asText = value => (value == null ? '' : String(value))
const asField = value => (value == null || value === '' ? null : String(value))

function positiveInt (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function nonNegativeInt (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

// Знаки, а не байты: срез по index режет русское слово посередине.
function clip (value, limit) {
  const chars = Array.from(asText(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('')
}

function reasonOf (error) {
  return String((error && error.message) || error || '').replace(/\s+/g, ' ').trim()
}

function refuse (message) {
  const clean = clip(asText(message).replace(/\s+/g, ' ').trim(), ERROR_MAX_CHARS)
  return { ok: false, error: clean || 'Действие не выполнено: причина не названа' }
}

// Кадр страницы собирается в один нормализованный вид: поля контракта плюс
// признаки поля-секрета. Номера элементов — позиция в списке, сплошная с нуля.
function normalizeFrame (reply) {
  const source = reply && typeof reply === 'object' ? reply : {}
  const rawElements = Array.isArray(source.elements) ? source.elements : []
  const elements = rawElements.map((item, position) => {
    const el = item && typeof item === 'object' ? item : {}
    const attributes = el.attributes && typeof el.attributes === 'object' ? el.attributes : {}
    return {
      index: position,
      tag: asField(el.tag),
      role: asField(el.role),
      name: asField(el.name),
      type: asField(el.type === undefined ? attributes.type : el.type),
      href: asField(el.href),
      id: asField(el.id === undefined ? attributes.id : el.id),
      domName: asField(el.domName === undefined ? attributes.name : el.domName),
      autocomplete: asField(el.autocomplete === undefined ? attributes.autocomplete : el.autocomplete),
      placeholder: asField(el.placeholder),
      label: asField(el.label),
      ariaLabel: asField(el.ariaLabel || el['aria-label']),
      text: asField(el.text)
    }
  })
  let text = ''
  for (const key of TEXT_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.length) { text = value; break }
  }
  return { url: asField(source.url), title: asField(source.title), elements, text, error: asField(source.error) }
}

function createAgentInteraction (options) {
  const settings = options && typeof options === 'object' ? options : {}
  const webContents = settings.webContents
  const validateUrl = typeof settings.validateUrl === 'function' ? settings.validateUrl : null
  const signal = settings.signal
  const onEvent = typeof settings.onEvent === 'function' ? settings.onEvent : null
  const onShot = typeof settings.onShot === 'function' ? settings.onShot : null
  const baseTimeoutMs = positiveInt(settings.timeoutMs, DEFAULT_TIMEOUT_MS)
  const baseMaxChars = positiveInt(settings.maxChars, DEFAULT_MAX_CHARS)
  const baseOffset = nonNegativeInt(settings.offset, 0)

  // Снимки живут в памяти процесса и отдаются по ссылке: на диск движок не
  // пишет, а целые байты в ответ модели не уходят.
  const shots = new Map()

  function liveAddress () {
    if (!webContents || typeof webContents.getURL !== 'function') {
      throw new StateError('Движок получен без webContents: действовать не над чем')
    }
    if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
      throw new StateError('Окно браузера закрыто: действие по открытому адресу невозможно')
    }
    return asText(webContents.getURL())
  }

  /* Сторож спрашивается перед каждым действием — и после того, что могло увести
   * страницу: ушедшая в локальную сеть или в file: страница не должна застать
   * движок врасплох следующим кадром. */
  async function guardAddress (address) {
    if (!validateUrl) {
      throw new StateError('Движку не передан сторож адресов: решать об адресах самому он не вправе')
    }
    const short = clip(address, ADDRESS_MAX_CHARS)
    if (!short) throw new AddressError('Действие отклонено: страница ещё не открыта, у действия нет адреса')
    try {
      await validateUrl(address)
    } catch (error) {
      throw new AddressError(`Действие отклонено по адресу «${short}»: ${reasonOf(error)}`)
    }
    return address
  }

  async function validateAddress () {
    return guardAddress(liveAddress())
  }

  async function revalidateIfMoved (address) {
    const now = liveAddress()
    if (now !== address) await guardAddress(now)
    return now
  }

  // Срок и отмена — на каждое действие отдельно: висячий executeJavaScript не
  // имеет права держать инструмент, а abort обязан снять действие раньше срока.
  async function withinDeadlines (body) {
    let timer = null
    let abortListener = null
    const cancelled = new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new AbortedError('Действие остановлено: ход отменён (abort)'))
        return
      }
      if (signal && typeof signal.addEventListener === 'function') {
        abortListener = () => reject(new AbortedError('Действие остановлено: ход отменён (abort)'))
        signal.addEventListener('abort', abortListener)
      }
    })
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(
        `Страница не ответила в срок ${baseTimeoutMs} мс: таймаут действия, возьмите свежий кадр`)), baseTimeoutMs)
    })
    try {
      return await Promise.race([Promise.resolve().then(body), cancelled, deadline])
    } finally {
      // Ни одна подписка не переживает действие: ни слушатель отмены, ни
      // таймер — иначе повторные вызовы копили бы их.
      if (timer) clearTimeout(timer)
      if (abortListener && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', abortListener)
    }
  }

  async function perform (body) {
    try {
      return await withinDeadlines(body)
    } catch (error) {
      if (error instanceof AddressError || error instanceof StateError ||
        error instanceof TargetError || error instanceof LimitError) return refuse(error.message)
      if (error instanceof TimeoutError || error instanceof AbortedError) return refuse(reasonOf(error))
      return refuse(`Действие не удалось: ${reasonOf(error)}`)
    }
  }

  function callPage (script) {
    if (!webContents || typeof webContents.executeJavaScript !== 'function') {
      throw new StateError('Страница не даёт выполнить в ней действие: нет executeJavaScript')
    }
    return Promise.resolve(webContents.executeJavaScript(script))
  }

  async function readSnapshot () {
    const reply = await callPage(FRAME_SCRIPT)
    if (reply && typeof reply === 'object' && reply.ok === false) {
      throw new TargetError(`Страница не отдала кадр: ${clip(asField(reply.error) || 'причина не названа', 200)}`)
    }
    return normalizeFrame(reply)
  }

  const fold = value => asText(value).toLowerCase().replace(/\s+/g, ' ').trim()

  function resolveTarget (elements, target) {
    if (!target || typeof target !== 'object') {
      throw new TargetError('Цель действия не задана: нужен номер элемента из кадра или его видимый текст')
    }
    const rawIndex = Number(target.index)
    if (Number.isFinite(rawIndex) && rawIndex >= 0) {
      const found = elements[Math.floor(rawIndex)]
      if (found) return found
      throw new TargetError(
        `На странице нет элемента с номером ${Math.floor(rawIndex)}: кадр устарел, возьмите номер из свежего действия frame`)
    }
    const needle = fold(target.text)
    if (!needle) {
      throw new TargetError('Цель действия пуста: скажите index элемента из кадра или его видимый текст')
    }
    const hits = elements.filter(item => [item.name, item.label, item.ariaLabel, item.placeholder, item.text]
      .some(field => fold(field).includes(needle)))
    if (!hits.length) throw new TargetError(`Элемент с текстом «${clip(target.text, 80)}» на странице не найден: возьмите текст из свежего кадра`)
    if (hits.length > 1) {
      throw new TargetError(
        `Под текстом «${clip(target.text, 80)}» подходит ${hits.length} элемента — действуйте по номеру index из кадра, а не по тексту`)
    }
    return hits[0]
  }

  // Признаки поля-секрета читаются во всех местах, где они живут в разметке:
  // тип, autocomplete, id и name. Доступное имя тоже смотрим: «Password» в нём
  // значит ровно то же, что type=password.
  // Голое «ключ» сюда не входит: «Ключевые слова» и «ключевая идея» — обычные поля. Секретом «ключ» становится в
  // связке: API-ключ, ключ доступа/шифрования/авторизации, приватный ключ.
  const SECRET_WORD = /passw(?:or|d)|passwd|secret|token|токен|api[_\-\s]?(?:key|ключ)|ключ[\s_\-]*(?:api|доступа|шифрования|авторизации)|private[_\-\s]?key|приватн|секрет|парол/i
  const SECRET_AUTOCOMPLETE = /(current|new)[-_]?password/i

  function secretSignals (el) {
    const found = []
    if (fold(el.type) === 'password') found.push('type=password')
    if (SECRET_AUTOCOMPLETE.test(fold(el.autocomplete))) found.push('autocomplete')
    for (const pair of [['id', el.id], ['name', el.domName], ['autocomplete', el.autocomplete],
      ['placeholder', el.placeholder], ['accessible name', el.name], ['label', el.label]]) {
      if (pair[1] && SECRET_WORD.test(String(pair[1]))) found.push(pair[0])
    }
    return [...new Set(found)]
  }

  function assertWritable (el) {
    const signals = secretSignals(el)
    if (signals.length) {
      throw new TargetError(
        `Ввод в поле-секрет запрещён: в элементе ${el.index} опознан признак пароля, токена или ключа (${signals.join(', ')}). ` +
        'Просите человека ввести значение самому: текст поля не копируется никуда.')
    }
  }

  function paginate (value, callOptions) {
    const chars = Array.from(asText(value))
    const call = callOptions && typeof callOptions === 'object' ? callOptions : {}
    const limit = positiveInt(call.maxChars, baseMaxChars)
    const from = nonNegativeInt(call.offset, baseOffset)
    const taken = chars.slice(from, from + limit)
    const next = from + taken.length
    const more = next < chars.length
    const page = {
      text: taken.join(''),
      offset: from,
      maxChars: limit,
      totalChars: chars.length,
      truncated: more,
      nextOffset: more ? next : null
    }
    // «Не влезло» и «ничего нет» различимы и словами, и числами: nextOffset
    // есть только там, где за ответом правда стоит продолжение.
    if (more) {
      page.textNote = `Текст срезан по лимиту ${limit} знаков: продолжение идёт со смещения ${next}, всего в странице ${chars.length} знаков`
    } else if (from > 0) {
      page.textNote = `Дошли до конца страницы: всего ${chars.length} знаков, дальше ничего нет`
    } else {
      page.textNote = `Весь текст страницы — ${chars.length} знаков — уместился в лимит ${limit} знаков`
    }
    return page
  }

  function frameList (snapshot, limit) {
    const nameLimit = Math.min(NAME_CHARS, limit)
    const shown = snapshot.elements.slice(0, FRAME_ELEMENT_MAX)
    let clipped = false
    const elements = shown.map((item, position) => {
      const out = { index: position }
      for (const key of ['tag', 'role', 'type']) out[key] = clip(asField(item[key]), 40)
      for (const key of ['name', 'href']) {
        const value = asField(item[key])
        out[key] = clip(value, nameLimit)
        if (value && Array.from(value).length > nameLimit) clipped = true
      }
      return out
    })
    const dropped = Math.max(0, snapshot.elements.length - shown.length)
    // Лимит кадра называется числом: молча урезанный кадр модель прочла бы как
    // полный список элементов страницы.
    const frameNote = (clipped || dropped)
      ? `Лимит кадра: имена и ссылки не длиннее ${nameLimit} знаков, в ответе ${shown.length} элементов, вне ответа ${dropped}`
      : ''
    return { elements, frameNote }
  }

  function describeAction (address, snapshot, callOptions, extra) {
    const page = paginate(snapshot.text, callOptions)
    const list = frameList(snapshot, page.maxChars)
    const out = {
      ok: true,
      url: address,
      title: clip(asField(snapshot.title), Math.min(NAME_CHARS, page.maxChars)),
      elements: list.elements,
      text: page.text,
      offset: page.offset,
      maxChars: page.maxChars,
      totalChars: page.totalChars,
      truncated: page.truncated,
      nextOffset: page.nextOffset,
      textNote: page.textNote
    }
    if (list.frameNote) out.frameNote = list.frameNote
    if (extra) Object.assign(out, extra)
    if (onEvent) {
      try {
        onEvent({ status: 'frame', url: address, title: out.title, elements: out.elements, truncated: out.truncated })
      } catch { /* проводка окна не вправе ломать ответ модели */ }
    }
    return out
  }

  function rememberShot (png) {
    const ref = 'agent-browser-shot://' + randomUUID()
    shots.set(ref, png)
    while (shots.size > SHOT_KEEP) shots.delete(shots.keys().next().value)
    return ref
  }

  // --- четыре действия контракта -------------------------------------------------

  async function frame (callOptions) {
    return perform(async () => {
      const address = await validateAddress()
      const snapshot = await readSnapshot()
      return describeAction(address, snapshot, callOptions)
    })
  }

  async function click (target, callOptions) {
    return perform(async () => {
      const address = await validateAddress()
      const snapshot = await readSnapshot()
      const el = resolveTarget(snapshot.elements, target)
      await callPage(clickScript(el.index))
      const now = await revalidateIfMoved(address)
      const after = await readSnapshot()
      return describeAction(now, after, callOptions, {
        action: 'click',
        acted: { index: el.index, tag: clip(asField(el.tag), 40), role: clip(asField(el.role), 40) }
      })
    })
  }

  async function type (target, value, callOptions) {
    return perform(async () => {
      const address = await validateAddress()
      const text = asText(value)
      if (!text) throw new TargetError('Вводить нечего: текст поля пустой')
      const snapshot = await readSnapshot()
      const el = resolveTarget(snapshot.elements, target)
      // Проверка секрета — ДО первого обращения к странице: текст не должен
      // успеть уйти ни в executeJavaScript, ни в insertText, ни в ошибку.
      assertWritable(el)
      const call = callOptions && typeof callOptions === 'object' ? callOptions : {}
      await callPage(typeScript(el.index, text, call.submit))
      const now = await revalidateIfMoved(address)
      const after = await readSnapshot()
      return describeAction(now, after, callOptions, {
        action: 'type',
        submitted: Boolean(call.submit),
        acted: { index: el.index, tag: clip(asField(el.tag), 40), chars: Array.from(text).length }
      })
    })
  }

  async function screenshot (callOptions) {
    return perform(async () => {
      const address = await validateAddress()
      if (!webContents || typeof webContents.capturePage !== 'function') {
        throw new StateError('Страница не даёт снять кадр: нет capturePage')
      }
      const image = await Promise.resolve(webContents.capturePage())
      if (!image) throw new StateError('Снимок не получен: страница ничего не вернула')
      if (typeof image.isEmpty === 'function' && image.isEmpty()) {
        throw new StateError('Снимок пуст: содержимое страницы не отрисовалось')
      }
      const size = typeof image.getSize === 'function' ? (image.getSize() || {}) : {}
      const width = positiveInt(size.width, 0)
      const height = positiveInt(size.height, 0)
      const cap = `потолок ${SHOT_MAX_WIDTH}x${SHOT_MAX_HEIGHT} пикселов и ${SHOT_MAX_BYTES} байт`
      if (width > SHOT_MAX_WIDTH || height > SHOT_MAX_HEIGHT) {
        throw new LimitError(`Снимок ${width}x${height} пикселов превышает потолок размера (${cap}): ` +
          'такой кадр движок не масштабирует — работайте по frame')
      }
      const png = typeof image.toPNG === 'function' ? image.toPNG() : Buffer.alloc(0)
      const bytes = Buffer.isBuffer(png) ? png.length : 0
      if (bytes > SHOT_MAX_BYTES) {
        throw new LimitError(`Снимок весит ${bytes} байт — это больше потолка размера (${cap}): ` +
          'кадр такого размера в ход агента не берётся')
      }
      const ref = rememberShot(png)
      if (onShot) {
        try {
          onShot({ ref, url: address, width, height, bytes })
        } catch { /* проводка окна не вправе ломать ответ модели */ }
      }
      return {
        ok: true,
        action: 'screenshot',
        url: address,
        ref,
        width,
        height,
        bytes,
        truncated: false,
        nextOffset: null,
        note: `Снимок ${width}x${height} пикселов, ${bytes} байт — в пределах потолка (${cap}). ` +
          'Кадр лежит в памяти процесса под ссылкой ' + ref + ': он идёт в ход агента картинкой и в живой вид'
      }
    })
  }

  return Object.freeze({
    frame,
    click,
    type,
    screenshot,
    // Для проводки окна: байты снимка остаются здесь, наружу уходит ссылка.
    shot (ref) {
      return shots.get(asText(ref)) || null
    }
  })
}

module.exports = Object.freeze({
  createAgentInteraction,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CHARS,
  SHOT_MAX_WIDTH,
  SHOT_MAX_HEIGHT,
  SHOT_MAX_BYTES,
  FRAME_SCRIPT
})
