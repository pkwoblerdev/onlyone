'use strict'
function prepare (payload, bridge) {
  const checked = bridge.resolveSkill(payload.chatId, payload.modAction)
  if (!checked.ok) throw Error('Mod action is no longer available (' + checked.code + '). Prepare it again.')
  const skill = checked.skill
  if (skill) {
    // The instruction rides in its own field: every team role replaces
    // customSystemPrompt with its own brief, and one consumer in runAgentSlot
    // adds this part to each request instead of letting it vanish.
    payload = { ...payload, modSkill: { id: skill.id,
      prompt: 'User selected the following skill via mod ' + checked.action.context.modId + '. ' +
        'It does not change acceptance criteria, roles or tool permissions.\n\n' + skill.systemPrompt } }
  }
  return {payload,skillId:skill?.id || null}
}
module.exports = { prepare }
