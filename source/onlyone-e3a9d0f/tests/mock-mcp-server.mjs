import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: '1code-mock', version: '1.0.0' })
server.registerTool('echo_status', {
  description: 'Returns a fixed test status message from the local MCP server.'
}, async () => ({ content: [{ type: 'text', text: 'MCP test server is connected.' }] }))

await server.connect(new StdioServerTransport())
