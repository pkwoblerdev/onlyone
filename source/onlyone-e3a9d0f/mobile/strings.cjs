// Список русских строк интерфейса телефона: что вызвано через t('…') в js/*.js. Нужен проверке перевода и сборщику en.js.
const fs = require('node:fs')
const path = require('node:path')

function strings() {
  const out = new Set()
  const dir = path.join(__dirname, 'www/js')
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js') || name === 'en.js') continue
    const source = fs.readFileSync(path.join(dir, name), 'utf8')
    for (const match of source.matchAll(/\bt\('((?:[^'\\]|\\.)*)'\)/g)) out.add(match[1].replace(/\\'/g, "'"))
  }
  return [...out]
}

module.exports = { strings }
if (require.main === module) console.log(strings().join('\n'))
