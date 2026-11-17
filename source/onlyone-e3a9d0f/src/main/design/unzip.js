// Минимальная распаковка ZIP на встроенном zlib.
//
// Своя, а не библиотека: единственная подходящая в дереве — `extract-zip`, и она
// транзитивная зависимость electron-builder, то есть в собранное приложение не
// попадает. Архив с референсами распаковывался бы в разработке и молча падал у
// пользователя — ровно тот класс поломки, который здесь уже случался с React из
// CDN.
//
// Поддерживаются два метода хранения, которыми пишут все обычные архиваторы:
// 0 (без сжатия) и 8 (deflate). Шифрованные и многотомные архивы отвергаются с
// внятным текстом, а не молча.
const { inflateRawSync } = require('zlib')

const SIG_EOCD = 0x06054b50        // конец центрального каталога
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_CENTRAL = 0x02014b50     // запись центрального каталога
const SIG_LOCAL = 0x04034b50       // локальный заголовок файла

// Читает имя как UTF-8, если архиватор выставил флаг, иначе как CP437.
// Половина архивов из Windows приходит без флага и с кириллицей в именах.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

function decodeName(buf, utf8) {
  if (utf8) return buf.toString('utf8')
  let out = ''
  for (const byte of buf) out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]
  return out
}

function findEocd(buf) {
  // Комментарий архива может быть до 64 КБ, поэтому подпись ищется с конца.
  const from = Math.max(0, buf.length - 0x10000 - 22)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i
  }
  return -1
}

/**
 * Разбирает архив и возвращает список файлов: { name, size, data }.
 * Каталоги пропускаются — их создаёт тот, кто записывает файлы.
 *
 * @param {Buffer} buf содержимое .zip
 * @param {{ maxEntries?: number, maxTotalBytes?: number, maxEntryBytes?: number }} limits
 */
function unzip(buf, limits = {}) {
  const maxEntries = limits.maxEntries ?? 2000
  const maxTotalBytes = limits.maxTotalBytes ?? 200 * 1024 * 1024
  const maxEntryBytes = limits.maxEntryBytes ?? 50 * 1024 * 1024

  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Это не ZIP-архив.')

  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('Не найден конец архива: файл повреждён или это не ZIP.')

  // ZIP64 здесь не поддержан. Молча прочитать первые 65 535 файлов и сделать
  // вид, что архив распакован целиком, — хуже, чем отказать.
  if (buf.readUInt32LE(Math.max(0, eocd - 20)) === SIG_EOCD64_LOCATOR) {
    throw new Error('Архивы ZIP64 не поддерживаются. Распакуйте его и приложите файлы.')
  }

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const directoryEnd = offset + buf.readUInt32LE(eocd + 12)
  if (buf.readUInt16LE(eocd + 4) || buf.readUInt16LE(eocd + 6) || buf.readUInt16LE(eocd + 8) !== count) throw new Error('Многотомные архивы не поддерживаются.')
  if (count === 0xffff || offset === 0xffffffff) throw new Error('Архивы ZIP64 не поддерживаются.')
  if (directoryEnd > eocd) throw new Error('Центральный каталог архива повреждён.')
  if (count > maxEntries) throw new Error(`В архиве ${count} файлов — больше предела в ${maxEntries}.`)

  const files = []
  let total = 0

  for (let i = 0; i < count; i++) {
    if (offset + 46 > directoryEnd || buf.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new Error('Центральный каталог архива повреждён.')
    }
    const flags = buf.readUInt16LE(offset + 8)
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const size = buf.readUInt32LE(offset + 24)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    if (offset + 46 + nameLen + extraLen + commentLen > directoryEnd) throw new Error('Запись каталога архива повреждена.')
    const name = decodeName(buf.subarray(offset + 46, offset + 46 + nameLen), (flags & 0x800) !== 0)
    offset += 46 + nameLen + extraLen + commentLen

    if (flags & 0x0001) throw new Error(`«${name}» зашифрован — архивы с паролем не поддерживаются.`)
    if (name.endsWith('/')) continue
    if (size > maxEntryBytes) throw new Error(`«${name}» весит ${size} байт — больше предела на один файл.`)
    if (total + size > maxTotalBytes) throw new Error('Распакованный архив превышает допустимый размер.')

    // Длина «extra» в локальном заголовке своя и с центральной не совпадает.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`Локальный заголовок «${name}» повреждён.`)
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    if (start + compressedSize > buf.readUInt32LE(eocd + 16)) throw new Error(`Данные «${name}» обрезаны или повреждены.`)
    const body = buf.subarray(start, start + compressedSize)

    let data
    if (method === 0) {
      if (compressedSize !== size) throw new Error(`Размер «${name}» не совпадает с каталогом архива.`)
      data = Buffer.from(body)
    }
    else if (method === 8) {
      // Предел берётся от настоящих ограничений, а не от объявленного в каталоге
      // размера: соврать в каталоге ничего не стоит, и именно так устроена
      // zip-бомба. Несовпадение с объявленным ловится отдельно, ниже.
      const room = Math.max(1, Math.min(maxEntryBytes, maxTotalBytes - total))
      try {
        data = inflateRawSync(body, { maxOutputLength: room })
      } catch (err) {
        // zlib сообщает об этом как «Cannot create a Buffer larger than N bytes» —
        // строка из чужих внутренностей, по которой непонятно ни что случилось,
        // ни что делать.
        if (/larger than|ERR_BUFFER_TOO_LARGE/i.test(String(err?.message || err))) {
          throw new Error(`«${name}» при распаковке разворачивается больше допустимого. Похоже, архив повреждён или собран так, чтобы занять всю память.`)
        }
        throw new Error(`«${name}» не удалось распаковать: ${String(err?.message || err)}`)
      }
    }
    else throw new Error(`«${name}» сжат неизвестным методом ${method}.`)

    if (data.length !== size) throw new Error(`Размер «${name}» не совпадает с каталогом архива.`)
    total += data.length
    files.push({ name, size: data.length, data })
  }

  return files
}

module.exports = { unzip }
