// Набор проверок живёт, пока его путь дописан в package.json: глоб-раннера нет.
// Так девять файлов провисели вне прогона — одни зелёные, другие и не запускались.
// Эта проверка не даёт набору снова разъехаться с каталогом tests/.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');

const MAIN_CHAINS = ['pretest', 'test', 'posttest'];
// Проверки, которым нужен интернет или ключ: в общий прогон они не входят,
// иначе «код 0» невозможно получить офлайн и непонятно, что упало — приложение
// или чужой сервис.
const NEEDS_NETWORK = new Map([
  ['test-openrouter-catalog.cjs', 'каталог OpenRouter: отдельный скрипт test:catalog']
]);
// Сценарий замера дизайна, а не регрессия: запускается руками по запросу.
const MANUAL = new Map([
  ['design-audit/run-audit.cjs', 'повторный замер расхождений дизайна']
]);

function namesIn(script) {
  return (String(script || '').match(/tests[\\/]([\w.\-]+\.cjs)/g) || []).map(text => text.split(/[\\/]/).pop());
}

const failures = [];
function test(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

const files = fs.readdirSync(__dirname).filter(name => /^(test|run)-.*\.cjs$/.test(name));
const wired = new Set(Object.values(pkg.scripts).flatMap(namesIn));

test(`каждая из ${files.length} проверок вписана в какой-нибудь прогон`, () => {
  const orphans = files.filter(name => !wired.has(name) && !MANUAL.has(name));
  assert.deepEqual(orphans, [], 'файлы есть, но ни один скрипт их не зовёт');
});

test('общий прогон не зависит от сети', () => {
  const main = new Set(MAIN_CHAINS.flatMap(chain => namesIn(pkg.scripts[chain])));
  const offline = [...NEEDS_NETWORK.keys()].filter(name => main.has(name));
  assert.deepEqual(offline, [], 'без сети npm test упадёт не по вине приложения');
});

test('исключения из прогона не протухают: файл существует и причина указана', () => {
  for (const [name, why] of [...NEEDS_NETWORK, ...MANUAL]) {
    assert.ok(why.length > 8, `${name}: причина исключения не описана`);
    assert.ok(fs.existsSync(path.join(__dirname, name)), `${name}: в списке исключений, а файла нет`);
    assert.equal(wired.has(name) && MAIN_CHAINS.flatMap(c => namesIn(pkg.scripts[c])).includes(name), false,
      `${name}: заявлен вне прогона, но стоит в общей цепочке`);
  }
});

test('в общем прогоне каждая проверка звучит один раз', () => {
  const seen = new Map();
  for (const chain of MAIN_CHAINS) {
    for (const name of namesIn(pkg.scripts[chain])) {
      assert.equal(seen.has(name), false, `${name} уже идёт в «${seen.get(name)}», не повторять в «${chain}»`);
      seen.set(name, chain);
    }
  }
});

test('оконные проверки не пишут снимки в чужой профиль', () => {
  const runners = files.filter(name => /^run-.*\.cjs$/.test(name));
  const external = runners.filter(name => fs.readFileSync(path.join(__dirname, name), 'utf8').includes('antigravity'));
  assert.deepEqual(external, [], 'снимки должны оставаться в каталоге своего прогона');
});

test('оконные UI-прогоны одинаково запускают изолированный Electron', () => {
  const runners = files.filter(name => /^run-.*ui\.cjs$/.test(name));
  const missing = runners.filter(name => {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    return !source.includes('--no-sandbox') || !source.includes('--disable-gpu-sandbox');
  });
  assert.deepEqual(missing, [], 'оконные проверки без test-only GPU-флагов');
});

// cmd.exe обрывает строку длиннее 8191 символа: npm test падал с «Слишком длинная
// командная строка», не запустив ни одной проверки (цепочка test доросла до 9954).
// Порог с запасом на обёртку `cmd /d /s /c "…"`. Лечение — подцепочка `npm run test:…`.
test('цепочки прогонов короче лимита командной строки cmd.exe', () => {
  const long = Object.entries(pkg.scripts)
    .filter(([, script]) => typeof script === 'string' && script.length > 8100)
    .map(([name, script]) => `${name}: ${script.length}`);
  assert.deepEqual(long, [], 'вынеси часть проверок в подцепочку, иначе Windows оборвёт прогон молча');
});

if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
