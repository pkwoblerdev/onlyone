'use strict'

// Observe the existing request; never retry, reroute or persist response contents.
async function requestJson (options, { request, context, kind, agentIndex = 0 }) {
  try {
    const response = await request('/chat/completions', options)
    const data = await response.json()
    context?.recordModelCall?.({ kind, agentIndex, model: options.body?.model, answeredModel: data?.model,
      outcome: 'completed', body: options.body })
    return data
  } catch (error) {
    context?.recordModelCall?.({ kind, agentIndex, model: options.body?.model,
      outcome: options.signal?.aborted ? 'cancelled' : 'failed', body: options.body })
    throw error
  }
}
module.exports = { requestJson }
