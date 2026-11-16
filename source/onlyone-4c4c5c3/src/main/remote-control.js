// Удалённое управление onlyone с телефона (волна 4): ядро на стороне компьютера.
//
// Работает, только пока onlyone открыт и функция включена (по умолчанию выключена). Телефон спаривается по
// одноразовому коду, новое устройство подтверждает человек на компьютере; дальше телефон видит чаты, где включена
// команда /remote-control, и может в них писать, останавливать ход и отвечать на разрешения и вопросы.
// Всё идёт через посредника зашифрованным ключом устройства (src/shared/remote-*.js): посредник текст не читает.
//
// Модуль не знает ни Electron, ни окна: всё внешнее приходит в `deps`, поэтому его проверяют без сети и окна.
const { PairingHost } = require('../shared/remote-pairing.js')
const { DeviceLink } = require('../shared/remote-link.js')
const proto = require('../shared/remote-protocol.js')

const PROTOCOL = 1
const MAX_DEVICES = 8
const AUDIT_LIMIT = 200
const SOFT_RISKS = new Set(['read', 'edit'])
const DESTRUCTIVE_WORDS = /удал|снос|стер|очист|форматир|delete|remove|\brm\b|drop |wipe|truncate|reset --hard|force/i

const toHex = bytes => proto.toHex(bytes)
const fromHex = text => proto.fromHex(text)

function createRemoteControl(deps) {
  const WebSocketImpl = deps.WebSocketImpl
  const relayUrl = deps.relayUrl
  const store = deps.store                       // { read(): object, write(object) }
  const askRenderer = deps.askRenderer           // async (method, params) => result
  const confirmDevice = deps.confirmDevice       // async ({ name, sas }) => boolean
  const listApprovals = deps.listApprovals       // () => [{ id, requestId, summary, details, risk, kind: 'approval' }]
  const resolveApproval = deps.resolveApproval   // (id, approved) => boolean
  const listQuestions = deps.listQuestions       // () => [{ id, requestId, question, options, asker, note }]
  const resolveQuestion = deps.resolveQuestion   // (id, answer) => boolean
  const abortRun = deps.abortRun                 // (requestId) => boolean
  const onChange = deps.onChange || (() => {})
  const desktopName = deps.desktopName || 'Компьютер'
  const version = deps.version || ''
  const now = deps.now || (() => Date.now())

  let data = normalize(store.read())
  const links = new Map()                        // deviceId → DeviceLink
  let pairing = null
  let pairingInfo = null
  let started = false

  function normalize(raw) {
    const out = { enabled: false, devices: [], audit: [] }
    if (!raw || typeof raw !== 'object') return out
    out.enabled = Boolean(raw.enabled)
    for (const device of Array.isArray(raw.devices) ? raw.devices : []) {
      if (!device || typeof device.id !== 'string' || !/^[0-9a-f]{64}$/.test(String(device.key || ''))) continue
      out.devices.push({ id: device.id, name: String(device.name || 'Телефон').slice(0, 60), key: device.key, createdAt: Number(device.createdAt) || 0, lastSeen: Number(device.lastSeen) || 0 })
    }
    out.devices = out.devices.slice(0, MAX_DEVICES)
    out.audit = (Array.isArray(raw.audit) ? raw.audit : []).slice(-AUDIT_LIMIT)
    return out
  }

  function save() { try { store.write(data) } catch { /* диск недоступен: работаем из памяти */ } }
  function audit(entry) {
    data.audit.push({ at: now(), ...entry })
    if (data.audit.length > AUDIT_LIMIT) data.audit = data.audit.slice(-AUDIT_LIMIT)
    save()
  }

  // ─── состояние для окна настроек ──────────────────────────────────────────
  function state() {
    return {
      enabled: data.enabled && Boolean(relayUrl),
      relay: relayUrl,
      desktopName,
      pairing: pairingInfo ? { code: pairingInfo.code, expiresAt: pairingInfo.expiresAt, link: pairingLink(pairingInfo.code), pending: pairingInfo.pending || null } : null,
      devices: data.devices.map(device => ({
        id: device.id, name: device.name, createdAt: device.createdAt, lastSeen: device.lastSeen,
        online: Boolean(links.get(device.id) && links.get(device.id).state === 'online')
      })),
      audit: data.audit.slice(-30)
    }
  }
  const pairingLink = code => 'onlyone://pair?code=' + encodeURIComponent(code) + '&relay=' + encodeURIComponent(relayUrl)
  const changed = () => { try { onChange(state()) } catch { /* окно закрыто */ } }

  // ─── обработчики запросов телефона ─────────────────────────────────────────
  function handlersFor(device) {
    const safe = p => p && typeof p === 'object' ? p : {}
    const remoteOnly = async (method, params) => askRenderer(method, safe(params), device)
    return {
      hello: async () => ({ protocol: PROTOCOL, desktopName, version, deviceName: device.name }),
      'chats.list': () => remoteOnly('chats.list'),
      'chat.get': params => {
        const p = safe(params)
        return remoteOnly('chat.get', { id: String(p.id || ''), limit: Math.min(200, Math.max(1, Number(p.limit) || 60)) })
      },
      'chat.send': async params => {
        const p = safe(params)
        const text = String(p.text || '').trim()
        if (!text) throw new Error('пустое сообщение')
        audit({ device: device.id, what: 'send', chat: String(p.id || '').slice(0, 40) })
        return remoteOnly('chat.send', { id: String(p.id || ''), text: text.slice(0, 20000), model: p.model, effort: p.effort })
      },
      'chat.stop': async params => {
        const p = safe(params)
        const run = await remoteOnly('chat.run', { id: String(p.id || '') })
        if (!run || !run.requestId) return { stopped: false }
        audit({ device: device.id, what: 'stop', chat: String(p.id || '').slice(0, 40) })
        return { stopped: Boolean(abortRun(run.requestId)) }
      },
      'chat.settings': params => {
        const p = safe(params)
        return remoteOnly('chat.settings', { id: String(p.id || ''), model: p.model, effort: p.effort })
      },
      'models.list': () => remoteOnly('models.list'),
      'pending.list': async () => ({ approvals: await visibleApprovals(), questions: await visibleQuestions() }),
      'approval.answer': async params => {
        const p = safe(params)
        const id = String(p.id || '')
        const found = await ownedPending(listApprovals, id)
        if (!found) throw new Error('запрос уже не активен')
        const approved = Boolean(p.approved)
        // Опасное разрешается вторым шагом: телефон присылает confirmed только после удержания или кода.
        if (approved && isDangerous(found) && p.confirmed !== true) throw new Error('нужно второе подтверждение')
        audit({ device: device.id, what: approved ? 'approve' : 'reject', risk: found.risk, summary: String(found.summary || '').slice(0, 160) })
        return { ok: Boolean(resolveApproval(id, approved)) }
      },
      'question.answer': async params => {
        const p = safe(params)
        const id = String(p.id || '')
        const answer = String(p.answer || '').trim()
        if (!answer) throw new Error('пустой ответ')
        if (!await ownedPending(listQuestions, id)) throw new Error('вопрос уже не активен')
        audit({ device: device.id, what: 'answer', summary: answer.slice(0, 80) })
        return { ok: Boolean(resolveQuestion(id, answer)) }
      },
      'chat.shot': params => remoteOnly('chat.shot', { id: String(safe(params).id || '') }),
      'tasks.get': params => remoteOnly('tasks.get', { id: String(safe(params).id || '') })
    }
  }

  const isDangerous = approval => !SOFT_RISKS.has(String(approval.risk || 'edit')) || DESTRUCTIVE_WORDS.test(String(approval.summary || '') + ' ' + String(approval.details || ''))

  // Телефону показываем только то, что относится к чатам с включённым /remote-control.
  async function runOwners() {
    try { return (await askRenderer('runs.owners', {})) || {} } catch { return {} }
  }
  // Ответ телефону разрешён только на то, что ему и показано: тот же фильтр владельцев чатов.
  // Не прочитали владельцев (окно закрыто) — отказ, а не разрешение всего.
  async function ownedPending(list, id) {
    const found = list().find(item => item.id === id)
    if (!found) return null
    const owners = await runOwners()
    return owners[found.requestId] ? found : null
  }
  async function visibleApprovals() {
    const owners = await runOwners()
    return listApprovals().filter(item => owners[item.requestId]).map(item => ({
      id: item.id, chat: owners[item.requestId], summary: item.summary, details: String(item.details || '').slice(0, 4000),
      diff: item.diff ? String(item.diff).slice(0, 8000) : '', risk: item.risk || 'edit', dangerous: isDangerous(item)
    }))
  }
  async function visibleQuestions() {
    const owners = await runOwners()
    return listQuestions().filter(item => owners[item.requestId]).map(item => ({
      id: item.id, chat: owners[item.requestId], question: item.question, asker: item.asker || '', note: item.note || '',
      options: (item.options || []).map(option => ({ label: option.label, detail: option.detail || '' }))
    }))
  }

  // ─── связь с устройствами ───────────────────────────────────────────────────
  async function connectDevice(device) {
    if (links.has(device.id)) return
    const link = new DeviceLink({ url: relayUrl, deviceKey: fromHex(device.key), role: 'd', WebSocketImpl, handlers: handlersFor(device) })
    links.set(device.id, link)
    link.on('status', status => {
      if (status === 'online') { device.lastSeen = now(); save() }
      changed()
    })
    await link.start()
  }

  function dropLink(id) {
    const link = links.get(id)
    if (link) { link.stop(); links.delete(id) }
  }

  async function start() {
    if (!relayUrl) return
    if (started) return
    started = true
    if (!data.enabled) return
    for (const device of data.devices) await connectDevice(device)
  }

  async function setEnabled(value) {
    if (value && !relayUrl) throw new Error('Удалённое управление недоступно: сервер не настроен.')
    data.enabled = Boolean(value)
    save()
    if (data.enabled) { started = false; await start() } else {
      cancelPairing()
      for (const id of [...links.keys()]) dropLink(id)
      started = false
    }
    changed()
    return state()
  }

  // ─── спаривание ─────────────────────────────────────────────────────────────
  async function beginPairing() {
    if (!relayUrl) throw new Error('Удалённое управление недоступно: сервер не настроен.')
    if (!data.enabled) throw new Error('Удалённое управление выключено')
    if (data.devices.length >= MAX_DEVICES) throw new Error('Достигнут предел устройств: отключите ненужные')
    cancelPairing()
    const host = new PairingHost({
      url: relayUrl, WebSocketImpl, desktopName,
      onRequest: async info => {
        if (pairingInfo) { pairingInfo.pending = { name: info.name, sas: info.sas }; changed() }
        const ok = await confirmDevice(info)
        audit({ what: ok ? 'pair-approved' : 'pair-denied', name: info.name })
        return ok
      },
      onPaired: async paired => {
        const device = { id: paired.deviceId, name: paired.name, key: toHex(paired.deviceKey), createdAt: now(), lastSeen: now() }
        data.devices.push(device)
        save()
        await connectDevice(device)
        changed()
      },
      onEnd: () => { if (pairing === host) { pairing = null; pairingInfo = null; changed() } }
    })
    pairing = host
    const begun = await host.start()
    pairingInfo = { code: begun.code, expiresAt: begun.expiresAt, pending: null }
    changed()
    return state().pairing
  }
  function cancelPairing() {
    const host = pairing
    pairing = null
    pairingInfo = null
    if (host) host.cancel()
  }

  function revoke(id) {
    const before = data.devices.length
    data.devices = data.devices.filter(device => device.id !== id)
    dropLink(id)
    if (data.devices.length !== before) audit({ what: 'revoke', device: id })
    save()
    changed()
    return state()
  }
  function revokeAll() {
    for (const id of [...links.keys()]) dropLink(id)
    const count = data.devices.length
    data.devices = []
    if (count) audit({ what: 'revoke-all', count })
    save()
    changed()
    return state()
  }

  // ─── события телефонам ──────────────────────────────────────────────────────
  async function broadcast(name, payload) {
    for (const link of links.values()) { if (link.state === 'online') await link.emit(name, payload) }
  }
  function stop() {
    cancelPairing()
    for (const id of [...links.keys()]) dropLink(id)
    started = false
  }

  return { start, stop, state, setEnabled, beginPairing, cancelPairing, revoke, revokeAll, broadcast, links, isDangerous, PROTOCOL, handlersFor }
}

module.exports = { createRemoteControl, PROTOCOL, DESTRUCTIVE_WORDS }
