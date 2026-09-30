// 桌面版 JSON 文档存储:对齐 ZTools 宿主 db 的 CouchDB 风格语义。
// 契约依据 lib/store.js 注释与 __tests__/favorites.test.js 的内存桩:
//   get(id)         → 文档副本;不存在返回 null
//   put(doc)        → 成功 { ok, id, rev };失败 { error: true, name, message }(常见 name: 'conflict')
//   remove(doc)     → 按传入 doc 的 _id/_rev 删除,返回同 put
//   allDocs(prefix) → 按 _id 前缀过滤、按 _id 排序的数组
// 全部同步。更新必须携带与现库一致的 _rev,否则 conflict(新建不允许带 _rev)。
//
// 持久化:单 JSON 文件写穿(临时文件 + 原子改名,与 backup.js 同款手法);
// 每次成功写入前把旧文件轮转为 .bak;启动时主文件损坏先回滚 .bak,
// 两者都坏则空库起步,并把原文件留作 .corrupt 供人工找回。

const fs = require('node:fs')
const path = require('node:path')

const REV_PREFIX = 'rev-'

const bakPath = (file) => `${file}.bak`
const corruptPath = (file) => `${file}.corrupt`
const tmpPath = (file) => `${file}.tmp`

function readMaybe(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    return null
  }
}

/** 解析并校验存储格式;任何不合规返回 null(调用方走损坏回滚) */
function parseState(raw) {
  try {
    const p = JSON.parse(raw)
    if (!p || typeof p !== 'object' || !p.docs || typeof p.docs !== 'object' || typeof p.seq !== 'number') return null
    const docs = new Map()
    for (const [id, doc] of Object.entries(p.docs)) {
      if (doc && typeof doc === 'object' && typeof doc._id === 'string') docs.set(id, doc)
    }
    return { docs, seq: p.seq }
  } catch (e) {
    return null
  }
}

/**
 * 创建一个基于单 JSON 文件的文档库。
 * @param {string} filePath 库文件绝对路径(所在目录不存在会自动创建)
 */
function createDb(filePath) {
  const clone = (v) => JSON.parse(JSON.stringify(v))

  function persist() {
    try {
      if (fs.existsSync(filePath)) fs.copyFileSync(filePath, bakPath(filePath))
    } catch (e) {
      // 轮转失败不阻断写入:主文件仍在,下次写入再试
    }
    fs.writeFileSync(tmpPath(filePath), JSON.stringify({ seq: state.seq, docs: Object.fromEntries(state.docs) }))
    fs.renameSync(tmpPath(filePath), filePath)
  }

  function load() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const raw = readMaybe(filePath)
    if (raw !== null) {
      const parsed = parseState(raw)
      if (parsed) return parsed
      // 主文件损坏:留档 .corrupt,尝试 .bak 回滚
      try { fs.copyFileSync(filePath, corruptPath(filePath)) } catch (e) { /* 留档失败不阻断启动 */ }
      const bak = readMaybe(bakPath(filePath))
      if (bak !== null) {
        const parsedBak = parseState(bak)
        if (parsedBak) return parsedBak
      }
      return { docs: new Map(), seq: 0 }
    }
    const bak = readMaybe(bakPath(filePath))
    if (bak !== null) {
      const parsedBak = parseState(bak)
      if (parsedBak) return parsedBak
    }
    return { docs: new Map(), seq: 0 }
  }

  const state = load()

  return {
    /** @returns {any} 文档副本;不存在返回 null */
    get(id) {
      const doc = state.docs.get(id)
      return doc ? clone(doc) : null
    },

    /**
     * CouchDB 风格写入:更新需 _rev 匹配,新建不得带 _rev。
     * @param {{_id: string, _rev?: string}} doc
     */
    put(doc) {
      if (!doc || typeof doc !== 'object' || typeof doc._id !== 'string' || !doc._id) {
        return { error: true, name: 'bad_request', message: 'put 需要 string 类型的 _id' }
      }
      const existing = state.docs.get(doc._id)
      if (existing ? doc._rev !== existing._rev : !!doc._rev) {
        return { error: true, name: 'conflict', message: 'Document update conflict' }
      }
      const rev = REV_PREFIX + (++state.seq)
      state.docs.set(doc._id, { ...clone(doc), _id: doc._id, _rev: rev })
      persist()
      return { ok: true, id: doc._id, rev }
    },

    /** @param {{_id: string, _rev?: string}} doc */
    remove(doc) {
      const existing = doc ? state.docs.get(doc._id) : null
      if (!existing) return { error: true, name: 'not_found', message: 'missing' }
      if (doc._rev !== existing._rev) return { error: true, name: 'conflict', message: 'Document update conflict' }
      state.docs.delete(doc._id)
      persist()
      return { ok: true, id: doc._id, rev: existing._rev }
    },

    /** @param {string} prefix 按 _id 前缀列出,按 _id 排序 */
    allDocs(prefix) {
      const out = []
      for (const id of [...state.docs.keys()].sort()) {
        if (!prefix || id.startsWith(prefix)) out.push(clone(state.docs.get(id)))
      }
      return out
    }
  }
}

module.exports = { createDb }
