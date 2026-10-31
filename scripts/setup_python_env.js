/**
 * 准备嵌入式 Python 环境。
 *
 * 使用方式: node scripts/setup_python_env.js
 */

import { execSync } from 'child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'

const PYTHON_VERSION = '3.11.9'
const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`
const BACKEND_DIR = join(import.meta.dirname, '..', 'python_backend')
const EMBED_DIR = join(BACKEND_DIR, 'python_embed')
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py'

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status} - ${url}`)

  const total = Number(res.headers.get('content-length') || 0)
  let downloaded = 0
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      downloaded += chunk.length
      if (total) {
        const pct = ((downloaded / total) * 100).toFixed(1)
        process.stdout.write(`\r  下载中... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB)`)
      }
      callback(null, chunk)
    }
  })

  await pipeline(Readable.fromWeb(res.body), progress, createWriteStream(dest))
  console.log()
}

async function main() {
  console.log('=== 准备嵌入式 Python 环境 ===\n')

  const zipPath = join(BACKEND_DIR, 'python_embed.zip')
  if (!existsSync(EMBED_DIR)) {
    console.log(`[1/4] 下载 Python ${PYTHON_VERSION} Embeddable...`)
    await download(PYTHON_URL, zipPath)

    console.log('[2/4] 解压 Python...')
    mkdirSync(EMBED_DIR, { recursive: true })
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${EMBED_DIR}' -Force"`,
      { stdio: 'inherit' }
    )
    rmSync(zipPath, { force: true })
  } else {
    console.log('[1/4] Python 目录已存在，跳过下载')
    console.log('[2/4] 跳过解压')
  }

  const pthName = readdirSync(EMBED_DIR).find((name) => /^python\d+\._pth$/.test(name))
  const pthFile = pthName ? join(EMBED_DIR, pthName) : ''
  if (existsSync(pthFile)) {
    let content = readFileSync(pthFile, 'utf-8')
    if (content.includes('#import site')) {
      content = content.replace('#import site', 'import site')
      writeFileSync(pthFile, content)
      console.log('  已启用 import site')
    }
  }

  const pythonExe = join(EMBED_DIR, 'python.exe')
  const pipExe = join(EMBED_DIR, 'Scripts', 'pip.exe')

  if (!existsSync(pipExe)) {
    console.log('[3/4] 安装 pip...')
    const getPipPath = join(BACKEND_DIR, 'get-pip.py')
    await download(GET_PIP_URL, getPipPath)
    execSync(`"${pythonExe}" "${getPipPath}"`, { stdio: 'inherit', cwd: EMBED_DIR })
    rmSync(getPipPath, { force: true })
  } else {
    console.log('[3/4] pip 已存在，跳过')
  }

  console.log('[4/4] 安装 Python 依赖（这可能需要几分钟）...')
  const requirementsPath = join(BACKEND_DIR, 'requirements-embed.txt')
  execSync(`"${pipExe}" install --no-cache-dir -r "${requirementsPath}"`, {
    stdio: 'inherit',
    cwd: BACKEND_DIR
  })

  console.log('\n=== Python 环境准备完成 ===')
  console.log(`  路径: ${EMBED_DIR}`)
  console.log(`  Python: ${pythonExe}`)
  console.log('  现在可以运行 npm run build:win 打包应用。')
}

main().catch((err) => {
  console.error('错误:', err.message)
  process.exit(1)
})
