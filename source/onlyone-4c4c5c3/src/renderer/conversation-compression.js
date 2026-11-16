// conversation-compression.js: раскладка сжатия длинного разговора (план, 3.9).
//
// Здесь только то, что можно проверить без окна и без модели: какие сообщения
// покрывает сохранённая сводка, что из-за неё не едет в модель и что человек
// видит в ленте. Решает, что сворачивать, и просит сводку у модели главный
// процесс, а запись о сжатии живёт на чате (`chat.compression`) — вместе с
// зашифрованным хранилищем разговоров она переживает перезапуск.
//
// Исходные сообщения никуда не деваются: `chat.messages` остаётся полным,
// сжатие меняет только то, что уходит в модель, и одну строку над лентой.

const COMPRESSION_MARK_LENGTH = 80

function createConversationCompression(options = {}) {
  const {
    t = key => key,
    escapeHtml = value => String(value == null ? '' : value)
  } = options

  // Отметка, по которой запись узнаёт своё сообщение. У сообщений нет id, а
  // один номер ничего не гарантирует: правка или удаление середины разговора
  // сдвигает всё, что после неё. Первые восемьдесят символов — то, что обязано
  // остаться на месте, чтобы сжатию было можно прятать сообщения за сводкой.
  function markOf(message) {
    return String((message && message.content) || '').slice(0, COMPRESSION_MARK_LENGTH)
  }

  function isCompressionFresh(history, compression) {
    if (!compression || !Array.isArray(history)) return false
    const from = Number(compression.fromIndex)
    const through = Number(compression.throughIndex)
    if (!Number.isInteger(from) || !Number.isInteger(through)) return false
    if (from < 0 || through < from || through >= history.length) return false
    return markOf(history[through]) === String(compression.throughMark || '').slice(0, COMPRESSION_MARK_LENGTH)
  }

  // История, которая реально уйдёт в модель: свёрнутая середина заменена одной
  // системной репликой со сводкой. Роль именно `system` — репликой человека
  // сводка стала бы просьбой, и модель отвечала бы на неё.
  function applyCompression(history, compression) {
    if (!isCompressionFresh(history, compression)) return history
    const from = Number(compression.fromIndex)
    const through = Number(compression.throughIndex)
    return [
      ...history.slice(0, from),
      { role: 'system', content: String(compression.line || '') },
      ...history.slice(through + 1)
    ]
  }

  // Строка над лентой. Раскрывается в саму сводку — то, что теперь читает
  // модель вместо начала разговора; ниже по-прежнему стоят все исходные
  // сообщения, они никуда не делись.
  function lineHtml(compression) {
    const folded = Number(compression && compression.folded) || 0
    if (!folded) return ''
    const summary = String((compression && compression.summary) || '').trim()
    return '<details class="chat-compressed">' +
      `<summary class="chat-compressed-summary">${escapeHtml(t('Разговор сжат: %s сообщений в начале заменены сводкой', folded))}</summary>` +
      `<div class="chat-compressed-body">${escapeHtml(summary)}</div>` +
      '</details>'
  }

  return {
    markOf,
    isCompressionFresh,
    applyCompression,
    lineHtml
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createConversationCompression }
}
if (typeof window !== 'undefined') {
  window.createConversationCompression = createConversationCompression
}
