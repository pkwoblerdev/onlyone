// Полный отчёт о наборе проверок.
//
// `npm test` склеен через `&&`: упало сороковое звено — про остальные семдесят
// ничего не известно, а отчёт выглядит как «набор красный». Этот скрипт гоняет
// те же проверки по одной и в конце говорит, что прошло, что нет и сколько
// длилось. `npm test` остаётся прежним быстрым gate-ом, которым пользуется
// план; это инструмент аудита.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');
const MAIN = ['pretest', 'test', 'posttest'];
const TIMEOUT_MS = Number(process.env.ONECODE_SUITE_TIMEOUT || 300000);

// Три оконных звена не успевают в 300 с не потому, что плавают, а потому,
// что делают два-четыре окна подряд: замер полного прогона 30.09 (набор шёл
// 5377 с) — run-task-center-queue-ui 509.8 с,
// run-resume-secure-ui 427.4 с, run-provider-profiles-ui 399.7 с.
// Без собственного потолка они записываются
// «плавающими», а строгий режим (`ONECODE_SUITE_STRICT=1`) считает плавающее
// провалом — то есть приёмка краснеет из-за таймаута самого харнесса.
const LONG_TIMEOUT_MS = Number(process.env.ONECODE_SUITE_LONG_TIMEOUT || 600000);
const LONG_LINKS = new Set([
  'run-task-center-queue-ui.cjs',
  'run-resume-secure-ui.cjs',
  'run-provider-profiles-ui.cjs'
]);
const timeoutFor = file => (LONG_LINKS.has(file) ? LONG_TIMEOUT_MS : TIMEOUT_MS);

function linksOf(chain) {
  return (String(pkg.scripts[chain] || '').match(/tests[\\/][\w.\-]+\.cjs/g) || []).map(text => text.replace(/^tests[\\/]/, ''));
}

// Порядок цепочек сохраняется, повтор не прогонов дважды (был случай, когда
// одна проверка стояла в двух цепочках).
const plan = [];
const seen = new Set();
for (const chain of MAIN) {
  for (const file of linksOf(chain)) {
    if (seen.has(file)) continue;
    seen.add(file);
    plan.push({ chain, file });
  }
}

const only = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
const run = only.length ? plan.filter(item => only.some(arg => item.file.includes(arg))) : plan;

console.log(`Прогон набора: ${run.length} проверок, по одной на процесс.`);
const results = [];
const seconds = ms => (ms / 1000).toFixed(1) + ' с';

function attempt(file) {
  const started = Date.now();
  const child = spawnSync(process.execPath, [path.join('tests', file)], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutFor(file),
    windowsHide: true
  });
  const output = `${child.stdout || ''}${child.stderr || ''}`;
  const status = child.error ? (child.error.code === 'ETIMEDOUT' ? 'обрыв' : 'ошибка') : (child.status === 0 ? 'ok' : 'провал');
  return { ms: Date.now() - started, status, code: child.status, output };
}

for (const { chain, file } of run) {
  const first = attempt(file);
  // Одна пересъмка отделяет «красный набор» от «упало под нагрузкой»: оконные
  // прогоны живут с жёстким таймаутом и на загруженной машине не успевают.
  const second = first.status === 'ok' ? null : attempt(file);
  const result = { chain, file, ...first, retried: Boolean(second) };
  if (second) {
    // Первая попытка — не черновик второй: если она упала, её вывод и есть
    // ответ на вопрос «что плавающее и почему». Раньше он перезаписывался, и
    // «ok* со второй попытки» не оставлял чего читать.
    Object.assign(result, {
      firstMs: first.ms, firstStatus: first.status, firstOutput: first.output,
      ms: first.ms + second.ms, status: second.status, output: second.output
    })
  }
  results.push(result);
  const label = result.status === 'ok' ? (second ? 'ok*' : 'ok  ') : 'провал';
  console.log(`${label.padEnd(6)} ${file} — ${(result.ms / 1000).toFixed(1)} с` +
    (second ? ` (первая попытка ${seconds(first.ms)}: ${first.status})` : ''));
}

const bad = results.filter(item => item.status !== 'ok');
const flaky = results.filter(item => item.retried && item.status === 'ok');
const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);

console.log('');
console.log(`Итог: проверок ${results.length}, прошло ${results.length - bad.length}, не прошло ${bad.length}, время ${seconds(results.reduce((sum, item) => sum + item.ms, 0))}.`);
if (flaky.length) console.log(`Плавающих (прошли со второй попытки): ${flaky.length} — ${flaky.map(item => `${item.file} (первая ${seconds(item.firstMs)}: ${item.firstStatus})`).join(', ')}`);
console.log('Дольше всех: ' + slowest.map(item => `${item.file} ${seconds(item.ms)}`).join(', '));

// Плавающее звено — это не «прошло»: это проигранная один раз проверка. В
// строгом режиме (для приёмочного прогона) оно считается провалом, чтобы «код 0»
// нельзя было получить серией пересъёмок. Обычный режим остаётся как был:
// отчёт, а не gate.
for (const item of flaky) {
  console.log('');
  console.log(`--- ${item.file} (${item.chain}, плавающее: первая попытка ${item.firstStatus} за ${seconds(item.firstMs)}, вторая прошла) ---`);
  console.log((item.firstOutput || '').trim().split('\n').slice(-14).join('\n') || 'вывода первой попытки нет');
}

for (const item of bad) {
  console.log('');
  console.log(`--- ${item.file} (${item.chain}, ${item.status}, ${seconds(item.ms)}${item.retried ? ', и со второй попытки' : ''}) ---`);
  console.log(item.output.trim().split('\n').slice(-12).join('\n') || 'вывода нет');
}

const reportPath = process.env.ONECODE_SUITE_OUT;
if (reportPath) {
  fs.writeFileSync(reportPath, JSON.stringify({
    at: new Date().toISOString(),
    total: results.length,
    failed: bad.map(item => item.file),
    flaky: flaky.map(item => item.file),
    strict: process.env.ONECODE_SUITE_STRICT === '1',
    results: results.map(({ output, firstOutput, ...rest }) => rest)
  }, null, 2));
  console.log('');
  console.log('Отчёт: ' + reportPath);
}

// В строгом режиме плавающее звено поднимает ту же тревогу, что упавшее.
process.exitCode = (bad.length || (process.env.ONECODE_SUITE_STRICT === '1' && flaky.length)) ? 1 : 0;
