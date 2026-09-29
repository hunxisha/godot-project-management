// Godot Asset Store API 客户端(store.godotengine.org/api/v1,2026 起官方编辑器使用的新 API):
// 列表/搜索/详情/批量版本信息/账号校验。纯网络读,零文件系统 ——
// 文件落盘分流在 assetfiles.js,安装执行在 assetsinstall.js。
// 从 assets.js 拆出(2026-09-29)。
// 注意:官方 type 字段把素材也归在 Addon 下,不能作为插件/素材判据(以 zip 内容嗅探为准)。
const { getJson } = require('./http')
const { getDoc, putDoc } = require('./store')

const API_BASE = 'https://store.godotengine.org/api/v1'
/** 商店页面地址前缀(格式与 API 返回的 store_url 一致:/asset/{publisher}/{slug}/) */
const STORE_BASE = 'https://store.godotengine.org'

/**
 * 保证拿到数组:商店 API 的字段可能是 null / 非数组,直接 .map 会炸。
 * 原先这个三元表达式在文件里重复了 8 次。
 * @param {any} v
 * @returns {any[]}
 */
function asArray(v) {
  return Array.isArray(v) ? v : []
}

/** @typedef {import('../../../src/types/godot').MarketAsset} MarketAsset */
/** @typedef {import('../../../src/types/godot').AddonInfo} AddonInfo */
/** @typedef {import('../../../src/types/godot').FavoriteAsset} FavoriteAsset */

/** 列表页展示用的最新 release 摘要 */
/** @typedef {{version: string, minGodot: string, maxGodot: string, created: string}} ReleaseInfo */

/** 安装/更新成功后回给渲染层的摘要(只含即时可展示的字段) */
/** @typedef {{title: string, versionString: string, dirNames: string[], enabled: boolean, kind: 'addon'|'asset'}} AddonBrief */

/**
 * 收藏入参:市场资产若来自收藏列表会带 addedAt(取消收藏时需先剥掉再重加),
 * 因此比 MarketAsset 多一个可选 addedAt。
 * @typedef {MarketAsset & { addedAt?: number }} FavoriteToggleInput
 */

/**
 * 拆 assetId 为 [publisherSlug, assetSlug]。
 * @param {string} assetId
 * @returns {[string, string]}
 */
function splitAssetId(assetId) {
  const [pub, slug] = String(assetId).split('/')
  if (!pub || !slug) throw new Error('资产 ID 无效: ' + assetId)
  return [pub, slug]
}

/**
 * 取 releases 数组中最新的一个(按 created 日期排序)。
 * @param {any[]} [list]
 * @returns {any} 最新 release;空列表返回 undefined
 */
function latestRelease(list) {
  if (!Array.isArray(list) || !list.length) return undefined
  const sorted = [...list].sort((a, b) => String(b.created).localeCompare(String(a.created)))
  return sorted[0]
}

/**
 * 商店资产对象 → MarketAsset 统一映射。
 * @param {any} a 商店 API 返回的资产对象
 * @returns {MarketAsset}
 */
function mapAsset(a) {
  return {
    assetId: `${a.publisher.slug}/${a.slug}`,
    title: a.name,
    author: a.publisher.name,
    category: (a.tags && a.tags[0] && a.tags[0].display_name) || '',
    tagSlugs: asArray(a.tags).map((t) => t.slug),
    versionString: '',
    godotVersion: '',
    iconUrl: a.thumbnail || undefined,
    description: a.description,
    storeUrl: a.store_url
  }
}

/**
 * 官方精选(推荐)Addon。
 * @returns {Promise<MarketAsset[]>}
 */
async function listFeatured() {
  const list = await getJson(`${API_BASE}/assets/?type=0&featured_only=true&require_release=true&page_size=20`)
  return asArray(list).map(mapAsset)
}

/** 全部资产总数缓存(assets 列表接口不返回 count,用搜索接口补一次) */
let allAssetCount = 0

/**
 * 全部资产(默认热度排序,分页)。
 * @param {number} [page]
 * @returns {Promise<{result: MarketAsset[], page: number, pages: number}>}
 */
async function listAllAssets(page = 1) {
  const list = await getJson(
    `${API_BASE}/assets/?type=0&require_release=true&page_size=20&page=${page}`
  )
  if (!allAssetCount) {
    const head = await getJson(
      `${API_BASE}/search/query/?query=&type=0&require_release=true&page=1&batch_size=1`
    ).catch(/** @returns {any} */ () => null)
    allAssetCount = Number(head && head.count) || asArray(list).length
  }
  return {
    result: asArray(list).map(mapAsset),
    page,
    pages: Math.max(1, Math.ceil(allAssetCount / 20))
  }
}

/**
 * 最新上架的资产(按发布时间倒序,分页)。
 * @param {number} [page]
 * @returns {Promise<{result: MarketAsset[], page: number, pages: number}>}
 */
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
    result: asArray(data.hits).map((h) => mapAsset(h.asset || {})),
    page,
    pages: Math.max(1, Math.ceil(count / 20))
  }
}

/**
 * 最近更新的 Addon(全库按更新时间倒序)。
 * @param {number} [page]
 * @returns {Promise<{result: MarketAsset[], page: number, pages: number}>}
 */
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
    result: asArray(data.hits).map((h) => mapAsset(h.asset || {})),
    page,
    pages: Math.max(1, Math.ceil(count / 20))
  }
}

/**
 * 搜索市场资产。
 * @param {string} filter 搜索词
 * @param {string} [godotVersion] 兼容版本过滤
 * @param {number} [page]
 * @param {number} [assetType] 商店资产类型:0=插件/素材(默认),1=完整项目(模板/演示)
 * @returns {Promise<{result: MarketAsset[], page: number, pages: number}>}
 */
async function searchAssets(filter, godotVersion, page = 1, assetType = 0) {
  const params = new URLSearchParams({
    query: filter || '',
    type: String(assetType || 0), // 0 = Addon(工具/脚本/素材),1 = 完整项目
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
    result: asArray(data.hits).map((h) => mapAsset(h.asset || {})),
    page,
    pages: Math.max(1, Math.ceil(count / 20))
  }
}

/**
 * 完整项目/模板(type=1):按更新时间倒序,分页。
 * 走 search 端点而不是 /assets/ —— 前者直接返回 count,省一次总数补查。
 * @param {number} [page]
 * @returns {Promise<{result: MarketAsset[], page: number, pages: number}>}
 */
async function listProjectAssets(page = 1) {
  const params = new URLSearchParams({
    query: '',
    type: '1',
    require_release: 'true',
    sort: 'updated_desc',
    page: String(page),
    batch_size: '20'
  })
  const data = await getJson(`${API_BASE}/search/query/?${params}`)
  const count = Number(data.count) || 0
  return {
    result: asArray(data.hits).map((h) => mapAsset(h.asset || {})),
    page,
    pages: Math.max(1, Math.ceil(count / 20))
  }
}

/**
 * 获取资产详情:含 release 的版本与下载直链(下载链接为带签名的临时直链,安装时实时获取)。
 * version 指定时取该版本(找不到时回退最新),否则取最新 release。
 * 同时带出详情弹层所需的扩展字段(媒体/许可/评分等;缺失时为空,渲染层需容忍)。
 * @param {string} assetId
 * @param {string} [version]
 * @returns {Promise<{assetId: string, title: string, author: string, versionString: string, downloadUrl: string, description: string, tags: string[], media: string[], videoId: string, licenseType: string, licenseUrl: string, reviewsScore: number, storeUrl: string, lastUpdated: string}>}
 */
async function getAssetDetail(assetId, version) {
  const [pub, slug] = splitAssetId(assetId)
  const detail = await getJson(`${API_BASE}/assets/${pub}/${slug}/`)
  /** @type {any[]} 远端 JSON,结构由 API 决定 */
  const releases = await getJson(`${API_BASE}/releases/${pub}/${slug}/`).catch(
    /** @returns {any[]} */ () => []
  )
  let rel = version ? releases.find((r) => String(r.version) === String(version)) : latestRelease(releases)
  if (version && !rel) rel = latestRelease(releases)
  if (!rel) rel = {}
  return {
    assetId,
    title: detail.name,
    author: (detail.publisher && detail.publisher.name) || '',
    versionString: rel.version || '',
    downloadUrl: rel.download_url || '',
    description: detail.description,
    tags: asArray(detail.tags).map((t) => t.display_name),
    media: asArray(detail.media),
    videoId: detail.video_id || '',
    licenseType: detail.license_type || '',
    licenseUrl: detail.license_url || '',
    reviewsScore: Number(detail.reviews_score) || 0,
    storeUrl: detail.store_url || `${STORE_BASE}/asset/${pub}/${slug}/`,
    lastUpdated: detail.last_updated || ''
  }
}

// ---------- 账号(API Key) ----------

/**
 * 验证 Asset Store API Key。
 * @param {string} key
 * @returns {Promise<{ authenticated: boolean, name?: string }>}
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

/**
 * release 精简信息。
 * @param {any} r
 * @returns {ReleaseInfo}
 */
function pickRelease(r) {
  if (!r) return { version: '', minGodot: '', maxGodot: '', created: '' }
  return {
    version: String(r.version || ''),
    minGodot: r.min_godot_version != null ? String(r.min_godot_version) : '',
    maxGodot: r.max_godot_version != null ? String(r.max_godot_version) : '',
    created: r.created || ''
  }
}

// release 信息缓存的常量:库文档 id、6 小时 TTL、容量上限(防长期浏览撑爆缓存文档)
const RELEASE_INFO_DOC = 'godot/cache/release-infos'
const RELEASE_INFO_TTL = 6 * 60 * 60 * 1000
const RELEASE_INFO_CAP = 2000

/**
 * 批量获取资产最新 release 信息(并发受限,两级缓存,失败只进内存缓存不落库)。
 * L1 = 进程内 Map;L2 = 本地库(6h TTL,容量裁剪),插件重启后翻页/复进市场不再全量重打 API。
 * @param {string[]} assetIds
 * @returns {Promise<Record<string, ReleaseInfo>>}
 */
async function getReleaseInfos(assetIds) {
  const ids = [...new Set(assetIds)].filter((id) => typeof id === 'string' && id.includes('/'))
  if (!ids.length) return {}
  const now = Date.now()
  const stored = (getDoc(RELEASE_INFO_DOC) || {}).items || {}
  /** @type {Record<string, any>} */
  const items = { ...stored }
  /** @type {string[]} */
  const missing = ids.filter((id) => {
    if (versionCache.has(id)) return false
    const hit = items[id]
    return !(hit && now - (hit.fetchedAt || 0) < RELEASE_INFO_TTL)
  })

  const CONCURRENCY = 6
  let idx = 0
  async function worker() {
    while (idx < missing.length) {
      const id = missing[idx++]
      try {
        const [pub, slug] = splitAssetId(id)
        const releases = await getJson(`${API_BASE}/releases/${pub}/${slug}/`)
        const info = pickRelease(latestRelease(releases))
        versionCache.set(id, info)
        items[id] = { ...info, fetchedAt: Date.now() }
      } catch (e) {
        // 失败只进内存缓存:暂时性故障不该把「无更新」钉住一整个 TTL
        versionCache.set(id, pickRelease(null))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker))

  if (missing.length) {
    // 容量裁剪:超过上限时丢弃最旧的条目,防止长期浏览把缓存文档撑爆
    const keys = Object.keys(items)
    if (keys.length > RELEASE_INFO_CAP) {
      keys.sort((a, b) => (items[a].fetchedAt || 0) - (items[b].fetchedAt || 0))
      for (const k of keys.slice(0, keys.length - RELEASE_INFO_CAP)) delete items[k]
    }
    putDoc(RELEASE_INFO_DOC, { fetchedAt: now, items })
  }

  /** @type {Record<string, ReleaseInfo>} */
  const out = {}
  for (const id of ids) {
    const hit = versionCache.get(id) || items[id]
    if (hit) out[id] = hit
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
 * @param {string} assetId
 * @returns {Promise<{version: string, created: string, stable: boolean, minGodot: string, maxGodot: string, size: number}[]>}
 */
async function listAssetReleases(assetId) {
  const [pub, slug] = splitAssetId(assetId)
  const releases = await getJson(`${API_BASE}/releases/${pub}/${slug}/`)
  const list = asArray(releases).sort((a, b) =>
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
  API_BASE,
  STORE_BASE,
  asArray,
  splitAssetId,
  latestRelease,
  mapAsset,
  listFeatured,
  listAllAssets,
  listNewAssets,
  listRecentlyUpdated,
  searchAssets,
  listProjectAssets,
  getAssetDetail,
  verifyApiKey,
  pickRelease,
  getReleaseInfos,
  listAssetReleases
}
