// 项目体检用的文件系统原语(见 docs/tools-page-plan.md §5.4)。
//
// 设计红线:
//   · 渲染层只拿 rel(相对项目根、正斜杠),绝对路径由这里拼 —— 误删面最小,
//     也让 JS / Rust 两端只需比对 rel/size 序列就能验证 parity。
//   · rel 一律过两道闸:resolveRel 挡字面越界(`..`、绝对路径、盘符),
//     resolveInside 再挡「项目内的符号链接指向项目外」(realpath 后必须仍在根内)。
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
 * 文本闸 + **真实路径包含校验**:用来挡住「项目内的符号链接指向项目外」这类绕过。
 * 目标不存在时(将要新建的文件),退到**最近的已存在祖先**做包含校验。
 * realpath 失败(权限等)按保守处理:拒绝。
 *
 * 为什么需要第二道闸:resolveRel 只做字面判断(`..` / 绝对 / 盘符),而 fs.statSync、
 * fs.readFileSync 会跟随符号链接 —— 项目内一条指向 ~/.ssh/id_rsa 的链接就能读出去。
 * 资产站 zip 解压正是项目内出现符号链接的主路径。错误串**刻意复用** '非法路径':
 * 不新增文案、不透露被挡掉的到底是哪一类(Rust 侧 Task 6-7 也只需镜像同一批串)。
 * @param {string|null} root
 * @param {unknown} rel
 * @returns {{abs?: string, error?: string}}
 */
function resolveInside(root, rel) {
  if (!root) return { error: '项目不存在' }
  const abs = resolveRel(root, rel)
  if (!abs) return { error: '非法路径' }
  let realRoot
  try { realRoot = fs.realpathSync(root) } catch (e) { return { error: '路径无法解析' } }
  let real
  if (fs.existsSync(abs)) {
    try { real = fs.realpathSync(abs) } catch (e) { return { error: '路径无法解析' } }
  } else {
    // 目标还不存在(写新文件的路径):逐级上溯到最近的已存在祖先,realpath 它,再把剩余段接回去
    const rest = []
    let cursor = abs
    /** @type {string|null} */
    let ancestor = null
    for (;;) {
      rest.unshift(path.basename(cursor))
      const parent = path.dirname(cursor)
      if (!parent || parent === cursor) break // 已到文件系统根仍不存在
      cursor = parent
      if (fs.existsSync(cursor)) {
        try { ancestor = fs.realpathSync(cursor) } catch (e) { return { error: '路径无法解析' } }
        break
      }
    }
    if (!ancestor) return { error: '目标目录不存在' }
    real = path.join(ancestor, ...rest)
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { error: '非法路径' }
  return { abs } // 返回 resolveRel 的原始 abs:普通文件行为与今日逐字节一致,rel 仍是对外唯一的键
}

/**
 * 读项目内文本文件。默认限额 1MB;超限只报 truncated,不返回内容。
 * 前 512 字节含 NUL 视为二进制(不按扩展名维护黑名单)。
 * @param {string} projectId
 * @param {string} rel
 * @param {{maxBytes?:number}} [opts]
 * @returns {import('../../../src/types/godot').ReadTextResult}
 */
function readProjectText(projectId, rel, opts) {
  const o = opts || {}
  const root = projectRoot(projectId)
  const g = resolveInside(root, rel)
  const abs = g.abs
  if (!abs) return { ok: false, error: g.error || '非法路径' }
  let st
  try { st = fs.statSync(abs) } catch (e) { return { ok: false, error: '文件不存在' } }
  if (!st.isFile()) return { ok: false, error: '文件不存在' }
  const max = o.maxBytes && o.maxBytes > 0 ? o.maxBytes : DEFAULT_MAX_BYTES
  if (st.size > max) return { ok: true, bytes: st.size, truncated: true }
  let buf
  try { buf = fs.readFileSync(abs) } catch (e) { return { ok: false, error: '读取失败' } }
  if (buf.subarray(0, 512).includes(0)) return { ok: true, bytes: st.size, skippedBinary: true }
  // bytes 取 buf.length 而不是 st.size:stat 与 read 之间 Godot 编辑器可能改写过文件,
  // 只有刚读进内存的字节数才真正描述返回的这段 text。
  return { ok: true, text: buf.toString('utf8'), bytes: buf.length, truncated: false }
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

module.exports = { projectRoot, resolveRel, resolveInside, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, scanProjectTree, readProjectText }
