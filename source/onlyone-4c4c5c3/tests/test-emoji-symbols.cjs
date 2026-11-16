// Contract and regression tests for Milestone 1.5: Emoji and symbols standardization.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const root = path.join(__dirname, '..', 'src', 'renderer');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const fontsCss = read('fonts.css');
const tokensCss = read('tokens.css');
const uiCss = read('ui-system.css');
const uiJs = read('ui-system.js');
const indexCss = read('index.css');
const appJs = read('app.js');
const indexHtml = read('index.html');

console.log('1. Checking Twemoji font asset and @font-face...');
const fontPath = path.join(root, 'fonts', 'twemoji.ttf');
assert(fs.existsSync(fontPath), 'Twemoji font file must exist at src/renderer/fonts/twemoji.ttf');
const fontStat = fs.statSync(fontPath);
assert(fontStat.size > 500000, 'Twemoji font file size is too small (expected > 500KB vector font)');
assert(/@font-face\s*\{[^}]*font-family:\s*['"]Twemoji['"][^}]*src:\s*url\(['"]fonts\/twemoji\.ttf['"]\)/s.test(fontsCss),
  'fonts.css must declare @font-face for Twemoji pointing to fonts/twemoji.ttf');

console.log('2. Checking design system tokens and font stacks...');
assert(/--font-emoji:\s*["']Twemoji["']/i.test(tokensCss), 'tokens.css must declare --font-emoji with Twemoji first');
assert(/--ui-size-emoji:\s*16px/i.test(tokensCss), 'tokens.css must declare --ui-size-emoji: 16px');
assert(/--font-ui:[^;]*var\(--font-emoji\)/.test(tokensCss) || /--font-ui:[^;]*"Twemoji"/.test(tokensCss),
  '--font-ui must include Twemoji in font stack');
// Since the mockup port --font-prose is an alias of --font-ui (one face everywhere).
assert(/--font-prose:[^;]*var\(--font-emoji\)/.test(tokensCss) || /--font-prose:[^;]*"Twemoji"/.test(tokensCss) ||
  /--font-prose:\s*var\(--font-ui\)/.test(tokensCss),
  '--font-prose must include Twemoji in font stack');

console.log('3. Checking .ui-emoji component in ui-system.css...');
assert(/\.ui-emoji\b/.test(uiCss), 'ui-system.css must contain .ui-emoji rule');
assert(/font-family:\s*var\(--font-emoji\)/.test(uiCss), '.ui-emoji must use var(--font-emoji)');
assert(/font-size:\s*var\(--ui-size-emoji\)/.test(uiCss), '.ui-emoji must use var(--ui-size-emoji)');
assert(/width:\s*var\(--ui-size-emoji\)/.test(uiCss), '.ui-emoji must define width: var(--ui-size-emoji)');
assert(/height:\s*var\(--ui-size-emoji\)/.test(uiCss), '.ui-emoji must define height: var(--ui-size-emoji)');

console.log('4. Checking formatWithEmoji helper in ui-system.js...');
assert(/function\s+formatWithEmoji\b/.test(uiJs), 'ui-system.js must define formatWithEmoji');
assert(/OnlyoneUI\s*=\s*Object\.freeze\(\{[^}]*formatWithEmoji/.test(uiJs), 'OnlyoneUI must export formatWithEmoji');

console.log('5. Checking service interface symbols in CSS and markup...');
// No literal glyphs in ::before / ::after pseudo-elements where SVG icons should be used
assert(!/\.agent-report-more\s*>\s*summary::before\s*\{[^}]*content:\s*['"][▸▾]['"]/s.test(indexCss),
  'agent-report-more summary::before must use SVG icon instead of text glyphs');
assert(!/\.wf-stage\.writes::after\s*\{[^}]*content:\s*['"]\s*✎['"]/s.test(indexCss),
  'wf-stage.writes::after must use SVG icon instead of text pencil glyph');
// Button controls in project chat rows must use SVG
assert(!/<button[^>]*class="btn-icon"[^>]*>→<\/button>/i.test(appJs),
  'app.js button controls must use SVG icons, not text arrow glyph');

console.log('6. Runtime emoji parsing is checked against the actual browser implementation by run-review-ui.cjs.');
