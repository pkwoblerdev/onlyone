// Режим «html» сквозного прогона видео (см. run-video-ui.cjs): отдельное звено, чтобы каждая проверка в общем прогоне звучала один раз.
process.argv[2] = 'html'
require('./run-video-ui.cjs')
