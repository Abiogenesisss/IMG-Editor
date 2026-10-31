import { mkdir, writeFile } from 'fs/promises'
import { extname, basename } from 'path'
import sharp from 'sharp'
import { beginTask } from './taskRuntime'
import { grantLocalFileAccess, sanitizeSegment, getAvailableFilePath } from './localFiles'

const GRAB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const GRAB_PREVIEW_MAX_BYTES = 32 * 1024 * 1024
const GRAB_FETCH_TIMEOUT_MS = 15000
const GRAB_ATTRS = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-image']
const GRAB_EXT_TO_TYPE = new Map([
  ['.jpg', 'jpg'],
  ['.jpeg', 'jpg'],
  ['.png', 'png'],
  ['.webp', 'webp'],
  ['.gif', 'gif'],
  ['.bmp', 'bmp'],
  ['.tif', 'tiff'],
  ['.tiff', 'tiff'],
  ['.avif', 'avif']
])
const GRAB_TYPE_TO_EXT = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
  ['image/tiff', '.tiff'],
  ['image/avif', '.avif']
])

function grabFetchSignal(taskSignal) {
  return AbortSignal.any([taskSignal, AbortSignal.timeout(GRAB_FETCH_TIMEOUT_MS)])
}

function grabFetchErrorMessage(err, fallback) {
  return err.name === 'TimeoutError' ? '请求超时' : err.message || fallback
}

function decodeHtmlEntities(value) {
  if (!value) return ''
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function normalizeSourceUrl(value, baseUrl) {
  const raw = decodeHtmlEntities(String(value || '').trim())
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('javascript:')) {
    return null
  }
  try {
    const url = new URL(raw, baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function getUrlImageExt(url) {
  try {
    return extname(new URL(url).pathname).toLowerCase()
  } catch {
    return ''
  }
}

function getUrlImageType(url) {
  return GRAB_EXT_TO_TYPE.get(getUrlImageExt(url)) || ''
}

function matchesAllowedTypes(url, allowedTypes) {
  const ext = getUrlImageExt(url)
  if (!ext) return true

  const type = GRAB_EXT_TO_TYPE.get(ext)
  if (!type) return false

  return !allowedTypes || allowedTypes.size === 0 || allowedTypes.has(type)
}

function looksLikeImageUrl(url) {
  return Boolean(getUrlImageType(url))
}

function splitSrcset(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean)
}

function parseAttributes(tag) {
  const attrs = {}
  const attrPattern = /([:@\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  let match
  while ((match = attrPattern.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? ''
  }
  return attrs
}

function buildGrabItem(url, sourceUrl, sourceKind, sourceIndex) {
  const type = getUrlImageType(url)
  return {
    id: `${sourceIndex}-${Buffer.from(url).toString('base64url').slice(0, 24)}`,
    url,
    source: sourceUrl,
    sourceKind,
    filename: deriveGrabFilename(url, type),
    type
  }
}

function pushGrabCandidate(list, seen, url, sourceUrl, sourceKind, sourceIndex, allowedTypes) {
  if (!url || seen.has(url) || !matchesAllowedTypes(url, allowedTypes)) return
  seen.add(url)
  list.push(buildGrabItem(url, sourceUrl, sourceKind, sourceIndex))
}

function extractImageCandidates(html, pageUrl, options) {
  const { includeSrcset, allowedTypes, maxPerSource, sourceIndex } = options
  const items = []
  const seen = new Set()

  const tagPattern = /<(img|source|meta|link)\b[^>]*>/gi
  let tagMatch
  while ((tagMatch = tagPattern.exec(html)) !== null) {
    const tagName = tagMatch[1].toLowerCase()
    const attrs = parseAttributes(tagMatch[0])

    if (tagName === 'img' || tagName === 'source') {
      for (const attr of GRAB_ATTRS) {
        const url = normalizeSourceUrl(attrs[attr], pageUrl)
        pushGrabCandidate(items, seen, url, pageUrl, 'page', sourceIndex, allowedTypes)
      }
      if (includeSrcset) {
        for (const attr of ['srcset', 'data-srcset']) {
          for (const entry of splitSrcset(attrs[attr])) {
            const url = normalizeSourceUrl(entry, pageUrl)
            pushGrabCandidate(items, seen, url, pageUrl, 'page', sourceIndex, allowedTypes)
          }
        }
      }
    } else if (tagName === 'meta') {
      const metaKey = `${attrs.property || ''} ${attrs.name || ''}`.toLowerCase()
      if (metaKey.includes('image')) {
        const url = normalizeSourceUrl(attrs.content, pageUrl)
        pushGrabCandidate(items, seen, url, pageUrl, 'meta', sourceIndex, allowedTypes)
      }
    } else if (tagName === 'link') {
      const rel = String(attrs.rel || '').toLowerCase()
      const asType = String(attrs.as || '').toLowerCase()
      const type = String(attrs.type || '').toLowerCase()
      if (asType === 'image' || type.startsWith('image/') || rel.includes('icon')) {
        const url = normalizeSourceUrl(attrs.href, pageUrl)
        pushGrabCandidate(items, seen, url, pageUrl, 'link', sourceIndex, allowedTypes)
      }
    }

    if (items.length >= maxPerSource) return items.slice(0, maxPerSource)
  }

  const cssUrlPattern = /url\(\s*(['"]?)(.*?)\1\s*\)/gi
  let cssMatch
  while ((cssMatch = cssUrlPattern.exec(html)) !== null) {
    const url = normalizeSourceUrl(cssMatch[2], pageUrl)
    if (url && looksLikeImageUrl(url)) {
      pushGrabCandidate(items, seen, url, pageUrl, 'style', sourceIndex, allowedTypes)
    }
    if (items.length >= maxPerSource) return items.slice(0, maxPerSource)
  }

  const plainImageUrlPattern =
    /https?:\/\/[^"' <>)]+?\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)(?:\?[^"' <>)]+)?/gi
  let plainMatch
  while ((plainMatch = plainImageUrlPattern.exec(html)) !== null) {
    const url = normalizeSourceUrl(plainMatch[0], pageUrl)
    pushGrabCandidate(items, seen, url, pageUrl, 'inline', sourceIndex, allowedTypes)
    if (items.length >= maxPerSource) return items.slice(0, maxPerSource)
  }

  return items.slice(0, maxPerSource)
}

function normalizeGrabSources(sources) {
  if (Array.isArray(sources)) return sources.map((s) => String(s || '').trim()).filter(Boolean)
  return String(sources || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function normalizeAllowedTypes(types) {
  if (!Array.isArray(types)) return new Set()
  return new Set(types.map((type) => String(type || '').toLowerCase()).filter(Boolean))
}

function deriveGrabFilename(url, type = '') {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname)
    const name = basename(pathname) || `image.${type || 'jpg'}`
    return sanitizeSegment(name, 'image', { limit: 140, whitespace: ' ', trim: true })
  } catch {
    return `image.${type || 'jpg'}`
  }
}

function getContentTypeExt(contentType) {
  const normalized = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return GRAB_TYPE_TO_EXT.get(normalized) || ''
}

function buildGrabHeaders(
  referer = '',
  accept = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
) {
  const headers = {
    'User-Agent': GRAB_USER_AGENT,
    Accept: accept,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
  if (referer) headers.Referer = referer
  return headers
}

function ensureImageExtension(filename, url, contentType) {
  const clean = sanitizeSegment(filename, 'image', { limit: 140, whitespace: ' ', trim: true })
  const currentExt = extname(clean).toLowerCase()
  if (GRAB_EXT_TO_TYPE.has(currentExt)) return clean

  const contentExt = getContentTypeExt(contentType)
  if (contentExt) return `${clean}${contentExt}`

  try {
    const urlExt = extname(new URL(url).pathname).toLowerCase()
    if (GRAB_EXT_TO_TYPE.has(urlExt)) return `${clean}${urlExt}`
  } catch {
    /* ignore */
  }

  return `${clean}.jpg`
}

export async function scanImageSources(event, body = {}) {
  const sources = normalizeGrabSources(body.sources)
  const allowedTypes = normalizeAllowedTypes(body.file_types)
  const includeSrcset = body.include_srcset !== false
  const maxPerSource = Math.max(1, Math.min(parseInt(body.max_per_source, 10) || 120, 500))
  const items = []
  const errors = []
  const seen = new Set()

  if (sources.length === 0) {
    return { success: false, error: '请输入至少一个 URL。' }
  }

  const { controller, finish } = beginTask(event.sender)

  try {
    for (let index = 0; index < sources.length; index += 1) {
      const rawSource = sources[index]
      const sourceUrl = normalizeSourceUrl(rawSource)
      if (!sourceUrl) {
        errors.push({ source: rawSource, error: 'URL 无效' })
        continue
      }

      try {
        if (looksLikeImageUrl(sourceUrl)) {
          pushGrabCandidate(items, seen, sourceUrl, sourceUrl, 'direct', index, allowedTypes)
        } else {
          const response = await fetch(sourceUrl, {
            headers: buildGrabHeaders(
              '',
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
            ),
            signal: grabFetchSignal(controller.signal)
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)

          const contentType = response.headers.get('content-type') || ''
          if (contentType.toLowerCase().startsWith('image/')) {
            pushGrabCandidate(items, seen, sourceUrl, sourceUrl, 'direct', index, allowedTypes)
          } else {
            const html = await response.text()
            const extracted = extractImageCandidates(html, sourceUrl, {
              includeSrcset,
              allowedTypes,
              maxPerSource,
              sourceIndex: index
            })
            for (const item of extracted) {
              if (!seen.has(item.url)) {
                seen.add(item.url)
                items.push(item)
              }
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err
        errors.push({ source: rawSource, error: grabFetchErrorMessage(err, '抓取失败') })
      } finally {
        event.sender.send('task-progress', {
          scope: 'grab-scan',
          done: index + 1,
          total: sources.length,
          current: rawSource
        })
      }
    }

    return { success: true, items, errors }
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, aborted: true }
    return { success: false, error: err.message || '抓取失败', items, errors }
  } finally {
    finish()
  }
}

export async function downloadGrabImages(event, body = {}) {
  const items = Array.isArray(body.items) ? body.items : []
  const outputDir = String(body.output_dir || '').trim()
  const results = []

  if (items.length === 0) return { success: false, error: '没有选择要保存的图片。' }
  if (!outputDir) return { success: false, error: '请选择输出目录。' }

  const { controller, finish } = beginTask(event.sender)

  try {
    await mkdir(outputDir, { recursive: true })
    await grantLocalFileAccess(outputDir)

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const url = normalizeSourceUrl(item.url)
      if (!url) {
        results.push({ id: item.id, url: item.url, success: false, error: 'URL 无效' })
        continue
      }

      try {
        const response = await fetch(url, {
          headers: buildGrabHeaders(item.source || url),
          signal: grabFetchSignal(controller.signal)
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.toLowerCase().startsWith('image/') && !looksLikeImageUrl(url)) {
          throw new Error(`非图片响应: ${contentType || 'unknown'}`)
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length === 0) throw new Error('空文件')

        const filename = ensureImageExtension(
          item.filename || deriveGrabFilename(url, item.type),
          url,
          contentType
        )
        const targetPath = await getAvailableFilePath(outputDir, filename)
        await writeFile(targetPath, buffer)
        results.push({
          id: item.id,
          url,
          success: true,
          path: targetPath,
          filename: basename(targetPath),
          bytes: buffer.length
        })
      } catch (err) {
        if (err.name === 'AbortError') throw err
        results.push({
          id: item.id,
          url,
          success: false,
          error: grabFetchErrorMessage(err, '保存失败')
        })
      } finally {
        event.sender.send('task-progress', {
          scope: 'grab-download',
          done: index + 1,
          total: items.length,
          current: item.filename || item.url
        })
      }
    }

    const saved = results.filter((item) => item.success).length
    return {
      success: true,
      output_dir: outputDir,
      saved,
      failed: results.length - saved,
      results
    }
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, aborted: true, results }
    return { success: false, error: err.message || '保存失败', results }
  } finally {
    finish()
  }
}

export async function loadGrabPreview(_event, body = {}) {
  const url = normalizeSourceUrl(body.url)
  const referer = normalizeSourceUrl(body.source) || url

  if (!url) return { success: false, error: 'URL 无效' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)

  try {
    const response = await fetch(url, {
      headers: buildGrabHeaders(referer),
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.toLowerCase().startsWith('image/') && !looksLikeImageUrl(url)) {
      throw new Error(`非图片响应: ${contentType || 'unknown'}`)
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
    if (contentLength > GRAB_PREVIEW_MAX_BYTES) {
      throw new Error('图片过大，跳过预览')
    }

    const input = Buffer.from(await response.arrayBuffer())
    if (input.length === 0) throw new Error('空文件')
    if (input.length > GRAB_PREVIEW_MAX_BYTES) throw new Error('图片过大，跳过预览')

    try {
      const preview = await sharp(input, { failOn: 'none' })
        .rotate()
        .resize(900, 900, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 86 })
        .toBuffer()
      return {
        success: true,
        dataUrl: `data:image/webp;base64,${preview.toString('base64')}`
      }
    } catch (err) {
      const mime = String(contentType || '')
        .split(';')[0]
        .trim()
        .toLowerCase()
      if (mime.startsWith('image/') && input.length <= 8 * 1024 * 1024) {
        return {
          success: true,
          dataUrl: `data:${mime};base64,${input.toString('base64')}`
        }
      }
      throw err
    }
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, error: '预览加载超时' }
    return { success: false, error: err.message || '预览加载失败' }
  } finally {
    clearTimeout(timer)
  }
}
