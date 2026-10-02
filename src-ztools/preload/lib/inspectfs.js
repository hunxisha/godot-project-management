// 项目体检用的文件系统原语(见 docs/tools-page-plan.md §5.4)。
//
// 设计红线:
//   · 渲染层只拿 rel(相对项目根、正斜杠),绝对路径由这里拼 —— 误删面最小,
//     也让 JS / Rust 两端只需比对 rel/size 序列就能验证 parity。
//   · rel 一律过 resolveRel 校验:`..`、绝对路径、盘符都直接拒。
//   · 只读原语不抛异常,一律返回 { ok:false, error } —— 工具页要在结论里显示原因。
const fs = require('node:fs')
const path = require('node:path')
const { getDoc } = require('./store')
const { walkFiles, makeExcluder } = require('./fsutil')

const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_ENTRIES = 200000

/**
 * projectId(完整文档 id,如 godot/project/xxx)→ 项目根;拿不到返回 null
 * @param {string} projectId
 * @returns {string|null}
 */
function projectRoot(projectId) {
  const doc = projectId ? getDoc(String(projectId)) : null
  return doc && doc.path ? String(doc.path) : null
}

/**
 * rel → 绝对路径。越界/绝对/含 `..` 一律返回 null。
 * @param {string|null} root
 * @param {unknown} rel
 * @returns {string|null}
 */
function resolveRel(root, rel) {
  if (!root || typeof rel !== 'string' || !rel) return null
  const norm = rel.replace(/\\/g, '/')
  if (norm.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(norm)) return null
  const stack = []
  for (const p of norm.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') return null
    stack.push(p)
  }
  if (!stack.length) return null
  return path.join(root, ...stack)
}

/**
 * 遍历项目文件树。默认**跳过**任意层级的 `.godot`(与 fsutil.walkFiles 的默认相反)。
 * @param {string} projectId
 * @param {{includeCache?:boolean, exts?:string[], skipDirs?:string[], maxEntries?:number}} [opts]
 * @returns {import('../../../src/types/godot').ScanTreeResult}
 */
function scanProjectTree(projectId, opts) {
  const o = opts || {}
  const root = projectRoot(projectId)
  if (!root) return { ok: false, error: '项目不存在' }
  if (!fs.existsSync(root)) return { ok: false, error: '项目目录已不存在' }
  const exts = Array.isArray(o.exts) && o.exts.length
    ? new Set(o.exts.map((e) => String(e).toLowerCase().replace(/^\./, '')))
    : null
  const max = o.maxEntries && o.maxEntries > 0 ? o.maxEntries : DEFAULT_MAX_ENTRIES
  /** @type {import('../../../src/types/godot').TreeEntry[]} */
  const files = []
  let walked
  try {
    walked = walkFiles(root, {
      includeCache: o.includeCache === true,
      exclude: makeExcluder(o.skipDirs)
    })
  } catch (e) {
    return { ok: false, error: (e && e.message) || '遍历失败' }
  }
  for (const f of walked) {
    const rel = String(f.rel).split(path.sep).join('/')
    const ext = path.extname(rel).slice(1).toLowerCase()
    if (exts && !exts.has(ext)) continue
    let st
    try { st = fs.statSync(f.abs) } catch (e) { continue }
    files.push({ rel, size: st.size, mtimeMs: Math.round(st.mtimeMs), ext })
    if (files.length >= max) return { ok: true, files, truncated: true }
  }
  return { ok: true, files, truncated: false }
}

module.exports = { projectRoot, resolveRel, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, scanProjectTree }
