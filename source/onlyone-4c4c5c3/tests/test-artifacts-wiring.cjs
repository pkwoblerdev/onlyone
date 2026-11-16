// Проводка артефактов (план, 3.2): чтобы инструменты, схема, окно и политика
// содержимого сходились. Само хранилище проверяется в test-artifacts.cjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const artifactPanel = require('../src/renderer/artifact-panel.js')
const chartPanel = artifactPanel.create({
  $: () => null,
  t: key => key,
  escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]),
  document: {}
})

const main = read('src', 'main', 'main.js')
const preload = read('src', 'preload', 'preload.js')
const html = read('src', 'renderer', 'index.html')
const designTools = read('src', 'main', 'design', 'tools.js')
const artifactsPrompt = read('src', 'main', 'mode-prompts', 'artifacts.js')

const failures = []
function test(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

const ARTIFACT_TOOLS = ['show_artifact', 'update_artifact', 'show_video', 'artifacts_list']

test('инструменты заявлены, подписаны и доходят до выполнения', () => {
  for (const name of ARTIFACT_TOOLS) {
    assert.ok(main.includes(`name: '${name}'`), `нет схемы ${name}`)
    assert.ok(new RegExp(`${name}: '`).test(main), `${name} без подписи в TOOL_VERBS`)
    assert.match(main, new RegExp(`if \\(name === '${name}'\\) return await`), `${name} не подключён в executeTool`)
  }
})

test('в разделе «Дизайн» артефакты недоступны — там dc_*', () => {
  const guard = /if \(design && !\[([^\]]*)\]\.includes\(name\)\) throw/.exec(main)
  assert.ok(guard, 'не найден барьер дизайн-хода')
  for (const name of ARTIFACT_TOOLS) {
    assert.ok(!guard[1].includes(name), `${name} просочился в дизайн-ход`)
  }
  assert.ok(!designTools.includes('show_artifact'), 'в списке dc_* не должно быть артефактов чата')
})

test('схема onecode-artifact объявлена и подключена', () => {
  assert.match(main, /scheme: 'onecode-artifact'/, 'схема не заявлена как привилегированная')
  assert.match(main, /protocol\.handle\('onecode-artifact', serveArtifactFile\)/, 'обработчик не подключён')
  // Путь обязан разрешаться внутри каталога одного артефакта.
  const server = /async function serveArtifactFile\([\s\S]*?\n}\n/.exec(main)
  assert.ok(server, 'не найден serveArtifactFile')
  assert.match(server[0], /resolveServed\(|servedFile\(/, 'отдача идёт мимо проверки каталога')
  assert.match(server[0], /realpath/, 'проверка лексическая, без разрешения симлинков')
  assert.match(server[0], /'forbidden', \{ status: 403 \}/, 'выход наружу не отклоняется')
})

test('мост окна и каналы совпадают', () => {
  const channels = [...preload.matchAll(/ipcRenderer\.invoke\('([a-z\-]*artifact[a-z\-]*)'/g)].map(m => m[1])
  assert.deepEqual(channels.sort(), ['archive-artifact', 'export-artifact', 'get-artifacts', 'rename-artifact', 'reveal-artifact', 'save-artifact-version'])
  for (const channel of channels) {
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `в главном процессе нет обработчика ${channel}`)
  }
  assert.match(preload, /onArtifactChanged/, 'окно не слушает изменения артефактов')
  assert.match(main, /broadcastToWindows\('artifact-changed'/, 'изменение не уходит в окна')
})

test('политика содержимого пускает схему артефактов туда, куда нужно', () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1]
  const directive = name => (new RegExp(`${name} ([^;]+)`).exec(csp) || [])[1] || ''
  assert.match(directive('frame-src'), /onecode-artifact:/, 'превью страницы не пустит frame-src')
  assert.match(directive('img-src'), /onecode-artifact:/, 'картинку не пустит img-src')
  assert.match(directive('connect-src'), /onecode-artifact:/, 'текст кода и диффа не прочитать без connect-src')
  assert.ok(!/'unsafe-eval'/.test(csp), 'политика не должна ослабевать до unsafe-eval')
})

test('панель артефактов живёт своим модулем, а не в ленте чата (план, 2d)', () => {
  const panelPath = path.join(root, 'src/renderer/artifact-panel.js')
  assert.ok(fs.existsSync(panelPath), 'нет файла модуля панели')
  const panel = fs.readFileSync(panelPath, 'utf8')
  const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8')
  // Экран со своим состоянием: проводка остаётся в чате, само поведение — в модуле.
  for (const name of ['showArtifact', 'closeArtifactPanel', 'refreshArtifactChips', 'artifactTableHtml']) {
    assert.ok(panel.includes(name), `поведение панели не в модуле: ${name}`)
  }
  // В app.js не должно остаться тела панели — имена-обёртки там правы.
  for (const body of ['function artifactTableHtml', 'const ARTIFACT_TABLE_ROWS', 'function fillArtifactVersions']) {
    assert.equal(app.includes(body), false, `в app.js снова появилось «${body}»`)
  }
  // Смысл один: панель подключена своим модулем до app.js. Соседство тегов
  // держаться не может — между ними встал chat-context.js (3.7). Здесь строже
  // обеих прежних формулировок: ещё и что тег ровно один.
  const panelTag = html.indexOf('<script src="artifact-panel.js"></script>')
  const appTag = html.indexOf('<script src="app.js"></script>')
  assert.ok(panelTag >= 0, 'модуль панели не подключён в index.html')
  assert.equal(html.split('<script src="artifact-panel.js"></script>').length - 1, 1, 'тег панели в index.html не один')
  assert.ok(appTag > panelTag, 'модуль не подключён до app.js — окна не соберётся')

  assert.match(app, /OnlyoneArtifactPanel\.create\(/, 'app.js не создаёт панель')
  assert.match(app, /artifactPanelInstance\.bind\(\)/, 'провода панели не подключены')
  // Модуль не должен влезать в чужие владения: ни настроек, ни ключей.
  assert.equal(/setSettings|openrouterKeys|getEnabledKeys/.test(panel), false, 'модуль панели лезет в настройки или ключи')
})

test('chart JSON становится доступной и безопасно экранированной SVG-диаграммой', () => {
  assert.match(artifactsPrompt, /"type":"bar"\|"line"/)
  assert.match(artifactsPrompt, /"categories":\[/)
  assert.match(artifactsPrompt, /"series":\[\{"name":"\.\.\.","values":\[1,2\]\}\]/)
  const bar = chartPanel.artifactChartHtml(JSON.stringify({
    type: 'bar', title: 'Доход < Q&A', xLabel: 'Период', yLabel: 'Сумма', unit: '₽',
    categories: ['Q&1', 'Q2'],
    series: [
      { name: 'Продажи & возвраты', values: [12, -3] },
      { name: 'План', values: [10, 8] }
    ]
  }), 420)
  assert.ok(bar)
  assert.match(bar, /<svg class="artifact-chart-svg" role="img"/)
  assert.match(bar, /<rect class="artifact-chart-bar"/)
  assert.match(bar, /Доход &lt; Q&amp;A/)
  assert.match(bar, /Q&amp;1/)
  assert.match(bar, /Продажи &amp; возвраты/)
  assert.match(bar, /fill="var\(--color-green\)"/)

  const line = chartPanel.artifactChartHtml(JSON.stringify({
    type: 'line', labels: ['Jan', 'Feb'],
    datasets: [{ label: 'Orders', data: [2, 5] }]
  }), 400)
  assert.match(line, /<path class="artifact-chart-line"/)
  assert.match(line, /<circle class="artifact-chart-point"/)
  assert.equal(chartPanel.artifactChartHtml('{broken', 400), null)
  assert.equal(chartPanel.artifactChartHtml(JSON.stringify({ type: 'pie', categories: ['A'], series: [{ values: [1] }] }), 400), null)
})

if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
