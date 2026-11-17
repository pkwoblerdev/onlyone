// Н91: сверка окончаний строк (--numstat против --ignore-cr-at-eol) в pretest.
//
// Если файл сохранён с чужими окончаниями строк (например, CRLF вместо LF или наоборот),
// `git diff --numstat` покажет все строки файла как изменённые (например, +500/-500),
// тогда как `--ignore-cr-at-eol` покажет только реальные содержательные правки (+2/-1).
//
// База сравнения — общий resolver tests/eol-baseline.cjs (release/*-build,
// ONECODE_EOL_BASE, tests/eol-base.json, иначе корневой коммит). Если база
// объявлена, но недействительна, или git не отвечает, проверка падает: молчаливого
// пропуска git-части больше нет.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { RAW, resolveBaseline, isVerified, describeBaseline, failureText } = require('./eol-baseline.cjs');

let failed = 0;
const problems = [];
// ok — значение или функция: функции выполняются здесь же, чтобы модульная
// самопроверка не могла «пройти» как невызванный объект.
function check(name, okOrFn, detail) {
  let ok = okOrFn;
  let error = '';
  if (typeof okOrFn === 'function') {
    try { ok = okOrFn() !== false; } catch (err) { ok = false; error = err.message; }
  }
  if (!ok) {
    failed++;
    const text = error || detail;
    problems.push(text ? `${name}: ${text}` : name);
    console.error(`ПРОВАЛ [${name}]${text ? ': ' + text : ''}`);
  } else {
    console.log('ok', name);
  }
}

function parseNumstat(output) {
  const map = new Map();
  const lines = (output || '').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const added = parts[0].trim();
      const deleted = parts[1].trim();
      const file = parts.slice(2).join('\t').trim();
      map.set(file, { added, deleted });
    }
  }
  return map;
}

function compareNumstat(rawOutput, eolOutput, contextLabel) {
  const rawMap = parseNumstat(rawOutput);
  const eolMap = parseNumstat(eolOutput);
  const diffs = [];

  for (const [file, raw] of rawMap) {
    const eol = eolMap.get(file);
    if (!eol) {
      diffs.push(`${file} (отсутствует в ignore-cr-at-eol)`);
      continue;
    }
    // Бинарные файлы показывают '-' в numstat
    if (raw.added === '-' || eol.added === '-') continue;
    if (raw.added !== eol.added || raw.deleted !== eol.deleted) {
      diffs.push(
        `${file} [numstat: +${raw.added}/-${raw.deleted} vs ignore-cr-at-eol: +${eol.added}/-${eol.deleted}]`
      );
    }
  }
  return diffs;
}

// 1. Модульные тесты алгоритма сверки
check('алгоритм сверки: идентичные показатели diff проходят чисто', () => {
  const raw = '10\t5\tsrc/file.js\n1\t0\tpackage.json';
  const eol = '10\t5\tsrc/file.js\n1\t0\tpackage.json';
  const diffs = compareNumstat(raw, eol, 'unit-pass');
  assert.equal(diffs.length, 0);
  return true;
});

check('алгоритм сверки: расхождение из-за CRLF детектируется', () => {
  const raw = '500\t500\tsrc/file.js\n1\t0\tpackage.json';
  const eol = '2\t1\tsrc/file.js\n1\t0\tpackage.json';
  const diffs = compareNumstat(raw, eol, 'unit-fail');
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /src\/file\.js/);
  return true;
});

// 2. Реальная проверка текущего репозитория через git.
// База та же, что у test-line-ending-churn (общий resolver). Архив без .git —
// не «ok», а verified:false; недействительная база и отказ git — провал.
const repoRoot = path.resolve(__dirname, '..');
const baseline = resolveBaseline(repoRoot);

function git(args) {
  try {
    return execFileSync('git', [...RAW, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

function diffsIn(diffArgs, label) {
  const raw = git(['diff', ...diffArgs, '--numstat']);
  const eol = git(['diff', ...diffArgs, '--numstat', '--ignore-cr-at-eol']);
  if (raw === null || eol === null) return null;
  return compareNumstat(raw, eol, label);
}

function report(name, label, diffArgs) {
  const diffs = diffsIn(diffArgs, label);
  check(name, diffs !== null && diffs.length === 0,
    diffs === null ? 'git diff не выполнился — окончания не проверены' : diffs.join(', '));
}

if (baseline.mode === 'archive') {
  console.error('archive: history not verified — .git нет: проверены только модульные тесты алгоритма');
} else if (baseline.mode === 'no-base' || baseline.mode === 'invalid') {
  check('есть действительная база для проверки окончаний', false, failureText(baseline));
} else {
  report('нет расхождений CRLF в незакоммиченных изменениях (working tree)', 'unstaged', []);
  report('нет расхождений CRLF в подготовленных к коммиту изменениях (staged)', 'staged', ['--cached']);
  report(`нет расхождений CRLF в коммитах от ${describeBaseline(baseline)}`, 'committed',
    [`${baseline.base}..HEAD`]);
}

console.log(JSON.stringify({ ok: failed === 0, verified: isVerified(baseline), base: baseline, failed, problems }));
process.exit(failed ? 1 : 0);
