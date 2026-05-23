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
  try {
    const legacyRaw = localStorage.getItem('api-configs')
    if (legacyRaw === null) return null

    const legacy = JSON.parse(legacyRaw || '[]')
    const result = await window.api.migrateApiConfigs(Array.isArray(legacy) ? legacy : [])
    localStorage.removeItem('api-configs')
    return result?.configs || []
  } catch {
    // Keep the legacy value if migration fails so settings can retry later.
    return null
  }
}

export async function loadApiConfigs() {
  const migrated = await migrateLegacyApiConfigs()
  if (migrated !== null) return migrated

  try {
    return await window.api.getApiConfigs()
  } catch {
    return []
  }
}

export function notifyApiConfigsChanged() {
  window.dispatchEvent(new CustomEvent(API_CONFIGS_UPDATED_EVENT))
}

export async function saveApiConfigs(list, { notify = true } = {}) {
  const configs = await window.api.saveApiConfigs(serializeApiConfigs(list))
  if (notify) notifyApiConfigsChanged()
  return configs
}
