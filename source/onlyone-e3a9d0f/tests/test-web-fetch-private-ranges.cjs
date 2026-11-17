// test-web-fetch-private-ranges.cjs — находка Н1 аудита sec-net 2026-11-01.
//
// Ограда `isPrivateAddress` в src/main/web-fetch.js не считает приватными два
// special-purpose диапазона IANA, которые наружу не маршрутизируются:
//   - 192.0.0.0/24  (IETF Protocol Assignments, RFC 6890),
//   - 198.18.0.0/15 (benchmarking, RFC 2544).
// Запросы к ним проходят по «публичной» ветке allow без спроса человека.
//
// ВНИМАНИЕ: этот набор КРАСНО до правки PRIVATE_V4 в web-fetch.js (файл —
// зона владельца, тест только фиксирует контракт). Патч — две строки в список
// PRIVATE_V4 (см. FIX.md находки Н1). Когда правка в main войдёт, проверку
// нужно перенести в общую цепочку `test` в package.json.
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { isPrivateAddress, autoLocalRefusal } = require('../src/main/web-fetch.js')

const MUST_BE_PRIVATE = [
  '192.0.0.0', '192.0.0.1', '192.0.0.255',        // 192.0.0.0/24 — RFC 6890
  '198.18.0.0', '198.18.0.1', '198.19.255.255',   // 198.18.0.0/15 — RFC 2544
  '[::ffff:192.0.0.1]', '[::ffff:198.18.5.6]'    // те же адреса, вписанные в IPv6
]

const MUST_STAY_PUBLIC = [
  '192.0.1.0', '198.17.255.255', '198.20.0.0',    // сразу за границами диапазонов
  '8.8.8.8', '172.15.0.1'
]

let failed = 0
for (const address of MUST_BE_PRIVATE) {
  const verdict = isPrivateAddress(address)
  if (verdict === true) { console.log('ok     приватен:', address) } else {
    failed++
    console.error(`ПРОВАЛ [${address}] должен считаться приватным (не маршрутизируется наружу), а получен ответ: ${verdict}`)
  }
}
for (const address of MUST_STAY_PUBLIC) {
  const verdict = isPrivateAddress(address)
  if (verdict === false) { console.log('ok     публичен:', address) } else {
    failed++
    console.error(`ПРОВАЛ [${address}] публичный адрес помечен приватным — ограда начнёт спрашивать лишнее`)
  }
}

// Б-8 / Н93: правила URL в «Авто». В «Авто» спроса нет — `approvalRequired`
// пропускает сеть молча, — поэтому локальный адрес там не «спрашивается», а
// запрещён: иначе инструмент достаёт loopback, link-local/metadata и домашнюю
// сеть без единого участия человека. Провайдеров и фид обновлений запрашивает
// само приложение, а не эти инструменты. Проверка — тот же helper, что у
// `fetch_url` (`isLocalHost`), второго определения диапазонов не заводим.
const lookup = async host => host === 'nas.home'
  ? [{ address: '192.168.1.9', family: 4 }]
  : [{ address: '93.184.216.34', family: 4 }]

const MUST_BE_REFUSED_IN_AUTO = [
  ['loopback', 'http://127.0.0.1:11434/api/tags'],
  ['localhost', 'http://localhost:3000/'],
  ['link-local и metadata', 'http://169.254.169.254/latest/meta-data/'],
  ['имя, ведущее в домашнюю сеть', 'http://nas.home/promo.mp4'],
  ['metadata по имени', 'http://metadata.google.internal/computeMetadata/v1/'],
  ['IPv6 loopback', 'http://[::1]:8080/']
]

const MUST_PASS_IN_AUTO = ['https://example.com/video.mp4', 'http://8.8.8.8/x']

async function autoRuleChecks () {
  for (const [what, url] of MUST_BE_REFUSED_IN_AUTO) {
    const refusal = await autoLocalRefusal(url, 'auto', lookup)
    if (typeof refusal !== 'string' || !refusal.trim()) {
      failed++
      console.error(`ПРОВАЛ [${what}] в «Авто» адрес проходит без спроса: ${url}`)
    } else console.log('ok     авто запрещает:', what)
  }
  for (const url of MUST_PASS_IN_AUTO) {
    const refusal = await autoLocalRefusal(url, 'auto', lookup)
    if (refusal !== '') {
      failed++
      console.error(`ПРОВАЛ [${url}] публичный адрес в «Авто» запрещён — так ломается обычная работа: ${refusal}`)
    } else console.log('ok     авто пропускает публичный:', url)
  }
  // В ручных режимах человек отвечает на карточку: адрес не отбирается у него.
  for (const permission of ['manual', 'acceptEdits', 'plan']) {
    const refusal = await autoLocalRefusal('http://127.0.0.1:3000/', permission, lookup)
    if (refusal !== '') {
      failed++
      console.error(`ПРОВАЛ [${permission}] спрос человека подменён запретом: ${refusal}`)
    } else console.log('ok     ручной режим не тронут:', permission)
  }
  // Непонятный адрес не должен превращаться ни в запрет, ни в разрешение:
  // его разбирает тот инструмент, который его получил.
  if (await autoLocalRefusal('не адрес', 'auto', lookup) !== '') {
    failed++
    console.error('ПРОВАЛ [мусор] не-адрес запрещён нашей же проверкой')
  } else console.log('ok     мусор вместо адреса не наш приговор')

  // Подключение к инструментам, которые ходят в сеть сами: проверка стоит до
  // запуска и до спроса, иначе в «Авто» её просто нет.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main', 'main.js'), 'utf8')
  const from = main.indexOf('async function downloadVideoTool(')
  const branch = main.slice(from, main.indexOf('async function analyzeVideoTool(', from))
  if (from < 0 || !/autoLocalRefusal\(/.test(branch) ||
      branch.indexOf('autoLocalRefusal(') > branch.indexOf("requireMutationApproval(")) {
    failed++
    console.error('ПРОВАЛ [video_download] проверка адреса не стоит перед скачиванием')
  } else console.log('ok     video_download спрашивает правило «Авто» до скачивания')

  const mcp = main.indexOf("if (name === 'add_mcp_server')")
  const mcpBranch = main.slice(mcp, mcp + 1200)
  if (mcp < 0 || !/autoLocalRefusal\(config\.url/.test(mcpBranch)) {
    failed++
    console.error('ПРОВАЛ [add_mcp_server] адрес сервера в «Авто» не проверяется')
  } else console.log('ok     add_mcp_server проверяет адрес по тому же правилу')
}

autoRuleChecks().then(() => {
  console.log(JSON.stringify({ ok: failed === 0, checks: MUST_BE_PRIVATE.length + MUST_STAY_PUBLIC.length, failed }))
  process.exit(failed ? 1 : 0)
}, error => {
  console.error('ПРОВАЛ', error.message)
  process.exit(1)
})
