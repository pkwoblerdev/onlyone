// Чем заполнять места, где должна быть картинка.
//
// Фотографию модель нарисовать не может, а страница без единого изображения
// выглядит недоделанной. Прежний ответ на это был один: полосатая заглушка с
// подписью «сюда фото». Когда таких мест на странице пять, вся работа выглядит
// как чертёж вместо макета — ровно то, на что жалуется владелец.
//
// Здесь то, что модель действительно может построить и что действительно
// выглядит как оформление: градиентные поля, зерно, геометрические паттерны,
// дуотон. Всё возвращается готовым CSS или SVG, всё детерминировано от
// переданных цветов, ничего не грузится извне.
//
// Заглушка тоже остаётся — но для того единственного случая, ради которого она
// нужна: когда на этом месте обязана быть настоящая фотография или логотип,
// которых взять неоткуда.

const KINDS = ['mesh', 'grain', 'pattern', 'duotone', 'placeholder']

function clean(color, fallback) {
  const value = String(color || '').trim()
  // Только то, что безопасно подставить в значение CSS: без скобок функций,
  // кавычек, точек с запятой и url().
  return /^(#[0-9a-f]{3,8}|[a-z]{3,20}|oklch\([^;()]{3,60}\)|rgb\([\d\s,.%/]{5,40}\)|hsl\([\d\s,.%/]{5,40}\))$/i.test(value)
    ? value : fallback
}

function mesh(colors) {
  const a = clean(colors[0], '#e08c62')
  const b = clean(colors[1], '#6b8f71')
  const c = clean(colors[2], '#1b1a16')
  return {
    css: `background-color:${c};background-image:` +
      `radial-gradient(at 18% 22%, ${a} 0px, transparent 55%),` +
      `radial-gradient(at 82% 12%, ${b} 0px, transparent 50%),` +
      `radial-gradient(at 68% 84%, ${a} 0px, transparent 45%),` +
      `radial-gradient(at 12% 78%, ${b} 0px, transparent 48%)`,
    note: 'Градиентное поле. Кладётся на крупный блок — первый экран, карточку, подложку заголовка. Текст поверх требует проверки контраста: под светлыми пятнами он пропадает.'
  }
}

function grain(colors) {
  const base = clean(colors[0], '#15120e')
  // Зерно делается фильтром, а не картинкой: ничего не грузится и не мылится
  // при масштабировании.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3"/><feColorMatrix type="saturate" values="0"/></filter><rect width="140" height="140" filter="url(#g)" opacity="0.16"/></svg>`
  return {
    css: `background-color:${base};background-image:url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`,
    note: 'Зерно поверх ровного фона: убирает ощущение пустой заливки. Непрозрачность выше 0.2 начинает мешать чтению.'
  }
}

function pattern(colors, seed) {
  const ink = clean(colors[0], '#b08968')
  const back = clean(colors[1], '#15120e')
  const shapes = [
    `<circle cx="20" cy="20" r="6" fill="${ink}"/>`,
    `<path d="M0 20 L20 0 L40 20 L20 40Z" fill="none" stroke="${ink}" stroke-width="1.5"/>`,
    `<path d="M0 30 Q20 0 40 30" fill="none" stroke="${ink}" stroke-width="1.5"/>`,
    `<rect x="12" y="12" width="16" height="16" fill="none" stroke="${ink}" stroke-width="1.5"/>`,
    `<path d="M0 0 L40 40 M40 0 L0 40" stroke="${ink}" stroke-width="1" opacity="0.55"/>`
  ]
  const pick = shapes[Math.abs(Number(seed) || 0) % shapes.length]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${back}"/>${pick}</svg>`
  return {
    css: `background-image:url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}");background-repeat:repeat`,
    note: 'Повторяющийся мотив. Годится для подложки раздела и для полей; под длинным текстом мешает — там оставляй ровный фон.'
  }
}

function duotone(colors) {
  const dark = clean(colors[0], '#1b1a16')
  const light = clean(colors[1], '#e08c62')
  return {
    css: `background:linear-gradient(135deg, ${dark} 0%, ${dark} 38%, ${light} 100%)`,
    filter: 'grayscale(1) contrast(1.15)',
    note: 'Дуотон для фотографии: положи картинку, примени filter, сверху блок с этим фоном и mix-blend-mode:screen. Без фотографии работает и сам по себе как плашка.'
  }
}

function placeholder(colors, label) {
  const ink = clean(colors[0], '#6f665a')
  const back = clean(colors[1], '#201c18')
  const text = String(label || 'фото').replace(/[<>&"]/g, '').slice(0, 28)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><pattern id="s" width="12" height="12" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="12" stroke="${ink}" stroke-width="1" opacity="0.35"/></pattern></defs><rect width="400" height="300" fill="${back}"/><rect width="400" height="300" fill="url(#s)"/><text x="200" y="154" text-anchor="middle" font-family="ui-monospace,monospace" font-size="15" fill="${ink}">${text}</text></svg>`
  return {
    src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    note: 'Заглушка ровно для того случая, когда на этом месте обязана быть настоящая фотография или логотип, которых взять неоткуда. Для узора, текстуры и декоративной иллюстрации бери mesh, grain или pattern — заглушка вместо оформления и есть та самая недоделанность.'
  }
}

function imagery({ kind, colors = [], label = '', seed = 0 }) {
  const want = String(kind || '').trim()
  if (!want) {
    return {
      success: true,
      kinds: KINDS,
      note: 'mesh — градиентное поле; grain — зерно поверх заливки; pattern — повторяющийся мотив; duotone — двухцветная обработка; placeholder — полосатая заглушка только для настоящей фотографии.'
    }
  }
  if (!KINDS.includes(want)) {
    return { success: false, error: 'Нет такого вида. Есть: ' + KINDS.join(', ') }
  }

  const list = (Array.isArray(colors) ? colors : []).map(c => String(c || ''))
  const made = want === 'mesh' ? mesh(list)
    : want === 'grain' ? grain(list)
    : want === 'pattern' ? pattern(list, seed)
    : want === 'duotone' ? duotone(list)
    : placeholder(list, label)

  return { success: true, kind: want, ...made }
}

module.exports = { imagery, KINDS }
