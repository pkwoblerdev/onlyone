// Стенд телефона для юнит-проверок: настоящие icons/i18n/en/render/provider/app.js
// из mobile/www, подменные Store и OnlyoneRemoteClient (сеть не трогаем).
// Разметка — из настоящего www/index.html. Приём перенесён из ломающего разбора
// break-3 (mobile-stand.cjs): модули исполняются как в браузере, без Electron.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { makeDom } = require('./dom-stand.cjs')
const ROOT = path.join(__dirname, '..', '..', 'mobile', 'www')

function loadPhone (options = {}) {
  const dom = makeDom()
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  dom.document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'))
    .replace(/<script[\s\S]*?<\/script>/gi, '')
  const requests = []
  const handlers = {}
  const remote = {
    state: { paired: { deviceKey: 'k', deviceId: 'd', desktopName: 'ПК', relay: 'wss://relay.test' }, status: 'online', chats: options.chats || [], chatsAt: 0, pending: { approvals: [], questions: [] } },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => {} },
    load: async () => {}, connect: () => {}, disconnect: () => {},
    pair: async () => {}, forget: async () => {},
    request: async (method, params) => { requests.push({ method, params }); return { ok: true } },
    refreshChats: async () => remote.state.chats,
    refreshPending: async () => remote.state.pending,
    DEFAULT_RELAY: 'wss://relay.test'
  }
  const fireRemote = (name, info) => { for (const fn of handlers[name] || []) fn(info) }
  const store = { get: async (k, f) => (k in (options.saved || {}) ? options.saved[k] : f), set: async (k, v) => { (options.saved || {})[k] = v }, remove: () => {}, wipe: () => {}, PREFIX: 'onlyone.' }
  const win = {
    OnlyoneStore: store,
    OnlyoneRemoteClient: { create: () => remote, DEFAULT_RELAY: remote.DEFAULT_RELAY },
    Capacitor: null,
    fetch: async () => { throw new Error('сеть в стенде запрещена') },
    addEventListener: () => {}, removeEventListener: () => {},
    innerWidth: 400, innerHeight: 800,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Event: class Event { constructor (type) { this.type = type } },
    crypto: { randomUUID: () => 'uid-' + Math.random().toString(16).slice(2) },
    TextDecoder: global.TextDecoder,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    marked: { parse: s => String(s) }
  }
  win.window = win
  const ctx = {
    window: win, document: dom.document, navigator: { userAgent: 'stand' },
    crypto: win.crypto, getComputedStyle: win.getComputedStyle, Event: win.Event,
    setTimeout, clearTimeout, setInterval, clearInterval, URL, TextDecoder: global.TextDecoder,
    localStorage: win.localStorage, console, Math, Date, JSON, String, Number, Object, Array, Boolean, Promise, Error, RegExp, Set, Map, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent
  }
  const run = file => {
    const src = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8')
    // eslint-disable-next-line no-new-func
    new Function(...Object.keys(ctx), src)(...Object.values(ctx))
  }
  for (const file of ['icons.js', 'i18n.js', 'en.js', 'render.js', 'provider.js', 'app.js']) run(file)
  return { dom, win, remote, requests, fireRemote, store, get app () { return win.__onlyone }, $: id => dom.document.getElementById(id) }
}

module.exports = { loadPhone }