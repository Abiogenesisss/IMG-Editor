const MODEL_LABELS = {
  'real-cugan': 'Real-CUGAN',
  'real-esrgan': 'Real-ESRGAN',
  waifu2x: 'Waifu2x'
}

const DENOISE_LABELS = {
  none: '默认',
  'no-denoise': '无降噪',
  denoise0: '降噪 0',
  denoise1: '降噪 1',
  denoise2: '降噪 2',
  denoise3: '降噪 3',
  denoise1x: '降噪 1X',
  denoise2x: '降噪 2X',
  denoise3x: '降噪 3X'
}

const FALLBACK_MODELS = {
  'real-cugan': {
    '2x-no-denoise': { scale: 2, denoise: 'no-denoise', installed: true },
    '2x-denoise1x': { scale: 2, denoise: 'denoise1x', installed: true },
    '2x-denoise2x': { scale: 2, denoise: 'denoise2x', installed: true },
    '2x-denoise3x': { scale: 2, denoise: 'denoise3x', installed: true },
    '3x-denoise3x': { scale: 3, denoise: 'denoise3x', installed: true },
    '4x-denoise3x': { scale: 4, denoise: 'denoise3x', installed: true }
  },
  'real-esrgan': {
    '4x': { scale: 4, installed: true }
  },
  waifu2x: {
    styles: ['art', 'art_scan', 'photo'],
    scales: [1, 2, 4],
    denoise_levels: [-1, 0, 1, 2, 3],
    tta: true
  }
}

function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
}

function denoiseFromLevel(level) {
  return Number(level) < 0 ? 'no-denoise' : `denoise${Number(level)}`
}

function normalizeCugan(raw = {}) {
  return Object.values(raw)
    .filter((item) => item && Number.isFinite(Number(item.scale)) && item.denoise)
    .map((item) => ({
      scale: Number(item.scale),
      denoise: item.denoise,
      installed: item.installed !== false
    }))
}

function normalizeEsrgan(raw = {}) {
  const installed = Object.values(raw).some((item) => item?.installed !== false)
  return [
    { scale: 2, denoise: 'none', installed },
    { scale: 4, denoise: 'none', installed }
  ]
}

function normalizeWaifu2x(raw = {}) {
  const scales = uniqueNumbers(raw.scales || [1, 2, 4])
  const denoise = (raw.denoise_levels || [-1, 0, 1, 2, 3]).map(denoiseFromLevel)
  return scales.flatMap((scale) =>
    denoise.map((value) => ({ scale, denoise: value, installed: true }))
  )
}

export function normalizeUpscaleCatalog(models = FALLBACK_MODELS) {
  const source = models && Object.keys(models).length ? models : FALLBACK_MODELS
  return {
    'real-cugan': {
      key: 'real-cugan',
      label: MODEL_LABELS['real-cugan'],
      defaultScale: 2,
      defaultDenoise: 'denoise3x',
      styles: ['art'],
      tta: false,
      variants: normalizeCugan(source['real-cugan'])
    },
    'real-esrgan': {
      key: 'real-esrgan',
      label: MODEL_LABELS['real-esrgan'],
      defaultScale: 4,
      defaultDenoise: 'none',
      styles: ['art'],
      tta: false,
      variants: normalizeEsrgan(source['real-esrgan'])
    },
    waifu2x: {
      key: 'waifu2x',
      label: MODEL_LABELS.waifu2x,
      defaultScale: 2,
      defaultDenoise: 'denoise2',
      styles: source.waifu2x?.styles || ['art', 'art_scan', 'photo'],
      tta: source.waifu2x?.tta !== false,
      variants: normalizeWaifu2x(source.waifu2x)
    }
  }
}

export function createFallbackUpscaleCatalog() {
  return normalizeUpscaleCatalog(FALLBACK_MODELS)
}

export function listUpscaleModels(catalog) {
  return Object.values(catalog || {}).map((item) => ({
    value: item.key,
    label: item.variants.some((variant) => variant.installed)
      ? item.label
      : `${item.label}（未安装）`,
    available: item.variants.some((variant) => variant.installed)
  }))
}

export function getUpscaleScaleOptions(catalog, model) {
  const variants = catalog?.[model]?.variants || []
  return uniqueNumbers(variants.filter((item) => item.installed).map((item) => item.scale)).map(
    (value) => ({ value, label: `${value}X` })
  )
}

export function getUpscaleDenoiseOptions(catalog, model, scale) {
  const variants = catalog?.[model]?.variants || []
  return [
    ...new Set(
      variants
        .filter((item) => item.installed && item.scale === Number(scale))
        .map((item) => item.denoise)
    )
  ].map((value) => ({ value, label: DENOISE_LABELS[value] || value }))
}

export function getUpscaleStyleOptions(catalog, model) {
  return (catalog?.[model]?.styles || ['art']).map((value) => ({
    value,
    label: value === 'art_scan' ? 'Art Scan' : value[0].toUpperCase() + value.slice(1)
  }))
}

export function validateUpscaleSelection(catalog, { model, scale, denoise, style }) {
  const config = catalog?.[model]
  if (!config) return { valid: false, error: `未知超分模型：${model}` }
  if (style && !config.styles.includes(style)) {
    return { valid: false, error: `${config.label} 不支持风格 ${style}` }
  }

  const variant = config.variants.find(
    (item) => item.scale === Number(scale) && item.denoise === denoise
  )
  if (!variant) {
    return {
      valid: false,
      error: `${config.label} 不支持 ${scale}X / ${denoise}`
    }
  }
  if (!variant.installed) {
    return { valid: false, error: `${config.label} 对应模型文件未安装` }
  }
  return { valid: true }
}
