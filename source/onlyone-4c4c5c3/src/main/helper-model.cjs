// Модель помощника по просьбе: «второго поставь на GLM 5.3». Ведущий называет её в assign_work (поле model), а здесь
// решается, можно ли. Чистая функция: каталог и проверки приходят снаружи, поэтому её проверяют без приложения.
//
// Правила: модель должна быть в живом каталоге и уметь вызывать инструменты; бесплатную можно назначить всегда, платную —
// только если человек сам назвал её в сообщении (ведущий не имеет права тратить деньги по собственной выдумке).
const norm = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()

function resolveHelperModel(raw, deps) {
  const asked = String(raw || '').trim()
  if (!asked) return { ok: true, id: '' }
  const list = deps.catalog || []
  const low = norm(asked)
  const record = list.find(model => norm(model.id) === low) ||
    list.find(model => norm(model.name) === low) ||
    list.find(model => norm(model.id).endsWith('/' + low)) ||
    list.find(model => norm(model.name).includes(low) && low.length >= 4)
  if (!record || !deps.exists(record.id)) return { ok: false, error: `Модель «${asked}» в каталоге не найдена — помощник идёт на модели по умолчанию.` }
  if (!deps.canCallTools(record.id)) return { ok: false, error: `«${record.name || record.id}» не умеет вызывать инструменты и помощником быть не может — взята модель по умолчанию.` }
  if (!deps.isFree(record.id)) {
    const text = norm(deps.userText)
    const named = text.includes(norm(record.id)) || (norm(record.name).length >= 4 && text.includes(norm(record.name)))
    if (!named) return { ok: false, error: `«${record.name || record.id}» платная, а человек её не называл — помощник идёт на модели по умолчанию. Платную можно назначить, только если человек сам попросил именно её.` }
  }
  return { ok: true, id: record.id, name: record.name || record.id }
}

module.exports = { resolveHelperModel }

