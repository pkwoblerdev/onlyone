'use strict'
// Поиск участка в файле не должен быть квадратичным: на однородном файле
// (логи, CSV, генераты) перебор всех позиций вешал главный процесс.
const assert = require('node:assert/strict')
const { findSequence, reverseFragment } = require('../src/main/review-sections.cjs')

function naive (lines, sequence) {
  const hits = []
  if (!sequence.length) return hits
  for (let i = 0; i + sequence.length <= lines.length; i++) {
    let same = true
    for (let j = 0; j < sequence.length; j++) {
      if (lines[i + j] !== sequence[j]) { same = false; break }
    }
    if (same) hits.push(i)
  }
  return hits
}

// --- совпадение с прежним поведением на случайных файлах --------------------
let seed = 20261031
const random = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return (seed >>> 0) / 0x100000000
}
for (let round = 0; round < 500; round++) {
  const lines = Array.from({ length: Math.floor(random() * 12) }, () => ['', 'a', 'b', 'ab'][Math.floor(random() * 4)])
  const sequence = Array.from({ length: Math.floor(random() * 5) }, () => ['', 'a', 'b', 'ab'][Math.floor(random() * 4)])
  assert.deepEqual(findSequence(lines, sequence), naive(lines, sequence),
    `round ${round}: ${JSON.stringify(lines)} / ${JSON.stringify(sequence)}`)
}

// --- границы -----------------------------------------------------------------
assert.deepEqual(findSequence([], ['a']), [])
assert.deepEqual(findSequence(['a'], []), [])
assert.deepEqual(findSequence(['a'], ['a', 'b']), [])
assert.deepEqual(findSequence(['a', 'a', 'a'], ['a']), [0, 1, 2])
assert.deepEqual(findSequence(['', '', ''], ['', '']), [0, 1], 'empty lines are still lines')

// --- однородный файл: 20 000 строк, участок 100 строк -----------------------
const uniform = Array.from({ length: 20000 }, () => 'line')
const block = Array.from({ length: 100 }, () => 'line')
const started = Date.now()
const hits = findSequence(uniform, block)
const elapsed = Date.now() - started
assert.equal(hits.length, 20000 - 100 + 1)
assert.equal(hits[0], 0)
assert.equal(hits.at(-1), 20000 - 100)
assert(elapsed < 150, `uniform 20k search took ${elapsed} ms`)

// --- тот же участок через обратный откат: неоднозначность, файл не тронут ---
const current = uniform.join('\n')
const before = uniform.slice(0, 10000).join('\n')
const after = [...uniform.slice(0, 10000), 'line changed', ...uniform.slice(10000)].join('\n')
const reversed = reverseFragment(current, before, after)
assert.equal(reversed.ok, false, 'an ambiguous block is refused, not guessed')

console.log(`PASS review find sequence: matches naive search, uniform 20k block found in ${elapsed} ms`)
