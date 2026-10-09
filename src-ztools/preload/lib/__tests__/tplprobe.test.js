// 探测层(tplprobe.js)的测试。全部用**逐字摘自真实源码**的片段当夹具,不自己编形态 ——
// 这层唯一的价值就是"和源码写得一样",夹具编错了实现就跟着错。
// 片段取自 godotengine/godot tag 4.7.2-stable 的 SConstruct(sha256 已核,见策划书附录 B)。
// 唯一的例外是下面标了「合成夹具」的那条单引号声明:4.7.2 全树没有这种形态,它只验正则的防御支。
// 用法: node src-ztools/preload/lib/__tests__/tplprobe.test.js
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

console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
