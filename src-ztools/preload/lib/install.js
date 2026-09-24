// 版本安装编排:串行下载队列、任务注册表、安装/导入/删除
const fs = require('node:fs')
const path = require('node:path')
const { downloadFile } = require('./http')
const { extractZip, ensureDir, dirSize } = require('./extract')
const { findExecutable, verifyExecutable, parseVersionOutput, parseTagFromFileName, currentPlatform, displayName } = require('./godotExe')
const { putDoc, removeDoc } = require('./store')
const { createTaskQueue } = require('./taskqueue')

// ---------- 任务表(串行队列 + 进度订阅 + 取消) ----------
// 通用机制在 taskqueue.js;这里只保留下载语义(id 形状、status 字段、取消句柄)。
// 注:本模块的任务没有终态集合,因此任何状态都可被 dismiss(与原实现一致)。
const tasks = createTaskQueue({
  serial: true,
  // 保留原有 id 形状:dl-<毫秒时间戳>-<5 位随机>
  makeId: () => `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
})

/**
 * 更新任务字段(任务已被移除时静默跳过)。
 * @param {string} id
 * @param {import('./taskqueue').Task} patch
 */
function setTask(id, patch) {
  tasks.patch(tasks.get(id), patch)
}

/**
 * 下载并安装一个版本(入队,立即返回任务 id)。
 * @param {import('../../../src/types/services').DownloadParams} params
 * @param {{ versionsRoot: string }} opts
 * @returns {string} 任务 id
 */
function downloadAndInstall(params, opts) {
  const finalUrl = params.url
  const task = tasks.create({
    tag: params.tag,
    variant: params.variant,
    platform: params.platform,
    url: finalUrl,
    fileName: params.fileName,
    totalSize: params.totalSize,
    status: 'queued',
    received: 0,
    speed: 0
  })
  const id = task.id
  // 创建后广播一次,让订阅者立刻看到排队中的任务
  tasks.emit()

  const job = async () => {
    const queued = tasks.get(id)
    if (!queued || queued.status === 'canceled') return
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
      tasks.setToken(id, dl)
      const cur = tasks.get(id)
      if (!cur || cur.status === 'canceled') {
        dl.cancel()
        return
      }
      await dl.promise
      const afterDownload = tasks.get(id)
      if (!afterDownload || afterDownload.status === 'canceled') return

      setTask(id, { status: 'extracting' })
      await extractZip(zipPath, installDir)
      const afterExtract = tasks.get(id)
      if (!afterExtract || afterExtract.status === 'canceled') return

      setTask(id, { status: 'verifying' })
      const exePath = findExecutable(installDir)
      if (!exePath) throw new Error('解压后未找到 Godot 可执行文件')
      const { ok } = await verifyExecutable(exePath)
      const afterVerify = tasks.get(id)
      if (!afterVerify || afterVerify.status === 'canceled') return

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

  tasks.enqueue(job)
  return id
}

/**
 * 取消任务(排队中直接取消;下载中销毁请求)。
 * @param {string} id
 */
function cancelTask(id) {
  const task = tasks.get(id)
  if (!task) return
  const handle = tasks.tokenOf(id)
  if (handle) handle.cancel()
  setTask(id, { status: 'canceled' })
}

/**
 * 移除任务记录(完成/取消/错误后由渲染层调用)。
 * @param {string} id
 */
function dismissTask(id) {
  tasks.dismiss(id)
}

/**
 * 订阅任务快照变化,返回取消订阅函数。
 * @param {(tasks: import('./taskqueue').Task[]) => void} fn
 * @returns {() => void}
 */
function watchTasks(fn) {
  return tasks.watch(fn)
}

// ---------- 导入本地引擎 ----------
/**
 * 导入本地 Godot 可执行文件。
 * @param {string} exePath
 * @returns {Promise<{ok: boolean, error?: string, version?: import('../../../src/types/godot').GodotVersion}>}
 */
async function importLocalExe(exePath) {
  try {
    if (!fs.existsSync(exePath)) return { ok: false, error: '文件不存在' }
    const fileName = path.basename(exePath)
    const { ok: verified, output } = await verifyExecutable(exePath)
    const tag = parseVersionOutput(output) || parseTagFromFileName(fileName) || 'local'
    /** @type {import('../../../src/types/godot').Variant} mono 版文件名带 mono,其余按 standard */
    const variant = /mono/i.test(fileName) ? 'mono' : 'standard'
    const platform = currentPlatform()
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
/**
 * 删除已装版本:可选连同安装目录一起删除,并移除记录。
 * @param {{ id: string, installDir?: string, managed: boolean }} v
 * @returns {{ ok: boolean, error?: string }}
 */
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
