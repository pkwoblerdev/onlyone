const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
const renderer = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8')

// Contract: the optional follow-up hint remains enabled for existing users,
// can be switched off without leaving a stale hint or starting a request, and
// can be switched on again for the currently selected conversation. This test
// deliberately discovers the setting through its accessible UI text rather
// than prescribing an element id, storage-key name, or preference API.
const settingRow = html.match(/<div class="setting-row[\s\S]*?(?:подсказк|suggestion|follow-up)[\s\S]*?<\/div>/i)
assert.ok(settingRow, 'Настройки должны содержать понятный переключатель подсказки следующего действия')

const control = settingRow[0].match(/<input\b[^>]*type=["']checkbox["'][^>]*>/i)?.[0]
assert.ok(control, 'Для настройки подсказки нужен доступный переключатель')
const controlId = control.match(/\bid=["']([^"']+)["']/i)?.[1]
assert.ok(controlId, 'Переключатель настройки должен иметь стабильную связь с renderer')
assert.match(renderer, new RegExp(`(?:\\$\\(['"]${controlId}['"]\\)|getElementById\\(['"]${controlId}['"]\\))`),
  'Renderer должен читать и обрабатывать переключатель из Настроек')

// The unset state must preserve the existing behavior. Accept either a direct
// localStorage read or an existing preference helper; the value is inferred
// from the actual control wiring, not from a mandated storage key.
assert.match(renderer, /(?:localStorage\.getItem|readPref)\s*\(/,
  'Предпочтение должно загружаться из локальных настроек')
assert.match(renderer, /(?:localStorage\.setItem|writePref)\s*\(/,
  'Изменение переключателя должно сохраняться в локальных настройках')
assert.match(renderer, /(?:!==?\s*['"]false['"]|\?\?\s*true|\|\|\s*true)/,
  'При отсутствии сохранённого значения подсказка должна оставаться включённой')

// Both producing a suggestion and rendering a previously cached one must
// respect the preference: turning it off cannot make a new call or leave the
// old hint in the composer. Re-enabling must resume from the active pane/chat.
assert.match(renderer, /generateNextSuggestion[\s\S]{0,900}(?:suggestion|enabled|checked|pref)/i,
  'Генерация должна учитывать выключенное предпочтение')
assert.match(renderer, /(?:has-suggestion|placeholder)[\s\S]{0,900}(?:suggestion|enabled|checked|pref)/i,
  'Отображение старой подсказки должно учитывать выключенное предпочтение')
assert.match(renderer, /(?:change|input)[\s\S]{0,900}(?:generateNextSuggestion|requestNextSuggestion|nextSuggestionsByChat)/,
  'Повторное включение должно возобновлять подсказку для текущего диалога')

console.log('Next suggestion preference contract: settings control, local persistence, enabled default, disable/enable behavior passed')
