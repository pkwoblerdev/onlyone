// The design prompt, and the one way it can silently stop being the real thing.
//
// Two failures would both be invisible: the project instruction disappearing,
// and the tool manifest drifting away from the tools
// actually attached — a model told about a tool that is not there writes the
// call and waits forever, which is the exact failure the weak-model rails exist
// to prevent.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { buildDesignPrompt, designCraft } = require('../src/main/design/prompt.js')
const { designToolSchemas } = require('../src/main/design/tools.js')

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (err) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message))
  }
}

const craft = designCraft()
const attached = designToolSchemas().map(tool => tool.function.name)
const ALL = [...attached, 'read_guide', 'task_plan', 'ask_user', 'list_skills', 'use_skill',
  'add_skill', 'update_skill', 'delete_skill', 'toggle_skill']
const prompt = buildDesignPrompt({ toolNames: ALL })

check('собственная инструкция дизайна включена в промпт', () => {
  const file = path.join(__dirname, '..', 'src', 'main', 'design', 'onlyone-design.md')
  assert.ok(fs.existsSync(file), 'onlyone-design.md отсутствует')
  assert.equal(craft, fs.readFileSync(file, 'utf8').trim())
  assert.ok(prompt.startsWith(craft), 'инструкция не включена в начало промпта')
})

check('инструкция сохраняет ключевые принципы работы и доступности', () => {
  for (const marker of ['dc_read', 'dc_write', 'dc_check', 'dc_set_entry', 'data-comment-anchor', 'keyboard', 'responsive']) {
    assert.ok(craft.includes(marker), 'потеряно: ' + marker)
  }
})

const manifest = prompt.slice(prompt.indexOf('# Tools'))

check('манифест чужого хоста не подставлен', () => {
  // The published tool manifest belongs to a host 1code is not. None of it may
  // be presented as available. These names appear only in the craft half's
  // prose, never as a described tool of this environment.
  for (const foreign of ['gen_pptx', 'bundle_project', 'show_pdf_export_dialog',
                         'snapshot_element', 'copy_starter_component']) {
    assert.ok(!manifest.includes(foreign + '('),
      'манифест описывает чужой инструмент как вызываемый: ' + foreign)
  }
  // Раньше здесь стояло «слова gen_pptx нет нигде». Это ловило подстановку
  // чужого манифеста целиком, но заодно запрещало и прямое отречение —
  // а именно оно работает лучше всего: модель доверяет поимённому списку и
  // округляет расплывчатое «и другие». Теперь правило точнее: чужое имя
  // может встречаться только внутри абзаца, где оно объявлено несуществующим.
  // Правило не про место, а про смысл: чужое имя допустимо только там, где
  // рядом сказано, что этого инструмента нет. Отречений в промпте несколько —
  // поимённый список в манифесте и запрет в контракте проверки, — и
  // перечислять их места значило бы ломать тест при каждой перестановке.
  const DENIALS = /does not exist|not a tool|are not available|none are available|Не вызывай|не существует|Named in full/i
  const craftEnd = prompt.indexOf('# Tools')
  for (const foreign of ['gen_pptx', 'questions_v2', 'fork_verifier_agent']) {
    let at = prompt.indexOf(foreign)
    while (at >= 0) {
      // Окно шире абзаца отречения: поимённый список длинный, и отречение стоит в его начале.
      const near = prompt.slice(Math.max(0, at - 900), at + 400)
      assert.ok(at < craftEnd || DENIALS.test(near),
        'чужой инструмент назван без отречения рядом: ' + foreign)
      at = prompt.indexOf(foreign, at + 1)
    }
  }
})

check('craft-часть не велит звать то, чего здесь нет', () => {
  // Раньше craft-часть ехала дословно, называла инструменты чужого хоста как
  // руководство к действию, а манифест отменял их отдельной оговоркой. Одна
  // оговорка против полусотни уверенных указаний не работает: модель следует
  // указаниям, упирается в отсутствующий инструмент и заканчивает ход самым
  // осторожным из возможных способов — серой типографикой и заглушками вместо
  // картинок. Теперь эти места переписаны под настоящий набор, а не отменены.
  assert.ok(/list is complete, and it overrides the section above/i.test(manifest),
    'нужна общая оговорка, что манифест главнее и полон')

  const instructions = [
    'ready_for_verification', 'copy_starter_component', 'run_script',
    'show_to_user', 'show_pdf_export_dialog', 'tool_search_tool_bm25',
    'read_skill_prompt', 'fig_read', 'fig_screenshot', 'github_get_tree'
  ]
  for (const named of instructions) {
    assert.ok(!craft.includes(named),
      'craft-часть всё ещё велит звать несуществующее: ' + named)
  }

  // Взамен названы настоящие: чем заканчивать ход и чем проверять сделанное.
  assert.ok(/dc_check/.test(craft) && /dc_set_entry/.test(craft),
    'craft-часть обязана называть настоящую проверку')
})

check('ни один чужой вызов из craft-части не остался без ответа', () => {
  // Whatever the craft half tells the model to call has to be either a real
  // 1code tool or explicitly cancelled. Nothing may be left ambiguous.
  const called = [...new Set([...craft.matchAll(/`([a-z][a-z0-9_]{3,})\(/g)].map(m => m[1]))]
  const attached = new Set(designToolSchemas().map(t => t.function.name))
  // `render` and `import` are language constructs in code samples, not tools.
  const ignore = new Set(['render', 'import', 'function', 'return'])
  const unanswered = called.filter(n =>
    !attached.has(n) && !ignore.has(n) && !manifest.includes(n))
  assert.deepEqual(unanswered, [],
    'названы, но не существуют и не отменены: ' + unanswered.join(', '))
})

check('каждый описанный инструмент существует, и наоборот', () => {
  const attached = designToolSchemas().map(t => t.function.name).sort()
  const described = [...new Set(
    [...prompt.matchAll(/`(dc_[a-z_]+)\(/g)].map(m => m[1])
  )].sort()
  assert.deepEqual(described, attached,
    'описанные ' + described.join(',') + ' против подключённых ' + attached.join(','))
})

check('файловые инструменты рабочей папки в дизайне не обещаны', () => {
  assert.ok(/`write_file`.*не привязан|не привязаны|not attached/s.test(prompt) ||
    prompt.includes('are not attached in the design'),
    'промпт должен прямо говорить, что файловых инструментов здесь нет')
})

check('правила среды действуют для всех моделей, а не только для слабых', () => {
  // Раньше этот блок приклеивался моделям с подсказкой размера в имени
  // (`weakModel`), и модель без такой подсказки не узнавала, что dc_write
  // перезаписывает компонент целиком. Теперь правила сказаны одному тексту.
  assert.match(prompt, /replaces the component\s+wholesale/i)
  assert.match(prompt, /`dc_read`\s+it\s+first/i)
  assert.match(prompt, /targeted request gets a targeted edit/i)
  assert.match(prompt, /This list is complete/i)
  assert.ok(!prompt.includes('Hard rules for this environment'),
    'старый отдельный блок для слабых моделей вернулся')
})

check('язык ответа замыкает текст режима Дизайна', () => {
  const modePrompts = require('../src/main/mode-prompts')
  const language = 'Отвечай по-русски и описывай видимый прогресс по-русски, если пользователь не попросил другой язык.'
  const built = modePrompts.buildModePrompt('design', {
    toolNames: ALL, personal: '', language, designName: 'Лендинг'
  })
  const lines = built.trim().split('\n').map(line => line.trim()).filter(Boolean)
  assert.equal(lines[lines.length - 1], language,
    'правило про язык должно быть последней строкой режима: craft-часть длинная и на английском')
})

check('состав дизайна попадает в промпт', () => {
  const withFiles = buildDesignPrompt({ designName: 'Лендинг', components: ['Hero.dc.html', 'Pricing.dc.html'] })
  assert.ok(withFiles.includes('Name: Лендинг'))
  assert.ok(withFiles.includes('Hero.dc.html'))
  assert.ok(withFiles.includes('Pricing.dc.html'))
  const empty = buildDesignPrompt({ designName: 'Пустой', components: [] })
  assert.ok(empty.includes('пока ни одного'))
})

check('dc_scaffold документирует одностраничный сайт без корпуса телефона', () => {
  assert.ok(manifest.includes('single-page site with working anchor navigation'),
    'манифест должен явно описывать одностраничный сайт с якорной навигацией')
  assert.ok(manifest.includes('Never wrap websites or landing pages in a phone shell'),
    'манифест должен прямо запрещать корпус телефона для сайтов')
  assert.ok(manifest.includes('phone frames belong strictly to `app`'),
    'манифест должен закреплять телефонный макет строго за app')
})

check('дизайн-гейт запрещает телефонную рамку для сайтов и требует адаптивность', () => {
  assert.ok(prompt.includes('never wrap a website into a 390px phone container or phone bezel'),
    'дизайн-гейт должен прямо запрещать контейнер 390px для сайтов')
  assert.ok(prompt.includes('reserve phone shells strictly for kind: \'app\''),
    'дизайн-гейт должен резервировать phone shells за kind app')
})

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)

