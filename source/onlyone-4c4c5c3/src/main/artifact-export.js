'use strict'

// Выгрузка артефакта в файл по выбору человека (план, 1.4).
//
// Всё, что здесь важно, — границы. Путь назначения приходит НЕ от окна: его
// отдаёт системный диалог, и только после того, как человек сказал «сюда».
// Окно может назвать формат, версию и (для графика) разметку, которую само
// нарисовало, — и каждое из этих полей обязано быть проверено до того, как на
// диске появится первый байт. Иначе выгрузка становится обходным путём: к
// чужой папке, к чужой версии, к странице с чужим скриптом, которую человек
// откроет двойным щелчком и даст ей allow-scripts сам.
//
// Зависимости внедряются (`artifacts`, `showSaveDialog`, `capturePage`), чтобы
// модуль проверялся без окна и без настоящего диалога.

const fs = require('fs/promises')
const fssync = require('fs')
const path = require('path')

// Чем «файл как есть» отличается от «открывается в браузере»: первое — байты
// версии, второе — обёртка, в которой содержимое видно без onlyone.
const EXTENSION = { file: null, html: '.html', svg: '.svg', png: '.png' }
const MAX_SVG_CHARS = 2_000_000
const MAX_NAME_CHARS = 80

// Кадр снимается на размер, который человек потом откроет в просмотрщике.
// Разрешение больше этих пределов даёт десятки мегабайт ради картинки, которую
// никто не рассматривает с пиксельной линейкой.
const CAPTURE_WIDTH = 1280
const CAPTURE_HEIGHT = 1600

// Имя файла для диалога. Заголовок артефакта пишет модель, и в нём бывает всё
// что угодно: `/`, `..`, `<>:"|?*`, перевод строки, завершающая точка. Оставляем
// кириллицу и пробелы — человек узнаёт свой артефакт, — и убираем всё, что
// ломает диалог или намекает на выход из папки.
function safeFileName(value) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    // Ряд точек — это всегда намёк на переход вверх по дереву или на скрытый
    // файл; одиночная точка внутри имени («v2.0») остаётся.
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  const trimmed = cleaned.slice(0, MAX_NAME_CHARS).replace(/[.\s]+$/g, '')
  return trimmed || 'artifact'
}

// Разметку графика сериализует окно — главный процесс не знает, как выглядит
// нарисованный svg. Принимается только настоящий svg и только без того, что
// превращает файл графика в страницу со скриптом. Возвращается исходная строка
// целиком: человек, открывший выгруженный файл, должен увидеть ровно тот
// документ, что ему нарисовали, включая декларацию XML в начале.
function cleanSvgText(value) {
  const original = typeof value === 'string' ? value : ''
  const text = original.trim()
  if (!text || text.length > MAX_SVG_CHARS) return null
  const head = text.replace(/^<\?xml[\s\S]*?\?>\s*/i, '')
  if (!/^<svg[\s>]/i.test(head)) return null
  if (/<\s*\/?\s*(script|iframe|object|embed|link)\b/i.test(text)) return null
  if (/javascript\s*:/i.test(text)) return null
  // Разделитель перед именем атрибута в HTML/SVG — не только пробел, но и «/»:
  // <animate/onbegin=…> иначе проходил мимо фильтра (break-5 Н6).
  if (/[\s/]on[a-z]+\s*=/i.test(text)) return null
  return original
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function standaloneHtml({ title, body, rawScript }) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${htmlEscape(title || 'Артефакт')}</title>
<style>body{margin:0;padding:24px;background:#fff;color:#111;font:14px/1.5 system-ui,sans-serif}svg{max-width:100%;height:auto}pre{white-space:pre-wrap;word-break:break-word}</style>
</head>
<body>
${body}
${rawScript ? `<script>${rawScript}<\/script>` : ''}
</body>
</html>
`
}

function createArtifactExporter({ artifacts, root, showSaveDialog, capturePage } = {}) {
  if (!artifacts || typeof artifacts.readMeta !== 'function') {
    throw new Error('Экспорт артефактов не получил хранилище.')
  }

  async function refuse(message) {
    return { ok: false, error: message }
  }

  //Meta читается здесь, а не в окне: окно может назвать что угодно, а версия
  //обязана существовать в папке этого артефакта.
  async function resolveVersion(artifactId, version, chatId) {
    const meta = await artifacts.readMeta(artifactId)
    if (!meta) return { error: 'Артефакт не найден.' }
    const wanted = meta.versions.find(item => item.n === Number(version || meta.current))
    if (!wanted) return { error: `Версии ${version} у этого артефакта нет.` }
    // Граница читается здесь целиком, а не через `servedFile`: у хранилища два
    // разных отказа, и свести их в один — значит наврать про причину.
    const found = artifacts.resolveServed(artifactId, wanted.file)
    if (!found || !found.file) {
      return { error: found && found.refused
        ? 'Файл версии лежит вне папки артефакта.'
        : `Файл версии ${wanted.n} не найден на диске.` }
    }
    const file = found.file
    // Диалог проверяется здесь же: `versionText` отказывает чужому чату, и
    // экспорт не должен быть дверью в обход этого отказа.
    if (chatId) await artifacts.versionText(artifactId, wanted.n, { chatId })
    return { meta, wanted, file }
  }

  function extensionFor(format, wanted) {
    if (format !== 'file') return EXTENSION[format]
    const stored = path.extname(String(wanted.file || ''))
    return stored || ''
  }

  async function bytesFor(format, meta, wanted, file, svgText) {
    if (format === 'file') return fs.readFile(file)
    if (format === 'svg') return Buffer.from(svgText, 'utf8')
    if (format === 'html') {
      if (meta.kind === 'page') return fs.readFile(file)
      if (meta.kind === 'image') {
        // Картинка у артефакта уже лежит как data-ссылка (её присылает модель),
        // и в обёртке она остаётся ровно такой: двойной щелчок должен открыть
        // то же изображение, а не белую страницу со сломанным путём.
        const bytes = await fs.readFile(file)
        const raw = bytes.toString('utf8').trim()
        const src = /^data:[^,]+[,;]/.test(raw)
          ? raw
          : `data:image/${(path.extname(wanted.file).slice(1) || 'png').toLowerCase()};base64,` +
            bytes.toString('base64')
        return Buffer.from(standaloneHtml({
          title: meta.title,
          body: `<img alt="${htmlEscape(meta.title || '')}" src="${htmlEscape(src)}">`
        }), 'utf8')
      }
      // График — json, который браузер не нарисует. Если окно прислало свою
      // разметку, отдаём её: файл открывается и показывает то же, что панель.
      // Если нет — хотя бы данные, чтобы выгрузка не была пустой страницей.
      const body = svgText
        ? svgText
        : `<pre>${htmlEscape((await fs.readFile(file)).toString('utf8'))}</pre>`
      return Buffer.from(standaloneHtml({ title: meta.title, body }), 'utf8')
    }
    return null
  }

  async function capture({ meta, wanted, file, svgText }) {
    if (typeof capturePage !== 'function') {
      return { error: 'Рисовать растр нечем: съёмка экрана недоступна.' }
    }
    const url = meta.kind === 'chart'
      ? 'data:text/html;base64,' + Buffer.from(standaloneHtml({
        title: meta.title, body: svgText
      }), 'utf8').toString('base64')
      // Страница и картинка снимаются по той же ссылке, по которой их видит
      // панель: один и тот же источник, никаких временных файлов в папке.
      : `onecode-artifact://${meta.id}/${encodeURIComponent(wanted.file)}`
    let bytes
    try {
      bytes = await capturePage({ url, width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT, file })
    } catch (error) {
      return { error: `Снимок не получился: ${String(error?.message || error)}` }
    }
    if (!bytes || !bytes.length) return { error: 'Снимок вышел пустым.' }
    return { bytes }
  }

  async function exportArtifact(args = {}, ownerWindow = null) {
    const format = String(args.format || '')
    if (!['file', 'html', 'svg', 'png'].includes(format)) return refuse('Неизвестный формат выгрузки.')
    if (typeof showSaveDialog !== 'function') return refuse('Диалог сохранения недоступен.')

    let id
    try {
      id = String(args.artifactId || '')
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return refuse('Недопустимый идентификатор артефакта.')
    } catch {
      return refuse('Недопустимый идентификатор артефакта.')
    }

    let found
    try {
      found = await resolveVersion(id, args.version, args.chatId || null)
    } catch (error) {
      return refuse(String(error?.message || error))
    }
    if (found.error) return refuse(found.error)
    const { meta, wanted, file } = found

    const allowed = {
      file: ['page', 'image', 'table', 'chart', 'code', 'diff', 'video'],
      html: ['page', 'image', 'chart'],
      svg: ['chart'],
      png: ['page', 'image', 'chart']
    }
    if (!allowed[format].includes(meta.kind)) {
      return refuse(`Формат «${format}» не применим к виду «${meta.kind}».`)
    }

    let svgText = null
    if (format === 'svg') {
      svgText = cleanSvgText(args.svgText)
      if (!svgText) return refuse('Прислана разметка, не похожая на график.')
    } else if (format === 'png' && meta.kind === 'chart') {
      svgText = cleanSvgText(args.svgText)
      if (!svgText) return refuse('Чтобы снять график в растр, нужна его разметка.')
    } else if (format === 'html' && meta.kind === 'chart') {
      svgText = cleanSvgText(args.svgText)
    }

    // Ролик не читается в память: он тяжёлый, и «как есть» для него — копия файла.
    const asCopy = meta.kind === 'video'
    let bytes = null
    if (asCopy) {
      bytes = true
    } else if (format === 'png') {
      const shot = await capture({ meta, wanted, file, svgText })
      if (shot.error) return refuse(shot.error)
      bytes = shot.bytes
    } else {
      try {
        bytes = await bytesFor(format, meta, wanted, file, svgText)
      } catch (error) {
        return refuse(String(error?.message || error))
      }
      if (!bytes) return refuse('Содержимое версии не читается.')
    }

    const name = safeFileName(meta.title) + extensionFor(format, wanted)
    let reply
    try {
      reply = await showSaveDialog(ownerWindow, {
        title: 'Сохранить артефакт',
        defaultPath: path.join(artifacts.folderOf(id), name),
        filters: [{ name: 'Файл', extensions: [name.split('.').pop()] }]
      })
    } catch (error) {
      return refuse(`Не удалось спросить, куда сохранять: ${String(error?.message || error)}`)
    }
    if (!reply || reply.canceled || !reply.filePath) return { ok: false, cancelled: true }

    try {
      // Папку под выбранный путь не создаём: человек выбрал существующее место,
      // а молчаливое «заведу-ка я каталог, которого нет» прячет опечатку в пути
      // и пишет файлы туда, где их никто не искал.
      if (asCopy) await fs.copyFile(file, reply.filePath)
      else await fs.writeFile(reply.filePath, bytes)
    } catch (error) {
      return refuse(`Записать не вышло: ${String(error?.message || error)}`)
    }
    return { ok: true, path: reply.filePath, kind: meta.kind, version: wanted.n }
  }

  return Object.freeze({ export: exportArtifact, safeFileName, cleanSvgText })
}

module.exports = { createArtifactExporter, safeFileName, cleanSvgText, MAX_SVG_CHARS }
