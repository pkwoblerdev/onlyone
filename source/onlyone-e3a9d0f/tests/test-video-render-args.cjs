// break-5 Н7: video_render — аргументы ffmpeg от модели не проверялись: второй
// выход писал поверх файла вне рабочей папки, URL уводил данные на произвольный
// адрес. Тест исполняет настоящую ветку renderVideoTool и настоящие
// assertWorkspaceTargetFile/isInside из main.js в песочнице; ffmpeg подставной.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { checkCommand } = require('../src/main/command-guard.js')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}
const asyncCheck = async (name, fn) => {
  total++
  try { await fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const cut = (from, to) => {
  const start = mainSrc.indexOf(from)
  const end = to ? mainSrc.indexOf(to, start) : mainSrc.indexOf('\n}\n', start) + 3
  if (start < 0 || end <= start) throw new Error('не вырезано: ' + from)
  return mainSrc.slice(start, end)
}
const code = [
  cut('function isInside(root, target) {'),
  cut('async function assertInsideRoot('),
  cut('async function assertWorkspaceTargetFile('),
  cut('async function renderVideoTool(', 'async function renderHtmlVideoTool(')
].join('\n')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-video-args-'))
const wsRoot = path.join(base, 'work')
const outside = path.join(base, 'protected')
fs.mkdirSync(wsRoot, { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(wsRoot, 'in.mp4'), 'видео', 'utf8')
fs.writeFileSync(path.join(outside, 'settings.json'), '{"важное":true}', 'utf8')

const runTool = async args => {
  const calls = { renders: [], approvals: [] }
  const deps = {
    workspace: { permission: 'auto' },
    planModeRefusal: what => ({ success: false, denied: true, message: 'plan: ' + what }),
    ffmpegTools: () => ({
      status: async () => ({ found: true, ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' }),
      exec: async () => ({ code: 0, stdout: '', stderr: '' })
    }),
    assertSafeWorkspacePath: async p => path.resolve(wsRoot, String(p)),
    requireMutationApproval: async (event, summary, details, diff, risk) => { calls.approvals.push({ summary, risk }); return true },
    relativeDisplay: p => path.relative(wsRoot, p),
    fs: fsp,
    dirname: path.dirname,
    resolve: path.resolve,
    isAbsolute: path.isAbsolute,
    relative: path.relative,
    parse: path.parse,
    startRenderTask: () => ({ signal: null, progress: () => {}, finish: () => {} }),
    videoRenderLib: { render: async (tools, options) => { calls.renders.push(options); return { ok: true } } },
    finishRenderTool: (event, requestId, args, output, done) => ({ success: Boolean(done.ok), output }),
    workspaceRoots: () => [wsRoot],
    assertWorkspaceConfigured: () => {},
    tr: s => s
  }
  const fn = new Function('deps', `
    const { workspace, planModeRefusal, ffmpegTools, assertSafeWorkspacePath, requireMutationApproval,
      relativeDisplay, fs, dirname, resolve, isAbsolute, relative, parse, startRenderTask, videoRenderLib,
      finishRenderTool, workspaceRoots, assertWorkspaceConfigured, tr } = deps
    ${code}
    return renderVideoTool
  `)(deps)
  let result = null
  let error = null
  try { result = await fn({}, args, 'req-test', null) } catch (e) { error = e }
  return { result, error, calls }
}
const refused = ({ result, error, calls }) => {
  assert.ok(error || (result && result.success === false), 'вызов прошёл: ' + JSON.stringify(result))
  assert.equal(calls.renders.length, 0, 'ffmpeg запущен с непроверенными аргументами')
}

async function main() {
  await asyncCheck('второй выход вне рабочей папки отклонён', async () => {
    refused(await runTool({ output: 'out.mp4', args: ['-i', 'in.mp4', '-t', '0.1', '-f', 'mp4', path.join(outside, 'settings.json')] }))
    assert.equal(fs.readFileSync(path.join(outside, 'settings.json'), 'utf8'), '{"важное":true}')
  })
  await asyncCheck('сетевой выход (URL) отклонён', async () => {
    refused(await runTool({ output: 'out.mp4', args: ['-i', 'in.mp4', '-f', 'flv', 'http://127.0.0.1:9/exfil'] }))
  })
  await asyncCheck('сетевой вход (URL) отклонён', async () => {
    refused(await runTool({ output: 'out.mp4', args: ['-i', 'https://example.com/in.mp4'] }))
  })
  await asyncCheck('относительный выход наружу отклонён', async () => {
    refused(await runTool({ output: 'out.mp4', args: ['-i', 'in.mp4', path.join('..', 'protected', 'out.mp4')] }))
  })
  await asyncCheck('pipe: выход отклонён', async () => {
    refused(await runTool({ output: 'out.mp4', args: ['-i', 'in.mp4', '-f', 'mp4', 'pipe:1'] }))
  })

  await asyncCheck('контроль: законные аргументы доходят до ffmpeg', async () => {
    const { result, error, calls } = await runTool({
      output: 'out.mp4',
      args: ['-i', 'in.mp4', '-t', '0.1', '-c:v', 'libx264', '-vf', 'fps=30000/1001', '-preset', 'fast']
    })
    assert.ifError(error)
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(calls.renders.length, 1)
    assert.deepEqual(calls.renders[0].args, ['-i', 'in.mp4', '-t', '0.1', '-c:v', 'libx264', '-vf', 'fps=30000/1001', '-preset', 'fast'])
  })
  await asyncCheck('контроль: абсолютный путь внутри рабочей папки разрешён', async () => {
    const { result, error, calls } = await runTool({ output: 'out.mp4', args: ['-i', path.join(wsRoot, 'in.mp4')] })
    assert.ifError(error)
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(calls.renders.length, 1)
  })

  check('command-guard: ffmpeg с выходом в профиль запрещён (тот же слой)', () => {
    const verdict = checkCommand({
      command: `ffmpeg -i in.mp4 -f mp4 "${path.join(outside, 'settings.json')}"`,
      cwd: wsRoot, protectedRoots: [outside], env: {}, pid: 1, appNames: []
    })
    assert.equal(verdict.ok, false, 'ffmpeg пишет в защищённый корень, а guard пропускает')
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })
  .finally(() => { try { fs.rmSync(base, { recursive: true, force: true }) } catch {} })