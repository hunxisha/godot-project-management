// 跨版本差异对比:库级汇总与类级成员明细,全部基于已生成的库,零网络。
// 从 docs.js 拆出(2026-09-29);docsDiffClass 组合门面的 docsGetClass,留在门面。
const { getDoc } = require('./store')
const { DB_ID } = require('./docpaths')
const { loadIndex } = require('./docbuild')

/** @typedef {import('../../../src/types/godot').DocClassDetail} DocClassDetail */

// ---------- 跨版本差异对比 ----------
//
// 升级引擎前最想知道「哪些 API 变了」。库级给汇总(新增/移除/有变化的类),
// 类级给成员明细(新增/移除/签名变化)。全部基于已生成的库,零网络。

/**
 * 方法/信号的签名串(参与变化判定):name(参数类型, ...) -> 返回类型。
 * 只比类型不比参数名 —— 官方改参数名不算破坏性变更。
 * @param {any} m
 */
function methodSignature(m) {
  const args = (m.params || []).map((/** @type {any} */ p) => p.type).join(',')
  return `${m.name}(${args}) -> ${m.returnType}`
}

/**
 * 对比两组条目,产出 新增/移除/变化(纯函数)。
 * @param {any[]} aItems
 * @param {any[]} bItems
 * @param {(x: any) => string} keyOf 身份键(同名重载用 name+arity)
 * @param {(x: any) => string} sigOf 签名(变化判定)
 * @returns {{added: string[], removed: string[], changed: {name: string, from: string, to: string}[]}}
 */
function diffGroup(aItems, bItems, keyOf, sigOf) {
  const aMap = new Map(aItems.map((x) => [keyOf(x), x]))
  const bMap = new Map(bItems.map((x) => [keyOf(x), x]))
  /** @type {string[]} */
  const added = []
  /** @type {string[]} */
  const removed = []
  /** @type {{name: string, from: string, to: string}[]} */
  const changed = []
  for (const [k, b] of bMap) {
    if (!aMap.has(k)) added.push(b.name)
  }
  for (const [k, a] of aMap) {
    if (!bMap.has(k)) { removed.push(a.name); continue }
    const from = sigOf(a)
    const to = sigOf(/** @type {any} */ (bMap.get(k)))
    if (from !== to) changed.push({ name: a.name, from, to })
  }
  return { added, removed, changed }
}

/** 方法/信号的身份键:同名重载按参数个数区分 */
function overloadKey(/** @type {any} */ x) {
  return `${x.name}/${(x.params || []).length}`
}

/** 成员的签名:类型 + 读写性 */
function memberSignature(/** @type {any} */ m) {
  return `${m.type}${m.setter ? '' : ' readonly'}`
}

/**
 * 单类的成员级差异。
 * @param {DocClassDetail} a
 * @param {DocClassDetail} b
 * @returns {{className: string, inherits: {from: string|null, to: string|null} | null,
 *            methods: any, members: any, signals: any, constants: any, enums: any}}
 */
function diffClassDetail(a, b) {
  return {
    className: b.name,
    inherits: a.inherits === b.inherits ? null : { from: a.inherits, to: b.inherits },
    methods: diffGroup(a.methods, b.methods, overloadKey, methodSignature),
    members: diffGroup(a.members, b.members, (x) => x.name, memberSignature),
    signals: diffGroup(a.signals, b.signals, overloadKey, (x) => methodSignature(x)),
    constants: diffGroup(a.constants, b.constants, (x) => x.name, (x) => String(x.value)),
    enums: diffGroup(a.enums, b.enums, (x) => x.name, (x) => (x.values || []).map((/** @type {any} */ v) => `${v.name}=${v.value}`).join(','))
  }
}

/**
 * 库级差异汇总:新增/移除/有变化的类。
 * @param {string} versionA 旧库
 * @param {string} versionB 新库
 * @returns {{ok: boolean, error?: string, tagA?: string, tagB?: string,
 *            addedClasses?: string[], removedClasses?: string[],
 *            changedClasses?: {name: string, changes: number}[]}}
 */
function docsDiffLibraries(versionA, versionB) {
  const idxA = loadIndex(versionA)
  const idxB = loadIndex(versionB)
  if (!idxA || !idxB) return { ok: false, error: '两个版本都需要已生成的文档库' }
  const recA = getDoc(DB_ID(versionA)) || {}
  const recB = getDoc(DB_ID(versionB)) || {}
  const mapA = new Map(idxA.map((c) => [c.name, c]))
  const mapB = new Map(idxB.map((c) => [c.name, c]))
  /** @type {string[]} */
  const addedClasses = []
  /** @type {string[]} */
  const removedClasses = []
  /** @type {{name: string, changes: number}[]} */
  const changedClasses = []
  for (const name of mapB.keys()) if (!mapA.has(name)) addedClasses.push(name)
  for (const name of mapA.keys()) if (!mapB.has(name)) removedClasses.push(name)
  // 同名类:用索引里的名单粗筛(正文级明细在 docsDiffClass 里按需给)
  for (const [name, a] of mapA) {
    const b = mapB.get(name)
    if (!b) continue
    let changes = 0
    changes += Math.abs(a.m.length - b.m.length)
    const setA = new Set([...a.m, ...a.p, ...a.s, ...a.c, ...a.e])
    const setB = new Set([...b.m, ...b.p, ...b.s, ...b.c, ...b.e])
    for (const x of setA) if (!setB.has(x)) changes++
    for (const x of setB) if (!setA.has(x)) changes++
    if (changes > 0) changedClasses.push({ name, changes })
  }
  const collator = new Intl.Collator('en')
  addedClasses.sort(collator.compare)
  removedClasses.sort(collator.compare)
  changedClasses.sort((x, y) => y.changes - x.changes || collator.compare(x.name, y.name))
  return {
    ok: true,
    tagA: recA.tag,
    tagB: recB.tag,
    addedClasses,
    removedClasses,
    changedClasses
  }
}

module.exports = { methodSignature, diffGroup, overloadKey, memberSignature, diffClassDetail, docsDiffLibraries }
