// break-5 Н6: фильтр SVG пропускал обработчик события через «/» вместо пробела
// (<animate/onbegin=…>), а HTML-обёртка картинки не экранировала src — кавычка
// внутри data-ссылки дописывала свой обработчик в выгруженный файл.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createArtifactExporter, cleanSvgText } = require('../src/main/artifact-export.js')

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

const SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
check('animate/onbegin через слэш отклонён', () => {
  assert.equal(cleanSvgText(SVG_HEAD + '<animate/onbegin=alert(1) attributeName="x" dur="1s"/></svg>'), null)
})
check('g/onload через слэш отклонён', () => {
  assert.equal(cleanSvgText(SVG_HEAD + '<g/onload=alert(1)></g></svg>'), null)
})
check('img/onerror внутри foreignObject отклонён', () => {
  assert.equal(cleanSvgText(SVG_HEAD + '<foreignObject><img src=x/onerror=alert(1)></foreignObject></svg>'), null)
})
check('контроль: пробельный обработчик отклонялся и раньше', () => {
  assert.equal(cleanSvgText(SVG_HEAD + '<g onload=alert(1)></g></svg>'), null)
})
check('контроль: чистый svg принимается', () => {
  const ok = SVG_HEAD + '<rect x="1" y="2" width="3" height="4" fill="red"/></svg>'
  assert.equal(cleanSvgText(ok), ok)
})

// HTML-обёртка картинки: data-ссылку присылает модель, кавычка в ней не должна
// разрывать атрибут src.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-export-xss-'))
const versionFile = path.join(base, 'v1.png')
const outFile = path.join(base, 'out.html')
const makeExporter = () => createArtifactExporter({
  artifacts: {
    readMeta: async () => ({ id: 'a1', kind: 'image', title: 'pic', current: 1, versions: [{ n: 1, file: 'v1.png' }] }),
    resolveServed: () => ({ file: versionFile }),
    folderOf: () => base
  },
  root: base,
  showSaveDialog: async () => ({ filePath: outFile })
})

async function main() {
  const evil = 'data:image/png;base64,AAAA" onload="alert(document.domain)'
  fs.writeFileSync(versionFile, evil, 'utf8')
  await asyncCheck('кавычка в data-ссылке не дописывает обработчик в выгрузку', async () => {
    const result = await makeExporter().export({ artifactId: 'a1', format: 'html', version: 1 })
    assert.equal(result.ok, true, JSON.stringify(result))
    const html = fs.readFileSync(outFile, 'utf8')
    assert.ok(!/"\s+onload\s*=/i.test(html), 'обработчик вне атрибута: ' + html.slice(0, 400))
    assert.match(html, /&quot;/, 'кавычка не экранирована')
  })
  fs.writeFileSync(versionFile, 'data:image/png;base64,AAAA', 'utf8')
  await asyncCheck('контроль: обычная data-ссылка выгружается целой', async () => {
    const result = await makeExporter().export({ artifactId: 'a1', format: 'html', version: 1 })
    assert.equal(result.ok, true, JSON.stringify(result))
    const html = fs.readFileSync(outFile, 'utf8')
    assert.match(html, /src="data:image\/png;base64,AAAA"/)
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })
  .finally(() => { try { fs.rmSync(base, { recursive: true, force: true }) } catch {} })