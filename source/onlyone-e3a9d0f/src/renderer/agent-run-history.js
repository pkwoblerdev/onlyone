/* Agent history serialization, shared by chat and Design. No DOM or IPC. */
(function (root) {
  'use strict'
  function createRecorder({ normalizePlanSteps, extractTaskTitle, now = Date.now }) {
  function agentRunRecord(source, { ask = '', seconds = 0 } = {}) {
    const tasks = [...(source?.agentTasks?.values() || [])]
    const items = Array.isArray(source?.board?.items) ? source.board.items : []
    const plans = [...(source?.planByAgent || new Map())].filter(([, list]) => Array.isArray(list) && list.length)
    if (tasks.length < 2 && !items.length && !plans.length) return undefined
    const text = String(ask || '').replace(/\s+/g, ' ').trim()
    return {
      at: now(),
      seconds: Math.round(Number(seconds) || 0),
      ask: text.length > 160 ? text.slice(0, 160).replace(/\s+\S*$/, '') + '…' : text,
      agents: tasks.map(task => ({
        index: task.index,
        name: task.name || `Агент ${task.index + 1}`,
        title: task.taskTitle || (task.assignment ? extractTaskTitle(task.assignment) : ''),
        model: task.model || '',
        outcome: task.outcome || (task.done ? 'done' : 'interrupted'),
        tools: task.tools || 0,
        tokens: task.tokens || 0,
        seconds: Math.max(0, Math.round(((task.endedAt || now()) - (task.since || now())) / 1000))
      })),
      board: items.map(item => ({
        id: item.id || '',
        agent: item.agent || '',
        title: String(item.title || extractTaskTitle(item.task) || item.id || '').slice(0, 120),
        status: item.status || 'open',
        note: String(item.note || '').slice(0, 400)
      })),
      plans: plans.map(([agent, list]) => {
        const steps = normalizePlanSteps(list)
        return { agent, done: steps.filter(step => step.status === 'done').length, total: steps.length }
      })
    }
  }
    return agentRunRecord
  }
  const api = Object.freeze({ createRecorder })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneRunHistory = api
})(typeof window === 'object' ? window : globalThis)
