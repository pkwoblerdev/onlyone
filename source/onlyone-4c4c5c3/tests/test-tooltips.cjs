// Tests for milestone 1.4: Native Windows title tooltips replacement with onlyone design system tooltips.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const uiSystemJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'ui-system.js'), 'utf8');
const uiSystemCss = fs.readFileSync(path.join(root, 'src', 'renderer', 'ui-system.css'), 'utf8');

console.log('--- 1. Static HTML Title Check ---');
// 1. In index.html, no interactive element may have a title attribute.
// Allowed: <title> document tag and <iframe ... title="..."> for accessibility.
const htmlLines = indexHtml.split('\n');
const forbiddenHtmlTitles = [];
htmlLines.forEach((line, idx) => {
  const lineNum = idx + 1;
  // Match title="...", ignoring <title> and <iframe ... title="..."
  if (/(?:^|\s)title\s*=/i.test(line)) {
    if (!/<title\b/i.test(line) && !/<iframe\b[^>]*title=/i.test(line)) {
      forbiddenHtmlTitles.push({ lineNum, line: line.trim() });
    }
  }
});
assert.deepEqual(forbiddenHtmlTitles, [], `Found forbidden title attributes in index.html: ${JSON.stringify(forbiddenHtmlTitles)}`);
console.log('  ok  index.html contains zero native title attributes on interactive elements');

console.log('--- 2. Static HTML data-tooltip Check ---');
// Verify primary interactive elements possess data-tooltip
const requiredTooltips = [
  '#winMinBtn', '#winMaxBtn', '#winCloseBtn',
  '#sidebarToggle', '#newChatBtn', '#openSettingsBtn',
  '#chatHeaderTitle', '#splitViewBtn', '#clearChatBtn',
  '#scrollDownBtn', '#attachBtn', '#permModeBtn',
  '#effortPillBtn', '#modelEffortPillBtn', '#sendBtn'
];
for (const selector of requiredTooltips) {
  const id = selector.slice(1);
  const regex = new RegExp(`<[^>]*id="${id}"[^>]*data-tooltip=`, 'i');
  assert(regex.test(indexHtml), `Element ${selector} in index.html must have data-tooltip`);
}
console.log('  ok  all primary interactive controls in index.html have data-tooltip');

console.log('--- 3. Static app.js DOM Title Check ---');
// In app.js, no DOM element may be assigned .title = ... or have title="..." in markup.
// Data model assignments (chat.title, target.title, stage.title) and function parameters are allowed.
const appLines = appJs.split('\n');
const forbiddenAppTitles = [];
appLines.forEach((line, idx) => {
  const lineNum = idx + 1;
  const trimmed = line.trim();
  if (/\btitle\s*=\s*["'`]/i.test(line)) {
    // Check if this is inside a function signature like pushBlock(..., title = '', ...)
    if (!/function\s+\w+\([^)]*title\s*=/i.test(line)) {
      forbiddenAppTitles.push({ lineNum, line: trimmed });
    }
  } else if (/\.title\s*=/i.test(line)) {
    // Allowed data properties: chat.title, target.title, stage.title
    if (!/\b(chat|target|stage)\.title\s*=/i.test(line)) {
      forbiddenAppTitles.push({ lineNum, line: trimmed });
    }
  } else if (/setAttribute\s*\(\s*['"]title['"]/i.test(line)) {
    forbiddenAppTitles.push({ lineNum, line: trimmed });
  }
});
assert.deepEqual(forbiddenAppTitles, [], `Found forbidden title assignments in app.js: ${JSON.stringify(forbiddenAppTitles)}`);
console.log('  ok  app.js contains zero native DOM title assignments');

console.log('--- 4. UI System Tooltip Primitives Check ---');
// Check ui-system.css contains .ui-tooltip, .is-visible, .ui-tooltip-kbd and prefers-reduced-motion
assert(uiSystemCss.includes('.ui-tooltip'), 'ui-system.css must define .ui-tooltip');
assert(uiSystemCss.includes('.ui-tooltip.is-visible'), 'ui-system.css must define .ui-tooltip.is-visible');
assert(uiSystemCss.includes('.ui-tooltip-kbd'), 'ui-system.css must define .ui-tooltip-kbd');
assert(uiSystemJs.includes('initGlobalTooltips'), 'ui-system.js must implement initGlobalTooltips');
assert(uiSystemJs.includes('onlyone-global-tooltip'), 'ui-system.js must manage onlyone-global-tooltip container');
console.log('  ok  ui-system css & js implement global tooltip primitives and shortcut chip styles');

console.log('--- 5. All Tooltip Unit & Contract Tests Passed! ---');
