/* Инструмент предложения связанного чата для главного процесса.
 *
 * Только транспорт: проверяет структуру предложения и отправляет событие
 * `fork-proposal` тому же окну, что и вопрос `ask_user`. Ни чата, ни запуска
 * модели здесь нет — создание остаётся явным действием человека в переписке.
 * Модель из src/renderer/fork-proposal.js — та же, что рисует карточку: двух
 * описаний формата не будет.
 */
'use strict'

const model = require('../renderer/fork-proposal.js')

const TOOL_NAME = model.TOOL_NAME

const TOOL_DEFINITION = Object.freeze({
  type: 'function',
  function: {
    name: TOOL_NAME,
    description:
      'Предложить человеку выделить отдельную тему или подзадачу в связанный чат. ' +
      'Карточка появляется в переписке; ничего не создаётся и модель не запускается — решает человек. ' +
      'Не зови, если тема может остаться в этом же чате. За один вызов — одно предложение.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Название будущего чата, до 200 знаков.' },
        goal: { type: 'string', description: 'Цель подзадачи: что должно получиться.' },
        reason: { type: 'string', description: 'Почему это стоит вести отдельно от текущего чата.' },
        context: {
          type: 'object',
          description: 'Что переносится. messages — текст переписки до границы; summary — согласованная выжимка.',
          properties: {
            mode: { type: 'string', enum: ['messages', 'summary'], description: 'Способ переноса контекста.' },
            end: { type: 'integer', description: 'Индекс последнего переносимого сообщения (с нуля). Не указывай, чтобы взять всю переписку до текущего хода.' },
            summary: { type: 'string', description: 'Выжимка для mode=summary: только то, что нужно новой задаче.' }
          },
          required: ['mode']
        },
        operationId: { type: 'string', description: 'Необязательный устойчивый id предложения; при повторе используй тот же.' }
      },
      required: ['title', 'goal', 'context']
    }
  }
})

function createForkProposalTool (options) {
  const sendToWindow = options?.sendToWindow
  if (typeof sendToWindow !== 'function') throw new TypeError('sendToWindow is required')
  return Object.freeze({
    definition: TOOL_DEFINITION,
    async execute (event, args, requestId) {
      let proposal
      try {
        proposal = model.sanitize(args)
      } catch (error) {
        return { success: false, error: 'Предложение не принято: ' + String(error?.message || error) }
      }
      const sent = sendToWindow(event, 'fork-proposal', { requestId: String(requestId || ''), proposal })
      if (sent === false) return { success: false, error: 'Окно недоступно: предложение не показано человеку.' }
      return {
        success: true,
        status: 'proposed',
        message: 'Предложение показано человеку. Чат не создан и модель не запущена; не жди ответа, продолжай работу.'
      }
    }
  })
}

module.exports = { TOOL_DEFINITION, TOOL_NAME, createForkProposalTool }
