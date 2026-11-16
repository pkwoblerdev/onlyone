const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
// Объявление помощника правки из чата (план, 4.2 шаг 2) стоит между
// `executeMcpTool` и `executeTool` — то есть попадает в вырезку этой песочницы
// вместе со своим реестром. Песочница обязана знать его НАСТОЯЩИМ, а не
// заглушкой: иначе проверка расходится с приложением ровно там, где приложение
// и решает, пускать правку или ждать.
const { createDesignEditTurn } = require('../src/main/design/edit-turn')
const cut = (from, to) => {
  const a = source.indexOf(from), b = source.indexOf(to, a)
  assert(a >= 0 && b > a, from)
  return source.slice(a, b)
}
// Настоящая точка отправки хода: разрешение спрашивается через неё, и без неё
// вырезанная функция падает до того, как успеет что-нибудь проверить.
const GUARD = cut('function sendToWindow(event, channel, body)', 'async function runAgentMode(')

async function run() {
  for (const self of [false, true]) {
    const pending = new Map()
    const request = new Function('selfDevActive', 'approvalRequired', 'crypto', 'pendingApprovals', 'workspace', 'setTimeout', 'clearTimeout', 'APPROVAL_TIMEOUT_MS',
      GUARD + '\n' + cut('async function requestApproval(', '// A destroyed renderer') + ';return requestApproval'
    )(() => self, () => false, {randomUUID: () => 'a'}, pending, {permission:'auto'}, () => 1, () => {}, 1000)
    const promise = request({sender:{send(){}}}, {summary:'write', risk:'edit', requestId:'r'})
    assert.equal(pending.size, self ? 1 : 0, 'self-edit must ignore Auto/session grants')
    if (self) pending.get('a').resolve(false)
    assert.equal(await promise, !self)
  }
  let called = false, asked = false
  const mcp = new Function('mcpManager', 'classifyMcpTool', 'bulkDeleteRefusal', 'selfDevActive', 'mcpSessionGranted', 'approvalRequired', 'requestApproval', 'createDesignEditTurn',
    GUARD + '\n' + cut('async function executeMcpTool(', 'async function executeTool(') + ';return executeMcpTool'
  )({toolMap:new Map([['tool',{serverId:'s',toolName:'edit'}]]), configs:new Map(), callOpenRouterTool:async()=>{called=true}},
    ()=>'edit', ()=>null, ()=>true, true, ()=>false, async()=>{asked=true;return false}, createDesignEditTurn)
  assert.equal((await mcp({sender:{send(){}}}, 'tool', {}, 'r')).denied, true)
  assert(asked && !called, 'cached MCP grant must not bypass self-development confirmation')
  // Текст самодоработки — слоем режима в ./mode-prompts (план, 6.2): он приходит
  // к любому входу, где включён переключатель, а не только к чату.
  const own = require('../src/main/mode-prompts/self-dev').build()
  for (const required of ['резервную копию', 'npm test', 'отдельным временным профилем', 'явного разрешения', 'не в установленном приложении']) assert(own.includes(required), required)
  const current = path.resolve('running-app')
  const looks = new Function('fs', 'join', 'relative', 'app', cut('async function looksLikeOwnSource(', '// What the agent has') + ';return looksLikeOwnSource')(
    {readFile:async()=>'{"name":"1code"}', access:async()=>{}, realpath:async p=>path.resolve(p)}, path.join, path.relative, {getAppPath:()=>current})
  assert.match(await looks(current), /отдельную рабочую копию/)
  assert.equal(await looks(path.resolve('separate-source')), null)
  console.log('Self-development: forced confirmation, MCP grant isolation, running-source guard passed')
}
run().catch(error=>{console.error(error);process.exitCode=1})
