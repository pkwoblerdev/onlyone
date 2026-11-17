/* Предпросмотр ручного форка (Ф-1).
 *
 * Один шаг перед созданием: название новой сессии, точка ответвления и что
 * переносится, а что остаётся у родителя. Создание происходит только по явному
 * нажатию; Esc и «Отмена» — отказ. Снимок считает вызывающий (`chat-forks.js`),
 * поэтому окно показывает ровно то, что попадёт в чат, и само ничего не решает.
 */
(function (root) {
  'use strict'

  // Резолвится true только по подтверждению. Повторный вызов при открытом окне
  // фокусирует его и возвращает false: двойное нажатие не создаёт два чата.
  function open (options) {
    const doc = (options && options.doc) || root.document
    const existing = doc && doc.querySelector ? doc.querySelector('.chat-fork-preview') : null
    if (existing && existing.open) { existing.focus(); return Promise.resolve(false) }
    if (existing) existing.remove()
    const t = options && typeof options.t === 'function' ? options.t : text => text
    return new Promise(resolve => {
      const el = (tag, text, className) => {
        const node = doc.createElement(tag)
        if (text != null) node.textContent = text
        if (className) node.className = className
        return node
      }
      const dialog = el('dialog', null, 'chat-fork-preview')
      const title = el('h2', t('Предпросмотр форка'))
      title.id = 'chat-fork-preview-title'
      dialog.setAttribute('aria-labelledby', title.id)
      const name = el('p', t('Название новой сессии') + ': ' + options.name)
      const boundary = el('p', t('Точка ответвления') + ': ' + t('Сообщение') + ' ' + (options.end + 1) + ' / ' + options.total)
      const copied = el('p', t('Переносится') + ': ' + t('Текст переписки до выбранного сообщения. Вложения, инструменты и служебные блоки не переносятся.'))
      const count = el('p', null, 'chat-fork-preview-meta')
      count.textContent = t('Сообщений с текстом') + ': ' + options.copied
      const skipped = el('p', null, 'chat-fork-preview-meta')
      skipped.textContent = options.omitted ? t('В границе есть сообщения без текста — они останутся у родителя.') : ''
      skipped.hidden = !options.omitted
      const kept = el('p', t('Не переносится') + ': ' + t('Дальнейшие сообщения родителя не добавляются, модель не запускается.'))
      const actions = el('div', null, 'chat-fork-preview-actions')
      const confirm = el('button', t('Создать форк'), 'btn-primary')
      confirm.type = 'button'
      confirm.dataset.action = 'confirm'
      const cancel = el('button', t('Отмена'), 'btn-secondary')
      cancel.type = 'button'
      cancel.dataset.action = 'cancel'
      actions.append(confirm, cancel)
      dialog.append(title, name, boundary, copied, count, skipped, kept, actions)

      let decided = false
      const finish = value => {
        if (decided) return
        decided = true
        dialog.close()
        resolve(value)
      }
      confirm.addEventListener('click', () => finish(true))
      cancel.addEventListener('click', () => finish(false))
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false) })
      dialog.addEventListener('close', () => {
        if (!decided) { decided = true; resolve(false) }
        const origin = options.opener
        dialog.remove()
        if (origin && origin.isConnected) origin.focus()
      })
      doc.body.append(dialog)
      dialog.showModal()
      confirm.focus()
    })
  }

  const api = Object.freeze({ open })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneForkPreview = api
})(typeof window === 'object' ? window : globalThis)
