'use strict'

// Снимок страницы в ходе мысли агента.
//
// Кадр, который снимает модель (инструмент browse_screenshot) или следилка за вкладкой, идёт сразу ей в ход: модель получает
// картинку следующим сообщением, а человек видит её уменьшенную копию в строке шага. Раньше кадр браузера модели не отдавался
// вовсе — в ответе была только ссылка для живого вида, и описывать страницу ей приходилось вслепую.
//
// Два размера из одного кадра: для модели (длинная сторона не больше MODEL_WIDTH — дальше картинка стоит токенов, а читаемости
// не прибавляет) и для ленты (миниатюра, которая едет через IPC и сохраняется в диалоге вместе со строкой шага).
// nativeImage приходит аргументом: модуль не знает про Electron и проверяется без окна.

const MODEL_WIDTH = 1280
const MODEL_QUALITY = 80
const THUMB_WIDTH = 360
const THUMB_QUALITY = 60
// Миниатюра хранится в диалоге: больше этого в строку шага не кладётся.
const THUMB_MAX_CHARS = 120000

function jpegUrl (image, quality, width) {
  const scaled = width ? image.resize({ width, quality: 'good' }) : image
  const jpeg = scaled.toJPEG(quality)
  return jpeg && jpeg.length ? `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}` : ''
}

function prepareShot (png, nativeImage) {
  try {
    if (!png || !png.length || !nativeImage) return null
    const image = nativeImage.createFromBuffer(Buffer.from(png))
    if (!image || image.isEmpty()) return null
    const size = image.getSize()
    const longest = Math.max(size.width, size.height)
    // Ужимается длинная сторона: у страницы в десять экранов высоты ширина ничего не говорит.
    const modelWidth = longest > MODEL_WIDTH ? Math.max(1, Math.round(size.width * MODEL_WIDTH / longest)) : 0
    const thumbWidth = size.width > THUMB_WIDTH ? THUMB_WIDTH : 0
    const model = jpegUrl(image, MODEL_QUALITY, modelWidth)
    if (!model) return null
    return { model, thumb: jpegUrl(image, THUMB_QUALITY, thumbWidth), width: size.width, height: size.height }
  } catch {
    return null
  }
}

// Окно принимает в строку шага только картинку из data: нужного размера: всё остальное — не миниатюра.
function validThumb (value) {
  const text = String(value || '')
  if (text.length > THUMB_MAX_CHARS) return ''
  return /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(text) ? text : ''
}

module.exports = { prepareShot, validThumb, MODEL_WIDTH, MODEL_QUALITY, THUMB_WIDTH, THUMB_QUALITY, THUMB_MAX_CHARS }
