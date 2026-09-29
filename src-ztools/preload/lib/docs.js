// 引擎文档库:从已装 Godot 引擎导出类参考,建立离线索引供「文档」页浏览。
//
// 为什么不用 --doctool:官方编辑器二进制导出的 XML 只有 API 结构,描述文本为空
// (实测 4.7.2 stable / 4.8-dev6);--dump-extension-api-with-docs 输出单个
// extension_api.json,描述完整(BBCode 原样保留)、JSON.parse 即得,无需 XML 解析器。
// 详见 docs/docs-browser-plan.md 第 2.1 节的实测记录。
//
// 生成是长任务:独立串行队列(不与导出/模板共用),status: queued/dumping/parsing/
// done/error/canceled;dumping 阶段 spawn 引擎(可取消=kill),parsing 阶段分片让出。
// 失败/取消只清暂存目录,旧库与 db 记录保持完好(原子接管,与备份的原子落盘同一思路)。
//
// 存储:文件缓存 <versionsRoot>/gpm-docs/<versionId>/ 下 classes/<Class>.json(每类
// 正文)+ index.json(全库索引);db 只存元数据(godot/docs/<versionId>)与收藏/历史
// (godot/docs/favorites、godot/docs/history)。正文不进 db。

// 2026-09-29 拆分:本文件只剩浏览 API + 收藏/历史 + 缓存管理 + 对外再导出。
// 各域实现:docpaths(路径) / doctasks(队列) / docmodel(映射与打分) / docpo(翻译) /
// docextras(教程) / docbuild(流水线与索引缓存) / docdiff(差异) / gdscan(项目扫描) /
// docfulltext(全文检索)。module.exports 的 33 个键与拆分前完全一致。
const fs = require('node:fs')
const path = require('node:path')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')
const { dirSize } = require('./extract')
const { rmQuiet } = require('./fsutil')
const { VERSION_PREFIX, versionKey, docsRoot, libClassesDir, DB_ID, FAVORITES_ID, HISTORY_ID, CLASS_NAME_RE } = require('./docpaths')
const { tasks, cancelDocsTask, dismissDocsTask, watchDocsTasks } = require('./doctasks')
const { mapClass, mapGlobalScope, buildIndexEntry, searchIndex, wordScore } = require('./docmodel')
const { unescapePo, parsePo, translationRefs, loadZhTranslations, applyTranslations } = require('./docpo')
const { docsUrlBase, parseTutorials, docsGetClassExtras } = require('./docextras')
const { loadIndex, indexCache, buildLibrary, writeLibrary, generateDocs, importDocsLibrary } = require('./docbuild')
const { methodSignature, diffGroup, overloadKey, memberSignature, diffClassDetail, docsDiffLibraries } = require('./docdiff')
const { parseGdParam, parseGdScript, collectGdFiles, scanProjectDocs } = require('./gdscan')
const { docsSearchFullText } = require('./docfulltext')
/** @typedef {import('../../../src/types/godot').DocClassDetail} DocClassDetail */
/** @typedef {import('../../../src/types/godot').DocClassSummary} DocClassSummary */
/** @typedef {import('../../../src/types/godot').DocSearchHit} DocSearchHit */
/** @typedef {import('../../../src/types/godot').DocHitKind} DocHitKind */
/** @typedef {import('../../../src/types/godot').DocLibraryStatus} DocLibraryStatus */
/** @typedef {import('../../../src/types/godot').DocHistoryItem} DocHistoryItem */
/** @typedef {import('../../../src/types/godot').DocsCacheInfo} DocsCacheInfo */

/** 最近浏览历史上限 */
const HISTORY_MAX = 30

// ---------- 浏览 API ----------

/**
 * 文档库状态:ready=已生成;building=生成中;null=未生成。
 * @param {string} versionId
 * @returns {DocLibraryStatus | null}
 */
function docsLibraryStatus(versionId) {
  const record = getDoc(DB_ID(versionId))
  if (record) {
    return {
      status: 'ready',
      versionId,
      tag: record.tag,
      name: record.name,
      classCount: record.classCount,
      builtAt: record.builtAt,
      lang: record.lang,
      translatedCount: record.translatedCount,
      stringCount: record.stringCount,
      kind: record.kind || 'engine',
      sourceProject: record.sourceProject
    }
  }
  const busy = tasks.list().find((/** @type {any} */ t) => versionKey(t.versionId).key === versionKey(versionId).key && !tasks.isTerminal(t.status))
  if (busy) return { status: 'building', versionId, tag: busy.tag, name: busy.versionName }
  return null
}

/**
 * 删除文档库(目录 + db 记录;收藏/历史是全局的,保留)。幂等。
 * @param {string} versionId
 * @returns {{ok: boolean}}
 */
function docsDeleteLibrary(versionId) {
  rmQuiet(docsRoot(versionId))
  removeDoc(DB_ID(versionId))
  indexCache.delete(versionId)
  return { ok: true }
}

/**
 * 类列表(来自索引;索引不存在时返回错误)。
 * @param {string} versionId
 * @returns {{ok: boolean, error?: string, classes?: DocClassSummary[]}}
 */
function docsListClasses(versionId) {
  const index = loadIndex(versionId)
  if (!index) return { ok: false, error: '文档库不存在或未生成' }
  return { ok: true, classes: index }
}

/**
 * 读取单个类正文。类名做白名单校验,阻断路径穿越。
 * @param {string} versionId
 * @param {string} className
 * @returns {DocClassDetail | null}
 */
function docsGetClass(versionId, className) {
  if (!CLASS_NAME_RE.test(String(className || ''))) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(libClassesDir(versionId), `${className}.json`), 'utf8'))
  } catch (e) {
    return null
  }
}

/**
 * 本地搜索(类名/方法/成员/信号/枚举/常量)。
 * @param {string} versionId
 * @param {string} query
 * @param {number} [limit]
 * @returns {DocSearchHit[]}
 */
function docsSearch(versionId, query, limit = 30) {
  const index = loadIndex(versionId)
  if (!index) return []
  return searchIndex(index, query, limit)
}

/**
 * 单类在两库之间的成员级差异(类在任一库缺失时返回 ok=false)。
 * @param {string} versionA
 * @param {string} versionB
 * @param {string} className
 */
function docsDiffClass(versionA, versionB, className) {
  const a = docsGetClass(versionA, className)
  const b = docsGetClass(versionB, className)
  if (!a || !b) return { ok: false, error: '该类在其中一个库中不存在' }
  return { ok: true, diff: diffClassDetail(a, b) }
}

// ---------- 收藏与历史(全局,跨版本) ----------

/**
 * @param {string} id
 * @param {any} fallback
 * @returns {any}
 */
function readDoc(id, fallback) {
  const d = getDoc(id)
  return d || fallback
}

/**
 * @returns {string[]}
 */
function docsListFavorites() {
  return readDoc(FAVORITES_ID, { items: [] }).items || []
}

/**
 * @param {string} className
 * @param {boolean} fav
 * @returns {{ok: boolean}}
 */
function docsToggleFavorite(className, fav) {
  const items = docsListFavorites()
  const set = new Set(items)
  if (fav) set.add(className)
  else set.delete(className)
  putDoc(FAVORITES_ID, { items: [...set].sort() })
  return { ok: true }
}

/**
 * @returns {DocHistoryItem[]}
 */
function docsListHistory() {
  return readDoc(HISTORY_ID, { items: [] }).items || []
}

/**
 * 记录一次浏览:去重置顶,上限 HISTORY_MAX。
 * @param {string} className
 */
function docsPushHistory(className) {
  const items = (readDoc(HISTORY_ID, { items: [] }).items || []).filter((/** @type {{name: string}} */ x) => x.name !== className)
  items.unshift({ name: className, at: Date.now() })
  putDoc(HISTORY_ID, { items: items.slice(0, HISTORY_MAX) })
}

// ---------- 缓存统计与清理 ----------

/**
 * @returns {DocsCacheInfo}
 */
function docsCacheInfo() {
  const records = listDocs('godot/docs/').filter((/** @type {any} */ d) => d.versionId)
  const libraries = records.map((/** @type {any} */ r) => ({
    versionId: r.versionId,
    tag: r.tag,
    classes: r.classCount,
    builtAt: r.builtAt,
    sizeBytes: r.libDir && fs.existsSync(r.libDir) ? dirSize(r.libDir) : 0
  }))
  return { sizeBytes: libraries.reduce((s, l) => s + l.sizeBytes, 0), libraries }
}

/**
 * 清理文档库缓存。versionIds 省略时清理全部;收藏/历史不在清理范围。
 * @param {string[]} [versionIds]
 * @returns {{ok: boolean, removed?: number}}
 */
function docsCleanCache(versionIds) {
  const ids = (versionIds && versionIds.length
    ? versionIds
    : listDocs('godot/docs/').filter((/** @type {any} */ d) => d.versionId).map((/** @type {any} */ d) => d.versionId))
  for (const id of ids) docsDeleteLibrary(id)
  // 全部清空时连空的根目录一起移除,不留 gpm-docs 空壳
  if (!listDocs('godot/docs/').some((/** @type {any} */ d) => d.versionId)) {
    rmQuiet(docsRoot())
  }
  return { ok: true, removed: ids.length }
}
module.exports = {
  // 纯函数(测试用)
  mapClass,
  mapGlobalScope,
  buildIndexEntry,
  searchIndex,
  wordScore,
  parsePo,
  applyTranslations,
  parseTutorials,
  parseGdScript,
  parseGdParam,
  diffGroup,
  diffClassDetail,
  // 主流程
  generateDocs,
  importDocsLibrary,
  scanProjectDocs,
  docsLibraryStatus,
  docsDeleteLibrary,
  docsListClasses,
  docsGetClass,
  docsGetClassExtras,
  docsSearch,
  docsDiffLibraries,
  docsDiffClass,
  docsSearchFullText,
  // 任务三件套
  cancelDocsTask,
  dismissDocsTask,
  watchDocsTasks,
  // 收藏与历史
  docsListFavorites,
  docsToggleFavorite,
  docsListHistory,
  docsPushHistory,
  // 缓存
  docsCacheInfo,
  docsCleanCache
}
