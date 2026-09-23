// 版本安装编排:串行下载队列、任务注册表、安装/导入/删除
const fs = require('node:fs')
const path = require('node:path')
const { downloadFile } = require('./http')
const { extractZip, ensureDir, dirSize } = require('./extract')
const { findExecutable, verifyExecutable, parseVersionOutput, parseTagFromFileName } = require('./godotExe')
const { putDoc, removeDoc } = require('./store')

// ---------- 任务注册表 ----------
// id → { pub(对外快照), handle(取消句柄) }
const registry = new Map()
const listeners = new Set()

function emit() {
  const snapshot = [...registry.values()].map((v) => v.pub)
  for (const l of listeners) l(snapshot)
}

function setTask(id, patch) {
  const cur = registry.get(id)
  if (!cur) return
  registry.set(id, { ...cur, pub: { ...cur.pub, ...patch } })
  emit()
}

// ---------- 串行队列 ----------
const queue = []
let running = false

async function pump() {
  if (running) return
  const job = queue.shift()
  if (!job) return
  running = true
  try {
    await job()
  } finally {
    running = false
    pump()
  }
}

function displayName(tag) {
  const idx = tag.indexOf('-')
  if (idx < 0) return tag
  const ver = tag.slice(0, idx)
  const channel = tag.slice(idx + 1)
  return `${ver} ${channel.charAt(0).toUpperCase()}${channel.slice(1)}`
}

const platformOfProcess = () => (process.platform === 'win32' ? 'win64' : process.platform === 'darwin' ? 'macos' : 'linux64')

/**
 * 下载并安装一个版本(入队,立即返回任务 id)。
 * @param {{ tag, variant, platform, url, fileName, totalSize }} params
 * @param {{ versionsRoot: string }} opts
 */
function downloadAndInstall(params, opts) {
  const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const finalUrl = params.url
  registry.set(id, {
    pub: {
      id,
      tag: params.tag,
      variant: params.variant,
      platform: params.platform,
      url: finalUrl,
      fileName: params.fileName,
      totalSize: params.totalSize,
      status: 'queued',
      received: 0,
      speed: 0
    },
    handle: null
  })
  emit()

  const job = async () => {
    const task = registry.get(id)
    if (!task || task.pub.status === 'canceled') return
    const installDir = path.join(opts.versionsRoot, `Godot_${params.tag}_${params.variant}_${params.platform}`)
    const downloadsDir = path.join(opts.versionsRoot, 'downloads')
    const zipPath = path.join(downloadsDir, params.fileName + '.part')

    try {
      ensureDir(downloadsDir)
      setTask(id, { status: 'downloading' })
      let lastTime = Date.now()
      let lastReceived = 0
      const dl = downloadFile(finalUrl, zipPath, {
        total: params.totalSize,
        onProgress: (received, total) => {
          const now = Date.now()
          const speed = Math.max(0, ((received - lastReceived) / Math.max(1, now - lastTime)) * 1000)
          lastTime = now
          lastReceived = received
          setTask(id, { received, totalSize: total || params.totalSize, speed })
        }
      })
      registry.set(id, { ...registry.get(id), handle: dl })
      if (registry.get(id).pub.status === 'canceled') {
        dl.cancel()
        return
      }
      await dl.promise
      if (registry.get(id).pub.status === 'canceled') return

      setTask(id, { status: 'extracting' })
      await extractZip(zipPath, installDir)
      if (registry.get(id).pub.status === 'canceled') return

      setTask(id, { status: 'verifying' })
      const exePath = findExecutable(installDir)
      if (!exePath) throw new Error('解压后未找到 Godot 可执行文件')
      const { ok } = await verifyExecutable(exePath)
      if (registry.get(id).pub.status === 'canceled') return

      const versionId = `godot/version/${params.tag}-${params.variant}-${params.platform}`
      const version = {
        id: versionId,
        tag: params.tag,
        name: displayName(params.tag),
        variant: params.variant,
        platform: params.platform,
        exePath,
        installDir,
        managed: true,
        source: finalUrl,
        installedAt: Date.now(),
        size: dirSize(installDir),
        verified: ok
      }
      putDoc(versionId, version)
      setTask(id, { status: 'done', versionId, version })
    } catch (e) {
      const message = e && e.message === '已取消' ? '已取消' : (e && e.message) || '安装失败'
      if (message === '已取消') {
        setTask(id, { status: 'canceled' })
      } else {
        setTask(id, { status: 'error', error: message })
      }
    } finally {
      try {
        fs.existsSync(zipPath) && fs.unlinkSync(zipPath)
      } catch (e) { /* ignore */ }
    }
  }

  queue.push(job)
  pump()
  return id
}

/** 取消任务(排队中直接取消;下载中销毁请求) */
function cancelTask(id) {
  const cur = registry.get(id)
  if (!cur) return
  if (cur.handle) {
    cur.handle.cancel()
    setTask(id, { status: 'canceled' })
  } else {
    setTask(id, { status: 'canceled' })
  }
}

/** 移除任务记录(完成/取消/错误后由渲染层调用) */
function dismissTask(id) {
  registry.delete(id)
  emit()
}

/** 订阅任务快照变化,返回取消订阅函数 */
function watchTasks(fn) {
  listeners.add(fn)
  fn([...registry.values()].map((v) => v.pub))
  return () => listeners.delete(fn)
}

// ---------- 导入本地引擎 ----------
/**
 * 导入本地 Godot 可执行文件,返回 { ok, error?, version? }
 */
async function importLocalExe(exePath) {
  try {
    if (!fs.existsSync(exePath)) return { ok: false, error: '文件不存在' }
    const fileName = path.basename(exePath)
    const { ok: verified, output } = await verifyExecutable(exePath)
    const tag = parseVersionOutput(output) || parseTagFromFileName(fileName) || 'local'
    const variant = /mono/i.test(fileName) ? 'mono' : 'standard'
    const platform = platformOfProcess()
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(exePath, 0o755)
      } catch (e) { /* ignore */ }
    }
    const versionId = `godot/version/${tag}-${variant}-${platform}`
    const version = {
      id: versionId,
      tag,
      name: displayName(tag),
      variant,
      platform,
      exePath,
      managed: false,
      source: 'local',
      installedAt: Date.now(),
      verified
    }
    putDoc(versionId, version)
    return { ok: true, version }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '导入失败' }
  }
}

// ---------- 删除版本 ----------
function deleteVersion({ id, installDir, managed }) {
  try {
    if (managed && installDir) {
      fs.rmSync(installDir, { recursive: true, force: true })
    }
    removeDoc(id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '删除失败' }
  }
}

module.exports = {
  downloadAndInstall,
  cancelTask,
  dismissTask,
  watchTasks,
  importLocalExe,
  deleteVersion,
  displayName
}
