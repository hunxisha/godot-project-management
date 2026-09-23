// 零依赖解压:Windows 用 PowerShell Expand-Archive,macOS 用 unzip,
// Linux 用 unzip,失败回退 python3 -m zipfile
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    child.on('error', (e) => reject(new Error(`${cmd} 不可用: ${e.message}`)))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))))
  })
}

/** 确保目录存在 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

async function extractZip(zipPath, destDir) {
  ensureDir(destDir)
  if (process.platform === 'win32') {
    // -LiteralPath 支持含空格/中文的路径
    const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
    return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps])
  }
  try {
    return await run('unzip', ['-q', '-o', zipPath, '-d', destDir])
  } catch (e) {
    if (process.platform !== 'linux') throw e
    // Linux 无 unzip 时回退 python3
    return run('python3', ['-m', 'zipfile', '-e', zipPath, destDir])
  }
}

/** 递归求目录字节大小 */
function dirSize(dir) {
  let total = 0
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else {
        try {
          total += fs.statSync(p).size
        } catch (e) { /* ignore */ }
      }
    }
  }
  try {
    walk(dir)
  } catch (e) {
    return 0
  }
  return total
}

module.exports = { extractZip, ensureDir, dirSize }
