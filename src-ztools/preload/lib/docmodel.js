// extension_api.json → 内部模型映射 + 搜索打分。纯函数、零 I/O,可独立测试。
// 从 docs.js 拆出(2026-09-29)。
/** @typedef {import('../../../src/types/godot').DocClassDetail} DocClassDetail */
/** @typedef {import('../../../src/types/godot').DocClassSummary} DocClassSummary */
/** @typedef {import('../../../src/types/godot').DocSearchHit} DocSearchHit */
/** @typedef {import('../../../src/types/godot').DocHitKind} DocHitKind */
/** @typedef {import('../../../src/types/godot').DocLibraryStatus} DocLibraryStatus */
/** @typedef {import('../../../src/types/godot').DocHistoryItem} DocHistoryItem */
/** @typedef {import('../../../src/types/godot').DocsCacheInfo} DocsCacheInfo */

/** 搜索单个类的成员命中上限,避免 Node 这类大类刷屏挤掉其他类的结果 */
const SEARCH_PER_CLASS_CAP = 8

// ---------- extension_api.json → 内部模型映射(纯函数,可独立测试) ----------

/**
 * @param {{is_const?: boolean, is_static?: boolean, is_virtual?: boolean, is_vararg?: boolean, is_required?: boolean}} m
 * @returns {string[]}
 */
function qualifiersOf(m) {
  const q = []
  if (m.is_static) q.push('static')
  if (m.is_virtual) q.push('virtual')
  if (m.is_const) q.push('const')
  if (m.is_required) q.push('required')
  if (m.is_vararg) q.push('vararg')
  return q
}

/**
 * @param {{name: string, type: string, default_value?: string}[] | undefined} args
 * @returns {import('../../../src/types/godot').DocParam[]}
 */
function mapParams(args) {
  return (args || []).map((a) => ({
    name: a.name,
    type: a.type || 'Variant',
    defaultValue: a.default_value
  }))
}

/**
 * 把 extension_api.json 的单个类(core 或 builtin)映射为内部模型。
 * @param {Record<string, any>} c
 * @param {{builtin?: boolean, isSingleton?: boolean}} [opts]
 * @returns {DocClassDetail}
 */
function mapClass(c, opts = {}) {
  const builtin = !!opts.builtin
  return {
    name: c.name,
    inherits: c.inherits || null,
    brief: c.brief_description || '',
    description: c.description || '',
    builtin,
    isSingleton: !!opts.isSingleton,
    // core 类成员在 properties,builtin 类在 members
    members: (c.properties || c.members || []).map((/** @type {any} */ p) => ({
      name: p.name,
      type: p.type || 'Variant',
      setter: p.setter || undefined,
      getter: p.getter || undefined,
      defaultValue: p.default_value,
      description: p.description || ''
    })),
    methods: (c.methods || []).map((/** @type {any} */ m) => ({
      name: m.name,
      returnType: m.return_type || (builtin ? 'Variant' : 'void'),
      params: mapParams(m.arguments),
      qualifiers: qualifiersOf(m),
      description: m.description || ''
    })),
    signals: (c.signals || []).map((/** @type {any} */ s) => ({
      name: s.name,
      params: mapParams(s.arguments),
      description: s.description || ''
    })),
    constants: (c.constants || []).map((/** @type {any} */ k) => ({
      name: k.name,
      value: String(k.value),
      enum: k.enum || undefined,
      description: k.description || ''
    })),
    enums: (c.enums || []).map((/** @type {any} */ e) => ({
      name: e.name,
      bitfield: !!e.is_bitfield,
      values: (e.values || []).map((/** @type {any} */ v) => ({
        name: v.name,
        value: String(v.value),
        description: v.description || ''
      }))
    })),
    // 运算符只有 builtin 类有(Vector2 + 等);core 类恒为空
    operators: (c.operators || []).map((/** @type {any} */ op) => ({
      name: op.name || '',
      returnType: op.return_type || 'Variant',
      params: mapParams(op.arguments),
      description: op.description || ''
    }))
  }
}

/**
 * 把 extension_api.json 的 utility_functions/global_constants/global_enums 合成
 * @GlobalScope 伪类(GDScript 内置函数与全局常量在编辑器帮助里也挂在它名下)。
 * @param {Record<string, any>} api
 * @returns {DocClassDetail}
 */
function mapGlobalScope(api) {
  const enums = (api.global_enums || []).map((/** @type {any} */ e) => ({
    name: e.name,
    bitfield: !!e.is_bitfield,
    values: (e.values || []).map((/** @type {any} */ v) => ({
      name: v.name,
      value: String(v.value),
      description: v.description || ''
    }))
  }))
  // 全局常量里属于某个全局枚举的值已由上面收录,这里只留散装常量
  const inEnum = new Set(enums.flatMap((/** @type {any} */ e) => e.values.map((/** @type {any} */ v) => v.name)))
  const constants = (api.global_constants || [])
    .filter((/** @type {any} */ k) => !inEnum.has(k.name))
    .map((/** @type {any} */ k) => ({ name: k.name, value: String(k.value), description: '' }))
  return {
    name: '@GlobalScope',
    inherits: null,
    brief: '全局作用域:GDScript 内置函数、全局常量与全局枚举。',
    description: '收录 GDScript 直接可用的内置函数(如 clamp / lerp / randi)与全局常量、枚举。这些成员不属于任何类,在任意脚本中直接调用。',
    builtin: true,
    isSingleton: false,
    members: [],
    signals: [],
    methods: (api.utility_functions || []).map((/** @type {any} */ uf) => ({
      name: uf.name,
      returnType: uf.return_type || 'Variant',
      params: mapParams(uf.arguments),
      qualifiers: uf.is_vararg ? ['vararg'] : [],
      description: uf.description || ''
    })),
    constants,
    enums,
    operators: []
  }
}

/**
 * 从映射后的类构建全库索引条目(紧凑键名,控制 index.json 体积)。
 * @param {DocClassDetail} cls
 * @returns {DocClassSummary}
 */
function buildIndexEntry(cls) {
  return {
    name: cls.name,
    inherits: cls.inherits,
    brief: cls.brief,
    builtin: cls.builtin,
    isSingleton: cls.isSingleton,
    m: cls.methods.map((x) => x.name),
    p: cls.members.map((x) => x.name),
    s: cls.signals.map((x) => x.name),
    c: cls.constants.map((x) => x.name).concat(cls.enums.flatMap((e) => e.values.map((v) => v.name))),
    e: cls.enums.map((x) => x.name)
  }
}

// ---------- 搜索打分(纯函数,可独立测试) ----------

/**
 * 单词命中打分:精确 > 前缀 > 包含;不命中返回 0。
 * @param {string} word 原词
 * @param {string} q 已转小写的查询
 * @returns {number}
 */
function wordScore(word, q) {
  const w = String(word || '').toLowerCase()
  if (!w) return 0
  if (w === q) return 3
  if (w.startsWith(q)) return 2
  if (w.includes(q)) return 1
  return 0
}

// 类名分值权重高于成员名:搜 "node" 时 Node 类要排在所有含 node 的成员前
const SCORE_CLASS = 100
const SCORE_MEMBER = 30

/**
 * 在索引上执行搜索,返回按分值排序的命中(纯函数)。
 * @param {DocClassSummary[]} index
 * @param {string} query
 * @param {number} [limit]
 * @returns {DocSearchHit[]}
 */
function searchIndex(index, query, limit = 30) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  /** @type {DocSearchHit[]} */
  const hits = []
  for (const entry of index) {
    const clsScore = wordScore(entry.name, q)
    if (clsScore) {
      hits.push({ kind: 'class', className: entry.name, name: entry.name, brief: entry.brief, score: SCORE_CLASS + clsScore })
    }
    let memberBudget = SEARCH_PER_CLASS_CAP
    /** @param {DocHitKind} kind @param {string} name */
    const pushMember = (kind, name) => {
      const s = wordScore(name, q)
      if (!s || memberBudget <= 0) return
      memberBudget--
      hits.push({ kind, className: entry.name, name, brief: entry.brief, score: SCORE_MEMBER + s })
    }
    for (const n of entry.m) pushMember('method', n)
    for (const n of entry.p) pushMember('member', n)
    for (const n of entry.s) pushMember('signal', n)
    for (const n of entry.e) pushMember('enum', n)
    for (const n of entry.c) pushMember('constant', n)
  }
  hits.sort((a, b) => b.score - a.score || a.className.localeCompare(b.className) || a.name.localeCompare(b.name))
  if (limit > 0) return hits.slice(0, limit)
  return hits
}

module.exports = {
  qualifiersOf,
  mapParams,
  mapClass,
  mapGlobalScope,
  buildIndexEntry,
  wordScore,
  searchIndex
}
