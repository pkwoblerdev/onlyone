// fetch_url: служебные блоки удаляются из страницы за один проход.
//
// Прежняя регулярка с ленивым [\s\S]*? при незакрытом теге просматривала
// остаток страницы от каждого вхождения: 320 КБ сплошных «<script » держали
// главный процесс ~15 с, а страница принимается до 3 МиБ. Здесь и смысл
// удаления, и предел по времени на худшем входе.
const assert = require('node:assert/strict')
const web = require('../src/main/web-fetch.js')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

const text = html => web.htmlToText(html, 'https://site.test/').text

const timed = (html, limit, what) => {
  const started = Date.now()
  web.htmlToText(html, 'https://site.test/')
  const ms = Date.now() - started
  assert(ms < limit, `${what}: разбор занял ${ms} мс`)
}

check('блоки с атрибутами выбрасываются целиком', () => {
  const page = '<h1>Заголовок</h1><script type="module" src="app.js">var secret = 1</script>' +
    '<style media="print">.a{color:red}</style><noscript>включите JS</noscript><p>текст</p>'
  const out = text(page)
  assert.match(out, /# Заголовок/)
  assert.match(out, /текст/)
  assert(!/secret|color:red|включите/.test(out), 'содержимое блока попало в текст: ' + out)
})

check('регистр имени и атрибуты не мешают', () => {
  const out = text('<SCRIPT SRC="a.js">bad()</SCRIPT><Style>.x{}</Style><P>ok</P>')
  assert.match(out, /ok/)
  assert(!/bad\(\)|\.x\{\}/.test(out), 'блок в другом регистре не выброшен: ' + out)
})

check('svg, template и iframe уходят вместе с вложенными блоками', () => {
  const out = text('<div>внешний<svg viewBox="0 0 1 1"><style>.s{}</style><text>внутри</text></svg>' +
    '<template><script>t()</script><p>шаблон</p></template>' +
    '<iframe src="https://frame.test/"></iframe>хвост</div>')
  assert.match(out, /внешний/)
  assert.match(out, /хвост/)
  assert(!/внутри|шаблон|\.s\{|t\(\)/.test(out), 'вложенное осталось: ' + out)
})

check('незакрытый блок не съедает страницу после себя', () => {
  // Поведение прежнее: без закрывающего тега блок не вырезается, но сам тег
  // как разметка из текста уходит.
  const out = text('<p>до</p><script>alert(1)')
  assert.match(out, /до/)
  assert.match(out, /alert\(1\)/)
  assert(!/<script/.test(out), 'тег остался в тексте: ' + out)
})

check('scriptx — не script', () => {
  const out = text('<scriptx>виден</scriptx><p>текст</p>')
  assert.match(out, /виден/)
  assert.match(out, /текст/)
})

check('несколько блоков подряд: текст между ними цел', () => {
  assert.equal(text('<script>a</script>первый<style>b</style>второй<script>c</script>'), 'первыйвторой')
})

check('head и select выкидываются, title остаётся', () => {
  const { title, text: out } = web.htmlToText('<html><head><meta charset="utf-8"><title>Имя</title></head>' +
    '<body><select><option>Москва</option></select><p>тело</p></body></html>', 'https://site.test/')
  assert.equal(title, 'Имя')
  assert.match(out, /тело/)
  assert(!/Москва/.test(out), 'содержимое select осталось: ' + out)
})

// Худший вход из отчёта: 320 КБ открывающих тегов без единого закрывающего.
check('320 КБ незакрытых script разбираются быстро', () => {
  const html = '<script '.repeat(40000)
  assert.equal(html.length, 320000)
  timed(html, 2000, 'незакрытые script')
})

// Не регрессия ради замера: столько же закрытых блоков должны уходить за
// один проход, а не пересобирать поиск на каждое вхождение.
check('20 000 закрытых блоков разбираются быстро', () => {
  timed('<script>var x = 1</script>'.repeat(20000), 2000, 'закрытые script')
})


check('320 КБ незакрытых заголовков разбираются быстро', () => {
  timed('<h1 '.repeat(80000), 2000, 'незакрытые h1')
})

check('320 КБ незакрытых комментариев разбираются быстро', () => {
  timed('<!--'.repeat(80000), 2000, 'незакрытые комментарии')
})

check('200 КБ незакрытого nav разбираются быстро', () => {
  timed('<nav '.repeat(40000), 2000, 'незакрытый nav')
})

// Тот же класс, что чинили для script/заголовков/комментариев, но в других
// проходах: ссылки, картинки, title и main/article оставались регулярками с
// ленивым `[\s\S]*?`. Замеры до правки: 320 КБ «<a » — 24,6 с, 40 КБ
// «<img alt="» — 97,8 с, 320 КБ «<main » — 26,4 с на одном вызове fetch_url.
check('320 КБ незакрытых ссылок разбираются быстро', () => {
  timed('<a '.repeat(109227), 2000, 'незакрытые a')
})

check('320 КБ ссылок с href без конца разбираются быстро', () => {
  timed('<a href="x">'.repeat(27307), 2000, 'ссылки без </a>')
})

check('320 КБ незакрытых alt у картинок разбираются быстро', () => {
  timed('<img alt="'.repeat(40960), 2000, 'незакрытые img alt')
})

check('320 КБ незакрытых title, main и article разбираются быстро', () => {
  timed('<title '.repeat(46811), 2000, 'незакрытые title')
  timed('<main '.repeat(54613), 2000, 'незакрытые main')
  timed('<article '.repeat(36409), 2000, 'незакрытые article')
})

// Ссылки и картинки читаются тем же проходом, что и раньше: проверка на
// реальном содержимом, а не только на времени.
check('ссылка с текстом, якорем и javascript: ведёт себя как раньше', () => {
  const out = text('<p>До</p><a href="/x/1">Метка</a><a href="#top">якорь</a>' +
    '<a href="javascript:alert(1)">скрипт</a><a>без href</a>')
  assert.match(out, /\[Метка\]\(https:\/\/site\.test\/x\/1\)/)
  assert.match(out, /якорьскриптбез href/, 'ссылки без адреса собрались иначе: ' + out)
  assert(!/href=/.test(out), 'атрибуты утекли в текст: ' + out)
})

check('картинка с alt и без, alt внутри ссылки', () => {
  const out = text('<p>а<img src="1.png" alt="подпись">б<img src="2.png">в</p>')
  assert.match(out, /\[изображение: подпись\]/)
  assert(!/2\.png|1\.png/.test(out), 'src картинки утек: ' + out)
})

check('title и main читаются сквозь остальную разметку', () => {
  const page = '<html><head><title>Имя &amp; файла</title></head><body>' +
    '<main><a href="/m">в основном</a></main><p>после</p></body></html>'
  const got = web.htmlToText(page, 'https://site.test/')
  assert.equal(got.title, 'Имя & файла')
  assert.match(got.text, /\[в основном\]\(https:\/\/site\.test\/m\)/)
  assert.match(got.text, /после/)
})

check('закрытые заголовки, nav/footer и комментарии по-прежнему обрабатываются', () => {
  assert.match(text('<h1>Заголовок</h1>'), /# Заголовок/)
  assert(!/меню/.test(text('<body><nav>меню</nav><p>текст</p></body>')), 'nav остался')
  assert.match(text('<body><nav>меню'), /меню/, 'незакрытый nav не должен съедать текст')
  assert(!/секрет/.test(text('<p>a</p><!-- секрет --><p>b</p>')), 'комментарий остался')
})
console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
