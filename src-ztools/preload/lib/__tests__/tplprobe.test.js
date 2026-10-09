// 探测层(tplprobe.js)的测试。全部用**逐字摘自真实源码**的片段当夹具,不自己编形态 ——
// 这层唯一的价值就是"和源码写得一样",夹具编错了实现就跟着错。
// 片段取自 godotengine/godot tag 4.7.2-stable 的 SConstruct(sha256 已核,见策划书附录 B)。
// 用法: node src-ztools/preload/lib/__tests__/tplprobe.test.js
// 不是「单文件原样摘录」的夹具目前有九处,每处就在原位写明合成在哪、真实出处又是哪一行:
//   1) 单引号 BoolVariable 声明 —— 4.7.2 全树 0 处,只验正则的跨版本防御支;
//   2) modules 探测里的 broken_module / .gitkeep —— 真实 modules/ 下没有这两个条目,是造的假目录;
//   3) 4.3 那段里的 disable_advanced_gui 块 —— 真实 4.3(:969-977)是嵌套 if/else,这里借了 4.7.2 的平铺写法占位;
//   4) MONO_CFG —— mono/config.py:31-33 与 webp/config.py:1-2 两段真实摘录的**拼接**,不是单文件原文;
//   5) jolt_physics 的 config.py 置空 —— 真实文件有 can_build 逻辑,本条只验键名,属简化;
//   6) 三条「注入回调抛 EPERM」的 —— 验的是回调契约不是文件形态,真实源码里不存在这种 config.py;
//   7) probeSource 那三棵临时树(主树 / dup 树 / 4.3 树)与注入用的 fakeTree —— 整棵目录树都是造的
//      (fakeTree 尤其:它压根不在磁盘上),但每一**行内容**要么逐字摘自真实源码,要么按下一条标明;
//   8) dup 树里的四处重名声明(disable_3d 在平台脚本再声明一遍、module_webp_enabled 写进 SConstruct、
//      only_in_detect 与 dup_in_file)—— 合成形态:真实 4.7.2 跨文件重名 0 处、同文件重名 0 处
//      (用本层 parseSconsOptions 实跑:SConstruct 90 名 ∩ detect.py 12 名 ∩ 各 config.py 4 名
//      ∩ 57 个 module_*_enabled,四组交集全空),造它们只为钉住合并顺序;
//   9) '4.6-dev' 那份 version.py —— 字段形态真实,数值是把真实 4.3 摘录的 minor 改 6、status 改 dev。
// 另有两处对简报的更正(不改结论,只把冒充摘录的文本改回真实文本 / 补漏掉的换行),见原位注释。
const P = require('../tplprobe.js')

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

// SConstruct:264 / :199 / :190 / :202 —— 四种默认值形态各来一条
const SCORE = [
  'opts.Add(BoolVariable("disable_3d", "Disable 3D nodes for a smaller executable", False))',
  'opts.Add(BoolVariable("d3d12", "Enable the Direct3D 12 rendering driver on supported platforms", False))',
  'opts.Add(BoolVariable("deprecated", "Enable compatibility code for deprecated and removed features", True))',
  'opts.Add(BoolVariable("accesskit", "Enable the AccessKit driver for screen reader support", True))',
  // SConstruct:169-177 —— EnumVariable 跨多行声明,默认值 "auto"
  'opts.Add(',
  '    EnumVariable(',
  '        "optimize",',
  '        "Optimization level (by default inferred from \'target\' and \'dev_build\')",',
  '        "auto",',
  '        ["auto", "none", "custom", "debug", "speed", "speed_trace", "size", "size_extra"],',
  '        ignorecase=2,',
  '    )',
  ')',
  // SConstruct:183 —— lto 默认 "none"
  'opts.Add(',
  '    EnumVariable(',
  '        "lto", "Link-time optimization (production builds)", "none", ["none", "auto", "thin", "full"], ignorecase=2',
  '    )',
  ')'
].join('\n')

section('BoolVariable / EnumVariable 声明解析')
const o = P.parseSconsOptions(SCORE)
ok(o.disable_3d && o.disable_3d.exists && o.disable_3d.default === false, 'disable_3d 存在且默认 False', JSON.stringify(o.disable_3d))
ok(o.d3d12 && o.d3d12.default === false, 'd3d12 默认 False —— 现状硬编码的 d3d12=no 是空操作(策划书 §0 纠正)')
ok(o.deprecated && o.deprecated.default === true, 'deprecated 默认 True')
ok(o.accesskit && o.accesskit.default === true, 'accesskit 默认 True')
ok(o.optimize && o.optimize.default === 'auto', '跨多行的 EnumVariable 也认得,默认 auto', JSON.stringify(o.optimize))
ok(o.lto && o.lto.default === 'none', 'lto 默认字符串 none')

section('不该被误认的东西')
// 逐键精确比对,不写「某个键不在结果里」这种恒真断言 —— 夹具里根本没有 env["x"] 文本时,
// !('env' in o) 在任何正则下都会 PASS,验不出东西。改成列全 SCORE 应得的全部键:
// 多命中一个（把引用/元组当声明）或漏命中一个都会红。
ok(Object.keys(o).sort().join(',') === 'accesskit,d3d12,deprecated,disable_3d,lto,optimize',
   'SCORE 夹具逐键精确：只解析出这 6 个键，无多余命中', Object.keys(o).sort().join(','))
ok(P.parseSconsOptions('') !== null, '空文本返回对象而不是 null')
// SConstruct:141 / :142 / :376 / :383 / :392 —— 逐字摘自真实源码的 env["x"] 引用与赋值行。
// 这些是「源码里提过某个名字」的典型噪声，一处三参声明都没有；早先用 'nothing here' 当夹具
// 不含引号也不含括号，正则放宽到天上去也命中不了它，等于没验。
const SCONS_ENV_REFS = [
  'env["x86_libtheora_opt_gcc"] = False',
  'env["x86_libtheora_opt_vc"] = False',
  'if env["import_env_vars"]:',
  'if not env["platform"]:',
  '        env["platform"] = "linuxbsd"'
].join('\n')
const ENV_REFS = P.parseSconsOptions(SCONS_ENV_REFS)
ok(Object.keys(ENV_REFS).length === 0, 'env["x"] 引用与赋值行不作声明（SConstruct:141/142/376/383/392 逐字）',
   JSON.stringify(ENV_REFS))
// 合成夹具，非真实源码摘录：4.7.2 全树单引号形态的 (Bool|Enum)Variable(' 声明 0 处（grep 已核实）。
// 正则里的单引号支保留下来只是跨版本防御（更早的 4.x / 下游补丁里混用过单引号），
// 这条断言验的就是那个分支本身，别把它当真实夹具引用。
const SQ = "opts.Add(BoolVariable('winrt', 'Use WinRT API.', True))"
ok(P.parseSconsOptions(SQ).winrt && P.parseSconsOptions(SQ).winrt.default === true,
   '单引号分支能解析（合成形态，验证正则的单引号支，非真实源码摘录）', JSON.stringify(P.parseSconsOptions(SQ)))

// platform/windows/detect.py:224-235 —— 逐字摘自真实文件的一段 opts.Add 列表项。
// 同一函数要能直接吃平台文件:§5.1 里 `W:` 探针(use_static_cpp / windows_subsystem)靠的就是这个复用。
// 这段夹具白送三个真实陷阱,由下面第一条断言逐键钉住:
//   1. 元组形态的 ("msvc_version", …) / ("mssdk_version", …) 不算变量声明(无 Bool/Enum 前缀);
//   2. help 里带括号的 winrt 行("Use WinRT API (OneCore TTS support).")要照常解析出 default=true;
//   3. help 里带裸撇号的 debug_crt / silence_msvc 行("MSVC's debug CRT (/MDd)")不干扰引号配对。
const WINDOWS_DETECT = [
  '        EnumVariable("windows_subsystem", "Windows subsystem", "gui", ["gui", "console"], ignorecase=2),',
  '        ("msvc_version", "MSVC version to use. Handled automatically by SCons if omitted.", ""),',
  '        ("mssdk_version", "Windows SDK version to use. Handled automatically by SCons if omitted.", ""),',
  '        BoolVariable("use_mingw", "Use the Mingw compiler, even if MSVC is installed.", False),',
  '        BoolVariable("use_llvm", "Use the LLVM compiler", False),',
  '        BoolVariable("use_static_cpp", "Link MinGW/MSVC C++ runtime libraries statically", True),',
  '        BoolVariable("use_asan", "Use address sanitizer (ASAN)", False),',
  '        BoolVariable("use_ubsan", "Use LLVM compiler undefined behavior sanitizer (UBSAN)", False),',
  '        BoolVariable("debug_crt", "Compile with MSVC\'s debug CRT (/MDd)", False),',
  '        BoolVariable("incremental_link", "Use MSVC incremental linking. May increase or decrease build times.", False),',
  '        BoolVariable("silence_msvc", "Silence MSVC\'s cl/link stdout bloat, redirecting any errors to stderr.", True),',
  '        BoolVariable("winrt", "Use WinRT API (OneCore TTS support).", True),'
].join('\n')

section('同一函数对平台文件同样成立')
const w = P.parseSconsOptions(WINDOWS_DETECT)
// 同样逐键精确。早先这条只观察 msvc_version / mssdk_version 缺席,winrt 那行带括号的 help
// 或 debug_crt / silence_msvc 带裸撇号的 help 只要有一行解析不出来,keys 就对不上 —— 这才有人喊。
ok(Object.keys(w).sort().join(',') === 'debug_crt,incremental_link,silence_msvc,use_asan,use_llvm,use_mingw,use_static_cpp,use_ubsan,windows_subsystem,winrt'
   && w.winrt.default === true && w.debug_crt.default === false && w.silence_msvc.default === true,
   '平台文件逐键精确：元组形态不作声明；带括号 help 与带裸撇号 help 照旧解析', Object.keys(w).sort().join(','))
ok(w.use_static_cpp && w.use_static_cpp.default === true && w.windows_subsystem && w.windows_subsystem.default === 'gui',
   'detect.py 探针:use_static_cpp=True 且 windows_subsystem="gui"', JSON.stringify({ u: w.use_static_cpp, s: w.windows_subsystem }))

section('is_enabled() 解析(模块默认值)')
// MONO_CFG 是**拼接夹具**,不是单文件原样摘录,两段各自的出处:
//   - `def is_enabled():` + 那行注释 + `return False` 逐字取自 modules/mono/config.py:31-33
//     (modules/text_server_fb/config.py:10-12 是同一个形态,注释里换了自己的选项名);
//   - 头两行 `def can_build(env, platform): / return True` 逐字取自 modules/webp/config.py:1-2。
//     mono 自己的 can_build 里还夹着 env.module_add_dependencies("mono", ["regex"]),与本条要验的
//     is_enabled() 形态无关,所以借 webp 的那两行 —— 别把它当作 mono/config.py 的原文。
// 这条真正要钉住的是 `def is_enabled():` 与 `return` 之间夹注释行也要认得:4.7.2 全树只有
// mono 与 text_server_fb 两个模块定义 is_enabled(),而且两个都是这个带注释的写法。
const MONO_CFG = 'def can_build(env, platform):\n    return True\n\n\ndef is_enabled():\n    # The module is disabled by default. Use module_mono_enabled=yes to enable it.\n    return False\n'
ok(P.parseIsEnabled(MONO_CFG) === false, 'mono/text_server_fb 的 is_enabled() 带注释行也认得 → False')
// 这个夹具逐字取自 modules/webp/config.py:1-2(真实文件 :1-6 还有 configure(env): pass,没有 is_enabled())。
// 4.7.2 另外 55 个模块的 config.py 都没有 is_enabled() —— 依据 SConstruct:476-483,先置 True,
// 再 try 调 config.is_enabled(),只有 AttributeError 才保持 True。
ok(P.parseIsEnabled('def can_build(env, platform):\n    return True\n') === true, '没有 is_enabled() → 默认 True(SConstruct:476-483)')

section('内置模块探测:目录名即模块名')
// methods.py:258 `module_name = os.path.basename(path)` —— 没有名字翻译层;
// SConstruct:485 `opts.Add(BoolVariable(f"module_{name}_enabled", ...))` 就是键名的出处。
// 检测门槛 methods.py:302-309 is_module()(文档见 :244):必须是目录,且 register_types.h / SCsub /
// config.py 三件齐。少一件就不是模块,给它生成 module_x_enabled 是在猜。
// 夹具各条目的真实程度:
//   - webp / jolt_physics / mono:真实 4.7.2 modules/ 下确有这三个目录,三件文件齐(tar 清单已核)。
//     webp 的 config.py 内容逐字取自 modules/webp/config.py:1-2;mono 的用上面的 MONO_CFG;
//     jolt_physics 的 config.py 置空是**简化**(真实文件有 can_build 逻辑),本条只验它的键名不验默认值。
//   - broken_module / .gitkeep:**合成形态,真实 modules/ 下没有这两个条目**。
//     broken_module 只给 register_types.h(缺另两件)→ 验三件齐的门槛;
//     .gitkeep 故意三件齐、只让名字以点开头 → 验点规则。若不给它配齐三件,把它挡掉的就是
//     "三件不齐"而不是点规则,那条断言在任何点规则变异下都会 PASS(等于没验)。
//     点目录该被跳过的依据:methods.py:273 用 glob.glob(os.path.join(path, "*")) 枚举子项,
//     glob 的 `*` 天然不匹配点开头条目。
const tree = {
  'modules/webp/register_types.h': '', 'modules/webp/SCsub': '', 'modules/webp/config.py': 'def can_build(env, platform):\n    return True\n',
  'modules/jolt_physics/register_types.h': '', 'modules/jolt_physics/SCsub': '', 'modules/jolt_physics/config.py': '',
  'modules/mono/register_types.h': '', 'modules/mono/SCsub': '', 'modules/mono/config.py': MONO_CFG,
  'modules/broken_module/register_types.h': '', // 缺 SCsub 与 config.py → 不算模块
  'modules/.gitkeep/register_types.h': '', 'modules/.gitkeep/SCsub': '', 'modules/.gitkeep/config.py': '' // 三件齐但以点开头 → 不算模块
}
const dirs = ['webp', 'jolt_physics', 'mono', 'broken_module', '.gitkeep']
const mods = P.detectBuiltinModules(
  (rel) => (rel === 'modules' ? dirs : []),
  (rel) => Object.prototype.hasOwnProperty.call(tree, rel),
  (rel) => tree[rel] || ''
)
ok(mods.module_webp_enabled && mods.module_webp_enabled.default === true, 'webp → module_webp_enabled 默认 True')
ok(!!mods.module_jolt_physics_enabled, 'jolt_physics → module_jolt_physics_enabled(不是 module_jolt_enabled)')
ok(mods.module_mono_enabled && mods.module_mono_enabled.default === false, 'mono 默认 False → 面板初始不勾')
// 形状钉一条:输出层的规则(策划书 §5.3「选择 ≠ 默认才输出」)读的就是 exists + default 这两个字段,
// 上面几条只看了 default,把 exists 改成 false 谁都不会喊 —— 这条专门盯它。
ok(mods.module_webp_enabled.exists === true && mods.module_mono_enabled.exists === true,
   '两条开关都按 OptionMap 形状给出 exists:true(default 由上面两条分别钉 True/False)')
ok(!('module_broken_module_enabled' in mods), '三件不齐的目录不当它是模块')
// 键名按 `module_${name}_enabled` 拼接,name='.gitkeep' 时点是原样带进去的,
// 所以这里断言的是实现真正会写出的那个键(不是把点吞掉后的 module__gitkeep_enabled)。
ok(!('module_.gitkeep_enabled' in mods), '点开头目录不当模块(按实现会写成 module_.gitkeep_enabled)')
// 逐键精确钉一遍全表:多生成一个键(broken_module 或 .gitkeep 漏进来)或漏一个都会红。
ok(Object.keys(mods).sort().join(',') === 'module_jolt_physics_enabled,module_mono_enabled,module_webp_enabled',
   'detectBuiltinModules 逐键精确:只出这三个键', Object.keys(mods).sort().join(','))
// 下面三条是**合成形态,非真实源码摘录**:验的不是某种 config.py 写法,而是「注入回调抛异常」这个
// 注入行为 —— 真实源码树里不存在这样一种文件形态。要它是因为 Task 4 的 probeSource 会把
// fs.existsSync / fs.readFileSync / fs.readdirSync 原样传进来,而 Windows 上用户的源码树正在被
// git checkout、或被杀软锁文件时这些调用会抛 EPERM;探测层抛出去整个面板就崩了。
ok(Object.keys(P.detectBuiltinModules(() => { throw new Error('EPERM') }, () => true, () => '')).length === 0,
   'listDir(readdirSync) 抛异常 → 返回空表,不把异常抛给调用方')
ok(P.detectBuiltinModules(() => ['webp'], () => true, () => { throw new Error('EPERM') }).module_webp_enabled.default === true,
   'config.py 读失败(readFileSync 抛) → 键照常出,default 回落 True(SConstruct:476-483 那个 AttributeError 分支同义)',
   JSON.stringify(P.detectBuiltinModules(() => ['webp'], () => true, () => { throw new Error('EPERM') })))
ok(Object.keys(P.detectBuiltinModules(() => ['webp'], () => { throw new Error('EPERM') }, () => '')).length === 0,
   '标记文件探测抛异常(existsSync 抛) → 该模块当作不是模块,不把异常抛给调用方')

section('cascade:4.3 与 4.7.2 形态不同,必须探不能内置(策划书 §5.4)')
// C472 逐字摘自 4.7.2 的 SConstruct:1076-1082(disable_3d 块 1076-1080 + disable_advanced_gui 块 1081-1082)。
// C43 的 disable_3d 块:结构与 4.3-stable 的 SConstruct:963-968 一致(嵌套 if/else + Exit(255)),
//   只把 :965 那句长 print_error 文案截成 "nope",缩进层级照原文。
// C43 的 disable_advanced_gui 块是**合成形态,非真实摘录**:真实 4.3(:969-977)那个块同样是
//   嵌套 if/else,这里用的是 4.7.2 的平铺写法,只当占位用 —— 验走完 4.3 那个嵌套块后能正确出块。
const C43 = 'if env["disable_3d"]:\n    if env.editor_build:\n        print_error("nope")\n        Exit(255)\n    else:\n        env.Append(CPPDEFINES=["_3D_DISABLED"])\nif env["disable_advanced_gui"]:\n    env.Append(CPPDEFINES=["ADVANCED_GUI_DISABLED"])\n'
const C472 = 'if env["disable_3d"]:\n    env.Append(CPPDEFINES=["_3D_DISABLED"])\n    env["disable_navigation_3d"] = True\n    env["disable_physics_3d"] = True\n    env["disable_xr"] = True\nif env["disable_advanced_gui"]:\n    env.Append(CPPDEFINES=["ADVANCED_GUI_DISABLED"])\n'
const c43 = P.parseCascades(C43)
const c472 = P.parseCascades(C472)
ok(!c43.disable_3d, '4.3:disable_3d 不连带任何东西', JSON.stringify(c43))
// 上面那条只盯 disable_3d 一个键,实现若对整个 4.3 夹具乱生出别的键它就沉默;
// 这条把整份结果钉成空对象 —— 这是"cascade 必须探测而非内置"的实证依据(真实 4.3 全量 SConstruct 同样为空)。
ok(JSON.stringify(c43) === '{}', '4.3 夹具逐键精确:整份结果一个连带都不产出', JSON.stringify(c43))
ok(JSON.stringify(c472.disable_3d) === JSON.stringify(['disable_navigation_3d', 'disable_physics_3d', 'disable_xr']), '4.7.2:连带那三项且保持源码里的顺序', JSON.stringify(c472.disable_3d))
ok(!c472.disable_advanced_gui, 'disable_advanced_gui 无连带(SConstruct:1081-1082 只加宏)')
// 逐字摘自 4.7.2 的 SConstruct:580-589。这段专门钉「出块判据」::580 那个块只有一行 Append,
// :583 回到顶格就该停;而 :589 那条 `env["no_editor_splash"] = True` 缩进更深、离它只有六行,
// 出块判据一失效(见变异 M10),它就会被算成 use_precise_math_checks 的连带。
// 上面三条 cascade 断言都碰不到它 —— 那三段夹具里没有任何跨块的赋值行。
const EXIT_FIX = 'if env["use_precise_math_checks"]:\n    env.Append(CPPDEFINES=["PRECISE_MATH_CHECKS"])\n\nif env.editor_build:\n    if env["engine_update_check"]:\n        env.Append(CPPDEFINES=["ENGINE_UPDATE_CHECK_ENABLED"])\n\n    if not env.File("#main/splash_editor.png").exists():\n        # Force disabling editor splash if missing.\n        env["no_editor_splash"] = True\n'
const cExit = P.parseCascades(EXIT_FIX)
ok(Object.keys(cExit).length === 0, '出块靠缩进判断:SConstruct:580 块在 :583 顶行处停住,:589 的赋值不算它的连带',
   JSON.stringify(cExit))

section('version.py 解析(源码版本闸的判据)')
// 逐字取自真实 version.py:1-6(4.7.2-stable)。注意真实第 2 行是 `name = "Godot Engine"`,
// 不是简报里写的 `engine_name` —— 简报那份自称"逐字取自 version.py:1-6"却把键名抄错了,
// 这里按真实文件更正(本函数只读 major/minor/patch/status,两种写法的解析结果相同)。
const VERSION_PY = 'short_name = "godot"\nname = "Godot Engine"\nmajor = 4\nminor = 7\npatch = 2\nstatus = "stable"\n'
ok(P.parseVersionPy(VERSION_PY) === '4.7.2-stable', '4.7.2-stable', P.parseVersionPy(VERSION_PY))
// 半合成夹具:字段形态真实,数值是把上面 4.3 那份的 minor 换成 6、status 换成 dev,并少一行 `name = ...`
// (真实源码里 status = "dev" 的是 master 那份,本地没有那棵树,不冒充它的摘录)。
ok(P.parseVersionPy('short_name = "godot"\nmajor = 4\nminor = 6\npatch = 0\nstatus = "dev"\n') === '4.6-dev',
   'patch 0 时只拼两段(换 status 通道也一样)', P.parseVersionPy('short_name = "godot"\nmajor = 4\nminor = 6\npatch = 0\nstatus = "dev"\n'))
// 逐字取自真实 4.3-stable 的 version.py:1-6(从 godot-4.3-stable.tar.xz 实读;4.5-stable 同形只换 minor)。
// 这条钉的是「patch = 0 不进版本串」—— 官方 tag 就是 `4.3-stable`,拼成 `4.3.0-stable` 会让
// Task 7 那道版本闸把 4.3 / 4.5 的源码一律判成版本不符(依据见 tplprobe.js 的 parseVersionPy 注释)。
const VERSION_PY_43 = 'short_name = "godot"\nname = "Godot Engine"\nmajor = 4\nminor = 3\npatch = 0\nstatus = "stable"\n'
ok(P.parseVersionPy(VERSION_PY_43) === '4.3-stable', '真实 4.3-stable version.py:1-6 → 4.3-stable(patch 0 不拼)',
   P.parseVersionPy(VERSION_PY_43))
ok(P.parseVersionPy('major = 4\n') === '', '信息不全 → 空串(不猜)', P.parseVersionPy('major = 4\n'))
ok(P.parseVersionPy('major = 4\nminor = 7\npatch = 2\n') === '', '缺 status 同样给空串,不补一个"看起来对"的通道',
   P.parseVersionPy('major = 4\nminor = 7\npatch = 2\n'))
ok(P.versionStringFromTag('4.7.2-stable') === '4.7.2-stable', 'tag 已是同形态时原样')
ok(P.versionStringFromTag('4.7-stable') === '4.7-stable', '无 patch 段的 tag 原样')
ok(P.versionStringFromTag('  4.7.2-stable  ') === '4.7.2-stable', '两侧空白裁掉(否则版本闸拿带空格的 tag 比必不匹配)',
   JSON.stringify(P.versionStringFromTag('  4.7.2-stable  ')))
ok(P.versionStringFromTag(undefined) === '', '没有 tag → 空串而不是 "undefined"', String(P.versionStringFromTag(undefined)))

section('probeSource 汇总')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-tplprobe-'))
// 建一棵临时树(mk 是它的快捷方式,绑定到主夹具树根 root)
const mkAt = (dir) => (rel, body) => {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}
const mk = mkAt(root)
// SCORE 结尾没有换行、C472 开头是顶格 `if env[...]`,直接相加会得到 `)if env["disable_3d"]:` 一行,
// parseCascades 认的是顶格头行 → 连带图恒空。简报漏了这个换行,这里补上(否则下面 cascade 那条必红)。
mk('SConstruct', SCORE + '\n' + C472)
mk('version.py', VERSION_PY)
mk('modules/webp/register_types.h', ''); mk('modules/webp/SCsub', ''); mk('modules/webp/config.py', 'def can_build(env, platform):\n    return True\n')
mk('modules/mono/register_types.h', ''); mk('modules/mono/SCsub', ''); mk('modules/mono/config.py', MONO_CFG)

;(async () => {
  const r = await P.probeSource(root)
  ok(r.ok === true, '探测成功', r.error)
  ok(r.sourceVersion === '4.7.2-stable', '读出源码版本', r.sourceVersion)
  ok(r.tagMatched === false, '没带 targetTag 时不谎报匹配', String(r.tagMatched))
  ok(r.tested === true, '4.7.2-stable 在已实测表内(附录 B)')
  const rTag = await P.probeSource(root, { targetTag: '4.6-stable' })
  ok(rTag.tagMatched === false, '带一个不符的 targetTag → tagMatched false')
  const rTag2 = await P.probeSource(root, { targetTag: '4.7.2-stable' })
  ok(rTag2.tagMatched === true, '带相符的 targetTag → tagMatched true')
  ok(!!r.options.disable_3d, '核心开关进了结果')
  ok(!!r.options.module_webp_enabled, '模块开关进了结果')
  ok(JSON.stringify(r.cascades.disable_3d) === JSON.stringify(['disable_navigation_3d', 'disable_physics_3d', 'disable_xr']), 'cascade 进了结果')
  ok(Array.isArray(r.testedVersions) && r.testedVersions.includes('4.7.2-stable'), '带上已实测版本表(策划书附录 B)')
  // 缺 SConstruct 的目录:如实失败,不返回半成品
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-tplprobe-bad-'))
  const r2 = await P.probeSource(bad)
  ok(r2.ok === false && /SConstruct/.test(r2.error || ''), '缺 SConstruct → ok:false + 带原因', r2.error)

  // ---- 跨文件重名:合并口径必须与单文件那条「同名只取第一次」一致(裁定 A / Ruling #20) ----
  // 真实 4.7.2 里跨文件重名是 0 处(SConstruct 的 90 个名字 ∩ platform/windows/detect.py 的 12 个 = 空,
  // ∩ 各 config.py 声明的 graphite / mp3_extra_formats / betsy_export_templates / cvtt_export_templates 也空,
  // 已实跑核过)。所以这两份夹具里的同名声明是**合成形态,非真实摘录**,造的是一份后读进来的脚本。
  const dupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-tplprobe-dup-'))
  const mkDup = mkAt(dupRoot)
  // SConstruct 那份用真实摘录的那一行(:264),默认 False
  mkDup('SConstruct', 'opts.Add(BoolVariable("disable_3d", "Disable 3D nodes for a smaller executable", False))\n' +
    'opts.Add(BoolVariable("module_webp_enabled", "Enable the WebP image format module (合成形态:SConstruct 里这条是 f-string 生成的,不会有字面量名)", False))\n')
  // 平台脚本那份:同名 disable_3d 默认改成 True(合成形态;行式取自 detect.py:224-235 的缩进列表项形态)
  mkDup('platform/windows/detect.py', '        BoolVariable("disable_3d", "同名重写(合成形态)", True),\n' +
    '        BoolVariable("only_in_detect", "平台脚本独有的开关(合成形态)", True),\n' +
    '        BoolVariable("dup_in_file", "同文件里第一次声明(合成形态)", True),\n' +
    '        BoolVariable("dup_in_file", "同文件里第二次重名声明(合成形态)", False),')
  // 模块那份:webp 的 config.py 没有 is_enabled() → detectBuiltinModules 会给出 default true
  mkDup('modules/webp/register_types.h', ''); mkDup('modules/webp/SCsub', ''); mkDup('modules/webp/config.py', 'def can_build(env, platform):\n    return True\n')
  const dup = await P.probeSource(dupRoot)
  ok(dup.ok === true, '重名树照样探测成功(重名不是错误)', dup.error)
  ok(dup.options.disable_3d.default === false,
     '跨文件重名取**先声明的那份**(SConstruct 先读),后读的平台脚本没有把它覆盖成 True',
     JSON.stringify(dup.options.disable_3d))
  ok(dup.options.only_in_detect && dup.options.only_in_detect.default === true,
     '后读脚本独有的开关仍然并进结果 —— 先到先得不是「只读第一份」',
     JSON.stringify(dup.options.only_in_detect))
  // 同一份脚本里重名(dup_in_file 声明了两次,True 在前 False 在后)—— 这条专门看守
  // parseSconsOptions 里那句 `if (m[1] in out) continue`(Ruling #20 说它至今零回归保护)。
  // 上面三条都碰不到它:那三条测的是**跨文件**合并,把 continue 删掉它们照绿。
  ok(dup.options.dup_in_file && dup.options.dup_in_file.default === true,
     '同文件内重名也只取第一次(parseSconsOptions 的 continue 从此有人看守)',
     JSON.stringify(dup.options.dup_in_file))
  ok(dup.options.module_webp_enabled.default === false,
     '模块开关那一路也遵守先到先得:SConstruct 先声明的 False 不被 config.py 推出的 True 覆盖',
     JSON.stringify(dup.options.module_webp_enabled))

  // ---- 静态核对过的版本不占「已实测」的名额(Ruling #8) ----
  ok(P.TESTED_VERSIONS.join(',') === '4.7.2-stable',
     '已实测表只有真编过的 4.7.2-stable', P.TESTED_VERSIONS.join(','))
  ok(P.STATIC_CHECKED_VERSIONS.join(',') === '4.5-stable,4.3-stable',
     '只做过静态核对的两档另立一张表', P.STATIC_CHECKED_VERSIONS.join(','))
  // 4.3 那份树:只给 SConstruct + version.py,不给 modules/(顺带钉「缺 modules 不是失败」)
  const root43 = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-tplprobe-43-'))
  mkAt(root43)('SConstruct', SCORE + '\n' + C472)
  mkAt(root43)('version.py', VERSION_PY_43)
  const r43 = await P.probeSource(root43)
  ok(r43.ok === true && r43.sourceVersion === '4.3-stable',
     '真实 4.3 那份 version.py 走完 IO 后是 4.3-stable;缺 modules/ 目录也算探测成功',
     `${r43.ok} / ${r43.sourceVersion} / ${r43.error}`)
  ok(r43.tested === false, '4.3-stable 不在已实测表内 → tested 为 false(静态核对不背书)', String(r43.tested))

  // ---- IO 全走注入的 deps:一个真实文件都不碰也得出同一份结论 ----
  const SRC = 'fake-src-root'
  const seen = []
  const fakeTree = {
    'SConstruct': SCORE + '\n' + C472,
    'version.py': VERSION_PY,
    'modules': ['webp', 'mono'],
    'modules/webp/register_types.h': '', 'modules/webp/SCsub': '', 'modules/webp/config.py': 'def can_build(env, platform):\n    return True\n',
    'modules/mono/register_types.h': '', 'modules/mono/SCsub': '', 'modules/mono/config.py': MONO_CFG,
    // detect.py 这一行逐字取自 platform/windows/detect.py:229
    'platform/windows/detect.py': '        BoolVariable("use_static_cpp", "Link MinGW/MSVC C++ runtime libraries statically", True),'
  }
  const rel = (fp) => String(fp).replace(/\\/g, '/').replace(SRC + '/', '')
  const inj = {
    readFileSync: (fp) => { const k = rel(fp); seen.push(k); if (typeof fakeTree[k] !== 'string') throw new Error('ENOENT ' + k); return fakeTree[k] },
    existsSync: (fp) => typeof fakeTree[rel(fp)] === 'string',
    readdirSync: (fp) => { const v = fakeTree[rel(fp)]; if (!Array.isArray(v)) throw new Error('ENOTDIR ' + rel(fp)); return v }
  }
  const ri = await P.probeSource(SRC, inj)
  ok(ri.ok === true && ri.options.module_mono_enabled.default === false,
     '注入的 readdirSync + readFileSync 一路流到模块开关(磁盘上没有这棵树也能探测)',
     `${ri.ok} / ${JSON.stringify(ri.options.module_mono_enabled)} / ${ri.error}`)
  ok(ri.options.use_static_cpp && ri.options.use_static_cpp.default === true,
     '注入的 detect.py 内容进了结果 —— 能力表里 optStaticCpp 的 flag 就靠这一路',
     JSON.stringify(ri.options.use_static_cpp))
  ok(seen.includes('platform/windows/detect.py') && seen.includes('modules/mono/config.py'),
     '读过的确实是注入的那两份文件(若实现绕开 deps 去 require node:fs,这份表里不会有它们)', seen.join(','))

  // ---- 注入的 IO 抛异常时如实失败,不把异常抛给调用方(Windows 上源码树常被 git/杀软占用) ----
  let thrown = null
  let rLock = null
  try { rLock = await P.probeSource(root, { existsSync: () => { throw new Error('EPERM: operation not permitted') } }) }
  catch (e) { thrown = e }
  ok(thrown === null && !!rLock && rLock.ok === false && /SConstruct/.test(rLock.error || ''),
     'existsSync 抛异常 → ok:false 带原因,不抛出去', thrown ? String(thrown) : `${rLock && rLock.ok} / ${rLock && rLock.error}`)

  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(bad, { recursive: true, force: true })
  fs.rmSync(dupRoot, { recursive: true, force: true })
  fs.rmSync(root43, { recursive: true, force: true })
  report()
})().catch((e) => {
  // async 节里任何一处抛出(含未捕获的 rejection)都必须把整轮判红 ——
  // 否则断言没跑完也照样显示"全部通过"。
  ok(false, 'probeSource 测试节抛出异常,整节作废', e && e.stack)
  report()
})

// 汇总只能在 probeSource 那节(async)跑完之后打。简报原先把这三行留在文件末尾同步执行,
// 那是个真缺陷:async 断言一行都还没跑就已经打印了 PASS,而且那节里的 FAIL 再也触发不了
// process.exit(1) —— 整节挂掉也照样显示"全部通过"。改成函数声明(靠提升在 async 里调)。
function report() {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`PASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
}
