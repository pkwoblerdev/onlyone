/* Удалённое управление onlyone: общий протокол компьютера и телефона (волна 4).
 *
 * Один и тот же файл работает в Node (главный процесс на Windows) и в WebView на Android, поэтому
 * только WebCrypto и ничего платформенного. Сервер-посредник (server/relay) видит лишь зашифрованные
 * пакеты и случайное имя «комнаты» — содержимого чатов у него нет.
 *
 *  1. СПАРИВАНИЕ. Компьютер показывает код вида ABCDE-FGHJK (50 бит, живёт 10 минут, одноразовый).
 *     Из кода выводится имя комнаты спаривания и ключ k0. Телефон входит в комнату и присылает свой
 *     открытый ключ ECDH P-256, зашифрованный k0: прочесть и подделать это без кода нельзя. Компьютер
 *     показывает человеку «Разрешить устройство?» и четыре цифры сверки (они одинаковы на обоих экранах и
 *     защищают от подмены посредником); после согласия присылает свой открытый ключ тем же способом.
 *     Общий секрет ECDH превращается в КЛЮЧ УСТРОЙСТВА, код гаснет.
 *  2. СЕАНС. Комната устройства — HMAC(ключ устройства, "room"): известна только им двоим. При входе
 *     стороны обмениваются случайными числами, и ключи сеанса выводятся из ключа устройства и этих чисел;
 *     каждый пакет шифруется AES-GCM со счётчиком (повтор и перестановка отвергаются).
 */
(function (root) {
  'use strict'

  const subtle = (root.crypto && root.crypto.subtle) || (typeof require === 'function' ? require('node:crypto').webcrypto.subtle : null)
  const getRandom = n => {
    const bytes = new Uint8Array(n)
    ;(root.crypto || require('node:crypto').webcrypto).getRandomValues(bytes)
    return bytes
  }
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  // Без смешиваемых знаков: нет 0/O, 1/I/L, U.
  const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
  const CODE_TTL_MS = 10 * 60 * 1000

  // ─── base64 / hex ───────────────────────────────────────────────────────────
  function toBase64(bytes) {
    let text = ''
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])
    return (root.btoa || (value => Buffer.from(value, 'binary').toString('base64')))(text)
  }
  function fromBase64(text) {
    const raw = (root.atob || (value => Buffer.from(value, 'base64').toString('binary')))(String(text))
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return bytes
  }
  const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  const fromHex = text => Uint8Array.from(String(text).match(/../g) || [], pair => parseInt(pair, 16))

  // ─── код доступа ────────────────────────────────────────────────────────────
  // Байт берётся, только если он меньше 240 (8 полных кругов по 30 знакам): `байт % 30`
  // от всех 256 значений давал первым 16 знакам лишний шанс (разбор REA 25.10).
  const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length)
  function makeCode() {
    let out = ''
    while (out.length < 10) {
      for (const byte of getRandom(16)) {
        if (byte < UNBIASED_LIMIT && out.length < 10) out += ALPHABET[byte % ALPHABET.length]
      }
    }
    return out.slice(0, 5) + '-' + out.slice(5)
  }
  // Код вводят как придётся: строчными, с пробелом или без дефиса — приводим к виду ABCDE-FGHJK.
  function normalizeCode(value) {
    const text = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    return text.length === 10 ? text.slice(0, 5) + '-' + text.slice(5) : ''
  }
  function validCode(value) {
    const code = normalizeCode(value)
    return Boolean(code) && [...code.replace('-', '')].every(ch => ALPHABET.includes(ch))
  }

  // ─── вывод ключей ───────────────────────────────────────────────────────────
  async function sha256(bytes) { return new Uint8Array(await subtle.digest('SHA-256', bytes)) }

  async function hkdf(secret, salt, info, bits = 256) {
    const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, base, bits))
  }

  async function aesKey(bytes) {
    return subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  }

  async function hmac(keyBytes, text) {
    const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return new Uint8Array(await subtle.sign('HMAC', key, enc.encode(text)))
  }

  async function pairingRoom(code) {
    const digest = await sha256(enc.encode('onlyone-pair-room:' + normalizeCode(code)))
    return 'p-' + toHex(digest.slice(0, 16))
  }
  async function codeKey(code) {
    const secret = enc.encode('onlyone-pair-key:' + normalizeCode(code))
    return aesKey(await hkdf(secret, new Uint8Array(32), 'pairing-aes'))
  }
  async function deviceRoom(deviceKey) {
    return 'd-' + toHex((await hmac(deviceKey, 'room')).slice(0, 16))
  }

  // ─── шифрование пакетов ─────────────────────────────────────────────────────
  // Пакет: 12 байт IV + шифртекст. Счётчик внутри открытого текста: {n, t, ...}.
  async function seal(key, object) {
    const iv = getRandom(12)
    const body = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(object))))
    const out = new Uint8Array(12 + body.length)
    out.set(iv, 0)
    out.set(body, 12)
    return toBase64(out)
  }
  async function open(key, text) {
    const bytes = fromBase64(text)
    if (bytes.length < 13 + 16) throw new Error('пакет слишком короткий')
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))
    return JSON.parse(dec.decode(plain))
  }

  // ─── ECDH ───────────────────────────────────────────────────────────────────
  async function newPair() {
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))
    return { privateKey: pair.privateKey, pub: toBase64(pub), pubBytes: pub }
  }
  async function sharedSecret(privateKey, otherPub) {
    const pub = await subtle.importKey('raw', fromBase64(otherPub), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256))
  }
  // Ключ устройства: из общего секрета, привязанного к обоим открытым ключам.
  async function makeDeviceKey(shared, pubDesktop, pubPhone) {
    const salt = await sha256(enc.encode(pubDesktop + '|' + pubPhone))
    return hkdf(shared, salt, 'onlyone-device-key', 256)
  }
  // Четыре цифры сверки: на экране компьютера и телефона обязаны совпасть.
  async function sasDigits(pubDesktop, pubPhone) {
    const digest = await sha256(enc.encode('onlyone-sas:' + pubDesktop + '|' + pubPhone))
    const number = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 10000
    return String(number).padStart(4, '0')
  }

  // ─── сеанс ──────────────────────────────────────────────────────────────────
  // Две стороны: 'd' (компьютер) и 'p' (телефон). Ключи на каждое направление свои, чтобы пакет, отправленный
  // в одну сторону, нельзя было выдать за пришедший из другой.
  async function makeSession(deviceKey, role, nonceMine, nonceTheirs) {
    const nonceD = role === 'd' ? nonceMine : nonceTheirs
    const nonceP = role === 'd' ? nonceTheirs : nonceMine
    const salt = await sha256(enc.encode(nonceD + '|' + nonceP))
    const toPhone = await aesKey(await hkdf(deviceKey, salt, 'session-d2p'))
    const toDesktop = await aesKey(await hkdf(deviceKey, salt, 'session-p2d'))
    const sendKey = role === 'd' ? toPhone : toDesktop
    const receiveKey = role === 'd' ? toDesktop : toPhone
    let sendCounter = 0
    let receiveCounter = 0
    return {
      async send(type, payload) {
        sendCounter += 1
        return seal(sendKey, { n: sendCounter, t: type, p: payload === undefined ? null : payload })
      },
      async receive(text) {
        const frame = await open(receiveKey, text)
        // Повтор и перестановка: счётчик должен строго расти.
        if (!(frame.n > receiveCounter)) throw new Error('повтор или перестановка пакета')
        receiveCounter = frame.n
        return { type: frame.t, payload: frame.p }
      }
    }
  }

  // Большое (снимок экрана) режется на куски под предел посредника и собирается обратно. Куски идут обычными
  // пакетами сеанса, поэтому шифруются и считаются так же.
  const CHUNK = 100 * 1024
  function splitBig(type, payload, limit = CHUNK) {
    const text = JSON.stringify(payload === undefined ? null : payload)
    if (text.length <= limit) return null
    const id = randomId()
    const count = Math.ceil(text.length / limit)
    const parts = []
    for (let i = 0; i < count; i++) parts.push({ id, i, n: count, t: type, d: text.slice(i * limit, (i + 1) * limit) })
    return parts
  }
  function makeAssembler() {
    const pending = new Map()
    return {
      // Возвращает {type, payload}, когда собраны все куски, иначе null.
      add(part) {
        if (!part || typeof part.id !== 'string' || !Number.isSafeInteger(part.n) || !(part.n > 0) || !Number.isSafeInteger(part.i) || !(part.i >= 0) || part.i >= part.n || part.n > 400) throw new Error('кривой кусок')
        let entry = pending.get(part.id)
        if (!entry) { entry = { n: part.n, t: part.t, got: new Map() }; pending.set(part.id, entry) }
        entry.got.set(part.i, String(part.d))
        if (pending.size > 20) pending.delete(pending.keys().next().value)
        if (entry.got.size < entry.n) return null
        pending.delete(part.id)
        let text = ''
        for (let i = 0; i < entry.n; i++) text += entry.got.get(i) || ''
        try {
          return { type: entry.t, payload: JSON.parse(text) }
        } catch {
          return null
        }
      }
    }
  }

  function randomNonce() { return toBase64(getRandom(16)) }
  function randomId() { return toHex(getRandom(8)) }

  const api = {
    ALPHABET, CODE_TTL_MS,
    makeCode, normalizeCode, validCode,
    pairingRoom, codeKey, deviceRoom,
    seal, open,
    newPair, sharedSecret, makeDeviceKey, sasDigits,
    makeSession, randomNonce, randomId, splitBig, makeAssembler, CHUNK,
    toBase64, fromBase64, toHex, fromHex
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyoneRemote = api
})(typeof window !== 'undefined' ? window : globalThis)
