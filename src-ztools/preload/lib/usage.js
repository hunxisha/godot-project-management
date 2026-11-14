// 引擎使用时长追踪:进程采样 + 启动会话。
//
// 约束:插件无常驻后台进程,只在 ZTools 窗口存活期间运行(「无后台轮询」哲学)。
// 口径因此是「工坊窗口存活期间,Godot 进程在跑的分钟数」,面板文案如实说明这一点:
//   - 采样:递归 setTimeout 每 60s 跑一次 tasklist/ps,查 Godot 进程是否在跑;
//     工坊窗口被 hideMainWindow 隐藏时 JS 通常仍存活、采样继续(宿主行为以实测为准,
//     结算兜底保证即使采样中断也不会虚高)。
//   - 会话:从工坊启动编辑器/运行项目时记一条(含 pid),采样命中/丢失用于精确结算
//     end。会话只做归因(哪天用了哪些项目),日分钟数只来自采样,二者不重复计费。
//   - 睡眠/挂起恢复:单次采样计入的分钟封顶 5 分钟,防止恢复后一笔爆冲。
//   - 会话从没被采样看到过(启动后立刻关窗):结算按「至少一次采样间隔」兜底,
//     这是写明的启发式,不是实测 —— 数据宁可少记不可虚记。
//   - 短暂的 headless godot 调用(导出/文档构建/--version 探测)若撞上采样点,
//     会贡献 <1 分钟的零头 —— 噪音可接受,不做进程身份甄别。

const { execFile } = require('node:child_process')
const { basename } = require('node:path')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')

const DAY_PREFIX = 'godot/usage/day/'
const SESSION_PREFIX = 'godot/usage/session/'

/** 采样周期 */
const SAMPLE_MS = 60 * 1000
/** 单次采样最多计入的毫秒数(睡眠恢复后实际间隔可能是几十分钟甚至更久,不封顶会一笔爆冲) */
const MAX_CREDIT_MS = 5 * 60 * 1000
/** 连续这么多次采样都看不到 pid 才算会话结束(tasklist 偶发抖动不至于误杀) */
const MISS_TICKS_TO_CLOSE = 2
/** 会话文档保留时长(日汇总文档很小,永久保留;会话按 TTL 清理) */
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000
/** tasklist 对超长映像名的截断宽度(表格列宽,CSV 输出同样受它影响) */
const IMAGE_NAME_MAX = 25

/** @typedef {{name: string, pid: number | null}} ProcRow 运行中的进程行:小写映像名 + pid */
/** @typedef {{day: string, minutes: number, byHour: number[], updatedAt: number}} UsageDayDoc */
/** @typedef {{start: number, end: number | null, pid: number | null, exeBase: string, exePath: string, projectId: string, projectName: string, action: string, day: string, lastSeenAt: number, misses?: number}} UsageSessionDoc */
/** @typedef {{creditedMs: number, running: boolean}} SampleResult */

/** 上次采样时刻(模块级状态;窗口重开时 preload 重载,自然归零) */
/** @type {number | null} */
let lastTick = null
/** 采样链的 setTimeout 句柄;null 表示未在跑(幂等启动的依据) */
/** @type {number | null} */
let timer = null
/** 测试注入的探针;非 null 时替代真实现 */
/** @type {null | (() => Promise<ProcRow[]>)} */
let probeOverride = null

/**
 * 本地时区 YYYY-MM-DD(日文档 id 与 day 字段都用它)。
 * @param {number} ts
 * @returns {string}
 */
function dayKeyOf(ts) {
  const d = new Date(ts)
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 记录开关:settings 文档缺字段(旧版本升级上来)视为开启,仅显式 false 关闭。
 * @returns {boolean}
 */
function readSettingEnabled() {
  const s = getDoc('godot/settings')
  return !s || s.usageTrackingEnabled !== false
}

/**
 * tasklist 的一行 CSV:`"映像名","pid",...` → {name, pid};不匹配的行跳过。
 * @param {string} line
 * @returns {ProcRow | null}
 */
function parseTasklistLine(line) {
  const m = /^"([^"]+)","(\d+)"/.exec(line.trim())
  return m ? { name: m[1].toLowerCase(), pid: Number(m[2]) } : null
}

/**
 * Windows 探针:tasklist /FO CSV /NH 全量列表(单次几十 ms,60s 一次可接受)。
 * @returns {Promise<ProcRow[]>}
 */
function probeWin32() {
  return new Promise((resolve) => {
    /** @param {any} err @param {any} stdout */
    function onList(err, stdout) {
      if (err) {
        resolve([])
        return
      }
      /** @type {ProcRow[]} */
      const rows = []
      for (const line of String(stdout).split(/\r?\n/)) {
        const r = parseTasklistLine(line)
        if (r) rows.push(r)
      }
      resolve(rows)
    }
    try {
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true }, onList)
    } catch (e) {
      resolve([])
    }
  })
}

/**
 * POSIX 探针:`ps -eo pid=,command=`(Linux/macOS 通用),取 argv0 的 basename。
 * @returns {Promise<ProcRow[]>}
 */
function probePosix() {
  return new Promise((resolve) => {
    /** @param {any} err @param {any} stdout */
    function onList(err, stdout) {
      if (err) {
        resolve([])
        return
      }
      /** @type {ProcRow[]} */
      const rows = []
      for (const line of String(stdout).split(/\r?\n/)) {
        const t = line.trim()
        const sp = t.indexOf(' ')
        if (!t || sp === -1) continue
        const pid = Number(t.slice(0, sp))
        const cmd = t.slice(sp + 1).trim()
        if (!Number.isFinite(pid) || !cmd) continue
        rows.push({ name: basename(cmd.split(/\s+/)[0].replace(/\\/g, '/')).toLowerCase(), pid })
      }
      resolve(rows)
    }
    try {
      execFile('ps', ['-eo', 'pid=,command='], onList)
    } catch (e) {
      resolve([])
    }
  })
}

/**
 * 探针分发(测试用 _setProbe 覆盖)。
 * @returns {Promise<ProcRow[]>}
 */
function probe() {
  if (probeOverride) return probeOverride()
  return process.platform === 'win32' ? probeWin32() : probePosix()
}

/**
 * 已登记引擎的映像名集合(小写 basename;「导入本地 exe」的任意命名也在版本文档里)。
 * @returns {string[]}
 */
function knownBases() {
  return listDocs('godot/version/')
    .map((v) => (v && typeof v.exePath === 'string' ? basename(v.exePath.replace(/\\/g, '/')).toLowerCase() : ''))
    .filter(Boolean)
}

/**
 * 进程行是否算「Godot 在跑」:
 * - 映像名以 godot 开头(官方命名,含 console 变体),不要求登记过;
 * - 或与某条已登记引擎的 basename 吻合 —— 允许 tasklist 的 25 字符截断:
 *   截断行必然是完整名的前缀,故用 startsWith。
 * @param {string} name 小写映像名
 * @param {string[]} bases 已知引擎 basename(小写)
 * @returns {boolean}
 */
function isGodotRow(name, bases) {
  if (name.startsWith('godot')) return true
  for (const b of bases) {
    if (name === b || (name.length <= IMAGE_NAME_MAX && b.startsWith(name))) return true
  }
  return false
}

/**
 * 行列表 → pid→小写映像名(pid 为 null 的行不收)。
 * @param {ProcRow[]} rows
 * @returns {Map<number, string>}
 */
function pidMapOf(rows) {
  /** @type {Map<number, string>} */
  const m = new Map()
  for (const r of rows) if (r.pid !== null) m.set(r.pid, r.name)
  return m
}

/**
 * 给当日文档累计(分钟取两位小数;按计费区间中点落入小时桶,小时桶给时段视图备用)。
 * @param {number} ts 采样时刻
 * @param {number} creditMs 本次计入的毫秒数
 * @returns {void}
 */
function creditDay(ts, creditMs) {
  const day = dayKeyOf(ts)
  const id = DAY_PREFIX + day
  const old = /** @type {UsageDayDoc | null} */ (getDoc(id))
  const minutes = creditMs / 60000
  const byHour =
    old && Array.isArray(old.byHour) && old.byHour.length === 24
      ? old.byHour.slice()
      : Array.from({ length: 24 }, () => 0)
  const hour = new Date(ts - creditMs / 2).getHours()
  byHour[hour] = Math.round(((byHour[hour] || 0) + minutes) * 100) / 100
  putDoc(id, {
    day,
    minutes: Math.round(((old ? old.minutes : 0) + minutes) * 100) / 100,
    byHour,
    updatedAt: ts
  })
}

/**
 * 维护 open 会话:命中 pid → 刷新 lastSeenAt;连续 2 次看不到 → 按最后见到时刻结算。
 * 结算 end 不小于「启动 + 一个采样间隔」:启动成功至少计一次间隔,是写明的启发式。
 * @param {ProcRow[]} rows
 * @param {number} ts
 * @returns {void}
 */
function updateSessions(rows, ts) {
  const pids = pidMapOf(rows)
  for (const doc of listDocs(SESSION_PREFIX)) {
    const s = /** @type {UsageSessionDoc & {_id: string, _rev?: string}} */ (doc)
    if (!s || typeof s.start !== 'number' || s.end !== null) continue
    const hit =
      s.pid !== null && pids.has(s.pid) && isGodotRow(/** @type {string} */ (pids.get(s.pid)), [s.exeBase])
    if (hit) {
      s.lastSeenAt = ts
      s.misses = 0
    } else {
      s.misses = (s.misses || 0) + 1
      if (s.misses >= MISS_TICKS_TO_CLOSE) s.end = Math.max(s.lastSeenAt || 0, s.start + SAMPLE_MS)
    }
    // misses 计数必须每轮落库,否则下一轮从文档读回的永远是旧值,永远攒不到关闭阈值
    const { _id, _rev, ...body } = s
    putDoc(_id, body)
  }
}

/**
 * 记录一次从工坊发起的启动会话(launcher spawn 成功后调用;任何失败都不影响启动本身)。
 * @param {{exePath?: string}} version 绑定的引擎版本文档
 * @param {{_id: string, name?: string}} project 项目文档(spawn 成功后的回写版)
 * @param {string} action 'editor' | 'run'
 * @param {number | undefined} [pid] 子进程 pid(spawn 失败或测试桩缺失时 undefined)
 * @returns {boolean} 是否写入
 */
function recordLaunch(version, project, action, pid) {
  try {
    if (!version || !project || !project._id) return false
    if (!readSettingEnabled()) return false
    const start = Date.now()
    const id = SESSION_PREFIX + start + '-' + Math.random().toString(36).slice(2, 8)
    return putDoc(id, {
      start,
      end: null,
      pid: typeof pid === 'number' ? pid : null,
      exeBase: basename(String(version.exePath || '').replace(/\\/g, '/')).toLowerCase(),
      exePath: String(version.exePath || ''),
      projectId: project._id,
      projectName: project.name || '',
      action: action === 'run' ? 'run' : 'editor',
      day: dayKeyOf(start),
      lastSeenAt: start,
      misses: 0
    })
  } catch (e) {
    return false
  }
}

/**
 * 采样一次:查 Godot 进程 → 给当日文档计分钟 → 命中/丢失维护 open 会话。
 * 首次采样(prev 为 null)只探不记 —— 没有区间就谈不上时长。
 * @param {number} [now] 注入的当前时刻(测试用)
 * @returns {Promise<SampleResult>}
 */
async function sampleOnce(now) {
  const ts = typeof now === 'number' ? now : Date.now()
  const prev = lastTick
  lastTick = ts
  const rows = await probe()
  const running = isGodotRowIn(rows)
  let creditedMs = 0
  const enabled = readSettingEnabled()
  if (running && prev !== null && enabled) {
    const elapsed = ts - prev
    if (elapsed > 0) {
      creditedMs = Math.min(elapsed, MAX_CREDIT_MS)
      creditDay(ts, creditedMs)
    }
  }
  // 关闭开关 = 完全暂停:不计分钟,也不维护会话(open 会话留给下次开窗时的 settle 结算)
  if (enabled) updateSessions(rows, ts)
  return { creditedMs, running }
}

/**
 * 本轮行里是否有任何 Godot 进程。
 * @param {ProcRow[]} rows
 * @returns {boolean}
 */
function isGodotRowIn(rows) {
  const bases = knownBases()
  return rows.some((r) => isGodotRow(r.name, bases))
}

/**
 * 窗口打开时的对账:pid 仍在 → 保持 open 交给采样链;不在 → 按 lastSeenAt 结算;
 * 顺带清理超过 TTL 的会话文档。
 * @param {number} [now] 注入的当前时刻(测试用)
 * @returns {Promise<{closed: number, pruned: number, kept: number}>}
 */
async function settle(now) {
  const ts = typeof now === 'number' ? now : Date.now()
  const pids = pidMapOf(await probe())
  let closed = 0
  let pruned = 0
  let kept = 0
  for (const doc of listDocs(SESSION_PREFIX)) {
    const s = /** @type {UsageSessionDoc & {_id: string, _rev?: string}} */ (doc)
    if (!s || typeof s.start !== 'number' || !s._id) continue
    if (s.start < ts - SESSION_TTL_MS) {
      removeDoc(s._id)
      pruned++
      continue
    }
    if (s.end !== null) continue
    const alive =
      s.pid !== null && pids.has(s.pid) && isGodotRow(/** @type {string} */ (pids.get(s.pid)), [s.exeBase])
    if (alive) {
      kept++
      continue
    }
    const { _id, _rev, ...body } = s
    body.end = Math.max(s.lastSeenAt || 0, s.start + SAMPLE_MS)
    body.lastSeenAt = s.lastSeenAt || body.end
    body.misses = 0
    putDoc(_id, body)
    closed++
  }
  return { closed, pruned, kept }
}

/**
 * 采样链的一步:先立即采样,再排下一轮(单链递归 setTimeout,不存在并发重叠;
 * 不用 setInterval 是因为沙箱里刻意不声明它 —— §15 教训的自动护栏)。
 * @returns {void}
 */
function tick() {
  sampleOnce().catch(() => {})
  timer = setTimeout(tick, SAMPLE_MS)
}

/**
 * 渲染层开窗时调用:幂等启动采样链 + 异步对账。纯 Node(无 window.ztools)不开定时器,
 * preload 测试可以直接 require 本模块而不会留下真实计时器。
 * @returns {{ok: boolean, error?: string}}
 */
function usageStart() {
  try {
    if (typeof window === 'undefined' || !window.ztools) return { ok: false, error: '宿主不存在' }
    if (timer === null) tick()
    settle().catch(() => {})
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '启动失败' }
  }
}

/**
 * 测试注入:替换探针实现(传 null 还原)。
 * @param {null | (() => Promise<ProcRow[]>)} fn
 * @returns {void}
 */
function _setProbe(fn) {
  probeOverride = fn
}

module.exports = {
  DAY_PREFIX,
  SESSION_PREFIX,
  dayKeyOf,
  recordLaunch,
  sampleOnce,
  settle,
  usageStart,
  isGodotRow,
  _setProbe
}
