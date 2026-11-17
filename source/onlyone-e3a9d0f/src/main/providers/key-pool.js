'use strict'

// Пул ключей провайдеров (пункт 2.4б плана работ).
//
// Управляет списком API-ключей провайдера (OpenRouter и совместимые):
// - Распределение нагрузки (round-robin / balancing) среди активных ключей.
// - Отслеживание состояний ключа:
//     * 'active' — ключ включён и готов к запросам;
//     * 'cooldown' («отдыхает») — ключ временно исчерпал лимиты (429) или сервер
//       вернул сбой (500, 502, 503, 504); автоматически восстанавливается по таймеру;
//     * 'dead' («не работает») — ключ отклонён (401 invalid/revoked/user not found);
//     * 'off' — ключ отключён человеком в настройках.
// - Прозрачный переход на следующий ключ при 429/5xx без обрыва ответа.
// - Честный отказ с указанием времени до разблокировки, если все ключи отдыхают.

const ROTATABLE_STATUSES = new Set([401, 402, 408, 409, 429, 500, 502, 503, 504])

const DEFAULT_COOLDOWN_429_MS = 60_000
const DEFAULT_COOLDOWN_5XX_MS = 30_000
// Потолок «отдыха» по Retry-After: значение целиком приходит от сервера (в т.ч. от
// пользовательского baseURL), без потолка ключ остывал 1e+21 с и настройки показывали
// 21-значное число (break-5 Н13). Час — с запасом против честных лимитов провайдера.
const MAX_RETRY_AFTER_MS = 3_600_000

class KeyPool {
  /**
   * @param {Object} options
   * @param {Array<Object>} options.keys — список объектов ключей
   * @param {Object} [options.clock] — провайдер времени ({ now: () => number })
   * @param {number} [options.defaultCooldownMs] — стандартное время кулдауна
   * @param {Function} [options.onDead] — коллбек при обнаружении dead-ключа
   */
  constructor({ keys = [], clock = null, defaultCooldownMs = null, onDead = null } = {}) {
    this.clock = clock || { now: () => Date.now() }
    this.defaultCooldownMs = defaultCooldownMs
    this.onDead = onDead
    this.currentIndex = 0

    // Внутреннее состояние ключей: id -> state
    this.keyStates = new Map()

    this.setKeys(keys)
  }

  now() {
    return this.clock.now()
  }

  /**
   * Обновить список ключей в пуле (с сохранением накопленного состояния кулдаунов)
   */
  setKeys(keys) {
    this.keys = Array.isArray(keys) ? [...keys] : []

    // Синхронизируем состояния
    const existingIds = new Set(this.keys.map(k => k.id))
    for (const id of this.keyStates.keys()) {
      if (!existingIds.has(id)) {
        this.keyStates.delete(id)
      }
    }

    for (const key of this.keys) {
      if (!this.keyStates.has(key.id)) {
        this.keyStates.set(key.id, {
          id: key.id,
          cooldownUntil: 0,
          cooldownReason: '',
          dead: Boolean(key.dead),
          deadReason: key.deadReason || '',
          requestsCount: 0,
          consecutiveFailures: 0,
          lastUsedAt: 0
        })
      } else {
        const state = this.keyStates.get(key.id)
        if (key.dead) {
          state.dead = true
          if (key.deadReason) state.deadReason = key.deadReason
        }
      }
    }
  }

  getKey(id) {
    return this.keys.find(k => k.id === id) || null
  }

  getState(id) {
    return this.keyStates.get(id) || null
  }

  isDead(id) {
    const state = this.getState(id)
    return Boolean(state?.dead)
  }

  isCoolingDown(id) {
    const state = this.getState(id)
    if (!state || !state.cooldownUntil) return false
    if (this.now() >= state.cooldownUntil) {
      // Время вышло — ключ автоматически остыл
      state.cooldownUntil = 0
      state.cooldownReason = ''
      state.consecutiveFailures = 0
      return false
    }
    return true
  }

  getKeyStatus(id) {
    const key = this.getKey(id)
    if (!key || key.enabled === false) return 'off'
    if (this.isDead(id)) return 'dead'
    if (this.isCoolingDown(id)) return 'cooldown'
    return 'active'
  }

  /**
   * Возвращает все ключи, готовые к приёму запросов прямо сейчас
   */
  getActiveKeys() {
    return this.keys.filter(k => this.getKeyStatus(k.id) === 'active')
  }

  /**
   * Пометить ключ в состояние «отдыхает» (cooldown)
   */
  markCooldown(id, { status = 429, reason = '', retryAfterSeconds = null } = {}) {
    const state = this.getState(id)
    if (!state) return

    let durationMs
    if (typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0) {
      durationMs = Math.min(retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
    } else if (this.defaultCooldownMs) {
      durationMs = this.defaultCooldownMs
    } else if (status === 429) {
      durationMs = DEFAULT_COOLDOWN_429_MS
    } else {
      durationMs = DEFAULT_COOLDOWN_5XX_MS
    }

    state.cooldownUntil = this.now() + durationMs
    state.consecutiveFailures++
    state.cooldownReason = reason || (status === 429 ? 'Лимит запросов исчерпан (429)' : `Сбой сервера (${status})`)
  }

  /**
   * Пометить ключ как dead (401 и фатальные отказы авторизации)
   */
  markDead(id, reason = '') {
    const state = this.getState(id)
    if (!state) return
    state.dead = true
    state.deadReason = reason || 'Ключ отклонён (401)'
    state.cooldownUntil = 0
    state.cooldownReason = ''
    if (typeof this.onDead === 'function') {
      this.onDead(id, state.deadReason)
    }
  }

  /**
   * Сбросить кулдаун ключа
   */
  resetCooldown(id) {
    const state = this.getState(id)
    if (!state) return
    state.cooldownUntil = 0
    state.cooldownReason = ''
    state.consecutiveFailures = 0
  }

  /**
   * Сбросить кулдаун для всех ключей
   */
  resetAll() {
    for (const state of this.keyStates.values()) {
      state.cooldownUntil = 0
      state.cooldownReason = ''
      state.consecutiveFailures = 0
    }
  }

  /**
   * Зафиксировать успешный запрос через ключ
   */
  recordSuccess(id) {
    const state = this.getState(id)
    if (!state) return
    state.requestsCount++
    state.consecutiveFailures = 0
    state.lastUsedAt = this.now()
    if (state.cooldownUntil) {
      state.cooldownUntil = 0
      state.cooldownReason = ''
    }
  }

  /**
   * Выбрать следующий ключ для запроса с учётом round-robin и preferredKeyId.
   */
  acquireKey({ preferredKeyId = null } = {}) {
    const enabledKeys = this.keys.filter(k => k.enabled !== false && !this.isDead(k.id))

    if (!enabledKeys.length) {
      const err = new Error('В пуле нет доступных активных ключей.')
      err.code = 'NO_ACTIVE_KEYS'
      throw err
    }

    // Если запрошен предпочтительный ключ и он здоров — отдаём его
    if (preferredKeyId) {
      const prefKey = enabledKeys.find(k => k.id === preferredKeyId)
      if (prefKey && !this.isCoolingDown(prefKey.id)) {
        return prefKey
      }
    }

    // Ищем доступные (не в кулдауне) ключи
    const available = enabledKeys.filter(k => !this.isCoolingDown(k.id))

    if (available.length > 0) {
      // Round-robin среди доступных ключей
      const key = available[this.currentIndex % available.length]
      this.currentIndex = (this.currentIndex + 1) % available.length
      return key
    }

    // Все включённые ключи в кулдауне: формируем честный отказ
    let minWaitMs = Infinity
    for (const key of enabledKeys) {
      const state = this.getState(key.id)
      if (state && state.cooldownUntil) {
        const remaining = state.cooldownUntil - this.now()
        if (remaining < minWaitMs) {
          minWaitMs = remaining
        }
      }
    }

    const minSec = Math.max(1, Math.ceil(minWaitMs / 1000))
    const err = new Error(`Все ключи в пуле отдыхают (лимиты 429/5xx). Ближайший ключ освободится через ${minSec} с.`)
    err.code = 'POOL_EXHAUSTED'
    err.minCooldownRemainingSec = minSec
    throw err
  }

  /**
   * Возвращает упорядоченный список кандидатов для failover-цепочки
   */
  getCandidateChain({ preferredKeyId = null } = {}) {
    const enabledKeys = this.keys.filter(k => k.enabled !== false && !this.isDead(k.id))
    if (!enabledKeys.length) return []

    const candidates = []

    // 1. Предпочитаемый (если не dead)
    if (preferredKeyId) {
      const pref = enabledKeys.find(k => k.id === preferredKeyId)
      if (pref && !this.isCoolingDown(pref.id)) {
        candidates.push(pref)
      }
    }

    // 2. Доступные ключи в порядке round-robin
    const available = enabledKeys.filter(k => !this.isCoolingDown(k.id))
    for (let i = 0; i < available.length; i++) {
      const cand = available[(this.currentIndex + i) % available.length]
      if (!candidates.includes(cand)) {
        candidates.push(cand)
      }
    }

    // 3. Если все остывают — в крайнем случае добавляем остывающие ключи в порядке скорейшего остывания
    if (candidates.length === 0) {
      const cooling = [...enabledKeys].sort((a, b) => {
        const sa = this.getState(a.id)?.cooldownUntil || 0
        const sb = this.getState(b.id)?.cooldownUntil || 0
        return sa - sb
      })
      candidates.push(...cooling)
    }

    return candidates
  }

  /**
   * Выполнить сетевой запрос с прозрачным переключением при 429/5xx
   * @param {Object} options
   * @param {Function} options.fetcher — (key) => Promise<Response>
   * @param {string} [options.preferredKeyId]
   * @param {Function} [options.onRotated] — ({ fromKey, toKey, status, reason }) => void
   * @param {AbortSignal} [options.signal]
   */
  async executeRequest({ fetcher, preferredKeyId = null, onRotated = null, signal = null } = {}) {
    const chain = this.getCandidateChain({ preferredKeyId })
    if (!chain.length) {
      this.acquireKey({ preferredKeyId }) // бросит POOL_EXHAUSTED или NO_ACTIVE_KEYS
    }

    let lastError = null
    let lastResponse = null

    for (let i = 0; i < chain.length; i++) {
      if (signal?.aborted) throw new Error('Запрос отменён.')

      const currentKey = chain[i]
      let res
      try {
        res = await fetcher(currentKey)
      } catch (err) {
        if (signal?.aborted) throw err
        lastError = err
        this.markCooldown(currentKey.id, { status: 500, reason: err.message || 'Сетевой сбой' })
        continue
      }

      if (res.ok) {
        this.recordSuccess(currentKey.id)
        return res
      }

      lastResponse = res
      const status = res.status

      let retryAfter = null
      const retryHeader = res.headers?.get ? res.headers.get('retry-after') : null
      if (retryHeader) {
        const parsed = parseInt(retryHeader, 10)
        if (!isNaN(parsed) && parsed > 0) retryAfter = parsed
      }

      let errorBody = ''
      try {
        errorBody = typeof res.text === 'function' ? await res.text() : ''
      } catch {}

      if (status === 401 && /user not found|no auth credentials|invalid (api )?key|key (is )?(invalid|revoked|disabled)/i.test(errorBody)) {
        this.markDead(currentKey.id, 'Ключ отклонён провайдером (401)')
      } else if (ROTATABLE_STATUSES.has(status)) {
        this.markCooldown(currentKey.id, {
          status,
          reason: status === 429 ? 'Лимит запросов исчерпан (429)' : `Ошибка провайдера (${status})`,
          retryAfterSeconds: retryAfter
        })
      } else {
        // Неротируемая ошибка (например 400 bad request) — отдаём сразу
        return res
      }

      // Если есть следующий ключ — вызываем коллбек ротации
      if (i + 1 < chain.length) {
        const nextKey = chain[i + 1]
        if (typeof onRotated === 'function') {
          onRotated({
            fromKey: currentKey,
            toKey: nextKey,
            status,
            reason: status === 429 ? 'Лимит запросов исчерпан' : `Сбой сервера (${status})`
          })
        }
      }
    }

    if (lastResponse) return lastResponse
    throw lastError || new Error('Не удалось выполнить запрос через пул ключей.')
  }

  /**
   * Сформировать публичные данные ключей для интерфейса настроек
   */
  getPublicKeys() {
    return this.keys.map(k => {
      const state = this.getState(k.id)
      const isDead = Boolean(state?.dead)
      const isCooling = this.isCoolingDown(k.id)
      const status = this.getKeyStatus(k.id)

      let cooldownRemainingSec = 0
      if (isCooling && state?.cooldownUntil) {
        cooldownRemainingSec = Math.max(1, Math.ceil((state.cooldownUntil - this.now()) / 1000))
      }

      return {
        ...k,
        status,
        dead: isDead,
        deadReason: state?.deadReason || '',
        cooldown: isCooling,
        cooldownUntil: state?.cooldownUntil || 0,
        cooldownRemainingSec,
        cooldownReason: state?.cooldownReason || '',
        requestsCount: state?.requestsCount || 0
      }
    })
  }
}

module.exports = {
  KeyPool,
  ROTATABLE_STATUSES,
  DEFAULT_COOLDOWN_429_MS,
  DEFAULT_COOLDOWN_5XX_MS
}
