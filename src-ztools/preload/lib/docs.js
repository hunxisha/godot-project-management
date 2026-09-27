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
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')
const { ensureDir, dirSize } = require('./extract')
const { createTaskQueue, TERMINAL_PHASES } = require('./taskqueue')
const { CanceledError, createCancelToken, checkCancel, forEachSliced, rmQuiet } = require('./fsutil')
const { getText } = require('./http')

/** @typedef {import('../../../src/types/godot').DocClassDetail} DocClassDetail */
/** @typedef {import('../../../src/types/godot').DocClassSummary} DocClassSummary */
/** @typedef {import('../../../src/types/godot').DocSearchHit} DocSearchHit */
/** @typedef {import('../../../src/types/godot').DocHitKind} DocHitKind */
/** @typedef {import('../../../src/types/godot').DocLibraryStatus} DocLibraryStatus */
/** @typedef {import('../../../src/types/godot').DocHistoryItem} DocHistoryItem */
/** @typedef {import('../../../src/types/godot').DocsCacheInfo} DocsCacheInfo */

const tasks = createTaskQueue({
  serial: true,
  makeId: () => `docs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  // phaseField 指向 status(与 ExportTask 同名同义),终态集合启用「仅终态可 dismiss」
  terminalPhases: TERMINAL_PHASES,
  phaseField: 'status'
})

/** 引擎 dump 的超时上限(实测 ~1s,留足余量) */
const DUMP_TIMEOUT_MS = 90_000
/** parsing 阶段任务进度的上报步长(每次 patch 都会广播快照,避免千次刷屏) */
const PROGRESS_STEP = 25
/** 最近浏览历史上限 */
const HISTORY_MAX = 30
/** 搜索单个类的成员命中上限,避免 Node 这类大类刷屏挤掉其他类的结果 */
const SEARCH_PER_CLASS_CAP = 8
/** 类名合法性:仅字母数字下划线与 @ 伪类前缀;同时阻断路径穿越 */
const CLASS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$|^@[A-Za-z]+$/

// ---------- 路径 ----------

const VERSION_PREFIX = 'godot/version/'

/**
 * 版本标识归一化:全插件的约定是 versionId = 完整 db 文档 id(godot/version/<tag>-<变体>-<平台>,
 * 见 install.js 的 version.id),但也接受裸键。返回 docId(查文档用)与 key(路径/db 落盘用的
 * 安全裸键 —— 完整 id 里的斜杠不能进文件路径)。
 * @param {string} versionId
 * @returns {{docId: string, key: string}}
 */
function versionKey(versionId) {
  const input = String(versionId || '').trim()
  const docId = input.startsWith(VERSION_PREFIX) ? input : VERSION_PREFIX + input
  const key = docId.slice(VERSION_PREFIX.length).replace(/[^A-Za-z0-9._-]/g, '_')
  return { docId, key }
}

/**
 * 文档库根目录:优先设置里的引擎安装根;未设置(用户只导入过本地引擎)时退回家目录。
 * @param {string} [versionId]
 */
function docsRoot(versionId) {
  const settings = getDoc('godot/settings') || {}
  const base = settings.versionsRoot || path.join(os.homedir(), '.gpm-docs')
  if (!versionId) return path.join(base, 'gpm-docs')
  return path.join(base, 'gpm-docs', versionKey(versionId).key)
}

/**
 * @param {string} versionId
 */
function libClassesDir(versionId) {
  return path.join(docsRoot(versionId), 'classes')
}

/**
 * @param {string} versionId
 */
function libIndexPath(versionId) {
  return path.join(docsRoot(versionId), 'index.json')
}

/**
 * @param {string} versionId
 */
const DB_ID = (versionId) => `godot/docs/${versionKey(versionId).key}`
const FAVORITES_ID = 'godot/docs/favorites'
const HISTORY_ID = 'godot/docs/history'

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

// ---------- 索引缓存(渲染层搜索/列表的读路径) ----------

/** @type {Map<string, { index: DocClassSummary[], at: number }>} */
const indexCache = new Map()

/**
 * 读取版本库索引(mtime 变化时自动重读)。
 * @param {string} versionId
 * @returns {DocClassSummary[] | null}
 */
function loadIndex(versionId) {
  const hit = indexCache.get(versionId)
  const indexFile = libIndexPath(versionId)
  try {
    const mtime = fs.statSync(indexFile).mtimeMs
    if (hit && hit.at === mtime) return hit.index
    const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    indexCache.set(versionId, { index: parsed.classes, at: mtime })
    return parsed.classes
  } catch (e) {
    indexCache.delete(versionId)
    return null
  }
}

// ---------- 中文类参考翻译 ----------
//
// 官方中文翻译在 godot 仓库的 doc/translations/zh_Hans.po(与编辑器内置中文帮助同源),
// msgid 就是类文档英文原文 —— 实测(4.7.2)与 --dump-extension-api-with-docs 的描述字符串
// 逐字符一致,brief 1018/1018、description 1009/1009 精确命中。因此「按原文查表替换」即可,
// 无需任何对齐算法;未命中的条目(未翻译/新版本新增)保持英文。

const TRANSLATION_LOCALE = 'zh_Hans'
/** 翻译下载超时:9-10MB 的 po,慢网络下给足余量 */
const TRANSLATION_TIMEOUT_MS = 60_000
/** 单个类 XML 的下载超时(约 20-100KB,快) */
const EXTRAS_TIMEOUT_MS = 20_000
/** 单个类 XML 的下载超时(约 20-100KB,快) */

/**
 * @param {string} s po 单段转义还原
 * @returns {string}
 */
function unescapePo(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i]
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '"' ? '"' : n === '\\' ? '\\' : n
    } else out += c
  }
  return out
}

/**
 * 解析 .po 为 msgid→msgstr 表。
 * 跳过:头部(msgid 为空)、fuzzy(未复核)、msgctxt(避免同文异译误替换)、复数形式、空 msgstr(未翻译)。
 * @param {string} text
 * @returns {{map: Map<string, string>, entries: number, untranslated: number, skipped: number}}
 */
function parsePo(text) {
  const map = new Map()
  let entries = 0, untranslated = 0, skipped = 0
  const lines = String(text || '').split(/\r?\n/)
  /** @type {{msgid: string, msgstr: string} | null} */
  let cur = null
  let field = null
  // #, fuzzy / msgctxt 出现在条目**之前**,属于下一个 msgid —— 不能在 flush 时才消费,
  // 否则会错标到上一条(fuzzy 误杀上一条、msgctxt 条目反而混进表,实测踩过)。
  let pendingFuzzy = false
  let pendingCtx = false
  let fuzzyFlag = false
  let hasCtx = false
  const flush = () => {
    if (cur && cur.msgid) {
      entries++
      if (!cur.msgstr) untranslated++
      else if (fuzzyFlag || hasCtx) skipped++
      else map.set(cur.msgid, cur.msgstr)
    }
    cur = null
    field = null
  }
  for (const line of lines) {
    if (line.startsWith('#,') && line.includes('fuzzy')) { pendingFuzzy = true; continue }
    if (line.startsWith('#')) continue
    if (line.startsWith('msgctxt ')) { pendingCtx = true; field = null; continue }
    if (line.startsWith('msgid_plural') || line.startsWith('msgstr[')) { field = 'plural'; continue }
    if (line.startsWith('msgid ')) {
      flush()
      cur = { msgid: '', msgstr: '' }
      field = 'msgid'
      fuzzyFlag = pendingFuzzy
      hasCtx = pendingCtx
      pendingFuzzy = false
      pendingCtx = false
    } else if (line.startsWith('msgstr ')) field = 'msgstr'
    // 关键字行(msgid "…")与续行("…")都要提取引号内容
    const body = line.replace(/^(msgid|msgstr)\s+/, '')
    const m = /^"(.*)"\s*$/.exec(body)
    if (!m || !cur) continue
    if (field === 'msgid') cur.msgid += unescapePo(m[1])
    else if (field === 'msgstr') cur.msgstr += unescapePo(m[1])
  }
  flush()
  return { map, entries, untranslated, skipped }
}

/**
 * 翻译来源的 ref 回退链:完整 tag(4.7.2-stable)→ 小版本分支(4.7)→ master。
 * dev/预发布版本没有对应 tag,回退到分支或 master 的翻译(按原文查表,多几条少几条不影响正确性)。
 * @param {string} tag
 * @returns {string[]}
 */
function translationRefs(tag) {
  const refs = []
  if (tag) refs.push(tag)
  const m = /^(\d+\.\d+)/.exec(tag || '')
  if (m && !refs.includes(m[1])) refs.push(m[1])
  if (!refs.includes('master')) refs.push('master')
  return refs
}

/**
 * 下载(带磁盘缓存)并解析中文翻译表;全部来源失败返回 null,生成降级为英文。
 * @param {string} tag
 * @param {{canceled: boolean}} token
 * @returns {Promise<Map<string, string> | null>}
 */
async function loadZhTranslations(tag, token, force = false) {
  const cacheDir = path.join(docsRoot(), 'po-cache')
  // 强刷翻译:清掉整个 po 缓存,重新走下载(官方翻译随上游更新)
  if (force) rmQuiet(cacheDir)
  for (const ref of translationRefs(tag)) {
    const cached = path.join(cacheDir, `${TRANSLATION_LOCALE}-${ref}.po`)
    try {
      let text = ''
      if (fs.existsSync(cached)) {
        text = fs.readFileSync(cached, 'utf8')
      } else {
        checkCancel(token)
        text = await Promise.race([
          getText(`https://raw.githubusercontent.com/godotengine/godot/${ref}/doc/translations/${TRANSLATION_LOCALE}.po`),
          /** @type {Promise<never>} */ (new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('翻译下载超时')), TRANSLATION_TIMEOUT_MS)
          }))
        ])
        if (!text || !text.includes('msgid')) throw new Error('翻译内容异常')
        checkCancel(token)
        ensureDir(cacheDir)
        const tmp = `${cached}.tmp`
        fs.writeFileSync(tmp, text)
        fs.renameSync(tmp, cached)
      }
      const { map } = parsePo(text)
      if (map.size) return map
    } catch (e) {
      // 该 ref 不可用(404/网络/超时):试下一个,全失败则降级英文
    }
  }
  return null
}

/**
 * 应用翻译:命中 msgid 的描述字段替换为中文,其余保持英文原样。
 * 同时统计「可翻译字符串总数」(hits.total)与「实际命中数」(hits.count),
 * 供 db 记录翻译覆盖率 —— 未命中是官方翻译缺失,不是插件丢失内容。
 * @param {DocClassDetail} cls
 * @param {Map<string, string>} tr
 * @param {{count: number, total: number}} hits 计数器
 * @returns {DocClassDetail}
 */
function applyTranslations(cls, tr, hits) {
  const t = (/** @type {string} */ s) => {
    if (s) {
      hits.total++
      const z = tr.get(s)
      if (z !== undefined) { hits.count++; return z }
    }
    return s
  }
  return {
    ...cls,
    brief: t(cls.brief),
    description: t(cls.description),
    members: cls.members.map((x) => ({ ...x, description: t(x.description) })),
    methods: cls.methods.map((x) => ({ ...x, description: t(x.description) })),
    signals: cls.signals.map((x) => ({ ...x, description: t(x.description) })),
    constants: cls.constants.map((x) => ({ ...x, description: t(x.description) })),
    enums: cls.enums.map((e) => ({ ...e, values: e.values.map((v) => ({ ...v, description: t(v.description) })) })),
    operators: cls.operators.map((x) => ({ ...x, description: t(x.description) }))
  }
}

// ---------- 类的附加信息(教程链接,按需从 GitHub XML 补) ----------
//
// 为什么按需:教程链接只在 godot 仓库的 doc/classes/*.xml 里(引擎的
// --dump-extension-api-with-docs 与 --doctool 都不含);全量拉 1000+ 个 XML 会拖慢生成,
// 因此改为「打开某个类时才拉那一个 XML」,解析后缓存到库目录 extras/ 下,一次付出长期有效。
// 注:Godot 4 的 XML 已不再包含 theme_items,主题属性无从获取,不做。

/** $DOCS_URL 占位符 → 官方文档站的实际前缀 */
function docsUrlBase(/** @type {string} */ tag) {
  const m = /^(\d+\.\d+)/.exec(String(tag || ''))
  return `https://docs.godotengine.org/en/${m ? m[1] : 'stable'}/`
}

/**
 * 从类 XML 解析教程链接(纯函数)。
 * @param {string} xml
 * @param {string} tag
 * @returns {{title: string, url: string}[]}
 */
function parseTutorials(xml, tag) {
  const block = /<tutorials>([\s\S]*?)<\/tutorials>/.exec(String(xml || ''))
  if (!block) return []
  const base = docsUrlBase(tag)
  /** @type {{title: string, url: string}[]} */
  const out = []
  const re = /<link\s+title="([^"]*)"\s*>([^<]*)<\/link>/g
  let m
  while ((m = re.exec(block[1])) !== null) {
    const raw = m[2].trim()
    // $DOCS_URL 是官方占位符(以 $DOCS_URL/tutorials/... 形式出现,自带分隔斜杠);
    // 其余(如 GitHub demo 链接)原样保留
    out.push({ title: m[1], url: raw.startsWith('$DOCS_URL') ? base + raw.slice('$DOCS_URL/'.length) : raw })
  }
  return out
}

/**
 * 读取类的附加信息(教程链接)。缓存命中直接返回;未命中按需下载 XML 并落缓存。
 * 网络失败返回 null —— 离线时详情页只是没有教程分节,不影响浏览。
 * @param {string} versionId
 * @param {string} className
 * @returns {Promise<{tutorials: {title: string, url: string}[], fetchedAt: number} | null>}
 */
async function docsGetClassExtras(versionId, className) {
  if (!CLASS_NAME_RE.test(String(className || ''))) return null
  const cacheFile = path.join(docsRoot(versionId), 'extras', `${className}.json`)
  try {
    if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  } catch (e) { /* 缓存损坏:走重新下载 */ }
  const record = getDoc(DB_ID(versionId))
  const tag = record && record.tag
  if (!tag) return null
  for (const ref of translationRefs(tag)) {
    try {
      const xml = await Promise.race([
        getText(`https://raw.githubusercontent.com/godotengine/godot/${ref}/doc/classes/${className}.xml`),
        /** @type {Promise<never>} */ (new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('超时')), EXTRAS_TIMEOUT_MS)
        }))
      ])
      if (!xml || !xml.includes('<class')) throw new Error('内容异常')
      const extras = { tutorials: parseTutorials(xml, tag), fetchedAt: Date.now(), ref }
      ensureDir(path.dirname(cacheFile))
      const tmp = `${cacheFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(extras))
      fs.renameSync(tmp, cacheFile)
      return extras
    } catch (e) {
      // 该 ref 没有这个文件(新类在旧分支上不存在):试下一个
    }
  }
  return null
}

// ---------- 类的附加信息(教程链接,按需从 GitHub XML 补) ----------
//
// 为什么按需:教程链接只在 godot 仓库的 doc/classes/*.xml 里(引擎的
// --dump-extension-api-with-docs 与 --doctool 都不含,实测确认);全量拉 1000+ 个 XML
// 会拖慢生成,因此改为「打开某个类时才拉那一个 XML」,解析后缓存到库目录 extras/ 下。
// 注:Godot 4 的 XML 已不再包含 theme_items,主题属性无从获取,不做。

/** $DOCS_URL 占位符 → 官方文档站的实际前缀 */
function docsUrlBase(/** @type {string} */ tag) {
  const m = /^(\d+\.\d+)/.exec(String(tag || ''))
  return `https://docs.godotengine.org/en/${m ? m[1] : 'stable'}/`
}

/**
 * 从类 XML 解析教程链接(纯函数)。
 * @param {string} xml
 * @param {string} tag
 * @returns {{title: string, url: string}[]}
 */
function parseTutorials(xml, tag) {
  const block = /<tutorials>([\s\S]*?)<\/tutorials>/.exec(String(xml || ''))
  if (!block) return []
  const base = docsUrlBase(tag)
  /** @type {{title: string, url: string}[]} */
  const out = []
  const re = /<link\s+title="([^"]*)"\s*>([^<]*)<\/link>/g
  let m
  while ((m = re.exec(block[1])) !== null) {
    const raw = m[2].trim()
    // $DOCS_URL 是官方占位符(自带分隔斜杠);其余(如 GitHub demo 链接)原样保留
    out.push({ title: m[1], url: raw.startsWith('$DOCS_URL') ? base + raw.slice('$DOCS_URL/'.length) : raw })
  }
  return out
}

/**
 * 读取类的附加信息(教程链接)。缓存命中直接返回;未命中按需下载 XML 并落缓存。
 * 网络失败返回 null —— 离线时详情页只是没有教程分节,不影响浏览。
 * @param {string} versionId
 * @param {string} className
 * @returns {Promise<{tutorials: {title: string, url: string}[], fetchedAt?: number, ref?: string} | null>}
 */
async function docsGetClassExtras(versionId, className) {
  if (!CLASS_NAME_RE.test(String(className || ''))) return null
  const cacheFile = path.join(docsRoot(versionId), 'extras', `${className}.json`)
  try {
    if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  } catch (e) { /* 缓存损坏:走重新下载 */ }
  const record = getDoc(DB_ID(versionId))
  const tag = record && record.tag
  if (!tag) return null
  for (const ref of translationRefs(tag)) {
    try {
      const xml = await Promise.race([
        getText(`https://raw.githubusercontent.com/godotengine/godot/${ref}/doc/classes/${className}.xml`),
        /** @type {Promise<never>} */ (new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('超时')), EXTRAS_TIMEOUT_MS)
        }))
      ])
      if (!xml || !xml.includes('<class')) throw new Error('内容异常')
      const extras = { tutorials: parseTutorials(xml, tag), fetchedAt: Date.now(), ref }
      ensureDir(path.dirname(cacheFile))
      const tmp = `${cacheFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(extras))
      fs.renameSync(tmp, cacheFile)
      return extras
    } catch (e) {
      // 该 ref 没有这个文件(新类在旧分支上不存在):试下一个
    }
  }
  return null
}

// ---------- 生成流水线 ----------

/**
 * 更新任务字段(任务已被移除时静默跳过)。
 * @param {string} id
 * @param {Record<string, any>} patch
 */
function setTask(id, patch) {
  tasks.patch(tasks.get(id), patch)
}

/**
 * 从已解析的 extension_api 对象建库并落盘(parsing 阶段),多个入口共用:
 * runGenerate(引擎现 dump)与 runImport(用户提供的 JSON 文件)。
 * @param {Record<string, any>} api
 * @param {{versionId: string, tag: string, name?: string, libDir: string, stageDir: string,
 *          tr: Map<string, string> | null, token: {canceled: boolean}, taskId: string}} ctx
 * @returns {Promise<number>} 收录的类数
 */
async function buildLibrary(api, ctx) {
  const zhHits = { count: 0, total: 0 }
  /** @type {{name: string}[]} */
  const singletons = api.singletons || []
  const singletonNames = new Set(singletons.map((s) => s.name))
  /** @type {DocClassDetail[]} */
  const mapped = []
  for (const c of api.classes || []) {
    const cls = mapClass(c, { isSingleton: singletonNames.has(c.name) })
    mapped.push(ctx.tr ? applyTranslations(cls, ctx.tr, zhHits) : cls)
  }
  for (const c of api.builtin_classes || []) {
    const cls = mapClass(c, { builtin: true })
    mapped.push(ctx.tr ? applyTranslations(cls, ctx.tr, zhHits) : cls)
  }
  const gs = mapGlobalScope(api)
  mapped.push(ctx.tr ? applyTranslations(gs, ctx.tr, zhHits) : gs)
  return writeLibrary(mapped, ctx, zhHits)
}

/**
 * 把已映射好的类写入库目录并落 db 记录(原子接管),所有建库入口共用。
 * @param {DocClassDetail[]} mapped
 * @param {{versionId: string, tag: string, name?: string, libDir: string, stageDir: string,
 *          tr: Map<string, string> | null, token: {canceled: boolean}, taskId: string,
 *          kind?: string, sourceProject?: string}} ctx
 * @param {{count: number, total: number}} [zhHits]
 * @returns {Promise<number>} 收录的类数
 */
async function writeLibrary(mapped, ctx, zhHits) {
  const hits = zhHits || { count: 0, total: 0 }
  // 原子接管:先写进暂存目录,全部成功后一次性替换旧库 ——
  // 失败/取消只清暂存,旧库与 db 记录保持完好可浏览。
  const stageClasses = path.join(ctx.stageDir, 'classes')
  ensureDir(stageClasses)
  const total = mapped.length
  setTask(ctx.taskId, { total })
  let done = 0
  await forEachSliced(mapped, async (cls) => {
    checkCancel(ctx.token)
    fs.writeFileSync(path.join(stageClasses, `${cls.name}.json`), JSON.stringify(cls))
    done++
    if (done % PROGRESS_STEP === 0 || done === total) setTask(ctx.taskId, { done })
  })
  checkCancel(ctx.token)

  const index = {
    builtAt: Date.now(),
    engineTag: ctx.tag,
    classes: mapped.map(buildIndexEntry)
  }
  const tmpIndex = `${path.join(ctx.stageDir, 'index.json')}.tmp`
  fs.writeFileSync(tmpIndex, JSON.stringify(index))
  fs.renameSync(tmpIndex, path.join(ctx.stageDir, 'index.json'))

  rmQuiet(ctx.libDir)
  fs.renameSync(ctx.stageDir, ctx.libDir)

  putDoc(DB_ID(ctx.versionId), {
    versionId: ctx.versionId,
    tag: ctx.tag,
    name: ctx.name || ctx.tag,
    classCount: total,
    builtAt: index.builtAt,
    libDir: ctx.libDir,
    // 库语言:拿到翻译表(哪怕覆盖不全)即视为中文库;未命中条目保留英文
    lang: ctx.tr ? 'zh-CN' : 'en',
    translatedCount: ctx.tr ? zhHits.count : 0,
    // 可翻译字符串总数:translatedCount/stringCount 即翻译覆盖率
    stringCount: ctx.tr ? zhHits.total : 0,
    // kind: 'engine'(引擎 API) | 'project'(项目脚本扫描)
    kind: ctx.kind || 'engine',
    sourceProject: ctx.sourceProject
  })
  indexCache.delete(ctx.versionId)
  return total
}

/**
 * 用真实引擎生成文档库(dumping → parsing → done),内部使用。
 * @param {string} taskId
 */
async function runGenerate(taskId) {
  const task = tasks.get(taskId)
  if (!task) return
  // task.versionId 是完整 db 文档 id(与全插件约定一致),直接查
  const versionId = task.versionId
  const version = getDoc(versionId)
  if (!version || !version.exePath || !fs.existsSync(version.exePath)) {
    setTask(taskId, { status: 'error', error: '引擎可执行文件不存在' })
    return
  }
  const libDir = docsRoot(versionId)
  const workDir = path.join(docsRoot(), `.work-${taskId}`)
  const token = createCancelToken()
  try {
    // 中文翻译与引擎导出并行启动:dump ~1s,翻译下载(9-10MB)可能更慢,先发车
    // 失败/超时不影响生成 —— 降级英文;forceTranslation 时先清缓存再下载
    const zhPromise = loadZhTranslations(version.tag, token, !!task.forceTranslation).catch(/** @type {() => null} */ (() => null))
    ensureDir(workDir)
    // ---- dumping:spawn 引擎,产物为 cwd 下的 extension_api.json ----
    setTask(taskId, { status: 'dumping', log: '' })
    const jsonPath = path.join(workDir, 'extension_api.json')
    /** @type {string[]} 输出尾部环形缓冲 */
    const tail = []
    const child = spawn(version.exePath, ['--headless', '--dump-extension-api-with-docs'], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // 取消 = 标记令牌 + kill 子进程:只标记不 kill 的话,挂起的引擎永远不会触发 close,
    // 串行队列会被这个任务永久卡死(测试中实际踩到)。
    tasks.setToken(taskId, {
      cancel: () => {
        token.canceled = true
        try { child.kill() } catch (e) { /* ignore */ }
      }
    })
    /** @param {any} buf */
    const onChunk = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 20) tail.shift()
      }
      setTask(taskId, { log: tail.join('\n') })
    }
    if (child.stdout) child.stdout.on('data', onChunk)
    if (child.stderr) child.stderr.on('data', onChunk)
    const timer = setTimeout(() => {
      try { child.kill() } catch (e) { /* ignore */ }
    }, DUMP_TIMEOUT_MS)
    const closeCode = await new Promise((resolve) => {
      child.on('error', (e) => resolve(-1))
      child.on('close', (code) => resolve(code))
    })
    clearTimeout(timer)
    checkCancel(token)
    if (closeCode !== 0 || !fs.existsSync(jsonPath)) {
      throw new Error(`引擎导出失败(退出码 ${closeCode})${tail.length ? ': ' + tail[tail.length - 1] : ''}`)
    }

    // ---- parsing:映射 + 应用中文翻译 + 写入暂存目录,分片让出 ----
    // 首次生成要先下载 9-10MB 的翻译文件(慢网络可长达分钟级),单独一个阶段让用户看得到
    setTask(taskId, { status: 'translating' })
    checkCancel(token)
    const tr = await zhPromise
    setTask(taskId, { status: 'parsing', done: 0, total: 0 })
    const api = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    const total = await buildLibrary(api, {
      versionId,
      tag: version.tag,
      name: version.name,
      libDir,
      stageDir: path.join(workDir, 'staging'),
      tr,
      token,
      taskId
    })
    setTask(taskId, { status: 'done', done: total })
  } catch (e) {
    if (e instanceof CanceledError || token.canceled) {
      setTask(taskId, { status: 'canceled' })
    } else {
      setTask(taskId, { status: 'error', error: (e && e.message) || '生成失败' })
    }
    // 暂存目录随 finally 清理;旧库未被动过,无需其他回滚
  } finally {
    rmQuiet(workDir)
    tasks.clearToken(taskId)
  }
}

/**
 * 生成指定版本的文档库(入队,立即返回)。同版本在途时拒绝重复入队。
 * opts.forceTranslation=true 时忽略 po 磁盘缓存,重新下载官方翻译
 * (翻译随上游更新,重新生成时可强制刷新)。
 * @param {string} versionId
 * @param {{forceTranslation?: boolean}} [opts]
 * @returns {{ok: boolean, error?: string, taskId?: string}}
 */
function generateDocs(versionId, opts) {
  const { docId } = versionKey(versionId)
  const version = getDoc(docId)
  if (!version || !version.exePath) return { ok: false, error: '版本不存在或未绑定可执行文件' }
  if (!fs.existsSync(version.exePath)) return { ok: false, error: '引擎可执行文件不存在' }
  const key = versionKey(versionId).key
  const busy = tasks.list().find((/** @type {any} */ t) => versionKey(t.versionId).key === key && !tasks.isTerminal(t.status))
  if (busy) return { ok: false, error: '该版本的文档库正在生成中' }
  const task = tasks.create({
    kind: 'docs',
    versionId: docId,
    tag: version.tag,
    versionName: version.name,
    forceTranslation: !!(opts && opts.forceTranslation),
    status: 'queued',
    done: 0,
    total: 0,
    log: ''
  })
  const id = task.id
  tasks.emit()
  tasks.enqueue(() => runGenerate(id))
  return { ok: true, taskId: id }
}

// ---------- 导入 extension_api.json 建库(无引擎可用时的兜底) ----------
//
// 未装引擎也能用文档页:在任意机器跑一次
// `godot --headless --dump-extension-api-with-docs` 得到 JSON,导入即可建库。
// 与引擎生成共用 buildLibrary(映射/翻译/原子接管/落库完全一致)。

/**
 * 从外部 extension_api.json 导入建库(入队)。版本标识取 api.header.version_full_name,
 * 库条目落成 godot/version/import-<tag> 形式,保证「库-版本」关系可回溯。
 * @param {{jsonPath: string, tag?: string, name?: string}} opts
 * @returns {{ok: boolean, error?: string, taskId?: string, versionId?: string}}
 */
function importDocsLibrary(opts) {
  const jsonPath = opts && opts.jsonPath
  if (!jsonPath || !fs.existsSync(jsonPath)) return { ok: false, error: '文件不存在' }
  /** @type {Record<string, any>} */
  let api
  try {
    api = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  } catch (e) {
    return { ok: false, error: '不是合法的 JSON 文件' }
  }
  if (!api || (!Array.isArray(api.classes) && !Array.isArray(api.builtin_classes))) {
    return { ok: false, error: '不是 --dump-extension-api-with-docs 的输出(缺少 classes)' }
  }
  const header = api.header || {}
  const rawTag = opts.tag || header.version_full_name || header.version || ''
  const tag = String(rawTag || '').replace(/\.(official|mono)$/i, '').replace(/\./g, '-') || `imported-${Date.now()}`
  const docId = `${VERSION_PREFIX}import-${tag}`
  const key = versionKey(docId).key
  const busy = tasks.list().find((/** @type {any} */ t) => versionKey(t.versionId).key === key && !tasks.isTerminal(t.status))
  if (busy) return { ok: false, error: '该版本的文档库正在导入中' }
  const task = tasks.create({
    kind: 'docs',
    versionId: docId,
    tag,
    versionName: opts.name || `${tag}(导入)`,
    imported: true,
    status: 'queued',
    done: 0,
    total: 0,
    log: ''
  })
  const id = task.id
  tasks.emit()
  tasks.enqueue(() => runImport(id, api, tag))
  return { ok: true, taskId: id, versionId: docId }
}

/**
 * 导入建库流程(translating → parsing → done),与引擎生成同构。
 * @param {string} taskId
 * @param {Record<string, any>} api
 * @param {string} tag
 */
async function runImport(taskId, api, tag) {
  const task = tasks.get(taskId)
  if (!task) return
  const versionId = task.versionId
  const libDir = docsRoot(versionId)
  const workDir = path.join(docsRoot(), `.work-${taskId}`)
  const token = createCancelToken()
  try {
    ensureDir(workDir)
    const zhPromise = loadZhTranslations(tag, token, false).catch(/** @type {() => null} */ (() => null))
    setTask(taskId, { status: 'translating' })
    const tr = await zhPromise
    checkCancel(token)
    setTask(taskId, { status: 'parsing', done: 0, total: 0 })
    const total = await buildLibrary(api, {
      versionId,
      tag,
      name: task.versionName,
      libDir,
      stageDir: path.join(workDir, 'staging'),
      tr,
      token,
      taskId
    })
    setTask(taskId, { status: 'done', done: total })
  } catch (e) {
    if (e instanceof CanceledError || token.canceled) setTask(taskId, { status: 'canceled' })
    else setTask(taskId, { status: 'error', error: (e && e.message) || '导入失败' })
  } finally {
    rmQuiet(workDir)
    tasks.clearToken(taskId)
  }
}

// ---------- 任务三件套 ----------

/**
 * 取消生成任务(排队中直接取消;dumping 中 kill 子进程)。
 * @param {string} id
 */
function cancelDocsTask(id) {
  const t = tasks.get(id)
  if (!t) return
  if (tasks.isTerminal(t.status)) return
  const handle = tasks.tokenOf(id)
  if (handle) handle.cancel()
  setTask(id, { status: 'canceled' })
}

/**
 * 移除任务记录(仅终态可移除)。
 * @param {string} id
 */
function dismissDocsTask(id) {
  tasks.dismiss(id)
}

/**
 * 订阅任务快照,返回取消订阅函数。
 * @param {(t: any[]) => void} fn
 * @returns {() => void}
 */
function watchDocsTasks(fn) {
  return tasks.watch(fn)
}

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

// ---------- 项目脚本扫描(生成项目文档库) ----------
//
// 把项目里带 class_name 的 GDScript 解析成与引擎库同构的类文档,从而复用整套浏览 UI
// (列表/搜索/Ctrl+K/目录/继承树/复制/外开)。纯文本解析,不依赖引擎 —— 项目未绑定
// 引擎也能用。识别 Godot 4 的 ## 文档注释与 @param/@return 标签。

/**
 * 解析类型标注:`x: int = 5` → {name, type, defaultValue}。
 * @param {string} raw
 * @returns {{name: string, type: string, defaultValue?: string}}
 */
function parseGdParam(raw) {
  const s = raw.trim()
  if (!s) return { name: '', type: 'Variant' }
  const m = /^(\w+)\s*(?::\s*([\w\[\]\.]+))?\s*(?:=\s*(.+))?$/.exec(s)
  if (!m) return { name: s, type: 'Variant' }
  return { name: m[1], type: m[2] || 'Variant', defaultValue: m[3] }
}

/**
 * 解析 GDScript 源码为类文档(纯函数)。没有 class_name 时 className 为空,
 * 调用方决定是否收录(无 class_name 的脚本不能被引用,一般不收)。
 * @param {string} text 源码
 * @param {{fileName?: string, scriptPath?: string}} [opts]
 * @returns {DocClassDetail | null} 解析不出任何结构时返回 null
 */
function parseGdScript(text, opts = {}) {
  const lines = String(text || '').split(/\r?\n/)
  /** @type {string[]} 最近一段 ## 文档注释(遇空行/声明后清空) */
  let doc = []
  /** @type {string[]} 待归属的注解(@export/@onready 等) */
  let annotations = []
  let className = ''
  let inherits = null
  /** @type {DocClassDetail['methods']} */
  const methods = []
  /** @type {DocClassDetail['members']} */
  const members = []
  /** @type {DocClassDetail['signals']} */
  const signals = []
  /** @type {DocClassDetail['constants']} */
  const constants = []
  /** @type {DocClassDetail['enums']} */
  const enums = []
  let classDoc = ''
  let found = false

  /** 把文档块转成描述文本,@param/@return 标签单独成行附在后面 */
  const docToText = () => {
    const body = []
    const tags = []
    for (const line of doc) {
      const mt = /^@(param|return|tutorial|deprecated|experimental|since|see)\b\s*(.*)$/.exec(line)
      if (mt) tags.push(`@${mt[1]} ${mt[2]}`.trim())
      else body.push(line)
    }
    return [body.join('\n').trim(), tags.join('\n')].filter(Boolean).join('\n\n')
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '    ')
    let trimmed = line.trim()

    if (trimmed.startsWith('##')) { doc.push(trimmed.slice(2).trim()); continue }
    // 空行或普通注释:断开文档块与后续声明的归属(与 Godot 编辑器一致)
    if (!trimmed) { doc = []; annotations = []; continue }
    if (trimmed.startsWith('#')) continue
    // 注解行:既可能是纯注解(@export 单独一行,归属下一个声明),
    // 也可能注解后直接跟声明(@export var x)。后者要继续解析剩下的部分。
    if (trimmed.startsWith('@')) {
      const ann = /^@([\w_]+)(?:\([^)]*\))?\s*([\s\S]*)$/.exec(trimmed)
      if (ann) {
        annotations.push(ann[1])
        const rest = ann[2].trim()
        if (!rest) continue
        trimmed = rest
      }
    }
    // 类级成员必须顶格;函数体内的局部声明不收录
    const indent = line.length - line.trimStart().length
    if (indent > 0) { doc = []; annotations = []; continue }

    const desc = docToText()
    const takeDoc = () => { const d = desc; doc = []; annotations = []; return d }

    let m
    if ((m = /^class_name\s+(\w+)(?:\s*,\s*"[^"]*")?/.exec(trimmed))) {
      className = m[1]
      classDoc = takeDoc()
      found = true
      // `class_name X extends Y` 的同行 extends
      const ext = /\bextends\s+([\w\.]+)/.exec(trimmed)
      if (ext) inherits = ext[1]
      continue
    }
    if ((m = /^extends\s+([\w\.]+)/.exec(trimmed))) {
      inherits = m[1]
      if (!classDoc) classDoc = takeDoc()
      else { doc = []; annotations = [] }
      continue
    }
    if ((m = /^signal\s+(\w+)\s*(?:\(([^)]*)\))?/.exec(trimmed))) {
      const params = (m[2] || '').split(',').map((p) => p.trim()).filter(Boolean).map(parseGdParam)
      signals.push({ name: m[1], params, description: takeDoc() })
      found = true
      continue
    }
    if ((m = /^enum\s+(\w+)?\s*\{(.*)\}\s*$/.exec(trimmed))) {
      const name = m[1] || 'Values'
      const values = m[2].split(',').map((v) => v.trim()).filter(Boolean).map((v, i) => {
        const eq = /^(\w+)\s*=\s*(.+)$/.exec(v)
        return eq ? { name: eq[1], value: eq[2].trim(), description: '' } : { name: v, value: String(i), description: '' }
      })
      enums.push({ name, bitfield: false, values })
      if (takeDoc()) { /* 枚举整体描述暂不单列(与引擎库保持同构) */ }
      found = true
      continue
    }
    if ((m = /^const\s+(\w+)\s*(?::\s*([\w\[\]\.]+))?\s*(?::=|=)\s*(.+)$/.exec(trimmed))) {
      constants.push({ name: m[1], value: m[3].trim(), description: takeDoc() })
      found = true
      continue
    }
    if ((m = /^(?:static\s+)?func\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([\w\[\]\.]+))?\s*:/.exec(trimmed))) {
      const params = (m[2] || '').split(',').map((p) => p.trim()).filter(Boolean).map(parseGdParam)
      methods.push({
        name: m[1],
        returnType: m[3] || 'Variant',
        params,
        qualifiers: /^static\s/.test(trimmed) ? ['static'] : [],
        description: takeDoc()
      })
      found = true
      continue
    }
    // var x: int = 5 / var x := 5 / @export var x: float / var x(无初始值)
    if ((m = /^var\s+(\w+)\s*(?::\s*([\w\[\]\.]+))?\s*(?:(?::=|=)\s*(.+))?$/.exec(trimmed))) {
      members.push({
        name: m[1],
        type: m[2] || 'Variant',
        // @export/@onready 等注解体现在描述里(有几个就写几个),便于检索
        description: [annotations.length ? `注解:${annotations.map((a) => '@' + a).join(' ')}` : '', takeDoc()].filter(Boolean).join('\n\n'),
        defaultValue: m[3] ? m[3].trim() : undefined
      })
      found = true
      continue
    }
    // 其他语句(if/for/print 等):断开文档归属
    doc = []
    annotations = []
  }

  if (!found) return null
  return {
    name: className || (opts.fileName || 'Unnamed').replace(/\.gd$/i, ''),
    inherits,
    brief: classDoc.split('\n')[0] || '',
    description: classDoc,
    builtin: false,
    isSingleton: false,
    methods,
    members,
    signals,
    constants,
    enums,
    operators: [],
    // 项目类:标注来源脚本(详情页显示,便于回编辑器)
    sourceFile: opts.scriptPath
  }
}

/**
 * 递归收集目录下的 .gd 文件(跳过 .godot 缓存与隐藏目录)。
 * @param {string} dir
 * @param {number} [depth]
 * @returns {string[]}
 */
function collectGdFiles(dir, depth = 0) {
  /** @type {string[]} */
  const out = []
  if (depth > 12) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const e of entries) {
    const name = e.name
    if (name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (e.isDirectory()) out.push(...collectGdFiles(full, depth + 1))
    else if (/\.gd$/i.test(name)) out.push(full)
  }
  return out
}

/**
 * 扫描项目脚本生成项目文档库(入队)。只收录带 class_name 的脚本。
 * @param {{projectId: string}} opts
 * @returns {{ok: boolean, error?: string, taskId?: string, versionId?: string}}
 */
function scanProjectDocs(opts) {
  // 与 versionId 同一约定:接受完整 db 文档 id(godot/project/<id>)或裸 key
  const raw = String((opts && opts.projectId) || '')
  const projectDocId = raw.startsWith('godot/project/') ? raw : `godot/project/${raw}`
  const project = getDoc(projectDocId)
  if (!project || !project.path) return { ok: false, error: '项目不存在' }
  if (!fs.existsSync(project.path)) return { ok: false, error: '项目目录不存在' }
  const docId = `${VERSION_PREFIX}project-${projectDocId.slice('godot/project/'.length)}`
  const key = versionKey(docId).key
  const busy = tasks.list().find((/** @type {any} */ t) => versionKey(t.versionId).key === key && !tasks.isTerminal(t.status))
  if (busy) return { ok: false, error: '该项目脚本正在扫描中' }
  const task = tasks.create({
    kind: 'docs',
    versionId: docId,
    tag: project.name || '项目',
    versionName: (project.name || '项目') + ' 脚本',
    projectScan: true,
    status: 'queued',
    done: 0,
    total: 0,
    log: ''
  })
  const id = task.id
  tasks.emit()
  tasks.enqueue(() => runScanProject(id, project))
  return { ok: true, taskId: id, versionId: docId }
}

/**
 * 扫描流程(scanning → done):读 .gd → 解析 → 入库。
 * @param {string} taskId
 * @param {any} project
 */
async function runScanProject(taskId, project) {
  const task = tasks.get(taskId)
  if (!task) return
  const versionId = task.versionId
  const libDir = docsRoot(versionId)
  const workDir = path.join(docsRoot(), `.work-${taskId}`)
  const token = createCancelToken()
  try {
    setTask(taskId, { status: 'parsing' })
    const files = collectGdFiles(project.path)
    /** @type {DocClassDetail[]} */
    const mapped = []
    let skipped = 0
    await forEachSliced(files, async (file) => {
      checkCancel(token)
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch (e) {
        return
      }
      // 没有 class_name 的脚本不构成可引用的类,跳过(计数上报)
      if (!/^\s*class_name\s+\w+/m.test(text)) {
        skipped++
        return
      }
      const cls = parseGdScript(text, { fileName: path.basename(file), scriptPath: file })
      if (cls && cls.name) {
        // 同名类(多脚本重复 class_name):保留先出现的,后者计入跳过
        if (mapped.some((c) => c.name === cls.name)) skipped++
        else mapped.push(cls)
      } else skipped++
    })
    checkCancel(token)
    if (!mapped.length) {
      throw new Error(`未找到带 class_name 的脚本(共扫描 ${files.length} 个 .gd 文件)`)
    }
    ensureDir(workDir)
    const total = await writeLibrary(mapped, {
      versionId,
      tag: project.name || '项目',
      name: (project.name || '项目') + ' 脚本',
      libDir,
      stageDir: path.join(workDir, 'staging'),
      tr: null,
      token,
      taskId,
      kind: 'project',
      sourceProject: project.id
    })
    setTask(taskId, { status: 'done', done: total, skipped, fileCount: files.length })
  } catch (e) {
    if (e instanceof CanceledError || token.canceled) setTask(taskId, { status: 'canceled' })
    else setTask(taskId, { status: 'error', error: (e && e.message) || '扫描失败' })
  } finally {
    rmQuiet(workDir)
    tasks.clearToken(taskId)
  }
}

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
