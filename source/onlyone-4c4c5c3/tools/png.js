// Разбор и сборка PNG без зависимостей. Нужен потому, что sharp в этом
// окружении не встал, а иконку надо собрать из исходника «без потери качества»:
// уменьшение усреднением по площади, а не выбрасыванием пикселей.
const zlib = require('node:zlib')

function readPng (buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('это не PNG')

  let width = 0, height = 0, depth = 0, colorType = 0
  const idat = []
  let palette = null, trns = null

  let at = 8
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('ascii', at + 4, at + 8)
    const data = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('чересстрочный PNG не поддержан')
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') trns = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    at += 12 + length
  }
  if (depth !== 8) throw new Error('поддержана только глубина 8 бит, здесь ' + depth)

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error('тип цвета ' + colorType + ' не поддержан')

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)

  // Снятие построчных фильтров PNG: каждая строка начинается с номера фильтра.
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]
    const row = out.subarray(y * stride, (y + 1) * stride)
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x]
      const a = x >= channels ? row[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = (prev && x >= channels) ? prev[x - channels] : 0
      let result
      if (filter === 0) result = value
      else if (filter === 1) result = value + a
      else if (filter === 2) result = value + b
      else if (filter === 3) result = value + ((a + b) >> 1)
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        result = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      } else throw new Error('неизвестный фильтр строки: ' + filter)
      row[x] = result & 255
    }
    src += stride
  }

  // Всё приводится к RGBA — дальше работать с одним форматом проще и надёжнее.
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    if (colorType === 2) {
      rgba[p] = out[i * 3]; rgba[p + 1] = out[i * 3 + 1]; rgba[p + 2] = out[i * 3 + 2]; rgba[p + 3] = 255
    } else if (colorType === 6) {
      rgba[p] = out[i * 4]; rgba[p + 1] = out[i * 4 + 1]; rgba[p + 2] = out[i * 4 + 2]; rgba[p + 3] = out[i * 4 + 3]
    } else if (colorType === 0) {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = out[i]; rgba[p + 3] = 255
    } else if (colorType === 4) {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = out[i * 2]; rgba[p + 3] = out[i * 2 + 1]
    } else if (colorType === 3) {
      const index = out[i]
      rgba[p] = palette[index * 3]; rgba[p + 1] = palette[index * 3 + 1]; rgba[p + 2] = palette[index * 3 + 2]
      rgba[p + 3] = trns && index < trns.length ? trns[index] : 255
    }
  }
  return { width, height, data: rgba }
}

function writePng ({ width, height, data }) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'ascii')
    body.copy(out, 8)
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

let table = null
function crc (buffer) {
  if (!table) {
    table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buffer.length; i++) c = table[(c ^ buffer[i]) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

// Уменьшение усреднением по площади. Ближайший сосед на логотипе с мягкими
// краями даёт рваную лесенку — на иконке в 48 точек это видно сразу.
function resize (image, w, h) {
  const out = Buffer.alloc(w * h * 4)
  const sx = image.width / w, sy = image.height / h
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let yy = y0; yy < y1 && yy < image.height; yy++) {
        for (let xx = x0; xx < x1 && xx < image.width; xx++) {
          const p = (yy * image.width + xx) * 4
          const alpha = image.data[p + 3]
          // Цвет усредняется с весом альфы, иначе прозрачные пиксели тянут
          // краевые точки в чёрный и вокруг знака появляется грязная кайма.
          r += image.data[p] * alpha; g += image.data[p + 1] * alpha; b += image.data[p + 2] * alpha
          a += alpha; n++
        }
      }
      const p = (y * w + x) * 4
      if (a > 0) { out[p] = Math.round(r / a); out[p + 1] = Math.round(g / a); out[p + 2] = Math.round(b / a) }
      out[p + 3] = Math.round(a / n)
    }
  }
  return { width: w, height: h, data: out }
}

function crop (image, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4)
  for (let yy = 0; yy < h; yy++) {
    const from = ((y + yy) * image.width + x) * 4
    image.data.copy(out, yy * w * 4, from, from + w * 4)
  }
  return { width: w, height: h, data: out }
}

module.exports = { readPng, writePng, resize, crop }
