const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ui = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8')
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
const cut = (text, from, to) => {
  const start = text.indexOf(from), end = text.indexOf(to, start)
  assert(start >= 0 && end > start)
  return text.slice(start, end)
}
;(async () => {
  const frame = {style: {}, parentElement: {clientWidth: 636, clientHeight: 436, style: {setProperty(){}}}}
  const fit = new Function('$', 'previewNatural', 'previewNaturalHeight', 'rememberDesignPreviewLayout',
    cut(ui, 'function fitDesignPreview()', 'function renderDesignPreview()') + '; return fitDesignPreview')(
      id => id === 'designPreviewFrame' ? frame : null, 1200, 1000, () => {})
  fit()
  // The auto-fit stays, but viewport presets and their percentage badge are gone.
  assert.equal(frame.style.zoom, '0.4')
  assert.equal(frame.style.transform, '')
  assert.equal(frame.style.width, '1200px')
  assert.equal(frame.style.height, '1000px')
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8')
  assert(!html.includes('designPreviewViewport'))
  assert(!html.includes('designPreviewZoom'))
  frame.parentElement.clientWidth = 2400; frame.parentElement.clientHeight = 2400
  fit()
  assert.equal(frame.style.zoom, '')

  // Reopening a design should restore that page's last geometry immediately,
  // and changing to an unseen page should keep the current frame size until it
  // reports its own natural dimensions.
  const previewSource = cut(ui, '// Превью само вписывает макет', '// --- review comments')
  const previewAttrs = new Map()
  const previewStage = {
    clientWidth: 636,
    clientHeight: 436,
    style: { values: {}, setProperty(name, value) { this.values[name] = value }, removeProperty(name) { delete this.values[name] } }
  }
  const previewFrame = {
    style: {},
    parentElement: previewStage,
    setAttribute(name, value) { previewAttrs.set(name, value) },
    removeAttribute(name) { previewAttrs.delete(name) }
  }
  const previewEmpty = { setAttribute() {}, removeAttribute() {} }
  const previewLabel = { textContent: '' }
  const previewRuntime = new Function('$', 'setElementPicking', 't', 'initialDesign', 'initialComponent',
    `let activeDesign = initialDesign
     let designActiveComponent = initialComponent
     ${previewSource}
     return {
       render: renderDesignPreview,
       setTarget(design, component) { activeDesign = design; designActiveComponent = component },
       reportSize(width, height) { previewNatural = width; previewNaturalHeight = height; fitDesignPreview() }
     }`)(
      id => ({designPreviewFrame: previewFrame, designPreviewEmpty: previewEmpty, designPreviewName: previewLabel})[id] || null,
      () => {}, value => value, {id: 'design-a'}, 'Landing.html')
  previewRuntime.render()
  previewRuntime.reportSize(1200, 800)
  assert.equal(previewFrame.style.width, '1200px')
  assert.equal(previewFrame.style.zoom, '0.5')
  previewRuntime.setTarget({id: 'design-b'}, 'Dashboard.html')
  previewRuntime.render()
  assert.equal(previewFrame.style.width, '1200px', 'unmeasured page must not flash back to width:100%')
  previewRuntime.reportSize(700, 500)
  assert.equal(previewFrame.style.width, '700px')
  previewRuntime.setTarget({id: 'design-a'}, 'Landing.html')
  previewRuntime.render()
  assert.equal(previewFrame.style.width, '1200px', 'reopened page restores its own cached width')
  assert.equal(previewFrame.style.zoom, '0.5', 'reopened page restores its own cached scale')

  let reply, calls = 0, saves = 0
  const design = {id:'one', name:'Новый дизайн'}
  const designs = [design]
  const titleNode = {}
  const name = new Function('window', 'designs', 'activeDesign', 'saveDesigns', '$',
    cut(ui, 'const namingDesigns =', 'function designReferenceNames(') + '; return nameDesign')(
      {electronAPI:{generateChatTitle: () => { calls++; return new Promise(r => {reply = r}) }}},
      designs, design, () => saves++, () => titleNode)
  const first = name(design, 'build', 'done', 'chosen-model')
  await name(design, 'build', 'done', 'chosen-model')
  assert.equal(calls, 1)
  reply({title:'Мобильное приложение'}); await first
  assert.equal(design.name, 'Мобильное приложение')
  assert.equal(titleNode.textContent, design.name)
  assert.equal(saves, 1)
  delete design.titleGenerated
  const pending = name(design, 'build', '', 'chosen-model')
  design.name = 'Моё название'; design.titleManual = true
  reply({title:'Нельзя перезаписать'}); await pending
  assert.equal(design.name, 'Моё название')
  assert(!Object.hasOwn(design, 'titlePending'))

  const collab = new Function('lastUserMessage',
    cut(main, 'function isCollaborativeRequest(payload)', 'function failureReason(') + '; return isCollaborativeRequest')(p => p.messages[0].content)
  // Команда — по просьбе: жалоба на одного агента просьбой не считается, прямое «работайте вместе» — считается.
  for (const content of ['почему работает один агент?', 'все задачи опять делает один агент']) {
    assert(!collab({designId:'test', messages:[{content}]}))
  }
  assert(collab({designId:'test', messages:[{content:'работайте вместе над макетом'}]}))
  assert.equal(collab({designId:'test',messages:[{content:'ответь сам, без других агентов'}]}), false)
  const choiceSource = main.match(/bodyData\.tool_choice = ([\s\S]*?);?\r?\n\s*}/)[1]
  const choose = new Function('payload','step','allTools', 'return ' + choiceSource)
  const tools = [{function:{name:'assign_work'}}]
  assert.equal(choose({requireDelegation:true,canAssign:true},0,tools).function.name,'assign_work')
  assert.equal(choose({requireDelegation:true,canAssign:false},0,tools),'auto')
  assert.equal(choose({requireDelegation:true,canAssign:true},1,tools),'auto')
  assert.equal(choose({requireDelegation:true,canAssign:true},0,[]),'auto')
  console.log('PASS: preview dimensions, naming and rename race, solo complaints, first-step delegation')
})().catch(error => {console.error(error); process.exitCode = 1})
