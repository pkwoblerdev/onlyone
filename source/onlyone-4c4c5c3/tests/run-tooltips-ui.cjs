// Real Electron window runner for milestone 1.4: custom tooltips.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs');

const root = path.join(__dirname, '..');
const output = runDir('1code-tooltips-ui');
const out = path.join(output, 'checks.json');
const shot = path.join(output, 'tooltip_screenshot.png');

const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(output, 'profile')], {
  cwd: root,
  timeout: 60000,
  stdio: 'inherit',
  env: guiEnv({
    ONECODE_SMOKE: path.join(__dirname, 'tooltips-smoke-renderer.js'),
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

if (fs.existsSync(shot)) {
  console.log('Снимок экрана подсказки сохранён в каталоге прогона:', shot);
} else {
  console.warn('Предупреждение: снимок экрана не был создан');
}

console.log(
  (report.ok ? 'Подсказки работают корректно' : 'Есть ошибки в работе подсказок') +
  ' — проверок ' + (report.checks || []).length +
  ', успешно ' + ((report.checks || []).length - failed.length)
);

settleRun(output, report.ok && child.status === 0)
process.exit(report.ok && child.status === 0 ? 0 : 1);
