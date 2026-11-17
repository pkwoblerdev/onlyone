// Real Electron window runner for milestone 1.6: motion and reduced-motion.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs');

const root = path.join(__dirname, '..');
const output = runDir('1code-motion-ui');
const out = path.join(output, 'checks.json');
const shot = path.join(output, 'motion_reduced_screenshot.png');

const child = spawnSync(electronBinary(), [path.join(__dirname, 'motion-main.cjs'), '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(output, 'profile')], {
  cwd: root,
  timeout: 60000,
  stdio: 'inherit',
  env: guiEnv({
    ONECODE_SMOKE: path.join(__dirname, 'motion-smoke-renderer.js'),
    ONECODE_SMOKE_OUT: out,
    ONECODE_SHOT: shot
  })
});

if (child.error) throw child.error;
if (!fs.existsSync(out)) {
  console.error('Окно не отчиталось: файл результатов не найден');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(out, 'utf8'));
const failed = (report.checks || []).filter(c => !c.pass);

for (const c of report.checks || []) {
  console.log((c.pass ? '  ok  ' : 'ПРОВАЛ') + ' ' + c.name + (c.detail ? ' — ' + c.detail : ''));
}

if (!fs.existsSync(shot)) throw new Error('Missing motion screenshot');
console.log('Снимок:', shot);

console.log(
  (report.ok ? 'Система движения интерфейса и reduced-motion работают безупречно' : 'Есть ошибки в работе анимаций интерфейса') +
  ' — проверок ' + (report.checks || []).length +
  ', успешно ' + ((report.checks || []).length - failed.length)
);

settleRun(output, report.ok && child.status === 0)
process.exit(report.ok && child.status === 0 ? 0 : 1);
