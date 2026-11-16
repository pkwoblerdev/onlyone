/* Панель артефактов чата (план, 3.2).
 *
 * Результат модели рядом с ответом: страница и картинка — живым превью,
 * таблица, график, код и дифф — текстом. Правится здесь же и уходит новой
 * версией, прежняя остаётся в списке версий.
 *
 * Отдельный файл потому, что панель — свой экран со своим состоянием, и держать
 * её в `app.js` означало смешивать ленту чата с превью (план, 2d). Модуль не
 * трогает ни хранилище диалогов, ни настройки: всё, что ему нужно, приходит
 * аргументами — `t`, `electronAPI`, общие виджеты окна.
 */
(function (root) {
  'use strict'

  function create(deps) {
    const { $, t, escapeHtml, enhanceSelect, openContextMenu, askConfirm, electronAPI, document } = deps

    // Открытый диалог окно знает лучше панели: она обязана спросить геттером из
    // `deps`, а не читать состояние окна (тот же порядок, что у карточки
    // задачи Дизайна).
    const openChatId = () => (typeof deps.getChatId === 'function' ? String(deps.getChatId() || '') : '')

    const ARTIFACT_KIND = { page: 'Страница', image: 'Картинка', table: 'Таблица', chart: 'График', code: 'Код', diff: 'Дифф', video: 'Видео' }
    const ARTIFACT_TEXT = new Set(['table', 'chart', 'code', 'diff'])
    let artifactShown = null
    // Счётчик показов: ответ прежнего показа не имеет права писать в панель,
    // которую уже занял следующий (шапка и содержимое обязаны быть от одного).
    let artifactShowSeq = 0
    let artifactReturnFocus = null
    let artifactChartRaw = ''
    let artifactChartResizeObserver = null
    let artifactChartResizeTimer = null
    // Таблица показывается не всеми строками: смысл вида — первые строки и
    // честная отметка, сколько осталось.
    const TABLE_ROWS = 200
    const TABLE_COLS = 24
    const FETCH_TIMEOUT_MS = 8000

    const artifactUrl = (artifact, version) => {
      const item = (artifact?.versions || []).find(v => v.n === Number(version || artifact.current)) || {}
      return `onecode-artifact://${artifact.id}/${item.file || ''}`
    }

    // Панель показывает либо результат агента ('artifact'), либо обычный браузер
    // ('browser', browser-panel.js). Режим — атрибут панели: что скрыто и что видно,
    // решает CSS, а данные обоих режимов живут независимо.
    function setPanelMode(mode) {
      const panel = $('artifactPanel')
      if (!panel) return
      panel.dataset.mode = mode === 'browser' ? 'browser' : 'artifact'
      const browser = panel.dataset.mode === 'browser'
      const preview = $('modePreview')
      const web = $('modeBrowser')
      // Переключатель нужен, только когда есть что переключать: без результата агента
      // «Превью» — пустая вкладка, и панель — просто браузер.
      const modes = $('artifactModes')
      if (modes) modes.hidden = !artifactShown
      if (artifactShown) panel.dataset.result = '1'
      else delete panel.dataset.result
      if (preview) {
        preview.setAttribute('aria-selected', String(!browser))
        preview.tabIndex = browser ? -1 : 0
        // «Превью» без показанного результата нечем открыть: вкладка серая, а не пустая.
        preview.setAttribute('aria-disabled', String(!artifactShown))
        preview.setAttribute('data-tooltip', artifactShown ? t('Результат агента') : t('Результатов пока нет: они появятся здесь, когда агент что-нибудь покажет'))
      }
      if (web) {
        web.setAttribute('aria-selected', String(browser))
        web.tabIndex = browser ? 0 : -1
      }
      const toggle = $('openBrowserBtn')
      if (toggle) toggle.setAttribute('aria-pressed', String(browser && !panel.hidden))
    }

    function artifactNotice(text) {
      const box = $('artifactNotice')
      if (!box) return
      box.hidden = !text
      box.textContent = text || ''
    }

    // Пустой прямоугольник превью неотличим от пустого артефакта, а медленный
    // ответ выглядит зависшим: состояние загрузки — часть экрана, не украшение.
    function artifactLoading(on) {
      const box = $('artifactLoading')
      if (box) box.hidden = !on
    }

    async function artifactText(artifact, version) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(artifactUrl(artifact, version), { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error(String(response.status))
        return await response.text()
      } catch (error) {
        if (controller.signal.aborted) throw new Error(t('Ответ не пришёл за 8 с'))
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    // Что можно выгрузить из артефакта этого вида (план, 1.4). Порядок — по
    // полезности: «как есть» первым, потому что это всегда честно сохраняет то,
    // что лежит на диске; остальные форматы появляются только там, где из
    // содержимого действительно получается файл другого рода: html-обёртку
    // имеет смысл давать странице, картинке и графику, svg — только графику,
    // растр — тому, что браузер рисует.
    const ARTIFACT_EXPORT = {
      page: [['file', 'Файл как есть'], ['html', 'HTML-страницей'], ['png', 'PNG-картинкой']],
      image: [['file', 'Файл как есть'], ['html', 'HTML-страницей'], ['png', 'PNG-картинкой']],
      chart: [['file', 'Файл как есть'], ['png', 'PNG-картинкой'], ['svg', 'SVG-графиком']],
      table: [['file', 'Файл как есть']],
      code: [['file', 'Файл как есть']],
      diff: [['file', 'Файл как есть']],
      // Ролик не переделывается в другой формат здесь: обёртка и снимок кадра
      // ему не нужны, а копия файла — ровно то, что человек хочет унести.
      video: [['file', 'Файл как есть']]
    }

    // Чистая функция: ни DOM, ни сети. Проверяется узловым прогоном именно
    // поэтому — и меню, и диалог должны спрашивать её, а не догадываться.
    function artifactExportFormats(artifact) {
      const list = ARTIFACT_EXPORT[String(artifact?.kind || '')]
      if (!list) return []
      return list.map(([format, label]) => ({ format, label: t(label) }))
    }

    // У текстовых видов размер — знаки, у ролика — мегабайты: «4 000 000 знаков»
    // про видеофайл ничего не говорит.
    function artifactSizeLabel(kind, size) {
      if (kind === 'video') return t('%s МБ', ((Number(size) || 0) / 1048576).toFixed(1))
      return t('%s знаков', size || 0)
    }

    // Местное время, а не utc: версия «14.03» означает для человека тот час,
    // в который он работал, а число миллисекунд он читать не будет.
    function artifactVersionStamp(at) {
      const date = new Date(Number(at) || 0)
      const pad = value => String(value).padStart(2, '0')
      return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function fillArtifactVersions(artifact, shownVersion) {
      const select = $('artifactVersion')
      if (!select) return
      const target = Number(shownVersion || artifact.current)
      select.innerHTML = ''
      for (const item of [...(artifact.versions || [])].sort((a, b) => b.n - a.n)) {
        const option = document.createElement('option')
        option.value = String(item.n)
        option.textContent = `#${item.n}`
        if (item.n === target) option.selected = true
        select.appendChild(option)
      }
      // Значение выставляется явно: без него выбор версии из галереи прожил бы
      // ровно до следующей перерисовки, и подпись в шапке разошлась бы с тем,
      // что человек открыл.
      select.value = String(target)
      select.disabled = (artifact.versions || []).length < 2
      // Список свой (план, 1.3): его видимая кнопка живёт рядом с select, а не
      // внутри него, поэтому подпись версии после перестройки опций обновляется
      // здесь — иначе в шапке останется номер, которого уже нет.
      const host = select.parentElement || select
      const shown = host.querySelector('[data-value-label]') ||
        select.previousElementSibling?.querySelector?.('[data-value-label]')
      if (shown) shown.textContent = select.selectedOptions[0]?.textContent || ''
      select.dataset.versionCount = String((artifact.versions || []).length)
      renderArtifactVersionGallery(artifact, Number(select.value || artifact.current))
    }

    // Галерея версий (план, 1.4): список, где видно вид, время и размер — в один
    // клик. Селектор версии рядом остаётся сознательно: он клавиатурный вход и
    // он жеCompact-состояние узкой панели, а галерея отвечает за «понять, что
    // это за версия, не открывая её».
    function renderArtifactVersionGallery(artifact, shownVersion) {
      const host = $('artifactVersions')
      if (!host) return
      host.innerHTML = ''
      const versions = [...(artifact.versions || [])].sort((a, b) => b.n - a.n)
      if (versions.length < 2) {
        host.hidden = true
        return
      }
      const kind = t(ARTIFACT_KIND[artifact.kind] || artifact.kind || '')
      for (const item of versions) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'artifact-version-row'
        row.dataset.version = String(item.n)
        const stamp = artifactVersionStamp(item.at)
        row.textContent = `#${item.n} · ${kind} · ${stamp} · ${artifactSizeLabel(artifact.kind, item.chars)}`
        row.setAttribute('data-tooltip', t('Показать версию %s · %s', item.n, stamp))
        row.setAttribute('aria-label', t('Версия %s, %s', item.n, stamp))
        if (item.n === shownVersion) row.setAttribute('aria-current', 'true')
        row.addEventListener('click', () => showArtifact(artifact, item.n))
        host.appendChild(row)
      }
      host.hidden = false
    }

    // Ряд артефактов диалога: открыть результат можно и после того, как ход
    // модели закончился. Пустой ряд скрыт — без содержимого места он не берёт.
    async function refreshArtifactChips(chatId) {
      const strip = $('artifactChips')
      if (!strip) return
      // Ряд принадлежит открытому диалогу, а не тому, из которого прилетело
      // событие (Н79). Без явного чата берётся открытый; пустого id здесь быть
      // не должно: getArtifacts('') в главном процессе отдаёт артефакты всех
      // чатов сразу, и ряд показал бы чужое.
      const target = String(chatId || openChatId() || '')
      if (!target) return
      let items = []
      try {
        items = (await electronAPI.getArtifacts(target)).artifacts || []
      } catch {
        items = []
      }
      strip.innerHTML = ''
      for (const item of items) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'artifact-chip'
        chip.dataset.id = item.id
        // Подпись — своим <span>: кнопка в приложении — flex-контейнер, а
        // многоточие работает только на блочном содержимом, иначе длинное имя
        // обрезается с двух сторон.
        const label = document.createElement('span')
        label.textContent = item.title || t('Без названия')
        chip.append(label)
        chip.setAttribute('data-tooltip',
          t(ARTIFACT_KIND[item.kind] || item.kind || '') + ' · ' + t('версия %s из %s', item.current, (item.versions || []).length))
        chip.addEventListener('click', () => showArtifact(item))
        strip.appendChild(chip)
      }
      strip.hidden = !items.length
    }

    // Таблица из csv своей разметкой: csvTableHtml — виджет окна скилл-пакета, он
    // отдаёт оболочку и достраивает таблицу в свой #skillPackDoc, в панели ему
    // делать нечего. Разделитель — запятая; кавычки и двойные кавычки как в csv.
    function splitCsvLine(line) {
      const cells = []
      let current = ''
      let quoted = false
      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        if (quoted) {
          if (char === '"' && line[i + 1] === '"') { current += '"'; i++ }
          else if (char === '"') quoted = false
          else current += char
        } else if (char === '"') quoted = true
        else if (char === ',') { cells.push(current); current = '' }
        else current += char
      }
      cells.push(current)
      return cells.map(cell => cell.trim())
    }

    function artifactTableHtml(text) {
      const lines = String(text).split(/\r?\n/).filter(line => line.trim())
      if (!lines.length) return `<div class="artifact-empty">${escapeHtml(t('Пустая таблица'))}</div>`
      const head = splitCsvLine(lines[0]).slice(0, TABLE_COLS)
      const body = lines.slice(1, TABLE_ROWS + 1).map(splitCsvLine)
      const left = Math.max(0, lines.length - 1 - body.length)
      const cells = value => escapeHtml(String(value ?? ''))
      return `<table class="artifact-table">
        <thead><tr>${head.map(cell => `<th>${cells(cell)}</th>`).join('')}</tr></thead>
        <tbody>${body.map(row => `<tr>${head.map((_, i) => `<td>${cells(row[i])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>${left ? `<p class="artifact-more">${t('Показаны не все строки: %s', left)}</p>` : ''}`
    }

    // Chart JSON is data, not source text: render the documented bar/line
    // contract as an SVG. A malformed or older shape remains readable as raw
    // JSON instead of becoming a blank panel.
    function artifactChartHtml(raw, availableWidth = 640) {
      let input
      try { input = JSON.parse(String(raw || '')) } catch { return null }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null

      const type = String(input.type || 'bar').toLowerCase()
      if (!['bar', 'line'].includes(type)) return null
      const rawCategories = Array.isArray(input.categories) ? input.categories : input.labels
      const rawSeries = Array.isArray(input.series) ? input.series : input.datasets
      if (!Array.isArray(rawCategories) || !rawCategories.length || rawCategories.length > 120 ||
          !Array.isArray(rawSeries) || !rawSeries.length || rawSeries.length > 6) return null

      const label = (value, max = 80) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
      const categories = rawCategories.map((value, index) =>
        label(typeof value === 'string' || typeof value === 'number' ? value : '') || String(index + 1))
      const series = []
      for (let index = 0; index < rawSeries.length; index++) {
        const item = rawSeries[index]
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null
        const values = Array.isArray(item.values) ? item.values : item.data
        if (!Array.isArray(values) || values.length !== categories.length) return null
        const numbers = values.map(value => {
          if (value === null || value === '' || typeof value === 'boolean') return NaN
          return Number(value)
        })
        if (numbers.some(value => !Number.isFinite(value))) return null
        series.push({ name: label(item.name || item.label, 80) || `Series ${index + 1}`, values: numbers })
      }

      const title = label(input.title, 120) || t('График')
      const xLabel = label(input.xLabel || input.x_label, 80) || t('Категория')
      const yLabel = label(input.yLabel || input.y_label, 80) || t('Значение')
      const unit = label(input.unit, 24)
      const escape = value => escapeHtml(String(value ?? ''))
      const format = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
      const palette = ['var(--accent)', 'var(--color-green)', 'var(--color-blue)',
        'var(--color-purple)', 'var(--color-amber)', 'var(--color-red)']

      const plotWidthBase = Math.max(320, Math.min(1000, Number(availableWidth) || 640))
      const width = Math.max(plotWidthBase, Math.min(5200, 88 + categories.length * 46))
      const height = 370
      const margin = { left: 62, right: 18, top: 44, bottom: 92 }
      const plotLeft = margin.left
      const plotRight = width - margin.right
      const plotTop = margin.top
      const plotBottom = height - margin.bottom
      const plotWidth = plotRight - plotLeft
      const plotHeight = plotBottom - plotTop
      const values = series.flatMap(item => item.values)
      const minValue = Math.min(0, ...values)
      const maxValue = Math.max(0, ...values)
      const span = maxValue - minValue || 1
      const scaleY = value => plotBottom - ((value - minValue) / span) * plotHeight
      const zeroY = scaleY(0)
      const safeTitle = escape(title)
      const chartType = t(type === 'bar' ? 'Столбчатая диаграмма' : 'Линейная диаграмма')
      const description = `${chartType}: ${title}. ${xLabel}: ${categories.length}. ${yLabel}${unit ? ` (${unit})` : ''}.`
      const parts = [
        `<div class="artifact-chart-scroll"><svg class="artifact-chart-svg" role="img" aria-labelledby="artifact-chart-title artifact-chart-desc" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `<title id="artifact-chart-title">${safeTitle}</title><desc id="artifact-chart-desc">${escape(description)}</desc>`,
        `<text class="artifact-chart-title" x="${plotLeft}" y="24">${safeTitle}</text>`
      ]

      for (let tick = 0; tick <= 4; tick++) {
        const value = minValue + span * tick / 4
        const y = scaleY(value)
        parts.push(`<line class="artifact-chart-grid" x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" />`)
        parts.push(`<text class="artifact-chart-tick" x="${plotLeft - 9}" y="${y + 4}" text-anchor="end">${escape(format(value))}</text>`)
      }

      const slot = plotWidth / categories.length
      if (type === 'bar') {
        const groupWidth = Math.min(slot * 0.76, 42)
        const barWidth = groupWidth / series.length
        for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex++) {
          const groupX = plotLeft + slot * categoryIndex + (slot - groupWidth) / 2
          for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
            const item = series[seriesIndex]
            const value = item.values[categoryIndex]
            const valueY = scaleY(value)
            const y = Math.min(valueY, zeroY)
            const barHeight = Math.max(1, Math.abs(zeroY - valueY))
            const x = groupX + seriesIndex * barWidth
            const tip = `${categories[categoryIndex]} · ${item.name}: ${format(value)}${unit ? ` ${unit}` : ''}`
            parts.push(`<rect class="artifact-chart-bar" x="${x + 1}" y="${y}" width="${Math.max(1, barWidth - 2)}" height="${barHeight}" fill="${palette[seriesIndex]}"><title>${escape(tip)}</title></rect>`)
          }
        }
      } else {
        for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
          const item = series[seriesIndex]
          const points = item.values.map((value, index) => ({
            x: plotLeft + slot * (index + 0.5), y: scaleY(value), value, index
          }))
          const d = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
          parts.push(`<path class="artifact-chart-line" d="${d}" stroke="${palette[seriesIndex]}" />`)
          for (const point of points) {
            const tip = `${categories[point.index]} · ${item.name}: ${format(point.value)}${unit ? ` ${unit}` : ''}`
            parts.push(`<circle class="artifact-chart-point" cx="${point.x}" cy="${point.y}" r="3.5" fill="${palette[seriesIndex]}"><title>${escape(tip)}</title></circle>`)
          }
        }
      }

      const labelStep = Math.max(1, Math.ceil(categories.length / Math.max(2, Math.floor(plotWidth / 64))))
      for (let index = 0; index < categories.length; index++) {
        if (index % labelStep && index !== categories.length - 1) continue
        const x = plotLeft + slot * (index + 0.5)
        const text = escape(categories[index])
        const rotate = categories.length > 6
        parts.push(`<text class="artifact-chart-category" x="${x}" y="${plotBottom + (rotate ? 37 : 20)}" text-anchor="${rotate ? 'end' : 'middle'}"${rotate ? ` transform="rotate(-36 ${x} ${plotBottom + 37})"` : ''}>${text}</text>`)
      }
      parts.push(`<text class="artifact-chart-axis-title" x="${(plotLeft + plotRight) / 2}" y="${height - 8}" text-anchor="middle">${escape(xLabel)}</text>`)
      parts.push(`<text class="artifact-chart-axis-title" x="15" y="${(plotTop + plotBottom) / 2}" text-anchor="middle" transform="rotate(-90 15 ${(plotTop + plotBottom) / 2})">${escape(yLabel)}${unit ? ` (${escape(unit)})` : ''}</text>`)
      parts.push('</svg>')
      if (series.length > 1) {
        parts.push(`<div class="artifact-chart-legend" aria-label="${escape(t('Легенда'))}">`)
        for (let index = 0; index < series.length; index++) {
          parts.push(`<span class="artifact-chart-legend-item"><i style="color:${palette[index]}" aria-hidden="true"></i>${escape(series[index].name)}</span>`)
        }
        parts.push('</div>')
      }
      parts.push('</div>')
      return parts.join('')
    }

    function renderArtifactChart(raw = artifactChartRaw) {
      const text = $('artifactText')
      if (!text) return
      artifactChartRaw = String(raw || '')
      const width = Math.max(320, (text.clientWidth || 640) - 24)
      const html = artifactChartHtml(artifactChartRaw, width)
      if (html) text.innerHTML = html
      else text.textContent = artifactChartRaw
    }

    // Лента не должна ездить под панелью: пока она открыта, чат отводит под
    // панель место тем же классом, каким панель себе ширину берёт.
    function artifactSpace(on) {
      const view = $('chatView')
      if (!view) return
      view.classList.toggle('artifact-open', Boolean(on))
      // Чату под панелью надо оставить место: решает окно, а не панель.
      if (typeof deps.onSpace === 'function') deps.onSpace(Boolean(on))
      // Кнопка «Развернуть» говорит текущим состоянием, а не тем, что сделает:
      // подпись «Развернуть» у уже развёрнутой панели читается как сбой.
      const expanded = view.classList.contains('artifact-expanded')
      const button = $('artifactExpand')
      if (button) {
        button.textContent = t(expanded ? 'Свернуть' : 'Развернуть')
        button.setAttribute('aria-pressed', String(expanded))
        button.setAttribute('data-tooltip', t(expanded
          ? 'Вернуть панель к обычной ширине' : 'Развернуть панель на весь чат'))
      }
    }

    function closeArtifactPanel() {
      artifactShowSeq++
      artifactShown = null
      artifactLoading(false)
      artifactSpace(false)
      const panel = $('artifactPanel')
      if (panel) panel.hidden = true
      setPanelMode(panel && panel.dataset.mode)
      const globe = $('openBrowserBtn')
      if (globe) globe.setAttribute('aria-pressed', 'false')
      const frame = $('artifactFrame')
      if (frame) frame.src = 'about:blank'
      artifactChartRaw = ''
      // Клавиатура должна вернуться туда, где её взяли, иначе закрытие панели
      // сбрасывает фокус в начало страницы.
      const back = artifactReturnFocus
      artifactReturnFocus = null
      if (back && document.contains(back) && !back.hidden) back.focus()
    }

    async function showArtifact(artifact, version, options) {
      if (!artifact?.id) return
      const seq = ++artifactShowSeq
      const panel = $('artifactPanel')
      if (panel.hidden) artifactReturnFocus = document.activeElement
      // Список диалога — источник правды про версии: модель могла прислать две
      // подряд, и у показанного надо свесть историю, а не локальную копию.
      let current = artifact
      try {
        const listed = await electronAPI.getArtifacts(artifact.chatId || '')
        current = (listed?.artifacts || []).find(item => item.id === artifact.id) || artifact
      } catch { /* список недоступен — показываем то, что принесли */ }
      if (seq !== artifactShowSeq) return

      artifactShown = current
      artifactChartRaw = ''
      panel.hidden = false
      artifactSpace(true)
      // Результат, пришедший сам, пока человек листает сайт, не отнимает у него браузер:
      // вкладка «Превью» оживает, а переключает на неё человек. Клик по результату — переключает.
      const stay = Boolean(options && options.quiet) && panel.dataset.mode === 'browser'
      setPanelMode(stay ? 'browser' : 'artifact')
      panel.dataset.kind = current.kind
      $('artifactKind').textContent = t(ARTIFACT_KIND[current.kind] || current.kind || '')
      const titleBox = $('artifactTitle')
      titleBox.textContent = current.title || t('Без названия')
      // Название совпало с видом («Страница · Страница») — вид не повторяем.
      $('artifactKind').hidden = Boolean(current.title) && current.title.trim() === $('artifactKind').textContent.trim()
      // Если заголовок не влез, его надо можно увидеть целиком — подсказка своя,
      // как на всём экране (план, 1.4).
      titleBox.setAttribute('data-tooltip', titleBox.scrollWidth > titleBox.clientWidth + 1 ? titleBox.textContent : '')
      const shown = Number(version || current.current)
      fillArtifactVersions(current, shown)
      enhanceSelect($('artifactVersion'))
      const item = (current.versions || []).find(v => v.n === shown)
      const count = (current.versions || []).length
      $('artifactMeta').textContent =
        `${t('версия %s из %s', shown, count)} · ${artifactSizeLabel(current.kind, item?.chars)}${current.fileName ? ` · ${current.fileName}` : ''}`
      // «Править» есть не везде: страницу правят в самом документе, картинку
      // изменить нельзя по смыслу. Кнопка, которая всегда отказывает, шумит.
      $('artifactEdit').textContent = t('Править')
      $('artifactEdit').hidden = !ARTIFACT_TEXT.has(current.kind)
      $('artifactSave').hidden = true
      $('artifactEditor').hidden = true
      artifactNotice('')
      artifactLoading(true)

      const frame = $('artifactFrame')
      const text = $('artifactText')
      // Прежний ролик замолкает и перестаёт качаться, что бы ни открылось дальше.
      const video = $('artifactVideo')
      if (video) {
        if (typeof video.pause === 'function') video.pause()
        video.hidden = true
        if (video.getAttribute && video.getAttribute('src')) { video.removeAttribute('src'); video.load() }
      }
      try {
        if (current.kind === 'video' && video) {
          frame.hidden = true
          frame.srcdoc = ''
          text.hidden = true
          text.innerHTML = ''
          video.hidden = false
          await new Promise((resolve, reject) => {
            const done = () => { clear(); resolve() }
            const failed = () => { clear(); reject(new Error(t('Ролик не открывается'))) }
            const timer = setTimeout(() => { clear(); reject(new Error(t('Ответ не пришёл за 8 с'))) }, FETCH_TIMEOUT_MS)
            const clear = () => {
              clearTimeout(timer)
              video.removeEventListener('loadedmetadata', done)
              video.removeEventListener('error', failed)
            }
            video.addEventListener('loadedmetadata', done, { once: true })
            video.addEventListener('error', failed, { once: true })
            // #t=0.1 — плеер показывает кадр, а не пустой прямоугольник, пока не нажали «играть».
            video.src = artifactUrl(current, shown) + '#t=0.1'
          })
        } else if (current.kind === 'page') {
          text.hidden = true
          text.innerHTML = ''
          frame.hidden = false
          await new Promise((resolve, reject) => {
            const done = () => { frame.removeEventListener('load', done); resolve() }
            frame.addEventListener('load', done, { once: true })
            frame.src = artifactUrl(current, shown)
            setTimeout(() => { frame.removeEventListener('load', done); reject(new Error(t('Ответ не пришёл за 8 с'))) }, FETCH_TIMEOUT_MS)
          })
        } else if (current.kind === 'image') {
          const data = (await artifactText(current, shown)).trim()
          if (seq !== artifactShowSeq) return
          text.hidden = true
          text.innerHTML = ''
          frame.hidden = false
          frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1d1b17}img{max-width:100%;max-height:100vh}</style></head><body><img src="${data.replace(/"/g, '&quot;')}" alt=""></body></html>`
        } else if (current.kind === 'table') {
          // Таблица показывается таблицей: смыслом вида «таблица» является то, что
          // её строки и колонки совидны, а не текст с запятыми.
          frame.hidden = true
          frame.srcdoc = ''
          text.hidden = false
          text.textContent = ''
          const tableBody = await artifactText(current, shown)
          if (seq !== artifactShowSeq) return
          text.innerHTML = artifactTableHtml(tableBody)
        } else if (current.kind === 'chart') {
          frame.hidden = true
          frame.srcdoc = ''
          text.hidden = false
          const chartRaw = await artifactText(current, shown)
          if (seq !== artifactShowSeq) return
          renderArtifactChart(chartRaw)
        } else {
          frame.hidden = true
          frame.srcdoc = ''
          text.hidden = false
          text.innerHTML = ''
          const body = await artifactText(current, shown)
          if (seq !== artifactShowSeq) return
          text.textContent = body
        }
      } catch (error) {
        if (seq === artifactShowSeq) artifactNotice(t('Содержимое не прочиталось: %s', error.message || error))
      } finally {
        if (seq === artifactShowSeq) artifactLoading(false)
      }
    }

    function editArtifact() {
      if (!artifactShown) return
      if (!$('artifactEditor').hidden) { closeArtifactEdit(); return }
      const target = artifactShown
      const shown = Number($('artifactVersion').value || target.current)
      // Только текстовые виды: правку страницы человек делает в самом документе,
      // а картинку изменить нельзя по смыслу.
      if (!ARTIFACT_TEXT.has(target.kind)) { artifactNotice(t('Править текстом можно таблицу, график, код и дифф.')); return }
      artifactText(target, shown).then(body => {
        // Показ сменился, пока читалось тело: редактор с чужим содержимым сохранил
        // бы его новой версией уже другого артефакта (или другой версии этого же).
        if (artifactShown?.id !== target.id ||
            Number($('artifactVersion').value || artifactShown.current) !== shown) return
        const editor = $('artifactEditor')
        editor.value = body
        editor.hidden = false
        $('artifactText').hidden = true
        $('artifactFrame').hidden = true
        $('artifactFrame').srcdoc = ''
        $('artifactEdit').textContent = t('Отменить правку')
        $('artifactSave').hidden = false
        editor.focus()
      }).catch(error => artifactNotice(t('Правка недоступна: %s', error.message || error)))
    }

    function closeArtifactEdit() {
      $('artifactEditor').hidden = true
      $('artifactSave').hidden = true
      $('artifactEdit').textContent = t('Править')
      showArtifact(artifactShown, artifactShown?.current)
    }

    async function saveArtifactVersion() {
      if (!artifactShown) return
      const content = $('artifactEditor').value
      if (!content.trim()) { artifactNotice(t('Пустая версия не сохраняется: прежнее на месте.')); return }
      const result = await electronAPI.saveArtifactVersion({ id: artifactShown.id, content })
      if (result?.ok) { $('artifactEditor').hidden = true; $('artifactSave').hidden = true }
      else artifactNotice(result?.error || t('Версия не сохранилась'))
    }

    function renameArtifactInPlace() {
      const title = $('artifactTitle')
      if (!artifactShown || title.isContentEditable) return
      // Слушатели снимаются один раз в finished: {once:true} на keydown съедался
      // первым набранным символом, и Escape/Enter умирали, а blur коммитил имя.
      let done = false
      const finished = async commit => {
        if (done) return
        done = true
        title.removeEventListener('keydown', onKey)
        title.removeEventListener('blur', onBlur)
        const value = title.textContent.trim()
        title.contentEditable = 'false'
        title.blur()
        title.textContent = artifactShown.title || t('Без названия')
        if (commit && value && value !== artifactShown.title) {
          const result = await electronAPI.renameArtifact({ id: artifactShown.id, title: value })
          if (result?.artifact) showArtifact(result.artifact)
        }
      }
      const onKey = event => {
        if (event.key === 'Enter') { event.preventDefault(); if (event.isComposing || event.keyCode === 229) return; finished(true) }
        else if (event.key === 'Escape') { event.preventDefault(); finished(false) }
      }
      const onBlur = () => finished(true)
      title.contentEditable = 'true'
      title.focus()
      document.getSelection()?.selectAllChildren(title)
      title.addEventListener('keydown', onKey)
      title.addEventListener('blur', onBlur)
    }

    // Редкие действия панели — под кнопкой «Ещё». Своё меню, а не три подписанные
    // кнопки в шапке: с пятью кнопками не оставалось места ни названию, ни
    // номеру версии.
    function artifactMoreMenu() {
      const anchor = $('artifactMore')
      if (!artifactShown || !anchor) return
      const box = anchor.getBoundingClientRect()
      const formats = artifactExportFormats(artifactShown)
      openContextMenu(box.left, box.bottom + 4, [
        // Выгрузка — один пункт со своим списком форматов, а не три: в шапке и
        // так пять действий, а форматов у страницы три.
        ...(formats.length ? [{ label: 'Выгрузить артефакт', onPick: () => artifactExportMenu(formats) }] : []),
        { label: 'Переименовать артефакт', onPick: () => renameArtifactInPlace() },
        { label: 'Показать папку артефакта', onPick: () => electronAPI.revealArtifact({ id: artifactShown.id }) },
        { label: 'Убрать из списка', hint: 'файлы останутся', onPick: () => archiveArtifactConfirmed() }
      ])
    }

    function artifactExportMenu(formats) {
      const anchor = $('artifactMore')
      if (!artifactShown || !anchor) return
      const box = anchor.getBoundingClientRect()
      openContextMenu(box.left, box.bottom + 4, formats.map(item => ({
        label: item.label, onPick: () => exportArtifactAs(item.format)
      })))
    }

    // Разметку графика знает только окно: главный процесс видит json и нарисовать
    // его не может, поэтому svg и растр графика уезжают вместе с той svg, которую
    // панель уже показывает.
    function artifactChartSvgText() {
      const svg = $('artifactText')?.querySelector?.('.artifact-chart-svg')
      return svg && svg.outerHTML ? svg.outerHTML : ''
    }

    async function exportArtifactAs(format) {
      if (!artifactShown) return
      const version = Number($('artifactVersion')?.value || artifactShown.current)
      const payload = {
        artifactId: artifactShown.id,
        version,
        format,
        chatId: artifactShown.chatId || ''
      }
      if (artifactShown.kind === 'chart' && format !== 'file') payload.svgText = artifactChartSvgText()
      const res = await electronAPI.exportArtifact(payload)
      if (res?.ok) {
        artifactNotice(t('Выгружено: %s', res.path || ''))
        return
      }
      // Отмена диалога — не поломка: человек передумал, и кричать об этом нечем.
      if (res?.cancelled) return
      artifactNotice(String(res?.error || t('Выгрузить не удалось')))
    }

    // В кнопке убирать надо было дважды; в меню второй раз означал бы «открой
    // меню ещё раз», поэтому здесь — обычный вопрос приложению.
    async function archiveArtifactConfirmed() {
      if (!artifactShown) return
      const id = artifactShown.id
      const chatId = artifactShown.chatId || ''
      if (!(await askConfirm(t('Убрать панель? Файлы останутся в папке артефакта.'), t('Убрать')))) return
      electronAPI.archiveArtifact({ id, chatId })
      closeArtifactPanel()
      refreshArtifactChips(chatId)
    }

    function bind() {
      $('artifactClose')?.addEventListener('click', closeArtifactPanel)
      // «Превью» возвращает к показанному результату; без результата вкладка серая и молчит.
      $('modePreview')?.addEventListener('click', () => { if (artifactShown) setPanelMode('artifact') })
      setPanelMode('artifact')
      $('artifactEdit')?.addEventListener('click', editArtifact)
      $('artifactMore')?.addEventListener('click', artifactMoreMenu)
      $('artifactExpand')?.addEventListener('click', () => {
        $('chatView')?.classList.toggle('artifact-expanded')
        artifactSpace(true)
      })
      $('artifactSave')?.addEventListener('click', () => saveArtifactVersion().catch(error => artifactNotice(String(error.message || error))))
      $('artifactVersion')?.addEventListener('change', event => { if (artifactShown) showArtifact(artifactShown, event.target.value) })

      if (typeof ResizeObserver === 'function') {
        artifactChartResizeObserver = new ResizeObserver(() => {
          const text = $('artifactText')
          if (artifactShown?.kind !== 'chart' || !text || text.hidden || !text.querySelector('.artifact-chart-svg')) return
          clearTimeout(artifactChartResizeTimer)
          artifactChartResizeTimer = setTimeout(() => renderArtifactChart(), 100)
        })
        artifactChartResizeObserver.observe($('artifactText'))
      }

      // Escape закрывает панель, пока в ней не редактируют текст: правку нельзя
      // терять по клавише, человек может печатать.
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || $('artifactPanel')?.hidden) return
        if (!$('artifactEditor').hidden || $('artifactTitle').isContentEditable) return
        // Открытое меню перехватывает Escape само; оба слушателя стоят на capture
        // одного узла, и stopPropagation здесь не помогает — закрылась бы и панель.
        if (document.querySelector('.ctx-menu')) return
        event.stopPropagation()
        closeArtifactPanel()
      }, true)

      electronAPI.onArtifactChanged?.(payload => {
        if (payload?.action === 'archived') {
          if (artifactShown?.id === payload?.artifact?.id) closeArtifactPanel()
          return
        }
        // В Ultra ролик показывает свой блок с плеером (ultra-blocks.js): панель поверх
        // него ничего не добавила бы, а закрыла бы половину окна.
        const inUltraBlock = payload?.artifact?.kind === 'video' &&
          document.documentElement.getAttribute('data-version-preset') === 'ultra'
        if (payload?.artifact && !inUltraBlock) showArtifact(payload.artifact, undefined, { quiet: true })
        // Ряд перестраивает только событие открытого диалога: фоновый чат не
        // имеет права подменять кнопки, которые человек видит сейчас (Н79).
        const opened = openChatId()
        const eventChat = String(payload?.artifact?.chatId || payload?.chatId || '')
        if (opened && (!eventChat || eventChat === opened)) refreshArtifactChips(opened)
      })
    }

    return Object.freeze({
      bind, showArtifact, closeArtifactPanel, refreshArtifactChips, artifactSpace, setPanelMode,
      artifactChartHtml, artifactExportFormats, artifactVersionStamp
    })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneArtifactPanel = api
})(typeof window === 'object' ? window : globalThis)
