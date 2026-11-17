// Встроенный браузер в панели превью: чистая модель — разбор адресной строки и вкладки.
//
// Адресная строка — не поле поиска и не поле URL, а оба сразу, как в обычном браузере:
// «localhost:3000» — адрес разработчика (http), «example.com» — сайт (https), «как сварить
// кофе» — поиск. Опасные схемы (javascript:, file:, data:) в окно с чужими страницами не
// пускаются никогда, что бы человек ни вставил.
const assert = require('node:assert/strict')
const model = require('../src/renderer/browser-model.js')

const failures = []
function test(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

const url = text => model.normalizeAddress(text)

test('полный адрес http/https остаётся как есть', () => {
  assert.deepEqual(url('https://example.com/a?b=1#c'), { kind: 'url', url: 'https://example.com/a?b=1#c' })
  assert.deepEqual(url('http://example.com'), { kind: 'url', url: 'http://example.com/' })
})

test('адреса разработчика получают http: localhost, 127.0.0.1, [::1], домашняя сеть, порт', () => {
  for (const [typed, want] of [
    ['localhost', 'http://localhost/'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['localhost:5173/app?x=1', 'http://localhost:5173/app?x=1'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['[::1]:3000', 'http://[::1]:3000/'],
    ['192.168.1.20:8000/index.html', 'http://192.168.1.20:8000/index.html'],
    ['myapp.localhost:3000', 'http://myapp.localhost:3000/']
  ]) assert.deepEqual(url(typed), { kind: 'url', url: want }, typed)
})

test('голое имя сайта получает https', () => {
  assert.deepEqual(url('example.com'), { kind: 'url', url: 'https://example.com/' })
  assert.deepEqual(url('www.example.co.uk/path'), { kind: 'url', url: 'https://www.example.co.uk/path' })
  assert.deepEqual(url('  example.com  '), { kind: 'url', url: 'https://example.com/' })
  assert.deepEqual(url('пример.рф'), { kind: 'url', url: 'https://xn--e1afmkfd.xn--p1ai/' })
})

test('всё остальное — поиск, текст экранируется', () => {
  const found = url('как сварить кофе')
  assert.equal(found.kind, 'search')
  assert.match(found.url, /^https:\/\/duckduckgo\.com\/\?q=/)
  assert.equal(new URL(found.url).searchParams.get('q'), 'как сварить кофе')
  assert.equal(new URL(url('a&b=c#d').url).searchParams.get('q'), 'a&b=c#d')
  assert.equal(url('одно').kind, 'search', 'одно слово без точки — поиск')
  assert.equal(url('hello world.com').kind, 'search', 'пробел делает это поиском, а не адресом')
})

test('опасные схемы отклоняются, а не уходят в поиск и не открываются', () => {
  for (const typed of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,<h1>x</h1>', 'chrome://settings', 'about:blank', 'view-source:https://example.com', 'blob:https://x/1', 'ftp://example.com', 'vbscript:x']) {
    const got = url(typed)
    assert.equal(got.kind, 'blocked', typed)
    assert.equal(got.url, '', typed)
  }
})

test('пустая строка — ничего', () => {
  assert.equal(url(''), null)
  assert.equal(url('   '), null)
  assert.equal(url(null), null)
})

test('подпись адреса: без схемы для https, с http как предупреждение, без хвостового слэша', () => {
  assert.equal(model.displayAddress('https://example.com/'), 'example.com')
  assert.equal(model.displayAddress('https://example.com/a/b?x=1'), 'example.com/a/b?x=1')
  assert.equal(model.displayAddress('http://localhost:3000/'), 'http://localhost:3000')
  assert.equal(model.displayAddress(''), '')
  assert.equal(model.displayAddress('мусор'), 'мусор')
})

test('вкладке без заголовка — имя узла', () => {
  assert.equal(model.titleOf({ url: 'https://www.example.com/x', title: '' }), 'example.com')
  assert.equal(model.titleOf({ url: 'http://localhost:3000/', title: '' }), 'localhost:3000')
  assert.equal(model.titleOf({ url: '', title: '' }), 'Новая вкладка')
  assert.equal(model.titleOf({ url: 'https://example.com', title: 'Пример' }), 'Пример')
})

test('вкладки: первая создаётся сама, активна последняя добавленная', () => {
  const tabs = model.createTabs()
  assert.equal(tabs.list().length, 0)
  const a = tabs.add('https://a.test/')
  const b = tabs.add('https://b.test/')
  assert.equal(tabs.list().length, 2)
  assert.equal(tabs.active(), b)
  tabs.select(a)
  assert.equal(tabs.active(), a)
})

test('вкладки: закрытие активной выбирает соседа справа, потом слева; последняя закрыта — пусто', () => {
  const tabs = model.createTabs()
  const a = tabs.add('https://a.test/')
  const b = tabs.add('https://b.test/')
  const c = tabs.add('https://c.test/')
  tabs.select(b)
  tabs.close(b)
  assert.equal(tabs.active(), c, 'справа')
  tabs.close(c)
  assert.equal(tabs.active(), a, 'слева')
  tabs.close(a)
  assert.equal(tabs.active(), null)
  assert.equal(tabs.list().length, 0)
})

test('вкладки: закрытие неактивной не меняет активную', () => {
  const tabs = model.createTabs()
  const a = tabs.add('https://a.test/')
  const b = tabs.add('https://b.test/')
  tabs.select(a)
  tabs.close(b)
  assert.equal(tabs.active(), a)
})

test('вкладки: предел восемь, девятая не заводится, а вместо неё отдаётся активная', () => {
  const tabs = model.createTabs({ max: 8 })
  const ids = []
  for (let i = 0; i < 8; i++) ids.push(tabs.add(`https://t${i}.test/`))
  const ninth = tabs.add('https://t8.test/')
  assert.equal(ninth, null)
  assert.equal(tabs.list().length, 8)
})

test('вкладки: patch меняет только известные поля и только своей вкладки', () => {
  const tabs = model.createTabs()
  const a = tabs.add('https://a.test/')
  const b = tabs.add('https://b.test/')
  tabs.patch(a, { title: 'А', loading: true, canBack: true, evil: 'x' })
  assert.equal(tabs.get(a).title, 'А')
  assert.equal(tabs.get(a).loading, true)
  assert.equal(tabs.get(a).canBack, true)
  assert.equal(tabs.get(a).evil, undefined)
  assert.equal(tabs.get(b).title, '')
  tabs.patch('нет-такой', { title: 'x' })
})

test('ошибка загрузки описывается словами по коду', () => {
  assert.match(model.describeLoadError(-102), /не отвечает|отклонил/i)
  assert.match(model.describeLoadError(-105), /имя|найти|адрес/i)
  assert.match(model.describeLoadError(-106), /интернет|сеть/i)
  assert.match(model.describeLoadError(-200), /сертификат|защищ/i)
  assert.match(model.describeLoadError(-7), /время|долго/i)
  assert.match(model.describeLoadError(-999), /не удалось/i)
  assert.equal(model.describeLoadError(-3), '', 'отмена перехода — не ошибка')
})

if (failures.length) { console.error(`\nПРОВАЛ ${failures.length}`); process.exit(1) }
console.log('\nВсе проверки модели браузера пройдены')
