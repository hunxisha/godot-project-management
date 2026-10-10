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
const { downloadResumable } = require('./http')
const { extractZip, ensureDir, dirSize, inspectZip } = require('./extract')
const fsutil = require('./fsutil')
const { currentPlatform } = require('./godotExe')
const { getDoc, putDoc, removeDoc } = require('./store')
const tpllib = require('./tpllib')

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
 * 自定义模板目录名的白名单(与 Rust 端 `is_valid_version_dir_name` 逐字镜像):
 * 字母数字开头,只含字母数字 / 点 / 下划线 / 连字符,1–64 字符。
 * versionDir 会被 `path.join(base, versionDir)` —— 放行 `/`、`\`、`..` 就等于允许把
 * 模板装到任意位置;版本串(`4.3.stable` / `4.4.dev6`)本来也不需要别的字符。
 * @param {string} s
 * @returns {boolean}
 */
function isValidVersionDirName(s) {
  return typeof s === 'string' && /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(s)
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
 * 下载安装,或从本地导入导出模板(入队,立即返回)。
 * 重新安装会覆盖:旧目录先**移入回收站**再落新包(与素材的先清后装同语义;永久删除
 * 会让「装错了想退回」变成不可能,计划书点名的安全边界)。
 *
 * 来源二选一:
 *   · 缺省 → 下载官方 release 的 tpz(与既有行为逐字节一致);
 *   · params.srcPath → 本地导入(.tpz 文件走「zip 预检 → 解压」,已解压的模板目录直接进校验),
 *     不发起任何网络请求。自编译/第三方模板由此进场。
 *
 * 目标目录名(versionDir)的**统一取法**(三处读它的地方必须同一条):显式 params.versionDir
 * → 该引擎记录里已有的 `godot/templates/<id>.versionDir` → tag 派生。早先这里写死 tag 派生,
 * 「手动导入过自定义目录名的引擎」再走一次下载安装就会装到另一个目录,而状态卡读的
 * 还是记录里的旧值 —— 实际装的目录与 db 记录不一致(计划书第 5 项点名的分叉)。
 *
 * @param {{versionId: string, srcPath?: string, versionDir?: string}} params
 * @param {{versionsRoot?: string, templatesBase?: string, platform?: string}} [opts]
 *   templatesBase 仅供测试覆盖安装根;缺省按 Godot 规则解析(._sc_ → exe 旁,否则用户数据目录)
 *   platform 仅供测试注入目标平台(测试模板包内是固定平台的文件);缺省用真实平台
 * @returns {{ok: boolean, error?: string, taskId?: string}}
 */
function downloadAndInstallTemplates(params, opts) {
  const { versionId, versionDir: versionDirArg } = params || {}
  // srcPath 在这里归一成确定字符串:'' = 没有本地来源(走下载)。后面所有分支部只认 src。
  // (中间变量不是画蛇添足:JSDoc 类型下 `typeof (params||{}).srcPath === 'string'` 收窄不了
  //  重复的属性访问表达式,TS 会一路把 undefined 带进 inspectZip/extractZip 的参数里。)
  const srcPathRaw = (params || {}).srcPath
  const src = typeof srcPathRaw === 'string' ? srcPathRaw : ''
  const v = getDoc(versionId)
  if (!v || !v.tag || !v.exePath) return { ok: false, error: '未找到该引擎' }
  const o = opts || {}
  const settings = getDoc('godot/settings') || {}
  const downloadsDir = settings.versionsRoot
    ? path.join(settings.versionsRoot, 'downloads')
    : path.join(os.tmpdir(), 'ztools-godot-dl')

  // 本地来源先验存在再入队:文件不存在的问题不该等到任务队列里才暴露
  let localStat = null
  if (src !== '') {
    try {
      localStat = fs.statSync(src)
    } catch (e) {
      return { ok: false, error: '模板文件不存在' }
    }
    if (!localStat.isFile() && !localStat.isDirectory()) return { ok: false, error: '模板来源既不是文件也不是目录' }
  }

  // 与 exportTemplateStatus / uninstallExportTemplates 同一条取法(见 JSDoc「统一取法」)
  const priorDoc = getDoc(`godot/templates/${versionId}`)
  const versionDir = versionDirArg || (priorDoc && priorDoc.versionDir) || versionDirFromTag(v.tag)
  // 显式目录名过白名单(记录里的值与 tag 派生值不校验:它们是本管线自己写下的,天然安全)
  if (versionDirArg !== undefined && !isValidVersionDirName(versionDirArg)) {
    return { ok: false, error: '模板目录名不合法:只允许字母数字、点、下划线、连字符' }
  }

  const fileName = src
    ? path.basename(src)
    : `Godot_v${v.tag}${v.variant === 'mono' ? '_mono' : ''}_export_templates.tpz`
  const url = templateUrl(v.tag, v.variant)

  const task = tasks.create({
    kind: 'templates',
    versionId,
    tag: v.tag,
    variant: v.variant,
    platform: o.platform || currentPlatform(),
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
    // 成功后才清理 .part;失败保留(已下载字节留在盘上,重试从断点继续)
    let succeeded = false
    try {
      const queued = tasks.get(id)
      if (!queued || queued.status === 'canceled') return

      if (localStat && localStat.isFile()) {
        // 本地 .tpz:没有 .part 文件,直接对源文件做预检(坏包在这里就被拦下)
        setTask(id, { status: 'downloading', totalSize: localStat.size, received: localStat.size })
        const insp = inspectZip(src)
        if (!insp.ok) throw new Error(`压缩包无法解析(${insp.error}),请确认选的是 .tpz(zip)文件`)
      } else if (!localStat) {
        ensureDir(downloadsDir)
        setTask(id, { status: 'downloading' })
        let lastTime = Date.now()
        let lastReceived = 0
        const dl = downloadResumable(url, zipPath, {
          attempts: 3,
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
        const afterDl = tasks.get(id)
        if (!afterDl || afterDl.status === 'canceled') return

        // zip 预检:解压前先验证压缩包可解析,拦住「下到半个文件」的坏包
        const insp = inspectZip(zipPath)
        if (!insp.ok) throw new Error(`下载的压缩包无法解析(${insp.error}),请重试(已完成部分会保留)`)
      }
      // 本地目录来源(localStat.isDirectory()):没有解压这一步,直接进校验

      setTask(id, { status: 'extracting' })
      let extractDir = ''
      if (localStat && localStat.isDirectory()) {
        extractDir = src // 已解压的模板目录:零拷贝直接用
      } else {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-godot-tpl-'))
        extractDir = path.join(tmpDir, 'x')
        await extractZip(localStat ? src : zipPath, extractDir)
      }

      // tpz 固定带 templates/ 顶层目录;防御性兼容单 wrapper 或散装
      const tops = fs.readdirSync(extractDir, { withFileTypes: true })
      let sourceRoot = extractDir
      if (tops.some((t) => t.name === 'templates' && t.isDirectory())) {
        sourceRoot = path.join(extractDir, 'templates')
      } else if (tops.length === 1 && tops[0].isDirectory()) {
        sourceRoot = path.join(extractDir, tops[0].name)
      }

      setTask(id, { status: 'verifying' })
      // templatesBase 仅供测试覆盖安装根;正常路径按 Godot 规则解析(._sc_ → exe 旁,否则用户数据目录)
      const baseDir = o.templatesBase || resolveTemplatesBase(v.exePath).base
      const dest = path.join(baseDir, versionDir)
      const fileCount = verifyTemplatesDir(sourceRoot, o.platform || process.platform)

      ensureDir(baseDir)
      if (fs.existsSync(dest)) {
        // 覆盖 = 旧目录进回收站(与显式卸载同一通道);移不走就停下 —— 永久删除换「必然成功」
        // 是用用户的退路换安装率,不做这个交换。
        try {
          fsutil.trashPath(dest, true)
        } catch (e) {
          throw new Error('无法移走旧模板(回收站不可用?),可先「卸载模板」后再装')
        }
      }
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
      // 自编译导入自动存档(任务书 §0 第 2 拍):生效位 cpSync 一份独立副本进 tplpack 槽。
      // 存档是附加语义:失败不碰已成功的安装,原因挂任务 archiveError 如实回
      if (params.archive) {
        try {
          const ar = tpllib.archiveFromInstall({ base: baseDir, dest, versionId, tag: v.tag, versionDir, archive: params.archive })
          setTask(id, { packId: ar.packId })
        } catch (e) {
          setTask(id, { archiveError: (e && e.message) || String(e) })
        }
      }
      succeeded = true
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
        // 本地文件来源没有 .part,不能把用户选的那个源文件当临时产物删掉
        succeeded && !localStat && fs.existsSync(zipPath) && fs.unlinkSync(zipPath)
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
    // 显式卸载走回收站(与项目删除一致),误删可恢复;fsutil 走整体引用,测试可注入探针
    if (fs.existsSync(dir)) fsutil.trashPath(dir, true)
    removeDoc(`godot/templates/${versionId}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '卸载失败' }
  }
}

module.exports = {
  versionDirFromTag,
  isValidVersionDirName,
  templateUrl,
  resolveTemplatesBase,
  exportTemplateStatus,
  downloadAndInstallTemplates,
  uninstallExportTemplates
}
