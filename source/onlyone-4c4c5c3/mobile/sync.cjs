// Подтягивает в www общие модули приложения (протокол, спаривание, связь), шрифты и разметчик Markdown.
// Один исходник на компьютер и телефон: правка протокола не расходится между ними.
// Запускается и из npm test в свежем checkout: пути — от __dirname, совпадающие файлы не переписываются.
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const www = path.join(__dirname, 'www')
const copy = (from, to) => {
  const source = fs.readFileSync(from)
  let current = null
  try { current = fs.readFileSync(to) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (current && current.equals(source)) return
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.writeFileSync(to, source)
}

for (const name of ['remote-protocol.js', 'remote-pairing.js', 'remote-link.js']) copy(path.join(root, 'src/shared', name), path.join(www, 'js/shared', name))
for (const name of ['instrument-sans-latin-400-normal.woff2', 'instrument-sans-latin-500-normal.woff2', 'fira-code-latin-400-normal.woff2', 'fira-code-cyrillic-400-normal.woff2']) copy(path.join(root, 'src/renderer/fonts', name), path.join(www, 'fonts', name))
copy(path.join(root, 'src/renderer/vendor/marked.min.js'), path.join(www, 'vendor/marked.min.js'))
console.log('mobile/www: общие модули, шрифты и marked на месте')
