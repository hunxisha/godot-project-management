// Godot Asset Library:搜索、安装、启用、更新、卸载插件(Addon)
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { getJson, downloadFile } = require('./http')
const { extractZip, ensureDir } = require('./extract')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')

const API_BASE = 'https://godotengine.org/asset-library/api'

/** 搜索市场资产 */
async function searchAssets(filter, godotVersion, page = 1) {
  const params = new URLSearchParams({
    filter: filter || '',
    sort: 'updated',
    status: 'approved',
    page: String(page),
    amount: '20'
  })
  if (godotVersion) params.set('godot_version', godotVersion)
  const data = await getJson(`${API_BASE}/assets?${params}`)
  return {
    result: (data.result || []).map((a) => ({
      assetId: a.asset_id,
      title: a.title,
      author: a.author,
      category: a.category,
      versionString: a.version_string,
      godotVersion: a.godot_version,
      downloadUrl: a.download_url,
      downloadCount: a.download_count,
      iconUrl: a.icon_url || undefined,
      modifyDate: a.modify_date,
      supportLevel: a.support_level
    })),
    page: data.page || 1,
    pages: data.pages || 1
  }
}

/** 获取资产详情 */
async function getAssetDetail(assetId) {
  const a = await getJson(`${API_BASE}/assets/${assetId}`)
  return {
    assetId: a.asset_id,
    title: a.title,
    versionString: a.version_string,
    downloadUrl: a.download_url,
    godotVersion: a.godot_version
  }
}

/** 解析 plugin.cfg(取 name/version/author) */
function parsePluginCfg(cfgPath) {
  try {
    const out = {}
    for (const line of fs.readFileSync(cfgPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([\w]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line)
      if (m && ['name', 'version', 'author'].includes(m[1])) out[m[1]] = m[2]
    }
    return out
  } catch (e) {
    return {}
  }
}

/**
 * 在 project.godot 的 [editor_plugins] enabled 行中增删插件路径。
 * 仅精确改写 enabled 一行;缺少 section 时在文件末尾追加。
 */
function setPluginEnabled(projectPath, dirNames, enable) {
  const file = path.join(projectPath, 'project.godot')
  const text = fs.readFileSync(file, 'utf8')
  const paths = dirNames.map((d) => `res://addons/${d}/plugin.cfg`)
  const re = /^enabled\s*=\s*PackedStringArray\(([^)]*)\)/m
  const sectionRe = /^\[editor_plugins\]\s*$/m

  let current = []
  const m = re.exec(text)
  if (m) {
    current = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
  }
  let next = enable
    ? [...new Set([...current, ...paths])]
    : current.filter((p) => !paths.includes(p))

  const newline = `enabled=PackedStringArray(${next.map((p) => `"${p}"`).join(', ')})`

  if (re.test(text)) {
    const updated = text.replace(re, newline)
    if (updated !== text) fs.writeFileSync(file, updated)
    return
  }
  if (sectionRe.test(text)) {
    const updated = text.replace(sectionRe, (m) => `${m}\n\n${newline}`)
    fs.writeFileSync(file, updated)
    return
  }
  const trailing = text.endsWith('\n') ? '\n' : '\n\n'
  fs.writeFileSync(file, text + trailing + '[editor_plugins]\n\n' + newline + '\n')
}

/** 扫描项目已安装插件 */
function listAddons(projectId) {
  const project = getDoc(projectId)
  if (!project) return []
  const addonsDir = path.join(project.path, 'addons')
  if (!fs.existsSync(addonsDir)) return []
  const marketDocs = {}
  for (const doc of listDocs(`godot/asset/${projectId}/`)) {
    marketDocs[doc._id] = doc
  }
  const out = []
  const enabledText = (() => {
    try {
      return fs.readFileSync(path.join(project.path, 'project.godot'), 'utf8')
    } catch (e) {
      return ''
    }
  })()
  const enabledPaths = [...enabledText.matchAll(/"([^"]*addons\/[^"\\]+\/plugin\.cfg)"/g)].map((m) => m[1])

  for (const ent of fs.readdirSync(addonsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const cfgPath = path.join(addonsDir, ent.name, 'plugin.cfg')
    const hasCfg = fs.existsSync(cfgPath)
    const cfg = hasCfg ? parsePluginCfg(cfgPath) : {}
    const market = Object.values(marketDocs).find((d) => (d.dirNames || []).includes(ent.name))
    out.push({
      dirName: ent.name,
      name: cfg.name || market?.title || ent.name,
      version: cfg.version || market?.versionString,
      author: cfg.author,
      hasCfg,
      enabled: enabledPaths.includes(`res://addons/${ent.name}/plugin.cfg`),
      fromMarket: !!market,
      assetId: market?.assetId,
      versionString: market?.versionString,
      installedAt: market?.installedAt
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * 下载安装市场插件到项目 addons/。
 * onProgress({ stage: 'downloading'|'extracting', received, total })
 */
async function installAsset({ projectId, assetId }, onProgress) {
  let tmpDir = ''
  try {
    const project = getDoc(projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    const detail = await getAssetDetail(assetId)
    if (!detail.downloadUrl) return { ok: false, error: '资产没有下载地址' }

    const addonsDir = path.join(project.path, 'addons')
    ensureDir(addonsDir)

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-godot-'))
    const zipPath = path.join(tmpDir, 'asset.zip')
    const dl = downloadFile(detail.downloadUrl, zipPath, {
      onProgress: (received, total) => onProgress && onProgress({ stage: 'downloading', received, total })
    })
    await dl.promise

    onProgress && onProgress({ stage: 'extracting' })
    const extractDir = path.join(tmpDir, 'x')
    await extractZip(zipPath, extractDir)

    // zip 根目录若含 addons/,则取其内部;否则取根目录
    let srcDir = extractDir
    if (fs.existsSync(path.join(extractDir, 'addons'))) srcDir = path.join(extractDir, 'addons')

    const dirNames = []
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const dest = path.join(addonsDir, ent.name)
      const src = path.join(srcDir, ent.name)
      if (ent.isDirectory()) {
        fs.rmSync(dest, { recursive: true, force: true })
        fs.renameSync(src, dest)
        dirNames.push(ent.name)
      } else if (ent.name === '.import' || ent.name.endsWith('.gdignore')) {
        // 单文件资产不移动
      } else {
        fs.rmSync(dest, { force: true })
        fs.renameSync(src, dest)
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

    const docId = `godot/asset/${projectId}/${assetId}`
    putDoc(docId, {
      projectId,
      assetId,
      title: detail.title,
      versionString: detail.versionString,
      dirNames,
      installedAt: Date.now()
    })
    return { ok: true, addon: { title: detail.title, versionString: detail.versionString, dirNames, enabled } }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '安装失败' }
  } finally {
    try {
      tmpDir && fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch (e) { /* ignore */ }
  }
}

/** 更新:重新安装覆盖 */
async function updateAsset({ projectId, assetId }, onProgress) {
  return installAsset({ projectId, assetId }, onProgress)
}

/** 检查市场端最新版本,返回 { hasUpdate, latest? } */
async function checkAddonUpdate({ projectId, assetId }) {
  try {
    const doc = getDoc(`godot/asset/${projectId}/${assetId}`)
    if (!doc) return { hasUpdate: false }
    const detail = await getAssetDetail(assetId)
    if (detail.versionString && detail.versionString !== doc.versionString) {
      return { hasUpdate: true, latest: detail.versionString }
    }
    return { hasUpdate: false, latest: detail.versionString }
  } catch (e) {
    return { hasUpdate: false, error: (e && e.message) || '检查更新失败' }
  }
}

/** 卸载:删除目录 + 移除启用 + 删除记录 */
function uninstallAddon({ projectId, dirName }) {
  try {
    const project = getDoc(projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    const addonDir = path.join(project.path, 'addons', dirName)
    if (fs.existsSync(addonDir)) fs.rmSync(addonDir, { recursive: true, force: true })
    setPluginEnabled(project.path, [dirName], false)
    for (const doc of listDocs(`godot/asset/${projectId}/`)) {
      if ((doc.dirNames || []).includes(dirName)) removeDoc(doc._id)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '卸载失败' }
  }
}

/** 启用/禁用插件(改写 project.godot) */
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
  searchAssets,
  getAssetDetail,
  listAddons,
  installAsset,
  updateAsset,
  checkAddonUpdate,
  uninstallAddon,
  setAddonEnabled
}
