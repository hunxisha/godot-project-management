// Godot Asset Store(store.godotengine.org/api/v1,2026 起官方编辑器使用的新 API):
// 搜索、安装、启用、更新、卸载插件(Addon)与纯素材(模型/精灵等)
// assetId 格式为 "{publisherSlug}/{assetSlug}",如 "maran23/script-ide"
//
// 安装按 zip 内容嗅探分流:含 plugin.cfg 走插件链路(进 addons/ 并启用),
// 否则视为纯素材按原结构落到项目根并记录文件清单(卸载/更新按清单执行)。
// 商店 API 的 type 字段把素材也归在 Addon 类型下(type=0 "Addon (tools, assets, etc...)"),
// 不能作为判据。

// 2026-09-29 拆分:本文件只剩头部说明、本地收藏域与对外再导出。
// 各域实现:assetapi(商店 API 客户端) / assetfiles(文件系统与嗅探) /
// assetstage(安装预览与暂存) / assetsinstall(安装执行)。
// module.exports 的键集合与拆分前完全一致。
const { getDoc, putDoc, putDocVerbose } = require('./store')
/** @typedef {import('../../../src/types/godot').MarketAsset} MarketAsset */
/** @typedef {import('../../../src/types/godot').FavoriteAsset} FavoriteAsset */
/** @typedef {MarketAsset & { addedAt?: number }} FavoriteToggleInput */
const {
  searchAssets, listFeatured, listAllAssets, listNewAssets, listRecentlyUpdated,
  listProjectAssets, getAssetDetail, verifyApiKey, getReleaseInfos, listAssetReleases
} = require('./assetapi')
const { listAddons } = require('./assetfiles')
const { previewAssetInstall, cancelAssetPreview, cancelStagedAsset } = require('./assetstage')
const {
  installAsset, saveAssetAsProject, downloadAssetZip, copyAssetToProject, updateAsset, checkAddonUpdate,
  uninstallAddon, setAddonEnabled
} = require('./assetsinstall')

// ---------- 本地收藏(官方 API 暂未开放收藏,收藏数据存于本地插件数据库) ----------

const FAVORITES_ID = 'godot/market/favorites'

/** @returns {FavoriteAsset[]} 收藏数据存于本地插件数据库 */
function readFavorites() {
  return getDoc(FAVORITES_ID)?.items || []
}

/** 收藏列表(按收藏时间倒序) */
function listFavorites() {
  return [...readFavorites()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
}

/**
 * 收藏/取消收藏。
 *
 * 三条约束(踩过坑,别简化):
 *  1. **不得改动入参**。原先这里有 `delete asset.addedAt`,会改到渲染层的响应式资产对象;
 *     而且它是多余动作 —— 下面显式写了 `addedAt: Date.now()`,展开时带过来的旧值本就会被覆盖。
 *  2. **assetId 必须归一化**。它决定「是否已收藏」的判断,展开入参对象得到的值可能是数字
 *     (已安装插件记录里的 assetId 就是数字),数字与字符串混用会让同一个插件出现两条收藏。
 *  3. **写库失败必须抛出原因**。原先忽略 `putDoc` 的返回值,「点收藏没反应」在界面上毫无线索;
 *     现在把宿主返回的 name/message(如 conflict)带进错误消息,由界面显示出来。
 *
 * @param {FavoriteToggleInput} asset
 * @returns {boolean} 操作后是否处于「已收藏」状态
 * @throws {Error} 资产缺少 assetId,或宿主写库失败
 */
function toggleFavorite(asset) {
  const assetId = asset && asset.assetId != null ? String(asset.assetId) : ''
  // 没有 assetId 就无从判断身份 —— 直接报错比写一条永远匹配不上的脏记录好,而且不必静默
  if (!assetId) throw new Error('该资产没有 assetId,无法收藏')

  const list = readFavorites()
  const exists = list.some((x) => x && String(x.assetId) === assetId)
  // 一律生成新数组:不改入参,也不改库里的那个数组(宿主 db.get 可能返回同一个引用)
  const next = exists
    ? list.filter((x) => !x || String(x.assetId) !== assetId)
    : [...list, { ...asset, assetId, addedAt: Date.now() }]

  const res = putDocVerbose(FAVORITES_ID, { items: next })
  if (!res.ok) throw new Error(`写入收藏失败:${res.reason}`)
  return isFavorite(assetId)
}

/**
 * 是否已收藏。
 * @param {string} assetId
 * @returns {boolean}
 */
function isFavorite(assetId) {
  // 两侧都按字符串比:库里存的是字符串,调用方可能传数字(已安装插件的 assetId 是数字)
  if (assetId == null || assetId === '') return false
  const key = String(assetId)
  return readFavorites().some((x) => x && String(x.assetId) === key)
}

module.exports = {
  searchAssets,
  listFeatured,
  listAllAssets,
  listNewAssets,
  listRecentlyUpdated,
  listProjectAssets,
  listFavorites,
  toggleFavorite,
  isFavorite,
  getReleaseInfos,
  listAssetReleases,
  verifyApiKey,
  getAssetDetail,
  listAddons,
  previewAssetInstall,
  cancelAssetPreview,
  cancelStagedAsset,
  installAsset,
  saveAssetAsProject,
  downloadAssetZip,
  copyAssetToProject,
  updateAsset,
  checkAddonUpdate,
  uninstallAddon,
  setAddonEnabled
}
