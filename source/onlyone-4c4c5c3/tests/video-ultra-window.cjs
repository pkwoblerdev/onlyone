// Режим «ultra» сквозного прогона видео (см. run-video-ui.cjs): отдельное звено, чтобы каждая проверка в общем прогоне звучала один раз.
process.argv[2] = 'ultra'
require('./run-video-ui.cjs')
