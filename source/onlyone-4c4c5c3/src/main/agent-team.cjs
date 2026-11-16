// Команда агентов по слову человека: сколько агентов работают над задачей и на каких моделях.
// Без настройки (count: null) всё как было: число агентов — по ключам пула, модели помощников подбираются из бесплатных.
// Ведущий (Агент 1) всегда та модель, что в переключателе у поля ввода; здесь задаются помощники, начиная с Агента 2.
const MAX_AGENTS = 8
// «~вендор/имя-latest» — псевдонимы самого каталога: без тильды они молча сбрасывались на «Авто».
const MODEL_ID = /^~?[A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.:-]{1,100}$/

function sanitizeAgentTeam (raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const count = Number.isInteger(source.count) && source.count >= 1 && source.count <= MAX_AGENTS ? source.count : null
  const models = []
  for (let i = 0; i < MAX_AGENTS - 1; i++) {
    const id = Array.isArray(source.models) ? String(source.models[i] || '').trim() : ''
    models.push(MODEL_ID.test(id) ? id : '')
  }
  // Хвост пустых «Авто» незачем хранить.
  while (models.length && !models[models.length - 1]) models.pop()
  return { count, models }
}

// Настроена ли команда вообще: хоть число, хоть одна своя модель.
const isConfigured = team => Boolean(team && (team.count || (team.models || []).some(Boolean)))

// Модель Агента N (N ≥ 2), выбранная человеком, или '' — «Авто».
const modelOfAgent = (team, number) => (team && Array.isArray(team.models) && number >= 2 ? team.models[number - 2] || '' : '')

module.exports = { sanitizeAgentTeam, isConfigured, modelOfAgent, MAX_AGENTS }
