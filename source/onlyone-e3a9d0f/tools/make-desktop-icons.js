// Иконки Windows из присланного знака: значок приложения (.ico) и знак для
// шапки окна. Прозрачность берётся из яркости — знак нарисован светящимся на
// тёмном, и грубый ключ по цвету оставил бы вокруг него грязную кайму.
const fs = require('node:fs')
const path = require('node:path')
const { readPng, writePng, resize, crop } = require('./png')

const ROOT = path.join(__dirname, '..')
const source = readPng(fs.readFileSync(path.join(ROOT, 'resources/mark-source.png')))

// Рамка знака в исходнике, измеренная по яркости.
const box = { x0: 580, y0: 277, x1: 1038, y1: 623 }
const cx = Math.round((box.x0 + box.x1) / 2)
const cy = Math.round((box.y0 + box.y1) / 2)
const longest = Math.max(box.x1 - box.x0, box.y1 - box.y0)

const squareAround = ratio => {
  const side = Math.round(longest / ratio)
  return crop(source, cx - (side >> 1), cy - (side >> 1), side, side)
}

function withAlphaFromLuminance (image) {
  const out = Buffer.from(image.data)
  for (let i = 0; i < image.width * image.height; i++) {
    const p = i * 4
    const lum = 0.2126 * out[p] + 0.7152 * out[p + 1] + 0.0722 * out[p + 2]
    // Фон исходника нигде не ярче 17.8, поэтому 19 срезает его вместе с зерном.
    const a = Math.max(0, Math.min(1, (lum - 19) / 39))
    out[p + 3] = Math.round(a * 255)
  }
  return { width: image.width, height: image.height, data: out }
}

// ICO — это контейнер: заголовок, по записи на размер и сами картинки. Windows
// со времён Vista читает записи, сохранённые как PNG, поэтому кодировать BMP с
// маской не нужно.
function writeIco (images) {
  const parts = images.map(image => writePng(image))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)          // зарезервировано
  header.writeUInt16LE(1, 2)          // тип: значок
  header.writeUInt16LE(images.length, 4)

  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + dir.length
  images.forEach((image, i) => {
    const at = i * 16
    // 256 записывается нулём: в один байт оно не помещается.
    dir[at] = image.width >= 256 ? 0 : image.width
    dir[at + 1] = image.height >= 256 ? 0 : image.height
    dir[at + 2] = 0                   // цветов в палитре — нет
    dir[at + 3] = 0                   // зарезервировано
    dir.writeUInt16LE(1, at + 4)      // плоскостей
    dir.writeUInt16LE(32, at + 6)     // бит на пиксель
    dir.writeUInt32LE(parts[i].length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += parts[i].length
  })
  return Buffer.concat([header, dir, ...parts])
}

const written = []
const put = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  written.push(path.relative(ROOT, file).replace(/\\/g, '/') + '  ' + body.length + ' байт')
}

// Значок приложения: знак заполняет квадрат плотно, маски у Windows нет.
const iconSquare = withAlphaFromLuminance(squareAround(0.78))
const sizes = [16, 24, 32, 48, 64, 128, 256]
put(path.join(ROOT, 'resources/1code.ico'), writeIco(sizes.map(s => resize(iconSquare, s, s))))
put(path.join(ROOT, 'resources/1code-icon-final.png'), writePng(resize(iconSquare, 512, 512)))

// Знак для шапки окна: тот же вырез, отдаётся окну как обычная картинка.
put(path.join(ROOT, 'src/renderer/mark.png'), writePng(resize(iconSquare, 256, 256)))

console.log(written.join('\n'))
