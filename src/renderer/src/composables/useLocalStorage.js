import { ref, watch } from 'vue'

/**
 * 创建一个与 localStorage 双向同步的 ref
 * @param {string} key - localStorage 键名
 * @param {*} defaultValue - 默认值
 * @param {object} [options]
 * @param {'string'|'number'|'float'|'boolean'|'json'} [options.type='string'] - 值类型
 */
export function useLocalStorage(key, defaultValue, options = {}) {
  const type = options.type || inferType(defaultValue)

  const stored = localStorage.getItem(key)
  const initial = stored !== null ? deserialize(stored, type, defaultValue) : defaultValue

  const data = ref(initial)

  watch(
    data,
    (v) => {
      localStorage.setItem(key, serialize(v, type))
    },
    { deep: type === 'json' }
  )

  return data
}

function inferType(value) {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'number' : 'float'
  return 'string'
}

function deserialize(raw, type, defaultValue) {
  switch (type) {
    case 'boolean':
      return raw === 'true'
    case 'number': {
      const parsed = Number.parseInt(raw, 10)
      return Number.isFinite(parsed) ? parsed : defaultValue
    }
    case 'float': {
      const parsed = Number.parseFloat(raw)
      return Number.isFinite(parsed) ? parsed : defaultValue
    }
    case 'json':
      try {
        return JSON.parse(raw) ?? defaultValue
      } catch {
        return defaultValue
      }
    default:
      return raw
  }
}

export function readStoredJson(key, defaultValue) {
  const raw = localStorage.getItem(key)
  if (raw === null) return defaultValue
  return deserialize(raw, 'json', defaultValue)
}

function serialize(value, type) {
  if (type === 'json') return JSON.stringify(value)
  return String(value)
}
