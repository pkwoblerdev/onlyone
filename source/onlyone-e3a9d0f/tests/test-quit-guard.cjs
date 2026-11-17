// Выход при незаписанной истории. Проверяется настоящий quit-guard, а не
// пересказ: событие Electron здесь — объект с preventDefault.
const assert = require('node:assert/strict');
const { create } = require('../src/main/quit-guard');

const failures = [];
function test(name, fn) { try { fn(); console.log('ok', name) } catch (e) { failures.push(name + ': ' + e.message); console.error('FAIL', name, e.message) } }
const event = () => ({ prevented: 0, preventDefault() { this.prevented++ } });

test('несохранённое не уходит молча: закрытие отменено, человек спрошен', () => {
  const ev = event();
  let asked = null, quits = 0;
  const guard = create({
    save: () => { throw new Error('диск занят') },
    ask: error => { asked = error.message; return false },
    quit: () => { quits++ }
  });
  guard(ev);
  assert.equal(asked, 'диск занят');
  assert.equal(ev.prevented, 1);
  assert.equal(quits, 1, 'выход перезапущен после ответа');
});

test('согласие выйти без сохранения задаётся один раз', () => {
  const first = event(), second = event();
  let asks = 0, saves = 0;
  const guard = create({
    save: () => { saves++; throw new Error('нет места') },
    ask: () => { asks++; return true },
    quit: () => {}
  });
  guard(first);
  guard(second);
  assert.equal(saves, 1);
  assert.equal(asks, 1, 'второй проход не дергает человека');
  assert.equal(second.prevented, 0, 'согласившись, выходит');
});

test('после «попробовать ещё раз» сохранение повторяется', () => {
  const first = event(), second = event();
  let attempt = 0, saved = 0, quits = 0;
  const guard = create({
    save: () => { attempt++; if (attempt === 1) throw new Error('занято'); saved++ },
    ask: () => false,
    quit: () => { quits++ }
  });
  guard(first);
  guard(second);
  assert.equal(saved, 1);
  assert.equal(second.prevented, 0);
  assert.equal(quits, 1);
});

test('обычный выход не показывает окно', () => {
  const ev = event();
  let asks = 0, quits = 0;
  const guard = create({ save: () => {}, ask: () => { asks++; return true }, quit: () => { quits++ } });
  guard(ev);
  assert.equal(asks, 0);
  assert.equal(quits, 0);
  assert.equal(ev.prevented, 0);
});

if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
