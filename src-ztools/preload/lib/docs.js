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
  /** 翻译命中计数(applyTranslations 回填) */
  const zhHits = { count: 0, total: 0 }
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
    /** @type {{name: string}[]} */
    const singletons = api.singletons || []
    const singletonNames = new Set(singletons.map((s) => s.name))
    /** @type {DocClassDetail[]} */
    const mapped = []
    for (const c of api.classes || []) {
      const cls = mapClass(c, { isSingleton: singletonNames.has(c.name) })
      mapped.push(tr ? applyTranslations(cls, tr, zhHits) : cls)
    }
    for (const c of api.builtin_classes || []) {
      const cls = mapClass(c, { builtin: true })
      mapped.push(tr ? applyTranslations(cls, tr, zhHits) : cls)
    }
    const gs = mapGlobalScope(api)
    mapped.push(tr ? applyTranslations(gs, tr, zhHits) : gs)

    // 原子接管:先写进 workDir 下的暂存目录,全部成功后一次性替换旧库 ——
    // 失败/取消只清暂存,旧库与 db 记录保持完好可浏览。
    const stageDir = path.join(workDir, 'staging')
    const stageClasses = path.join(stageDir, 'classes')
    ensureDir(stageClasses)
    const total = mapped.length
    setTask(taskId, { total })
    let done = 0
    await forEachSliced(mapped, async (cls) => {
      checkCancel(token)
      fs.writeFileSync(path.join(stageClasses, `${cls.name}.json`), JSON.stringify(cls))
      done++
      if (done % PROGRESS_STEP === 0 || done === total) setTask(taskId, { done })
    })
    checkCancel(token)

    const index = {
      builtAt: Date.now(),
      engineTag: version.tag,
      classes: mapped.map(buildIndexEntry)
    }
    const tmpIndex = `${path.join(stageDir, 'index.json')}.tmp`
    fs.writeFileSync(tmpIndex, JSON.stringify(index))
    fs.renameSync(tmpIndex, path.join(stageDir, 'index.json'))

    rmQuiet(libDir)
    fs.renameSync(stageDir, libDir)

    putDoc(DB_ID(versionId), {
      versionId,
      tag: version.tag,
      name: version.name,
      classCount: total,
      builtAt: index.builtAt,
      libDir,
      // 库语言:拿到翻译表(哪怕覆盖不全)即视为中文库;未命中条目保留英文
      lang: tr ? 'zh-CN' : 'en',
      translatedCount: tr ? zhHits.count : 0,
      // 可翻译字符串总数:translatedCount/stringCount 即翻译覆盖率
      stringCount: tr ? zhHits.total : 0
    })
    indexCache.delete(versionId)
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
      stringCount: record.stringCount
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
  // 主流程
  generateDocs,
  docsLibraryStatus,
  docsDeleteLibrary,
  docsListClasses,
  docsGetClass,
  docsSearch,
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
