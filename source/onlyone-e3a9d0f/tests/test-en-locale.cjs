/**
 * Test contract for 2.6: English locale completeness and bilingual parity.
 * Verifies that:
 * 1. Dictionary is loaded and valid (>450 keys).
 * 2. TRANSLATABLE_ATTRS in app.js includes 'data-tooltip'.
 * 3. All Cyrillic text nodes in index.html have dictionary translations.
 * 4. All Cyrillic translatable attributes (data-tooltip, aria-label, placeholder, title) in index.html have translations.
 * 5. All static t('...') calls in app.js have dictionary translations.
 * 6. Dynamic toast & confirmation template interpolations succeed in t().
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('--- 1. Checking i18n.js dictionary loading ---');
const i18nPath = path.join(__dirname, '../src/renderer/i18n.js');
const i18nCode = fs.readFileSync(i18nPath, 'utf8');

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(i18nCode, sandbox);

const dict = sandbox.window.__I18N__?.en;
assert(dict, 'window.__I18N__.en must exist');
const keyCount = Object.keys(dict).length;
console.log(`  ok  English dictionary contains ${keyCount} translation keys`);
assert(keyCount >= 450, `Expected at least 450 keys, got ${keyCount}`);

console.log('--- 2. Checking TRANSLATABLE_ATTRS in app.js ---');
const appPath = path.join(__dirname, '../src/renderer/app.js');
const appCode = fs.readFileSync(appPath, 'utf8');

assert(
  /const\s+TRANSLATABLE_ATTRS\s*=\s*\[[^\]]*'data-tooltip'[^\]]*\]/.test(appCode),
  "TRANSLATABLE_ATTRS must include 'data-tooltip'"
);
console.log("  ok  TRANSLATABLE_ATTRS includes 'data-tooltip'");

console.log('--- 3. Checking static Cyrillic text in index.html ---');
const htmlPath = path.join(__dirname, '../src/renderer/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const cyrillicRegex = /[а-яёА-ЯЁ]/;
const missingHtmlTexts = [];

// Check text nodes outside scripts, styles and user-facing code blocks
const textNodeRegex = />([^<]+)</g;
let m;
while ((m = textNodeRegex.exec(html)) !== null) {
  const raw = m[1].replace(/\s+/g, ' ').trim();
  if (!raw || !cyrillicRegex.test(raw)) continue;
  // Ignore single characters or punctuation
  if (raw.length < 2) continue;
  if (!dict[raw]) {
    missingHtmlTexts.push(raw);
  }
}

if (missingHtmlTexts.length > 0) {
  console.error('Missing translations for HTML text nodes:', missingHtmlTexts);
}
assert.strictEqual(missingHtmlTexts.length, 0, `Found ${missingHtmlTexts.length} untranslated text nodes in index.html`);
console.log('  ok  zero untranslated Cyrillic text nodes in index.html');

console.log('--- 4. Checking translatable attributes in index.html ---');
const attrRegex = /(?:data-tooltip|aria-label|placeholder|title)=["']([^"']+)["']/g;
const missingAttrs = [];
while ((m = attrRegex.exec(html)) !== null) {
  const raw = m[1].replace(/\s+/g, ' ').trim();
  if (!raw || !cyrillicRegex.test(raw)) continue;
  // Strip shortcut from tooltip for lookup if present: "Новый диалог (Ctrl+N)" -> dict check
  const shortcutMatch = raw.match(/\(((?:Ctrl|Alt|Shift)\+[A-Za-z0-9,\.]+|Enter|Esc|Tab)\)$/i);
  const base = shortcutMatch ? raw.slice(0, shortcutMatch.index).trim() : raw;
  if (!dict[raw] && !dict[base]) {
    missingAttrs.push(raw);
  }
}

if (missingAttrs.length > 0) {
  console.error('Missing translations for HTML attributes:', missingAttrs);
}
assert.strictEqual(missingAttrs.length, 0, `Found ${missingAttrs.length} untranslated attributes in index.html`);
console.log('  ok  zero untranslated Cyrillic translatable attributes in index.html');

console.log('--- 5. Checking static t("...") calls in app.js ---');
const tRegex = /\bt\(\s*['"]([^'"]+)['"]\s*\)/g;
const missingTCalls = [];
while ((m = tRegex.exec(appCode)) !== null) {
  const raw = m[1].replace(/\s+/g, ' ').trim();
  if (!raw || !cyrillicRegex.test(raw)) continue;
  if (!dict[raw]) {
    missingTCalls.push(raw);
  }
}

if (missingTCalls.length > 0) {
  console.error('Missing translations for t() calls:', missingTCalls);
}
assert.strictEqual(missingTCalls.length, 0, `Found ${missingTCalls.length} untranslated t() calls in app.js`);
console.log('  ok  all static t() calls in app.js exist in English dictionary');

console.log('--- 6. Testing dynamic toast and confirmation pattern translation in app.js runtime ---');
// Extract t function from app.js into sandbox to test its behaviour
const tFuncMatch = appCode.match(/function\s+t\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
assert(tFuncMatch, 'Could not extract function t() from app.js');

const testSandbox = {
  window: sandbox.window,
  uiLang: 'en',
  DICT: () => sandbox.window.__I18N__['en']
};
vm.createContext(testSandbox);
vm.runInContext(tFuncMatch[0], testSandbox);

const tFn = testSandbox.t;
assert.strictEqual(tFn('Ответ скопирован'), 'Answer copied');
assert.strictEqual(tFn('Удалить это сообщение из диалога?'), 'Delete this message from chat?');
assert.strictEqual(tFn('Выбрана модель: GLM 5.3 Flash'), 'Selected model: GLM 5.3 Flash');
assert.strictEqual(tFn('Папка добавлена в чат: my-project'), 'Folder added to chat: my-project');
assert.strictEqual(tFn('Скилл «FastAPI Expert» удалён'), 'Skill “FastAPI Expert” deleted');
assert.strictEqual(tFn('Скилл «FastAPI Expert» включён'), 'Skill “FastAPI Expert” enabled');
assert.strictEqual(tFn('Ключ «Work» отключён'), 'Key “Work” disabled');
assert.strictEqual(tFn('Проект «Alpha» создан'), 'Project “Alpha” created');
assert.strictEqual(tFn('Проект «Alpha» удалён'), 'Project “Alpha” deleted');
assert.strictEqual(tFn('Дизайн «Landing» удалён'), 'Design “Landing” deleted');
assert.strictEqual(
  tFn('Удалить скилл «FastAPI Expert»? Он перестанет подмешиваться в системный контекст.'),
  'Delete skill “FastAPI Expert”? It will no longer be included in system context.'
);
assert.strictEqual(
  tFn('Отключить папку «my-folder» от всех чатов?'),
  'Remove folder “my-folder” from all chats?'
);
console.log('  ok  dynamic toast & confirmation pattern translations verified');

// Подстановки идут по порядку и на обоих языках: первый аргумент не должен
// заполнять все «%s», а русский — оставлять «%s» на экране.
assert.strictEqual(tFn('версия %s из %s', 1, 3), 'version 1 of 3');
const ruSandbox = { window: sandbox.window, uiLang: 'ru', DICT: () => sandbox.window.__I18N__['ru'] || null };
vm.createContext(ruSandbox);
vm.runInContext(tFuncMatch[0], ruSandbox);
assert.strictEqual(ruSandbox.t('версия %s из %s', 1, 3), 'версия 1 из 3');
assert.strictEqual(ruSandbox.t('{1} из {0}', 3, 1), '1 из 3');
console.log('  ok  placeholders filled in order, in Russian and English');

console.log('test-en-locale: ALL BILINGUAL PARITY CONTRACT CHECKS PASSED!');
