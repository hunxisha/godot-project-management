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
/** 商店页面地址前缀(格式与 API 返回的 store_url 一致:/asset/{publisher}/{slug}/) */
const STORE_BASE = 'https://store.godotengine.org'

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
    tagSlugs: (a.tags || []).map((t) => t.slug),
    versionString: '',
    godotVersion: '',
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

/** 全部资产总数缓存(assets 列表接口不返回 count,用搜索接口补一次) */
let allAssetCount = 0

/** 全部资产(默认热度排序,分页) */
async function listAllAssets(page = 1) {
  const list = await getJson(
    `${API_BASE}/assets/?type=0&require_release=true&page_size=20&page=${page}`
  )
  if (!allAssetCount) {
    const head = await getJson(
      `${API_BASE}/search/query/?query=&type=0&require_release=true&page=1&batch_size=1`
    ).catch(() => null)
    allAssetCount = Number(head && head.count) || (Array.isArray(list) ? list.length : 0)
  }
  return {
    result: (Array.isArray(list) ? list : []).map(mapAsset),
    page,
    pages: Math.max(1, Math.ceil(allAssetCount / 20))
  }
}

/** 最新上架的资产(按发布时间倒序,分页) */
async function listNewAssets(page = 1) {
  const params = new URLSearchParams({
    query: '',
    type: '0',
    require_release: 'true',
    sort: 'created_desc',
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
    // 有搜索词时按相关性排序,否则按更新时间排序
    sort: filter ? 'relevance' : 'updated_desc',
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

/**
 * 获取资产详情:含 release 的版本与下载直链(下载链接为带签名的临时直链,安装时实时获取)。
 * version 指定时取该版本(找不到时回退最新),否则取最新 release。
 */
async function getAssetDetail(assetId, version) {
  const [pub, slug] = splitAssetId(assetId)
  const detail = await getJson(`${API_BASE}/assets/${pub}/${slug}/`)
  const releases = await getJson(`${API_BASE}/releases/${pub}/${slug}/`).catch(() => [])
  let rel = version ? releases.find((r) => String(r.version) === String(version)) : latestRelease(releases)
  if (version && !rel) rel = latestRelease(releases)
  if (!rel) rel = {}
  return {
    assetId,
    title: detail.name,
    versionString: rel.version || '',
    downloadUrl: rel.download_url || '',
    description: detail.description,
    tags: (detail.tags || []).map((t) => t.display_name)
  }
}

/** 同盘直接 rename,跨盘(EXDEV/EPERM)回退为复制后删除 */
function moveSync(src, dest) {
  try {
    fs.renameSync(src, dest)
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e
    fs.cpSync(src, dest, { recursive: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
}

/** 递归收集 plugin.cfg 路径(限深 5,跳过隐藏目录) */
function findPluginCfgs(dir, depth = 0, out = []) {
  if (depth > 5) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) findPluginCfgs(p, depth + 1, out)
    else if (ent.name === 'plugin.cfg') out.push(p)
  }
  return out
}

/**
 * 确定安装源目录列表(其直接子项即插件目录)。
 * 兼容多种打包结构:根/addons/x、根/x/addons/x、wrapper/x 等——
 * 统一取 plugin.cfg 所在目录的父目录;无 plugin.cfg 时回退旧逻辑。
 */
function locateSources(extractDir) {
  const cfgs = findPluginCfgs(extractDir)
  const sources = [...new Set(cfgs.map((c) => path.dirname(path.dirname(c))))]
  if (sources.length) return sources
  return [fs.existsSync(path.join(extractDir, 'addons')) ? path.join(extractDir, 'addons') : extractDir]
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
      installedAt: market?.installedAt,
      // 商店页面:优先用安装时记下的原址,否则按 assetId 拼装
      storeUrl: market
        ? (market.meta && market.meta.storeUrl) ||
          (market.assetId ? `${STORE_BASE}/asset/${market.assetId}/` : undefined)
        : undefined
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * 下载安装市场插件到项目 addons/。
 * opts: { projectId, assetId, assetMeta, version? } version 指定安装的 release 版本。
 * onProgress({ stage: 'downloading'|'extracting', received, total })
 */
async function installAsset({ projectId, assetId, assetMeta, version }, onProgress) {
  let tmpDir = ''
  try {
    const project = getDoc(projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    const detail = await getAssetDetail(assetId, version)
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

    // 定位插件源目录:zip 打包结构多样(addons/x、x/addons/x、wrapper/x 等),
    // 以 plugin.cfg 所在目录的父目录为准,无 plugin.cfg 时回退旧逻辑
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

// ---------- 批量版本信息(列表展示用) ----------

/** assetId → { version, minGodot, maxGodot, created } 的内存缓存 */
const versionCache = new Map()

/** release 精简信息 */
function pickRelease(r) {
  if (!r) return { version: '', minGodot: '', maxGodot: '', created: '' }
  return {
    version: String(r.version || ''),
    minGodot: r.min_godot_version != null ? String(r.min_godot_version) : '',
    maxGodot: r.max_godot_version != null ? String(r.max_godot_version) : '',
    created: r.created || ''
  }
}

/**
 * 批量获取资产最新 release 信息(并发受限、带内存缓存,失败静默跳过)。
 * @param {string[]} assetIds
 * @returns {Promise<Record<string, { version, minGodot, maxGodot, created }>>}
 */
async function getReleaseInfos(assetIds) {
  const ids = [...new Set(assetIds)].filter(
    (id) => typeof id === 'string' && id.includes('/') && !versionCache.has(id)
  )
  const CONCURRENCY = 6
  let idx = 0
  async function worker() {
    while (idx < ids.length) {
      const id = ids[idx++]
      try {
        const [pub, slug] = splitAssetId(id)
        const releases = await getJson(`${API_BASE}/releases/${pub}/${slug}/`)
        versionCache.set(id, pickRelease(latestRelease(releases)))
      } catch (e) {
        versionCache.set(id, pickRelease(null))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker))
  const out = {}
  for (const id of new Set(assetIds)) {
    if (versionCache.has(id)) out[id] = versionCache.get(id)
  }
  return out
}

/**
 * 列出资产全部 release(版本选择用),按发布时间倒序。
 *
 * 注意单位:Asset Store 返回的 `size` 是**十进制 MB 的浮点数**(已实测核对:
 * 某个 release 返回 0.118271,实际下载到的 zip 为 118,271 字节,即 size × 10^6)。
 * 这里统一换算成字节,与下载进度(Content-Length)以及全项目其它 size 字段保持一致,
 * 否则界面会把它当字节渲染成「0 KB」。
 */
async function listAssetReleases(assetId) {
  const [pub, slug] = splitAssetId(assetId)
  const releases = await getJson(`${API_BASE}/releases/${pub}/${slug}/`)
  const list = [...(Array.isArray(releases) ? releases : [])].sort((a, b) =>
    String(b.created).localeCompare(String(a.created))
  )
  return list.map((r) => ({
    version: String(r.version || ''),
    created: r.created || '',
    stable: !!r.stable,
    minGodot: r.min_godot_version != null ? String(r.min_godot_version) : '',
    maxGodot: r.max_godot_version != null ? String(r.max_godot_version) : '',
    /** 字节。API 给的是 MB 浮点数,已在此换算 */
    size: r.size ? Math.round(Number(r.size) * 1e6) : 0
  }))
}

module.exports = {
  searchAssets,
  listFeatured,
  listAllAssets,
  listNewAssets,
  listRecentlyUpdated,
  listFavorites,
  toggleFavorite,
  isFavorite,
  getReleaseInfos,
  listAssetReleases,
  verifyApiKey,
  getAssetDetail,
  listAddons,
  installAsset,
  updateAsset,
  checkAddonUpdate,
  uninstallAddon,
  setAddonEnabled
}
