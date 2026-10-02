// launcher 回归测试:启动参数拆分 + 启动失败不掀掉宿主。
//
// 后半部分是线上缺陷的护栏:桌面版「点启动项目,软件就关了」。两条成因都在这里钉住 ——
// ① 唯一窗口被 hideMainWindow 关掉(ZTools 宿主上真会关窗;Tauri 垫片是空实现);
// ② 引擎不可执行时 spawn 报错,而 'error' 是异步事件,没人接就是未捕获异常 → 宿主退出。
// launcher 必须自己接住并让用户看见,而不是静默或陪葬。
//
// 依赖处理:
//   - child_process:打桩(不能真去启动进程,还要能手工触发 'error')
//   - store:打桩(内存 db)
//
// 用法:
//   node src-ztools/preload/lib/__tests__/launcher.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const Module = require('node:module')

const LIB = path.resolve(__dirname, '..')

// ---------- 依赖打桩(必须在 require launcher.js 之前) ----------
function stub(id, exports) {
  const abs = require.resolve(path.join(LIB, id))
  require.cache[abs] = { id: abs, filename: abs, loaded: true, children: [], paths: [], exports }
}

const spawned = []
class FakeChild extends EventEmitter {
  constructor(cmd, args, opts) {
    super()
    this.cmd = cmd
    this.args = args
    this.opts = opts
  }
  unref() { this.unrefed = true }
}
// 内置模块不进 require.cache,只能在模块加载层拦截(否则真会去启动进程)
const realLoad = Module._load
const fakeChildProcess = {
  spawn: (cmd, args, opts) => {
    const child = new FakeChild(cmd, args, opts)
    spawned.push(child)
    return child
  }
}
Module._load = function (request, parent, isMain) {
  if (request === 'node:child_process') return fakeChildProcess
  return realLoad.call(this, request, parent, isMain)
}

const db = new Map()
stub('store.js', {
  getDoc: (id) => (db.has(id) ? { ...db.get(id) } : null),
  putDoc: (id, data) => { db.set(id, { ...data }); return true },
  removeDoc: (id) => { db.delete(id); return true }
})

// 启动失败的兜底通知走宿主 API;launcher 在无 window 的环境(纯 Node)里必须也能跑
const notified = []
global.window = { ztools: { showNotification: (body) => notified.push(body) } }

const { splitLaunchArgs, launchProject } = require(path.join(LIB, 'launcher.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const eq = (actual, expect, label) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, JSON.stringify(actual))

eq(splitLaunchArgs(undefined), [], '未设置参数 → 空数组')
eq(splitLaunchArgs(''), [], '空串 → 空数组')
eq(splitLaunchArgs('   '), [], '纯空白 → 空数组')
eq(splitLaunchArgs('--debug'), ['--debug'], '单参数')
eq(splitLaunchArgs('--resolution 1280x720'), ['--resolution', '1280x720'], '多参数按空白切分')
eq(splitLaunchArgs('"a b" c'), ['a b', 'c'], '引号内空白属于同一参数')
eq(splitLaunchArgs('--x="a b" --y'), ['--x=a b', '--y'], '引号出现在参数中段')
eq(splitLaunchArgs('  --a   --b  '), ['--a', '--b'], '多余空白被忽略')
eq(splitLaunchArgs('未完结"引号'), ['未完结引号'], '未闭合引号不抛错')

// ---------- 启动链路(打桩依赖) ----------
console.log('\n=== 启动失败的分支:一律返回 ok:false,不抛错、不掀宿主 ===')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-launcher-test-'))
const projDir = path.join(WORK, 'proj')
fs.mkdirSync(projDir, { recursive: true })
const projId = 'godot/project/p1'
db.set(projId, { id: projId, name: 'demo', path: projDir })

ok(launchProject({ projectId: 'godot/project/nope', action: 'editor' }).error === '项目不存在', '项目不存在 → 明确提示')

const goneId = 'godot/project/gone'
db.set(goneId, { id: goneId, name: 'gone', path: path.join(WORK, 'not-there') })
ok(launchProject({ projectId: goneId, action: 'editor' }).error === '项目目录不存在', '项目目录不存在 → 明确提示')

const unboundId = 'godot/project/unbound'
db.set(unboundId, { id: unboundId, name: 'unbound', path: projDir })
const unbound = launchProject({ projectId: unboundId, action: 'editor' })
ok(unbound.ok === false && /未绑定可用的 Godot 引擎/.test(String(unbound.error)), '未绑定引擎 → 指引去「版本」页', String(unbound.error))

const missingExe = path.join(WORK, 'Godot_v4.7.2-stable_linux.x86_64')
const versionId = 'godot/version/4.7.2-stable-standard-linux64'
db.set(versionId, { id: versionId, exePath: missingExe, managed: true })
const staleId = 'godot/project/stale'
db.set(staleId, { id: staleId, name: 'stale', path: projDir, versionId })
const stale = launchProject({ projectId: staleId, action: 'editor' })
ok(stale.ok === false && /未绑定可用的 Godot 引擎/.test(String(stale.error)), '引擎文件已不在 → 明确提示而不是崩', String(stale.error))
ok(spawned.length === 0, '以上分支都没有真的去 spawn')

// 引擎存在:正常路径要落到 spawn,并把 launchArgs 拼在动作参数之后
fs.writeFileSync(missingExe, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
const okId = 'godot/project/ok'
db.set(okId, { id: okId, name: 'ok', path: projDir, versionId, launchArgs: '--resolution "1280 720"' })
const launched = launchProject({ projectId: okId, action: 'editor' })
ok(launched.ok === true, '可启动的项目返回 ok', String(launched.error))
ok(spawned.length === 1, 'spawn 被调用一次')
ok(spawned[0].cmd === missingExe, 'spawn 的是绑定引擎的可执行文件', spawned[0].cmd)
eq(spawned[0].args, ['--path', projDir, '-e', '--resolution', '1280 720'], '参数顺序:--path → 动作 → 自定义参数')
ok(spawned[0].opts.detached === true && spawned[0].opts.stdio === 'ignore', '脱离宿主进程独立运行')
ok(spawned[0].unrefed === true, 'unref 掉,不让引擎拖着宿主')
ok(launched.project.openCount === 1 && launched.project.lastOpenedAt > 0, '打开统计已回写')
ok(db.get(okId).openCount === 1, '统计已落库')
if (process.platform !== 'win32') {
  const mode = fs.statSync(missingExe).mode & 0o777
  ok((mode & 0o100) !== 0, '解压丢执行位时自动补上(POSIX)', mode.toString(8))
}
ok(spawned[0].listenerCount('error') > 0, "接了 'error' 监听(不接就是未捕获异常,宿主会退出)")

// 异步启动失败:必须被接住 + 通知用户,而不是掀掉宿主进程
notified.length = 0
let crashed = null
process.once('uncaughtException', (e) => { crashed = e })
spawned[0].emit('error', new Error('spawn ENOEXEC'))
ok(crashed === null, "spawn 的 'error' 不产生未捕获异常(桌面版会在此关闭)")
ok(notified.length === 1 && /启动 Godot 失败/.test(notified[0]), '失败原因经宿主通知浮出', notified.join(' | '))

console.log(`\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
