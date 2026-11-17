const path = require('path')
const { McpManager } = require('../src/main/mcp-manager')

async function main() {
  const manager = new McpManager()
  manager.setConfigs([{
    id: 'mock',
    name: 'Mock MCP',
    type: 'stdio',
    command: process.execPath,
    args: [path.join(__dirname, 'mock-mcp-server.mjs')],
    env: {}
  }])

  await manager.connect('mock')
  const tools = manager.openRouterTools()
  if (tools.length !== 1 || !tools[0].function.name.includes('echo_status')) throw new Error('MCP tool discovery failed')
  const response = await manager.callOpenRouterTool(tools[0].function.name, {})
  const text = response?.content?.[0]?.text
  if (text !== 'MCP test server is connected.') throw new Error('MCP tool call failed')
  await manager.disconnectAll()
  console.log(JSON.stringify({ ok: true, tools: tools.map(tool => tool.function.name), response: text }))
}

main().catch(error => { console.error(error); process.exit(1) })
