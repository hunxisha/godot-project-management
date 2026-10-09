// 探测层(tplprobe.js)的测试。全部用**逐字摘自真实源码**的片段当夹具,不自己编形态 ——
// 这层唯一的价值就是"和源码写得一样",夹具编错了实现就跟着错。
// 片段取自 godotengine/godot tag 4.7.2-stable 的 SConstruct(sha256 已核,见策划书附录 B)。
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
ok(!('env' in o), '不把 env["x"] 之类的引用当声明')
ok(P.parseSconsOptions('') !== null, '空文本返回对象而不是 null')
ok(Object.keys(P.parseSconsOptions('nothing here')).length === 0, '无声明文本 → 空结果')
// 单引号写法(4.x 早期与部分平台文件里见过)也要认
const SQ = "opts.Add(BoolVariable('winrt', 'Use WinRT API.', True))"
ok(P.parseSconsOptions(SQ).winrt && P.parseSconsOptions(SQ).winrt.default === true, '单引号声明同样解析')

// platform/windows/detect.py:224-235 —— 逐字摘自真实文件的一段 opts.Add 列表项。
// 同一函数要能直接吃平台文件:§5.1 里 `W:` 探针(use_static_cpp / windows_subsystem)靠的就是这个复用。
// 这段还顺带钉住两件事:元组形态的 ("msvc_version", …) 不算声明;help 文案里的裸撇号(MSVC's)不干扰引号配对。
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
ok(!('msvc_version' in w) && !('mssdk_version' in w), 'help 里带括号/元组形态的 opts.Add 项不被当成变量声明', Object.keys(w).join(','))
ok(w.use_static_cpp && w.use_static_cpp.default === true && w.windows_subsystem && w.windows_subsystem.default === 'gui',
   'detect.py 探针:use_static_cpp=True 且 windows_subsystem="gui"', JSON.stringify({ u: w.use_static_cpp, s: w.windows_subsystem }))

console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
