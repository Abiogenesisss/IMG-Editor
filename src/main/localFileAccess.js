import { realpath } from 'fs/promises'
import { resolve, sep } from 'path'

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
