// 版本安装编排:串行下载队列、任务注册表、安装/导入/删除
const fs = require('node:fs')
const path = require('node:path')
const { downloadResumable } = require('./http')
const { extractZip, ensureDir, dirSize, inspectZip } = require('./extract')
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
 * 下载候选地址:主地址(官方 CDN)+ 备用直链(官方构建仓库同名资产),去重且丢弃空值。
 * @param {string} url
 * @param {string} [fallbackUrl]
 * @returns {string[]}
 */
function downloadSources(url, fallbackUrl) {
  /** @type {string[]} */
  const out = []
  for (const u of [url, fallbackUrl]) {
    if (u && !out.includes(u)) out.push(u)
  }
  return out
}

/**
 * 上游「这个地址没有这个包」的判据:CDN 映射滞后会 404,产物被撤下会 403。
 * 只有这类错误才值得换备用直链 —— 网络断了换地址没有意义。
 * @param {unknown} e
 * @returns {boolean}
 */
function isMissingAssetError(e) {
  return /HTTP 40[34]/.test((/** @type {Error} */ (e) && /** @type {Error} */ (e).message) || '')
}

/**
 * 失败原因 → 给用户看的一句话;原始原因留在任务的 errorDetail 里备查。
 * 404 的实测成因只有一个:上游把版本列进了归档页,却没发布当前平台的产物
 * (如 4.8-dev7:归档页有条目,构建仓库里只有 Android 与模板,没有桌面版包),
 * 这时说「下载失败 HTTP 404」等于没说。
 * @param {unknown} e
 * @returns {string}
 */
function describeFailure(e) {
  const raw = (/** @type {Error} */ (e) && /** @type {Error} */ (e).message) || '安装失败'
  if (raw === '已取消') return '已取消'
  if (isMissingAssetError(e)) return '该版本暂无当前平台的构建产物(上游未发布或已下架),请换一个版本再试'
  return raw
}

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
  const fallbackUrl = params.fallbackUrl || ''
  const task = tasks.create({
    tag: params.tag,
    variant: params.variant,
    platform: params.platform,
    url: finalUrl,
    fallbackUrl,
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
    // 成功后才清理 .part;失败保留(已下载字节留在盘上,重试从断点继续)
    let succeeded = false
    /** 真正下成的地址(可能是备用直链),落库时记它而不是主地址 */
    let usedUrl = finalUrl

    /**
     * 依次尝试候选地址。仅当上游确实没有这个包(404/403)时才换下一个地址重来;
     * 换地址后从零开始 —— .part 里可能是另一个地址的半截内容,续传会拼出坏包。
     * @returns {Promise<void>}
     */
    const runDownload = async () => {
      const sources = downloadSources(finalUrl, fallbackUrl)
      for (let i = 0; i < sources.length; i++) {
        const url = sources[i]
        if (i > 0) {
          // 界面显示真正在用的地址,任务卡片上的链接才不会是错的那条
          usedUrl = url
          setTask(id, { url, received: 0, speed: 0 })
          try {
            fs.existsSync(zipPath) && fs.unlinkSync(zipPath)
          } catch (e) { /* ignore */ }
        }
        let lastTime = Date.now()
        let lastReceived = 0
        try {
          const dl = downloadResumable(url, zipPath, {
            attempts: 3,
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
            dl.promise.catch(() => {}) // 主动取消后无人 await,别留未处理的拒绝
            throw new Error('已取消')
          }
          await dl.promise
          return
        } catch (e) {
          if (i === sources.length - 1 || !isMissingAssetError(e)) throw e
        }
      }
    }

    try {
      ensureDir(downloadsDir)
      setTask(id, { status: 'downloading' })
      await runDownload()
      const afterDownload = tasks.get(id)
      if (!afterDownload || afterDownload.status === 'canceled') return

      // zip 预检:解压前先验证压缩包可解析,拦住「下到半个文件」的坏包
      const insp = inspectZip(zipPath)
      if (!insp.ok) throw new Error(`下载的压缩包无法解析(${insp.error}),请重试(已完成部分会保留)`)

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
        source: usedUrl,
        installedAt: Date.now(),
        size: dirSize(installDir),
        verified: ok
      }
      putDoc(versionId, version)
      succeeded = true
      setTask(id, { status: 'done', versionId, version })
    } catch (e) {
      const detail = (/** @type {Error} */ (e) && /** @type {Error} */ (e).message) || '安装失败'
      if (detail === '已取消') {
        setTask(id, { status: 'canceled' })
      } else {
        setTask(id, { status: 'error', error: describeFailure(e), errorDetail: detail })
      }
    } finally {
      try {
        succeeded && fs.existsSync(zipPath) && fs.unlinkSync(zipPath)
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
  taskQueue: tasks,
  downloadAndInstall,
  cancelTask,
  dismissTask,
  watchTasks,
  importLocalExe,
  deleteVersion,
  displayName
}
