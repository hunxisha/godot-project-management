// 全文搜索(描述正文):整库懒加载 + 常驻缓存,按 index.json mtime 失效。
// 不做倒排索引(省掉构建开销与索引体积),线性扫描几十毫秒。从 docs.js 拆出(2026-09-29)。
const fs = require('node:fs')
const path = require('node:path')
const { libClassesDir, libIndexPath } = require('./docpaths')

/** @typedef {import('../../../src/types/godot').DocClassDetail} DocClassDetail */

// ---------- 全文搜索(描述正文) ----------
//
// 名称搜索走索引即可;正文检索需要读每个类的 JSON。库总量约 10-15MB,一次性读进内存后
// 线性扫描只需几十毫秒,因此不做倒排索引(省掉构建开销与索引体积),首查懒加载 + 常驻缓存,
// 库重建时按 index.json 的 mtime 自动失效。

/** @type {Map<string, {items: {name: string, text: string, json: DocClassDetail}[], at: number}>} */
const fullTextCache = new Map()

/**
 * 载入整库正文(懒加载,按 index.json mtime 失效)。
 * @param {string} versionId
 */
function loadFullText(versionId) {
  const indexFile = libIndexPath(versionId)
  let mtime = 0
  try {
    mtime = fs.statSync(indexFile).mtimeMs
  } catch (e) {
    return null
  }
  const hit = fullTextCache.get(versionId)
  if (hit && hit.at === mtime) return hit.items
  const dir = libClassesDir(versionId)
  /** @type {{name: string, text: string, json: DocClassDetail}[]} */
  const items = []
  /** @type {string[]} */
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    return null
  }
  for (const file of names) {
    if (!file.endsWith('.json')) continue
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      // 只保留可检索的描述文本(名称类命中由索引负责,这里专攻正文)
      const parts = [json.brief || '', json.description || '']
      for (const m of json.methods || []) parts.push(m.description || '')
      for (const p of json.members || []) parts.push(p.description || '')
      for (const s of json.signals || []) parts.push(s.description || '')
      for (const c of json.constants || []) parts.push(c.description || '')
      for (const e of json.enums || []) for (const v of e.values || []) parts.push(v.description || '')
      items.push({ name: json.name, text: parts.join('\n'), json })
    } catch (e) { /* 单个文件损坏不影响整库检索 */ }
  }
  fullTextCache.set(versionId, { items, at: mtime })
  return items
}

/**
 * 从命中位置截一段上下文(前后各留一些字符,压掉换行)。
 * @param {string} text
 * @param {number} at
 */
function snippetOf(text, at) {
  const start = Math.max(0, at - 40)
  const end = Math.min(text.length, at + 60)
  const raw = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${raw}${end < text.length ? '…' : ''}`
}

/**
 * 描述正文检索:返回按命中次数排序的类,附首个片段。
 * @param {string} versionId
 * @param {string} query
 * @param {number} [limit]
 * @returns {{kind: 'body', className: string, name: string, brief: string, snippet: string, score: number}[]}
 */
function docsSearchFullText(versionId, query, limit = 20) {
  const q = String(query || '').trim().toLowerCase()
  if (q.length < 2) return []
  const items = loadFullText(versionId)
  if (!items) return []
  /** @type {{kind: 'body', className: string, name: string, brief: string, snippet: string, score: number}[]} */
  const hits = []
  for (const it of items) {
    const hay = it.text.toLowerCase()
    const at = hay.indexOf(q)
    if (at < 0) continue
    // 命中次数作为相关度(封顶,避免长描述刷屏)
    let count = 0
    let cursor = at
    while (cursor >= 0 && count < 50) {
      count++
      cursor = hay.indexOf(q, cursor + q.length)
    }
    hits.push({
      kind: 'body',
      className: it.name,
      name: it.name,
      brief: it.json.brief || '',
      snippet: snippetOf(it.text, at),
      score: count
    })
  }
  hits.sort((a, b) => b.score - a.score || a.className.localeCompare(b.className))
  return limit > 0 ? hits.slice(0, limit) : hits
}

module.exports = { docsSearchFullText }
