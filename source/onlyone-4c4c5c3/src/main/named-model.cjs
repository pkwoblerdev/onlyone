// Модель, названная человеком в просьбе («agent inception/mercury-decide:free…»). Ищется id вида «вендор/имя[:вариант]»:
// сначала среди каталога (самый длинный id побеждает); иначе, если вендор настоящий (есть в каталоге), а имени там нет —
// модель «неизвестная»: ход не начинается, человеку говорят об этом и называют похожие. Пути и адреса моделями не считаются.
const TRAIL = /[.,;!?)»"']+(?=\s|$)/g

function clean (text) { return String(text || '').replace(TRAIL, '') }

function namedModelInText (text, catalog) {
  const source = clean(text)
  const low = source.toLowerCase()
  const list = Array.isArray(catalog) ? catalog : []
  const edge = ch => !ch || !/[a-z0-9_.:/-]/i.test(ch)
  const hit = list
    .filter(model => model && /\//.test(model.id || ''))
    .sort((a, b) => b.id.length - a.id.length)
    .find(model => {
      const id = model.id.toLowerCase()
      let at = low.indexOf(id)
      while (at >= 0) {
        if (edge(low[at - 1]) && edge(low[at + id.length])) return true
        at = low.indexOf(id, at + 1)
      }
      return false
    })
  if (hit) return { id: hit.id, name: hit.name || hit.id }
  // Неизвестной считается только явно названная («agent/model/модель/агент <вендор/имя>» или с «:free») и только с
  // настоящим вендором: «src/main» и подобные пути под это не попадают.
  const vendors = new Set(list.map(model => String(model.id || '').split('/')[0].toLowerCase()).filter(Boolean))
  const found = source.match(/(?:agent|model|модел\p{L}*|агент\p{L}*)\s+([a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*(?::[a-z0-9_-]+)?)/iu) ||
    source.match(/(?:^|\s)([a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*:free)(?=\s|$)/i)
  if (found && !/^https?/i.test(found[1]) && vendors.has(found[1].split('/')[0].toLowerCase())) return { unknown: found[1] }
  return {}
}

// Похожие на неизвестное имя модели: общий вендор и общие слова названия. Для подсказки человеку, а не для подмены.
function similarModels (unknown, catalog, count = 3) {
  const words = id => String(id).toLowerCase().split(/[/:_.-]+/).filter(word => word && word !== 'free')
  const wanted = new Set(words(unknown))
  const vendor = String(unknown).split('/')[0].toLowerCase()
  return (Array.isArray(catalog) ? catalog : [])
    .map(model => {
      const shared = words(model.id).filter(word => wanted.has(word)).length
      return { model, score: shared + (String(model.id).toLowerCase().startsWith(vendor + '/') ? 2 : 0) }
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(item => ({ id: item.model.id, name: item.model.name || item.model.id }))
}

// «Only 2 agents», «только два агента» — предел команды (ведущий входит в счёт). null, если предела нет.
const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, один: 1, одного: 1, два: 2, двое: 2, двух: 2, три: 3, трое: 3, трёх: 3, четыре: 4 }
function maxAgentsInText (text) {
  const source = String(text || '')
  const english = source.match(/\bonly\s+(\d+|one|two|three|four)\s+agents?\b/i)
  const russian = source.match(/(?<![\p{L}])только\s+(\d+|один|одного|два|двое|двух|три|трое|трёх|четыре)\s+агент\p{L}*/iu)
  const raw = (english || russian || [])[1]
  if (!raw) return null
  const number = /^\d+$/.test(raw) ? Number(raw) : COUNT_WORDS[raw.toLowerCase()]
  return Number.isInteger(number) && number >= 1 && number <= 8 ? number : null
}

module.exports = { namedModelInText, similarModels, maxAgentsInText }
