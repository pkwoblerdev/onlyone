// A var() pointing at a token that was never declared does not error anywhere:
// the property is simply dropped and the rule quietly does nothing. Six hover
// and focus styles shipped dead that way before this check existed.
const fs = require('fs')
const path = require('path')

// Tokens moved into their own file, so the stylesheet the browser sees is the
// two of them concatenated. Reading only index.css would report every token as
// missing; reading only tokens.css would miss a rule that uses a name nobody
// declares.
const read = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', name), 'utf8')
const css = [read('tokens.css'), read('index.css')].join('\n')
const indexCss = read('index.css')

const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]))
const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map(m => m[1]))

// var(--x, fallback) survives a missing token, so those are not failures.
const withFallback = new Set(
  [...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,/g)].map(m => m[1])
)

const missing = [...used].filter(name => !declared.has(name) && !withFallback.has(name)).sort()

const iconRules = [
  ['.icon', /\.icon\s*\{[^}]*width:\s*var\(--ui-icon\)[^}]*height:\s*var\(--ui-icon\)[^}]*stroke-width:\s*var\(--ui-icon-stroke\)/s],
  ['.sb-icon-nav', /\.sb-icon-nav\s*\{[^}]*width:\s*var\(--ui-icon\)[^}]*height:\s*var\(--ui-icon\)[^}]*stroke-width:\s*var\(--ui-icon-stroke\)/s],
  ['.design-starter-thumb .icon', /\.design-starter-thumb \.icon\s*\{[^}]*width:\s*var\(--ui-icon-large\)[^}]*height:\s*var\(--ui-icon-large\)[^}]*stroke-width:\s*var\(--ui-icon-stroke\)/s],
  ['.pack-badge .icon', /\.pack-badge \.icon\s*\{[^}]*width:\s*var\(--ui-icon-large\)[^}]*height:\s*var\(--ui-icon-large\)[^}]*stroke-width:\s*var\(--ui-icon-stroke\)/s],
  ['.tasks-empty-icon .icon', /\.tasks-empty-icon \.icon\s*\{[^}]*width:\s*var\(--ui-icon-large\)[^}]*height:\s*var\(--ui-icon-large\)[^}]*stroke-width:\s*var\(--ui-icon-stroke\)/s],
]
const missingIconRules = iconRules.filter(([, pattern]) => !pattern.test(indexCss)).map(([selector]) => selector)
const iconSizeTokens = ['small', 'compact', 'large'].every(size => declared.has(`--ui-icon-${size}`)) && declared.has('--ui-icon') && declared.has('--ui-icon-stroke')

// In narrow panes the model label must yield before the fixed send button.
const composerRules = [
  ['.composer-bar', /\.composer-bar\s*\{[^}]*min-width:\s*0/s],
  ['.composer-actions-right', /\.composer-actions-right\s*\{[^}]*min-width:\s*0/s],
  ['.btn-model-pill', /\.btn-model-pill\s*\{[^}]*min-width:\s*0[^}]*flex:\s*0\s+1\s+220px/s],
  ['.btn-model-pill model label', /\.btn-model-pill #pillModelName,[\s\S]*?\{[^}]*flex:\s*1\s+1\s+auto[^}]*min-width:\s*0/s],
  ['.btn-send', /\.btn-send\s*\{[^}]*flex-shrink:\s*0/s],
]
const missingComposerRules = composerRules.filter(([, pattern]) => !pattern.test(indexCss)).map(([selector]) => selector)

const open = (css.match(/\{/g) || []).length
const close = (css.match(/\}/g) || []).length

for (const name of missing) console.error(`ПРОВАЛ: ${name} используется, но нигде не объявлена`)
if (open !== close) console.error(`ПРОВАЛ: скобки не сходятся — ${open} против ${close}`)
if (!iconSizeTokens) console.error('ПРОВАЛ: не объявлен полный набор токенов размера/толщины SVG-иконок')
for (const selector of missingIconRules) console.error(`ПРОВАЛ: ${selector} не использует общий токен SVG-иконок`)
for (const selector of missingComposerRules) console.error(`ПРОВАЛ: ${selector} не защищает узкую строку ввода от переполнения`)

const ok = missing.length === 0 && open === close && iconSizeTokens && missingIconRules.length === 0 && missingComposerRules.length === 0
console.log(JSON.stringify({ ok, declared: declared.size, used: used.size, missing: missing.length, iconSizeTokens, checkedIconRules: iconRules.length, missingIconRules: missingIconRules.length, checkedComposerRules: composerRules.length, missingComposerRules: missingComposerRules.length }))
process.exit(ok ? 0 : 1)
