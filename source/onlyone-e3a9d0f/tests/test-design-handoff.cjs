'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.css'), 'utf8')
// Код окна разложен по модулям (план, 2d): проверяем весь исполняемый текст.
const app = require('./renderer-code.cjs').rendererCode(root)

assert.match(html, /class="composer-col"[\s\S]*id="scrollDownBtn"[\s\S]*class="composer-card"/)
assert.match(css, /\.composer-col\s*\{[^}]*max-width:\s*800px/s)
assert.match(css, /\.feed-container\s*\{[^}]*max-width:\s*800px/s)
// The pill carries the permission mode, and «Manual» is where a fresh profile
// starts. The handoff draws a six-item popover of presets here — Solo,
// Lead, Council and the rest — and the owner ruled those out twice: one way of
// working, and the mode that decides what a turn may touch is the one worth a
// place in the composer.
// The pill carries the permission mode, and «Manual» is where a fresh profile
// starts. There is one way of working — one Agent — and the choice worth a place
// in the composer is what a turn is allowed to touch.
assert.match(html, /id="permModeLabel">Manual</)
assert.match(html, /id="permModeMenu"/, 'the pill opens a list of permission modes')

assert.doesNotMatch(app, /WORKFLOW_PRESETS|workflowPreset/,
  'workflow presets were removed; one way of working')
const modeSource = app.slice(app.indexOf('const PERMISSION_MODES'), app.indexOf('function setupEventListeners'))
assert.match(modeSource, /const PERMISSION_MODES = \['plan', 'manual', 'acceptEdits', 'auto'\]/)
assert.match(modeSource, /permModeLabel\.textContent = PERMISSION_LABELS\[mode\]/)
for (const label of ['Plan', 'Manual', 'Accept Edits', 'Auto']) {
  assert.ok(modeSource.includes(`'${label}'`), `the pill offers ${label}`)
}
assert.match(html, /id="workspacePermissionSelect"/, 'permissions remain separate from Agent mode')

const actions = app.slice(app.indexOf('function messageActionsHtml'), app.indexOf('function bindMessageActions'))
assert.deepStrictEqual([...actions.matchAll(/data-act="([^"]+)"/g)].map(match => match[1]), ['copy', 'retry'])
// Остановка хода — одна, в строке ввода. Вторая кнопка в строке состояния
// ответа убрана: три места с одним смыслом никто не читает как одно.
assert.match(app, /btn\.classList\.toggle\('is-stop', stopping\)/)
assert.doesNotMatch(app, /class="stream-status"/)
// Отправка того же роста, что соседи по строке ввода: при 34 px против 30 она
// выпирала. С переводом на дизайн-систему (1.3) все берут одну высоту — токен.
assert.match(css, /\.btn-send\s*\{[^}]*width:\s*var\(--ui-control-md\)[^}]*height:\s*var\(--ui-control-md\)[^}]*flex-shrink:\s*0/s)
assert.match(css, /\.btn-bar\s*\{[^}]*height:\s*var\(--ui-control-md\)/s)
// Один шрифт на всё приложение (1.14, часть 5): строка ввода набрана стеком интерфейса.
assert.match(css, /\.composer-textarea\s*\{[^}]*font-family:\s*var\(--font-(?:ui|prose)\)[^}]*font-size:\s*15px/s)

assert.match(css, /\.page-container\s*\{[^}]*max-width:\s*1000px[^}]*padding:\s*44px 40px 40px/s)
assert.match(css, /\.project-cards\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s)
assert.match(css, /\.modal-settings\s*\{[^}]*max-width:\s*940px[^}]*640px/s)
// Счётчики MCP — шрифт интерфейса, крупный размер шкалы (1.3), цифры одной ширины.
assert.match(css, /\.strip-value\s*\{[^}]*font-family:\s*var\(--font-ui\)[^}]*font-size:\s*var\(--ui-size-section\)[^}]*tabular-nums/s)

console.log('design handoff checks passed')
