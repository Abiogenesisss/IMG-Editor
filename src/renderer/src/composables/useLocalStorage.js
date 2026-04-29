import { ref, watch, onMounted, onUnmounted, getCurrentInstance } from 'vue'

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

  // 写入时同步到 localStorage
  let skipNextWatch = false
  watch(data, (v) => {
    if (skipNextWatch) {
      skipNextWatch = false
      return
    }
    localStorage.setItem(key, serialize(v, type))
  }, { deep: type === 'json' })

  // 监听其他标签页/窗口的 storage 变更
  function onStorageChange(e) {
    if (e.key === key && e.newValue !== null) {
      skipNextWatch = true
      data.value = deserialize(e.newValue, type)
    } else if (e.key === key && e.newValue === null) {
      skipNextWatch = true
      data.value = defaultValue
    }
  }

  // 仅在组件上下文中注册生命周期钩子
  if (getCurrentInstance()) {
    onMounted(() => window.addEventListener('storage', onStorageChange))
    onUnmounted(() => window.removeEventListener('storage', onStorageChange))
  } else {
    // 在组件外使用时直接注册
    window.addEventListener('storage', onStorageChange)
  }

  return data
}

function inferType(value) {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'number' : 'float'
  return 'string'
}

function deserialize(raw, type) {
  switch (type) {
    case 'boolean': return raw === 'true'
    case 'number': return parseInt(raw) || 0
    case 'float': return parseFloat(raw) || 0
    case 'json':
      try { return JSON.parse(raw) } catch { return null }
    default: return raw
  }
}

function serialize(value, type) {
  if (type === 'json') return JSON.stringify(value)
  return String(value)
}
