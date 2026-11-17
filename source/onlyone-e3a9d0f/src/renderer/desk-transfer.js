/* Layout exchange is an explicit human action; imported resources stay unbound.

   Шторка «Обмен раскладкой» (макет 25.10): «Передать» показывает, что уйдёт в
   шаблон, и одну главную кнопку «Скопировать шаблон» — текст шаблона на экран
   не выводится. «Принять»: вставленный шаблон распознаётся и встаёт чипом,
   ниже — что добавится, и «Добавить N блока». */
(function () {
  'use strict'
  window.OnlyoneDeskTransfer = { mount ({ api, t, refresh, report, isEditing, blocks = () => [], icon, imported }) {
    const get = id => document.getElementById('desk-transfer-' + id)
    const dialog = get('dialog'), input = get('input'), output = get('export')
    let preview = null, busy = false, generation = 0, message = '', tab = 'out', copied = false
    const kinds = { browser: 'Сайт', artifact: 'Инструмент', output: 'Результат', process: 'Процесс', 'external-app': 'Программа' }
    const auxWords = { artifact: 'инструмент', output: 'результат', process: 'процесс не переносится', 'external-app': 'программа' }
    const insideWords = { browser: 'сайт', artifact: 'страница внутри', output: 'текст внутри' }
    const kindIcon = { browser: 'browser', artifact: 'artifact', output: 'output', process: 'process', 'external-app': 'artifact' }
    const errors = {
      'invalid-template': 'Неверный формат шаблона Desk.', 'empty-template': 'В шаблоне нет блоков.',
      limit: 'После импорта в Desk должно быть не больше 64 блоков.',
      'expired-preview': 'Предпросмотр устарел. Проверьте шаблон заново.',
      conflict: 'Раскладка изменилась. Откройте обмен заново.',
      'storage-unavailable': 'Не удалось сохранить Desk. Прежняя раскладка сохранена.'
    }
    const host = url => { try { return new URL(url).host } catch { return url || '' } }
    // Форма слова «блок» для числа: 0 — один, 1 — два–четыре, 2 — пять и больше.
    const form = n => n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 1 : 2
    function row (title, kind, aux, quiet) {
      const node = document.createElement('li')
      node.className = 'desk-row'
      if (icon) node.append(icon(kindIcon[kind] || 'artifact', false))
      const name = document.createElement('span')
      name.className = 'desk-nm' + (quiet ? ' is-quiet' : '')
      name.textContent = title
      const end = document.createElement('span')
      end.className = 'desk-aux desk-end'
      end.textContent = aux
      node.append(name, end)
      return node
    }
    function controls () {
      get('content').disabled = busy
      get('legacy').disabled = busy
      get('copy').disabled = busy || !output.value
      get('preview').disabled = busy || !input.value.trim()
      get('apply').disabled = busy || !preview
    }
    function paintTabs () {
      const out = tab === 'out'
      get('tab-out').setAttribute('aria-selected', String(out))
      get('tab-in').setAttribute('aria-selected', String(!out))
      get('out').hidden = !out
      get('in').hidden = out
      get('copy').hidden = !out
      document.getElementById('desk-fit').hidden = !out
      get('legacy').hidden = out
      get('preview').hidden = out || Boolean(preview)
      get('apply').hidden = out || !preview
    }
    function paint () {
      const labels = { title: 'Обмен раскладкой', 'tab-out': 'Передать', 'tab-in': 'Принять',
        help: 'В шаблон попадут названия, размеры блоков и адреса сайтов без путей. Файлы, процессы и входы останутся у вас.',
        'blocks-title': 'В шаблоне',
        'content-label': 'С содержимым инструментов и результатов',
        legacy: 'Взять старый Workspace',
        'export-label': 'Текущая раскладка для передачи',
        'input-label': 'Шаблон', preview: 'Проверить шаблон',
        'preview-title': 'Добавится',
        'preview-note': 'Блоки встанут рядом с текущими. Ничего не запустится, пока вы не откроете их сами.' }
      for (const [id, source] of Object.entries(labels)) get(id).textContent = t(source)
      document.getElementById('desk-transfer-open-label').textContent = t('Обмен раскладкой')
      get('open').setAttribute('aria-label', t('Обмен раскладкой'))
      get('close').querySelector('span').textContent = t('Закрыть')
      get('clear').querySelector('span').textContent = t('Убрать шаблон')
      get('copy').querySelector('span').textContent = t(copied ? 'Шаблон скопирован' : 'Скопировать шаблон')
      input.placeholder = t('Вставьте шаблон, который вам передали')
      if (get('content').checked) get('help').textContent = t('Пакет включает код страниц и текст результатов, до 256 КБ. Проверьте содержимое перед передачей. Внешние файлы, входы и программы не копируются; зависимости показаны списком.')
      const list = get('blocks')
      list.replaceChildren(...blocks().map(block => block.kind === 'process'
        ? row(block.title, block.kind, t(auxWords.process), true)
        : row(block.title, block.kind, block.kind === 'browser' ? host(block.url) || t('сайт') : t(auxWords[block.kind] || 'инструмент'), false)))
      const failed = Boolean(message) && !preview && tab === 'in'
      get('message').textContent = t(message)
      get('message').classList.toggle('is-ok', message === 'Шаблон скопирован.' || message.startsWith('Переносится'))
      input.setAttribute('aria-invalid', String(failed && message !== '' && !message.startsWith('Переносится')))
      // Распознанный шаблон — чипом вместо поля с текстом.
      input.hidden = Boolean(preview)
      get('chip').hidden = !preview
      get('preview-panel').hidden = !preview
      const previewList = get('preview-list')
      previewList.replaceChildren()
      if (preview) {
        const n = preview.blocks.length
        get('chip-text').textContent = [t('«%s», %s блок'), t('«%s», %s блока'), t('«%s», %s блоков')][form(n)].replace('%s', preview.title).replace('%s', n)
        for (const block of preview.blocks) {
          const aux = block.url ? host(block.url) : t(insideWords[block.kind] || kinds[block.kind] || 'блок')
          const item = row(block.title, block.kind, aux, false)
          item.title = `${t(kinds[block.kind] || 'Блок')} · ${block.rect.width} × ${block.rect.height}`
          previewList.append(item)
        }
        get('apply').textContent = [t('Добавить %s блок'), t('Добавить %s блока'), t('Добавить %s блоков')][form(n)].replace('%s', n)
      } else get('apply').textContent = t('Добавить блоки')
      paintTabs()
      controls()
    }
    function failure (result) { message = errors[result?.code] || 'Не удалось выполнить обмен раскладкой.'; paint() }
    function setTab (next) {
      tab = next
      message = ''
      copied = false
      paint()
      ;(tab === 'out' ? get('copy') : preview ? get('apply') : input).focus()
    }
    async function exportNow () {
      const current = ++generation
      busy = true; output.value = ''; copied = false; paint()
      try {
        const result = await api.exportTemplate(get('content').checked)
        if (current !== generation) return
        if (result.ok) output.value = result.text
        else failure(result)
      } catch { if (current === generation) failure() }
      finally { if (current === generation) { busy = false; controls() } }
    }
    async function open (start = 'out') {
      if (isEditing()) { report('Блок Desk сейчас занят'); return }
      get('content').checked = false
      preview = null; message = ''; input.value = ''; tab = start
      if (!dialog.open) dialog.showModal()
      await exportNow()
      ;(tab === 'out' ? get('copy') : input).focus()
    }
    get('open').addEventListener('click', () => { if (dialog.open) dialog.close(); else void open() })
    get('tab-out').addEventListener('click', () => setTab('out'))
    get('tab-in').addEventListener('click', () => setTab('in'))
    get('legacy').addEventListener('click', async () => {
      if (busy) return
      const current = generation
      busy = true; preview = null; controls()
      try {
        const result = await api.legacyTemplate()
        if (current !== generation) return
        if (result.ok) { input.value = result.text; message = 'Переносится только раскладка. Агентов, команды и файлы подключите заново.'; paint(); void check() }
        else failure(result)
      } catch { if (current === generation) failure() }
      finally { if (current === generation) { busy = false; controls() } }
    })
    get('content').addEventListener('change', () => { void exportNow() })
    get('close').addEventListener('click', () => dialog.close())
    dialog.addEventListener('close', () => {
      if (dialog.open) return
      generation++; preview = null; input.value = ''; output.value = ''; message = ''; get('open').focus()
    })
    input.addEventListener('input', () => { preview = null; message = ''; paint() })
    // Вставили — сразу проверяем: шаблон распознаётся без лишнего нажатия.
    input.addEventListener('paste', () => setTimeout(() => { if (input.value.trim()) void check() }, 0))
    get('clear').addEventListener('click', () => { preview = null; input.value = ''; message = ''; paint(); input.focus() })
    get('copy').addEventListener('click', async () => {
      if (busy) return
      const current = generation
      busy = true; controls()
      try {
        const result = await api.copyTemplate(output.value, get('content').checked)
        if (current !== generation) return
        if (result.ok) { message = 'Шаблон скопирован.'; copied = true; paint() } else failure(result)
      } catch { if (current === generation) failure() }
      finally { if (current === generation) { busy = false; controls() } }
    })
    async function check () {
      if (busy) return
      const current = generation, text = input.value
      preview = null; busy = true; message = ''; paint()
      try {
        const result = await api.previewTemplate(text, { width: document.getElementById('desk-canvas').clientWidth, height: document.getElementById('desk-canvas').clientHeight })
        if (current !== generation || input.value !== text) return
        if (result.ok) { preview = result; paint() } else failure(result)
      } catch { if (current === generation) failure() }
      finally { if (current === generation) { busy = false; controls() } }
    }
    get('preview').addEventListener('click', () => { void check() })
    get('apply').addEventListener('click', async () => {
      if (busy || !preview) return
      const current = generation, token = preview.token, count = preview.blocks.length
      busy = true; controls()
      try {
        const result = await api.importTemplate(token)
        if (current !== generation) return
        preview = null
        if (result.ok) {
          dialog.close()
          if (imported) await imported(count)
          else { await refresh(); report('Раскладка добавлена. Привяжите ресурсы в Onlyone.') }
        } else failure(result)
      } catch { if (current === generation) { preview = null; failure() } }
      finally { if (current === generation) { busy = false; controls() } }
    })
    paint()
    return { paint, open }
  } }
})()
