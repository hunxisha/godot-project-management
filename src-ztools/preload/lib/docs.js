// 引擎文档库:从已装 Godot 引擎导出类参考,建立离线索引供「文档」页浏览。
//
// 为什么不用 --doctool:官方编辑器二进制导出的 XML 只有 API 结构,描述文本为空
// (实测 4.7.2 stable / 4.8-dev6);--dump-extension-api-with-docs 输出单个
// extension_api.json,描述完整(BBCode 原样保留)、JSON.parse 即得,无需 XML 解析器。
// 详见 docs/docs-browser-plan.md 第 2.1 节的实测记录。
//
// 生成是长任务:独立串行队列(不与导出/模板共用),status: queued/dumping/parsing/
// done/error/canceled;dumping 阶段 spawn 引擎(可取消=kill),parsing 阶段分片让出。
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

const tasks = createTaskQueue({
  serial: true,
  makeId: () => `docs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
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

/**
 * 文档库根目录:优先设置里的引擎安装根;未设置(用户只导入过本地引擎)时退回家目录。
 * @param {string} [versionId]
 */
function docsRoot(versionId) {
  const settings = getDoc('godot/settings') || {}
  const base = settings.versionsRoot || path.join(os.homedir(), '.gpm-docs')
  return versionId ? path.join(base, 'gpm-docs', versionId) : path.join(base, 'gpm-docs')
}

function libClassesDir(versionId) {
  return path.join(docsRoot(versionId), 'classes')
}

function libIndexPath(versionId) {
  return path.join(docsRoot(versionId), 'index.json')
}

const DB_ID = (versionId) => `godot/docs/${versionId}`
const FAVORITES_ID = 'godot/docs/favorites'
const HISTORY_ID = 'godot/docs/history'

// ---------- extension_api.json → 内部模型映射(纯函数,可独立测试) ----------

/** @param {{is_const?:boolean,is_static?:boolean,is_virtual?:boolean,is_vararg?:boolean,is_required?:boolean}} m */
function qualifiersOf(m) {
  const q = []
  if (m.is_static) q.push('static')
  if (m.is_virtual) q.push('virtual')
  if (m.is_const) q.push('const')
  if (m.is_required) q.push('required')
  if (m.is_vararg) q.push('vararg')
  return q
}

/** @param {{name:string,type:string,default_value?:string,meta?:string}[]|undefined} args */
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
    members: (c.properties || c.members || []).map((p) => ({
      name: p.name,
      type: p.type || 'Variant',
      setter: p.setter || undefined,
      getter: p.getter || undefined,
      defaultValue: p.default_value,
      description: p.description || ''
    })),
    methods: (c.methods || []).map((m) => ({
      name: m.name,
      returnType: m.return_type || (builtin ? 'Variant' : 'void'),
      params: mapParams(m.arguments),
      qualifiers: qualifiersOf(m),
      description: m.description || ''
    })),
    signals: (c.signals || []).map((s) => ({
      name: s.name,
      params: mapParams(s.arguments),
      description: s.description || ''
    })),
    constants: (c.constants || []).map((k) => ({
      name: k.name,
      value: String(k.value),
      enum: k.enum || undefined,
      description: k.description || ''
    })),
    enums: (c.enums || []).map((e) => ({
      name: e.name,
      bitfield: !!e.is_bitfield,
      values: (e.values || []).map((v) => ({
        name: v.name,
        value: String(v.value),
        description: v.description || ''
      }))
    })),
    // 运算符只有 builtin 类有(Vector2 + 等);core 类恒为空
    operators: (c.operators || []).map((op) => ({
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
 */
function mapGlobalScope(api) {
  const enums = (api.global_enums || []).map((e) => ({
    name: e.name,
    bitfield: !!e.is_bitfield,
    values: (e.values || []).map((v) => ({
      name: v.name,
      value: String(v.value),
      description: v.description || ''
    }))
  }))
  // 全局常量里属于某个全局枚举的值已由上面收录,这里只留散装常量
  const inEnum = new Set(enums.flatMap((e) => e.values.map((v) => v.name)))
  const constants = (api.global_constants || [])
    .filter((k) => !inEnum.has(k.name))
    .map((k) => ({ name: k.name, value: String(k.value), description: '' }))
  return {
    name: '@GlobalScope',
    inherits: null,
    brief: '全局作用域:GDScript 内置函数、全局常量与全局枚举。',
    description: '收录 GDScript 直接可用的内置函数(如 clamp / lerp / randi)与全局常量、枚举。这些成员不属于任何类,在任意脚本中直接调用。',
    builtin: true,
    isSingleton: false,
    members: [],
    signals: [],
    methods: (api.utility_functions || []).map((uf) => ({
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
 * @param {ReturnType<typeof mapClass>} cls
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
 * @param {ReturnType<typeof buildIndexEntry>[]} index
 * @param {string} query
 * @param {number} [limit]
 */
function searchIndex(index, query, limit = 30) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  /** @type {{kind:string, className:string, name:string, brief:string, score:number}[]} */
  const hits = []
  for (const entry of index) {
    const clsScore = wordScore(entry.name, q)
    if (clsScore) {
      hits.push({ kind: 'class', className: entry.name, name: entry.name, brief: entry.brief, score: SCORE_CLASS + clsScore })
    }
    let memberBudget = SEARCH_PER_CLASS_CAP
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

/** @type {Map<string, { index: any[], at: number }>} */
const indexCache = new Map()

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

// ---------- 生成流水线 ----------

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
  const versionId = task.versionId
  const version = getDoc(`godot/version/${versionId}`)
  if (!version || !version.exePath || !fs.existsSync(version.exePath)) {
    setTask(taskId, { status: 'error', error: '引擎可执行文件不存在' })
    return
  }
  const libDir = docsRoot(versionId)
  const workDir = path.join(docsRoot(), `.work-${taskId}`)
  const token = createCancelToken()
  try {
    ensureDir(workDir)
    // ---- dumping:spawn 引擎,产物为 cwd 下的 extension_api.json ----
    setTask(taskId, { status: 'dumping', log: '' })
    const jsonPath = path.join(workDir, 'extension_api.json')
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

    // ---- parsing:映射 + 写入暂存目录,分片让出 ----
    setTask(taskId, { status: 'parsing', done: 0, total: 0 })
    const api = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    const singletonNames = new Set((api.singletons || []).map((s) => s.name))
    /** @type {ReturnType<typeof mapClass>[]} */
    const mapped = []
    for (const c of api.classes || []) {
      mapped.push(mapClass(c, { isSingleton: singletonNames.has(c.name) }))
    }
    for (const c of api.builtin_classes || []) mapped.push(mapClass(c, { builtin: true }))
    mapped.push(mapGlobalScope(api))

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
      libDir
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
 * @param {string} versionId
 */
function generateDocs(versionId) {
  const version = getDoc(`godot/version/${versionId}`)
  if (!version || !version.exePath) return { ok: false, error: '版本不存在或未绑定可执行文件' }
  if (!fs.existsSync(version.exePath)) return { ok: false, error: '引擎可执行文件不存在' }
  const busy = tasks.list().find((t) => t.versionId === versionId && !TERMINAL_PHASES[t.status])
  if (busy) return { ok: false, error: '该版本的文档库正在生成中' }
  const task = tasks.create({
    kind: 'docs',
    versionId,
    tag: version.tag,
    versionName: version.name,
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

function cancelDocsTask(id) {
  const t = tasks.get(id)
  if (!t) return
  if (TERMINAL_PHASES[t.status]) return
  const handle = tasks.tokenOf(id)
  if (handle) handle.cancel()
  setTask(id, { status: 'canceled' })
}

function dismissDocsTask(id) {
  tasks.dismiss(id)
}

function watchDocsTasks(fn) {
  return tasks.watch(fn)
}

// ---------- 浏览 API ----------

/**
 * 文档库状态:ready=已生成;building=生成中;null=未生成。
 * @param {string} versionId
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
      builtAt: record.builtAt
    }
  }
  const busy = tasks.list().find((t) => t.versionId === versionId && !TERMINAL_PHASES[t.status])
  if (busy) return { status: 'building', versionId, tag: busy.tag, name: busy.versionName }
  return null
}

/**
 * 删除文档库(目录 + db 记录;收藏/历史是全局的,保留)。幂等。
 * @param {string} versionId
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
 */
function docsSearch(versionId, query, limit = 30) {
  const index = loadIndex(versionId)
  if (!index) return []
  return searchIndex(index, query, limit)
}

// ---------- 收藏与历史(全局,跨版本) ----------

/**
 * @param {string} id
 * @param {unknown} fallback
 */
function readDoc(id, fallback) {
  const d = getDoc(id)
  return d || fallback
}

function docsListFavorites() {
  return readDoc(FAVORITES_ID, { items: [] }).items || []
}

function docsToggleFavorite(className, fav) {
  const items = docsListFavorites()
  const set = new Set(items)
  if (fav) set.add(className)
  else set.delete(className)
  putDoc(FAVORITES_ID, { items: [...set].sort() })
  return { ok: true }
}

function docsListHistory() {
  return readDoc(HISTORY_ID, { items: [] }).items || []
}

function docsPushHistory(className) {
  const items = (readDoc(HISTORY_ID, { items: [] }).items || []).filter((x) => x.name !== className)
  items.unshift({ name: className, at: Date.now() })
  putDoc(HISTORY_ID, { items: items.slice(0, HISTORY_MAX) })
}

// ---------- 缓存统计与清理 ----------

function docsCacheInfo() {
  const records = listDocs('godot/docs/').filter((d) => d.versionId)
  const libraries = records.map((r) => ({
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
 */
function docsCleanCache(versionIds) {
  const ids = (versionIds && versionIds.length
    ? versionIds
    : listDocs('godot/docs/').filter((d) => d.versionId).map((d) => d.versionId))
  for (const id of ids) docsDeleteLibrary(id)
  return { ok: true, removed: ids.length }
}

module.exports = {
  // 纯函数(测试用)
  mapClass,
  mapGlobalScope,
  buildIndexEntry,
  searchIndex,
  wordScore,
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
