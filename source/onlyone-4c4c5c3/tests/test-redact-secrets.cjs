'use strict'
// Адресный набор правила зачистки `redactSecrets` (`src/main/run-checkpoints.js`).
//
// Меряется ОДНО: обычная речь обязана оставаться речью, а секрет — исчезать.
// Прежняя форма правила присваивания затирала любое слово, стоящее сразу после
// секретного имени: «Мой токен можно проверить вручную» теряло «можно», а
// «the Authorization header must start with Bearer» — слово «header». Теперь
// значение узнаётся по форме (цифра, дефис, подчёркивание, смешанный регистр)
// или по явному разделителю «:», «=», тире.
//
// Каждая проверка идёт парой к смыслу: если слово остаётся, то настоящая
// подстановка на его месте обязана стираться — иначе зелёный цвет означает
// просто выключенное правило. Мутанты: `audits/qoder-2-2026-09-25/redact-rule-mutation.cjs`.
//
// Ни сети, ни Electron, ни живых ключей: все значения выдуманы.
const assert = require('node:assert/strict')
const { redactSecrets } = require('../src/main/run-checkpoints')
const { maskSecretText } = require('../src/main/providers/secret-mask')

let checks = 0
let failed = 0
function check(name, fn) {
  checks++
  try {
    fn()
    console.log('ok', name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// 1. Обычный текст: вывод обязан совпасть со входом байт в байт.
// ---------------------------------------------------------------------------

const RUSSIAN_PROSE = [
  'Мой токен можно проверить вручную',
  'Ключ не задан, поэтому ход не пошёл',
  'пароль: нет',
  'пароль: не указан',
  'пароль: «нет»',
  'ключ: не задан человеком',
  'токен: отсутствует',
  'токен доступа не задан',
  'ключ от провайдера',
  'Мой ключ — это не секрет',
  'ключевые слова и ключевые фразы',
  'Ключевые файлы не трогай',
  'токен-дизайн: круги и квадраты',
  'ключи и замки',
  'в ключевой фразе слова не меняются',
  'парольная политика в компании меняется раз в год',
  'подпись документа в PDF',
  'авторизация через SSO не настроена',
  'ключ зажигания',
  'пароль пользователя истёк',
  'подпись пакета проверена',
  'Собери лендинг про пальмы, ключевые файлы не трогай, token_count = 5'
]

const ENGLISH_PROSE = [
  'the token can be checked manually',
  'the Authorization header must start with Bearer',
  'auth timeout is too short',
  'signature pad driver missing',
  'jwt library update to 9.4.2',
  'cookie consent banner shown twice',
  'api keynote scheduled for monday',
  'password policy settings are unchanged',
  'key bindings are stored in settings.json',
  'the key ring holds 3 keys',
  'token bucket rate limiting',
  'secret santa gift exchange',
  'the cookie jar is empty',
  'Model key note: none',
  'ключ: none',
  'secret: null',
  'токен: empty',
  'password: n/a',
  'The key is UTF-8 encoded',
  'The token is X11 mapped'
]

const TECHNICAL_PROSE = [
  'npm test && npm run build',
  'curl -s https://example.com/api/v1/items',
  'git commit -a',
  'C:\\Users\\Admin\\projects\\1code',
  'version 1.1.13 released',
  'port 11434 is busy',
  'commit 5f3cc1a fixed the parser',
  '{"model": "gpt", "temperature": 0.2}',
  'HTTP 401 Unauthorized from api.openai.com',
  'https://openrouter.ai/docs/faq#limits',
  'SELECT id, key FROM notes ORDER BY 1'
]

function proseGroup(title, lines) {
  check(title, () => {
    const eaten = lines.filter(line => redactSecrets(line) !== line)
    assert.deepEqual(eaten.map(line => `${line}  ->  ${redactSecrets(line)}`), [],
      `${eaten.length} обычн${eaten.length === 1 ? 'ая строка' : 'ых строк'} потеряли текст`)
  })
}

// ---------------------------------------------------------------------------
// 2. Секреты: значение обязано исчезнуть, остальной текст — остаться.
// ---------------------------------------------------------------------------

// [вход, ...значения, которые не имеют права остаться в выводе]
const SECRET_LINES = [
  ['ключ sk-or-v1-EXAMPLEbe5caa9c23046a234585fab14 отозван', 'sk-or-v1-EXAMPLEbe5caa9c23046a234585fab14'],
  ['x-api-key: sk-ant-api03-EXAMPLE8a077cb3937f810b7e2b44390', 'sk-ant-api03-EXAMPLE8a077cb3937f810b7e2b44390'],
  ['в запросе был ключ sk-proj-EXAMPLEd9cf725d3920c7692 и всё', 'sk-proj-EXAMPLEd9cf725d3920c7692'],
  ['AIzaSyD-Q7z2Lm4Xd9Rt6Yb1Nc8Vk3Hf5Gs0Jp', 'AIzaSyD-Q7z2Lm4Xd9Rt6Yb1Nc8Vk3Hf5Gs0Jp'],
  ['Токен ghp_AAAAAAAAAAAAAAAA положил в файл', 'ghp_AAAAAAAAAAAAAAAA'],
  ['glpat-AbCdEfGhIjKlMnOpQrSt', 'glpat-AbCdEfGhIjKlMnOpQrSt'],
  ['hf_AbCdEfGhIjKlMnOpQrStUvWx', 'hf_AbCdEfGhIjKlMnOpQrStUvWx'],
  ['xoxb-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx', 'xoxb-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'],
  ['ключ 9f8e7d6c5b4a39281706f5e4d3c2b1a0', '9f8e7d6c5b4a39281706f5e4d3c2b1a0'],
  ['curl -H "Authorization: Bearer abcdef123456ABCDEF" https://api.example/me', 'abcdef123456ABCDEF'],
  ['Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
  ['https://host/x?api_key=SECRET123&user=1', 'SECRET123'],
  ['https://host/x?access_token=abc123XYZdef', 'abc123XYZdef'],
  ['curl https://api.example/me?key=abcdef123456', 'abcdef123456'],
  ['postgres://user:pass@host/db', 'pass'],
  ['cookie: session_token=abcDEF123456xyz', 'abcDEF123456xyz'],
  ['пароль от базы: Qwerty123!, хост локальный', 'Qwerty123!'],
  ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA1234567890abcdef']
]

const FORMS_OF_ASSIGNMENT = [
  ['токен это abc123XYZ', 'abc123XYZ'],
  ['ключ от провайдера: abc123XYZ', 'abc123XYZ'],
  ['пароль базы: Qwerty123', 'Qwerty123'],
  ['ключ — abc123XYZ', 'abc123XYZ'],
  ['ключ - abc123XYZ', 'abc123XYZ'],
  ['password=huntertwo please rotate', 'huntertwo'],
  ['token: abcdef', 'abcdef'],
  ['ключ: qwerty', 'qwerty'],
  ['токен qwerty123', 'qwerty123'],
  ['вот токен abc123XYZ и ключ def456QWE', 'abc123XYZ', 'def456QWE'],
  ['{"token": "abc123XYZ", "model": "gpt"}', 'abc123XYZ'],
  ['token: "abc123XYZ"', 'abc123XYZ'],
  ['токен «abc123XYZ»', 'abc123XYZ'],
  ["secret: 'abc123XYZ'", 'abc123XYZ'],
  ['API_KEY=abc123XYZ', 'abc123XYZ'],
  ['- key: abc123XYZ', 'abc123XYZ'],
  ['токен=abc123XYZ', 'abc123XYZ'],
  ['ключ:\tabc123XYZ', 'abc123XYZ'],
  ['secret: hunter2', 'hunter2'],
  ['пароль: 123456', '123456'],
  ['ключ: 9f8e7d', '9f8e7d'],
  // Падежи русской метки. «SECRET_NAME» знал только именительный, и в тексте
  // просьбы ключ оставался целым: «зайди паролем Kx9…», «от пароля Kx9…»,
  // «ключи Kx9… и …» (находка аудита 01.11: 7 из 20 форм).
  ['зайди под admin паролем abc123XYZ', 'abc123XYZ'],
  ['от пароля abc123XYZ откатись', 'abc123XYZ'],
  ['под паролю abc123XYZ не пиши лог', 'abc123XYZ'],
  ['в пароле abc123XYZ одна заглавная', 'abc123XYZ'],
  ['с паролями abc123XYZ, def456QWE', 'abc123XYZ', 'def456QWE'],
  ['паролей abc123XYZ хватает', 'abc123XYZ'],
  ['ключом abc123XYZ пользуются двое', 'abc123XYZ'],
  ['без ключа abc123XYZ не пустит', 'abc123XYZ'],
  ['по ключу abc123XYZ', 'abc123XYZ'],
  ['ключи abc123XYZ, def456QWE', 'abc123XYZ', 'def456QWE'],
  ['в ключах abc123XYZ путаница', 'abc123XYZ'],
  ['у токена abc123XYZ истёк срок', 'abc123XYZ'],
  ['с токеном abc123XYZ', 'abc123XYZ'],
  ['о токене abc123XYZ', 'abc123XYZ'],
  ['токены abc123XYZ, def456QWE', 'abc123XYZ', 'def456QWE'],
  ['секретом abc123XYZ поделился', 'abc123XYZ'],
  ['без секрета abc123XYZ', 'abc123XYZ'],
  ['credential abc123XYZ', 'abc123XYZ'],
  ['credentials: abc123XYZ', 'abc123XYZ']
]

function secretGroup(title, lines) {
  check(title, () => {
    const leaks = []
    for (const [line, ...secrets] of lines) {
      const out = redactSecrets(line)
      for (const secret of secrets) if (out.includes(secret)) leaks.push(`«${secret}» в ${out}`)
    }
    assert.deepEqual(leaks, [], `${leaks.length} значени${leaks.length === 1 ? 'е' : 'й'} осталось на месте`)
  })
}

// Парное негативное управление: та же фраза, где вместо обычного слова стоит
// ключ. Если бы проверка выше краснела от выключенного правила, краснела бы и
// она — но в обратную сторону.
function pairs() {
  check('слово осталось, а ключ на его месте стёрт: русский оборот', () => {
    assert.equal(redactSecrets('Мой токен можно проверить вручную'), 'Мой токен можно проверить вручную')
    assert.equal(redactSecrets('Мой токен abc123XYZ проверить вручную'), 'Мой токен *** проверить вручную')
  })
  check('слово осталось, а ключ на его месте стёрт: английский оборот', () => {
    assert.equal(redactSecrets('the Authorization header must start with Bearer'),
      'the Authorization header must start with Bearer')
    assert.equal(redactSecrets('the Authorization token must start with Bearer abc123XYZ'),
      'the Authorization token must start with Bearer ***')
  })
  check('список значений через запятую стирается весь, проза после запятой — нет', () => {
    const list = redactSecrets('токен abc123XYZ, def456QWE')
    assert.equal(list, 'токен ***, ***', 'список закрыт не весь: ' + list)
    const pairs = redactSecrets('secret=abc123, other=def456')
    assert.equal(pairs, 'secret=***, ***', 'пары через запятую закрыты не все: ' + pairs)
    const prose = redactSecrets('токен abc123XYZ, но не def456QWE')
    assert.equal(prose, 'токен ***, но не def456QWE', 'слово после запятой съедено: ' + prose)
  })
  check('метка формата и слово схемы не прячут ключ и сами остаются', () => {
    assert.equal(redactSecrets('auth token AbCdEf123456 stored'), 'auth token *** stored')
    assert.equal(redactSecrets('секрет base64 dGVzdHRva2VuMTIzNDU2Nzg5MA'), 'секрет base64 ***')
    assert.equal(redactSecrets('токен JWT eyJhbGciOiJIUzI1NiJ9.abc'), 'токен JWT ***')
  })
  check('секрет в пути URL стёрт, имена разделов и короткие слова целы', () => {
    const hit = redactSecrets('https://api.example.com/token/abc123def456/callback')
    assert.ok(!hit.includes('abc123def456'), 'ключ в пути уцелел: ' + hit)
    assert.match(hit, /\/token\/.+\/callback/, 'путь перестал читаться: ' + hit)
    assert.equal(redactSecrets('https://docs.example.com/keys/intro'),
      'https://docs.example.com/keys/intro')
    assert.equal(redactSecrets('https://api.example.com/token/refresh'),
      'https://api.example.com/token/refresh')
  })
  check('число после имени по-прежнему под маской, счёт в середине фразы — нет', () => {
    assert.ok(!redactSecrets('ключ 123456').includes('123456'), 'голый код после имени уцелел')
    assert.equal(redactSecrets('the key ring holds 3 keys'), 'the key ring holds 3 keys')
  })
}

// ---------------------------------------------------------------------------
// 3. Остатки правила: что оно сознательно НЕ закрывает.
// ---------------------------------------------------------------------------

// Проверки обратные по смыслу: они краснеют, если кто-то начнёт затирать
// обычное слово «qwerty» или русское «секрет» — то есть если защита снова
// поедет за пределы формы. Настоящий пароль, написанный как обычное слово без
// разделителя, при этом остаётся открытым: отличить его от речи нельзя.
function residuals() {
  check('остаток задокументирован: строчное слово без разделителя не затирается', () => {
    assert.equal(redactSecrets('токен qwerty'), 'токен qwerty')
    assert.equal(redactSecrets('ключ abc'), 'ключ abc')
    assert.equal(redactSecrets('токен ABCDEF'), 'токен ABCDEF', 'КАПС через пробел задет')
    assert.ok(!redactSecrets('ключ: ABCDEF').includes('ABCDEF'), 'КАПС после «:» уцелел')
  })
  check('остаток задокументирован: русское слово после «:» остаётся словом', () => {
    assert.equal(redactSecrets('пароль: Кузнечик'), 'пароль: Кузнечик')
    assert.equal(redactSecrets('ключ: секрет'), 'ключ: секрет')
    // то же русское слово с цифрой — уже форма, и оно стирается
    assert.ok(!redactSecrets('ключ: Кузнечик123').includes('Кузнечик123'), 'форма с цифрой уцелела')
  })
}

// ---------------------------------------------------------------------------
// 3б. Короткие ключи: значение короче 32 знаков без имени рядом. «Слепая»
//     base64-форма начинается с 32, энтропия — с 16, и ключ в двенадцать
//     знаков в тексте ответа сервера оставался целым. Узнаётся он префиксом
//     провайдера; чтобы правило не поехало по прозе, в остатке обязана быть
//     цифра (её нет в «sk-learn» и «xoxo-guys»).
// ---------------------------------------------------------------------------
function shortKeys() {
  const SHORT_SECRETS = [
    ['ключ sk-9f8e отозван', 'sk-9f8e'],
    ['в запросе был sk-ab12cd и всё', 'sk-ab12cd'],
    ['AIzaSyA1b не подошёл', 'AIzaSyA1b'],
    ['xoxb-1234 устарел', 'xoxb-1234'],
    ['токен ghp_9f8e отозван', 'ghp_9f8e'],
    ['github_pat_ab12 не принят', 'github_pat_ab12'],
    ['glpat-ab12 истёк', 'glpat-ab12'],
    ['npm_ab12cd отозван', 'npm_ab12cd'],
    ['xai-ab12 не принят', 'xai-ab12'],
    ['sec_live_ab12 отозван', 'sec_live_ab12'],
    ['hf_ab12cd закончился', 'hf_ab12cd'],
    ['прислали eyJhbGci.eyJzdWIi вместо ключа', 'eyJhbGci.eyJzdWIi']
  ]
  check('короткие ключи узнаются по префиксу — и в redactSecrets, и в maskSecretText', () => {
    const leaks = []
    for (const [line, secret] of SHORT_SECRETS) {
      if (redactSecrets(line).includes(secret)) leaks.push(`redactSecrets: «${secret}» в ${redactSecrets(line)}`)
      const masked = maskSecretText(line)
      if (masked.includes(secret)) leaks.push(`maskSecretText: «${secret}» в ${masked}`)
    }
    assert.deepEqual(leaks, [], `${leaks.length} коротких ключей осталось на месте`)
  })

  check('короткие ключи: проза с теми же буквами остаётся собой', () => {
    const prose = [
      'the risk-free rate is 5%',
      'npm install && npm test',
      'hf band radio works',
      'hf_x shortcut',
      'xoxo-guys party at nine',
      'AIza is short',
      'xai is a company',
      'pk field is nullable',
      'eyJ is not a word'
    ]
    const eaten = prose.filter(line => redactSecrets(line) !== line || maskSecretText(line) !== line)
    assert.deepEqual(eaten.map(line => `${line}  ->  ${redactSecrets(line)} | ${maskSecretText(line)}`), [],
      `${eaten.length} обычных строк потеряли текст`)
  })
}

// ---------------------------------------------------------------------------
// 4. Форма, URL и заголовки — то, что было защищено раньше и не имеет права
//    отвалиться при правке правила присваивания.
// ---------------------------------------------------------------------------

function untouchedProtections() {
  check('формы живых ключей стираются без всякого имени', () => {
    for (const secret of ['sk-or-v1-EXAMPLEbe5caa9c23046a234585fab14',
      'AIzaSyD-Q7z2Lm4Xd9Rt6Yb1Nc8Vk3Hf5Gs0Jp',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'q7z2Lm4Xd9Rt6Yb1Nc8Vk3Hf5Gs0Jp2WxNz']) {
      assert.ok(!redactSecrets(`вот тебе ${secret} и больше ничего`).includes(secret.slice(0, 20)),
        `форма не закрыта: ${secret.slice(0, 12)}…`)
    }
  })
  check('URL и заголовок: секрет стёрт, адрес и схема живы', () => {
    const url = redactSecrets('https://api.example/v1?token=СЕКРЕТ-ТОКЕН-9f8e7d6c&page=2')
    assert.match(url, /\?token=\*\*\*/, 'параметр token не закрыт: ' + url)
    assert.match(url, /page=2/, 'обычный параметр задет: ' + url)
    const header = redactSecrets('curl -H "Authorization: Bearer abcdef123456ABCDEF" https://api.example/me')
    assert.match(header, /Authorization: Bearer \*\*\*/, 'заголовок не закрыт: ' + header)
    assert.match(header, /api\.example\/me/, 'адрес пропал вместе с заголовком: ' + header)
    const basic = redactSecrets('https://admin:S3cr3tPass@example.com/panel')
    assert.ok(!basic.includes('S3cr3tPass'), 'пароль в URL уцелел: ' + basic)
  })
  check('имена с уточнением остаются собой: keynote, token_count, ключевые', () => {
    assert.equal(redactSecrets('token_count = 5'), 'token_count = 5')
    assert.equal(redactSecrets('api keynote scheduled'), 'api keynote scheduled')
    assert.equal(redactSecrets('ключевые файлы не трогай'), 'ключевые файлы не трогай')
  })
}

function hygiene() {
  check('правило не роняет текст и не липнет к себе', () => {
    assert.equal(redactSecrets(''), '')
    assert.equal(redactSecrets(null), '')
    assert.equal(redactSecrets(undefined), '')
    assert.equal(redactSecrets(0), '', 'число должно превратиться в пустую строку, а не в исключение')
    const once = redactSecrets('ключ: abc123XYZ и токен это def456QWE')
    assert.equal(redactSecrets(once), once, 'повторная зачистка меняет текст')
    assert.ok(!/ключ \*\*\*\*\*/.test(once), 'маска легла на маску: ' + once)
    const long = 'ключ abc123XYZ '.repeat(400)
    const started = Date.now()
    assert.ok(redactSecrets(long).includes('***'), 'длинный текст не обработан')
    assert.ok(Date.now() - started < 1500, 'правило деградирует на длинном тексте')
  })
}

function multiline() {
  check('многострочный текст: ключ стёрт в середине, остальные строки целы', () => {
    const text = 'Запрос к API:\n  заголовок: Authorization: Bearer abc123XYZ\n  модель: deepseek-chat\n  лимит: 1000'
    const out = redactSecrets(text)
    assert.ok(!out.includes('abc123XYZ'), 'ключ в многострочном тексте уцелел: ' + out)
    assert.match(out, /модель: deepseek-chat/, 'обычная строка задета: ' + out)
    assert.match(out, /лимит: 1000/, 'число задето: ' + out)
  })
  check('PEM-блок стёрт целиком, слова вокруг него читаемы', () => {
    const text = 'подними ключ:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\nи проверь порт 2222'
    const out = redactSecrets(text)
    assert.ok(!out.includes('b3BlbnNzaC1rZXktdjEAAAAA'), 'PEM уцелел: ' + out)
    assert.match(out, /и проверь порт 2222/, 'текст после блока задет: ' + out)
    assert.match(out, /подними ключ/, 'текст перед блоком задет: ' + out)
  })
}

proseGroup('русская проза остаётся дословно', RUSSIAN_PROSE)
proseGroup('английская проза остаётся дословно', ENGLISH_PROSE)
proseGroup('технические строки остаются дословно', TECHNICAL_PROSE)
secretGroup('секреты в живых формах стёрты', SECRET_LINES)
secretGroup('секреты после имени — любая форма присваивания', FORMS_OF_ASSIGNMENT)
pairs()
residuals()
shortKeys()
untouchedProtections()
multiline()
hygiene()

console.log(`Проверок: ${checks}, отказов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
