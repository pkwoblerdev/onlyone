// Contract tests for UI Motion and Animation system (Milestone 1.6)
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const root = path.join(__dirname, '..', 'src', 'renderer');
const indexCss = fs.readFileSync(path.join(root, 'index.css'), 'utf8');
const uiSystemCss = fs.readFileSync(path.join(root, 'ui-system.css'), 'utf8');
const tokensCss = fs.readFileSync(path.join(root, 'tokens.css'), 'utf8');

console.log('1. Checking @keyframes declarations and usages...');

// Parse all @keyframes in index.css
const kfMatches = [...indexCss.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)];
const kfNames = kfMatches.map(m => m[1]);

// Check uniqueness of keyframes
const nameCounts = new Map();
for (const name of kfNames) {
  nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
}
const duplicates = [...nameCounts.entries()].filter(([, cnt]) => cnt > 1);
assert.equal(duplicates.length, 0, `Duplicate keyframes found: ${JSON.stringify(duplicates)}`);

// Check that every declared keyframe is actually referenced
const lines = indexCss.splitlines ? indexCss.splitlines() : indexCss.split('\n');
const unreferenced = [];
for (const name of nameCounts.keys()) {
  const isUsed = lines.some(l => new RegExp(`\\banimation\\s*:[^;]*\\b${name}\\b`).test(l));
  if (!isUsed) unreferenced.push(name);
}
assert.equal(unreferenced.length, 0, `Unreferenced / dead keyframes found: ${JSON.stringify(unreferenced)}`);

console.log('2. Checking animation: calls validity (no broken animation references)...');
// Ensure all animation: properties refer to valid keyframes or built-ins
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const m = line.match(/\banimation\s*:\s*([^;!]+)/);
  if (m) {
    const val = m[1].trim();
    if (val === 'none') continue;
    const tokens = val.split(/\s+/).map(t => t.replace(/var\(--[^)]+\)/g, '').trim()).filter(Boolean);
    const hasValidKeyframe = tokens.some(t => nameCounts.has(t) || ['none', 'inherit', 'initial'].includes(t));
    assert(hasValidKeyframe, `Line ${i + 1} has broken animation reference: ${line.trim()}`);
  }
}

console.log('3. Checking GPU composite property rules (no layout transitions)...');
// Forbidden layout properties in transitions (skip progressBar width which is a pure meter gauge)
const forbiddenLayoutProps = ['top', 'bottom', 'left', 'right', 'margin', 'padding'];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('transition:') || line.includes('transition :')) {
    for (const prop of forbiddenLayoutProps) {
      const hasBadProp = new RegExp(`\\b${prop}\\b`).test(line);
      assert(!hasBadProp, `Line ${i + 1} animates layout property '${prop}': ${line.trim()}`);
    }
  }
}

console.log('4. Checking that excessive scale jumps (>1.05) are eliminated on service UI...');
// Check body of keyframes in index.css
const kfBodyRegex = /@keyframes\s+([\w-]+)\s*\{([^}]+(?:\{[^}]+\}[^}]*)*)\}/g;
let match;
while ((match = kfBodyRegex.exec(indexCss)) !== null) {
  const name = match[1];
  const body = match[2];
  const scaleMatches = [...body.matchAll(/scale\(\s*([0-9.]+)\s*\)/g)];
  for (const [, scaleVal] of scaleMatches) {
    const s = parseFloat(scaleVal);
    // Allow subtle scale down (press response >= 0.95), but forbid huge balloons (> 1.05) on service icons
    assert(s <= 1.05, `Keyframe '${name}' has excessive scale jump ${s} > 1.05: ${body.trim()}`);
  }
}

console.log('5. Checking prefers-reduced-motion contract in index.css and ui-system.css...');
assert(indexCss.includes('prefers-reduced-motion: reduce'), 'index.css must support prefers-reduced-motion');
assert(uiSystemCss.includes('prefers-reduced-motion: reduce'), 'ui-system.css must support prefers-reduced-motion');

// In index.css, reduced motion must force transform: none and zero/minimal durations
assert(indexCss.includes('animation-duration: 0.01ms !important'), 'reduced-motion sets near-zero animation duration');
assert(indexCss.includes('transition-duration: 0.01ms !important'), 'reduced-motion sets near-zero transition duration');
assert(indexCss.includes('transform: none !important'), 'reduced-motion disables transform shifts');

console.log('test-motion: ALL MOTION CONTRACT CHECKS PASSED (5/5)');
