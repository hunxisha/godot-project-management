// 导出模板自编译(裁剪向导后半,src-ztools/preload/lib/buildtools.js)的回归测试。
//
// 覆盖:输出解析(scons 版本串在实测里与构建哈希同用点分隔)、vcvars 择位(vswhere 优先/
// fallback)、产物改名映射(scons 的 godot.windows.template_release.* → 官方 tpz 的
// windows_release_*)、检测流程(非 Windows 直接说明;Windows 下缺什么给什么下一步)、
// 构建主流程(bat 生成、尾行收集、取消、失败诊断、产物 stage)—— 全部经 _with 注入接缝,
// 不真跑 scons(闸门②的真实编译已于 2026-10-06 在本机完成,见 docs/template-build-wizard-plan.md)。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/buildtools.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const LIB = path.resolve(__dirname, '..')
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-buildtools-test-'))

// buildtools → templates → store 的 require 链要 window.ztools.db
const docs = new Map()
global.window = { ztools: { db: { get: (id) => (docs.has(id) ? { ...docs.get(id) } : null) } } }
const B = require(path.join(LIB, 'buildtools.js'))
const { install } = (() => {
  // buildtools 自带队列;waitTask 直接用它的实例。队列实例不导出,走任务列表的另一个入口:
  // buildtools 的 watch 订阅拿到快照。为简单起见这里记一个最新的任务 map。
  return { install: null }
})()

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms))

/** 最近一次 watch 快照里的任务表(id → task),给 waitTask 用 */
const seen = new Map()
B.watchTemplateBuildTasks((list) => { for (const t of list) seen.set(t.id, t) })
async function waitTask(id, timeout = 3000) {
  for (let i = 0; i < timeout / 5; i++) {
    const t = seen.get(id)
    if (t && ['done', 'error', 'canceled'].includes(t.status)) return t
    await sleep(5)
  }
  throw new Error('任务超时未完成')
}

/** spawn 桩:记录调用,按脚本吐输出再 close;支持延迟 close(取消用例)与 kill 观察 */
function fakeSpawn(script) {
  const calls = []
  let killed = false
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {
      killed = true
      setTimeout(() => child.emit('close', null, 'SIGTERM'), 10)
    }
    setTimeout(() => {
      if (script.out) child.stdout.emit('data', Buffer.from(script.out))
      if (script.err) child.stderr.emit('data', Buffer.from(script.err))
      setTimeout(() => child.emit('close', script.code ?? 0), script.delay ?? 10)
    }, 1)
    return child
  }
  return { spawn, calls, isKilled: () => killed }
}

async function main() {
  // ---------- 1. 解析纯函数 ----------
  section('1. 输出解析与产物名映射')
  ok(B.parseSconsVersion('SCons by Steven Knight et al.:\n\tSCons: v4.10.1.055b01f429d58b686701a56df863a817c36bb103, Sun, 16 Nov 2025') === '4.10.1',
    '★实测版本串与哈希同用点分隔 → 只取纯数字段(v4.10.1.055b… 的坑)')
  ok(B.parseSconsVersion('SCons: v4.5, ...') === '4.5', '两段版本号也认')
  ok(B.parseSconsVersion('') === '' && B.parseSconsVersion('nothing') === '', '认不出给空串')

  ok(B.mapTemplateFileName('godot.windows.template_release.x86_64.exe') === 'windows_release_x86_64.exe', 'exe → 官方名')
  ok(B.mapTemplateFileName('godot.windows.template_release.x86_64.console.exe') === 'windows_release_x86_64.console.exe', 'console.exe → 官方名')
  ok(B.mapTemplateFileName('godot.windows.template_release.x86_64.lib') === 'windows_release_x86_64.lib', '.lib → 官方名')
  ok(B.mapTemplateFileName('godot.windows.template_release.x86_64.exp') === 'windows_release_x86_64.exp', '.exp → 官方名')
  ok(B.mapTemplateFileName('godot.windows.template_debug.x86_64.exe') === null, 'debug 构建不是模板产物')
  ok(B.mapTemplateFileName('obj') === null, '目录名不是产物')
  ok(B.mapTemplateFileName('godot.windows.template_release.x86_64.exp.new') === null, '别的后缀不认')

  {
    const exists = (p) => p.includes('D:')
    const vc = B.pickVcvars('E:\\vs\\A\nD:\\vs\\B', ['C:\\vs\\C'], exists)
    ok(vc === 'D:\\vs\\B\\VC\\Auxiliary\\Build\\vcvars64.bat',
      '★vswhere 多行里取第一个「vcvars 真存在」的(第一个不存在的跳过)', vc)
    ok(B.pickVcvars('', ['C:\\x', 'D:\\y'], exists) === 'D:\\y\\VC\\Auxiliary\\Build\\vcvars64.bat', 'vswhere 空输出 → fallback 命中')
    ok(B.pickVcvars('', [], exists) === '', '全找不到 → 空串(检查层把它翻成下一步提示)')
  }

  // ---------- 2. 检测流程 ----------
  section('2. 检测:缺什么给什么下一步(闸门③)')
  {
    const r = await B.checkTemplateBuildToolsWith({ platform: 'linux' }, { execSync: () => '', cpuCount: 8 })
    ok(r.ok === false && r.problems.length === 1 && /Windows/.test(r.problems[0]),
      '★非 Windows 宿主直接说明,不给假成功', JSON.stringify(r.problems))
  }
  {
    const seq = []
    const execStub = (cmd) => {
      seq.push(String(cmd))
      if (/--version/.test(cmd) && !/SCons/.test(cmd)) return 'Python 3.12.13'
      if (/SCons/.test(cmd)) return 'SCons by Steven Knight et al.:\n\tSCons: v4.10.1, Sun, 16 Nov 2025'
      if (/vswhere/.test(cmd)) return 'D:\\apps\\Microsoft Visual Studio\\Community'
      throw new Error('unexpected: ' + cmd)
    }
    const r = await B.checkTemplateBuildToolsWith({ platform: 'win32' }, { execSync: execStub, cpuCount: 16 })
    ok(r.ok === true && r.pythonVersion === '3.12.13' && r.sconsVersion === '4.10.1' &&
      r.vcvarsPath.includes('D:\\apps\\Microsoft Visual Studio\\Community') && r.cpuCount === 16 && r.problems.length === 0,
      '★三件套齐:ok、版本、vcvars(经 vswhere 找到非默认盘安装位)、核数都对', JSON.stringify(r))
    ok(seq.some((c) => /python -m SCons --version/.test(c)),
      'SCons 检测走 python -m(不吃 PATH 里的 scons.exe)', seq.join(' | '))
    ok(B.checkCache.vcvarsPath === r.vcvarsPath, '检测结果缓存给构建步(向导第一步本来就是它)')
  }
  {
    const execStub = (cmd) => { throw new Error('no such file') }
    const r = await B.checkTemplateBuildToolsWith({ platform: 'win32' }, { execSync: execStub, cpuCount: 4 })
    ok(r.ok === false && r.problems.length === 2 &&
      /Python 3/.test(r.problems[0]) && /C\+\+ 的桌面开发/.test(r.problems[1]),
      '★全缺:problems 各带下一步动作(python 缺时 SCons 没有运行入口,装好 python 重检才会轮到它)',
      JSON.stringify(r.problems))
    ok(B.checkCache.vcvarsPath === '', '缺工具链时不给构建步留路径')
  }

  // ---------- 3. 构建主流程 ----------
  section('3. 构建:bat 生成 → 尾行 → stage(注入 spawn,不真编译)')
  {
    // 未检测就 build → 同步拒(防呆:向导第一步被跳过的异常用法)。
    // 前面的检测用例填过缓存,这里清空还原「第一步没跑过」的状态,测完恢复。
    const savedVcvars = B.checkCache.vcvarsPath
    B.checkCache.vcvarsPath = ''
    const r0 = B.buildTemplatePackWith({ srcDir: 'E:\\src', tag: '4.7.2-stable' }, { spawn: () => { throw new Error('should not spawn') }, statfsSync: () => ({ bsize: 4096, bavail: 1e9 }) })
    ok(r0.ok === false && /工具链检测/.test(r0.error || ''), '★没跑过检测就 build → 拒绝并指向第一步', r0.error)
    B.checkCache.vcvarsPath = savedVcvars

    // 夹具源码
    const src = path.join(WORK, 'src')
    fs.mkdirSync(path.join(src, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(src, 'SConstruct'), "// SConstruct\n")
    fs.writeFileSync(path.join(src, 'bin', 'godot.windows.template_release.x86_64.exe'), 'exe-body')
    fs.writeFileSync(path.join(src, 'bin', 'godot.windows.template_release.x86_64.console.exe'), 'con-body')
    fs.writeFileSync(path.join(src, 'bin', 'godot.windows.template_debug.x86_64.exe'), 'should-not-copy')
    fs.writeFileSync(path.join(src, 'bin', 'obj'), 'dir-like')

    B.checkCache.vcvarsPath = 'D:\\vs\\VC\\Auxiliary\\Build\\vcvars64.bat'
    const f = fakeSpawn({ out: 'Generating shaders...\nLinking Program bin\\godot.windows.template_release.x86_64.exe...\nscons: done building targets.', code: 0 })
    let wrote = ''
    const origWrite = fs.writeFileSync
    const fsStub = new Proxy(fs, {}) // 不换 fs:bat 内容用 spawn 参数断言前直接读真文件
    const r = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable' }, { spawn: f.spawn, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
    ok(r.ok === true && !!r.taskId, '构建入队成功', r.error)
    const t = await waitTask(r.taskId, 5000)
    ok(t.status === 'done', `任务完成(${t.status} ${t.error || ''})`, JSON.stringify(t))
    ok(f.calls.length === 1 && f.calls[0].cmd === 'cmd.exe' && /build-.*\.bat$/.test(f.calls[0].args[3]),
      '编译经临时 bat 文件执行(路径带空格的 vcvars 手动实测同形态)', JSON.stringify(f.calls[0].args))
    const bat = f.calls[0].args[3]
    ok(fs.existsSync(bat) === false, '★构建脚本用完即删(临时目录不留 .bat 残骸)')
    ok(typeof t.stageDir === 'string' && fs.existsSync(path.join(t.stageDir, 'templates', 'windows_release_x86_64.exe')) &&
      fs.readFileSync(path.join(t.stageDir, 'templates', 'windows_release_x86_64.exe'), 'utf8') === 'exe-body',
      '★产物改名进 stage/templates(官方 tpz 文件名形态,给目录形态导入吃)')
    ok(fs.existsSync(path.join(t.stageDir, 'templates', 'windows_release_x86_64.console.exe')), 'console 包装器也进 stage')
    ok(!fs.existsSync(path.join(t.stageDir, 'templates', 'windows_release_x86_64.exe.debug')) &&
      !fs.readFileSync(path.join(t.stageDir, 'templates', 'windows_release_x86_64.exe'), 'utf8').includes('should-not-copy'),
      'debug 产物与非模板文件不进 stage')
    ok(t.versionDir === '4.7.2.stable' && t.files === 2, '任务带 versionDir(tag 派生)与文件数', `${t.versionDir}/${t.files}`)
    ok(/scons: done building targets\./.test(t.log), '尾行留在任务上(完成态也是)', t.log)
    void wrote; void fsStub; void origWrite
  }
  {
    // 编译失败:退出码 + 尾行进 errorDetail
    const src = path.join(WORK, 'src-fail')
    fs.mkdirSync(path.join(src, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(src, 'SConstruct'), 'x')
    fs.writeFileSync(path.join(src, 'bin', 'godot.windows.template_release.x86_64.exe'), 'x')
    const f = fakeSpawn({ err: 'ERROR: The Direct3D 12 rendering driver requires dependencies', code: 2 })
    const r = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable' }, { spawn: f.spawn, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
    const t = await waitTask(r.taskId, 5000)
    ok(t.status === 'error' && /退出码 2/.test(t.error || '') && /Direct3D 12/.test(t.errorDetail || ''),
      '★失败带退出码,原话尾部进 errorDetail(闸门③:诊断信息不丢)', `${t.error} / ${t.errorDetail}`)
  }
  {
    // 取消:kill 子进程,状态 canceled
    const src = path.join(WORK, 'src-cancel')
    fs.mkdirSync(path.join(src, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(src, 'SConstruct'), 'x')
    const f = fakeSpawn({ out: 'compiling...', code: 0, delay: 800 })
    const r = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable' }, { spawn: f.spawn, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
    await sleep(60)
    B.cancelTemplateBuildTask(r.taskId)
    ok(f.isKilled(), '★取消真的 kill 了 scons 子进程(不是只改状态)')
    const t = await waitTask(r.taskId, 5000)
    ok(t.status === 'canceled', '取消后状态 canceled', t.status)
    B.dismissTemplateBuildTask(r.taskId)
    ok(!seen.get(r.taskId) || seen.get(r.taskId).status === 'canceled', 'dismiss 不抛错(列表快照按宿主实现为准)')
  }
  {
    // 空间闸与形态闸
    const src = path.join(WORK, 'src-disk')
    fs.mkdirSync(path.join(src, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(src, 'SConstruct'), 'x')
    const rD = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable' }, { spawn: () => {}, statfsSync: () => ({ bsize: 4096, bavail: 1024 }) })
    ok(rD.ok === false && /剩余空间不足 20 GB/.test(rD.error || ''), '★磁盘不足 20GB 在入队前被拦(40 分钟后才知道放不下就太晚了)', rD.error)
    const noSconstruct = path.join(WORK, 'not-godot')
    fs.mkdirSync(noSconstruct, { recursive: true })
    const rS = B.buildTemplatePackWith({ srcDir: noSconstruct, tag: '4.7.2-stable' }, { spawn: () => {}, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
    ok(rS.ok === false && /SConstruct/.test(rS.error || ''), '不是 Godot 源码根 → 同步拒绝', rS.error)
  }

  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:\n - ' + failures.join('\n - '))
    process.exit(1)
  }
  console.log('全部通过')
  fs.rmSync(WORK, { recursive: true, force: true })
}

main().catch((e) => { console.error(e); process.exit(1) })
