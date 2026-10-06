// 导出模板自编译(Godot 工坊裁剪向导的后半):工具链检测 → 跑 scons → 产物 stage。
//
// 形态与依据(docs/template-build-wizard-plan.md,闸门②已于 2026-10-06 本机实测):
//   · 命令:`vcvars64.bat && scons platform=windows target=template_release disable_3d=yes
//     accesskit=no d3d12=no -j<核数>` —— 选项组是实测验证过的固定值:2D-only 模板不需要
//     D3D12 依赖与 AccessKit 依赖,缺它们正是实测里最先撞上的两个失败;disable_3d 连带
//     裁掉 physics_3d/navigation_3d/xr。命令经**临时 .bat 文件**执行(与手动实测同款),
//     绕开 spawn 数组参数里带引号路径被 cmd 二次解释的问题。
//   · 产物:`bin/godot.windows.template_release.<arch>.*` 改名拷贝到
//     `stage/templates/windows_release_<arch>.*`(官方 tpz 的文件名形态),由第 5 项的
//     installExportTemplates **目录形态导入**直接吃下(stage 被 move 就位,无残留)。
//     两端都不引入 zip 写依赖 —— 打包 .tpz 交给用户需要分享时自行压缩,不是安装链路的必需品。
//   · 任务:独立串行队列(kind='tplbuild'),引擎输出尾部留在任务上(exporter 同款),
//     取消 = kill 子进程;编译可能持续几分钟到几十分钟,进度就是尾行本身。
//
// 检测的三个探头:python(直接调)、SCons(`python -m SCons --version`,不依赖 PATH 里的
// scons.exe)、vcvars64.bat(vswhere 找 VC 工具链,fallback 扫常见安装位)。
// 红线:这里 spawn/exec 的对象全部来自**本机探测与用户选择的路径**,不接受渲染层传命令串 ——
// 渲染层只给 srcDir/tag/jobs 三个值,命令的其余部分在本文件里拼死,不给注入留门。
const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createTaskQueue } = require('./taskqueue')
const { versionDirFromTag } = require('./templates')

const tasks = createTaskQueue({
  serial: true,
  makeId: () => `tplbuild-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
})

/** 任务上保留的构建输出行数上限(只留尾部,失败诊断用;exporter 同款) */
const LOG_TAIL = 40

/** 编译前要求源码所在盘的剩余空间(源码树 ~2GB + 编译中间物 ~10GB 的经验值,拍定的保守闸) */
const MIN_FREE_BYTES = 20 * 1024 * 1024 * 1024

/** 检测/构建只在 Windows 有意义(非 Windows 检测直接给说明) */
function isWin() {
  return process.platform === 'win32'
}

/**
 * 检测结果的缓存桥:checkTemplateBuildTools 找到的 vcvarsPath,buildTemplatePack 写进
 * 临时 bat 用。构建前必须先跑过一次检测(向导第一步本来就是它);没检测过就拒绝,
 * 不静默编一个路径。@type {{vcvarsPath: string}}
 */
const checkCache = { vcvarsPath: '' }

/**
 * 解析 `python -m SCons --version` 的输出 → 版本号(如 '4.10.1')。认不出给空串。
 * 实测输出首行是「SCons by Steven Knight et al.:」,次行「\tSCons: v4.10.1, <date>…」。
 * @param {string} text
 * @returns {string}
 */
function parseSconsVersion(text) {
  // 版本号与构建哈希在实测输出里同用点分隔(v4.10.1.055b01f…),只取纯数字的前两三段
  const m = /SCons:\s*v(\d+(?:\.\d+){0,2})/.exec(String(text || ''))
  return m ? m[1] : ''
}

/**
 * 从 vswhere 的输出(installationPath,每行一个)挑出第一个 vcvars64.bat 真实存在的安装位。
 * 固定 win32 join:vswhere 只在 Windows 跑,路径全是 Windows 形态 —— 与运行检测的平台无关
 * (Linux 上 path.join 会拼出正斜杠,断言与语义都乱,CI 首跑已踩)。
 * @param {string} vswhereOut vswhere -property installationPath 的原样输出
 * @param {string[]} fallbacks vswhere 不可用/空时的候选目录(逐个拼 VC\Auxiliary\Build\vcvars64.bat)
 * @param {(p: string) => boolean} exists 注入的 existsSync
 * @returns {string}
 */
function pickVcvars(vswhereOut, fallbacks, exists) {
  const lines = String(vswhereOut || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  for (const dir of lines) {
    const p = path.win32.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
    if (exists(p)) return p
  }
  for (const dir of fallbacks) {
    const p = path.win32.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
    if (exists(p)) return p
  }
  return ''
}

/**
 * scons 产物名 → 官方 tpz 的模板文件名;不是模板产物的返回 null。
 * 实测形态:godot.windows.template_release.x86_64{.console}.<exe|lib|exp> → windows_release_x86_64…
 * @param {string} name
 * @returns {string|null}
 */
function mapTemplateFileName(name) {
  const console_ = /^godot\.windows\.template_release\.(.+?)\.console\.exe$/.exec(name)
  if (console_) return `windows_release_${console_[1]}.console.exe`
  const plain = /^godot\.windows\.template_release\.(.+?)\.(exe|lib|exp)$/.exec(name)
  if (plain) return `windows_release_${plain[1]}.${plain[2]}`
  return null
}

/** vswhere 的固定位置(Windows SDK/VS Installer 的官方落点,本机实测存在) */
const VSWHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'

/** vswhere 找不到时的候选安装根(常见盘符 × 常见 SKU) */
function vcvarsFallbackDirs() {
  const roots = ['C:', 'D:', 'E:', 'D:\\apps', 'E:\\apps']
  const years = ['2026', '2022', '2019']
  const skus = ['Community', 'BuildTools', 'Professional', 'Enterprise']
  const out = []
  for (const r of roots) for (const y of years) for (const s of skus) out.push(`${r}\\Microsoft Visual Studio\\${y}\\${s}`.replace(/\\+/g, '\\'))
  return out
}

/**
 * 工具链检测(只读;跑三个子进程,总量毫秒到秒级)。
 * 缺什么就把「下一步动作」放进 problems —— 闸门③的要求:不许只说缺,不说怎么补。
 * @returns {Promise<{ok: boolean, pythonVersion: string, sconsVersion: string, vcvarsPath: string, cpuCount: number, problems: string[]}>}
 */
function checkTemplateBuildTools() {
  return checkTemplateBuildToolsWith(
    { platform: process.platform },
    { execSync, cpuCount: os.cpus().length, existsSync: fs.existsSync }
  )
}

/**
 * `checkTemplateBuildTools` 的实现体。execSync 与核数注入是测试接缝:
 * 检测的真实形态(python/py 回落、-m SCons、vswhere)在这里定死,测试传桩只验流程。
 * @param {{platform: string}} env
 * @param {{execSync: typeof execSync, cpuCount: number, existsSync: (p: string) => boolean}} deps
 */
async function checkTemplateBuildToolsWith(env, deps) {
  const cpuCount = deps.cpuCount
  /** @type {{ok: boolean, pythonVersion: string, sconsVersion: string, vcvarsPath: string, cpuCount: number, problems: string[]}} */
  const out = { ok: false, pythonVersion: '', sconsVersion: '', vcvarsPath: '', cpuCount, problems: [] }
  if (env.platform !== 'win32') {
    out.problems.push('自编译模板构建目前只在 Windows 宿主提供(需要 MSVC 与 vcvars 环境)。')
    return out
  }
  // python:`python --version`;失败再试 py 启动器
  let pythonCmd = ''
  for (const cmd of ['python', 'py -3']) {
    try {
      const v = String(deps.execSync(`${cmd} --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim()
      if (/^Python \d/.test(v)) {
        out.pythonVersion = v.replace(/^Python\s+/, '')
        pythonCmd = cmd
        break
      }
    } catch (e) { /* 换下一个 */ }
  }
  if (!pythonCmd) out.problems.push('没有可用的 Python 3。请安装 Python 3.8+ 并勾选「加入 PATH」后重试。')
  // SCons:走 `python -m SCons --version`,不吃 PATH 里的 scons.exe(pip 装在哪个解释器都能找到)
  if (pythonCmd) {
    try {
      const v = String(deps.execSync(`${pythonCmd} -m SCons --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '')
      out.sconsVersion = parseSconsVersion(v)
    } catch (e) { /* 认不出就是没装 */ }
    if (!out.sconsVersion) out.problems.push('没有 SCons。请用与上面相同的 Python 执行:python -m pip install scons')
  }
  // vcvars64.bat:vswhere 优先(能找到非默认盘的 VS),fallback 扫常见安装位
  let vsOut = ''
  try {
    vsOut = String(deps.execSync(`"${VSWHERE}" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '')
  } catch (e) { /* 没有 Installer 就直接走 fallback */ }
  out.vcvarsPath = pickVcvars(vsOut, vcvarsFallbackDirs(), (p) => deps.existsSync(p))
  if (!out.vcvarsPath) out.problems.push('没有找到 MSVC 工具链。请安装 Visual Studio(Community 即可)并在 Installer 里勾选「使用 C++ 的桌面开发」。')
  out.ok = out.problems.length === 0
  // 检测到的 vcvars 缓存给构建步;重跑检测会覆盖 —— 换了 VS 安装位后重检即可生效
  checkCache.vcvarsPath = out.vcvarsPath
  return out
}

/**
 * 把 bin/ 下的模板产物改名拷贝到 stage/templates(官方 tpz 文件名形态)。
 * @param {string} binDir Godot 源码的 bin 目录
 * @param {string} stageDir stage 根(里面建 templates/)
 * @returns {number} 拷贝的文件数
 */
function stageBin(binDir, stageDir) {
  const dest = path.join(stageDir, 'templates')
  fs.mkdirSync(dest, { recursive: true })
  let n = 0
  for (const f of fs.readdirSync(binDir)) {
    const mapped = mapTemplateFileName(f)
    if (!mapped) continue
    fs.copyFileSync(path.join(binDir, f), path.join(dest, mapped))
    n++
  }
  return n
}

/**
 * 发起自编译(入队,立即返回)。完成后任务上带 stageDir(含 templates/ 顶层)与
 * versionDir(tag 派生),渲染层直接 installExportTemplates(versionId, { srcPath: stageDir })。
 * @param {{srcDir: string, tag: string, jobs?: number}} params
 * @returns {{ok: boolean, error?: string, taskId?: string}}
 */
function buildTemplatePack(params) {
  return buildTemplatePackWith(params, { spawn, statfsSync: fs.statfsSync })
}

/**
 * `buildTemplatePack` 的实现体。spawn 与 statfs 注入是测试接缝:构建流程(bat 生成、
 * 尾行收集、取消、产物 stage)在 Node 里就能钉住,不必真跑 40 分钟的 scons。
 * @param {{srcDir: string, tag: string, jobs?: number}} params
 * @param {{spawn: typeof spawn, statfsSync: (p: string) => {bsize: number, bavail: number}}} deps
 */
function buildTemplatePackWith(params, deps) {
  const { srcDir, tag } = params || {}
  if (!srcDir || typeof srcDir !== 'string') return { ok: false, error: '请先选择 Godot 源码目录' }
  if (!tag || typeof tag !== 'string') return { ok: false, error: '缺少引擎版本信息' }
  // vcvars 路径来自检测步的缓存:构建必须在检测之后(向导的第一步就是它),这道闸放最前 ——
  // 没检测过时,源码目录对不对都无从谈起。不在这里重新探测:检测的三个子进程是秒级动作,
  // 重复探测只会拖慢入队。
  if (!checkCache.vcvarsPath) {
    return { ok: false, error: '请先完成工具链检测(向导第一步)' }
  }
  if (!fs.existsSync(path.join(srcDir, 'SConstruct'))) {
    return { ok: false, error: '所选目录不是 Godot 源码根(缺 SConstruct)' }
  }
  const binDir = path.join(srcDir, 'bin')
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true })
  const jobs = Math.min(64, Math.max(1, Number((params || {}).jobs) || os.cpus().length))
  // 编译是重活:磁盘不够就提前说,不让用户在 40 分钟后看 Out of space
  try {
    /** @type {any} */
    const st = deps.statfsSync(srcDir)
    if (st.bsize * st.bavail < MIN_FREE_BYTES) {
      return { ok: false, error: '源码所在盘剩余空间不足 20 GB,编译中间产物放不下,请先清理后重试' }
    }
  } catch (e) { /* statfs 不可用的文件系统:跳过这一道,不因此拒绝 */ }

  const task = tasks.create({
    kind: 'tplbuild',
    tag,
    srcDir,
    jobs,
    status: 'queued',
    log: ''
  })
  const id = task.id
  tasks.emit()

  const job = /** @returns {Promise<void>} */ () => new Promise((resolve) => {
    const cur = tasks.get(id)
    if (!cur || cur.status === 'canceled') return resolve()
    setTask(id, { status: 'building' })
    // 临时 bat:路径写死在文件里逐行执行,引号/空格路径与手动实测完全同形态
    let batPath = ''
    let stageDir = ''
    try {
      batPath = path.join(os.tmpdir(), `ztools-godot-build-${id}.bat`)
      fs.writeFileSync(batPath, [
        '@echo off',
        `call "${checkCache.vcvarsPath}"`,
        `cd /d "${srcDir}"`,
        `scons platform=windows target=template_release disable_3d=yes accesskit=no d3d12=no -j${jobs}`
      ].join('\r\n'), 'utf8')
    } catch (e) {
      setTask(id, { status: 'error', error: '写构建脚本失败: ' + ((e && e.message) || e) })
      return resolve()
    }
    /** @type {string[]} 构建输出尾部环形缓冲(exporter 同款) */
    const tail = []
    let canceled = false
    const child = deps.spawn('cmd.exe', ['/d', '/s', '/c', batPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    tasks.setToken(id, {
      cancel: () => {
        canceled = true
        try { child.kill() } catch (e) { /* ignore */ }
      }
    })
    /** @param {any} buf */
    const onChunk = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > LOG_TAIL) tail.shift()
      }
      setTask(id, { log: tail.join('\n') })
    }
    if (child.stdout) child.stdout.on('data', onChunk)
    if (child.stderr) child.stderr.on('data', onChunk)
    child.on('error', (e) => {
      if (!canceled) setTask(id, { status: 'error', error: '启动编译失败: ' + e.message })
      resolve()
    })
    child.on('close', (code) => {
      const cleanupBat = () => { try { fs.existsSync(batPath) && fs.unlinkSync(batPath) } catch (e) { /* ignore */ } }
      if (canceled) {
        cleanupBat()
        setTask(id, { status: 'canceled' })
        return resolve()
      }
      if (code !== 0) {
        cleanupBat()
        setTask(id, { status: 'error', error: `编译失败(退出码 ${code})—— 常见原因与下一步见向导的失败说明`, errorDetail: tail.join('\n') })
        return resolve()
      }
      // 编译成功:bin 产物改名拷贝进 stage(templates/ 顶层),交给目录形态导入
      try {
        stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-godot-stage-'))
        const n = stageBin(binDir, stageDir)
        if (!n) throw new Error('bin/ 里没有模板产物(编译配置可能不对,应含 godot.windows.template_release.*)')
        setTask(id, { status: 'done', stageDir, versionDir: versionDirFromTag(tag), files: n })
      } catch (e) {
        setTask(id, { status: 'error', error: (e && e.message) || '整理产物失败' })
      }
      cleanupBat()
      resolve()
    })
  })

  tasks.enqueue(job)
  return { ok: true, taskId: id }
}

/**
 * 取消构建(排队中直接取消;构建中 kill scons 子进程)。
 * @param {string} id
 */
/**
 * 取消构建(排队中直接取消;构建中 kill scons 子进程)。
 * @param {string} id
 */
function cancelTemplateBuildTask(id) {
  const t = tasks.get(id)
  if (!t) return
  if (['done', 'error', 'canceled'].includes(t.status)) return
  const handle = tasks.tokenOf(id)
  if (handle) handle.cancel()
  setTask(id, { status: 'canceled' })
}

/** @param {string} id */
function dismissTemplateBuildTask(id) {
  tasks.dismiss(id)
}

/** @param {(tasks: import('../../../src/types/godot').TemplateBuildTask[]) => void} fn */
function watchTemplateBuildTasks(fn) {
  return tasks.watch(fn)
}

/**
 * @param {string} id
 * @param {Record<string, any>} patch
 */
function setTask(id, patch) {
  tasks.patch(tasks.get(id), patch)
}

module.exports = {
  parseSconsVersion,
  pickVcvars,
  mapTemplateFileName,
  vcvarsFallbackDirs,
  checkCache,
  checkTemplateBuildTools,
  checkTemplateBuildToolsWith,
  buildTemplatePack,
  buildTemplatePackWith,
  cancelTemplateBuildTask,
  dismissTemplateBuildTask,
  watchTemplateBuildTasks,
  stageBin
}
