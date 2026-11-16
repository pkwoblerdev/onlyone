// ---------------------------------------------------------------------------
// Конфигурация интерфейса onlyone («Интерфейс как данные»)
// Схема, валидация, защита от CSS-инъекций, CSS-переменные, хранение и откат
// ---------------------------------------------------------------------------

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_UI_CONFIG = Object.freeze({
  sidebarWidth: 240,
  workPanelWidth: 360,
  codeFontSize: 13,
  fontUiSize: 13.5,
  lineHeight: 1.45,
  showSidebar: true,
  // Значение по умолчанию обязано сохранять прежний вид: панель «Работа» была
  // видна всегда. Версию, где её нет, прячет своим
  // `--work-panel-display` оболочка Ultra, а не общий дефолт.
  showWorkPanel: true,
  panelsOrder: ['sidebar', 'chat', 'work'],
  versionPreset: 'default'
})

// Версии оболочки: прежняя, Pro и Ultra. Значение выбирает раскладку окна,
// поэтому оно не ездит в CSS-переменные (см. toCssVariables) и не принимает
// ничего кроме этих трёх слов.
const VERSION_PRESETS = Object.freeze(['default', 'pro', 'ultra'])

// Наборы интерфейса под задачи человека:
// «дизайн» (design): просторная рабочая панель макета, компактный сайдбар
// «код» (code): крупный кегль кода (16px), активная рабочая панель
// «исследование» (research): развёрнутый сайдбар (320px) под проекты и контекст, скрытая рабочая панель
const TASK_PRESETS = Object.freeze({
  design: Object.freeze({
    sidebarWidth: 200,
    workPanelWidth: 480,
    codeFontSize: 13,
    fontUiSize: 13.5,
    lineHeight: 1.45,
    showSidebar: true,
    showWorkPanel: true,
    panelsOrder: ['sidebar', 'chat', 'work'],
    taskPreset: 'design'
  }),
  code: Object.freeze({
    sidebarWidth: 220,
    workPanelWidth: 420,
    codeFontSize: 16,
    fontUiSize: 13.5,
    lineHeight: 1.5,
    showSidebar: true,
    showWorkPanel: true,
    panelsOrder: ['sidebar', 'chat', 'work'],
    taskPreset: 'code'
  }),
  research: Object.freeze({
    sidebarWidth: 320,
    workPanelWidth: 360,
    codeFontSize: 13,
    fontUiSize: 14,
    lineHeight: 1.5,
    showSidebar: true,
    showWorkPanel: false,
    panelsOrder: ['sidebar', 'chat', 'work'],
    taskPreset: 'research'
  })
})

const TASK_PRESET_ALIASES = Object.freeze({
  design: 'design',
  'дизайн': 'design',
  code: 'code',
  'код': 'code',
  research: 'research',
  'исследование': 'research'
})

function getTaskPreset(name) {
  if (!name || typeof name !== 'string') return null
  const normalized = TASK_PRESET_ALIASES[name.trim().toLowerCase()]
  if (!normalized || !TASK_PRESETS[normalized]) return null
  return { ...TASK_PRESETS[normalized] }
}

function applyTaskPreset(baseConfig, presetName) {
  const preset = getTaskPreset(presetName)
  if (!preset) {
    return { ok: false, error: `неизвестный набор интерфейса: "${presetName}". Доступны: design (дизайн), code (код), research (исследование)` }
  }

  const base = baseConfig && typeof baseConfig === 'object' ? baseConfig : DEFAULT_UI_CONFIG
  const merged = {
    ...base,
    ...preset
  }

  // versionPreset (версия оболочки) не затирается набором задачи
  if (base.versionPreset) {
    merged.versionPreset = base.versionPreset
  }

  return validate(merged)
}

const ALLOWED_PROPERTIES = new Set([
  'sidebarWidth',
  'workPanelWidth',
  'codeFontSize',
  'fontUiSize',
  'lineHeight',
  'showSidebar',
  'showWorkPanel',
  'panelsOrder',
  'versionPreset',
  'taskPreset'
])

// Регулярное выражение для отсечения CSS- и JS-инъекций
const INJECTION_PATTERN = /(?:@import|url\(|expression\(|javascript:|<\/?style|<\/?script|[;"'{}])/i

function checkNoInjection(val, propName = '') {
  if (typeof val === 'string') {
    if (INJECTION_PATTERN.test(val)) {
      return { ok: false, error: `CSS injection detected in ${propName}: forbidden characters or keywords` }
    }
  } else if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      const res = checkNoInjection(val[i], `${propName}[${i}]`)
      if (!res.ok) return res
    }
  } else if (val && typeof val === 'object') {
    for (const [k, v] of Object.entries(val)) {
      const resK = checkNoInjection(k, `${propName}.${k}`)
      if (!resK.ok) return resK
      const resV = checkNoInjection(v, `${propName}.${k}`)
      if (!resV.ok) return resV
    }
  }
  return { ok: true }
}

function validate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, error: 'invalid payload: expected object' }
  }

  // Проверка на инъекции по всему объекту
  const injectionCheck = checkNoInjection(candidate, 'config')
  if (!injectionCheck.ok) {
    return injectionCheck
  }

  // Проверка неожиданных свойств (additionalProperties: false)
  for (const key of Object.keys(candidate)) {
    if (!ALLOWED_PROPERTIES.has(key)) {
      return { ok: false, error: `invalid property: unknown key "${key}"` }
    }
  }

  const result = { ...DEFAULT_UI_CONFIG }

  if (candidate.taskPreset !== undefined) {
    if (typeof candidate.taskPreset !== 'string') {
      return { ok: false, error: 'invalid type: taskPreset must be a string' }
    }
    const normalized = TASK_PRESET_ALIASES[candidate.taskPreset.trim().toLowerCase()]
    if (!normalized || !TASK_PRESETS[normalized]) {
      return { ok: false, error: `invalid taskPreset: ожидается одно из ${Object.keys(TASK_PRESETS).join(' | ')}` }
    }
    const preset = TASK_PRESETS[normalized]
    Object.assign(result, preset)
    result.taskPreset = normalized
  }

  if (candidate.sidebarWidth !== undefined) {
    if (typeof candidate.sidebarWidth !== 'number' || !Number.isInteger(candidate.sidebarWidth)) {
      return { ok: false, error: 'invalid type: sidebarWidth must be an integer' }
    }
    if (candidate.sidebarWidth < 180 || candidate.sidebarWidth > 420) {
      return { ok: false, error: 'sidebarWidth выходит за пределы допустимых границ [180..420]' }
    }
    result.sidebarWidth = candidate.sidebarWidth
  }

  if (candidate.workPanelWidth !== undefined) {
    if (typeof candidate.workPanelWidth !== 'number' || !Number.isInteger(candidate.workPanelWidth)) {
      return { ok: false, error: 'invalid type: workPanelWidth must be an integer' }
    }
    if (candidate.workPanelWidth < 280 || candidate.workPanelWidth > 720) {
      return { ok: false, error: 'workPanelWidth выходит за пределы допустимых границ [280..720]' }
    }
    result.workPanelWidth = candidate.workPanelWidth
  }

  if (candidate.codeFontSize !== undefined) {
    if (typeof candidate.codeFontSize !== 'number' || !Number.isInteger(candidate.codeFontSize)) {
      return { ok: false, error: 'invalid type: codeFontSize must be an integer' }
    }
    if (candidate.codeFontSize < 10 || candidate.codeFontSize > 24) {
      return { ok: false, error: 'codeFontSize выходит за пределы допустимых границ [10..24]' }
    }
    result.codeFontSize = candidate.codeFontSize
  }

  if (candidate.fontUiSize !== undefined) {
    if (typeof candidate.fontUiSize !== 'number' || Number.isNaN(candidate.fontUiSize)) {
      return { ok: false, error: 'invalid type: fontUiSize must be a number' }
    }
    if (candidate.fontUiSize < 11 || candidate.fontUiSize > 18) {
      return { ok: false, error: 'fontUiSize выходит за пределы допустимых границ [11..18]' }
    }
    result.fontUiSize = candidate.fontUiSize
  }

  if (candidate.lineHeight !== undefined) {
    if (typeof candidate.lineHeight !== 'number' || Number.isNaN(candidate.lineHeight)) {
      return { ok: false, error: 'invalid type: lineHeight must be a number' }
    }
    if (candidate.lineHeight < 1.2 || candidate.lineHeight > 1.8) {
      return { ok: false, error: 'lineHeight выходит за пределы допустимых границ [1.2..1.8]' }
    }
    result.lineHeight = candidate.lineHeight
  }

  if (candidate.showSidebar !== undefined) {
    if (typeof candidate.showSidebar !== 'boolean') {
      return { ok: false, error: 'invalid type: showSidebar must be a boolean' }
    }
    result.showSidebar = candidate.showSidebar
  }

  if (candidate.showWorkPanel !== undefined) {
    if (typeof candidate.showWorkPanel !== 'boolean') {
      return { ok: false, error: 'invalid type: showWorkPanel must be a boolean' }
    }
    result.showWorkPanel = candidate.showWorkPanel
  }

  if (candidate.panelsOrder !== undefined) {
    if (!Array.isArray(candidate.panelsOrder)) {
      return { ok: false, error: 'invalid type: panelsOrder must be an array' }
    }
    const validPanels = new Set(['sidebar', 'chat', 'work'])
    if (
      candidate.panelsOrder.length !== 3 ||
      !candidate.panelsOrder.every(p => validPanels.has(p)) ||
      new Set(candidate.panelsOrder).size !== 3
    ) {
      return { ok: false, error: 'invalid panelsOrder: must contain unique ["sidebar", "chat", "work"]' }
    }
    result.panelsOrder = [...candidate.panelsOrder]
  }

  if (candidate.versionPreset !== undefined) {
    if (typeof candidate.versionPreset !== 'string' || !VERSION_PRESETS.includes(candidate.versionPreset)) {
      return { ok: false, error: `invalid versionPreset: ожидается одно из ${VERSION_PRESETS.join(' | ')}` }
    }
    result.versionPreset = candidate.versionPreset
  }

  return { ok: true, config: result }
}

function toCssVariables(config) {
  const c = { ...DEFAULT_UI_CONFIG, ...(config || {}) }
  const vars = {
    '--sidebar-width': `${c.sidebarWidth}px`,
    '--work-panel-width': `${c.workPanelWidth}px`,
    '--code-font-size': `${c.codeFontSize}px`,
    '--font-ui-size': `${c.fontUiSize}px`,
    '--line-height': `${c.lineHeight}`,
    '--sidebar-display': c.showSidebar ? 'flex' : 'none',
    '--work-panel-display': c.showWorkPanel ? 'flex' : 'none'
  }

  for (const [k, v] of Object.entries(vars)) {
    if (/[;{}"'<>]/i.test(v)) {
      throw new Error(`Dangerous CSS variable value for ${k}: ${v}`)
    }
  }

  return vars
}

function getFilePath(userDataPath) {
  return path.join(userDataPath, 'ui-config.json')
}

function load(userDataPath) {
  const filePath = getFilePath(userDataPath)
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      const res = validate(parsed)
      if (res.ok) {
        return res.config
      }
    }
  } catch (err) {
    // В случае сбоя чтения или повреждённого JSON возвращаем дефолты
  }
  return { ...DEFAULT_UI_CONFIG }
}

function save(userDataPath, config) {
  const res = validate(config)
  if (!res.ok) {
    return res
  }

  const filePath = getFilePath(userDataPath)
  const tmpPath = path.join(userDataPath, `ui-config.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`)

  try {
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(tmpPath, JSON.stringify(res.config, null, 2), 'utf8')
    try {
      fs.renameSync(tmpPath, filePath)
    } catch {
      fs.copyFileSync(tmpPath, filePath)
      try { fs.unlinkSync(tmpPath) } catch {}
    }
    return { ok: true, config: res.config }
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath) } catch {}
    return { ok: false, error: err.message }
  }
}

function reset(userDataPath) {
  const filePath = getFilePath(userDataPath)
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {}
  return { ok: true, config: { ...DEFAULT_UI_CONFIG } }
}

module.exports = {
  DEFAULT_UI_CONFIG,
  TASK_PRESETS,
  getTaskPreset,
  applyTaskPreset,
  validate,
  toCssVariables,
  load,
  save,
  reset
}
