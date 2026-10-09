// 导出模板自编译(裁剪向导后半,src-ztools/preload/lib/buildtools.js)的回归测试。
//
// 覆盖:输出解析(scons 版本串在实测里与构建哈希同用点分隔)、vcvars 择位(vswhere 优先/
// fallback)、产物改名映射(scons 的 godot.windows.template_release.* → 官方 tpz 的
// windows_release_*)、检测流程(非 Windows 直接说明;Windows 下缺什么给什么下一步)、
// 构建主流程(bat + profile 两份临时文件的生成、两条裁剪通道的划分、尾行收集、取消、
// 失败诊断、产物 stage)、入队前的源码版本闸、两份临时文件在每条终态分支都同进同退
// (取消 / 非 0 退出 / 写盘失败 / 子进程起不来)—— 全部经 _with 注入接缝,
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

/** spawn 桩:记录调用,按脚本吐输出再 close;支持延迟 close(取消用例)与 kill 观察。
 * script.spawnError 走另一条形态:子进程根本起不来 → 只有 'error' 事件、没有 'close'
 * (真实宿主里 cmd.exe 被 AV 拦 / PATH 被清就是这样,是这条路的主要失效形态)。 */
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
    if (script.spawnError) {
      setTimeout(() => child.emit('error', script.spawnError), script.delay ?? 10)
      return child
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

/**
 * 节选自真实 4.7.2-stable 的 version.py 的四个字段(**合成形态,非整文件逐字**):
 * 字段名与值形态(裸整数 + 带引号 status)取自真实文件,其余部分省略。
 * patch 不为 0 是有意的 —— `4.7.0` 会被 parseVersionPy 拼成 `4.7`,与 tag 同形的那条另测。
 */
const VERSION_PY_472 = 'major = 4\nminor = 7\npatch = 2\nstatus = "stable"\n'

/**
 * 建一棵能过入队前同步闸(有 SConstruct、version.py 读得出)的最小源码树。
 * 两份文件都是**合成形态**:SConstruct 只一行注释,不重造 `BoolVariable(...)` 声明与
 * `modules/<名>/config.py` 三件套 —— 那套逐字形态由 tplprobe.test.js 守着,两处各造一份必然长歪。
 * 需要选项表时走 runBuild 注入 probeSource 桩。
 * @param {string} name
 * @param {{versionPy?: string, artifacts?: boolean}} [opts]
 * @returns {string} 树根目录
 */
function makeTree(name, opts) {
  const o = opts || {}
  const dir = path.join(WORK, name)
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'SConstruct'), '// SConstruct(合成形态:只当源码根判据,不含变量声明)\n')
  fs.writeFileSync(path.join(dir, 'version.py'), o.versionPy || VERSION_PY_472)
  if (o.artifacts) {
    fs.writeFileSync(path.join(dir, 'bin', 'godot.windows.template_release.x86_64.exe'), 'exe-body')
    fs.writeFileSync(path.join(dir, 'bin', 'godot.windows.template_release.x86_64.console.exe'), 'con-body')
    fs.writeFileSync(path.join(dir, 'bin', 'godot.windows.template_debug.x86_64.exe'), 'should-not-copy')
    fs.writeFileSync(path.join(dir, 'bin', 'obj'), 'dir-like')
  }
  return dir
}

/**
 * 抓 buildtools 写进临时目录的 .bat 与 .json 内容。
 * 这两份文件都在 `child.on('close')` 里被删,构建结束后根本读不到,只能在写入那一刻拦。
 * buildtools.js 与本文件 require('node:fs') 拿到的是同一个模块对象,所以打补丁生效 ——
 * 不为此新开一条注入通道(通道越多,执行层与测试各说各话的机会越多)。
 * @param {'bat'|'json'} [failOn] 让写这一类文件时**抛错**(模拟磁盘满 / 目录被锁 / AV 拦第二次写),
 *   另一类照常落盘 —— 用来钉「写盘失败这条终态也要把已经落盘的那份删掉」。
 *   抛在记录之前,所以 captured 里只有真落盘的那几份(不给"没写成却记了一条"留空转)。
 */
function startTmpCapture(failOn) {
  /** @type {{file: string, text: string}[]} */
  const captured = []
  const orig = fs.writeFileSync
  fs.writeFileSync = (fp, data, ...rest) => {
    const name = String(fp)
    const base = path.basename(name)
    if (/^ztools-godot-(build|profile)-/.test(base)) {
      if (failOn && base.endsWith('.' + failOn)) throw new Error(`模拟写盘失败: ${base}`)
      captured.push({ file: name, text: String(data) })
    }
    return orig.apply(fs, [fp, data, ...rest])
  }
  return {
    captured,
    /** @param {'bat'|'json'} ext */
    text: (ext) => (captured.find((c) => c.file.endsWith('.' + ext)) || { text: '' }).text,
    /** @param {'bat'|'json'} ext */
    file: (ext) => (captured.find((c) => c.file.endsWith('.' + ext)) || { file: '' }).file,
    restore: () => { fs.writeFileSync = orig }
  }
}

/**
 * 注入给 buildtools 的探测桩:一份「探到了两个核心 flag 与两个模块开关」的源码。
 * options 形态与 tplprobe 的 OptionMap 逐字同形(`{ exists: true, default: … }`),
 * 默认值取真实 4.7.2 的形态(disable_3d 默认 False、vulkan 与各模块默认 True)。
 * 桩**照实记下每次收到的 srcDir**(挂在 `fn.received`):Ruling #45 的护栏要证明的是
 * 「buildtools 真调到了探测接缝、且 srcDir 传的就是入队时那个目录」——
 * 只有间接证据(传错目录 → 真探测 ok:false → 别的断言变红)不算直接证明。
 * @param {Record<string, {exists: true, default: boolean|string}>} [overrides]
 * @returns {((srcDir: string) => Promise<any>) & { received: string[] }}
 */
function probeStub(overrides) {
  /** @type {string[]} */
  const received = []
  const fn = async (srcDir) => {
    received.push(srcDir)
    return {
      ok: true, error: '', sourceVersion: '4.7.2-stable', tested: true, tagMatched: true,
      cascades: {}, testedVersions: [],
      options: {
        disable_3d: { exists: true, default: false },
        vulkan: { exists: true, default: true },
        module_regex_enabled: { exists: true, default: true },
        module_zip_enabled: { exists: true, default: true },
        ...(overrides || {})
      }
    }
  }
  return Object.assign(fn, { received })
}

/**
 * 跑一次完整构建(注入 spawn 与探测),等它落到终态,把两份临时文件的内容一起取回来。
 * @param {string} srcDir @param {Record<string, boolean>} features
 * @param {(srcDir: string) => any} probe @param {'default-on'|'default-off'} [mode]
 */
async function runBuild(srcDir, features, probe, mode) {
  const f = fakeSpawn({ out: 'scons: done building targets.', code: 0 })
  const cap = startTmpCapture()
  try {
    /** @type {Record<string, any>} */
    const params = { srcDir, tag: '4.7.2-stable', features, jobs: 8 }
    if (mode) params.mode = mode
    const r = B.buildTemplatePackWith(params, {
      spawn: f.spawn, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }), probeSource: probe
    })
    const t = r.ok ? await waitTask(r.taskId, 5000) : null
    const bat = cap.text('bat')
    const sconsLine = bat.split(/\r?\n/).find((l) => l.startsWith('scons ')) || ''
    return {
      r, t, bat, calls: f.calls,
      profilePath: cap.file('json'),
      /** profile 的 disabled_build_options;没写盘就是 null(断言按 null 安全比较,不抛) */
      dbo: cap.text('json') ? (JSON.parse(cap.text('json')).disabled_build_options || null) : null,
      sconsLine,
      /** 命令行形状(把逐次变化的 profile 临时路径抹掉,跨次运行才可比) */
      lineShape: sconsLine.replace(`"${cap.file('json')}"`, () => '"<profile>"')
    }
  } finally { cap.restore() }
}

/**
 * 把 dbo 的键按「是不是模块开关」分堆 —— 两条通道划分判据的反向检查用。
 * @param {Record<string, any>} dbo
 * @returns {string[]} 非 module_* 的键
 */
function nonModuleKeys(dbo) {
  return Object.keys(dbo || {}).filter((k) => !/^module_.*_enabled$/.test(k))
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
    // existsSync 桩:检测的 vcvars 落点是 Windows 路径,Linux CI 上真 existsSync 必然 false ——
    // 注入桩让「三件套齐」的流程跨平台确定(真实存在性由真宿主的人工验收 T8 管)
    const r = await B.checkTemplateBuildToolsWith({ platform: 'win32' },
      { execSync: execStub, cpuCount: 16, existsSync: (p) => p.includes('D:') })
    ok(r.ok === true && r.pythonVersion === '3.12.13' && r.sconsVersion === '4.10.1' &&
      r.vcvarsPath.includes('D:\\apps\\Microsoft Visual Studio\\Community') && r.cpuCount === 16 && r.problems.length === 0,
      '★三件套齐:ok、版本、vcvars(经 vswhere 找到非默认盘安装位)、核数都对', JSON.stringify(r))
    ok(seq.some((c) => /python -m SCons --version/.test(c)),
      'SCons 检测走 python -m(不吃 PATH 里的 scons.exe)', seq.join(' | '))
    ok(B.checkCache.vcvarsPath === r.vcvarsPath, '检测结果缓存给构建步(向导第一步本来就是它)')
  }
  {
    const execStub = (cmd) => { throw new Error('no such file') }
    const r = await B.checkTemplateBuildToolsWith({ platform: 'win32' },
      { execSync: execStub, cpuCount: 4, existsSync: () => false })
    ok(r.ok === false && r.problems.length === 2 &&
      /Python 3/.test(r.problems[0]) && /C\+\+ 的桌面开发/.test(r.problems[1]),
      '★全缺:problems 各带下一步动作(python 缺时 SCons 没有运行入口,装好 python 重检才会轮到它)',
      JSON.stringify(r.problems))
    ok(B.checkCache.vcvarsPath === '', '缺工具链时不给构建步留路径')
  }

  // ---------- 3. 构建主流程 ----------
  section('3. 构建:bat + profile 生成 → 尾行 → stage(不注入探测 —— 走真实 tplprobe)')
  {
    // 未检测就 build → 同步拒(防呆:向导第一步被跳过的异常用法)。
    // 前面的检测用例填过缓存,这里清空还原「第一步没跑过」的状态,测完恢复。
    const savedVcvars = B.checkCache.vcvarsPath
    B.checkCache.vcvarsPath = ''
    const r0 = B.buildTemplatePackWith({ srcDir: 'E:\\src', tag: '4.7.2-stable', features: {} }, { spawn: () => { throw new Error('should not spawn') }, statfsSync: () => ({ bsize: 4096, bavail: 1e9 }) })
    ok(r0.ok === false && /工具链检测/.test(r0.error || ''), '★没跑过检测就 build → 拒绝并指向第一步(版本闸不许抢在它前面)', r0.error)
    B.checkCache.vcvarsPath = savedVcvars

    B.checkCache.vcvarsPath = 'D:\\vs\\VC\\Auxiliary\\Build\\vcvars64.bat'
    const src = makeTree('src', { artifacts: true })
    const f = fakeSpawn({ out: 'Generating shaders...\nLinking Program bin\\godot.windows.template_release.x86_64.exe...\nscons: done building targets.', code: 0 })
    const cap = startTmpCapture()
    try {
      const r = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable', features: { sys3d: false, uiRegex: false }, jobs: 8 }, { spawn: f.spawn, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
      ok(r.ok === true && !!r.taskId, '构建入队成功', r.error)
      const t = await waitTask(r.taskId, 5000)
      ok(t.status === 'done', `任务完成(${t.status} ${t.error || ''})`, JSON.stringify(t))
      ok(f.calls.length === 1 && f.calls[0].cmd === 'cmd.exe' && /build-.*\.bat$/.test(f.calls[0].args[3]),
        '编译经临时 bat 文件执行(路径带空格的 vcvars 手动实测同形态)', JSON.stringify(f.calls[0].args))
      const batPath = f.calls[0].args[3]
      const bat = cap.text('bat')
      ok(bat !== '' && cap.file('json') !== '' && cap.text('json') !== '',
        '★两份临时文件都真写了盘(后面所有断言的前提,防"读不到东西还恒真")', cap.file('json'))
      ok(fs.existsSync(batPath) === false, '★构建脚本用完即删(临时目录不留 .bat 残骸)')
      ok(fs.existsSync(cap.file('json')) === false, '★临时 profile 同样用完即删')
      ok(bat.includes(`call "D:\\vs\\VC\\Auxiliary\\Build\\vcvars64.bat"`), 'bat 里 call 的是检测缓存的 vcvars', bat)
      const sconsLine = bat.split(/\r?\n/).find((l) => l.startsWith('scons ')) || ''
      ok(sconsLine === `scons platform=windows target=template_release build_profile="${cap.file('json')}" -j8`,
        '★scons 行前缀逐字恒定,可变部分全在 -j 之前', sconsLine)
      // 这棵真树只有 SConstruct + version.py:真实的 tplprobe.probeSource 在上面探不到任何
      // BoolVariable,也没有 modules/ 目录 → 两个通道都该是空的。这就是"接线接到了真探测"的
      // 可观察后果 —— 桩若被写死成一份完整选项表,这里会冒出 disable_3d=yes 与 module_regex_enabled。
      ok(!/disable_3d=yes/.test(bat), '★未注入探测:这份源码没探到 disable_3d → 一个核心 token 都不发(未声明的 scons 变量是静默失效的)')
      const realProbeKeys = Object.keys((cap.text('json') ? JSON.parse(cap.text('json')) : { disabled_build_options: null }).disabled_build_options || { x: 1 })
      ok(realProbeKeys.length === 0, '★未注入探测:profile 照样写盘但一个 module_* 都不猜', cap.text('json'))
      ok(Array.isArray(t.writtenFlags) && t.writtenFlags.length === 0, 'writtenFlags 随空探测落空,任务不因此失败', JSON.stringify(t.writtenFlags))
      ok(typeof t.stageDir === 'string' && fs.existsSync(path.join(t.stageDir, 'templates', 'windows_release_x86_64.exe')) &&
        fs.readFileSync(path.join(t.stageDir, 'templates', 'windows_release_x86_64.exe'), 'utf8') === 'exe-body',
        '★产物改名进 stage/templates(官方 tpz 文件名形态,给目录形态导入吃)')
      ok(fs.existsSync(path.join(t.stageDir, 'templates', 'windows_release_x86_64.console.exe')), 'console 包装器也进 stage')
      ok(!fs.existsSync(path.join(t.stageDir, 'templates', 'windows_release_x86_64.exe.debug')) &&
        !fs.readFileSync(path.join(t.stageDir, 'templates', 'windows_release_x86_64.exe'), 'utf8').includes('should-not-copy'),
        'debug 产物与非模板文件不进 stage')
      ok(t.versionDir === '4.7.2.stable' && t.files === 2, '任务带 versionDir(tag 派生)与文件数', `${t.versionDir}/${t.files}`)
      ok(/scons: done building targets\./.test(t.log), '尾行留在任务上(完成态也是)', t.log)
    } finally { cap.restore() }
  }
  {
    // 编译失败:退出码 + 尾行进 errorDetail
    const src = makeTree('src-fail')
    fs.writeFileSync(path.join(src, 'bin', 'godot.windows.template_release.x86_64.exe'), 'x')
    const f = fakeSpawn({ err: 'ERROR: The Direct3D 12 rendering driver requires dependencies', code: 2 })
    const r = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable', features: {} }, { spawn: f.spawn, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
    const t = await waitTask(r.taskId, 5000)
    ok(t.status === 'error' && /退出码 2/.test(t.error || '') && /Direct3D 12/.test(t.errorDetail || ''),
      '★失败带退出码,原话尾部进 errorDetail(闸门③:诊断信息不丢)', `${t.error} / ${t.errorDetail}`)
  }
  {
    // 取消:kill 子进程,状态 canceled;两份临时文件都要清掉
    const src = makeTree('src-cancel')
    const f = fakeSpawn({ out: 'compiling...', code: 0, delay: 800 })
    const cap = startTmpCapture()
    let taskId = ''
    try {
      const r = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable', features: {} }, { spawn: f.spawn, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
      taskId = r.taskId
      await sleep(60)
      B.cancelTemplateBuildTask(taskId)
      ok(f.isKilled(), '★取消真的 kill 了 scons 子进程(不是只改状态)')
      const t = await waitTask(taskId, 5000)
      ok(t.status === 'canceled', '取消后状态 canceled', t.status)
      // canceled 状态是 cancelTemplateBuildTask 自己写的,close 回调(连同清理)还在 10ms 之后 ——
      // 不等一下就在盘上看文件,测的是竞态不是清理。
      await sleep(60)
      ok(cap.captured.length > 0 && cap.captured.every((c) => !fs.existsSync(c.file)),
        '★取消路径同样不留 .bat/.json 残骸', JSON.stringify(cap.captured.map((c) => c.file)))
    } finally { cap.restore() }
    B.dismissTemplateBuildTask(taskId)
    ok(!seen.get(taskId) || seen.get(taskId).status === 'canceled', 'dismiss 不抛错(列表快照按宿主实现为准)')
  }
  {
    // 空间闸与形态闸
    const src = makeTree('src-disk')
    const rD = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable', features: {} }, { spawn: () => { throw new Error('should not spawn') }, statfsSync: () => ({ bsize: 4096, bavail: 1024 }) })
    ok(rD.ok === false && /剩余空间不足 20 GB/.test(rD.error || ''), '★磁盘不足 20GB 在入队前被拦(40 分钟后才知道放不下就太晚了)', rD.error)
    const noSconstruct = path.join(WORK, 'not-godot')
    fs.mkdirSync(noSconstruct, { recursive: true })
    const rS = B.buildTemplatePackWith({ srcDir: noSconstruct, tag: '4.7.2-stable', features: {} }, { spawn: () => { throw new Error('should not spawn') }, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
    ok(rS.ok === false && /SConstruct/.test(rS.error || ''), '不是 Godot 源码根 → 同步拒绝', rS.error)
    const rF = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable' }, { spawn: () => { throw new Error('should not spawn') }, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
    ok(rF.ok === false && /功能勾选/.test(rF.error || ''), '★缺 features → 同步拒绝(执行层不替面板猜默认勾选)', rF.error)
  }

  // ---------- 4. 两条通道 ----------
  section('4. 两条通道:module_* 进 profile 文件,核心 flag 进命令行 token')
  {
    const src = makeTree('src-two', { artifacts: true })
    const stub = probeStub()
    const a = await runBuild(src, { sys3d: false, uiRegex: false }, stub)
    const pfx = (o) => `scons platform=windows target=template_release build_profile="${o.profilePath}"`
    ok(a.t && a.t.status === 'done', '取消 3D + 取消正则:任务走完', a.t && a.t.error)
    ok(a.sconsLine === `${pfx(a)} disable_3d=yes -j8`,
      '★用户取消的核心 flag 必须以 token 出现在行上(前缀逐字恒定、-j 收尾)', a.sconsLine)
    ok(a.profilePath.endsWith('.json') && a.bat.includes(`build_profile="${a.profilePath}"`),
      '★行上的 build_profile 就是真写了盘的那个路径', a.profilePath)
    ok(JSON.stringify(a.dbo) === '{"module_regex_enabled":false}',
      '★模块开关进 profile 文件(dbo 里逐字只有它)', JSON.stringify(a.dbo))
    ok(!/module_[a-z0-9_]+_enabled=/.test(a.sconsLine), '★行上不得出现任何 module_ token(模块一律只在 profile 文件里)')
    ok(nonModuleKeys(a.dbo || {}).length === 0 && Object.keys(a.dbo || {}).length > 0,
      '★profile 的 dbo 里不得出现非 module_* 键(T5 遍历守卫在下游的镜像)', JSON.stringify(a.dbo))
    ok(JSON.stringify(a.t.writtenFlags) === '["disable_3d","module_regex_enabled"]',
      'writtenFlags 把两个通道的键都记下(排序后)', JSON.stringify(a.t.writtenFlags))
    ok(a.t.profilePath === a.profilePath, '任务上带 profilePath', a.t.profilePath)
    ok(fs.existsSync(a.profilePath) === false, '临时 profile 构建后已被清理')

    const b = await runBuild(src, { sys3d: false, uiRegex: true }, stub)
    ok(b.lineShape === a.lineShape,
      '★只改模块勾选 → 命令行逐字不变(可变部分只随核心 flag 的改动数变,不随模块勾选变)', b.lineShape)
    ok(JSON.stringify(b.dbo) === '{}',
      '勾回正则后 profile 里没有它(与源码默认相同就不输出)', JSON.stringify(b.dbo))

    const c = await runBuild(src, { sys3d: true, uiRegex: false }, stub)
    ok(c.lineShape === 'scons platform=windows target=template_release build_profile="<profile>" -j8',
      '★只改核心 flag → 命令行随之变短(3D 是源码默认,不点名就不发 token)', c.lineShape)
    ok(JSON.stringify(c.dbo) === '{"module_regex_enabled":false}',
      '模块通道不受核心 flag 影响', JSON.stringify(c.dbo))

    const d = await runBuild(src, { sys3d: false, uiRegex: true }, stub, 'default-off')
    ok(d.sconsLine === `${pfx(d)} disable_3d=yes modules_enabled_by_default=no -j8`,
      '★params.mode 透传到 buildProfile:反向白名单的命令行键出现且按字典序', d.sconsLine)
    ok(JSON.stringify(d.dbo) === '{"module_regex_enabled":true}',
      '反向白名单下保留的模块显式点名 true(不点名的会被整体关掉)', JSON.stringify(d.dbo))
    ok(!/module_/.test(d.sconsLine) && nonModuleKeys(d.dbo || {}).length === 0,
      '反向白名单同样守住两条通道的划分')
    // Ruling #45 的直接证据:探测接缝被真调用过 4 次(本节 4 次 runBuild,一次构建一次探测),
    // 且每次收到的都是入队时那个 srcDir —— 传错目录(比如临时目录或 stage 目录)这里就红。
    ok(stub.received.length === 4 && stub.received.every((d2) => d2 === src),
      '★每次构建真调到了探测接缝,且收到的 srcDir 就是入队传进去的那个目录', JSON.stringify(stub.received))
  }

  // ---------- 5. 探测失败 ----------
  section('5. 探测失败:任务转 error,一次 scons 都不起')
  {
    const src = makeTree('src-probe')
    // 真树上这一支不可达(缺 SConstruct 已被入队前的同步闸拦在前面),所以只能注入 ——
    // 它守的是"探测层报了 ok:false 就别接着编"这条契约,不是真实路径的复现。
    const a = await runBuild(src, { sys3d: false }, async () => ({
      ok: false, error: '所选目录不是 Godot 源码根(缺 SConstruct),无法探测构建选项', options: {}
    }))
    ok(a.t && a.t.status === 'error' && /无法探测构建选项/.test(a.t.error || ''),
      '★probeSource 返回 ok:false → 任务转 error 并原样带上它的说法', a.t && a.t.error)
    ok(a.calls.length === 0 && a.bat === '' && a.profilePath === '',
      '★探测失败时不落任何临时文件、不起 scons', `${a.calls.length}/${a.bat}`)

    const b = await runBuild(src, { sys3d: false }, () => Promise.reject(new Error('探测炸了')))
    ok(b.t && b.t.status === 'error' && /探测构建选项失败/.test(b.t.error || '') && /探测炸了/.test(b.t.error || ''),
      '★probeSource 抛/reject 也转 error 并带原因(作业里 throw 出去 = 未捕获拒绝 + 这个任务永远停在 building;队列本身不塌)', b.t && b.t.error)
    ok(b.calls.length === 0, 'reject 分支同样不起 scons')
  }

  // ---------- 6. 源码版本闸 ----------
  section('6. 源码版本闸(入队前同步拒绝)')
  {
    const src = makeTree('src-ver')
    const no = path.join(WORK, 'not-godot-ver')
    fs.mkdirSync(no, { recursive: true })
    // 四条拒绝用例全部走 buildTemplatePackWith + 「一被调用就抛」的 spawn 桩(Ruling #48):
    // 用未注入的 buildTemplatePack 时,一旦 stable 闸或版本闸回归,这几条会真的 enqueue、
    // 用真 fs.statfsSync 并 spawn 真 cmd.exe 去跑一份假源码目录 —— 测试套件不该能在人不知情时起真进程。
    // 同文件 :260 / :345 就是这个写法。放行用例仍另配 fakeSpawn(见下面 f5/f47)。
    const gateDeps = () => ({
      spawn: () => { throw new Error('不应 spawn:闸门失守才会走到这里') },
      statfsSync: () => ({ bsize: 4096, bavail: 1e7 })
    })
    const r1 = B.buildTemplatePackWith({ srcDir: src, tag: '4.6-stable', features: {} }, gateDeps())
    ok(r1.ok === false && /源码版本不符/.test(r1.error || '') && /4\.6-stable/.test(r1.error || '') && /4\.7\.2-stable/.test(r1.error || ''),
      '★版本不符 → 同步拒绝且串里带两个版本', r1.error)
    const r2 = B.buildTemplatePackWith({ srcDir: no, tag: '4.7.2-stable', features: {} }, gateDeps())
    ok(r2.ok === false && /SConstruct/.test(r2.error || ''), '缺 SConstruct → 同步拒绝', r2.error)
    // Ruling #44:versionStringFromTag 不规范化,预发布 tag 与带 v 前缀的 tag 都会被上面那句
    // 判成"源码版本不符" —— 那是给错方向的建议(用户的源码是对的,错的是 tag 形态)。
    const r3 = B.buildTemplatePackWith({ srcDir: src, tag: '4.4-beta1', features: {} }, gateDeps())
    ok(r3.ok === false && /stable/.test(r3.error || '') && !/源码版本不符/.test(r3.error || ''),
      '★预发布 tag(4.4-beta1)→ 走「只支持 stable」的专门文案,不是「源码版本不符」', r3.error)
    const r4 = B.buildTemplatePackWith({ srcDir: src, tag: 'v4.7.2-stable', features: {} }, gateDeps())
    ok(r4.ok === false && /stable/.test(r4.error || '') && !/源码版本不符/.test(r4.error || ''),
      '★带 v 前缀的 tag 同走专门文案(不做规范化、不猜用户想要哪个 stable)', r4.error)
    const f5 = fakeSpawn({ out: 'x', code: 1 })
    const r5 = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable', features: {} }, { spawn: f5.spawn, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
    ok(r5.ok === true, '★版本对得上 → 放行(闸门不把正常用法挡在门外)', r5.error)
    if (r5.taskId) await waitTask(r5.taskId, 5000)
    // patch 为 0 的源码 ↔ 省略 patch 的 tag:两侧同形才放行(tplprobe.parseVersionPy 的官方形态)
    const src47 = makeTree('src-47', { versionPy: 'major = 4\nminor = 7\npatch = 0\nstatus = "stable"\n' })
    const f47 = fakeSpawn({ out: 'x', code: 1 })
    const r6 = B.buildTemplatePackWith({ srcDir: src47, tag: '4.7-stable', features: {} }, { spawn: f47.spawn, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
    ok(r6.ok === true, '★4.7.0 源码 ↔ tag 4.7-stable:patch 0 的省略形态两侧同形,闸门放行', r6.error)
    if (r6.taskId) await waitTask(r6.taskId, 5000)
  }

  // ---------- 7. 异常终态的清理 ----------
  section('7. 异常终态也不留残骸:子进程起不来 / 写盘失败都两份一起清')
  {
    // 真实宿主里 cmd.exe 起不来(ENOENT / EPERM / 企业机 AV 拦截 / env 被清理)走的是 'error' 事件,
    // 而这条路发生在两份临时文件**都已写盘之后**('close' 根本不会来)。
    const src = makeTree('src-spawnerr', { artifacts: true })
    const f = fakeSpawn({ spawnError: Object.assign(new Error('spawn cmd.exe ENOENT'), { code: 'ENOENT' }) })
    const cap = startTmpCapture()
    try {
      const r = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable', features: {} }, { spawn: f.spawn, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
      const t = await waitTask(r.taskId, 5000)
      ok(t.status === 'error' && /启动编译失败/.test(t.error || '') && /ENOENT/.test(t.error || ''),
        '★子进程起不来 → 任务转 error 并带上 spawn 的原因(不是悄悄停在 building)', `${t.status}/${t.error}`)
      ok(cap.captured.length === 2 && cap.captured.every((c) => c.text !== ''),
        '前提:两份临时文件都真写了盘(否则下面的"无残骸"是恒真)', JSON.stringify(cap.captured.map((c) => c.file)))
      ok(cap.captured.every((c) => !fs.existsSync(c.file)),
        '★spawn 失败同样两份同进同退(临时目录不留 .bat/.json 残骸)',
        JSON.stringify(cap.captured.filter((c) => fs.existsSync(c.file)).map((c) => c.file)))
    } finally { cap.restore() }
  }
  {
    // 写盘失败:profile 先写、bat 后写 → bat 写不动时留下的那个 .json 是本轮新引入的孤儿。
    // 清理常量原先定义在 Promise 执行器内部,catch 结构上够不着它(想清也清不了),现在必须能清。
    const src = makeTree('src-writefail', { artifacts: true })
    const f = fakeSpawn({ out: 'x', code: 0 })
    const cap = startTmpCapture('bat')
    try {
      const r = B.buildTemplatePackWith({ srcDir: src, tag: '4.7.2-stable', features: {} }, { spawn: f.spawn, statfsSync: () => ({ bsize: 4096, bavail: 1e7 }) })
      const t = await waitTask(r.taskId, 5000)
      ok(t.status === 'error' && /写构建脚本失败/.test(t.error || '') && /模拟写盘失败/.test(t.error || ''),
        '★写 bat 失败 → 任务转 error 并带上原因', `${t.status}/${t.error}`)
      ok(cap.captured.length === 1 && cap.captured[0].file.endsWith('.json') && cap.captured[0].text !== '',
        '前提:.json 已落盘、.bat 没写成(否则下面的"无孤儿"是恒真)', JSON.stringify(cap.captured.map((c) => c.file)))
      ok(!fs.existsSync(cap.file('json')), '★写盘失败也删掉已经落盘的那份 .json(不留孤儿配置)', cap.file('json'))
      ok(f.calls.length === 0, '★写盘失败后一次 scons 都不起', String(f.calls.length))
    } finally { cap.restore() }
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
