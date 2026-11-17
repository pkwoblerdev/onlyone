'use strict'

// Deliberately vulnerable: the safety scan fixture must produce real findings.
const { exec } = require('node:child_process')
const path = require('node:path')

function listDirectory (userInput) {
  exec('ls -la ' + userInput)
}

function readUpload (name) {
  return path.join('/srv/uploads', name)
}

module.exports = { listDirectory, readUpload }
