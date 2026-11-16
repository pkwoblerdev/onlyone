const assert = require('node:assert')

test.skip('later', () => { assert.equal(1 + 1, 2) })
xit('legacy', () => { assert.equal(2 + 2, 4) })
assert.ok(true)
