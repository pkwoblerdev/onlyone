// Посредник удалённого управления onlyone (волна 4).
//
// Компьютер и телефон входят в одну «комнату» по случайному имени и обмениваются пакетами, которые зашифрованы
// ключом, известным только им (src/shared/remote-protocol.js). Посредник их не читает, ничего не пишет на диск и
// не логирует содержимое: он только пересылает и сообщает, на месте ли собеседник.
//
// Протокол (текстовые JSON-кадры):
//   → {op:'join', room:'p-<32 hex>'|'d-<32 hex>', role:'d'|'p'}   вход в комнату (первое сообщение, 5 секунд)
//   ← {op:'joined', peer:true|false}                               вошёл; собеседник уже здесь или нет
//   ← {op:'peer', online:true|false}                               собеседник пришёл / ушёл
//   → {op:'msg', d:'<base64>'}  ⇄  {op:'msg', d:'<base64>'}        пакет собеседнику
//   ← {op:'err', code:'no-peer'|'bad-frame'|'rate'|'full'}         отказ
// В комнате по одной стороне каждой роли: новый вход той же роли вытесняет прежний (код закрытия 4001).
const http = require('node:http')
const { WebSocketServer } = require('ws')

const ROOM_RX = /^[pd]-[0-9a-f]{32}$/
const JOIN_TIMEOUT_MS = 5000
const PING_MS = 25000
const DEAD_MS = 65000
const PAIR_ROOM_TTL_MS = 15 * 60 * 1000
// Комната устройства живёт, пока в ней есть движение: без срока удерживаемые
// комнаты исчерпывали MAX_ROOMS до перезапуска (break-5 Н4). Срок большой —
// телефон может быть офлайн сутки; DeviceLink переподключается сам.
const DEVICE_ROOM_TTL_MS = 24 * 60 * 60 * 1000
const MAX_PAYLOAD = 512 * 1024
const RATE_PER_SEC = 80
const MAX_ROOMS = 5000
const MAX_PER_IP = 24

function createRelay(options = {}) {
  const rooms = new Map()      // имя → { d, p, createdAt }
  const perIp = new Map()
  const stats = { joined: 0, forwarded: 0, rejected: 0 }
  const now = options.now || (() => Date.now())

  const server = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok rooms=' + rooms.size)
      return
    }
    response.writeHead(404)
    response.end()
  })
  const wss = new WebSocketServer({ server, maxPayload: options.maxPayload || MAX_PAYLOAD })

  const send = (socket, frame) => { try { if (socket.readyState === 1) socket.send(JSON.stringify(frame)) } catch { /* сокет закрывается */ } }
  const other = role => (role === 'd' ? 'p' : 'd')

  function leave(socket) {
    const room = socket.room && rooms.get(socket.room)
    if (!room) return
    if (room[socket.role] === socket) {
      room[socket.role] = null
      send(room[other(socket.role)], { op: 'peer', online: false })
    }
    if (!room.d && !room.p) rooms.delete(socket.room)
  }

  wss.on('connection', (socket, request) => {
    // X-Forwarded-For доверяем только прокси на этой же машине (штатный nginx
    // перезаписывает заголовок $remote_addr): клиентский XFF при прямом доступе
    // давал каждому соединению свой счётчик и снимал лимит на IP (break-5 Н4).
    const peer = (request.socket && request.socket.remoteAddress) || '?'
    const trustedProxies = options.trustProxyFrom || ['127.0.0.1', '::1', '::ffff:127.0.0.1']
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim()
    const ip = (forwarded && trustedProxies.includes(peer)) ? forwarded : peer
    const used = (perIp.get(ip) || 0) + 1
    if (used > (options.maxPerIp || MAX_PER_IP)) { send(socket, { op: 'err', code: 'full' }); socket.close(4003); return }
    perIp.set(ip, used)
    socket.ip = ip
    socket.alive = true
    socket.lastSeen = now()
    socket.tokens = RATE_PER_SEC
    socket.refilled = now()
    const joinTimer = setTimeout(() => { if (!socket.room) socket.close(4000) }, options.joinTimeout || JOIN_TIMEOUT_MS)

    socket.on('pong', () => { socket.alive = true; socket.lastSeen = now() })
    socket.on('message', raw => {
      socket.lastSeen = now()
      // Ведро на секунду: тот, кто засыпает комнату пакетами, получает отказ, а не место в очереди.
      const at = now()
      socket.tokens = Math.min(RATE_PER_SEC, socket.tokens + ((at - socket.refilled) / 1000) * RATE_PER_SEC)
      socket.refilled = at
      if (socket.tokens < 1) { send(socket, { op: 'err', code: 'rate' }); stats.rejected++; return }
      socket.tokens -= 1
      let frame
      try { frame = JSON.parse(String(raw)) } catch { send(socket, { op: 'err', code: 'bad-frame' }); return }
      if (!frame || typeof frame !== 'object') { send(socket, { op: 'err', code: 'bad-frame' }); return }

      if (frame.op === 'join') {
        if (socket.room) return
        if (!ROOM_RX.test(String(frame.room || '')) || (frame.role !== 'd' && frame.role !== 'p')) { send(socket, { op: 'err', code: 'bad-frame' }); socket.close(4002); return }
        let room = rooms.get(frame.room)
        if (!room) {
          if (rooms.size >= (options.maxRooms || MAX_ROOMS)) { send(socket, { op: 'err', code: 'full' }); socket.close(4003); return }
          room = { d: null, p: null, createdAt: now(), lastActive: now() }
          rooms.set(frame.room, room)
        }
        room.lastActive = now()
        const previous = room[frame.role]
        if (previous && previous !== socket) { previous.room = null; try { previous.close(4001) } catch { /* уже закрыт */ } }
        room[frame.role] = socket
        socket.room = frame.room
        socket.role = frame.role
        clearTimeout(joinTimer)
        stats.joined++
        const peer = room[other(frame.role)]
        send(socket, { op: 'joined', peer: Boolean(peer) })
        if (peer) send(peer, { op: 'peer', online: true })
        return
      }

      if (frame.op === 'msg') {
        const room = socket.room && rooms.get(socket.room)
        if (!room) { send(socket, { op: 'err', code: 'bad-frame' }); return }
        if (typeof frame.d !== 'string') { send(socket, { op: 'err', code: 'bad-frame' }); return }
        room.lastActive = now()
        const peer = room[other(socket.role)]
        if (!peer) { send(socket, { op: 'err', code: 'no-peer' }); return }
        stats.forwarded++
        send(peer, { op: 'msg', d: frame.d })
        return
      }
      send(socket, { op: 'err', code: 'bad-frame' })
    })
    socket.on('close', () => {
      clearTimeout(joinTimer)
      leave(socket)
      const left = (perIp.get(ip) || 1) - 1
      if (left > 0) perIp.set(ip, left); else perIp.delete(ip)
    })
    socket.on('error', () => { /* закрытие придёт отдельно */ })
  })

  // Живость и уборка: молчащих закрываем, комнаты спаривания старше 15 минут убираем.
  const sweep = setInterval(() => {
    const at = now()
    for (const socket of wss.clients) {
      if (!socket.alive && at - socket.lastSeen > (options.deadMs || DEAD_MS)) { socket.terminate(); continue }
      socket.alive = false
      try { socket.ping() } catch { /* закрывается */ }
    }
    for (const [name, room] of rooms) {
      // Спаривание живёт от создания, устройство — от последнего движения:
      // иначе удерживаемые комнаты d- заполняли MAX_ROOMS навсегда.
      const expired = name.startsWith('p-')
        ? at - room.createdAt > PAIR_ROOM_TTL_MS
        : at - (room.lastActive || room.createdAt) > (options.deviceRoomTtlMs || DEVICE_ROOM_TTL_MS)
      if (expired) {
        for (const socket of [room.d, room.p]) { if (socket) { socket.room = null; try { socket.close(4004) } catch { /* уже закрыт */ } } }
        rooms.delete(name)
      }
    }
  }, options.pingMs || PING_MS)
  sweep.unref()

  return {
    server,
    stats,
    rooms: () => rooms.size,
    listen: (port, host) => new Promise(resolve => server.listen(port, host || '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => {
      clearInterval(sweep)
      for (const socket of wss.clients) socket.terminate()
      wss.close(() => server.close(() => resolve()))
    })
  }
}

module.exports = { createRelay, ROOM_RX }

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787
  const relay = createRelay()
  relay.listen(port, process.env.HOST || '127.0.0.1').then(bound => {
    process.stdout.write('onlyone-relay слушает порт ' + bound + '\n')
  })
  const stop = () => relay.close().then(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
