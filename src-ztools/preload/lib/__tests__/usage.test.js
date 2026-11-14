// usage 单元测试:日累计计费、会话结算、探针匹配(tasklist 截断容错)、宿主守卫。
// 依赖处理:store 打桩(内存 db);探针用 _setProbe 注入,不真跑 tasklist/ps。
// usageStart 在无 window 的纯 Node 里必须不开定时器 —— 也在这里钉住(文件末尾显式
// process.exit,因为带宿主的那一步会真的排一个 setTimeout,不杀掉进程就挂住不退)。
// 用法:node src-ztools/preload/lib/__tests__/usage.test.js
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')

function stub(id, exports) {
  const abs = require.resolve(path.join(LIB, id))
  require.cache[abs] = { id: abs, filename: abs, loaded: true, children: [], paths: [], exports }
}

const db = new Map()
stub('store.js', {
  getDoc: (id) => (db.has(id) ? { ...db.get(id) } : null),
  // 与真 store.js 同形:_id 由封装合并进文档体(否则按前缀 listDocs 会漏)
  putDoc: (id, data) => { db.set(id, { _id: id, ...data }); return true },
  putDocVerbose: (id, data) => { db.set(id, { _id: id, ...data }); return { ok: true, reason: '' } },
  removeDoc: (id) => { db.delete(id); return true },
  listDocs: (prefix) => [...db.values()].filter((d) => String(d._id).startsWith(prefix))
})

const usage = require(path.join(LIB, 'usage.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const eq = (actual, expect, label) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, JSON.stringify(actual))

const sessionsInDb = () => [...db.values()].filter((d) => String(d._id).startsWith(usage.SESSION_PREFIX))

async function main() {
  // ---------- dayKeyOf ----------
  console.log('\n=== dayKeyOf:本地时区 YYYY-MM-DD ===')
  eq(usage.dayKeyOf(new Date(2026, 10, 14, 12, 0, 0).getTime()), '2026-11-14', '正午 → 当天')
  eq(usage.dayKeyOf(new Date(2026, 0, 3, 5, 30).getTime()), '2026-01-03', '月/日补零')

  // ---------- recordLaunch ----------
  console.log('\n=== recordLaunch:会话写入与开关 ===')
  const projId = 'godot/project/p1'
  db.set(projId, { _id: projId, name: 'demo' })
  ok(usage.recordLaunch({ exePath: 'E:/x/Godot_v4.7.2-stable_win64.exe' }, { _id: projId, name: 'demo' }, 'editor', 4321), '正常写入')
  let list = sessionsInDb()
  ok(list.length === 1, '会话文档已写入', list.length)
  const s0 = list[0]
  eq(s0.pid, 4321, '会话带 pid')
  eq(s0.exeBase, 'godot_v4.7.2-stable_win64.exe', 'exeBase 是小写 basename')
  eq(s0.end, null, '初始 end 为 null')
  eq(s0.projectName, 'demo', '项目名快照')
  eq(s0.action, 'editor', '动作归档')
  ok(typeof s0.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s0.day), 'day 是 YYYY-MM-DD')
  ok(usage.recordLaunch(null, { _id: projId }, 'editor', 1) === false, 'version 缺失 → false')
  db.set('godot/settings', { usageTrackingEnabled: false })
  ok(usage.recordLaunch({ exePath: 'E:/x/godot.exe' }, { _id: projId, name: 'demo' }, 'run', 1) === false, '开关关闭 → 跳过')
  db.delete('godot/settings')

  // ---------- isGodotRow ----------
  console.log('\n=== isGodotRow:通用前缀 + 已登记引擎截断容错 ===')
  ok(usage.isGodotRow('godot_v4.exe', []) === true, 'godot 前缀直接命中')
  ok(usage.isGodotRow('chrome.exe', []) === false, '无关进程不命中')
  const longBase = 'mycustombuildeditor_2026_edition.exe'
  ok(usage.isGodotRow(longBase.slice(0, 25), [longBase]) === true, 'tasklist 25 字符截断 → 前缀命中')
  ok(usage.isGodotRow(longBase, [longBase]) === true, '完整名相等命中')
  ok(usage.isGodotRow('myother_editor.exe', [longBase]) === false, '非前缀不误命中')

  // ---------- sampleOnce:计费序列 ----------
  console.log('\n=== sampleOnce:计费/封顶/匹配 ===')
  const T0 = new Date(2026, 10, 14, 10, 0, 0).getTime() // 本地 2026-11-14 10:00
  const dayId = 'godot/usage/day/2026-11-14'
  // 受控会话:start=T0,pid 4321(与探针一致)
  db.set('godot/usage/session/t1', {
    _id: 'godot/usage/session/t1', start: T0, end: null, pid: 4321,
    exeBase: 'godot_v4.7.2-stable_win64.exe', exePath: 'E:/x/Godot_v4.7.2-stable_win64.exe',
    projectId: projId, projectName: 'demo', action: 'editor',
    day: '2026-11-14', lastSeenAt: T0, misses: 0
  })
  usage._setProbe(async () => [{ name: 'godot_v4.7.2-stable_win64.exe', pid: 4321 }])

  let r = await usage.sampleOnce(T0)
  ok(r.running === true && r.creditedMs === 0, '首次采样:探测到但不计(没有区间)')
  ok(db.get(dayId) === undefined, '首次采样不写日文档')

  r = await usage.sampleOnce(T0 + 60_000)
  ok(r.creditedMs === 60_000, '60s 后计 1 分钟', r.creditedMs)
  eq(db.get(dayId).minutes, 1, '日文档 minutes=1')
  eq(db.get(dayId).byHour[10], 1, '落入 10 点小时桶')
  eq(db.get('godot/usage/session/t1').lastSeenAt, T0 + 60_000, '命中会话刷新 lastSeenAt')

  r = await usage.sampleOnce(T0 + 60_000 + 30 * 60_000)
  ok(r.creditedMs === 5 * 60_000, '睡眠 30 分钟 → 封顶 5 分钟', r.creditedMs)
  eq(db.get(dayId).minutes, 6, '日文档 minutes=1+5')

  // ---------- 会话结算:连续 2 次看不到 pid(先做,后续计费步的探针 pid 与会话不符,不能再让它干扰 misses) ----------
  console.log('\n=== 会话结算 ===')
  usage._setProbe(async () => [])
  await usage.sampleOnce(T0 + 60_000 + 31 * 60_000)
  eq(db.get('godot/usage/session/t1').misses, 1, '第 1 次丢失只记 misses')
  eq(db.get('godot/usage/session/t1').end, null, '第 1 次丢失不结算')
  await usage.sampleOnce(T0 + 60_000 + 32 * 60_000)
  const s1 = db.get('godot/usage/session/t1')
  eq(s1.end, T0 + 60_000 + 30 * 60_000, '连续 2 次丢失 → end=最后见到时刻', s1.end)
  // 已结算的会话不再被采样链触碰
  await usage.sampleOnce(T0 + 60_000 + 33 * 60_000)
  eq(db.get('godot/usage/session/t1').end, s1.end, '已结算会话不再被改动')

  // ---------- 其余计费形态(会话已结算,不参与匹配) ----------
  console.log('\n=== sampleOnce:其余计费形态 ===')
  usage._setProbe(async () => [{ name: 'chrome.exe', pid: 9 }])
  r = await usage.sampleOnce(T0 + 60_000 + 34 * 60_000)
  ok(r.running === false && r.creditedMs === 0, '无关进程不计费')

  usage._setProbe(async () => [{ name: 'godot_v4.exe', pid: 7 }])
  r = await usage.sampleOnce(T0 + 60_000 + 35 * 60_000)
  ok(r.running === true && r.creditedMs === 60_000, '未登记的 godot 前缀进程也计费')

  // 截断命中走「已登记引擎」路径:登记一个超长自定义名(不以 godot 开头,排除通用前缀干扰)
  db.set('godot/version/v1', { _id: 'godot/version/v1', exePath: 'E:/x/' + longBase })
  usage._setProbe(async () => [{ name: longBase.slice(0, 25), pid: 11 }])
  r = await usage.sampleOnce(T0 + 60_000 + 36 * 60_000)
  ok(r.running === true && r.creditedMs === 60_000, '已登记引擎的截断映像名计费')
  eq(db.get(dayId).minutes, 8, '日文档 minutes=1+5+1+1')
  db.delete('godot/version/v1')

  // ---------- settle:对账/清理 ----------
  console.log('\n=== settle:活着保持,不在按 lastSeenAt 结算,过期清理 ===')
  db.set('godot/usage/session/a', { _id: 'godot/usage/session/a', start: T0, end: null, pid: 100, exeBase: 'godot_a.exe', projectId: projId, projectName: 'demo', action: 'editor', day: '2026-11-14', lastSeenAt: T0, misses: 0 })
  db.set('godot/usage/session/b', { _id: 'godot/usage/session/b', start: T0, end: null, pid: 200, exeBase: 'godot_b.exe', projectId: projId, projectName: 'demo', action: 'editor', day: '2026-11-14', lastSeenAt: 0, misses: 0 })
  db.set('godot/usage/session/c', { _id: 'godot/usage/session/c', start: T0 - 100 * 86_400_000, end: null, pid: 300, exeBase: 'godot_c.exe', projectId: projId, projectName: 'demo', action: 'editor', day: '2026-08-06', lastSeenAt: T0, misses: 0 })
  usage._setProbe(async () => [{ name: 'godot_a.exe', pid: 100 }])
  const st = await usage.settle(T0 + 3_600_000)
  eq(st, { closed: 1, pruned: 1, kept: 1 }, 'settle 汇总:1 结算 / 1 清理 / 1 保持')
  ok(db.get('godot/usage/session/a').end === null, 'pid 仍活着 → 保持 open')
  ok(db.get('godot/usage/session/b').end === T0 + 60_000, '没见过面的会话按「启动+一个采样间隔」兜底')
  ok(db.get('godot/usage/session/c') === undefined, '超过 90 天的会话被清理')

  // ---------- usageStart:宿主守卫 ----------
  console.log('\n=== usageStart:纯 Node 不开定时器,带宿主才启动 ===')
  eq(usage.usageStart(), { ok: false, error: '宿主不存在' }, '无宿主 → ok:false(不排定时器)')
  usage._setProbe(async () => [])
  global.window = { ztools: {} }
  ok(usage.usageStart().ok === true, '带宿主 → ok:true,采样链已启动')
  ok(usage.usageStart().ok === true, '幂等:重复调用不炸')

  console.log(`\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  // 上一步真的排了 60s 的采样定时器,显式退出杀掉它,否则进程会一直挂着
  process.exit(0)
}

main().catch((e) => {
  console.error('测试执行异常:', e)
  process.exit(1)
})
