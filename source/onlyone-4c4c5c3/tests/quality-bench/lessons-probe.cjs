'use strict'
// Зонд уроков стенда: отдельный запуск Electron без окон на профиле попытки.
// seed — кладёт уроки по шагам человека (предложить/включить/исправить/отозвать)
// в настоящее зашифрованное хранилище уроков и ждёт, пока Chromium сохранит ключ;
// collect — читает состояния и считает тот же promptBlock, что main.js отдаёт ходу.
// Тексты уроков в отчёт не попадают: только ключи зерна и состояния.
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const mode = process.env.ONECODE_BENCH_LESSONS_MODE
const out = process.env.ONECODE_BENCH_LESSONS_OUT
const seedFile = process.env.ONECODE_BENCH_LESSONS_SEED
const projectId = String(process.env.ONECODE_BENCH_LESSONS_PROJECT || '')
const request = String(process.env.ONECODE_BENCH_LESSONS_REQUEST || '')
app.on('window-all-closed', () => {})
const finish = (value, code) => {
  try { fs.writeFileSync(out + '.tmp', JSON.stringify(value)); fs.renameSync(out + '.tmp', out) } catch { /* код выхода скажет */ }
  app.exit(code)
}
app.whenReady().then(() => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return finish({ ok: false, error: 'encryption-unavailable' }, 1)
    const lessonsLib = require('../../src/main/project-lessons.cjs')
    const { applySeed } = require('../../scripts/quality-bench/lessons.cjs')
    const store = require('../../src/main/mods-store.cjs').createStore({ file: path.join(app.getPath('userData'), 'lessons.json'),
      protect: text => safeStorage.encryptString(text).toString('base64'),
      unprotect: body => safeStorage.decryptString(Buffer.from(body, 'base64')) })
    const service = lessonsLib.createLessons({ storage: store })
    const fixture = JSON.parse(fs.readFileSync(seedFile, 'utf8'))
    if (mode === 'seed') {
      const seeded = applySeed(service, fixture)
      if (!seeded.ok) return finish({ ok: false, error: 'seed-failed', step: seeded.step, code: seeded.code }, 1)
      // Ключ шифрования Chromium пишется в Local State с задержкой. Выйти раньше —
      // значит оставить уроки, которые приложение потом не расшифрует.
      const state = path.join(app.getPath('userData'), 'Local State')
      const deadline = Date.now() + 30000
      const wait = () => {
        let flushed = false
        try { flushed = fs.readFileSync(state, 'utf8').includes('os_crypt') } catch { flushed = false }
        if (flushed) return finish({ ok: true, ids: seeded.ids }, 0)
        if (Date.now() > deadline) return finish({ ok: false, error: 'key-not-persisted' }, 1)
        return setTimeout(wait, 100)
      }
      return wait()
    }
    if (mode === 'collect') {
      const projects = {}
      for (const project of fixture.projects || []) {
        const listed = service.list(project)
        if (!listed.ok) return finish({ ok: false, error: 'list-failed', project }, 1)
        projects[project] = listed.lessons.map(item => ({ id: item.id, text: item.text, status: item.status }))
      }
      let prompt = null
      if (projectId) {
        try { prompt = service.promptBlock(projectId, { request, mode: 'agent' }) } catch { prompt = null }
      }
      return finish({ ok: true, projects, prompt }, 0)
    }
    return finish({ ok: false, error: 'unknown-mode' }, 1)
  } catch (error) { return finish({ ok: false, error: String(error && error.message || error).slice(0, 120) }, 1) }
}).catch(() => app.exit(1))
