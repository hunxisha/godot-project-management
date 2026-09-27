// 插件数据导出/导入:换机迁移用。
//
// 导出 = 设置 + 项目清单 + 市场收藏 + 文档收藏/浏览历史 打包成一个 JSON 文件。
// 文档库正文(可再生成的大体积缓存)不迁移,只有跨版本生效的收藏与历史跟着走。
// 导入 = 项目仅登记本机路径存在的条目(引擎/备份路径都是本机概念,不迁移);
//        收藏按 assetId 合并(不覆盖本机已有);文档收藏并集、浏览历史按时间合并去重;
//        设置只补本机缺失的键(versionsRoot/backupRoot/proxy 这类机器本地路径不应被导入值覆盖)。
const fs = require('node:fs')
const { getDoc, putDoc, listDocs } = require('./store')
const { addProject } = require('./projects')

const FAVORITES_ID = 'godot/market/favorites'
const DOC_FAVORITES_ID = 'godot/docs/favorites'
const DOC_HISTORY_ID = 'godot/docs/history'
/** 浏览历史上限(与 docs.js 的 HISTORY_MAX 一致) */
const DOC_HISTORY_MAX = 30
const DATA_KIND = 'ztools-godot-data'

/**
 * 导出插件数据到 JSON 文件。
 * @param {string} destPath
 * @returns {{ok: boolean, error?: string, projects?: number, favorites?: number, docFavorites?: number, docHistory?: number}}
 */
function exportPluginData(destPath) {
  try {
    if (!destPath) return { ok: false, error: '未指定导出路径' }
    const settings = getDoc('godot/settings') || {}
    const { _id: _sid, _rev: _srev, ...settingsFields } = settings
    const projects = listDocs('godot/project/').map(({ _id, _rev, ...rest }) => rest)
    const favorites = (getDoc(FAVORITES_ID) || {}).items || []
    const docFavorites = (getDoc(DOC_FAVORITES_ID) || {}).items || []
    const docHistory = (getDoc(DOC_HISTORY_ID) || {}).items || []
    const data = {
      kind: DATA_KIND,
      version: 2,
      exportedAt: Date.now(),
      settings: settingsFields,
      projects,
      favorites,
      docFavorites,
      docHistory
    }
    fs.writeFileSync(destPath, JSON.stringify(data, null, 2), 'utf8')
    return { ok: true, projects: projects.length, favorites: favorites.length, docFavorites: docFavorites.length, docHistory: docHistory.length }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '导出失败' }
  }
}

/**
 * 从 JSON 文件导入插件数据。
 * @param {string} srcPath
 * @returns {{ok: boolean, error?: string, projectsAdded?: number, projectsOffline?: number, projectsSkipped?: number, favoritesAdded?: number, docFavoritesAdded?: number, docHistoryAdded?: number, settingsAdopted?: number}}
 */
function importPluginData(srcPath) {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: '文件不存在' }
    const data = JSON.parse(fs.readFileSync(srcPath, 'utf8'))
    if (!data || data.kind !== DATA_KIND) return { ok: false, error: '不是本插件导出的数据文件' }

    // 项目:只登记本机路径存在的;引擎绑定 versionId 是本机文档 id,保持原值,
    // 若本机无此引擎,项目页的「未绑定」提示会自然出现
    let projectsAdded = 0
    let projectsOffline = 0
    let projectsSkipped = 0
    for (const p of data.projects || []) {
      if (!p.path || !fs.existsSync(p.path)) {
        projectsOffline++
        continue
      }
      const r = addProject(p.path)
      if (r.ok) projectsAdded++
      else projectsSkipped++
    }

    // 收藏:按 assetId 合并,不覆盖本机已有
    const local = getDoc(FAVORITES_ID) || {}
    const items = Array.isArray(local.items) ? [...local.items] : []
    const have = new Set(items.map((x) => x && String(x.assetId)))
    let favoritesAdded = 0
    for (const f of data.favorites || []) {
      if (!f || f.assetId == null) continue
      if (have.has(String(f.assetId))) continue
      items.push({ ...f, addedAt: f.addedAt || Date.now() })
      have.add(String(f.assetId))
      favoritesAdded++
    }
    putDoc(FAVORITES_ID, { items })

    // 文档收藏:按类名取并集(全局,跨版本)
    const localDocFavs = getDoc(DOC_FAVORITES_ID) || {}
    const docItems = Array.isArray(localDocFavs.items) ? [...localDocFavs.items] : []
    const haveClass = new Set(docItems)
    let docFavoritesAdded = 0
    for (const c of data.docFavorites || []) {
      if (!c || typeof c !== 'string' || haveClass.has(c)) continue
      docItems.push(c)
      haveClass.add(c)
      docFavoritesAdded++
    }
    docItems.sort()
    putDoc(DOC_FAVORITES_ID, { items: docItems })

    // 浏览历史:按类名去重、保留最新时间,按时间倒序截断
    const localDocHist = getDoc(DOC_HISTORY_ID) || {}
    /** @type {{name: string, at: number}[]} */
    const hist = Array.isArray(localDocHist.items) ? [...localDocHist.items] : []
    const histAt = new Map(hist.map((h) => [h.name, h.at || 0]))
    for (const h of data.docHistory || []) {
      if (!h || typeof h.name !== 'string') continue
      const at = h.at || 0
      histAt.set(h.name, Math.max(histAt.get(h.name) || 0, at))
    }
    const mergedHist = [...histAt.entries()]
      .map(([name, at]) => ({ name, at }))
      .sort((a, b) => b.at - a.at)
      .slice(0, DOC_HISTORY_MAX)
    const docHistoryAdded = mergedHist.filter((h) => !hist.some((x) => x.name === h.name)).length
    putDoc(DOC_HISTORY_ID, { items: mergedHist })

    // 设置:只补本机缺失的键(机器本地路径不被导入值覆盖)
    const localSettings = getDoc('godot/settings') || {}
    const { _id: _sid, _rev: _srev, ...imported } = data.settings || {}
    /** @type {Record<string, any>} */
    const patch = {}
    for (const [k, v] of Object.entries(imported)) {
      if (localSettings[k] === undefined && v !== undefined && v !== null) patch[k] = v
    }
    if (Object.keys(patch).length) putDoc('godot/settings', { ...localSettings, ...patch })
    const settingsAdopted = Object.keys(patch).length

    return { ok: true, projectsAdded, projectsOffline, projectsSkipped, favoritesAdded, docFavoritesAdded, docHistoryAdded, settingsAdopted }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '导入失败' }
  }
}

module.exports = { exportPluginData, importPluginData }
