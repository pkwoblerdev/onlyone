// Замер префикса запроса к модели (11.10.2026): сколько уходит на системный промпт, описания инструментов и историю
// в обычном агентном ходе. Не входит в npm test: печатает таблицу, ничего не утверждает.
//   node tests/measure-prompt-cost.cjs            — «Привет» и рабочая просьба с чтением файла
//   node tests/measure-prompt-cost.cjs --sections — ещё и разбивка системного промпта по разделам
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-prompt-cost')
const sections = process.argv.includes('--sections')

function run (name, { turns, prompt, files = {} }) {
  const base = path.join(out, name)
  const workspace = path.join(base, 'workspace')
  const profile = path.join(base, 'profile')
  const dumpDir = path.join(base, 'dump')
  for (const dir of [workspace, profile, dumpDir]) fs.mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(workspace, file), content)
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
  }))
  const providerFile = path.join(base, 'provider.json')
  fs.writeFileSync(providerFile, JSON.stringify({ turns }))
  const script = path.join(base, 'renderer.js')
  const resultFile = path.join(base, 'result.json')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 60000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (fn()) return true } catch {}; await wait(120) } return false }
    await until(() => document.documentElement.dataset.appReady === '1')
    await wait(500)
    $('newChatBtn')?.click(); await wait(400)
    const box = $('composerTextarea'); box.value = ${JSON.stringify(prompt)}
    box.dispatchEvent(new Event('input', { bubbles: true })); await wait(150)
    $('composerForm').requestSubmit()
    await until(() => $('sendBtn')?.classList.contains('is-stop'), 20000)
    await until(() => !$('sendBtn')?.classList.contains('is-stop'), 90000)
    await wait(800)
    return { ok: true, checks: [] }
  })()`)
  spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 240000, stdio: 'ignore',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_PROVIDER_DUMP: dumpDir, ONECODE_PROVIDER_LOG: path.join(base, 'requests.log') })
  })
  const files2 = fs.readdirSync(dumpDir).filter(f => f.startsWith('request-')).sort()
  console.log(`\n== ${name}: запросов ${files2.length} ==`)
  files2.forEach((file, i) => {
    const body = JSON.parse(fs.readFileSync(path.join(dumpDir, file), 'utf8')).body
    const text = m => typeof m.content === 'string' ? m.content : (m.content || []).map(p => p.text || '').join('')
    const system = body.messages.filter(m => m.role === 'system').map(text).join('\n')
    const rest = body.messages.filter(m => m.role !== 'system').map(m => text(m) + JSON.stringify(m.tool_calls || '')).join('')
    const tools = JSON.stringify(body.tools || [])
    const kb = n => (n / 1024).toFixed(1).padStart(5) + ' КБ'
    console.log(`  #${i + 1}  system ${kb(Buffer.byteLength(system))}  tools ${kb(Buffer.byteLength(tools))} (${(body.tools || []).length})  история ${kb(Buffer.byteLength(rest))}  max_tokens=${body.max_tokens ?? '—'} reasoning=${JSON.stringify(body.reasoning || null)}`)
    if (sections && i === 0) {
      const parts = system.split(/\n(?=<[a-z_]+>|#{1,3} )/)
      parts.map(p => ({ head: p.slice(0, 70).replace(/\s+/g, ' '), size: Buffer.byteLength(p) }))
        .sort((a, b) => b.size - a.size).slice(0, 14)
        .forEach(p => console.log(`      ${kb(p.size)}  ${p.head}`))
      fs.writeFileSync(path.join(base, 'system.txt'), system)
      console.log('      полный текст: ' + path.join(base, 'system.txt'))
    }
    if (sections && i === 0) fs.writeFileSync(path.join(base, 'tools.json'), JSON.stringify(body.tools, null, 1))
  })
}

run('privet', { prompt: 'Привет', turns: [{ text: 'Привет! Чем помочь?' }] })
run('rabota', {
  prompt: 'Прочитай a.js и скажи, что в нём не так.',
  files: { 'a.js': 'function add(a, b) {\n  return a - b\n}\nmodule.exports = add\n' },
  turns: [
    { toolCalls: [{ name: 'read_file', args: { path: 'a.js' } }], text: 'Читаю.' },
    { text: 'add вычитает вместо сложения.' },
    { content: 'ВЕРДИКТ: ГОТОВО' }
  ]
})
