// 导出模板自编译(Godot 工坊裁剪向导的后半):工具链检测 → 跑 scons → 产物 stage。
//
// 形态与依据(docs/template-build-wizard-plan.md,闸门②已于 2026-10-06 本机实测):
//   · 命令:`vcvars64.bat` 里跑 `scons platform=windows target=template_release
//     build_profile="<临时 profile>" <核心 flag 的 flag=value token…> -j<核数>` —— 裁剪集不再是
//     写死的固定值,由**用户勾选 + 这份源码的探测结果**查表生成:两条通道按 Ruling #38 划分,
//     `module_*` 全进 profile 文件,其余一切(核心 flag 与模式键)发命令行 token,顺序由输出层排好。
//     实测验证过的那组(disable_3d / accesskit)仍是勾掉 2D-only 时的产物,只是不再写死。
//     命令经**临时 .bat 文件**执行(与手动实测同款),
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
// 渲染层只给 srcDir / tag / jobs / features / mode 五个值(两个通道的参数都由本文件查表生成,
// 命令的其余部分在本文件里拼死),不给注入留门。
const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createTaskQueue } = require('./taskqueue')
const { versionDirFromTag } = require('./templates')
const { probeSource, parseVersionPy, versionStringFromTag } = require('./tplprobe')
const { buildProfile, profileText } = require('./tplprofile')

const tasks = createTaskQueue({
  serial: true,
  makeId: () => `tplbuild-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
})

/** 任务上保留的构建输出行数上限(只留尾部,失败诊断用;exporter 同款) */
const LOG_TAIL = 40

/** 编译前要求源码所在盘的剩余空间(源码树 ~2GB + 编译中间物 ~10GB 的经验值,拍定的保守闸) */
const MIN_FREE_BYTES = 20 * 1024 * 1024 * 1024

/**
 * 版本闸只认 stable 形态的引擎版本(Ruling #44)。
 * `tplprobe.versionStringFromTag` 刻意只做 trim、不做规范化(两侧同形态才对得上),所以
 * `4.4-beta1`(真实 version.py 解析出来是 `4.4-beta`)与 `v4.7.2-stable` 都会撞在
 * "源码版本不符"上 —— 那是给错方向的建议:用户的源码是对的,错的是 tag 形态。
 * 这一道先把它拦下来给专门文案,**不猜用户想要哪个 stable**。
 */
const STABLE_TAG_RE = /^\d+\.\d+(\.\d+)?-stable$/

/**
 * 探测结果的执行层视图:本文件只用这三项,其余(sourceVersion / tested / cascades …)
 * 由上游与后续任务消费,这里不复制一份。
 * @typedef {Object} ProbeOutcome
 * @property {boolean} ok
 * @property {string} error
 * @property {Record<string, {exists: true, default: boolean|string}>} options
 */

/** 检测/构建只在 Windows 有意义(非 Windows 检测直接给说明) */
function isWin() {
  return process.platform === 'win32'
}

/**
 * 检测结果的缓存桥:checkTemplateBuildTools 找到的 vcvarsPath 与 scons 通道,buildTemplatePack
 * 写进临时 bat 用。构建前必须先跑过一次检测(向导第一步本来就是它);没检测过就拒绝,
 * 不静默编一个路径。sconsVia='python' 时 bat 改用命中解释器起 `python -m SCons`
 * (scons 不在 PATH 的那台机器),与检测同通道,不各说各话。
 * @type {{vcvarsPath: string, pythonPath: string, pythonCmd: string, sconsVia: string}}
 */
const checkCache = { vcvarsPath: '', pythonPath: '', pythonCmd: '', sconsVia: '' }

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

/** Windows 自带 tar(bsdtar,Win10 1803+;吃得动 .tar.xz)的固定落点;代下载解包与第四探头共用 */
const TAR_EXE = 'C:\\Windows\\System32\\tar.exe'

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
 * @returns {Promise<{ok: boolean, pythonVersion: string, pythonPath: string, sconsVersion: string, sconsPath: string, vcvarsPath: string, tarPath: string, cpuCount: number, problems: string[]}>}
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
  /** @type {{ok: boolean, pythonVersion: string, pythonPath: string, sconsVersion: string, sconsPath: string, vcvarsPath: string, tarPath: string, cpuCount: number, problems: string[]}} */
  const out = { ok: false, pythonVersion: '', pythonPath: '', sconsVersion: '', sconsPath: '', vcvarsPath: '', tarPath: '', cpuCount, problems: [] }
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
  // 是哪支 python.exe 只有解释器自己答得上(PATH 别名 / py 启动器 / 商店别名各指一处,where 猜不准);
  // 问不到就留空串 —— 版本行照显示,只是少一行路径,不影响齐不齐的结论
  if (pythonCmd) {
    try {
      out.pythonPath = String(deps.execSync(`${pythonCmd} -c "import sys;print(sys.executable)"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim()
    } catch (e) { /* 路径问不到不影响检测结论 */ }
  }
  // SCons:先认 PATH 上的 `scons --version` —— 编译 bat 跑的就是 PATH 上的 scons,检测判据必须
  // 与它同口径(旧口径只认 `python -m SCons`,把「scons 装在另一支已在 PATH 的解释器里」的可用
  // 工具链判成未找到,还会把 uv 托管解释器的用户引去 pip 撞 PEP 668);PATH 没有再回落模块通道,
  // 此时 bat 改由命中解释器起 `python -m SCons`(sconsLineFor),两端始终同一条通道。
  let sconsVia = ''
  try {
    const pv = parseSconsVersion(String(deps.execSync('scons --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || ''))
    if (pv) { out.sconsVersion = pv; sconsVia = 'path' }
  } catch (e) { /* PATH 上没有,试模块通道 */ }
  if (!sconsVia && pythonCmd) {
    try {
      const pv = parseSconsVersion(String(deps.execSync(`${pythonCmd} -m SCons --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || ''))
      if (pv) { out.sconsVersion = pv; sconsVia = 'python' }
    } catch (e) { /* 认不出就是没装 */ }
  }
  if (sconsVia === 'path') {
    try {
      out.sconsPath = (String(deps.execSync('where scons', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]) || ''
    } catch (e) { /* 落点问不到就只显示版本号 */ }
  }
  if (!sconsVia && pythonCmd) {
    // uv 等托管解释器带 EXTERNALLY-MANAGED 标记(PEP 668),裸 pip install 必拒 —— 提示里直接给
    // 能跑通的写法,别让用户照着一句跑不通的命令撞墙再回来
    const managed = out.pythonPath
      ? deps.existsSync(path.win32.join(path.win32.dirname(out.pythonPath), 'Lib', 'EXTERNALLY-MANAGED'))
      : false
    out.problems.push(managed
      ? '没有 SCons。上面的 Python 受 PEP 668 外部管理(uv 等),裸 pip install 会被拒:请改用 python -m pip install --break-system-packages scons,或装进任一已在 PATH 的解释器 —— 检测与编译都从 PATH 认 scons。'
      : '没有 SCons。请用上面的 Python 执行:python -m pip install scons,或直接装进任一已在 PATH 的解释器 —— 检测与编译都从 PATH 认 scons。')
  }
  // vcvars64.bat:vswhere 优先(能找到非默认盘的 VS),fallback 扫常见安装位
  let vsOut = ''
  try {
    vsOut = String(deps.execSync(`"${VSWHERE}" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '')
  } catch (e) { /* 没有 Installer 就直接走 fallback */ }
  out.vcvarsPath = pickVcvars(vsOut, vcvarsFallbackDirs(), (p) => deps.existsSync(p))
  if (!out.vcvarsPath) out.problems.push('没有找到 MSVC 工具链。请安装 Visual Studio(Community 即可)并在 Installer 里勾选「使用 C++ 的桌面开发」。')
  // 第四探头:tar.exe 只服务代下载的解包步(手动备源码 + 编译都不吃 tar)—— 缺只回空串,
  // 不进 problems、不拖 ok:向导的「下载该版本源码」按钮按这个字段禁用并给如实文案
  out.tarPath = deps.existsSync(TAR_EXE) ? TAR_EXE : ''
  out.ok = out.problems.length === 0
  // 检测到的 vcvars / python / scons 通道缓存给构建步;重跑检测会覆盖 —— 换了安装位后重检即可生效
  checkCache.vcvarsPath = out.vcvarsPath
  checkCache.pythonPath = out.pythonPath
  checkCache.pythonCmd = pythonCmd
  checkCache.sconsVia = sconsVia
  return out
}

/**
 * bat 里的 scons 行:默认裸 scons 从 PATH 解析(与检测判据同口径);检测走的是模块通道
 * (scons 不在 PATH)时改由命中解释器起 `python -m SCons`,检测与编译始终同一条通道。
 * 前缀之后只出现 commandExtras 的 token(核心 flag 与模式键),module_* 一律不在行上。
 * @param {{sconsVia?: string, pythonPath?: string, pythonCmd?: string}} cache checkCache 的形状
 * @param {string} profilePath 临时 profile 文件路径
 * @param {string[]} extras 查表生成的命令行 token
 * @param {number} jobs 并行度
 * @returns {string}
 */
function sconsLineFor(cache, profilePath, extras, jobs) {
  const head = cache.sconsVia === 'python' ? `"${cache.pythonPath || cache.pythonCmd}" -m SCons` : 'scons'
  return [head, 'platform=windows', 'target=template_release', `build_profile="${profilePath}"`, ...extras, `-j${jobs}`].join(' ')
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
 * 同步探测(只读 version.py)。**定义在本文件,不从 ./tplprobe 取** —— tplprobe 只有异步的
 * probeSource,而入队路径必须同步返回 ok:false(与 toggleFavorite 那条既有约定同形)。
 * 异步版 probeSource 在任务里跑,拿完整选项表生成两条通道。
 * @param {string} srcDir
 * @returns {{ok: boolean, error: string, sourceVersion: string}}
 */
function probeSourceSync(srcDir) {
  // M7(终审修复波):判空/判串提到 path.join 之前 —— 传 undefined 时 join 先炸 TypeError
  // (入队路径有上面的同步闸挡着,这一格目前不可达;换一次序就没有死角了)。join 只在两个前置判过时才求值。
  if (!srcDir || typeof srcDir !== 'string' || !fs.existsSync(path.join(srcDir, 'SConstruct'))) {
    return { ok: false, error: '所选目录不是 Godot 源码根(缺 SConstruct)', sourceVersion: '' }
  }
  let vpy = ''
  try { vpy = String(fs.readFileSync(path.join(srcDir, 'version.py'), 'utf8')) } catch (e) { /* 下面按读不出处理 */ }
  // parseVersionPy 读不出给空串:空串对不上任何 stable tag,闸门自然拒绝,不猜一个"看起来对"的串。
  return { ok: true, error: '', sourceVersion: parseVersionPy(vpy) }
}

/**
 * 包一层异步探测:probeSource 的任何异常都转成 ok:false。
 * 作业跑在**串行队列**里,但队列不会因此塌 —— `taskqueue.js:188-199` 的 `pump` 是
 * `try { await job() } finally { running = false; pump() }`,**没有 catch**,所以下一个任务照跑。
 * 真实后果是另外两条:① 一个**未捕获的 Promise 拒绝**(宿主里只是一条没人看的日志,
 * 渲染层与向导都拿不到任何说法);② **这个任务永远停在 `building`**,已经落盘的临时文件也等不到
 * 清理(转 error、写错误文案、删临时文件都排在 throw 之后,轮不到它们跑)。
 * 这里包一层,把那两条换成「任务转 error + 带上探测层给的原因」。
 * @param {(srcDir: string) => any} fn
 * @param {string} srcDir
 * @returns {Promise<ProbeOutcome>}
 */
async function runProbe(fn, srcDir) {
  try {
    return await fn(srcDir)
  } catch (e) {
    return { ok: false, error: '探测构建选项失败: ' + ((e && e.message) || e), options: {} }
  }
}

/**
 * 发起自编译(入队,立即返回)。完成后任务上带 stageDir(含 templates/ 顶层)与
 * versionDir(tag 派生),渲染层直接 installExportTemplates(versionId, { srcPath: stageDir })。
 * @param {{srcDir: string, tag: string, jobs?: number, features: Record<string, boolean>, mode?: 'default-on' | 'default-off'}} params
 *   `features` 由契约(T8 起)收成必填,下面那道闸是它的双保险(运行时仍然先拒为妙);
 *   `mode` 真可选:省略时 buildProfile 归到保守那一侧(default-on)。
 * @returns {{ok: boolean, error?: string, taskId?: string}}
 */
function buildTemplatePack(params) {
  return buildTemplatePackWith(params, { spawn, statfsSync: fs.statfsSync })
}

/**
 * `buildTemplatePack` 的实现体。spawn / statfs / probeSource 注入是测试接缝:构建流程
 * (profile 与 bat 的生成、两条裁剪通道的划分、尾行收集、取消、产物 stage)在 Node 里就能钉住,
 * 不必真跑 40 分钟的 scons;而 probeSource 这一格是为了让"两条通道"的用例不必在夹具里
 * 重造一棵探得出选项的源码树(逐字 SConstruct + modules 三件套的形态由 tplprobe.test.js 守着)。
 * @param {{srcDir: string, tag: string, jobs?: number, features: Record<string, boolean>, mode?: 'default-on' | 'default-off'}} params
 * @param {{spawn: typeof spawn, statfsSync: (p: string) => {bsize: number, bavail: number}, probeSource?: (srcDir: string) => any}} deps
 */
function buildTemplatePackWith(params, deps) {
  const { srcDir, tag } = params || {}
  const features = (params || {}).features
  const mode = (params || {}).mode
  if (!srcDir || typeof srcDir !== 'string') return { ok: false, error: '请先选择 Godot 源码目录' }
  if (!tag || typeof tag !== 'string') return { ok: false, error: '缺少引擎版本信息' }
  // 勾选结果是裁剪的唯一来源:没有它就等于让执行层替面板猜一套默认值(猜多猜少都是替用户做主)。
  if (!features || typeof features !== 'object') return { ok: false, error: '缺少功能勾选结果' }
  // vcvars 路径来自检测步的缓存:构建必须在检测之后(向导的第一步就是它),这道闸放最前 ——
  // 没检测过时,源码目录对不对都无从谈起。不在这里重新探测:检测的三个子进程是秒级动作,
  // 重复探测只会拖慢入队。
  if (!checkCache.vcvarsPath) {
    return { ok: false, error: '请先完成工具链检测(向导第一步)' }
  }
  // 版本闸(取代原先那句 SConstruct 存在性检查,位置不变 —— 不前移到检测闸之前,那条
  // "检测先于一切"的既有约定由 buildtools.test.js 钉着)。拿 4.6 源码给 4.7.2 编模板,
  // 产物会被塞进 4.7.2.stable 目录,导出时的行为异常极难查 —— 这一道在建任务之前、同步拒绝。
  // 先判 tag 形态再读源码:预发布/带 v 前缀的 tag 与 versionStringFromTag 的"不规范化"撞出来的是
  // 一句指错方向的"源码版本不符"(源码没错,错的是 tag),所以它专属下面这条文案。
  const target = versionStringFromTag(tag)
  if (!STABLE_TAG_RE.test(target)) {
    return {
      ok: false,
      error: `自编译模板只支持 stable 形态的引擎版本(如 4.7.2-stable / 4.7-stable),目标引擎 = ${target || '读不出'}。预发布版(beta / rc)与带 v 前缀的 tag 不走这条路 —— 请改用对应的正式版引擎与同版本源码。`
    }
  }
  const probeSync = probeSourceSync(srcDir)
  if (!probeSync.ok) return { ok: false, error: probeSync.error }
  if (probeSync.sourceVersion !== target) {
    return {
      ok: false,
      error: `源码版本不符：version.py = ${probeSync.sourceVersion || '读不出'}，目标引擎 = ${target}。请先切到该版本的源码，或改用与源码同版本的引擎。`
    }
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
    log: '',
    writtenFlags: []
  })
  const id = task.id
  tasks.emit()

  const job = async () => {
    const cur = tasks.get(id)
    if (!cur || cur.status === 'canceled') return
    setTask(id, { status: 'building' })
    // 临时 bat 与临时 profile:路径写死在文件里逐行执行,引号/空格路径与手动实测完全同形态
    let batPath = ''
    let profilePath = ''
    let stageDir = ''
    // 两份临时文件同进同退:只删 bat 会把每次构建的裁剪配置留在临时目录里积灰。
    // 三个清理常量定义在 try **之前**、Promise 执行器之外 —— 因为「写盘失败」的 catch 与
    // 「子进程起不来」的 'error' 这两条终态也都在两份文件已落盘之后,必须够得着它们;
    // existsSync 守卫让重复调用安全,所以每条终态分支都只管调,不必判断走到过哪一步。
    const cleanupBat = () => { try { fs.existsSync(batPath) && fs.unlinkSync(batPath) } catch (e) { /* ignore */ } }
    const cleanupProfile = () => { try { fs.existsSync(profilePath) && fs.unlinkSync(profilePath) } catch (e) { /* ignore */ } }
    const cleanupTmp = () => { cleanupBat(); cleanupProfile() }
    try {
      batPath = path.join(os.tmpdir(), `ztools-godot-build-${id}.bat`)
      profilePath = path.join(os.tmpdir(), `ztools-godot-profile-${id}.json`)
      // 探测这份源码:选项的存在性与默认值决定两条通道各写什么。探不到就停 ——
      // 未声明的 scons 变量是静默失效的,拿一份"以为裁了其实没裁"的产物比失败更糟。
      const probe = await runProbe(deps.probeSource || probeSource, srcDir)
      if (!probe.ok) {
        setTask(id, { status: 'error', error: probe.error })
        return
      }
      // mode 原样透传:T7 不校验它(归契约层 T8),buildProfile 自己把缺省与认不出的值
      // 都归到保守那一侧(关得少的 default-on)。
      const prof = buildProfile(features, probe.options, { mode })
      // 一条都没写也照样落盘:命令行上的 build_profile= 指向它,scons 读不到这个文件会直接失败。
      fs.writeFileSync(profilePath, profileText(prof.json), 'utf8')
      // scons 行经 sconsLineFor:通道由检测缓存定(PATH 裸 scons / 命中解释器 -m SCons);
      // 前缀之后只出现 commandExtras 的 token(核心 flag 与模式键),module_* 一律不在行上,最后是 -j。
      fs.writeFileSync(batPath, [
        '@echo off',
        `call "${checkCache.vcvarsPath}"`,
        `cd /d "${srcDir}"`,
        sconsLineFor(checkCache, profilePath, prof.commandExtras, jobs)
      ].join('\r\n'), 'utf8')
      // "当时编了什么"回查用:两个通道写出去的键都记在任务上(profile 里也留着整份 JSON)
      setTask(id, { writtenFlags: prof.written, profilePath })
    } catch (e) {
      // profile 先写、bat 后写:这一步失败时已落盘的那份(通常是 .json)不能留成孤儿。
      cleanupTmp()
      setTask(id, { status: 'error', error: '写构建脚本失败: ' + ((e && e.message) || e) })
      return
    }
    /** @type {string[]} 构建输出尾部环形缓冲(exporter 同款) */
    const tail = []
    let canceled = false
    await /** @type {Promise<void>} */ (new Promise((resolve) => {
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
        // cmd.exe 起不来(ENOENT / EPERM / 企业机 AV 拦截 / env 被清理)走的是这条,而此刻两份
        // 临时文件**都已经写盘** —— 真实宿主里这是主要形态('close' 根本不会来),不清就是每失败一次留一对残骸。
        cleanupTmp()
        if (!canceled) setTask(id, { status: 'error', error: '启动编译失败: ' + e.message })
        resolve()
      })
      child.on('close', (code) => {
        if (canceled) {
          cleanupTmp()
          setTask(id, { status: 'canceled' })
          return resolve()
        }
        if (code !== 0) {
          cleanupTmp()
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
        cleanupTmp()
        resolve()
      })
    }))
  }

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
  TAR_EXE,
  checkCache,
  checkTemplateBuildTools,
  checkTemplateBuildToolsWith,
  sconsLineFor,
  buildTemplatePack,
  buildTemplatePackWith,
  cancelTemplateBuildTask,
  dismissTemplateBuildTask,
  watchTemplateBuildTasks,
  stageBin
}
