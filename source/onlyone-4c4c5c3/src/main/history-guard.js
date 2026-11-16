'use strict'

// Запись агента в переписку и устаревшее сохранение окна.
//
// Окно держит свою копию истории и пишет её целиком (`set-conversations`).
// Агент в главном процессе дописывает заметку в чат (`project_note`) и шлёт окну
// `conversations-changed`. Если окно успело отправить сохранение со своей
// старой копией раньше, чем прочитало историю заново, главный процесс записывал
// эту копию поверх — заметка пропадала, и слияние в окне её уже не находило.
//
// Здесь главный процесс помнит, что написал сам, и пока окно не прочитало
// историю после этой записи, дописывает забытое в его сохранение. Удалённый
// пользователем чат не воскрешается: заново создаётся только чат, который
// создал агент.
//
// Отсутствие записи в сохранении означает одно из двух, и охранник различает их
// по тому, что окно получало: «ещё не доехало» (спасаем) или «было показано и
// пропало» (человек удалил). Удаление — факт: запись охранника снимается целиком,
// чтобы устаревшая копия другого окна не вернула удалённое на диск.

const crypto = require('node:crypto')

const MAX_ENTRIES = 200
const TTL_MS = 10 * 60 * 1000

const clone = value => JSON.parse(JSON.stringify(value))

function messageKey(message) {
  const role = message?.role || '?'
  const content = message?.content
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => part?.text || '').join(' ') : ''
  // Ключ с содержимым: две заметки, написанные агентом в одну миллисекунду, давали
  // общий ключ `role:timestamp`, и вторая молча не дописывалась.
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)
  return message?.timestamp ? `${role}:${message.timestamp}:${hash}` : `${role}#${hash}`
}

function create({ now = () => Date.now() } = {}) {
  let entries = []

  const prune = () => {
    const limit = now() - TTL_MS
    entries = entries.filter(entry => entry.pending.size && entry.at >= limit)
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
  }

  // Есть ли заметка охраняемой записи среди сообщений `messages`. Сначала роль и
  // время: содержимое хешируется только у кандидатов, иначе каждое чтение большой
  // истории перебивалось бы хешами на все сообщения.
  const holdsNote = (entry, messages) => messages.some(message =>
    (message?.role || '?') === entry.noteRole &&
    (message?.timestamp || 0) === entry.noteAt &&
    messageKey(message) === entry.noteKey)

  // Есть ли запись агента в копии `list` — по ней и решается, устарело сохранение
  // или из него удалили.
  const holds = (entry, list) => {
    const chat = list.find(item => item?.id === entry.chatId)
    if (!chat) return false
    if (entry.topic && chat.topic !== entry.topic) return false
    if (!entry.noteKey) return true
    return holdsNote(entry, Array.isArray(chat.messages) ? chat.messages : [])
  }

  return {
    // Агент записал `note` в чат `chat` (целиком — на случай, если чат создан им)
    // и/или назначил `topic`. `senderIds` — окна, которым ушло conversations-changed.
    wrote({ chat, note = null, topic = '', created = false }, senderIds) {
      if (!chat?.id || (!note && !topic && !created)) return
      prune()
      entries.push({
        at: now(),
        chatId: chat.id,
        chat: created ? clone(chat) : null,
        note: note ? clone(note) : null,
        noteKey: note ? messageKey(note) : '',
        noteRole: note?.role || '?',
        noteAt: note?.timestamp || 0,
        topic: String(topic || ''),
        pending: new Set(senderIds),
        had: new Set()
      })
    },

    // Окно прочитало историю `list`: всё, что было записано до этого, оно видело.
    // По `list` охранник узнаёт, что запись показана: без него остаётся только «не доехало».
    seen(senderId, list) {
      const delivered = Array.isArray(list) ? list : null
      for (const entry of entries) {
        entry.pending.delete(senderId)
        if (delivered && holds(entry, delivered)) entry.had.add(senderId)
      }
      prune()
    },

    // Сохранение окна `senderId`: возвращает список с дописанным забытым.
    reconcile(senderId, incoming) {
      prune()
      const list = Array.isArray(incoming) ? incoming : []
      for (const entry of entries) {
        if (holds(entry, list)) { entry.had.add(senderId); continue }
        // Заметка на месте, но тема переименована человеком — это не удаление.
        // Охрану не снимаем: устаревшая копия другого окна всё ещё должна получить
        // заметку, а новую тему человека не затираем темой агента (Н7).
        const chatNow = list.find(item => item?.id === entry.chatId)
        if (entry.noteKey && chatNow && holdsNote(entry, Array.isArray(chatNow.messages) ? chatNow.messages : [])) {
          entry.had.add(senderId); continue
        }
        // Запись была в копии этого окна и пропала — её удалили. Снимается вся
        // запись, чтобы устаревшая копия другого окна не вернула удалённое на диск.
        if (entry.had.has(senderId)) { entry.pending.clear(); continue }
        if (!entry.pending.has(senderId)) continue
        const chat = list.find(item => item?.id === entry.chatId)
        if (!chat) {
          if (entry.chat) list.unshift(clone(entry.chat))
          continue
        }
        if (entry.note) {
          const messages = Array.isArray(chat.messages) ? chat.messages : (chat.messages = [])
          if (!holdsNote(entry, messages)) {
            // Вставка по времени; у заметки без timestamp времени нет — в конец, а
            // не в начало, иначе прежние сообщения съезжают (Н3).
            const at = entry.note.timestamp
              ? messages.findIndex(message => (message?.timestamp || 0) > entry.note.timestamp)
              : -1
            messages.splice(at < 0 ? messages.length : at, 0, clone(entry.note))
            chat.updatedAt = Math.max(chat.updatedAt || 0, entry.note.timestamp || 0)
          }
        }
        if (entry.topic && chat.topic !== entry.topic) chat.topic = entry.topic
      }
      return list
    },

    pending: () => entries.length
  }
}

module.exports = { create, messageKey, MAX_ENTRIES, TTL_MS }
