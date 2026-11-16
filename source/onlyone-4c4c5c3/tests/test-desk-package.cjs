'use strict'
const assert = require('node:assert/strict')
const { exportPackage, parsePackage, fitBlocks, legacyTemplate } = require('../src/main/desk-package.cjs')
const { validateSnapshot } = require('../src/main/desk-model.cjs')
async function main () {
  const block = { id: 'b', kind: 'artifact', title: 'Tool', resourceRef: 'artifact:private', revision: 1,
    rect: { x: 1900, y: 400, width: 800, height: 600, z: 1 } }
  const snapshot = { schemaVersion: 1, id: 'desk', title: 'Desk', revision: 1, blocks: [block] }
  const text = await exportPackage(snapshot, async () => ({ type: 'page', content: '<h1>Tool</h1><script>window.ok = true</script>' }))
  assert(!text.includes('artifact:private'))
  const parsed = parsePackage(text)
  assert.equal(parsed.blocks[0].portable.active, false)
  assert(parsed.blocks[0].portable.content.includes('<h1>Tool</h1>'))
  const bad = JSON.parse(text); bad.blocks[0].portable.active = true
  assert.throws(() => parsePackage(JSON.stringify(bad)))
  bad.blocks[0].portable.active = false; bad.blocks[0].portable.path = 'C:/private'
  assert.throws(() => parsePackage(JSON.stringify(bad)))
  assert.throws(() => parsePackage('{'))
  const fit = fitBlocks(parsed.blocks, { width: 900, height: 600 })
  assert(fit[0].rect.x >= 0 && fit[0].rect.x + fit[0].rect.width <= 900)
  assert(fit[0].rect.y >= 0 && fit[0].rect.y + fit[0].rect.height <= 600)
  assert.equal(parsed.blocks[0].rect.x, 1900, 'fit does not mutate the package')
  validateSnapshot({ ...snapshot, blocks: [{ ...block, resourceRef: 'desk-package:page', portable: parsed.blocks[0].portable }] })
  await assert.rejects(exportPackage(snapshot, async () => { throw Error('unavailable') }))
  const unsafe = await exportPackage(snapshot, async () => ({ type: 'page', content: '<img src="https://example.com/image.png">' }))
  assert.deepEqual(parsePackage(unsafe).blocks[0].portable.dependencies, ['https://example.com/image.png'])
  const legacy = require('../src/main/workspace-crate').pack({ name: 'Old workspace', blocks: [{ title: 'Old tool', role: 'output', x: 10, y: 20, w: 100, h: 100 }] })
  assert.equal(legacyTemplate(legacy).blocks[0].rect.width, 280)
  assert.equal(legacyTemplate(legacy).title, 'Old workspace')
  assert.throws(() => legacyTemplate(legacy.replace('Old tool', 'changed')))
  console.log('PASS Desk packages: explicit content, inactive import, strict payload, dependency manifest, viewport fitting and atomic export')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
