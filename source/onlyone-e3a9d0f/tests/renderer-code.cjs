// Код окна одним текстом: `app.js` и все подключённые к нему модули.
//
// С разделением app.js (план, 2d) экраны живут своими файлами, и проверка
// «как это написано в окне» должна видеть весь исполняемый код, а не только
// то, что в `app.js` осталось. Список берётся из `index.html`: что грузится,
// то и проверяется; словари (`i18n.js`) и вендор в код окна не входят.
const fs = require('node:fs')
const path = require('node:path')

const SKIP = /^vendor\/|i18n\.js$/

function rendererCode(root) {
  const dir = path.join(root, 'src', 'renderer')
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  return [...html.matchAll(/<script\s+src="([^"]+\.js)"/g)]
    .map(match => match[1])
    .filter(src => !SKIP.test(src))
    .map(src => fs.readFileSync(path.join(dir, src), 'utf8').replace(/\r\n/g, '\n'))
    .join('\n')
}

module.exports = { rendererCode }
