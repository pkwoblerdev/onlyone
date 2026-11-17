const assert = require('node:assert')

test.skip('one', () => { assert.ok(1) })
test.skip('two', () => { assert.ok(1) })
xit('three', () => { assert.ok(1) })
