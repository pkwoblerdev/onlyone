'use strict'

// Точка входа worker'а поиска. Нужна отдельным файлом: worker_threads запускают
// этот код в другом потоке, и передать туда можно только путь к модулю.

const { parentPort, workerData } = require('worker_threads')
const { search } = require('./workspace-search')

search({
  ...workerData.args,
  // О фазе сообщаем сразу: сборка и проба шаблона — это первые секунды жизни
  // потока, и у родителя есть свой, короткий срок на них.
  onPhase: phase => parentPort.postMessage({ type: 'phase', phase }),
  // Отдаем частями, чтобы главный процесс мог показать то, что уже найдено, если
  // до конца обхода он ждать не станет.
  onBatch: matches => parentPort.postMessage({ type: 'batch', matches })
})
  .then(result => parentPort.postMessage({
    type: 'done',
    files: result.files,
    skipped: result.skipped,
    truncated: result.truncated,
    stopped: result.stopped
  }))
  .catch(error => parentPort.postMessage({ type: 'error', error: String(error?.message || error) }))
