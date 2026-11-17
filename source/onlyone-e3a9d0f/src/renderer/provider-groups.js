/* Список «Провайдер» в Настройках → Ключи: пути разложены по группам, а не свалены в одну кучу.
 * Путей теперь два десятка, и «OpenAI» рядом с «Together AI» и «LM Studio» — это разные вещи для человека: сам разработчик
 * моделей, агрегатор или хостинг (как OpenRouter — один ключ на модели многих авторов) и сервер на этом компьютере.
 * Группу пути называет реестр главного процесса (поле `kind`); окно своих догадок об именах не держит. */
(function (root) {
  'use strict'

  const ORDER = ['gateway', 'vendor', 'local', 'custom']
  const LABEL = {
    gateway: 'Агрегаторы и хостинги',
    vendor: 'Разработчики моделей',
    local: 'На этом компьютере',
    custom: 'Свой адрес'
  }

  // Порядок внутри группы — порядок реестра: встроенный OpenRouter идёт первым среди агрегаторов.
  function fill (select, providers, t, doc) {
    const groups = new Map()
    for (const item of providers || []) {
      const kind = ORDER.includes(item.kind) ? item.kind : 'vendor'
      if (!groups.has(kind)) groups.set(kind, [])
      groups.get(kind).push(item)
    }
    select.textContent = ''
    for (const kind of ORDER) {
      const list = groups.get(kind)
      if (!list) continue
      const group = doc.createElement('optgroup')
      group.label = t(LABEL[kind])
      for (const item of list) {
        const option = doc.createElement('option')
        option.value = String(item.id)
        // Название пути приходит из реестра: на английском экране оно переводится здесь, а список остаётся списком путей.
        option.textContent = t(item.title || String(item.id))
        group.appendChild(option)
      }
      select.appendChild(group)
    }
  }

  const api = { fill, ORDER, LABEL }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyoneProviderGroups = api
})(typeof window !== 'undefined' ? window : globalThis)
