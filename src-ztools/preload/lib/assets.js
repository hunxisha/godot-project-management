// Godot Asset Store(store.godotengine.org/api/v1,2026 起官方编辑器使用的新 API):
// 搜索、安装、启用、更新、卸载插件(Addon)
// assetId 格式为 "{publisherSlug}/{assetSlug}",如 "maran23/script-ide"
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { getJson, downloadFile } = require('./http')
const { extractZip, ensureDir } = require('./extract')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')

const API_BASE = 'https://store.godotengine.org/api/v1'

/** 拆 assetId 为 [publisherSlug, assetSlug] */
function splitAssetId(assetId) {
  const [pub, slug] = String(assetId).split('/')
  if (!pub || !slug) throw new Error('资产 ID 无效: ' + assetId)
  return [pub, slug]
}

/** 取 releases 数组中最新的一个(按 created 日期排序) */
function latestRelease(list) {
  if (!Array.isArray(list) || !list.length) return undefined
  const sorted = [...list].sort((a, b) => String(b.created).localeCompare(String(a.created)))
  return sorted[0]
}

/** 商店资产对象 → MarketAsset 统一映射 */
function mapAsset(a) {
  return {
    assetId: `${a.publisher.slug}/${a.slug}`,
    title: a.name,
    author: a.publisher.name,
    category: (a.tags && a.tags[0] && a.tags[0].display_name) || '',
    versionString: '',
    godotVersion: '',
    rating: a.reviews_score,
    iconUrl: a.thumbnail || undefined,
    description: a.description,
    storeUrl: a.store_url
  }
}

/** 官方精选(推荐)Addon */
async function listFeatured() {
  const list = await getJson(`${API_BASE}/assets/?type=0&featured_only=true&require_release=true&page_size=20`)
  return (Array.isArray(list) ? list : []).map(mapAsset)
}

/** 最近更新的 Addon(全库按更新时间倒序) */
async function listRecentlyUpdated(page = 1) {
  const params = new URLSearchParams({
    query: '',
    type: '0',
    require_release: 'true',
    sort: 'updated_desc',
    page: String(page),
    batch_size: '20'
  })
  const data = await getJson(`${API_BASE}/search/query/?${params}`)
  const count = Number(data.count) || 0
  return {
    result: (data.hits || []).map((h) => mapAsset(h.asset || {})),
    page,
    pages: Math.max(1, Math.ceil(count / 20))
  }
}

/** 搜索市场资产(Addon) */
async function searchAssets(filter, godotVersion, page = 1) {
  const params = new URLSearchParams({
    query: filter || '',
    type: '0', // 0 = Addon(工具/脚本),1 = 完整项目
    require_release: 'true',
    sort: 'updated_desc',
    page: String(page),
    batch_size: '20'
  })
  if (godotVersion) params.set('compatibility', godotVersion)
  const data = await getJson(`${API_BASE}/search/query/?${params}`)
  const count = Number(data.count) || 0
  return {
    result: (data.hits || []).map((h) => mapAsset(h.asset || {})),
    page,
    pages: Math.max(1, Math.ceil(count / 20))
  }
}

/** 获取资产详情:含最新 release 的版本与下载直链(下载链接为带签名的临时直链,安装时实时获取) */
async function getAssetDetail(assetId) {
  const [pub, slug] = splitAssetId(assetId)
  const detail = await getJson(`${API_BASE}/assets/${pub}/${slug}/`)
  const releases = await getJson(`${API_BASE}/releases/${pub}/${slug}/`).catch(() => [])
  const latest = latestRelease(releases) || {}
  return {
    assetId,
    title: detail.name,
    versionString: latest.version || '',
    downloadUrl: latest.download_url || '',
    description: detail.description,
    tags: (detail.tags || []).map((t) => t.display_name)
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
async function installAsset({ projectId, assetId, assetMeta }, onProgress) {
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
      meta: assetMeta || undefined,
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

// ---------- 本地收藏(官方 API 暂未开放收藏,收藏数据存于本地插件数据库) ----------

const FAVORITES_ID = 'godot/market/favorites'

function readFavorites() {
  return getDoc(FAVORITES_ID)?.items || []
}

/** 收藏列表(按收藏时间倒序) */
function listFavorites() {
  return [...readFavorites()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
}

/** 收藏/取消收藏,返回收藏状态 */
function toggleFavorite(asset) {
  const list = readFavorites()
  const idx = list.findIndex((x) => x.assetId === asset.assetId)
  if (idx >= 0) {
    list.splice(idx, 1)
    putDoc(FAVORITES_ID, { items: list })
    return false
  }
  delete asset.addedAt
  list.push({ ...asset, addedAt: Date.now() })
  putDoc(FAVORITES_ID, { items: list })
  return true
}

function isFavorite(assetId) {
  return readFavorites().some((x) => x.assetId === assetId)
}

// ---------- 我的库(全部项目的市场插件安装记录聚合) ----------

/**
 * 汇总所有项目安装过的市场资产(同一资产多项目去重合并)。
 * @returns {Array<{
 *   assetId: string, title: string, author: string, category: string, rating: number,
 *   iconUrl?: string, description?: string, storeUrl?: string,
 *   versionString: string, installedAt: number,
 *   projectCount: number, projectNames: string[]
 * }>}
 */
function listLibrary() {
  const nameById = new Map()
  for (const p of listDocs('godot/project/')) nameById.set(p._id, p.name)

  const merged = new Map()
  for (const doc of listDocs('godot/asset/')) {
    if (!doc.assetId) continue
    let item = merged.get(doc.assetId)
    if (!item) {
      item = {
        assetId: doc.assetId,
        title: doc.title || doc.assetId,
        author: (doc.meta && doc.meta.author) || '',
        category: (doc.meta && doc.meta.category) || '',
        rating: (doc.meta && doc.meta.rating) || 0,
        iconUrl: doc.meta && doc.meta.iconUrl,
        description: doc.meta && doc.meta.description,
        storeUrl: doc.meta && doc.meta.storeUrl,
        versionString: doc.versionString || '',
        installedAt: doc.installedAt || 0,
        projectCount: 0,
        projectNames: []
      }
      merged.set(doc.assetId, item)
    }
    item.projectCount += 1
    const name = nameById.get(doc.projectId) || doc.projectId
    if (!item.projectNames.includes(name)) item.projectNames.push(name)
    if ((doc.installedAt || 0) > item.installedAt) {
      item.installedAt = doc.installedAt
      if (doc.versionString) item.versionString = doc.versionString
    }
  }
  return [...merged.values()].sort((a, b) => b.installedAt - a.installedAt)
}

// ---------- 账号(API Key) ----------

/**
 * 验证 Asset Store API Key。
 * @returns {{ authenticated: boolean, name?: string }}
 */
async function verifyApiKey(key) {
  const info = await getJson(`${API_BASE}/auth/introspection`, {
    Authorization: `Bearer ${key}`
  })
  if (!info || String(info.authenticated).toLowerCase() !== 'true') {
    throw new Error('API Key 无效或已过期')
  }
  return { authenticated: true, name: info.name || info.id || '已认证用户' }
}

module.exports = {
  searchAssets,
  listFeatured,
  listRecentlyUpdated,
  listFavorites,
  toggleFavorite,
  isFavorite,
  listLibrary,
  verifyApiKey,
  getAssetDetail,
  listAddons,
  installAsset,
  updateAsset,
  checkAddonUpdate,
  uninstallAddon,
  setAddonEnabled
}
