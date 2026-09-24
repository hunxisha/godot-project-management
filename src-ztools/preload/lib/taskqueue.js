// 统一任务队列:注册表 + 快照广播 + 取消令牌 + 终态判定(+ 可选串行执行)。
//
// 为什么有这个模块:install.js(下载队列)与 backup.js(备份/恢复)原本各写了一套同形的
// 任务生命周期 —— 都是 Map 注册表 + Set 监听器 + emit 快照 + cancel/dismiss/watch 三件套。
// 差异只在细节,于是细节分了叉:
//
//   | 方面        | install.js 原实现              | backup.js 原实现              |
//   |------------|-------------------------------|------------------------------|
//   | 快照         | 直接暴露内部对象(不拷贝)          | 浅拷贝                        |
//   | 监听器异常    | 会中断后续监听器                 | 每个监听器 try/catch 隔离       |
//   | 创建时广播    | emit 一次                      | 不广播(首次 patch 才广播)       |
//   | 终态概念     | 无(status 字符串)               | 有(done/error/canceled)       |
//   | dismiss     | 任何状态都能移除                 | 仅终态可移除                   |
//   | 串行执行     | 有(queue + pump)              | 无                           |
//
// 本模块把这些差异变成显式选项,行为由调用方选择,而不是由「复制粘贴时改没改」决定。
// 对外 API(services.js 暴露的方法名与签名)保持不变。
//
// 注意:本模块**不引入 fsutil**,保持零依赖,便于单独测试与复用。

/** 常见终态集合,供 backup/restore 这类有明确生命周期的任务使用 */
const TERMINAL_PHASES = { done: true, error: true, canceled: true }

/**
 * 创建一个任务队列。
 *
 * @param {object} [opts]
 * @param {string} [opts.idPrefix='task'] 生成 id 的前缀
 * @param {() => string} [opts.makeId] 自定义 id 生成器(默认 `${idPrefix}-${base36 时间}-${序号}`)
 * @param {string} [opts.sortBy] 快照排序字段(默认不排序)
 * @param {object} [opts.terminalPhases] 终态集合;给了才启用「仅终态可 dismiss」
 * @param {string} [opts.phaseField='phase'] 阶段字段**名**(写入与终态判断都用它)
 * @param {boolean} [opts.serial=false] 是否串行执行 enqueue 的作业
 */
function createTaskQueue(opts) {
  const o = opts || {}
  const idPrefix = o.idPrefix || 'task'
  const sortBy = o.sortBy || null
  const terminalPhases = o.terminalPhases || null
  const phaseField = o.phaseField || 'phase'
  const serial = !!o.serial

  /** @type {Map<string, object>} */
  const tasks = new Map()
  /** @type {Map<string, { cancel: () => boolean }>} 取消令牌 / 取消句柄 */
  const tokens = new Map()
  const listeners = new Set()
  let seq = 0

  const makeId = o.makeId || (() => `${idPrefix}-${Date.now().toString(36)}-${++seq}`)

  function isTerminal(phase) {
    return terminalPhases ? !!terminalPhases[phase] : false
  }

  /** 任务快照:浅拷贝,避免订阅者改到内部状态 */
  function list() {
    const arr = [...tasks.values()].map((t) => ({ ...t }))
    if (sortBy) arr.sort((a, b) => (a[sortBy] || 0) - (b[sortBy] || 0))
    return arr
  }

  function emit() {
    const snap = list()
    for (const fn of listeners) {
      try {
        fn(snap)
      } catch (e) { /* 单个订阅者异常不影响任务本身,也不影响其他订阅者 */ }
    }
  }

  /** 订阅任务快照,立即回调一次当前状态,返回取消订阅函数 */
  function watch(fn) {
    listeners.add(fn)
    try {
      fn(list())
    } catch (e) { /* ignore */ }
    return () => listeners.delete(fn)
  }

  /** 新建任务。**不广播** —— 需要让订阅者立刻看到时显式调用 emit()。 */
  function create(fields) {
    const id = makeId()
    const task = { id, startedAt: Date.now(), ...fields }
    tasks.set(id, task)
    return task
  }

  function get(id) {
    return tasks.get(id)
  }

  function patch(task, fields) {
    if (!task) return
    Object.assign(task, fields)
    emit()
  }

  function finish(task, phase, error) {
    if (!task) return
    task[phaseField] = phase
    if (error) task.error = error
    task.finishedAt = Date.now()
    emit()
  }

  // ---------- 取消 ----------

  /** 登记取消令牌/句柄(download 句柄与 cancel token 都只需实现 cancel()) */
  function setToken(id, token) {
    tokens.set(id, token)
  }

  function clearToken(id) {
    tokens.delete(id)
  }

  function tokenOf(id) {
    return tokens.get(id)
  }

  // ---------- 移除 ----------

  /**
   * 移除任务记录。配置了 terminalPhases 时**仅终态可移除**,返回是否移除成功;
   * 未配置时任何状态都可移除。
   */
  function dismiss(id) {
    const task = tasks.get(id)
    if (!task) return false
    if (terminalPhases && !isTerminal(task[phaseField])) return false
    tasks.delete(id)
    tokens.delete(id)
    emit()
    return true
  }

  // ---------- 串行执行(仅 serial 时有意义) ----------

  const queue = []
  let running = false

  async function pump() {
    if (running) return
    const job = queue.shift()
    if (!job) return
    running = true
    try {
      await job()
    } finally {
      running = false
      pump()
    }
  }

  /**
   * 提交一个作业。serial=true 时逐个执行(等上一个 await 完再跑下一个),
   * 否则立即执行并返回其 Promise。
   */
  function enqueue(job) {
    if (!serial) return job()
    queue.push(job)
    pump()
  }

  return {
    // 查询
    list,
    get,
    size: () => tasks.size,
    isTerminal,
    // 变更
    create,
    patch,
    finish,
    emit,
    dismiss,
    // 订阅
    watch,
    // 取消
    setToken,
    clearToken,
    tokenOf,
    // 执行
    enqueue
  }
}

module.exports = { createTaskQueue, TERMINAL_PHASES }
