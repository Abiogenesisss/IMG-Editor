/**
 * 准备嵌入式 Python 环境的脚本
 *
 * 使用方式:  node scripts/setup_python_env.js
 *
 * 该脚本会:
 * 1. 下载 Python Embeddable Package (Windows x64)
 * 2. 解压到 python_backend/python_embed/
 * 3. 安装 pip
 * 4. 用 pip 安装 requirements.txt 中的依赖
 *
 * 完成后 python_backend/ 目录即可整体打包进 Electron 应用。
 */

import { execSync } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import https from 'https'
import http from 'http'

const PYTHON_VERSION = '3.11.9'
const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`
const BACKEND_DIR = join(import.meta.dirname, '..', 'python_backend')
const EMBED_DIR = join(BACKEND_DIR, 'python_embed')
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py'

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    const getter = url.startsWith('https') ? https : http
    getter
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close()
          return download(res.headers.location, dest).then(resolve, reject)
        }
        if (res.statusCode !== 200) {
          file.close()
          return reject(new Error(`下载失败: HTTP ${res.statusCode} - ${url}`))
        }
        const total = parseInt(res.headers['content-length'] || '0')
        let downloaded = 0
        res.on('data', (chunk) => {
          downloaded += chunk.length
          if (total) {
            const pct = ((downloaded / total) * 100).toFixed(1)
            process.stdout.write(
              `\r  下载中... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB)`
            )
          }
        })
        res.pipe(file)
        file.on('finish', () => {
          file.close()
          console.log()
          resolve()
        })
      })
      .on('error', (err) => {
        file.close()
        reject(err)
      })
  })
}

async function main() {
  console.log('=== 准备嵌入式 Python 环境 ===\n')

  // 1. 下载 Python Embeddable
  const zipPath = join(BACKEND_DIR, 'python_embed.zip')
  if (!existsSync(EMBED_DIR)) {
    console.log(`[1/4] 下载 Python ${PYTHON_VERSION} Embeddable...`)
    await download(PYTHON_URL, zipPath)

    // 2. 解压
    console.log('[2/4] 解压 Python...')
    mkdirSync(EMBED_DIR, { recursive: true })
    // 使用 PowerShell 解压 zip
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${EMBED_DIR}' -Force"`,
      { stdio: 'inherit' }
    )
    // 删除 zip
    execSync(`del "${zipPath}"`, { stdio: 'ignore', shell: true })
  } else {
    console.log('[1/4] Python 目录已存在，跳过下载')
    console.log('[2/4] 跳过解压')
  }

  // 3. 启用 import site，使 pip 能正常工作
  //    Python embeddable 默认禁用 site-packages，需要修改 python3xx._pth 文件
  const pthFile = join(EMBED_DIR, `python311._pth`)
  if (existsSync(pthFile)) {
    let content = readFileSync(pthFile, 'utf-8')
    if (content.includes('#import site')) {
      content = content.replace('#import site', 'import site')
      writeFileSync(pthFile, content)
      console.log('  已启用 import site')
    }
  }

  // 4. 安装 pip
  const pythonExe = join(EMBED_DIR, 'python.exe')
  const pipExe = join(EMBED_DIR, 'Scripts', 'pip.exe')

  if (!existsSync(pipExe)) {
    console.log('[3/4] 安装 pip...')
    const getPipPath = join(BACKEND_DIR, 'get-pip.py')
    await download(GET_PIP_URL, getPipPath)
    execSync(`"${pythonExe}" "${getPipPath}"`, { stdio: 'inherit', cwd: EMBED_DIR })
    execSync(`del "${getPipPath}"`, { stdio: 'ignore', shell: true })
  } else {
    console.log('[3/4] pip 已存在，跳过')
  }

  // 5. 安装依赖
  console.log('[4/4] 安装 Python 依赖（这可能需要几分钟）...')
  const requirementsPath = join(BACKEND_DIR, 'requirements-embed.txt')
  execSync(`"${pipExe}" install --no-cache-dir -r "${requirementsPath}"`, {
    stdio: 'inherit',
    cwd: BACKEND_DIR
  })

  console.log('\n=== Python 环境准备完成 ===')
  console.log(`  路径: ${EMBED_DIR}`)
  console.log(`  Python: ${pythonExe}`)
  console.log('  现在可以运行 npm run build:win 来打包应用了。')
}

main().catch((err) => {
  console.error('错误:', err.message)
  process.exit(1)
})
