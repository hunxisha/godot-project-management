// 定位解压目录中的 Godot 可执行文件,并执行 --version 校验
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/** 递归收集目录下的文件(限制深度) */
function walkFiles(dir, depth = 0, maxDepth = 3) {
  const out = []
  if (depth > maxDepth) return out
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkFiles(p, depth + 1, maxDepth))
    else out.push(p)
  }
  return out
}

/**
 * 在安装目录中定位 Godot 可执行文件。
 * - Windows: 排除 _console 的 .exe
 * - macOS: 优先 Godot.app/Contents/MacOS/*,并清除 quarantine 标记
 * - Linux: 名称含 godot 的文件,chmod 755
 */
function findExecutable(installDir) {
  const files = walkFiles(installDir)
  const platform = process.platform

  if (platform === 'win32') {
    const exes = files.filter((f) => f.toLowerCase().endsWith('.exe') && !f.toLowerCase().includes('_console'))
    return exes[0] || null
  }

  if (platform === 'darwin') {
    const appFile = files.find((f) => /\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(f))
    if (appFile) {
      try {
        spawn('xattr', ['-d', 'com.apple.quarantine', appFile]).on('error', () => {})
      } catch (e) { /* ignore */ }
      return appFile
    }
    return files.find((f) => /godot/i.test(path.basename(f))) || null
  }

  // linux
  const exe = files.find((f) => /godot/i.test(path.basename(f)))
  if (exe) {
    try {
      fs.chmodSync(exe, 0o755)
    } catch (e) { /* ignore */ }
  }
  return exe || null
}

/**
 * 执行 <exe> --version,超时 15s。
 * 返回 { ok, output }——ok=false 表示未能确认,不阻断安装。
 */
function verifyExecutable(exePath) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok, output) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok, output })
    }
    let out = ''
    let child
    try {
      child = spawn(exePath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return finish(false, '')
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch (e) { /* ignore */ }
      finish(false, out)
    }, 15000)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('error', () => finish(false, out))
    child.on('close', (code) => finish(code === 0 && out.trim().length > 0, out.trim()))
  })
}

/** 从 --version 输出解析版本号:如 "4.3.stable.official.xxx" → "4.3-stable" */
function parseVersionOutput(output) {
  const m = /^(\d+\.\d+(?:\.\d+)?)\.(stable|beta\d*|rc\d*|alpha\d*|dev\d*)/i.exec(output.trim())
  if (!m) return null
  return `${m[1]}-${m[2].toLowerCase()}`
}

/** 从文件名解析版本 tag:如 Godot_v4.3-stable_win64.exe → 4.3-stable */
function parseTagFromFileName(fileName) {
  const m = /_v(\d[\w.\-]*?)-((?:stable|beta\d*|rc\d*|alpha\d*|dev\d*))/i.exec(fileName)
  return m ? `${m[1]}-${m[2].toLowerCase()}` : null
}

module.exports = { findExecutable, verifyExecutable, parseVersionOutput, parseTagFromFileName }
