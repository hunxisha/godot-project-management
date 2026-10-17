// 译文的本地缓存:一条资产一条文档(`godot/trans/{assetId}`)。
//
// 为什么不塞进一个全局文档:宿主 db 是文档式的,putDoc 每次**整篇重写**。
// 全放一条文档意味着每翻 20 条卡片就要序列化几千条历史,越用越卡;
// 按资产拆开后,命中与写入都是常数级,删除单条也便宜。
//
// 缓存键 = 资产 + 条目种类 + 目标语言 + 服务商标识 + 原文哈希。
// 原文哈希参与键是硬要求:商店改了描述,旧译文自然不再命中,不需要任何失效逻辑。
const crypto = require('node:crypto')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')

const PREFIX = 'godot/trans/'
/** 与 godot/cache/release-infos 的既有上限保持一致,避免又一套数字 */
const MAX_DOCS = 2000

/**
 * 原文哈希(16 位足够区分同一资产的多次改稿,不用于安全)。
 * @param {string} text
 * @returns {string}
 */
function hashText(text) {
  return crypto.createHash('sha1').update(String(text == null ? '' : text)).digest('hex').slice(0, 16)
}

/**
 * assetId → 文档 id(`publisher/slug` 里的斜杠不能留在 id 里,否则前缀扫描会串)
 * @param {string} assetId
 * @returns {string}
 */
function docId(assetId) {
  return PREFIX + encodeURIComponent(String(assetId || ''))
}

/**
 * 从文档 id 还原 assetId
 * @param {string} id
 * @returns {string}
 */
function assetIdOf(id) {
  return decodeURIComponent(String(id || '').slice(PREFIX.length))
}

/**
 * 读一条资产的缓存条目。没有/结构坏掉都返回空数组 —— 缓存坏了就当没缓存,不能让界面报错。
 * @param {string} assetId
 * @returns {{kind: string, lang: string, provider: string, srcHash: string, text: string}[]}
 */
function readEntries(assetId) {
  const doc = getDoc(docId(assetId))
  /** @type {any[]} */
  const list = doc && Array.isArray(doc.entries) ? doc.entries : []
  return list.filter((e) => e && typeof e.text === 'string' && e.srcHash)
}

/**
 * 命中查找。键完全一致才算命中(服务商与模型都在键里:换引擎就该重新翻,
 * 否则用户明明切到了 AI 却拿到 DeepL 的旧译文)。
 * @param {{kind: string, lang: string, provider: string, srcHash: string, text: string}[]} entries
 * @param {{kind: string, lang: string, provider: string, srcHash: string}} want
 * @returns {string | null}
 */
function matchEntry(entries, want) {
  for (const e of entries || []) {
    if (e.kind === want.kind && e.lang === want.lang &&
      e.provider === want.provider && e.srcHash === want.srcHash) {
      return e.text
    }
  }
  return null
}

/**
 * 合并写入(同键覆盖),并在条目超限时按 updatedAt 淘汰最旧的文档。
 * @param {string} assetId
 * @param {{kind: string, lang: string, provider: string, srcHash: string, text: string}[]} list
 * @returns {boolean} 是否写入成功
 */
function upsert(assetId, list) {
  const fresh = (Array.isArray(list) ? list : []).filter((e) => e && typeof e.text === 'string' && e.srcHash)
  if (!fresh.length) return false
  const id = docId(assetId)
  const doc = getDoc(id)
  const old = doc && Array.isArray(doc.entries) ? doc.entries : []
  /** @type {Map<string, any>} */
  const byKey = new Map()
  for (const e of old) byKey.set(`${e.kind}|${e.lang}|${e.provider}|${e.srcHash}`, e)
  for (const e of fresh) byKey.set(`${e.kind}|${e.lang}|${e.provider}|${e.srcHash}`, e)
  const entries = [...byKey.values()]
  const wrote = putDoc(id, { assetId, updatedAt: Date.now(), entries })
  if (wrote) trim()
  return wrote
}

/** 超出上限时按 updatedAt 从旧到新删(整条资产文档一起删) */
function trim() {
  const docs = listDocs(PREFIX)
  if (docs.length <= MAX_DOCS) return 0
  const sorted = docs.slice().sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
  let removed = 0
  for (const d of sorted.slice(0, docs.length - MAX_DOCS)) {
    if (removeDoc(d._id)) removed++
  }
  return removed
}

/**
 * 缓存统计(设置页显示与「一键清理」用)。
 * @returns {{count: number, sizeBytes: number, entries: number}}
 */
function stats() {
  const docs = listDocs(PREFIX)
  let sizeBytes = 0
  let entries = 0
  for (const d of docs) {
    try {
      sizeBytes += Buffer.byteLength(JSON.stringify(d), 'utf8')
    } catch (e) {
      /* 序列化失败只影响体积估算,不该让设置页报错 */
    }
    if (Array.isArray(d.entries)) entries += d.entries.length
  }
  return { count: docs.length, sizeBytes, entries }
}

/**
 * 清空全部译文缓存。
 * @returns {{ok: boolean, removed: number}}
 */
function clear() {
  let removed = 0
  for (const d of listDocs(PREFIX)) {
    if (removeDoc(d._id)) removed++
  }
  return { ok: true, removed }
}

module.exports = {
  PREFIX,
  MAX_DOCS,
  hashText,
  docId,
  assetIdOf,
  readEntries,
  matchEntry,
  upsert,
  stats,
  clear
}
