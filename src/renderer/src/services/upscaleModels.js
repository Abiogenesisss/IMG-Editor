import {
  createFallbackUpscaleCatalog,
  normalizeUpscaleCatalog
} from '../../../shared/upscaleCatalog'

export async function loadUpscaleCatalog() {
  const result = await window.api.callPython('/upscale-models', {})
  if (!result?.success) throw new Error(result?.error || '超分模型列表读取失败')
  return normalizeUpscaleCatalog(result.models)
}

export { createFallbackUpscaleCatalog }
