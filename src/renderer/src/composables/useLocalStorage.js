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
  const initial = stored !== null ? deserialize(stored, type) : defaultValue

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

function deserialize(raw, type) {
  switch (type) {
    case 'boolean':
      return raw === 'true'
    case 'number':
      return parseInt(raw) || 0
    case 'float':
      return parseFloat(raw) || 0
    case 'json':
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    default:
      return raw
  }
}

function serialize(value, type) {
  if (type === 'json') return JSON.stringify(value)
  return String(value)
}
