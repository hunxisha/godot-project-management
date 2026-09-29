// 生成流水线:引擎 dump → 映射/翻译 → 暂存落盘 → 原子接管;导入 JSON 建库同构共用
// buildLibrary/writeLibrary。索引缓存(loadIndex)也在这里 —— 写方负责失效后重读。
// 从 docs.js 拆出(2026-09-29);setTask 移到 doctasks.js。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { getDoc, putDoc } = require('./store')
const { ensureDir } = require('./extract')
const { CanceledError, createCancelToken, checkCancel, forEachSliced, rmQuiet } = require('./fsutil')
const { tasks, setTask } = require('./doctasks')
const { versionKey, docsRoot, libIndexPath, DB_ID, VERSION_PREFIX } = require('./docpaths')
const { mapClass, mapGlobalScope, buildIndexEntry } = require('./docmodel')
const { applyTranslations, loadZhTranslations } = require('./docpo')

/** @typedef {import('../../../src/types/godot').DocClassDetail} DocClassDetail */
/** @typedef {import('../../../src/types/godot').DocClassSummary} DocClassSummary */

/** 引擎 dump 的超时上限(实测 ~1s,留足余量) */
const DUMP_TIMEOUT_MS = 90_000
/** parsing 阶段任务进度的上报步长(每次 patch 都会广播快照,避免千次刷屏) */
const PROGRESS_STEP = 25

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

// ---------- 生成流水线 ----------
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
    translatedCount: ctx.tr ? hits.count : 0,
    // 可翻译字符串总数:translatedCount/stringCount 即翻译覆盖率
    stringCount: ctx.tr ? hits.total : 0,
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

module.exports = { loadIndex, indexCache, buildLibrary, writeLibrary, generateDocs, importDocsLibrary }
