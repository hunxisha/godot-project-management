// 导出模板(export templates)的下载与安装。
//
// Godot 导出游戏需要对应版本的导出模板:.tpz 文件(本质是 zip,内含 templates/ 目录,
// 里面是各平台的导出用可执行文件与打包资源)。编辑器按「版本串」在固定位置查找:
//   {数据目录}/export_templates/{versionDir}/
// versionDir 形如 4.3.stable、4.2.2.stable —— 与 GitHub release tag 仅差「- → .」。
// 数据目录遵循 Godot 自身规则:
//   · exe 旁存在 ._sc_(自包含模式)→ {exe目录}/editor_data/export_templates/
//   · Windows → %APPDATA%\Godot\export_templates
//   · macOS   → ~/Library/Application Support/Godot/export_templates
//   · Linux   → ~/.local/share/godot/export_templates
// 下载源:官方 GitHub release 资产 Godot_v{tag}[_mono]_export_templates.tpz(已实测
// stable/patch/mono 命名规律;个别 dev tag 无此资产时下载会如实报错)。
// 安装进度走独立任务队列(任务 kind='templates'),复用渲染层现有的任务卡片展示。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { downloadFile } = require('./http')
const { extractZip, ensureDir, dirSize } = require('./extract')
const { currentPlatform } = require('./godotExe')
const { getDoc, putDoc, removeDoc } = require('./store')

// ---------- 任务队列 ----------
// 复用 install.js 的下载任务队列:与引擎下载同一条串行流水线,
// 渲染层现有 watchTasks/dismissTask/cancelTask 无需感知多队列。
const { taskQueue: tasks } = require('./install')

/**
 * 更新任务字段(任务已被移除时静默跳过)。
 * @param {string} id
 * @param {Record<string, any>} patch
 */
function setTask(id, patch) {
  tasks.patch(tasks.get(id), patch)
}

/**
 * tag → 导出模板目录名(Godot 版本串):4.3-stable → 4.3.stable,4.2.2-stable → 4.2.2.stable。
 * @param {string} tag
 * @returns {string}
 */
function versionDirFromTag(tag) {
  return String(tag).replace(/-/g, '.')
}

/**
 * tpz 下载地址(官方 GitHub release 资产)。
 * @param {string} tag 如 4.3-stable
 * @param {string} [variant] standard | mono(mono 变体文件名带 _mono)
 * @returns {string}
 */
function templateUrl(tag, variant) {
  const mono = variant === 'mono' ? '_mono' : ''
  return `https://github.com/godotengine/godot/releases/download/${tag}/Godot_v${tag}${mono}_export_templates.tpz`
}

/**
 * 解析导出模板的基础目录(export_templates 的父查找位置)。
 * @param {string} exePath 引擎可执行文件(用于 ._sc_ 自包含模式探测)
 * @param {{appData?: string, home?: string, platform?: string}} [env] 测试可注入环境
 * @returns {{base: string, selfContained: boolean}}
 */
function resolveTemplatesBase(exePath, env) {
  const e = env || {}
  const platform = e.platform || process.platform
  const exeDir = path.dirname(exePath)
  if (fs.existsSync(path.join(exeDir, '._sc_'))) {
    return { base: path.join(exeDir, 'editor_data', 'export_templates'), selfContained: true }
  }
  if (platform === 'win32') {
    const appData = e.appData || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return { base: path.join(appData, 'Godot', 'export_templates'), selfContained: false }
  }
  if (platform === 'darwin') {
    const home = e.home || os.homedir()
    return { base: path.join(home, 'Library', 'Application Support', 'Godot', 'export_templates'), selfContained: false }
  }
  const home = e.home || os.homedir()
  return { base: path.join(home, '.local', 'share', 'godot', 'export_templates'), selfContained: false }
}

/** 平台前缀 → 模板包内该平台文件的命名前缀(3.x 与 4.x 均符合) */
/** @type {Record<string, string>} */
const PLATFORM_FILE_PREFIX = { win32: 'windows_', darwin: 'macos', linux: 'linux' }

/**
 * 校验解压出的模板目录可用:非空且含当前平台的模板文件。
 * @param {string} dir
 * @param {string} platform process.platform
 * @returns {number} 文件条目数
 */
function verifyTemplatesDir(dir, platform) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  if (!entries.length) throw new Error('模板包不完整:目录为空')
  const prefix = PLATFORM_FILE_PREFIX[platform] || 'linux'
  if (!entries.some((e) => e.name.toLowerCase().startsWith(prefix))) {
    throw new Error(`模板包不完整:未找到当前平台的模板文件(${platform})`)
  }
  return entries.length
}

// 同盘 rename、跨盘回退复制(与 assets.js 同款,模块内自足)
/**
 * @param {string} src
 * @param {string} dest
 */
function moveSync(src, dest) {
  try {
    fs.renameSync(src, dest)
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e
    fs.cpSync(src, dest, { recursive: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
}

/**
 * 查询某已装引擎的导出模板状态。
 * @param {{versionId: string, templatesBase?: string}} opts templatesBase 仅供测试覆盖安装根
 * @returns {{versionDir: string, installed: boolean, tracked: boolean, path: string}}
 */
function exportTemplateStatus(opts) {
  const { versionId, templatesBase } = opts
  const v = getDoc(versionId)
  if (!v || !v.tag) return { versionDir: '', installed: false, tracked: false, path: '' }
  const doc = getDoc(`godot/templates/${versionId}`)
  const versionDir = (doc && doc.versionDir) || versionDirFromTag(v.tag)
  const base = templatesBase || resolveTemplatesBase(v.exePath).base
  const dir = path.join(base, versionDir)
  return {
    versionDir,
    // 目录存在即视为已安装(手动安装过模板的用户也能看到正确状态)
    installed: fs.existsSync(dir),
    tracked: !!doc,
    path: dir
  }
}

/**
 * 下载并安装导出模板(入队,立即返回)。
 * 重新安装会覆盖:先删除旧目录再落新包(与素材的先清后装同语义)。
 * @param {{versionId: string}} params
 * @param {{versionsRoot?: string, templatesBase?: string}} [opts]
 *   templatesBase 仅供测试覆盖安装根;缺省按 Godot 规则解析(._sc_ → exe 旁,否则用户数据目录)
 * @returns {{ok: boolean, error?: string, taskId?: string}}
 */
function downloadAndInstallTemplates({ versionId }, opts) {
  const v = getDoc(versionId)
  if (!v || !v.tag || !v.exePath) return { ok: false, error: '未找到该引擎' }
  const o = opts || {}
  const settings = getDoc('godot/settings') || {}
  const downloadsDir = settings.versionsRoot
    ? path.join(settings.versionsRoot, 'downloads')
    : path.join(os.tmpdir(), 'ztools-godot-dl')
  const fileName = `Godot_v${v.tag}${v.variant === 'mono' ? '_mono' : ''}_export_templates.tpz`
  const url = templateUrl(v.tag, v.variant)

  const task = tasks.create({
    kind: 'templates',
    versionId,
    tag: v.tag,
    variant: v.variant,
    platform: currentPlatform(),
    url,
    fileName,
    status: 'queued',
    received: 0,
    speed: 0
  })
  const id = task.id
  tasks.emit()

  const job = async () => {
    let tmpDir = ''
    const zipPath = path.join(downloadsDir, fileName + '.part')
    try {
      const queued = tasks.get(id)
      if (!queued || queued.status === 'canceled') return

      ensureDir(downloadsDir)
      setTask(id, { status: 'downloading' })
      let lastTime = Date.now()
      let lastReceived = 0
      const dl = downloadFile(url, zipPath, {
        onProgress: (received, total) => {
          const now = Date.now()
          const speed = Math.max(0, ((received - lastReceived) / Math.max(1, now - lastTime)) * 1000)
          lastTime = now
          lastReceived = received
          setTask(id, { received, totalSize: total })
        }
      })
      tasks.setToken(id, dl)
      const cur = tasks.get(id)
      if (!cur || cur.status === 'canceled') {
        dl.cancel()
        return
      }
      await dl.promise
      if (!tasks.get(id) || tasks.get(id).status === 'canceled') return

      setTask(id, { status: 'extracting' })
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-godot-tpl-'))
      const extractDir = path.join(tmpDir, 'x')
      await extractZip(zipPath, extractDir)

      // tpz 固定带 templates/ 顶层目录;防御性兼容单 wrapper 或散装
      const tops = fs.readdirSync(extractDir, { withFileTypes: true })
      let sourceRoot = extractDir
      if (tops.some((t) => t.name === 'templates' && t.isDirectory())) {
        sourceRoot = path.join(extractDir, 'templates')
      } else if (tops.length === 1 && tops[0].isDirectory()) {
        sourceRoot = path.join(extractDir, tops[0].name)
      }

      setTask(id, { status: 'verifying' })
      const versionDir = versionDirFromTag(v.tag)
      // templatesBase 仅供测试覆盖安装根;正常路径按 Godot 规则解析(._sc_ → exe 旁,否则用户数据目录)
      const baseDir = o.templatesBase || resolveTemplatesBase(v.exePath).base
      const dest = path.join(baseDir, versionDir)
      const fileCount = verifyTemplatesDir(sourceRoot, process.platform)

      ensureDir(baseDir)
      fs.rmSync(dest, { recursive: true, force: true })
      moveSync(sourceRoot, dest)

      putDoc(`godot/templates/${versionId}`, {
        versionId,
        versionDir,
        tag: v.tag,
        variant: v.variant,
        path: dest,
        fileCount,
        size: dirSize(dest),
        installedAt: Date.now()
      })
      setTask(id, { status: 'done', versionId })
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
      try {
        tmpDir && fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch (e) { /* ignore */ }
    }
  }

  tasks.enqueue(job)
  return { ok: true, taskId: id }
}

/**
 * 卸载导出模板:删除模板目录并移除记录。
 * 注意:同版本的标准/C# 引擎共用同一个模板目录,卸载会影响双方。
 * @param {{versionId: string, templatesBase?: string}} opts templatesBase 仅供测试覆盖安装根
 * @returns {{ok: boolean, error?: string}}
 */
function uninstallExportTemplates(opts) {
  try {
    const { versionId, templatesBase } = opts
    const doc = getDoc(`godot/templates/${versionId}`)
    const v = getDoc(versionId)
    if (!doc && !v) return { ok: false, error: '未找到该引擎' }
    const versionDir = (doc && doc.versionDir) || versionDirFromTag(v.tag)
    const base = templatesBase || resolveTemplatesBase(v.exePath).base
    const dir = path.join(base, versionDir)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    removeDoc(`godot/templates/${versionId}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '卸载失败' }
  }
}

module.exports = {
  versionDirFromTag,
  templateUrl,
  resolveTemplatesBase,
  exportTemplateStatus,
  downloadAndInstallTemplates,
  uninstallExportTemplates
}
