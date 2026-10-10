// 自编译模板 · 探测层:对着用户那份源码树回答"这个开关存不存在、它的默认值是什么"。
//
// 为什么要有这一层而不是在功能表里写 `since: '4.5'`(策划书 §2 决策 2):
// 探测同时给出**存在性**与**源码默认值**,后者是 §5.3 那条"选择 ≠ 默认才输出"规则的前提;
// 而且它不随版本腐化 —— 每次小版本都要改插件的表,迟早和源码对不上,而 scons 对不认识的
// 参数是**静默忽略**的(策划书 §6 末实验:值不进 env、无 warning、退出码 0),
// 对不上不会报错,只会让用户拿到一个"以为裁了其实没裁"的产物。
//
// 这些解析函数本身都不做 IO:纯文本函数吃源码片段,`detectBuiltinModules` 把「列目录 / 探文件 /
// 读文件」三件事收进参数里由调用方注入。IO 只在 probeSource() 这一处,而且只在调用方没注入 deps
// 时才 `require('node:fs')` 回落 —— 注入 deps 的调用方(测试、非 Windows 宿主)一个真实文件都不碰。
/** @typedef {Record<string, {exists: true, default: boolean|string}>} OptionMap */

// 双引号与单引号两种写法都要认:4.7.2 的 SConstruct 用双引号,
// 平台文件与更早的版本里单引号混着出现。默认值只认 True/False/带引号字符串/整数。
const VAR_DECL = /(?:Bool|Enum)Variable\(\s*["']([a-z0-9_]+)["']\s*,\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,\s*(True|False|"([^"]*)"|'([^']*)'|\d+)/g

/**
 * 解析 SConstruct(或任何 .py 构建脚本)里的变量声明。
 * 同名只取**第一次**出现 —— 源码里同一变量不会重复 Add,重复出现时先出现的才是真声明。
 * @param {string} text
 * @returns {OptionMap}
 */
function parseSconsOptions(text) {
  /** @type {OptionMap} */
  const out = {}
  if (typeof text !== 'string') return out
  VAR_DECL.lastIndex = 0
  let m
  while ((m = VAR_DECL.exec(text))) {
    if (m[1] in out) continue
    out[m[1]] = { exists: true, default: decodeDefault(m[2], m[3], m[4]) }
  }
  return out
}

/** @param {string} raw @param {string} [dq] @param {string} [sq] @returns {boolean|string} */
function decodeDefault(raw, dq, sq) {
  if (raw === 'True') return true
  if (raw === 'False') return false
  if (dq !== undefined) return dq
  if (sq !== undefined) return sq
  return raw // 整数默认值(极少见)原样留字符串,由调用方判
}

// 模块的 is_enabled() 形态固定,但中间可能夹注释行 —— 4.7.2 的 mono 就是:
//   def is_enabled():
//       # The module is disabled by default. Use module_mono_enabled=yes to enable it.
//       return False
// (modules/mono/config.py:31-33;text_server_fb/config.py:10-12 同形态。全树只有这两个模块定义它。)
const IS_ENABLED = /def\s+is_enabled\s*\(\s*\)\s*:\s*(?:#[^\n]*\n\s*)?return\s+(True|False)\b/

/**
 * 读一个 `modules/<x>/config.py` 的默认启用状态。
 * 没有 `is_enabled()` 就是 True —— 依据 `SConstruct:476-483`:先置 True,再 try 调 `config.is_enabled()`,
 * `AttributeError` 才保持 True。4.7.2 全量 57 个模块目录里只有 `mono` 与 `text_server_fb` 定义了它。
 * (注:`SConstruct:476` 外面还套着 `if env["modules_enabled_by_default"]:`,那个选项默认 True,
 * 用户显式设成 no 时全部模块默认 False —— 那是 profile 层的事,本层只管源码声明的默认形态。)
 *
 * **已核实的边界(Ruling #24,改这里之前先读)**:`IS_ENABLED` 里那个 `(?:#[^\n]*\n\s*)?`
 * 只容**一行**注释。已逐棵树核过 4.3-stable / 4.5-stable / 4.7.2-stable 的全部 6 处
 * `is_enabled()`(每棵树各 `mono` + `text_server_fb` 两处),**每处都恰好是"一行注释 + return False"**,
 * 所以当前实现与源码严格对齐。若哪天某个版本在 `def is_enabled():` 与 `return` 之间夹**两行**注释,
 * 正则就匹配不到,本函数会**静默回落 `true`** —— 那等于面板替用户把 mono 打了勾。
 * 不加宽容度也不造两行注释的合成夹具:那违反本文件"夹具必须逐字摘自真实源码"的硬约束,
 * 给一个源码里不存在的形态写实现同样是猜。真出现两行注释的版本时,拿那两行的真实摘录来改正则。
 * @param {string} configText
 * @returns {boolean}
 */
function parseIsEnabled(configText) {
  const m = IS_ENABLED.exec(String(configText || ''))
  if (!m) return true
  return m[1] === 'True'
}

// methods.py:302-309 `is_module()` 的原文判据(文档见 :244):
// "A module must have `register_types.h`, `SCsub`, `config.py` files created to be detected.",
// 且 `os.path.isdir(path)` —— 少一件就不是模块,给它生成 module_x_enabled 是在猜。
const MODULE_MARKERS = ['register_types.h', 'SCsub', 'config.py']

/**
 * 探测内置模块开关。键一律 `module_<目录名>_enabled`(methods.py:258 `module_name = os.path.basename(path)`,
 * 拼键的动作在 SConstruct:485)—— 没有名字翻译层,所以 `jolt_physics` 就是 `module_jolt_physics_enabled`,
 * 官方文档里那个 `module_jolt_enabled` 是滞后写法,源码里不存在。
 * 点开头的条目跳过:methods.py:273 用 `glob.glob(os.path.join(path, "*"))` 枚举子项,`*` 天然不匹配点开头。
 * @param {(rel: string) => string[]} listDir  传 'modules' 时返回其下条目名
 * @param {(rel: string) => boolean} exists
 * @param {(rel: string) => string} read
 * @returns {OptionMap}
 */
function detectBuiltinModules(listDir, exists, read) {
  /** @type {OptionMap} */
  const out = {}
  let names = []
  try { names = listDir('modules') || [] } catch (e) { return out }
  for (const name of names) {
    if (!name || name.startsWith('.')) continue
    const base = `modules/${name}`
    if (!MODULE_MARKERS.every((f) => safeExists(exists, `${base}/${f}`))) continue
    const key = `module_${name}_enabled`
    if (key in out) continue
    out[key] = { exists: true, default: parseIsEnabled(safeRead(read, `${base}/config.py`)) }
  }
  return out
}

/** @param {(p: string) => boolean} fn @param {string} p */
function safeExists(fn, p) {
  try { return !!fn(p) } catch (e) { return false }
}
/** @param {(p: string) => string} fn @param {string} p */
function safeRead(fn, p) {
  try { return String(fn(p) || '') } catch (e) { return '' }
}

/**
 * 解析 `if env["<x>"]:` 块里的 `env["<y>"] = True` 赋值,当作这份源码的真实连带图。
 *
 * 为什么要探不内置:4.3-stable 的 `disable_3d` 块(:963-968)只加一个 `_3D_DISABLED` 宏,
 * 4.5-stable(:1023-1027)起才强制 navigation_3d/physics_3d/xr(4.7.2 在 :1076-1080)。
 * 内置声明会在 4.3 上谎称裁掉了那三项 —— 而 4.3 根本没有那三个选项,探测会正确判 absent。
 * 出块判据用缩进(顶行 `if` 之后所有更深缩进行都属于该块),所以 4.3 那个 if/else 嵌套
 * 也能正确走完;else 分支里没有 `env["x"] = True` 赋值,结果仍为空。
 * @param {string} text
 * @returns {Record<string, string[]>}
 */
function parseCascades(text) {
  /** @type {Record<string, string[]>} */
  const out = {}
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const head = /^if\s+env\["([a-z0-9_]+)"\]:\s*$/.exec(lines[i])
    if (!head) continue
    const src = head[1]
    /** @type {string[]} */
    const targets = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (!line.trim()) continue
      if (!/^[ \t]/.test(line)) break // 回到顶格 = 出块
      const a = /^[ \t]+env\["([a-z0-9_]+)"\]\s*=\s*True\s*$/.exec(line)
      if (a && a[1] !== src && !targets.includes(a[1])) targets.push(a[1])
    }
    if (targets.length) out[src] = targets
  }
  return out
}

/**
 * 读 version.py 拼版本串。缺任一字段就返回空串 —— 这个值用来做版本闸,
 * 猜一个"看起来对"的串比承认读不出来更糟(它会放行一份错版本源码)。
 *
 * **patch 为 0 时不进版本串**,这是官方形态不是我们定的:
 * tag `4.3-stable` 的 version.py:3-6 逐字是 `major = 4 / minor = 3 / patch = 0 / status = "stable"`
 * (4.5-stable 同形,均已从 tar 包实读),而对外用的串是 `4.3-stable` / `4.3.stable` ——
 * 见本仓库 `godotExe.js:146`(`Godot_v4.3-stable_win64.exe → 4.3-stable`)与
 * `templates.js:39`(`4.3-stable → 4.3.stable`、`4.2.2-stable → 4.2.2.stable`)。
 * 若把 patch 0 拼成 `4.3.0-stable`,Task 7 那道版本闸会把 4.3 / 4.5 的源码**一律判成版本不符**。
 * @param {string} text
 * @returns {string}
 */
function parseVersionPy(text) {
  const s = String(text || '')
  /** @param {string} k @returns {string} 读到返回数字串,没读到返回空串 */
  const num = (k) => { const m = new RegExp('^\\s*' + k + '\\s*=\\s*(\\d+)\\s*$', 'm').exec(s); return m ? m[1] : '' }
  const st = /^\s*status\s*=\s*["']([^"']+)["']\s*$/m.exec(s)
  const major = num('major'), minor = num('minor'), patch = num('patch')
  // 三个数字字段一律按"读没读到"判,不按真假值判。注:`num()` 的值域只有**空串**与**非空数字串**,
  // 而 `!'0'` 为 `false`,所以 `x === ''` 与 `!x` 在整个值域上**恒等价**(把 major/minor 写成 0
  // 也杀不掉这条,别把它当修了一个真实存在的误判)—— 变异自检里它记为等价变异 V-M5。
  // 统一成 `=== ''` 是让读代码的人不必先去推 `num()` 的返回类型。
  if (major === '' || minor === '' || patch === '' || !st) return ''
  return patch === '0' ? `${major}.${minor}-${st[1]}` : `${major}.${minor}.${patch}-${st[1]}`
}

/**
 * 目标引擎 tag → 可比对的版本串。本仓库的 tag 就是版本串形态(`4.7.2-stable`/`4.7-stable`,
 * 由 releases.js 从 GitHub tag 直接取),所以这里只做裁剪不去规范化 ——
 * patch 0 的省略发生在 parseVersionPy 那一侧,两侧同形态才能对上。
 * @param {string} tag @returns {string}
 */
function versionStringFromTag(tag) {
  return String(tag || '').trim()
}

// 已实测版本表(策划书附录 B)。**只放真编译过并核对过产物的版本**,它只回答
// "这个版本我们替它背过书吗",不参与存在性判断 —— 存在性永远由探测回答。
const TESTED_VERSIONS = ['4.7.2-stable']

// 只做过**静态核对**(逐条比对源码声明,没有编译产物背书)的版本,附录 B 分档如此。
// 混进 TESTED_VERSIONS 会给 4.3/4.5 的用户一个我们没背过的书,故另立一张表(Ruling #8)。
// 与 TESTED_VERSIONS 一样不参与存在性判断,只影响文案强度。
const STATIC_CHECKED_VERSIONS = ['4.5-stable', '4.3-stable']

// P0 恒为 `scons platform=windows`(策划书 §2 决策 6),所以平台脚本只读 windows 那份。
// 为什么非读不可:能力表里 `optStaticCpp` 的 flag `use_static_cpp` **声明**在
// `platform/windows/detect.py:229`(BoolVariable,默认 True),SConstruct 里只有 :675 那句
// `methods.get_cmdline_bool("use_static_cpp", True)` 的读取 —— 不读平台脚本就探不到这条声明,
// 该面板项永远标灰。非 Windows 源码树里这个文件不存在,readOpt 拿到空串,合入空表,其余结果不受影响。
const PLATFORM_BUILD_SCRIPTS = ['platform/windows/detect.py']

/**
 * 合并两份 OptionMap:**同名先到先得**,后出现的**不覆盖**先出现的。
 * 这条规则在单文件里由 parseSconsOptions 内部 `if (m[1] in out) continue` 实现,
 * 但探测层要合并多份脚本(SConstruct + platform/windows/detect.py + 模块开关),
 * "谁覆盖谁"直接决定 profile 里写什么 —— 所以合并口径与单文件必须一致(裁定 A)。
 * 真实 4.7.2 跨文件重名 0 处(用本层的 parseSconsOptions 实跑核过:SConstruct 90 个名字
 * ∩ platform/windows/detect.py 12 个 = 空,∩ 各 config.py 声明的 4 个
 * (graphite / mp3_extra_formats / betsy_export_templates / cvtt_export_templates)= 空,
 * ∩ 57 个 module_*_enabled = 空),所以这条规则当下是防御性的;
 * 但防御规则一旦被改成"后者覆盖",没有任何真实源码会喊,只有测试钉得住。
 * @param {OptionMap} target 先声明的那份(原地写入)
 * @param {OptionMap} extra 后读到的那份
 * @returns {OptionMap}
 */
function mergeOptionsFirstWins(target, extra) {
  for (const k of Object.keys(extra || {})) if (!(k in target)) target[k] = extra[k]
  return target
}

/**
 * 平台 get_flags 覆盖表(SConstruct:434-437 的消费点):这些键除非命令行点名,env 直接取平台值 ——
 * SConstruct 里 BoolVariable 的声明默认**不是生效默认**。真机踩过的坑:d3d12 在 SConstruct:199
 * 声明 False,而 windows 的 get_flags 给 True(detect.py:294),面板按声明默认算「取消 = 与默认相同
 * 不发 token」,scons 却按平台默认开着编,配置阶段停在 D3D12 SDK 检查上。
 * 只认 get_flags 函数体里的布尔键,其余(arch / supported 等非布尔或非标键)不猜。
 * @param {string} detectText platform/windows/detect.py 的原文(读不到给空串)
 * @returns {Record<string, boolean>}
 */
function parsePlatformFlags(detectText) {
  const text = String(detectText || '')
  const at = text.indexOf('def get_flags():')
  if (at < 0) return {}
  const next = text.indexOf('\ndef ', at + 1)
  const body = text.slice(at, next < 0 ? text.length : next)
  /** @type {Record<string, boolean>} */
  const out = {}
  for (const m of body.matchAll(/"([a-z0-9_]+)":\s*(True|False)/g)) out[m[1]] = m[2] === 'True'
  return out
}

/**
 * 探测一份源码树 —— 本层**唯一**做 IO 的函数,且 IO 全部走可注入的 deps
 * (readFileSync / existsSync / readdirSync),只有不传 deps 时才回落到真 node:fs。
 * 返回值喂给输出层:`options` 是「这个开关在这份源码里存不存在 + 源码默认值」的唯一真源,
 * `cascades` 是这份源码自己的连带图(4.3 与 4.7.2 形态不同,故不内置)。
 * `sourceVersion` 读不出为空串(版本闸的判据,不猜);`tested` 只回答在不在已实测表里;
 * `tagMatched` 只在调用方给了 `targetTag` 时才参与比对,没给就留 false。
 * @param {string} srcDir
 * @param {{readFileSync?: (fp: string, enc: string) => string, existsSync?: (fp: string) => boolean,
 *   readdirSync?: (fp: string) => string[], targetTag?: string}} [deps]
 * @returns {Promise<{ok: boolean, error: string, sourceVersion: string, tested: boolean,
 *   tagMatched: boolean, options: OptionMap, cascades: Record<string, string[]>, testedVersions: string[]}>}
 */
async function probeSource(srcDir, deps) {
  const d = deps || {}
  /** @type {(fp: string, enc: string) => string} */
  const readFileSync = d.readFileSync || ((fp, enc) => String(require('node:fs').readFileSync(fp, enc)))
  /** @type {(fp: string) => boolean} */
  const existsSync = d.existsSync || ((fp) => require('node:fs').existsSync(fp))
  /** @type {(fp: string) => string[]} */
  const readdirSync = d.readdirSync || ((fp) => require('node:fs').readdirSync(fp).map((x) => String(x)))
  /** @param {...string} seg @returns {string} */
  function p(...seg) { return require('node:path').join(srcDir, ...seg) }
  // testedVersions 交出去的是**副本**:按引用交模块级常量,下游一次 .push() 就永久污染已实测表,
  // 而下面 `tested` 的判定用的正是同一个数组(计划书里 T8 只 `.includes` 读,不是活 bug,但不留给下游)。
  // STATIC_CHECKED_VERSIONS 不进返回值,所以不用同样处理。
  const out = { ok: false, error: '', sourceVersion: '', tested: false, tagMatched: false, options: /** @type {OptionMap} */ ({}), cascades: {}, testedVersions: TESTED_VERSIONS.slice() }
  // SConstruct 是"这是不是 Godot 源码根"的唯一判据(与 buildtools.js 现有那道同步校验同一条)。
  if (!srcDir || !safeExists(existsSync, p('SConstruct'))) {
    out.error = '所选目录不是 Godot 源码根(缺 SConstruct),无法探测构建选项'
    return out
  }
  /** @param {string} rel @returns {string} 读不到(不存在/被占用/是目录)一律给空串,不抛 */
  const readOpt = (rel) => { try { return String(readFileSync(p(rel), 'utf8')) } catch (e) { return '' } }
  const sc = readOpt('SConstruct')
  mergeOptionsFirstWins(out.options, parseSconsOptions(sc))
  for (const rel of PLATFORM_BUILD_SCRIPTS) {
    mergeOptionsFirstWins(out.options, parseSconsOptions(readOpt(rel)))
  }
  mergeOptionsFirstWins(out.options, detectBuiltinModules(
    (rel) => { try { return rel === 'modules' ? readdirSync(p('modules')).map((x) => String(x)) : [] } catch (e) { return [] } },
    (rel) => safeExists(existsSync, p(rel)),
    (rel) => readOpt(rel)
  ))
  // 平台覆盖层最后盖:生效默认 = 平台 get_flags 覆盖后的值(只盖两边都声明了的键,未声明的不凭空造)
  const platformFlags = parsePlatformFlags(readOpt(require('node:path').join('platform', 'windows', 'detect.py')))
  for (const k of Object.keys(platformFlags)) {
    if (out.options[k] && out.options[k].exists) out.options[k] = { exists: true, default: platformFlags[k] }
  }
  // 连带块都在 SConstruct 顶层(parseCascades 认顶格 `if env["x"]:),平台脚本里那些是缩进的,
  // 喂进去恒为空 —— 只从 SConstruct 解析一次。
  out.cascades = parseCascades(sc)
  out.sourceVersion = parseVersionPy(readOpt('version.py'))
  // tested 只回答"这个版本在附录 B 的已实测表里吗";不在表里照样探测成功,由渲染层给保守提示。
  out.tested = TESTED_VERSIONS.includes(out.sourceVersion)
  // targetTag 可选:调用方带来要比的目标引擎时才算 tagMatched,没带就留 false ——
  // 不能无条件置 true,那等于谎报"版本对得上"。这道守卫最要紧的一支在**读不出 version.py** 的树上:
  // 那时 sourceVersion='' 而 versionStringFromTag(undefined)='' 两侧同为空串,少了守卫就会把
  // "版本不明"算成"版本对得上"。
  if (d.targetTag) out.tagMatched = out.sourceVersion === versionStringFromTag(d.targetTag)
  out.ok = true
  return out
}

module.exports = {
  parseSconsOptions, parseIsEnabled, detectBuiltinModules, parseCascades, MODULE_MARKERS,
  parseVersionPy, versionStringFromTag, probeSource, parsePlatformFlags, TESTED_VERSIONS, STATIC_CHECKED_VERSIONS
}
