'use strict'

// Строка текущего времени для хвоста запроса модели. Агент сам времени не знает, а команды времени в оболочке Windows
// (cmd.exe) ненадёжны: `Get-Date` там не существует, `date` ждёт ввода. Строка отдаёт местное время со смещением, UTC до
// секунд и ближайшую границу пятиминутного окна: рынки и графики живут по UTC и по времени биржи.

const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']
const pad = value => String(value).padStart(2, '0')

// offsetMinutes — как у Date.getTimezoneOffset(): UTC минус местное, в минутах (для UTC+3 это -180).
function clockNote (now, offsetMinutes = 0) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return ''
  const local = new Date(now.getTime() - offsetMinutes * 60000)
  const sign = offsetMinutes <= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const zone = 'UTC' + sign + Math.floor(abs / 60) + (abs % 60 ? ':' + pad(abs % 60) : '')
  const date = pad(local.getUTCDate()) + '.' + pad(local.getUTCMonth() + 1) + '.' + local.getUTCFullYear()
  const hm = pad(local.getUTCHours()) + ':' + pad(local.getUTCMinutes())
  const utcHm = pad(now.getUTCHours()) + ':' + pad(now.getUTCMinutes())
  const utcFull = utcHm + ':' + pad(now.getUTCSeconds())
  const next = new Date(Math.floor(now.getTime() / 300000) * 300000 + 300000)
  const nextUtc = pad(next.getUTCHours()) + ':' + pad(next.getUTCMinutes()) + ':00'
  return 'Сейчас ' + DAYS[local.getUTCDay()] + ' ' + date + ' ' + hm + ' местного времени (' + zone + '), ' + utcHm +
    ' UTC (точно ' + utcFull + ' UTC). Ближайшая граница 5-минутного окна — ' + nextUtc + ' UTC.'
}

module.exports = { clockNote }
