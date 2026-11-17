// Что на странице на самом деле, в числах.
//
// Проверка макета отвечала «да/нет»: отрисовалось, есть переполнение, есть
// битые картинки. Этого хватает, чтобы поймать сломанное, и не хватает ни на
// что больше. Контракт ревью требует называть кегли, контрасты и ритм отступов
// — а взять их было неоткуда, и модель называла их по памяти о том, что сама
// написала. Память о написанном и отрисованное — разные вещи: наследование,
// запасной шрифт, перенос и медиазапрос меняют результат молча.
//
// Здесь страница измеряется после рендера. Код замера свой, а не модельный:
// выполнять присланный моделью скрипт в окне с доступом к файлам дизайна —
// совсем другой разговор, и он тут не нужен. Набор величин закрыт и отвечает
// ровно на те вопросы, которые задаёт контракт ревью.
const { randomUUID } = require('crypto')

const FONT_HOSTS = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//i

// Скрипт замера. Строкой, потому что исполняется он в чужом окне.
const PROBE = `(async () => {
  await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 800))]);
  const root = document.querySelector('#dc-root') || document.body;

  const visible = el => {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility === 'visible' && s.opacity !== '0' && s.display !== 'none';
  };

  const all = [...root.querySelectorAll('*')].filter(visible);

  // --- шкала кеглей -----------------------------------------------------------
  // Считаем только по узлам с собственным текстом: иначе размер обёртки
  // засчитывается столько раз, сколько в ней вложенных блоков.
  const sizes = new Map();
  for (const el of all) {
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const s = getComputedStyle(el);
    const px = Math.round(parseFloat(s.fontSize) || 0);
    if (!px) continue;
    const key = px + '/' + (s.fontWeight || '400');
    const row = sizes.get(key) || { px, weight: s.fontWeight, count: 0, family: (s.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(), sample: '' };
    row.count += 1;
    if (!row.sample) row.sample = el.innerText.trim().replace(/\\s+/g, ' ').slice(0, 48);
    sizes.set(key, row);
  }
  const scale = [...sizes.values()].sort((a, b) => b.px - a.px).slice(0, 12);

  // --- контраст текста к своему фону ------------------------------------------
  const parse = value => {
    const m = String(value).match(/[\\d.]+/g);
    if (!m) return null;
    return { r: +m[0], g: +m[1], b: +m[2], a: m[3] === undefined ? 1 : +m[3] };
  };
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const backdrop = el => {
    let node = el;
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.5) return c;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
  };

  const weak = [];
  for (const el of all) {
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    if (!fg) continue;
    const px = parseFloat(s.fontSize) || 0;
    const bold = (parseInt(s.fontWeight, 10) || 400) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const value = ratio(fg, backdrop(el));
    if (value < need) {
      weak.push({ ratio: value, need, px: Math.round(px),
        text: el.innerText.trim().replace(/\\s+/g, ' ').slice(0, 44) });
    }
  }
  weak.sort((a, b) => a.ratio - b.ratio);

  // --- ритм отступов ----------------------------------------------------------
  const gaps = new Map();
  for (const el of all) {
    const s = getComputedStyle(el);
    for (const value of [s.marginBottom, s.marginTop, s.paddingTop, s.paddingBottom, s.rowGap, s.columnGap]) {
      const px = Math.round(parseFloat(value) || 0);
      if (px > 0 && px < 400) gaps.set(px, (gaps.get(px) || 0) + 1);
    }
  }
  const rhythm = [...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([px, count]) => ({ px, count }));

  // --- палитра ----------------------------------------------------------------
  const paint = new Map();
  for (const el of all) {
    const s = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const area = Math.round(box.width * box.height);
    if (!area) continue;
    for (const [role, value] of [['fg', s.color], ['bg', s.backgroundColor]]) {
      const c = parse(value);
      if (!c || c.a < 0.05) continue;
      const key = role + ' rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
      paint.set(key, (paint.get(key) || 0) + (role === 'bg' ? area : Math.round(area / 40)));
    }
  }
  const palette = [...paint.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([key, weight]) => ({ color: key, weight }));

  // --- цели попадания ---------------------------------------------------------
  const controls = [...root.querySelectorAll('button,a[href],input,select,textarea,[role=button]')].filter(visible);
  const small = controls.map(el => {
    const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height),
      text: (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 30) };
  }).filter(c => c.h < 44 || c.w < 44).slice(0, 8);

  // --- длина строки в основном тексте ------------------------------------------
  const paragraphs = [...root.querySelectorAll('p,li')].filter(visible)
    .map(el => {
      const s = getComputedStyle(el);
      const px = parseFloat(s.fontSize) || 16;
      const width = el.getBoundingClientRect().width;
      // Примерная ширина знака для латиницы и кириллицы — половина кегля.
      return Math.round(width / (px * 0.5));
    }).filter(n => n > 0).sort((a, b) => a - b);
  const measureLine = paragraphs.length
    ? { min: paragraphs[0], median: paragraphs[Math.floor(paragraphs.length / 2)], max: paragraphs[paragraphs.length - 1] }
    : null;

  const body = root.getBoundingClientRect();
  return {
    viewport: { width: innerWidth, height: innerHeight },
    page: { width: Math.round(body.width), height: Math.round(document.documentElement.scrollHeight) },
    elements: all.length,
    scale, rhythm, palette,
    lowContrast: weak.slice(0, 8),
    smallTargets: small,
    lineLength: measureLine,
    fontsUsed: [...new Set(all.map(el => (getComputedStyle(el).fontFamily || '').split(',')[0].replace(/["']/g, '').trim()).filter(Boolean))].slice(0, 6)
  };
})()`

async function measureDesign({ BrowserWindow, session, serveFile, designId, path, widths = [1280, 375], signal }) {
  const screens = []
  for (const width of widths) {
    if (signal?.aborted) throw new Error('Замер отменён')
    const partition = session.fromPartition(`design-measure-${randomUUID()}`)
    const prefix = `onecode-design://${designId}/`
    partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    partition.setPermissionCheckHandler(() => false)
    partition.webRequest.onBeforeRequest((details, callback) => {
      const url = String(details.url || '')
      const own = url.startsWith(prefix) || url.startsWith('data:') || url.startsWith('blob:')
      callback({ cancel: !own && !FONT_HOSTS.test(url) })
    })
    partition.on('will-download', event => event.preventDefault())
    partition.protocol.handle('onecode-design', serveFile)

    const window = new BrowserWindow({ width, height: 900, show: false, useContentSize: true,
      webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-redirect', event => event.preventDefault())

    let timer = null
    const abort = () => { if (!window.isDestroyed()) window.destroy() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const result = await Promise.race([
        (async () => {
          await window.loadURL(prefix + encodeURIComponent(path))
          await new Promise(resolve => setTimeout(resolve, 400))
          return window.webContents.executeJavaScript(PROBE)
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Лимит замера: 10 секунд')), 10000) })
      ])
      screens.push(result)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (!window.isDestroyed()) window.destroy()
      try { await partition.clearStorageData() } catch {}
    }
  }

  return { success: true, screens, note: readingOf(screens) }
}

// Одна строка вывода: что из замеренного заслуживает внимания. Числа без
// прочтения модель склонна пересказывать, а не использовать.
function readingOf(screens) {
  const wide = screens[0]
  if (!wide) return ''
  const notes = []

  const steps = (wide.scale || []).map(row => row.px)
  if (steps.length >= 3) {
    const top = steps[0]
    const body = steps.find(px => px <= 20) || steps[steps.length - 1]
    if (top / body < 2) notes.push(`разброс кеглей мал: ${top}px против ${body}px, иерархия почти плоская`)
  }
  if ((wide.lowContrast || []).length) {
    const worst = wide.lowContrast[0]
    notes.push(`контраст ниже нормы у ${wide.lowContrast.length}: худший ${worst.ratio} при нужных ${worst.need}`)
  }
  if ((wide.rhythm || []).length > 6) notes.push('отступов больше шести разных — ритма нет, есть случайные числа')
  if ((wide.smallTargets || []).length) notes.push(`целей меньше 44px: ${wide.smallTargets.length}`)
  if (wide.lineLength && (wide.lineLength.median > 90 || wide.lineLength.median < 40)) {
    notes.push(`длина строки ${wide.lineLength.median} знаков, читаемая полоса — 45–75`)
  }
  const narrow = screens[1]
  if (narrow && narrow.page && narrow.viewport && narrow.page.width > narrow.viewport.width + 2) {
    notes.push('на узкой ширине страница шире экрана')
  }

  return notes.length ? notes.join('; ') : 'грубых отклонений в числах нет — дальше вопрос вкуса, а не измерения'
}

module.exports = { measureDesign, readingOf }
