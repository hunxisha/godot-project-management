// 项目备份领域模块:创建 / 查询 / 统计 / 校验 / 备注 / 删除 / 清理 / 恢复 / 预估 / 任务。
//
// 设计要点:
// 1. 所有长循环通过 fsutil 分片让出事件循环 —— preload 与渲染层同线程,否则界面会冻结
//    (进度不刷新、取消点不动)。
// 2. 原子落盘:先写 .gpm-tmp-* 临时产物,成功后再 rename 到最终名;失败/取消一律清理,
//    不留孤儿文件,也不写脏记录。
// 3. 任务表 + 订阅:备份可在页面切换后继续,进度与取消通过 watchBackupTasks 广播。
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')
const { ensureDir, createZip, extractZip, inspectZip } = require('./extract')
const {
  CanceledError,
  createCancelToken,
  sanitizeName,
  stampSec,
  uniquePath,
  trashPath,
  rmQuiet,
  tempPath,
  makeExcluder,
  copyTree,
  estimateTree
} = require('./fsutil')
const { addProject } = require('./projects')
const { createTaskQueue, TERMINAL_PHASES } = require('./taskqueue')

const BACKUP_PREFIX = 'godot/backup/'
const PROJECT_PREFIX = 'godot/project/'
/** 备份记录结构版本:1=旧记录(无下列可选字段),2=当前 */
const SCHEMA = 2
/** 备份文件存在性探测缓存时长 */
const EXISTS_TTL = 5000

/**
 * 目录名排除器。
 * @typedef {(name: string, isDir: boolean) => boolean} Excluder
 */

// ---------- 任务表(进度 + 取消 + 跨页面订阅) ----------
// 通用机制在 taskqueue.js;这里只保留备份语义(默认字段、终态规则、取消语义)。
const queue = createTaskQueue({
  idPrefix: 'bt',
  sortBy: 'startedAt',
  terminalPhases: TERMINAL_PHASES
})

/**
 * 任务快照(按 startedAt 升序,浅拷贝)。
 * @returns {import('../../../src/types/godot').BackupTask[]}
 */
function listBackupTasks() {
  return queue.list()
}

/**
 * 订阅备份任务快照,立即回调一次当前状态,返回取消订阅函数。
 * @param {(tasks: object[]) => void} fn
 */
function watchBackupTasks(fn) {
  return queue.watch(fn)
}

/**
 * 新建任务:补齐备份任务的默认字段(phase/done/total/bytes/current)。
 * @param {import('./taskqueue').Task} [fields]
 * @returns {import('./taskqueue').Task}
 */
function newTask(fields) {
  return queue.create({
    kind: 'backup',
    phase: 'scanning',
    done: 0,
    total: 0,
    bytes: 0,
    current: '',
    ...fields
  })
}

/**
 * @param {import('./taskqueue').Task} task
 * @param {import('./taskqueue').Task} patch
 */
function patchTask(task, patch) {
  queue.patch(task, patch)
}

/**
 * @param {import('./taskqueue').Task} task
 * @param {string} phase
 * @param {string} [error]
 */
function finishTask(task, phase, error) {
  queue.finish(task, phase, error)
}

/**
 * 取消进行中的备份/恢复任务。
 * 已进入不可回滚阶段(覆盖恢复替换原目录)后 token 已 lock,返回 false。
 * @param {string} id
 * @returns {boolean} 是否被接受
 */
function cancelBackupTask(id) {
  const token = queue.tokenOf(id)
  if (!token) return false
  const ok = !!token.cancel()
  const task = queue.get(id)
  if (ok && task) {
    task.cancelRequested = true
    queue.emit()
  }
  return ok
}

/**
 * 移除已结束的任务记录(进行中的任务不可移除)。
 * @param {string} id
 * @returns {boolean}
 */
function dismissBackupTask(id) {
  return queue.dismiss(id)
}

// ---------- 备份文件存在性(带缓存) ----------

const existsCache = new Map()

/**
 * 带 TTL 的「备份文件/目录是否还在」探测。
 * @param {string} p
 * @returns {boolean}
 */
function existsCached(p) {
  const now = Date.now()
  const hit = existsCache.get(p)
  if (hit && now - hit.at < EXISTS_TTL) return hit.exists
  let exists = false
  try {
    exists = fs.existsSync(p)
  } catch (e) {
    exists = false
  }
  existsCache.set(p, { exists, at: now })
  return exists
}

/**
 * 失效某个路径的存在性缓存(删除/恢复后调用)。
 * @param {string} p
 */
function invalidateExists(p) {
  if (p) existsCache.delete(p)
}

// ---------- 创建 ----------

/**
 * @typedef {object} BackupCreateOpts 备份创建/预估的入参(全部可选)
 * @property {'zip'|'copy'} [mode]
 * @property {string} [destDir]
 * @property {boolean} [includeCache]
 * @property {1|6|9} [level]
 * @property {string} [label]
 * @property {string[]} [exclude]
 */

/**
 * @typedef {object} NormalizedBackupOpts 归一化后的备份参数(创建与预估共用)
 * @property {'zip'|'copy'} mode
 * @property {string} destDir
 * @property {boolean} includeCache
 * @property {string} label
 * @property {string[]} excludeNames
 * @property {Excluder | null} exclude 目录名排除器(见 fsutil.makeExcluder)
 * @property {1|6|9} level
 */

/**
 * 归一化备份参数:补齐默认值、规整 exclude 列表。
 * @param {BackupCreateOpts} [opts]
 * @returns {NormalizedBackupOpts}
 */
function normalizeOpts(opts) {
  const o = opts || {}
  const mode = o.mode === 'copy' ? 'copy' : 'zip'
  const excludeNames = Array.isArray(o.exclude) ? o.exclude.filter(Boolean) : []
  return {
    mode,
    destDir: o.destDir,
    includeCache: !!o.includeCache,
    label: typeof o.label === 'string' ? o.label.trim() : '',
    excludeNames,
    exclude: makeExcluder(excludeNames),
    level: o.level === 1 || o.level === 9 ? o.level : 6
  }
}

/**
 * 备份项目。先写临时产物,成功后 rename 到最终名并落库;失败/取消不留任何痕迹。
 * @param {string} projectId
 * @param {{mode?:'zip'|'copy', destDir:string, includeCache?:boolean, level?:1|6|9, label?:string, exclude?:string[]}} opts
 * @param {(p:{phase:string,done:number,total:number,current:string,bytes:number}) => void} [onProgress]
 * @returns {Promise<import('../../../src/types/godot').BackupRecord>} 备份记录(含 missing:false)
 */
async function backupProject(projectId, opts, onProgress) {
  const o = normalizeOpts(opts)
  const project = getDoc(projectId)
  if (!project) throw new Error('项目不存在')
  const root = project.path
  if (!root || !fs.existsSync(path.join(root, 'project.godot'))) {
    throw new Error('项目目录校验失败(未找到 project.godot)')
  }
  if (!o.destDir) throw new Error('未指定备份保存位置')
  ensureDir(o.destDir)

  const task = newTask({
    projectId,
    projectName: project.name,
    label: o.label || undefined,
    mode: o.mode,
    destDir: o.destDir
  })
  const token = createCancelToken()
  queue.setToken(task.id, token)

  /**
   * @param {{phase: string, done: number, total: number, current: string, bytes: number}} p
   */
  const report = (p) => {
    patchTask(task, {
      phase: p.phase,
      done: p.done || 0,
      total: p.total || 0,
      bytes: p.bytes || 0,
      current: p.current || ''
    })
    if (onProgress) {
      try {
        onProgress({ ...p })
      } catch (e) { /* 进度回调异常不影响备份 */ }
    }
  }

  const name = sanitizeName(o.label || project.name || path.basename(root))
  const finalName = `${name}_${stampSec()}${o.mode === 'zip' ? '.zip' : ''}`
  const tmp = tempPath(o.destDir, task.id, o.mode === 'copy')
  const startedAt = Date.now()

  try {
    let stat
    if (o.mode === 'zip') {
      stat = await createZip(root, tmp, {
        includeCache: o.includeCache,
        exclude: o.exclude,
        level: o.level,
        token,
        onProgress: report,
        phase: 'packing'
      })
    } else {
      stat = await copyTree(root, tmp, {
        includeCache: o.includeCache,
        exclude: o.exclude,
        token,
        onProgress: report,
        phase: 'copying'
      })
    }

    patchTask(task, { phase: 'finalizing' })
    const finalPath = uniquePath(path.join(o.destDir, finalName))
    fs.renameSync(tmp, finalPath)
    invalidateExists(finalPath)

    const record = {
      _id: BACKUP_PREFIX + crypto.randomUUID(),
      projectId,
      projectName: project.name,
      mode: o.mode,
      destPath: finalPath,
      size: stat.bytes,
      fileCount: stat.fileCount,
      createdAt: Date.now(),
      label: o.label || undefined,
      includeCache: o.includeCache,
      level: o.mode === 'zip' ? o.level : undefined,
      engineVersion: project.engineVersion || undefined,
      configVersion: typeof project.configVersion === 'number' ? project.configVersion : undefined,
      excluded: o.excludeNames.length ? o.excludeNames.slice() : undefined,
      durationMs: Date.now() - startedAt,
      schema: SCHEMA
    }
    const { _id, ...data } = record
    putDoc(_id, data)
    finishTask(task, 'done')
    return { ...record, missing: false }
  } catch (e) {
    rmQuiet(tmp)
    if (e instanceof CanceledError || (e && e.canceled)) {
      finishTask(task, 'canceled')
      /** @type {Error & { canceled?: boolean }} */
      const err = new Error('已取消')
      err.canceled = true
      throw err
    }
    finishTask(task, 'error', (e && e.message) || '备份失败')
    throw e
  } finally {
    queue.clearToken(task.id)
  }
}

/**
 * 预估备份规模(文件数 + 字节),分片让出避免卡界面。
 * @param {string} projectId
 * @param {BackupCreateOpts} [opts]
 * @returns {Promise<{fileCount: number, bytes: number}>}
 */
async function estimateBackup(projectId, opts) {
  const o = normalizeOpts(opts)
  const project = getDoc(projectId)
  if (!project) throw new Error('项目不存在')
  if (!project.path || !fs.existsSync(path.join(project.path, 'project.godot'))) {
    throw new Error('项目目录无效(未找到 project.godot)')
  }
  return estimateTree(project.path, { includeCache: o.includeCache, exclude: o.exclude })
}

// ---------- 查询 ----------

/**
 * 列出备份记录(按时间倒序)。
 * 兼容旧调用:listBackups('godot/project/xxx') 等价于 listBackups({ projectId: 'godot/project/xxx' })。
 * @param {string|{projectId?:string, withStatus?:boolean}} [arg]
 *   withStatus 默认 true(附带 missing 标记);传 false 可跳过磁盘探测(配合 backupStats 用)。
 */
function listBackups(arg) {
  const query = typeof arg === 'string' ? { projectId: arg } : (arg || {})
  const withStatus = query.withStatus !== false
  let list = listDocs(BACKUP_PREFIX)
  if (query.projectId) list = list.filter((d) => d.projectId === query.projectId)
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return list.map((d) => (withStatus ? { ...d, missing: !existsCached(d.destPath) } : { ...d }))
}

/**
 * 每个项目最近一份备份(渲染层无需拉全量再折叠)。
 * @returns {Record<string, import('../../../src/types/godot').BackupRecord>}
 */
function listLatestBackups() {
  /** @type {Record<string, import('../../../src/types/godot').BackupRecord>} */
  const map = {}
  for (const d of listDocs(BACKUP_PREFIX)) {
    const cur = map[d.projectId]
    if (!cur || (d.createdAt || 0) > (cur.createdAt || 0)) map[d.projectId] = { ...d }
  }
  return map
}

/**
 * 单条备份记录。
 * @param {string} backupId
 * @returns {object | null}
 */
function getBackup(backupId) {
  const d = getDoc(backupId)
  return d ? { ...d } : null
}

/** 备份汇总(在 preload 侧聚合,供统计头使用) */
function backupStats() {
  const list = listDocs(BACKUP_PREFIX)
  const projects = listDocs(PROJECT_PREFIX)
  let totalSize = 0
  let missingCount = 0
  let zip = 0
  let copy = 0
  const covered = new Set()
  for (const d of list) {
    totalSize += d.size || 0
    if (d.mode === 'copy') copy++
    else zip++
    if (!existsCached(d.destPath)) missingCount++
    covered.add(d.projectId)
  }
  let coveredProjects = 0
  // 孤立备份(项目记录已删除)不计入「已覆盖项目」
  for (const p of projects) if (covered.has(p._id)) coveredProjects++
  return {
    count: list.length,
    totalSize,
    missingCount,
    coveredProjects,
    totalProjects: projects.length,
    byMode: { zip, copy }
  }
}

// ---------- 修改 ----------

/**
 * 更新备份备注名(label 传空串则清除)。
 * @param {string} backupId
 * @param {{label?: string}} patch
 * @returns {{ok: boolean, error?: string}}
 */
function updateBackup(backupId, patch) {
  try {
    const rec = getDoc(backupId)
    if (!rec) return { ok: false, error: '备份记录不存在' }
    const { _id, _rev, ...data } = rec
    if (patch && 'label' in patch) {
      const label = String(patch.label == null ? '' : patch.label).trim()
      if (label) data.label = label.slice(0, 80)
      else delete data.label
    }
    putDoc(_id, data)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '保存失败' }
  }
}

/**
 * 校验备份内容是否可用:文件是否存在 + 是否含 project.godot。
 * zip 只读取尾部窗口与中央目录,不整包载入(项目备份可能达数 GB)。
 * @param {string} backupId
 * @returns {{ok: boolean, valid: boolean, error?: string, entryCount?: number}}
 */
function verifyBackup(backupId) {
  const rec = getDoc(backupId)
  if (!rec) return { ok: false, valid: false, error: '备份记录不存在' }
  let valid = false
  let error = ''
  let entryCount = 0
  try {
    if (!fs.existsSync(rec.destPath)) {
      error = '备份文件已不存在'
    } else if (rec.mode === 'zip') {
      const r = inspectZip(rec.destPath, 'project.godot')
      valid = r.ok
      entryCount = r.entries.length
      if (!r.ok) error = r.error
    } else if (!fs.existsSync(path.join(rec.destPath, 'project.godot'))) {
      error = '快照目录内未找到 project.godot'
    } else {
      valid = true
    }
  } catch (e) {
    error = (e && e.message) || '校验失败'
  }
  invalidateExists(rec.destPath)
  try {
    const { _id, _rev, ...data } = rec
    putDoc(_id, {
      ...data,
      verified: valid,
      verifiedAt: Date.now(),
      verifyError: error || undefined
    })
  } catch (e) { /* 写回失败不影响校验结论 */ }
  return { ok: true, valid, error: error || undefined, entryCount }
}

// ---------- 删除 ----------

/**
 * 删除备份。
 * @param {string} backupId
 * @param {{keepRecordOnly?:boolean}} [opts] keepRecordOnly=true 仅移除记录,保留磁盘文件
 * @returns {{ok: boolean, error?: string}}
 */
function deleteBackup(backupId, opts) {
  try {
    const keepRecordOnly = !!(opts && opts.keepRecordOnly)
    const rec = getDoc(backupId)
    if (!rec) return { ok: false, error: '备份记录不存在' }
    if (!keepRecordOnly && fs.existsSync(rec.destPath)) {
      trashPath(rec.destPath, rec.mode !== 'zip')
    }
    removeDoc(backupId)
    invalidateExists(rec.destPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '删除失败' }
  }
}

/**
 * 批量删除(一次调用,避免渲染层发起 N 次往返)。
 * @param {string[]} backupIds
 * @param {{keepRecordOnly?:boolean}} [opts]
 * @returns {{ok: boolean, removed: number, failed: {id: string, error: string}[]}}
 */
function deleteBackups(backupIds, opts) {
  const ids = Array.isArray(backupIds) ? backupIds : []
  const failed = []
  let removed = 0
  for (const id of ids) {
    const r = deleteBackup(id, opts)
    if (r.ok) removed++
    else failed.push({ id, error: r.error || '删除失败' })
  }
  return { ok: failed.length === 0, removed, failed }
}

/**
 * 清理备份。**默认 dryRun:true**,只返回将被删除的清单,必须显式传 dryRun:false 才真正删除。
 * @param {{keepPerProject?:number, olderThanDays?:number, dryRun?:boolean}} opts
 * @returns {{ok:boolean, dryRun:boolean, targets:import('../../../src/types/godot').BackupRecord[], totalSize:number, removed?:number, failed?:{id:string,error:string}[], error?:string}}
 */
function pruneBackups(opts) {
  const o = opts || {}
  const keep = Number.isFinite(o.keepPerProject) && o.keepPerProject >= 0
    ? Math.floor(o.keepPerProject)
    : null
  const days = Number.isFinite(o.olderThanDays) && o.olderThanDays > 0
    ? Math.floor(o.olderThanDays)
    : null
  if (keep === null && days === null) {
    return { ok: false, dryRun: true, targets: [], totalSize: 0, error: '未指定清理条件' }
  }

  const all = listDocs(BACKUP_PREFIX).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  const targets = []
  const seen = new Set()

  if (keep !== null) {
    const byProject = new Map()
    for (const d of all) {
      const arr = byProject.get(d.projectId)
      if (arr) arr.push(d)
      else byProject.set(d.projectId, [d])
    }
    for (const arr of byProject.values()) {
      for (const d of arr.slice(keep)) {
        if (!seen.has(d._id)) {
          seen.add(d._id)
          targets.push(d)
        }
      }
    }
  }
  if (days !== null) {
    const cutoff = Date.now() - days * 86400000
    for (const d of all) {
      if ((d.createdAt || 0) < cutoff && !seen.has(d._id)) {
        seen.add(d._id)
        targets.push(d)
      }
    }
  }

  const totalSize = targets.reduce((s, d) => s + (d.size || 0), 0)
  if (o.dryRun !== false) {
    return { ok: true, dryRun: true, targets, totalSize }
  }

  const res = deleteBackups(targets.map((d) => d._id))
  return { ok: res.ok, dryRun: false, targets, totalSize, removed: res.removed, failed: res.failed }
}

// ---------- 恢复 ----------

/**
 * 从备份恢复。
 * mode 'new':恢复到新目录并注册为新项目(安全,可取消)
 * mode 'overwrite':替换原项目目录(原目录先改名,成功后移入回收站,失败自动回滚;
 *                 进入替换阶段后 token 锁定,不再响应取消)
 * @param {string} backupId
 * @param {{mode?:'overwrite'|'new', destDir?:string, newName?:string}} opts
 * @param {(p:{phase:string,done:number,total:number,current:string,bytes:number}) => void} [onProgress]
 * @returns {Promise<{ok: boolean, error?: string, canceled?: boolean, newProjectName?: string, newProjectId?: string}>}
 */
async function restoreBackup(backupId, opts, onProgress) {
  const o = opts || {}
  const mode = o.mode === 'overwrite' ? 'overwrite' : 'new'
  const record = getDoc(backupId)
  if (!record) return { ok: false, error: '备份记录不存在' }
  if (!fs.existsSync(record.destPath)) {
    return { ok: false, error: '备份文件已不存在: ' + record.destPath }
  }

  const task = newTask({
    kind: 'restore',
    projectId: record.projectId,
    projectName: record.projectName,
    mode,
    destDir: record.destPath
  })
  const token = createCancelToken()
  queue.setToken(task.id, token)

  /**
   * @param {{phase: string, done: number, total: number, current: string, bytes: number}} p
   */
  const report = (p) => {
    patchTask(task, {
      phase: p.phase,
      done: p.done || 0,
      total: p.total || 0,
      bytes: p.bytes || 0,
      current: p.current || ''
    })
    if (onProgress) {
      try {
        onProgress({ ...p })
      } catch (e) { /* ignore */ }
    }
  }

  let tmpDir = ''
  try {
    // 准备源目录:zip 先解压到备份同级的临时目录;copy 快照直接使用
    let srcDir = record.destPath
    if (record.mode === 'zip') {
      tmpDir = path.join(path.dirname(record.destPath), `.godot-restore-${Date.now()}`)
      await extractZip(record.destPath, tmpDir, { token, onProgress: report, phase: 'unpacking' })
      srcDir = tmpDir
    }
    if (!fs.existsSync(path.join(srcDir, 'project.godot'))) {
      throw new Error('备份内容无效(未找到 project.godot)')
    }

    const project = getDoc(record.projectId)

    if (mode === 'new') {
      const base = o.destDir || (project ? path.dirname(project.path) : path.dirname(record.destPath))
      const name = sanitizeName(o.newName || record.label || record.projectName || path.basename(srcDir))
      ensureDir(base)
      const target = uniquePath(path.join(base, name))
      await copyTree(srcDir, target, { includeCache: true, token, onProgress: report, phase: 'copying' })
      patchTask(task, { phase: 'registering' })
      const r = addProject(target)
      if (!r || !r.ok) {
        rmQuiet(target)
        throw new Error((r && r.error) || '新项目注册失败')
      }
      finishTask(task, 'done')
      return {
        ok: true,
        newProjectName: r.project ? r.project.name : name,
        newProjectId: r.project ? r.project.id : undefined
      }
    }

    // ---------- 覆盖恢复 ----------
    if (!project) throw new Error('原项目记录不存在,请选择「恢复为新项目」')
    if (!fs.existsSync(path.join(project.path, 'project.godot'))) {
      throw new Error('原项目目录无效(未找到 project.godot)')
    }
    // 锁定前最后确认一次取消意图:一旦开始替换原目录就不可回滚
    if (token.isCanceled()) throw new CanceledError()
    token.lock()
    patchTask(task, { phase: 'replacing', cancelable: false })

    const oldDir = `${project.path}_old_${Date.now()}`
    fs.renameSync(project.path, oldDir)
    try {
      await copyTree(srcDir, project.path, {
        includeCache: true,
        token,
        onProgress: report,
        phase: 'copying'
      })
      try {
        trashPath(oldDir, true)
      } catch (e) { /* 旧目录清理失败不影响恢复结果 */ }
    } catch (e) {
      rmQuiet(project.path)
      try {
        fs.renameSync(oldDir, project.path)
      } catch (e2) { /* 回滚失败:原目录仍在 _old_ 路径下 */ }
      throw e
    }
    finishTask(task, 'done')
    return { ok: true }
  } catch (e) {
    if (e instanceof CanceledError || (e && e.canceled)) {
      finishTask(task, 'canceled')
      return { ok: false, canceled: true, error: '已取消' }
    }
    finishTask(task, 'error', (e && e.message) || '恢复失败')
    return { ok: false, error: (e && e.message) || '恢复失败' }
  } finally {
    rmQuiet(tmpDir)
    queue.clearToken(task.id)
  }
}

module.exports = {
  backupProject,
  estimateBackup,
  listBackups,
  listLatestBackups,
  getBackup,
  backupStats,
  updateBackup,
  verifyBackup,
  deleteBackup,
  deleteBackups,
  pruneBackups,
  restoreBackup,
  listBackupTasks,
  watchBackupTasks,
  cancelBackupTask,
  dismissBackupTask
}
