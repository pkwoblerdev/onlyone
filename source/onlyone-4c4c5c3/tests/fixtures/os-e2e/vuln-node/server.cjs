'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, 'public')

// Vulnerable on purpose: user input is joined to the root without a check.
function readUserFile (name) {
  const file = path.join(ROOT, name)
  return fs.readFileSync(file, 'utf8')
}

module.exports = { readUserFile }
