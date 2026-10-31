export const API_CONFIGS_UPDATED_EVENT = 'api-configs-updated'

export function serializeApiConfigs(list) {
  return (Array.isArray(list) ? list : []).map((config) => ({
    id: config.id,
    name: config.name,
    model: config.model,
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    enabled: config.enabled !== false
  }))
}

export async function migrateLegacyApiConfigs() {
  const legacyRaw = localStorage.getItem('api-configs')
  if (legacyRaw === null) return null

  const legacy = JSON.parse(legacyRaw)
  const { configs } = await window.api.migrateApiConfigs(legacy)
  // 迁移成功后才移除旧值；失败交给页面展示，保留原配置供重试。
  localStorage.removeItem('api-configs')
  return configs
}

export async function loadApiConfigs() {
  const migrated = await migrateLegacyApiConfigs()
  if (migrated !== null) return migrated

  return window.api.getApiConfigs()
}

export function notifyApiConfigsChanged() {
  window.dispatchEvent(new CustomEvent(API_CONFIGS_UPDATED_EVENT))
}

export async function saveApiConfigs(list, { notify = true } = {}) {
  const configs = await window.api.saveApiConfigs(serializeApiConfigs(list))
  if (notify) notifyApiConfigsChanged()
  return configs
}
