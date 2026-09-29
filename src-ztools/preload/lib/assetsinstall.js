// 安装执行域:installAsset 按 zip 内容嗅探分流(插件 vs 纯素材),以及更新/卸载/
// 复制到其他项目/另存为项目/直接下载 zip/检查更新/启用停用。
// 进度走 onProgress + store 记录(无共享任务队列,渲染层 useInstallProgress 消费)。
// 从 assets.js 拆出(2026-09-29)。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { getJson, downloadFile } = require('./http')
const { extractZip, ensureDir, readZipEntries, inspectZip } = require('./extract')
const { trashPath, uniquePath } = require('./fsutil')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')
const { addProject } = require('./projects')
const { getAssetDetail, getReleaseInfos, listAssetReleases, mapAsset, asArray, splitAssetId, latestRelease, API_BASE } = require('./assetapi')
const { moveSync, findPluginCfgs, locateSources, parsePluginCfg, collectFiles, resolveUnder, removeInstalledFiles, setPluginEnabled } = require('./assetfiles')
const { takeStaged, sweepStaged, buildInstallPlan, previewAssetInstall, conflictInfo } = require('./assetstage')

/** @typedef {{title: string, versionString: string, dirNames: string[], enabled: boolean, kind: 'addon'|'asset'}} AddonBrief */

/**
 * 下载安装市场资产。按 zip 内容分流:
 *  · 含 plugin.cfg → 插件(Addon):进项目 addons/,可自动启用;
 *  · 否则 → 纯素材(模型/精灵等):落到项目根,记录文件清单供卸载/更新。
 * opts: { projectId, assetId, assetMeta, version?, stageId?, stripTopDir? }
 *  · stageId:previewAssetInstall 暂存的包,确认安装时复用(缺失时回退为重新下载);
 *  · stripTopDir:素材唯一顶层目录是否并入项目根;缺省沿用该资产上次安装的选择。
 * @param {{projectId: string, assetId: string, assetMeta?: object, version?: string, stageId?: string, stripTopDir?: boolean}} opts
 * @param {(p: {stage: 'downloading'|'extracting', received?: number, total?: number}) => void} [onProgress]
 * @returns {Promise<{ok: boolean, error?: string, addon?: AddonBrief}>}
 */
async function installAsset({ projectId, assetId, assetMeta, version, stageId, stripTopDir }, onProgress) {
  let tmpDir = ''
  try {
    const project = getDoc(projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    const detail = await getAssetDetail(assetId, version)
    if (!detail.downloadUrl) return { ok: false, error: '资产没有下载地址' }

    let zipPath = takeStaged(stageId, assetId)
    if (zipPath) {
      tmpDir = path.dirname(zipPath) // 借用暂存目录,finally 一并清理
    } else {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-godot-'))
      zipPath = path.join(tmpDir, 'asset.zip')
      const dl = downloadFile(detail.downloadUrl, zipPath, {
        onProgress: (received, total) => onProgress && onProgress({ stage: 'downloading', received, total })
      })
      await dl.promise
    }

    // zip 预检:解压前先验证压缩包可解析,拦住「下到半个文件」的坏包
    const insp = inspectZip(zipPath)
    if (!insp.ok) throw new Error(`下载的压缩包无法解析(${insp.error}),请重试安装`)

    onProgress && onProgress({ stage: 'extracting' })
    const extractDir = path.join(tmpDir, 'x')
    await extractZip(zipPath, extractDir)

    // 内容嗅探:zip 里有没有 plugin.cfg 是插件与素材的唯一可靠判据(见文件头注释)
    const ctx = { project, projectId, assetId, assetMeta, detail, extractDir }
    if (findPluginCfgs(extractDir).length) return installAsAddon(ctx)
    return installAsAssetFiles({ ...ctx, stripTopDir })
  } catch (e) {
    return { ok: false, error: (e && e.message) || '安装失败' }
  } finally {
    try {
      tmpDir && fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch (e) { /* ignore */ }
  }
}

/** 安装链路的公共上下文(下载解压完成后传入) */
/** @typedef {{project: any, projectId: string, assetId: string, assetMeta?: object, detail: any, extractDir: string, stripTopDir?: boolean}} InstallCtx */

/**
 * 插件链路:定位插件目录 → 挪进 addons/ → 按设置自动启用 → 写记录。
 * @param {InstallCtx} ctx
 * @returns {{ok: boolean, error?: string, addon?: AddonBrief}}
 */
function installAsAddon({ project, projectId, assetId, assetMeta, detail, extractDir }) {
  const addonsDir = path.join(project.path, 'addons')
  ensureDir(addonsDir)

  // 定位插件源目录:zip 打包结构多样(addons/x、x/addons/x、wrapper/x 等),
  // 以 plugin.cfg 所在目录的父目录为准
  const sources = locateSources(extractDir)

  const dirNames = []
  for (const srcDir of sources) {
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const dest = path.join(addonsDir, ent.name)
      const src = path.join(srcDir, ent.name)
      if (ent.isDirectory()) {
        fs.rmSync(dest, { recursive: true, force: true })
        moveSync(src, dest)
        dirNames.push(ent.name)
      } else if (ent.name === '.import' || ent.name.endsWith('.gdignore')) {
        // 单文件资产不移动
      } else {
        fs.rmSync(dest, { force: true })
        moveSync(src, dest)
      }
    }
  }
  if (!dirNames.length) return { ok: false, error: '压缩包中未找到插件目录' }

  // 自动启用
  let enabled = false
  const settings = getDoc('godot/settings') || {}
  if (settings.autoEnablePlugin !== false) {
    const cfgDirs = dirNames.filter((d) => fs.existsSync(path.join(addonsDir, d, 'plugin.cfg')))
    if (cfgDirs.length) {
      setPluginEnabled(project.path, cfgDirs, true)
      enabled = true
    }
  }

  putDoc(`godot/asset/${projectId}/${assetId}`, {
    projectId,
    assetId,
    title: detail.title,
    versionString: detail.versionString,
    kind: 'addon',
    dirNames,
    meta: assetMeta || undefined,
    installedAt: Date.now()
  })
  return { ok: true, addon: { kind: 'addon', title: detail.title, versionString: detail.versionString, dirNames, enabled } }
}

/**
 * 素材链路:落到项目根 —— 作者按 res:// 路径打包,收进统一目录会断引用。
 * 唯一顶层目录是否并入项目根由确认层决定(stripTopDir);未显式传入时(已装页的更新/切换
 * 版本)沿用该资产上次安装的选择。更新语义是先清后装:先按旧清单删掉旧文件再做冲突检测。
 * @param {InstallCtx} ctx
 * @returns {{ok: boolean, error?: string, addon?: AddonBrief}}
 */
function installAsAssetFiles({ project, projectId, assetId, assetMeta, detail, extractDir, stripTopDir }) {
  const root = project.path
  const docId = `godot/asset/${projectId}/${assetId}`
  const prev = getDoc(docId)
  const strip = stripTopDir != null ? !!stripTopDir : !!(prev && prev.kind === 'asset' && prev.stripTopDir)

  // wrapper 判定:唯一顶层目录(且不是 __MACOSX)才存在「并入/保留」的歧义
  let sourceRoot = extractDir
  let wrapperName = ''
  if (strip) {
    const tops = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.name !== '__MACOSX')
    if (tops.length === 1 && tops[0].isDirectory()) {
      wrapperName = tops[0].name
      sourceRoot = path.join(extractDir, wrapperName)
    }
  }

  // 写入根下带 project.godot 的是完整项目/模板,混进现有项目会覆盖用户工程文件
  if (fs.existsSync(path.join(sourceRoot, 'project.godot'))) {
    return { ok: false, error: '这是完整项目或模板,不能安装到现有项目目录' }
  }

  const files = collectFiles(sourceRoot)
  if (!files.length) return { ok: false, error: '压缩包中没有可安装的文件' }

  // 更新:先按旧清单清掉本资产上次写入的文件,再装新版(避免旧版本文件残留)
  if (prev && prev.kind === 'asset') removeInstalledFiles(root, prev.installedPaths)

  // 冲突检测:项目里已有同名文件时整包拒绝,不做部分覆盖
  const conflicts = files.filter((rel) => {
    const dest = resolveUnder(root, rel)
    return dest && fs.existsSync(dest)
  })
  if (conflicts.length) {
    return {
      ok: false,
      error: `项目内已有同名文件(${conflicts.length} 个,如 ${conflicts.slice(0, 3).join('、')}),已取消安装。可先卸载旧内容后重试`
    }
  }

  for (const rel of files) {
    const dest = resolveUnder(root, rel)
    if (!dest) continue
    ensureDir(path.dirname(dest))
    fs.copyFileSync(path.join(sourceRoot, rel), dest)
  }

  // dirNames 仅存顶层条目供展示;卸载/更新一律以 installedPaths 文件清单为准
  const topEntries = [...new Set(files.map((f) => f.split('/')[0]))]
  putDoc(docId, {
    projectId,
    assetId,
    title: detail.title,
    versionString: detail.versionString,
    kind: 'asset',
    dirNames: topEntries,
    installedPaths: files,
    // 记录本次的 wrapper 选择,更新/切换版本未显式传入时沿用
    stripTopDir: strip,
    meta: assetMeta || undefined,
    installedAt: Date.now()
  })
  return {
    ok: true,
    addon: { kind: 'asset', title: detail.title, versionString: detail.versionString, dirNames: topEntries, enabled: false }
  }
}

/**
 * 把完整项目/模板另存为独立项目:解压到 destRoot 下的 slug 子目录并登记进项目列表。
 * 与 installAsset 互斥 —— 完整项目绝不能混进现有项目,这里只走「新项目」通道。
 * 唯一顶层目录一律剥离(新目录本身就是项目根)。
 * @param {{assetId: string, version?: string, stageId?: string, destRoot: string}} opts
 * @param {(p: {stage: 'downloading'|'extracting', received?: number, total?: number}) => void} [onProgress]
 * @returns {Promise<{ok: boolean, error?: string, projectName?: string, projectId?: string, path?: string}>}
 */
async function saveAssetAsProject({ assetId, version, stageId, destRoot }, onProgress) {
  let tmpDir = ''
  try {
    if (!destRoot || !fs.existsSync(destRoot) || !fs.statSync(destRoot).isDirectory()) {
      return { ok: false, error: '目标目录不存在' }
    }
    const detail = await getAssetDetail(assetId, version)
    if (!detail.downloadUrl) return { ok: false, error: '资产没有下载地址' }

    let zipPath = takeStaged(stageId, assetId)
    if (zipPath) {
      tmpDir = path.dirname(zipPath)
    } else {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-godot-'))
      zipPath = path.join(tmpDir, 'asset.zip')
      const dl = downloadFile(detail.downloadUrl, zipPath, {
        onProgress: (received, total) => onProgress && onProgress({ stage: 'downloading', received, total })
      })
      await dl.promise
    }

    // zip 预检:另存为新项目前先验证压缩包可解析
    const inspProj = inspectZip(zipPath)
    if (!inspProj.ok) throw new Error(`下载的压缩包无法解析(${inspProj.error}),请重试`)

    onProgress && onProgress({ stage: 'extracting' })
    const extractDir = path.join(tmpDir, 'x')
    await extractZip(zipPath, extractDir)

    const tops = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.name !== '__MACOSX')
    const sourceRoot = tops.length === 1 && tops[0].isDirectory() ? path.join(extractDir, tops[0].name) : extractDir
    if (!fs.existsSync(path.join(sourceRoot, 'project.godot'))) {
      return { ok: false, error: '压缩包中没有 project.godot,不是完整项目' }
    }

    const slug = String(assetId).split('/')[1] || 'asset'
    const target = path.join(destRoot, slug)
    if (fs.existsSync(target)) return { ok: false, error: `目标目录已存在:${target}` }
    moveSync(sourceRoot, target)

    const added = addProject(target)
    if (!added || added.ok === false) {
      return { ok: false, error: (added && added.error) || '项目登记失败' }
    }
    return { ok: true, projectName: added.project && added.project.name, projectId: added.project && added.project.id, path: target }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '另存失败' }
  } finally {
    try {
      tmpDir && fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch (e) { /* ignore */ }
  }
}

/**
 * 仅下载资产 zip 到指定目录(不安装、不写记录)。重名自动加序号。
 * @param {{assetId: string, version?: string, destDir: string}} opts
 * @param {(p: {stage: 'downloading'|'extracting', received?: number, total?: number}) => void} [onProgress]
 * @returns {Promise<{ok: boolean, error?: string, file?: string}>}
 */
async function downloadAssetZip({ assetId, version, destDir }, onProgress) {
  try {
    if (!destDir || !fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
      return { ok: false, error: '目标目录不存在' }
    }
    const detail = await getAssetDetail(assetId, version)
    if (!detail.downloadUrl) return { ok: false, error: '资产没有下载地址' }
    /** 文件名安全化:slug/版本串来自远端,防路径非法字符 */
    /** @param {string} s */
    const safe = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '_') || 'asset'
    const base = `${safe(String(assetId).split('/')[1])}-${safe(detail.versionString || 'latest')}`
    let name = `${base}.zip`
    let n = 2
    while (fs.existsSync(path.join(destDir, name))) name = `${base}-${n++}.zip`
    const dl = downloadFile(detail.downloadUrl, path.join(destDir, name), {
      onProgress: (received, total) => onProgress && onProgress({ stage: 'downloading', received, total })
    })
    await dl.promise
    return { ok: true, file: name }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '下载失败' }
  }
}

/**
 * 更新:重新安装覆盖(素材由 installAsAssetFiles 先清后装)。
 * @param {{projectId: string, assetId: string}} opts
 * @param {(p: {stage: 'downloading'|'extracting', received?: number, total?: number}) => void} [onProgress]
 * @returns {Promise<{ok: boolean, error?: string, addon?: AddonBrief}>}
 */
async function updateAsset({ projectId, assetId }, onProgress) {
  return installAsset({ projectId, assetId }, onProgress)
}

/**
 * 检查市场端最新版本。
 * @param {{projectId: string, assetId: string}} opts
 * @returns {Promise<{hasUpdate: boolean, latest?: string, error?: string}>}
 */
async function checkAddonUpdate({ projectId, assetId }) {
  try {
    const doc = getDoc(`godot/asset/${projectId}/${assetId}`)
    if (!doc) return { hasUpdate: false }
    const [pub, slug] = splitAssetId(assetId)
    const releases = await getJson(`${API_BASE}/releases/${pub}/${slug}/`)
    const latest = latestRelease(releases)
    const latestVersion = (latest && latest.version) || ''
    if (latestVersion && latestVersion !== doc.versionString) {
      return { hasUpdate: true, latest: latestVersion }
    }
    return { hasUpdate: false, latest: latestVersion }
  } catch (e) {
    return { hasUpdate: false, error: (e && e.message) || '检查更新失败' }
  }
}

/**
 * 卸载:删除目录 + 移除启用 + 删除记录。
 * 素材(kind=asset)按安装清单删文件并清空父目录,不动 project.godot。
 * @param {{projectId: string, dirName: string, assetId?: string}} opts
 * @returns {{ok: boolean, error?: string}}
 */
function uninstallAddon({ projectId, dirName, assetId }) {
  try {
    const project = getDoc(projectId)
    if (!project) return { ok: false, error: '项目不存在' }

    // 素材:按清单精确删除(渲染层对市场条目会带上 assetId)
    if (assetId) {
      const doc = getDoc(`godot/asset/${projectId}/${assetId}`)
      if (doc && doc.kind === 'asset') {
        removeInstalledFiles(project.path, doc.installedPaths, { toTrash: true })
        removeDoc(doc._id)
        return { ok: true }
      }
    }

    const addonDir = path.join(project.path, 'addons', dirName)
    // 显式卸载走回收站(与项目删除一致),误删可恢复
    if (fs.existsSync(addonDir)) trashPath(addonDir, true)
    setPluginEnabled(project.path, [dirName], false)
    for (const doc of listDocs(`godot/asset/${projectId}/`)) {
      // 素材记录的 dirNames 是项目根顶层条目,不能按目录名匹配到插件卸载
      if (doc.kind !== 'asset' && (doc.dirNames || []).includes(dirName)) removeDoc(doc._id)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '卸载失败' }
  }
}

/**
 * 把已装的纯素材复制到另一个项目:按安装清单逐文件复制,目标已有同名文件跳过。
 * 复制了内容才写目标记录(合并旧清单);部分失败时如实回报。
 * @param {{sourceProjectId: string, assetId: string, targetProjectId: string}} opts
 * @returns {{ok: boolean, error?: string, copied?: number, skipped?: string[]}}
 */
function copyAssetToProject({ sourceProjectId, assetId, targetProjectId }) {
  const source = getDoc(sourceProjectId)
  const target = getDoc(targetProjectId)
  if (!source || !target) return { ok: false, error: '项目不存在' }
  if (sourceProjectId === targetProjectId) return { ok: false, error: '源与目标是同一项目' }
  const doc = getDoc(`godot/asset/${sourceProjectId}/${assetId}`)
  if (!doc || doc.kind !== 'asset') return { ok: false, error: '该资产不是纯素材或缺少安装记录' }
  const paths = asArray(doc.installedPaths)
  if (!paths.length) return { ok: false, error: '安装清单为空' }

  /** @type {string[]} */
  const copied = []
  /** @type {string[]} */
  const skipped = []
  for (const rel of paths) {
    const from = resolveUnder(source.path, rel)
    const to = resolveUnder(target.path, rel)
    if (!from || !to) { skipped.push(rel); continue }
    if (!fs.existsSync(from)) { skipped.push(`${rel}(源文件缺失)`); continue }
    if (fs.existsSync(to)) { skipped.push(`${rel}(目标已存在)`); continue }
    ensureDir(path.dirname(to))
    fs.copyFileSync(from, to)
    copied.push(rel)
  }

  if (copied.length) {
    const targetDocId = `godot/asset/${targetProjectId}/${assetId}`
    const prev = getDoc(targetDocId)
    putDoc(targetDocId, {
      projectId: targetProjectId,
      assetId,
      title: doc.title,
      versionString: doc.versionString,
      kind: 'asset',
      dirNames: [...new Set(copied.map((f) => f.split('/')[0]))],
      installedPaths:
        prev && prev.kind === 'asset' ? [...new Set([...asArray(prev.installedPaths), ...copied])] : copied,
      stripTopDir: doc.stripTopDir,
      meta: doc.meta,
      installedAt: Date.now(),
      copiedFrom: sourceProjectId
    })
  }
  return { ok: true, copied: copied.length, skipped }
}

/**
 * 启用/禁用插件(改写 project.godot)。
 * @param {{projectId: string, dirName: string, enabled: boolean}} opts
 * @returns {{ok: boolean, error?: string}}
 */
function setAddonEnabled({ projectId, dirName, enabled }) {
  try {
    const project = getDoc(projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    setPluginEnabled(project.path, [dirName], enabled)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '操作失败' }
  }
}

module.exports = {
  installAsset,
  saveAssetAsProject,
  downloadAssetZip,
  updateAsset,
  checkAddonUpdate,
  uninstallAddon,
  copyAssetToProject,
  setAddonEnabled
}
