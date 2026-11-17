// Contract tests for section names (milestone 1.8, переписаны 28.09 по Н89).
//
// 1.8 вшил английские названия разделов прямо в разметку — и на русском экране
// левая панель осталась английской («Chats, Projects, Skills,
// Design»). Правило теперь то же, что у остального интерфейса: источник правды
// в разметке — русский, английский даёт словарь. Названия разделов продолжают
// звучать по-английски в английском интерфейсе, но перестают быть exceptions
// среди переведимого текста.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const root = path.join(__dirname, '..', 'src', 'renderer');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'i18n.js'), 'utf8');
// Разделы, перенесённые с макета (21.10), рисуют заголовок своим модулем: pageHead(t('…'))
const pageModules = ['skills-page.js', 'projects-page.js', 'design-gallery.js']
  .map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');

const dict = new Map();
for (const m of i18n.matchAll(/^    '((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)'/gm)) {
  dict.set(m[1].replace(/\\'/g, "'"), m[2].replace(/\\'/g, "'"));
}

// Русское имя раздела и то, каким оно обязано стать на английском.
// «MCP» — имя протокола: в обоих языках оно пишется так,
// и пары в словаре для него быть не должно.
const SECTIONS = [
  { id: 'navChats', ru: 'Диалоги', en: 'Chats' },
  { id: 'navTasks', ru: 'Задачи', en: 'Tasks' },
  { id: 'navProjects', ru: 'Проекты', en: 'Projects' },
  { id: 'navSkills', ru: 'Скиллы', en: 'Skills' },
  { id: 'navDesign', ru: 'Дизайн', en: 'Design' },
  { id: 'navConnectors', ru: 'MCP', en: 'MCP' }
];

// Пара нужна всем, кроме имени продукта: для него допустимо либо её отсутствие,
// либо явная тождественная запись в словаре.
function expectPair (ru, en) {
  if (ru === en) {
    const pair = dict.get(ru);
    assert.ok(pair === undefined || pair === en,
      `«${ru}» — имя продукта, в словаре оно может быть только собой, а не ${JSON.stringify(pair)}`);
    return;
  }
  assert.equal(dict.get(ru), en, `«${ru}» must translate to '${en}', got ${JSON.stringify(dict.get(ru))}`);
}

console.log('1. Навигация: в разметке — русский источник, в словаре — английская пара...');
for (const sec of SECTIONS) {
  const re = new RegExp(`id="${sec.id}"[\\s\\S]*?<span>${sec.ru}</span>`);
  // «Задачи» по макету 21.10 — кнопка-значок в шапке чата: имя у неё в aria-label
  const iconOnly = new RegExp(`id="${sec.id}"[^>]*aria-label="${sec.ru}[^"]*"`);
  assert(re.test(indexHtml) || iconOnly.test(indexHtml), `Sidebar #${sec.id} must carry <span>${sec.ru}</span> (источник — русский)`);
  expectPair(sec.ru, sec.en);
  console.log(`  ok  #${sec.id} -> ${sec.ru} / ${sec.en}`);
}

console.log('2. Заголовки разделов (.page-title) — то же правило...');
const PAGE_TITLES = [
  { viewId: 'taskCenterView', ru: 'Задачи', en: 'Tasks' },
  { viewId: 'projectsView', ru: 'Проекты', en: 'Projects' },
  { viewId: 'skillsView', ru: 'Скиллы', en: 'Skills' },
  { viewId: 'designView', ru: 'Дизайн', en: 'Design' },
  { viewId: 'connectorsView', ru: 'MCP', en: 'MCP' }
];
for (const title of PAGE_TITLES) {
  const re = new RegExp(`id="${title.viewId}"[\\s\\S]*?<h1 class="page-title">${title.ru}</h1>`);
  const plain = new RegExp(`id="${title.viewId}"[\\s\\S]*?<h1>${title.ru}</h1>`);
  assert(re.test(indexHtml) || plain.test(indexHtml) || pageModules.includes(`pageHead(t('${title.ru}')`), `View #${title.viewId} page-title must be '${title.ru}'`);
  expectPair(title.ru, title.en);
  console.log(`  ok  #${title.viewId} -> ${title.ru} / ${title.en}`);
}

console.log('3. В навигации больше нет вшитых английских названий...');
const navContent = (indexHtml.match(/<nav class="sidebar-nav">([\s\S]*?)<\/nav>/) || [])[1];
assert(navContent, 'sidebar-nav found');
for (const sec of SECTIONS) {
  if (sec.ru === sec.en) continue;
  assert(!navContent.includes(`<span>${sec.en}</span>`),
    `английская подпись '${sec.en}' вшита в разметку — на русском экране она не переведётся`);
}
console.log('  ok  ни одного вшитого английского названия');

console.log('4. Команда /skills сохранила имя команды...');
assert(/cmd:\s*'\/skills',\s*label:\s*'Skills'/.test(fs.readFileSync(path.join(root, 'slash-commands.js'), 'utf8')), "slash-commands.js /skills command has label 'Skills'");
console.log("  ok  /skills command labeled 'Skills'");

console.log('5. В настройках нет вкладки модов и группы бюджета задачи (управление через чат)...');
assert(!indexHtml.includes('id="tab-mods"'), 'tab-mods must not be in index.html settings navigation');
assert(!indexHtml.includes('id="panel-mods"'), 'panel-mods must not be in index.html settings panels');
assert(!indexHtml.includes('id="mods-manager"'), 'mods-manager must not be in index.html settings');
assert(!indexHtml.includes('id="budgetRequests"'), 'budgetRequests must not be in index.html');
assert(!indexHtml.includes('id="budgetTokens"'), 'budgetTokens must not be in index.html');
assert(!indexHtml.includes('id="budgetDeadline"'), 'budgetDeadline must not be in index.html');
assert(!indexHtml.includes('id="budgetSettingsSave"'), 'budgetSettingsSave must not be in index.html');
assert(!appJs.includes("if (settingsTab === 'mods')"), 'app.js must not contain mods settings tab refresh');
assert(!appJs.includes("budgetSettings?.load()"), 'app.js must not contain budgetSettings?.load()');
console.log('  ok  моды и бюджет задачи убраны из настроек');

console.log('6. Команда /mods зарегистрирована в строке ввода...');
assert(/cmd:\s*'\/mods'/.test(fs.readFileSync(path.join(root, 'slash-commands.js'), 'utf8')), "slash-commands.js must have /mods command");
console.log('  ok  /mods command registered');

console.log('test-section-names: ALL CHECKS PASSED (6/6)');
