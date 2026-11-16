'use strict'

// Профиль, который не открылся: набор данных потерял ключ шифрования или секция
// файла настроек не расшифровалась. Модуль решает, что и когда сказать человеку,
// и куда отложить нечитаемые байты; чтение настроек и сами наборы остаются в
// главном процессе (bulk-store.js, readStoreSecure).
//
// Зависимости приносят аргументами: dialog/app/join/tr — окно и пути, latency —
// журнал, fs — синхронная запись архива, bulk — ленивое хранилище наборов.

function createProfileNotice({ bulk, bulkKeys, dialog, app, join, tr, latency, fs }) {
  // Набор, который не открылся из-за ключа шифрования. Пока он есть, пустой
  // список чатов или макетов — это не «пользователь ничего не создал», а
  // «данные не читаются», и молчать об этом нельзя: см. bulk-store.js (loseKey).
  function bulkIntegrity() {
    // Именно bulk(), а не готовое хранилище: хранилище создаётся лениво, а
    // спросить про целостность могут раньше первого чтения (например тот же
    // обработчик get-conversations) — и тогда «пусто» из-за потерянного ключа
    // снова стало бы молчаливым.
    return bulk().integrity()
  }

  // Открылся ли набор в этом запуске. Отвечать надо и после того, как нечитаемое
  // уехало в архив: окно к этому времени уже успевает сохранить новый пустой
  // список, а сказать человеку «переписка не открылась» нужно всё равно.
  function bulkKeyLost(key) {
    return bulkIntegrity().unreadable.includes(key)
  }

  // Секции файла настроек, которые в этом запуске ушли в settings-corrupt: живого
  // значения больше нет, и человеку об этом говорят окном, а не только строкой
  // журнала (Н20).
  const archivedSettings = new Set()

  // Что уже названо человеку: наборы могут открываться по очереди (сначала
  // переписка, потом дизайны), и о каждом потерянном надо сказать один раз, а не
  // молчать о втором из-за первого окна.
  const keyLossNotified = new Set()

  function noticeKeyLoss() {
    const integrity = bulkIntegrity()
    // Нечитаемые за запуск наборы делятся на две беды: целой файл, который
    // нечем расшифровать (ключ), и файл, который не разобрался (карантин).
    // Врать человеку «ключ не подошёл» поверх битого JSON нельзя (общий Н1).
    const damagedKeys = new Set(integrity.corrupt || [])
    const lostNow = [...bulkKeys].filter(bulkKeyLost)
    const archivedNow = [...archivedSettings]
    const fresh = [...lostNow, ...archivedNow].filter(key => !keyLossNotified.has(key))
    if (!fresh.length) return
    for (const key of fresh) keyLossNotified.add(key)
    const lost = lostNow.filter(key => fresh.includes(key))
    const damaged = lost.filter(key => damagedKeys.has(key))
    const keyless = lost.filter(key => !damagedKeys.has(key))
    const archived = archivedNow.filter(key => fresh.includes(key))
    const nameOf = key => key === 'skills' ? tr('Скиллы') : key === 'mcpServers' ? tr('MCP') : key
    const bulkName = keys => keys.length === 2 ? tr('Переписка и дизайны')
      : keys[0] === 'conversations' ? tr('Переписка') : tr('Дизайны')
    const dataDir = join(app.getPath('userData'), 'data')
    const messages = []
    const details = []
    if (keyless.length) {
      messages.push(tr('%s не открылись: ключ шифрования профиля не подошёл.', bulkName(keyless)))
      details.push(tr('Файлы на месте и не изменены — папка данных: %s.\n\nКлюч шифрования пишет Chromium, и если приложение было закрыто сбоем в первые секунды после создания профиля (или файлы пришли с другой учётной записи Windows), ключ до диска не дожил.\n\nНичего из этой папки не удаляйте: там лежит шифр, который можно разобрать руками. Приложение работает далее, но при первом же сохранении отложит нечитаемые файлы рядом с именем `.key-lost-<дата>` — вместо того чтобы молча перезаписать их пустым списком.', dataDir))
    }
    if (damaged.length) {
      messages.push(tr('%s не открылись: файл набора не разобрался.', bulkName(damaged)))
      details.push(tr('Нечитаемые файлы наборов уже отложены рядом с именем `.corrupt-<дата>` — папка данных: %s. Ничего из неё не удаляйте: там лежат байты, которые можно разобрать руками. Список покажется пустым — это не вы удалили данные.', dataDir))
    }
    if (!lost.length) messages.push(tr('%s не открылись: ключ шифрования профиля не подошёл.', archived.map(nameOf).join(', ')))
    if (archived.length) details.push(tr('Секции настроек (%s) сохранены в папке %s — ничего из неё не удаляйте, чтобы можно было разобрать руками.', archived.map(nameOf).join(', '), join(app.getPath('userData'), 'settings-corrupt')))
    dialog.showMessageBox({
      type: 'warning',
      title: 'onlyone',
      message: messages.join(' '),
      detail: details.join('\n\n'),
      buttons: [tr('Понятно')]
    }).catch(() => { /* ответ не нужен, ход окна его не ждёт */ })
  }

  function corruptArchiveDir() {
    return join(app.getPath('userData'), 'settings-corrupt')
  }

  // Файл архива на ключ пишется один раз, но «названа» секция быть должна в
  // каждый запуск: нечитаемое не читается снова и снова, и окно обязано
  // говорить об этом каждый раз (новый Н3). Отличное по содержимому второе
  // укладывание уходит отдельным файлом с датой — прежний образец не затирается
  // и новые байты не теряются (общий Н4).
  function archiveCorruptSettings(key, raw) {
    const body = JSON.stringify(raw)
    const dir = corruptArchiveDir()
    const target = join(dir, `${key}.json`)
    try {
      if (fs.existsSync(target)) {
        if (fs.readFileSync(target, 'utf8') !== body) {
          const aside = join(dir, `${key}.${Date.now()}.json`)
          const temp = `${aside}.${process.pid}.tmp`
          fs.writeFileSync(temp, body)
          fs.renameSync(temp, aside)
        }
        latency.write(`settings archived-corrupt ${key}`)
        archivedSettings.add(key)
        return true
      }
      fs.mkdirSync(dir, { recursive: true })
      const temp = `${target}.${process.pid}.tmp`
      fs.writeFileSync(temp, body)
      fs.renameSync(temp, target)
      latency.write(`settings archived-corrupt ${key}`)
      // Живого значения больше нет: об этом скажет окно, а не только журнал (Н20).
      archivedSettings.add(key)
      return true
    } catch (error) {
      latency.write(`settings archive-failed ${key} ${String(error?.message || error).slice(0, 200)}`)
      return false
    }
  }

  return { bulkIntegrity, bulkKeyLost, noticeKeyLoss, archiveCorruptSettings }
}

module.exports = { createProfileNotice }
