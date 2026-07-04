function configText(config = {}) {
  return `${config.model || ''} ${config.name || ''} ${config.endpoint || ''}`.toLowerCase()
}

export function resolveImageProvider(config = {}) {
  if (config.provider === 'gpt' || config.provider === 'nanobanana') return config.provider

  const value = configText(config)
  if (/gpt[-_\s]?image|gpt[-_\s]?img|gpt.*\bimg\b/.test(value)) return 'gpt'
  if (/nano[-_\s]?banana|gemini.*image|flash-image|pro-image/.test(value)) {
    return 'nanobanana'
  }
  return ''
}

export function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

export function resolveOpenAIImageEndpoint(endpoint, mode = 'generate') {
  const raw = trimTrailingSlash(endpoint || 'https://api.openai.com/v1')
  const target = mode === 'edit' ? 'edits' : 'generations'
  const other = mode === 'edit' ? 'generations' : 'edits'

  if (new RegExp(`/images/${other}$`, 'i').test(raw)) {
    return raw.replace(new RegExp(`/images/${other}$`, 'i'), `/images/${target}`)
  }
  if (new RegExp(`/images/${target}$`, 'i').test(raw)) return raw
  if (/\/v\d+$/i.test(raw)) return `${raw}/images/${target}`

  try {
    const url = new URL(raw)
    if (url.pathname === '/' || url.pathname === '') {
      return `${raw}/v1/images/${target}`
    }
  } catch {
    /* use as a base path */
  }
  return `${raw}/images/${target}`
}

export function resolveGeminiInteractionsEndpoint(endpoint) {
  const raw = trimTrailingSlash(endpoint || 'https://generativelanguage.googleapis.com/v1beta')
  return /\/interactions$/i.test(raw) ? raw : `${raw}/interactions`
}
