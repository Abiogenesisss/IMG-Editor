import { realpath, access } from 'fs/promises'
import { resolve, sep, join, extname } from 'path'

const allowedDirectories = new Set()

function normalizeKey(filePath) {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function withTrailingSeparator(filePath) {
  return filePath.endsWith(sep) ? filePath : `${filePath}${sep}`
}

async function canonicalPath(filePath) {
  try {
    return await realpath(filePath)
  } catch {
    return resolve(filePath)
  }
}

export async function grantLocalFileAccess(directoryPath) {
  if (!directoryPath) return null
  const canonical = await canonicalPath(directoryPath)
  allowedDirectories.add(normalizeKey(canonical))
  return canonical
}

export async function isLocalFileAccessAllowed(filePath) {
  if (!filePath) return false
  const canonical = normalizeKey(await canonicalPath(filePath))
  for (const directory of allowedDirectories) {
    if (canonical === directory || canonical.startsWith(withTrailingSeparator(directory))) {
      return true
    }
  }
  return false
}

const RESERVED_FILENAME_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

export function sanitizeSegment(
  value,
  fallback = 'image',
  { limit = 80, whitespace = '_', trim = false } = {}
) {
  const cleaned = String(value || fallback)
    .split('')
    .map((char) => (RESERVED_FILENAME_CHARS.has(char) || char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .replace(/\s+/g, whitespace)
    .replace(/\.+$/g, '')
  const normalized = trim ? cleaned.trim() : cleaned
  return (normalized || fallback).slice(0, limit)
}

export async function getAvailablePath(initialPath, makeNextPath) {
  let target = initialPath
  let counter = 2
  while (true) {
    try {
      await access(target)
      target = makeNextPath(counter)
      counter += 1
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      return target
    }
  }
}

export function getAvailableFilePath(directory, filename) {
  const ext = extname(filename)
  const stem = ext ? filename.slice(0, -ext.length) : filename
  return getAvailablePath(join(directory, filename), (counter) =>
    join(directory, `${stem}_${counter}${ext}`)
  )
}
