// Contract for the new component family only. Legacy index.css migration is 1.3.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.join(__dirname, '..', 'src', 'renderer');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const tokens = read('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
const cssFiles = ['ui-system.css', 'ui-catalog.css'];
const errors = [];
function lint(css) {
  const findings = [];
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, property, value] of css.matchAll(/(?:^|[;{])\s*([\w-]+)\s*:\s*([^;{}]+)/g)) {
    if (/#(?:[\da-z]+)|\brgba?\(|\bhsla?\(/i.test(value)) findings.push(property + ': literal colour');
    if (/-?\d*\.?\d+(?:px|rem|em|ms|s)\b/.test(value)) findings.push(property + ': literal dimension');
    if (/^(?:color|background-color|border-color|outline-color|fill|stroke)$/.test(property) &&
      !/^(?:var\(|transparent\b|currentColor\b|inherit\b|none\b)/.test(value.trim())) findings.push(property + ': non-token colour');
  }
  return findings;
}
for (const file of cssFiles) errors.push(...lint(read(file)).map(e => file + ': ' + e));
// Prove the guard fails on the regressions it claims to prevent.
assert(lint('.button { color: #abcdef; font-size: 15px; }').length >= 2);
assert(lint('.button { color: red; }').length > 0);
assert(lint('.button { padding: var(--ui-space-2); color: var(--text); }').length === 0);
for (const match of tokens.matchAll(/#[\da-z]+/gi)) {
  if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(match[0])) errors.push('invalid colour: ' + match[0]);
}
const declared = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
for (const file of cssFiles) for (const [, name] of read(file).matchAll(/var\((--[\w-]+)/g)) if (!declared.has(name)) errors.push('undefined ' + name);
const html = read('ui-catalog.html');
assert(!/\stitle=|\sstyle=/.test(html), 'no native tooltips or inline visual overrides');
for (const state of ['hover', 'focus', 'pressed']) assert(html.includes('data-state="' + state + '"'));
for (const component of ['button','input','select','tooltip','switch','tabs','card','chip','dialog','notice','empty']) assert(html.includes('ui-' + component), component);
assert(read('ui-system.css').includes('prefers-reduced-motion'));
assert(!/eval\(|electronAPI|fetch\(/.test(read('ui-system.js')), 'UI primitives have no privileged side effects');
assert.deepEqual(errors, []);
console.log('UI system: token contract, all components, states and lint mutation checks passed');
