/* Данные только на телефоне и только зашифрованными: AES-GCM, ключ создан на устройстве и не извлекается
   (CryptoKey с extractable=false лежит в IndexedDB этого приложения; прочитать его байты нельзя даже из кода страницы).
   Резервное копирование Android выключено в манифесте, поэтому зашифрованные данные не уходят в облако. */
(function (root) {
  'use strict'
  const DB = 'onlyone-keys'
  const PREFIX = 'ob1.'
  let keyPromise = null

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('keys')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  const idb = (db, mode, fn) => new Promise((resolve, reject) => {
    const tx = db.transaction('keys', mode)
    const request = fn(tx.objectStore('keys'))
    tx.oncomplete = () => resolve(request && request.result)
    tx.onerror = () => reject(tx.error)
  })

  function dataKey() {
    if (!keyPromise) {
      keyPromise = (async () => {
        const db = await openDb()
        let key = await idb(db, 'readonly', store => store.get('data'))
        if (!key) {
          key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
          await idb(db, 'readwrite', store => store.put(key, 'data'))
        }
        return key
      })()
    }
    return keyPromise
  }

  const unb64 = text => Uint8Array.from(atob(text), ch => ch.charCodeAt(0))

  async function set(name, value) {
    const key = await dataKey()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const body = new TextEncoder().encode(JSON.stringify(value))
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body))
    const out = new Uint8Array(iv.length + sealed.length)
    out.set(iv); out.set(sealed, iv.length)
    // Большие значения режем: String.fromCharCode(...) на мегабайтах падает.
    let text = ''
    for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode(...out.subarray(i, i + 0x8000))
    localStorage.setItem(PREFIX + name, btoa(text))
  }

  async function get(name, fallback) {
    const raw = localStorage.getItem(PREFIX + name)
    if (!raw) return fallback
    try {
      const key = await dataKey()
      const bytes = unb64(raw)
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))
      return JSON.parse(new TextDecoder().decode(plain))
    } catch { return fallback }
  }

  function remove(name) { localStorage.removeItem(PREFIX + name) }
  function wipe() { for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key) }

  root.OnlyoneStore = { get, set, remove, wipe, PREFIX }
})(window)
