'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { DesignStore } = require('../src/main/design/store')
const tick = () => new Promise(resolve => setImmediate(resolve))

async function main() {
  // Код окна разложен по модулям (план, 2d): область вырезается из того файла,
  // где функция лежит сейчас, поэтому берём весь исполняемый текст окна.
  const app = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))
  const sent = [], pending = [], timers = new Map()
  let timerId = 0
  const context = vm.createContext({
    personal: {}, applyAppearance() {}, showToast() {}, cleanErrorText: String,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId },
    clearTimeout(id) { timers.delete(id) },
    window: { electronAPI: { setPersonal(value) {
      sent.push({ ...value })
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    } } }
  })
  vm.runInContext(app.slice(app.indexOf('let personalSaveTimer'), app.indexOf('function setupPersonal')), context)
  vm.runInContext("savePersonal({name: 'A'}, {now: true})", context)
  await tick()
  vm.runInContext("savePersonal({name: 'AB'})", context)
  pending.shift().resolve({name: 'A'})
  await tick()
  assert.equal(context.personal.name, 'AB', 'old response must not overwrite newer typing')
  for (const fn of timers.values()) fn()
  timers.clear()
  await tick()
  assert.equal(sent[1].name, 'AB', 'debounce sends the latest snapshot')
  vm.runInContext("savePersonal({theme: 'light'}, {now: true}); savePersonal({theme: 'dark'}, {now: true})", context)
  assert.equal(sent.length, 2, 'writes wait for the pending request')
  pending.shift().resolve({name: 'AB'})
  await tick()
  assert.equal(sent[2].theme, 'light')
  pending.shift().reject(new Error('injected'))
  await tick()
  assert.equal(sent[3].theme, 'dark', 'failed write does not poison the queue')
  pending.shift().resolve(sent[3])
  await tick()
  assert.equal(context.personal.theme, 'dark')

  const button = { dataset: {}, classList: { toggle() {} }, querySelector() { return {style: {}} } }
  const designTextarea = {value: ''}
  const sendControls = require('../src/renderer/send-controls').create({
    $: id => id === 'designSendBtn' ? button : id === 'designComposerTextarea' ? designTextarea : null,
    t: s => s
  })
  sendControls.paintDesignSendButton(true)
  assert.equal(button.dataset.stop, '1', 'пустая строка во время хода должна останавливать')
  designTextarea.value = 'черновик следующего хода'
  sendControls.paintDesignSendButton(true)
  assert.equal(button.dataset.stop, '', 'при набранном тексте кнопка должна ставить его в очередь')
  assert.equal(button.dataset.tooltip, 'Добавить сообщение в очередь')
  sendControls.paintDesignSendButton(false)
  assert.equal(button.dataset.stop, '')
  const textarea = {value: 'next request'}
  let queued
  let submitted, stopped = 0, delivered = []
  const formContext = vm.createContext({
    form: {addEventListener(_event, fn) { submitted = fn }},
    textarea, designBusy: true, designRun: {}, $: () => button,
    stopDesignRun() { stopped++ }, autoResizeTextarea() {},
    queueDesignMessage(_id, entry) { queued = entry; return true }, activeDesign: {id: 'design-1'},
    paintDesignSendButton() {}, sendDesignMessage(text) { delivered.push(text) },
    // выбранного в превью элемента нет — сообщение уходит как есть
    selectedDesignElement: null, designActiveComponent: '', setElementPicking() {}
  })
  const setup = app.indexOf('function setupDesignEvents')
  const submit = app.indexOf("form?.addEventListener('submit'", setup)
  const submitEnd = app.indexOf("textarea?.addEventListener('keydown'", submit)
  vm.runInContext(app.slice(submit, submitEnd), formContext)
  button.dataset.stop = '1'
  submitted({preventDefault() {}})
  assert.equal(stopped, 1)
  assert.equal(textarea.value, 'next request', 'Stop preserves the draft')
  button.dataset.stop = ''
  submitted({preventDefault() {}})
  assert.equal(queued?.text, 'next request', 'typed message is queued while Design is busy')
  assert.equal(textarea.value, '')
  assert.equal(stopped, 1, 'sending a typed draft must not stop the active run')
  textarea.value = 'after run'
  formContext.designBusy = false
  button.dataset.stop = ''
  submitted({preventDefault() {}})
  assert.deepEqual(delivered, ['after run'], 'draft can be sent when the turn ends')
  assert.equal(textarea.value, '')

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuation-safety-'))
  try {
    const store = new DesignStore(root), second = new DesignStore(root)
    await store.write('test', 'Card', {template: '<p>before</p>', props: '{"v":0}'})
    // Delay reads to expose a lost-update race without requiring overlapping reads.
    for (const instance of [store, second]) {
      const read = instance.read.bind(instance)
      instance.read = async (...args) => { const result = await read(...args); await tick(); return result }
    }
    await Promise.all([
      store.replace('test', 'Card', 'template', 'before', 'after'),
      second.setProps('test', 'Card', '{"v":1}')
    ])
    const component = await store.read('test', 'Card')
    assert.equal(component.template, '<p>after</p>')
    assert.equal(component.props, '{"v":1}')
    await assert.rejects(store.replace('test', 'Card', 'template', 'missing', 'bad'))
    await second.setProps('test', 'Card', '{"v":2}')
    assert.equal((await store.read('test', 'Card')).props, '{"v":2}', 'failed transaction releases lock')
    const sources = await Promise.all(Array.from({length: 12}, async (_, i) => {
      const file = path.join(root, 'input-' + i + '.txt')
      await fs.writeFile(file, String(i))
      return file
    }))
    const refs = await Promise.all(sources.map((file, i) => (i % 2 ? store : second).addRef('test', file, 'nested/same.txt')))
    assert.equal(new Set(refs.map(ref => ref.name)).size, 12)
    for (const [i, ref] of refs.entries()) assert.equal((await store.readRef('test', ref.name)).text, String(i))
    assert(!(await fs.readdir(store.folder('test'))).some(name => name.endsWith('.tmp')))
  } finally { await fs.rm(root, {recursive: true, force: true}) }
  console.log('PASS: settings snapshots/serialization/recovery, Design Stop with draft, concurrent component mutations, exclusive references')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
