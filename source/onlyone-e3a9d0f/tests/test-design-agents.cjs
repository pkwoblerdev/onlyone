const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')
const { toolAllowedForAssignment } = require('../src/main/agent-quality.js')

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

// Extract briefs from main.js
const cut = (from, to) => {
  const a = mainSrc.indexOf(from)
  const b = mainSrc.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return mainSrc.slice(a, b)
}

// Брифы Дизайна — данными в ./mode-prompts/team.js (план, 6.2); признание запроса
// командным осталось в главном процессе, потому что читает состояние хода.
const team = require('../src/main/mode-prompts/team')
const mainFns = new Function(
  'const lastUserMessage = p => p?.messages?.at(-1)?.content || ""\n' +
  cut('function isCollaborativeRequest(payload) {', 'function failureReason(') +
  '\nreturn { isCollaborativeRequest }'
)()
const briefs = {
  leadDesignBrief: team.leadDesignBrief,
  helperDesignBrief: team.helperDesignBrief,
  critiqueDesignBrief: team.critiqueDesignBrief,
  isCollaborativeRequest: mainFns.isCollaborativeRequest
}

check('isCollaborativeRequest: designId сам по себе команду не включает, просьба — включает', () => {
  assert.equal(briefs.isCollaborativeRequest({ designId: 'design_123', messages: [{ role: 'user', content: 'Привет' }] }), false)
  assert.equal(briefs.isCollaborativeRequest({ designId: 'design_xyz', messages: [{ role: 'user', content: 'сделай лендинг' }] }), false)
  assert.equal(briefs.isCollaborativeRequest({ designId: 'design_xyz', messages: [{ role: 'user', content: 'сделай лендинг, работайте вместе' }] }), true)
})

check('isCollaborativeRequest уважает явное указание на одиночную работу', () => {
  assert.equal(briefs.isCollaborativeRequest({ designId: 'design_123', messages: [{ role: 'user', content: 'ответь сам, без других агентов' }] }), false)
})

check('leadDesignBrief наставляет координатора на дизайн и декомпозицию', () => {
  const brief = briefs.leadDesignBrief(2, '')
  assert.ok(brief.includes('раздел «Дизайн»') || brief.includes('разделе «Дизайн»'), 'нет указания на раздел Дизайн')
  assert.ok(brief.includes('assign_work'), 'нет требования вызвать assign_work')
  assert.ok(brief.includes('dc_write'), 'нет упоминания dc_write')
  assert.ok(brief.includes('dc_check'), 'нет упоминания dc_check')
  assert.ok(brief.includes('dc_refs'), 'нет упоминания dc_refs')
  assert.ok(brief.includes('dc_set_entry'), 'нет упоминания dc_set_entry')
})

check('helperDesignBrief для readOnly: false дает права на изменение компонентов', () => {
  const brief = briefs.helperDesignBrief('Агент 2', 'Создать Hero секцию', false)
  assert.ok(brief.includes('СОЗДАНИЕ И ИЗМЕНЕНИЕ (readOnly: false)'), 'нет пометки о записи')
  assert.ok(brief.includes('dc_write'), 'нет dc_write')
  assert.ok(brief.includes('dc_html_str_replace'), 'нет dc_html_str_replace')
  assert.ok(brief.includes('.dc.html'), 'нет упоминания формата .dc.html')
})

check('helperDesignBrief для readOnly: true настраивает на проверку и аудит', () => {
  const brief = briefs.helperDesignBrief('Агент 3', 'Проверить адаптивность и стили', true)
  assert.ok(brief.includes('ТОЛЬКО ЧТЕНИЕ (readOnly: true)'), 'нет пометки о только чтении')
  assert.ok(brief.includes('dc_check'), 'нет dc_check')
  assert.ok(brief.includes('dc_read'), 'нет dc_read')
  assert.ok(brief.includes('dc_refs'), 'нет dc_refs')
})

check('critiqueDesignBrief ориентирован на выявление изъянов интерфейса', () => {
  const others = [
    { name: 'Агент 2', task: 'Hero секция', body: 'Создал hero.dc.html' }
  ]
  const critique = briefs.critiqueDesignBrief('Агент 3', others)
  assert.ok(critique.includes('Агент 3'), 'нет имени критика')
  assert.ok(critique.includes('dc_read') || critique.includes('dc_check'), 'нет упоминания инструментов проверки')
  assert.ok(critique.includes('ВОЗРАЖЕНИЕ') && critique.includes('ВОЗРАЖЕНИЙ НЕТ'), 'нет формата возражений')
})

check('toolAllowedForAssignment корректно фильтрует инструменты дизайна', () => {
  // readOnly: false
  assert.equal(toolAllowedForAssignment('dc_write', false), true)
  assert.equal(toolAllowedForAssignment('dc_html_str_replace', false), true)
  assert.equal(toolAllowedForAssignment('dc_js_str_replace', false), true)
  assert.equal(toolAllowedForAssignment('dc_set_props', false), true)
  assert.equal(toolAllowedForAssignment('dc_set_entry', false), true)
  assert.equal(toolAllowedForAssignment('dc_check', false), true)
  assert.equal(toolAllowedForAssignment('dc_read', false), true)

  // readOnly: true (аудит)
  assert.equal(toolAllowedForAssignment('dc_write', true), false)
  assert.equal(toolAllowedForAssignment('dc_html_str_replace', true), false)
  assert.equal(toolAllowedForAssignment('dc_js_str_replace', true), false)
  assert.equal(toolAllowedForAssignment('dc_set_props', true), false)
  assert.equal(toolAllowedForAssignment('dc_set_entry', true), false)
  assert.equal(toolAllowedForAssignment('dc_check', true), true)
  assert.equal(toolAllowedForAssignment('dc_read', true), true)
  assert.equal(toolAllowedForAssignment('dc_refs', true), true)
  assert.equal(toolAllowedForAssignment('dc_read_ref', true), true)
  assert.equal(toolAllowedForAssignment('dc_list', true), true)
  assert.equal(toolAllowedForAssignment('dc_comments', true), true)
})

check('app.js не объявляет команду на каждое сообщение Дизайна', () => {
  assert.ok(!appSrc.includes('collaborative: true,'), 'collaborative: true вернулся в app.js')
})

check('app.js обрабатывает onAgentStageStart для вкладки Design', () => {
  assert.ok(appSrc.includes('window.electronAPI.onAgentStageStart'), 'onAgentStageStart не слушается в design')
  assert.ok(appSrc.includes('recordDesignActivity(`${stage.agentName} · ${title}`)'), 'активность дизайна не обновляет имя агента')
})

check('main.js использует leadDesignBrief и helperDesignBrief в runAgentMode', () => {
  assert.ok(/payload\.designId\s*\?\s*leadDesignBrief/.test(mainSrc), 'leadDesignBrief не подключен в runAgentMode')
  assert.ok(/payload\.designId\s*\?\s*helperDesignBrief/.test(mainSrc), 'helperDesignBrief не подключен в runAgentMode')
  assert.ok(/payload\.designId\s*\?\s*critiqueDesignBrief/.test(mainSrc), 'critiqueDesignBrief не подключен в runAgentMode')
})

if (failed > 0) {
  console.error(`\nВсего провалов: ${failed}`)
  process.exit(1)
} else {
  console.log('\nВсе проверки мультиагентной работы в Design успешно пройдены!')
}