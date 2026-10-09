// 输出层(tplprofile.js):勾选 + 探测结果 → build_profile JSON + scons 命令行键。
// 规则只有一条(策划书 §5.3):用户选择 ≠ 探测到的源码默认值时才输出 —— **两个通道都适用**。
// 通道划分只认前缀(Ruling #38):`module_*` 写进 disabled_build_options,其余一切发进 commandExtras;
// 为什么不用"谁在 SConstruct:655 之后才被读"那张按行号的白名单,见实现文件头第 (1) 条。
// 生效时机:SConstruct:655-658 落 env、:1112-1113 消费模块开关、:440/:499 命令行落 env。
// 用法: node src-ztools/preload/lib/__tests__/tplprofile.test.js
// 本测试是**同步**的:被测实现是纯函数,不需要 async 断言节(汇总因此留在文件末尾)。
const fs = require('node:fs')
const path = require('node:path')
const F = require('../tplfeatures.js')
const P = require('../tplprobe.js')
const T = require('../tplprofile.js')

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 一份"像 4.7.2"的探测结果:默认值逐字照 SConstruct 行号
const OPTS = {
  disable_3d: { exists: true, default: false },
  disable_physics_3d: { exists: true, default: false },
  accesskit: { exists: true, default: true },
  d3d12: { exists: true, default: false },
  debug_symbols: { exists: true, default: false },
  deprecated: { exists: true, default: true },
  optimize: { exists: true, default: 'auto' },
  lto: { exists: true, default: 'none' },
  module_webp_enabled: { exists: true, default: true },
  module_mono_enabled: { exists: true, default: false }
}
// 简报夹具坑:简报那份实现里 PRESETS.full() 无参会走到 initialSelection(undefined) 然后在
// options[k] 上抛 TypeError。本实现把"整个 options 缺失"按"什么都没探到"处理(见入参契约那节),
// 但测试仍一律带实参 —— 少传一个真实选项表在生产路径上是 bug,不该由夹具替它背书。
const sel = (on) => Object.assign(T.PRESETS.full(OPTS), on)
const dboOf = (r) => r.json.disabled_build_options
// 通道读取器:profile 看键,命令行看 token 的 flag 部分(键名里不含 `=`,所以取第一个 `=` 之前)。
const cmdFlagOf = (token) => token.slice(0, token.indexOf('='))
const cmdOf = (r) => r.commandExtras.map(cmdFlagOf)
const inCommand = (r, flag) => cmdOf(r).includes(flag)
const tokenOf = (r, flag) => r.commandExtras.find((t) => cmdFlagOf(t) === flag)
const hasIn = (r, flag) => flag in dboOf(r) || inCommand(r, flag)
const tokenValueOf = (r, flag) => { const t = tokenOf(r, flag); return t === undefined ? undefined : t.slice(flag.length + 1) }
// #38 的前缀判据(与实现同一条规则的另一种写法:守卫要独立于实现的正则,否则"实现把前缀判据写错"
// 与"守卫用同一个正则"会一起错 —— 所以这里用 ruling 的字面口径 startsWith('module_')）。
const isModulePrefix = (k) => k.startsWith('module_')
// 两个通道的产物登记表:每节造出一份产物就登记,文件末尾的「Ruling #38 通道守卫」对它做遍历性断言。
const PROD = []
const reg = (label, r) => { PROD.push([label, r]); return r }

section('与默认相同 → 不输出')
let r = reg('全默认勾选(default-on)', T.buildProfile(T.PRESETS.full(OPTS), OPTS))
ok(Object.keys(dboOf(r)).length === 0, '全默认勾选 → disabled_build_options 为空对象', JSON.stringify(r.json))
ok(eqJson(r.commandExtras, []), '全默认勾选 → 命令行也不发任何 token(两个通道同时受"与默认相同就不输出"约束)', JSON.stringify(r.commandExtras))

section('取消一项 → 只出这一项')
r = reg('取消 3D 伞项', T.buildProfile(sel({ sys3d: false }), OPTS))
ok(eqJson(r.commandExtras, ['disable_3d=yes']), '取消 3D → 命令行 token "disable_3d=yes"(#38:disable_* 不是 module_*,不进 profile)', JSON.stringify(r.commandExtras))
ok(!('disable_3d' in dboOf(r)), 'disable_3d 不再出现在 profile 里:它的读取点在 SConstruct:1076,但命令行在 :440/:499 就落 env,走命令行永远正确', JSON.stringify(dboOf(r)))
ok(!hasIn(r, 'accesskit'), '未动的 accesskit 在两个通道里都不出现')

section('勾选语义与源码默认方向相反的那几项(§5.3 的由来)')
r = reg('勾上调试符号', T.buildProfile(sel({ optDebugSymbols: true }), OPTS))
ok(eqJson(r.commandExtras, ['debug_symbols=yes']), '勾上"调试符号"(默认 False)→ 命令行发 debug_symbols=yes', JSON.stringify(r.commandExtras))
ok(!('debug_symbols' in dboOf(r)), '同一个键不重复出现在 profile 里(两通道互斥)', JSON.stringify(dboOf(r)))
r = reg('全默认勾选(再算一次)', T.buildProfile(T.PRESETS.full(OPTS), OPTS))
ok(!('debug_symbols' in dboOf(r)), '全默认态不输出 debug_symbols —— 否则"全量"预设会编出带符号的模板')
r = reg('取消 d3d12(空操作)', T.buildProfile(sel({ d3d12: false }), OPTS))
ok(!hasIn(r, 'd3d12'), '取消 d3d12(默认已 False)→ 两个通道都不出(现状那句 d3d12=no 是空操作)')

section('探测判 absent 的项 → 不写,且报出来')
const absentR = reg('disable_3d 未探到', T.buildProfile(sel({ sys3d: false }), Object.assign({}, OPTS, { disable_3d: undefined })))
ok(!('disable_3d' in dboOf(absentR)), '不存在的键绝不写进 profile(静默失效风险)')
ok(!inCommand(absentR, 'disable_3d'), '不存在的键也绝不发进命令行(#38 之后命令行同样是通道,一样不许猜)', JSON.stringify(absentR.commandExtras))
ok(absentR.skipped.some((s) => s.flag === 'disable_3d' && /不存在|未探到/.test(s.why)), '跳过的项带原因', JSON.stringify(absentR.skipped))

section('一个面板项映射多个 flag 时全部处理')
const rasterR = reg('关 TGA/BMP/HDR 三个模块', T.buildProfile(sel({ fmtRaster: false }), Object.assign({}, OPTS, {
  module_tga_enabled: { exists: true, default: true }, module_bmp_enabled: { exists: true, default: true }, module_hdr_enabled: { exists: true, default: true }
})))
ok(['module_tga_enabled', 'module_bmp_enabled', 'module_hdr_enabled'].every((k) => dboOf(rasterR)[k] === false), '三项一起关(模块开关正是留在 profile 的那一类)', JSON.stringify(dboOf(rasterR)))
ok(eqJson(rasterR.commandExtras, []), '这三项一个都不发到命令行(#38 的反向半边)', JSON.stringify(rasterR.commandExtras))
// 反向的一半:一项多 flag 时,**默认值不一致**就不能打勾(打勾等于替用户猜另外那个 flag 也开着)。
// 夹具:vorbis 探到且默认 True、ogg 未探到(真实 4.7.2 里 ogg 模块确实存在,这条只钉"every 不是 some")。
const mixed = Object.assign({}, OPTS, { module_vorbis_enabled: { exists: true, default: true } })
ok(T.initialSelection(mixed).audOgg === false, '一项多 flag 且默认混合(True + 未探到)→ 不打勾(every 写成 some 就红)',
   JSON.stringify(T.initialSelection(mixed).audOgg))
// 与"面板没给勾选态"不同:这里选择是**明确给了** false 的,所以按"用户取消了这项"处理 ——
// 探到的那个 flag 写 false,没探到的那个只进 skipped。
const mixedR = reg('明确未勾选的混合项', T.buildProfile(T.initialSelection(mixed), mixed))
ok(dboOf(mixedR).module_vorbis_enabled === false, '明确未勾选项里"探到的"flag 照选择写 false(把明确 false 当"不处理"就红)', JSON.stringify(dboOf(mixedR)))
ok(!hasIn(mixedR, 'module_ogg_enabled') && mixedR.skipped.some((s) => s.flag === 'module_ogg_enabled'),
   '同一项里"没探到"的那个仍只报 skipped,不写(与上条分得开)', JSON.stringify(mixedR.skipped.filter((s) => /ogg/.test(s.flag))))

section('稳定序列化(给 parity 逐字节比)')
// #38 之后 profile 只剩模块键,所以这一节夹具换成**两个模块开关**:
// 表里 fmtWebp 排在 fmtJpg 之前(module_webp_enabled 先插入),字典序却是 jpg 在前 —— 不 sortKeys 就红。
const WEBP_JPG = Object.assign({}, OPTS, { module_jpg_enabled: { exists: true, default: true } })
const a = T.profileText(T.buildProfile(sel({ fmtWebp: false, fmtJpg: false }), WEBP_JPG).json)
const b = T.buildProfile(sel({ fmtJpg: false, fmtWebp: false }), WEBP_JPG).json
const bText = T.profileText(b)
ok(a === bText, '勾选顺序不同 → 文本相同', `${a}\n---\n${bText}`)
ok(a.indexOf('"module_jpg_enabled"') < a.indexOf('"module_webp_enabled"'), '键按字典序输出(表插入序是 webp 在前)', a)
ok(eqJson(Object.keys(T.buildProfile(sel({ fmtWebp: false, fmtJpg: false }), WEBP_JPG).json.disabled_build_options),
         ['module_jpg_enabled', 'module_webp_enabled']),
   'disabled_build_options 的键数组本身就是字典序(Rust 侧按下标比也要对得上)')
// written 的键名与顺序:written 现在记**两个通道**的全部产出,夹具用表序与字典序相反的那一对
// (表里 sys3d 的 disable_3d 排在编译选项组的 debug_symbols 之前)。
const rPair = reg('取消 3D + 勾调试符号', T.buildProfile(sel({ sys3d: false, optDebugSymbols: true }), OPTS))
ok(eqJson(rPair.written, ['debug_symbols', 'disable_3d']),
   'written 的顺序承诺:与勾选/表插入序无关,固定字典序(删掉 written.sort() 当场红)', JSON.stringify(rPair.written))
ok(eqJson(rPair.written, Object.keys(dboOf(rPair)).concat(cmdOf(rPair)).sort()),
   'written = 两个通道实际产出的并集(键名对不上、或漏记某个通道就红)',
   `${JSON.stringify(rPair.written)} vs ${JSON.stringify(Object.keys(dboOf(rPair)).concat(cmdOf(rPair)).sort())}`)
// 命令行通道的稳定排序:#38 之后它是主要出口,parity 同样逐字节比它。
// 夹具的表插入序是 disable_3d(引擎子系统)在前、debug_symbols(编译选项)在后,字典序相反 ——
// 删掉 Object.keys(cmd).sort() 就得到 ["disable_3d=yes","debug_symbols=yes"],当场红。
ok(eqJson(rPair.commandExtras, ['debug_symbols=yes', 'disable_3d=yes']),
   'commandExtras 固定字典序(删掉它的排序当场红)', JSON.stringify(rPair.commandExtras))
ok(eqJson(T.buildProfile(sel({ optDebugSymbols: true, sys3d: false }), OPTS).commandExtras, rPair.commandExtras),
   'commandExtras 与勾选顺序无关(它是 T7 拼进行尾的数组,parity 要逐字节比)')
ok(eqJson(T.buildProfile(sel({ accesskit: false, sys3d: false }), OPTS, { mode: 'default-off' }).commandExtras,
         T.buildProfile(sel({ sys3d: false, accesskit: false }), OPTS, { mode: 'default-off' }).commandExtras),
   '反向模式下 commandExtras 也与勾选顺序无关', '')
ok(rPair.skipped.every((s) => rPair.written.indexOf(s.flag) === -1), 'skipped 与 written 无交集')
// 钉住 profileText 的形态本身:Rust 双端比的是字节,缩进或结构一变就对不上。
ok(a.split('\n')[1] === '  "disabled_build_options": {', '顶层只有 disabled_build_options + 缩进固定 2 空格', JSON.stringify(a.split('\n').slice(0, 3)))
ok(JSON.stringify(JSON.parse(T.profileText(b))) === JSON.stringify(b), 'profileText 可原样解析回同一对象')
// 值域不变量(两个通道都要跑):scons 那侧 `env[c] = dbo[c]` 之后要么当布尔用要么按枚举串比,
// 出现 null / undefined / 数字就是本层算错了。undefined 更阴 —— JSON.stringify 直接把键丢掉,
// 文本里连 null 都看不见,所以必须比 written 的条数,不能只扫文本。
const invariantR = reg('值域夹具(模块 + 核心 + 枚举混在一起)', T.buildProfile(sel({ fmtRaster: false, optPrecision: true, sys3d: false, accesskit: false }), Object.assign({}, OPTS, { precision: { exists: true, default: 'single' } })))
ok(Object.values(dboOf(invariantR)).every((v) => typeof v === 'boolean' || typeof v === 'string'),
   'profile 里写出去的值只会是布尔或枚举字符串(没有 null / 数字 / undefined 通道)', JSON.stringify(dboOf(invariantR)))
const enumTokenValues = new Set(Object.values(T.ENUM_VALUES).flatMap((t) => [t.on, t.off]))
ok(invariantR.commandExtras.every((t) => {
  const v = t.slice(t.indexOf('=') + 1)
  return t.indexOf('=') > 0 && !/=.*=/.test(t) && v !== '' && (v === 'yes' || v === 'no' || enumTokenValues.has(v))
}), 'commandExtras 的每条 token 都是 key=value 且值 ∈ {yes,no} ∪ ENUM_VALUES 取值域', JSON.stringify(invariantR.commandExtras))
ok(Object.keys(dboOf(invariantR)).length + invariantR.commandExtras.length === invariantR.written.length,
   'written 条数 = profile 键数 + 命令行 token 数(值算成 undefined 时键会静默消失,这条拦住)',
   `${invariantR.written.length} vs ${Object.keys(dboOf(invariantR)).length}+${invariantR.commandExtras.length}`)
ok(!/:\s*(null|undefined)\b/.test(T.profileText(invariantR.json)), 'profile 文本里没有 null/undefined 字面量', T.profileText(invariantR.json))
ok(!invariantR.commandExtras.some((t) => /=(true|false|undefined|)$/.test(t)), '命令行 token 里没有 true/false/undefined/空值(scons 只认 yes/no 与枚举串)', JSON.stringify(invariantR.commandExtras))

section('最小可跑预设:官方 9 条在新规则下的落点(Ruling #33/#36/#38)')
// 官方 9 条 linux_builds.yml:108-116 的处置(#38 之后):
//   :108 modules_enabled_by_default=no    → 命令行(它不是 module_*,且 :476 早于 profile 落 env)
//   :109 module_text_server_fb_enabled=no → **不发**(它自己 is_enabled() 就是 False,反向白名单下更被
//        整体关掉,发它违反"与默认相同就不输出";官方那行属冗余防御)
//   :110-116 那 7 条(4 条 disable_* + deprecated/minizip/brotli)→ **全部命令行**(都不是 module_*)
//   → 于是 minimal 的 profile 里只剩"保留的模块显式点名 true"这一类键
// 渲染与输入驱动(vulkan/opengl3/angle/sdl/accesskit)与表外模块**一概不碰** —— 官方那 9 条里没有它们。
const OFFICIAL_MIN_7 = ['disable_3d', 'disable_advanced_gui', 'disable_physics_2d', 'disable_physics_3d', 'deprecated', 'minizip', 'brotli']
const MIN_EXPECT_CMD = ['brotli=no', 'deprecated=no', 'disable_3d=yes', 'disable_advanced_gui=yes', 'disable_physics_2d=yes', 'disable_physics_3d=yes', 'minizip=no', 'modules_enabled_by_default=no']
const MIN_OPTS = {
  disable_3d: { exists: true, default: false }, // 以下 7 条逐字照 SConstruct 的默认值
  disable_advanced_gui: { exists: true, default: false }, // :265
  disable_physics_2d: { exists: true, default: false }, // :266
  disable_physics_3d: { exists: true, default: false }, // :267
  deprecated: { exists: true, default: true }, // :190
  minizip: { exists: true, default: true }, // :194
  brotli: { exists: true, default: true }, // :195
  module_webp_enabled: { exists: true, default: true }, // 唯一"保留的模块",必须显式点名 true
  // 官方一条都不碰的渲染/输入驱动 + 官方第 2 条那个默认 False 的模块,全部探到:
  // 它们**只许出现在 skipped 或不出现**,两个通道都不许进。
  vulkan: { exists: true, default: true },
  opengl3: { exists: true, default: true },
  angle: { exists: true, default: true },
  sdl: { exists: true, default: true },
  accesskit: { exists: true, default: true },
  module_text_server_fb_enabled: { exists: true, default: false }
}
const minProd = reg('minimal(MIN_OPTS 夹具, default-off)', T.buildProfile(T.PRESETS.minimalSelection(MIN_OPTS), MIN_OPTS, { mode: 'default-off' }))
ok(eqJson(Object.keys(dboOf(minProd)), ['module_webp_enabled']),
   'minimal 的 profile 键集合逐字 = 只剩保留模块的显式点名(#38:官方那 7 条全挪去命令行)', JSON.stringify(Object.keys(dboOf(minProd))))
ok(eqJson(minProd.commandExtras, MIN_EXPECT_CMD),
   'minimal 的 commandExtras 逐字 = 官方 :108 + :110-116 共 8 条 token(字典序),多一条少一条都红', JSON.stringify(minProd.commandExtras))
ok(eqJson(minProd.written, ['brotli', 'deprecated', 'disable_3d', 'disable_advanced_gui', 'disable_physics_2d', 'disable_physics_3d', 'minizip', 'module_webp_enabled', 'modules_enabled_by_default']),
   'minimal 的 written 逐字 = 两通道全部 9 个键名(命令行 8 + profile 1)', JSON.stringify(minProd.written))
ok(!('modules_enabled_by_default' in dboOf(minProd)),
   '该键不写进 profile:留一个不生效的键在归档 profile 里会误导后来人(Ruling #35,与 #38 同向)', JSON.stringify(dboOf(minProd)))
// 官方 9 条逐条对号入座 —— 这张表就是报告里那张对照表的代码形态。
const OFFICIAL_9 = [
  { flag: 'modules_enabled_by_default', token: 'modules_enabled_by_default=no', ci: 'linux_builds.yml:108' },
  { flag: 'module_text_server_fb_enabled', token: null, ci: 'linux_builds.yml:109' },
  { flag: 'disable_3d', token: 'disable_3d=yes', ci: 'linux_builds.yml:110' },
  { flag: 'disable_advanced_gui', token: 'disable_advanced_gui=yes', ci: 'linux_builds.yml:111' },
  { flag: 'disable_physics_2d', token: 'disable_physics_2d=yes', ci: 'linux_builds.yml:112' },
  { flag: 'disable_physics_3d', token: 'disable_physics_3d=yes', ci: 'linux_builds.yml:113' },
  { flag: 'deprecated', token: 'deprecated=no', ci: 'linux_builds.yml:114' },
  { flag: 'minizip', token: 'minizip=no', ci: 'linux_builds.yml:115' },
  { flag: 'brotli', token: 'brotli=no', ci: 'linux_builds.yml:116' }
]
for (const o of OFFICIAL_9) {
  if (o.token === null) {
    ok(!hasIn(minProd, o.flag), `官方 ${o.ci} 的 ${o.flag}=no 不发:它默认就是 False(config.py:9-11),发它违反差值规则(Ruling #36)`, JSON.stringify([dboOf(minProd), minProd.commandExtras]))
    continue
  }
  ok(tokenOf(minProd, o.flag) === o.token && !(o.flag in dboOf(minProd)),
     `官方 ${o.ci} 的 ${o.flag} → 命令行 token "${o.token}"(不在 profile 里)`,
     JSON.stringify([tokenOf(minProd, o.flag), Object.keys(dboOf(minProd))]))
}
ok(eqJson(minProd.commandExtras.slice().sort(), MIN_EXPECT_CMD), 'commandExtras 已是字典序(与官方那行的 token 顺序无关,parity 只比这一份)', JSON.stringify(minProd.commandExtras))
for (const k of ['disable_3d', 'disable_advanced_gui', 'disable_physics_2d', 'disable_physics_3d']) {
  ok(tokenOf(minProd, k) === `${k}=yes`, `minimal 发 ${k}=yes(官方 :110-113 四条 disable_*,新通道)`, JSON.stringify(minProd.commandExtras))
}
for (const k of ['deprecated', 'minizip', 'brotli']) {
  ok(tokenOf(minProd, k) === `${k}=no`, `minimal 发 ${k}=no(官方 :114-116 三条,新通道)`, JSON.stringify(minProd.commandExtras))
}
ok(dboOf(minProd).module_webp_enabled === true, '反向白名单下保留的模块在 profile 里显式写 true(不点名的会被整体关掉)', JSON.stringify(dboOf(minProd)))
for (const k of ['vulkan', 'opengl3', 'angle', 'sdl', 'accesskit']) {
  ok(!hasIn(minProd, k), `minimal 不碰渲染与输入驱动:${k} 两个通道都不进(官方 Minimal template 没有这一条)`, JSON.stringify([Object.keys(dboOf(minProd)), minProd.commandExtras]))
}
ok(Object.keys(dboOf(minProd)).every(isModulePrefix),
   'minimal 的 profile 键全部带 module_ 前缀(#38 主守卫在 minimal 上成立)', JSON.stringify(Object.keys(dboOf(minProd))))
ok(minProd.commandExtras.every((t) => !isModulePrefix(cmdFlagOf(t))),
   'minimal 的命令行 token 里没有 module_*(#38 反向守卫在 minimal 上成立)', JSON.stringify(minProd.commandExtras))
// 反向模式不改变核心 disable_* 的差值语义(表内没探到的伞项只进 skipped)。
const minimal = reg('minimal(OPTS 夹具, default-off)', T.buildProfile(T.PRESETS.minimalSelection(OPTS), OPTS, { mode: 'default-off' }))
ok(tokenOf(minimal, 'disable_3d') === 'disable_3d=yes', '反向模式不改变核心 disable_* 的差值语义:未勾选的 disable_3d 仍发 yes', JSON.stringify(minimal.commandExtras))
ok(tokenOf(minimal, 'disable_physics_3d') === 'disable_physics_3d=yes', 'minimal 里 3D 物理同样被显式关掉(官方 :113 那一条)', JSON.stringify(minimal.commandExtras))
// OPTS 夹具没探到 minizip/brotli/advGui/phys2d(它们进 skipped),所以这里只有 4 条 token:
// deprecated(OPTS 探到 True)+ 两条 disable_* + 模式级 modules_enabled_by_default。
ok(eqJson(minimal.commandExtras, ['deprecated=no', 'disable_3d=yes', 'disable_physics_3d=yes', 'modules_enabled_by_default=no']),
   '命令行键的集合与顺序由 #38 + 字典序决定,不随勾选变化(未探到的官方条目自动缺席)', JSON.stringify(minimal.commandExtras))
ok(eqJson(minimal.written, ['deprecated', 'disable_3d', 'disable_physics_3d', 'module_webp_enabled', 'modules_enabled_by_default']),
   'OPTS 夹具下 minimal 的产出并集:一个模块键 + 两条 disable_* + deprecated + 模式级键', JSON.stringify(minimal.written))
// 反向白名单下"没保留的模块"与有效默认(关)相同 → 不写冗余的 no(与 #36 对 text_server_fb 的判据同一条)。
// 夹具是**合成形态**:4.7.2 表内模块默认全 True(只有 mono / text_server_fb 定义 is_enabled()→False,
// 而两者都不在面板表里),这里造一个"探到默认 False 的表内模块"只为钉住两种默认都不写冗余 no。
const optsJpg = Object.assign({}, OPTS, { module_jpg_enabled: { exists: true, default: false } })
const minJpg = reg('minimal(默认已 False 的模块)', T.buildProfile(T.PRESETS.minimalSelection(optsJpg), optsJpg, { mode: 'default-off' }))
ok(!hasIn(minJpg, 'module_jpg_enabled'), '反向模式下"默认已 False 且没保留"的模块不写 no(差值规则,不是漏写)', JSON.stringify([Object.keys(dboOf(minJpg)), minJpg.commandExtras]))
const minOffWebp = reg('minimal(webp 也不保留)', T.buildProfile(Object.assign(T.PRESETS.minimalSelection(OPTS), { fmtWebp: false }), OPTS, { mode: 'default-off' }))
ok(!hasIn(minOffWebp, 'module_webp_enabled'),
   '反向模式下"源码默认 True 但用户没保留"的模块同样不写 no:它已被 modules_enabled_by_default 关掉(写一遍冗余 no 才是违反 §5.3)',
   JSON.stringify([Object.keys(dboOf(minOffWebp)), minOffWebp.commandExtras]))
// 表外开关(4.7.2 里真实存在,但按策划书 §3 负范围不进面板)一个都不许写:
// 写出去就等于把 freetype/gdscript 这类"关掉即废模板"的项替用户关了。
const OFF_TABLE = {
  module_gdscript_enabled: { exists: true, default: true },
  module_freetype_enabled: { exists: true, default: true },
  module_text_server_adv_enabled: { exists: true, default: true },
  threads: { exists: true, default: true },
  xaudio2: { exists: true, default: false },
  disable_exceptions: { exists: true, default: true }
}
const minimalFull = reg('minimal(带表外开关, default-off)', T.buildProfile(T.PRESETS.minimalSelection(Object.assign({}, OPTS, OFF_TABLE)), Object.assign({}, OPTS, OFF_TABLE), { mode: 'default-off' }))
const TABLE_FLAGS = F.TPL_FEATURES.flatMap((f) => F.flagsOf(f))
ok(Object.keys(dboOf(minimalFull)).every((k) => TABLE_FLAGS.includes(k)),
   '反向模式的 profile 只写功能表里的 flag,表外开关(gdscript/freetype/threads…)一个都不写',
   JSON.stringify(Object.keys(dboOf(minimalFull))))
ok(cmdOf(minimalFull).every((k) => TABLE_FLAGS.includes(k) || k === 'modules_enabled_by_default'),
   '命令行通道只写功能表里的 flag,外加模式级那一条 modules_enabled_by_default(#38 之后这条才真正有覆盖面)', JSON.stringify(minimalFull.commandExtras))
for (const k of Object.keys(OFF_TABLE)) {
  ok(!hasIn(minimalFull, k), `表外开关 ${k} 不因"面板没这一项"被写出去(两个通道都不许)`, JSON.stringify([Object.keys(dboOf(minimalFull)), minimalFull.commandExtras]))
}

section('default-off 的值域:枚举型照样走 ENUM_VALUES,不许退化成布尔(E5)')
// 上一轮把 `if (mode === 'default-off') return keep` 从"只对模块"扩到"对所有 flag",73 条全绿,
// 真实后果是给 lto / optimize / precision 三个 **EnumVariable 写成布尔** —— scons 直接拒。
// #38 之后这三个枚举落在命令行通道,值域检查因此要跟着换边(布尔会被 scons 直接拒)。
const ENUM_OPTS = Object.assign({}, MIN_OPTS, {
  lto: { exists: true, default: 'none' }, // SConstruct:183
  optimize: { exists: true, default: 'auto' }, // :171-174
  precision: { exists: true, default: 'single' } // :192
})
const minEnum = reg('minimal + 三个枚举勾上(default-off)', T.buildProfile(Object.assign(T.PRESETS.minimalSelection(ENUM_OPTS), { optLto: true, optSize: true, optPrecision: true }), ENUM_OPTS, { mode: 'default-off' }))
ok(eqJson(minEnum.commandExtras, ['brotli=no', 'deprecated=no', 'disable_3d=yes', 'disable_advanced_gui=yes', 'disable_physics_2d=yes', 'disable_physics_3d=yes', 'lto=auto', 'minizip=no', 'modules_enabled_by_default=no', 'optimize=size', 'precision=double']),
   '反向模式下三个枚举照样发字符串 token(写成布尔 → scons 拒收,那条变异当场红)', JSON.stringify(minEnum.commandExtras))
ok(['lto', 'optimize', 'precision'].every((k) => !hasIn(minEnum, k) || [T.ENUM_VALUES[k].on, T.ENUM_VALUES[k].off].includes(tokenValueOf(minEnum, k))),
   '枚举型 flag 发出去的值 ∈ ENUM_VALUES 的取值域(两种模式都跑这一条)', JSON.stringify(minEnum.commandExtras))
ok(Object.values(dboOf(minEnum)).every((v) => typeof v === 'boolean' || typeof v === 'string'),
   '反向模式下的值域不变量:profile 里只会是布尔或枚举字符串', JSON.stringify(dboOf(minEnum)))
ok(eqJson(Object.keys(dboOf(minEnum)), ['module_webp_enabled']),
   '枚举改成命令行后,反向模式的 profile 只剩模块键(#38 的 minimal 形态)', JSON.stringify(Object.keys(dboOf(minEnum))))
// 合成形态:把 precision 的源码默认改成"已开双精度",反向模式下取消它应写回 off 值而不是 false。
const minEnumOff = reg('minimal + precision 默认已开双精度', T.buildProfile(Object.assign(T.PRESETS.minimalSelection(ENUM_OPTS), { optPrecision: false }),
  Object.assign({}, ENUM_OPTS, { precision: { exists: true, default: 'double' } }), { mode: 'default-off' }))
ok(tokenOf(minEnumOff, 'precision') === 'precision=single', '反向模式取消一个"默认已开"的枚举 → 发 off 值 "single",不是 false', JSON.stringify(minEnumOff.commandExtras))

section('8 个 disable_* 伞项的方向:逐一钉初始勾选态 + 勾上不得写成 true(E3)')
// 表内 disable_* 共 8 项,上一轮只钉了 sys3d / phys3d 两个。把 isNegatedFlag 从 /^disable_/ 收窄成
// 只认这三个,73 条全绿 —— 而真实后果:面板把「3D 导航 / 2D 导航 / XR / 高级 GUI / override.cfg」
// 显示成未勾选(它们源码默认全是 False = 功能开着),用户把「3D 导航」勾回去 → profile 写出
// disable_navigation_3d: true —— **勾上 = 关掉**。下面把 8 项全钉上,并加方向不变量。
// #38 之后这 8 条的产物在命令行通道,所以"检查对象"从 disabled_build_options 换成 commandExtras。
const negItems = F.TPL_FEATURES.filter((f) => f.flags.length === 1 && /^disable_/.test(f.flags[0]))
ok(negItems.length === 8, '功能表里恰好 8 个单 flag 的 disable_* 伞项(第 9 个出现时这节要跟着长)', negItems.map((f) => f.id).join(','))
// 4.7.2 真实形态:这 8 条默认全是 False(SConstruct:264-271)
const NEG_OPTS = {}
for (const f of negItems) NEG_OPTS[f.flags[0]] = { exists: true, default: false }
const negInit = T.initialSelection(NEG_OPTS)
for (const f of negItems) {
  ok(negInit[f.id] === true, `${f.id}:${f.flags[0]} 默认 False = 功能开着 → 初始必须勾着(判据只认部分前缀就红)`, JSON.stringify(negInit[f.id]))
}
const negAllOn = reg('8 个 disable_* 全勾', T.buildProfile(negInit, NEG_OPTS))
for (const f of negItems) {
  ok(!(f.flags[0] in dboOf(negAllOn)) && !inCommand(negAllOn, f.flags[0]),
     `8 项全勾时两个通道里都没有 ${f.flags[0]}(方向不变量:勾上 ≠ 关掉)`, JSON.stringify([dboOf(negAllOn), negAllOn.commandExtras]))
}
for (const f of negItems) {
  const one = reg(`只取消 ${f.id}`, T.buildProfile(Object.assign({}, negInit, { [f.id]: false }), NEG_OPTS))
  ok(eqJson(one.commandExtras, [`${f.flags[0]}=yes`]) && Object.keys(dboOf(one)).length === 0,
     `只取消 ${f.id} → 恰好发 ${f.flags[0]}=yes 一条 token 且 profile 为空,其余 7 条不受牵连`, JSON.stringify([one.commandExtras, dboOf(one)]))
}
ok(negItems.every((f) => ['sys3d', 'phys3d', 'phys2d', 'nav3d', 'nav2d', 'xr', 'advGui', 'overrideCfg'].includes(f.id)),
   '这 8 项的 id 名单与上一轮登记的一致(改名或增删项时先在这里留痕)', negItems.map((f) => f.id).join(','))

section('初始勾选态 = 探测到的源码默认值(简报的通用启发式在 precision 上判错)')
// 简报原式 `default !== 'none' && default !== 'auto'` 对 precision(真实默认 "single",
// SConstruct:192)返回 true → 面板把"双精度浮点"显示成已勾选,而源码默认根本没开双精度。
// 方向是**多勾**:用户不动它就给产物加了双精度。下面这几条就是为了让那条启发式必红。
const withPrec = Object.assign({}, OPTS, { precision: { exists: true, default: 'single' } })
ok(T.initialSelection(withPrec).optPrecision === false, 'precision 默认 "single" → 双精度浮点初始不勾(核心修复断言)',
   JSON.stringify(T.initialSelection(withPrec).optPrecision))
ok(T.initialSelection(Object.assign({}, OPTS, { precision: { exists: true, default: 'double' } })).optPrecision === true,
   'precision 默认 "double"(真改了默认)→ 才打勾', '把 ENUM_VALUES.precision.off 写错或删掉就红')
ok(T.initialSelection(withPrec).optLto === false, 'lto 默认 "none" → LTO 初始不勾')
ok(T.initialSelection(withPrec).optSize === false, 'optimize 默认 "auto" → 体积优先初始不勾')
ok(T.ENUM_VALUES.lto.off === OPTS.lto.default && T.ENUM_VALUES.optimize.off === OPTS.optimize.default &&
   T.ENUM_VALUES.precision.off === 'single',
   'ENUM_VALUES 三条 off 与真实源码默认值一致(none/auto/single)', JSON.stringify(T.ENUM_VALUES))
// 勾上枚举项 → 发"开"的那个取值;取消 → 与默认相同不写
r = reg('勾上双精度', T.buildProfile(sel({ optPrecision: true }), withPrec))
ok(tokenOf(r, 'precision') === 'precision=double', '勾上双精度 → 命令行发 "precision=double" 而不是 true(#38 之后它在命令行)', JSON.stringify(r.commandExtras))
ok(!('precision' in dboOf(r)), '枚举型 flag 不留在 profile 里:SConstruct:596 的宏读点在 profile 落 env 之前,留着一个改不动产物的键才是真坑', JSON.stringify(dboOf(r)))
r = reg('勾上体积优先', T.buildProfile(sel({ optSize: true }), OPTS))
ok(tokenOf(r, 'optimize') === 'optimize=size', '勾上体积优先 → 命令行发 optimize=size', JSON.stringify(r.commandExtras))
ok(!hasIn(T.buildProfile(sel({ optSize: false }), OPTS), 'optimize'), '取消体积优先(默认就是 auto)→ 两个通道都不发 optimize')

section('认不出的枚举默认 → 两个方向都不猜(宁缺勿错)')
// 合成形态:4.7.2 功能表里的三个枚举(lto/optimize/precision)都在 ENUM_VALUES 里,
// 这条造一个"字符串默认但表里没条目"的开关,只为钉住"宁缺勿错"那一支。
const unknownEnum = Object.assign({}, OPTS, { deprecated: { exists: true, default: 'yes' } })
ok(T.initialSelection(unknownEnum).optDeprecated === false, '表里没有条目的字符串默认 → 不打勾(启发式会打勾 → 红)')
const unknownR = reg('未知枚举 + 取消 deprecated', T.buildProfile(sel({ optDeprecated: false }), unknownEnum))
ok(!hasIn(unknownR, 'deprecated'), '同一个未知枚举即使被取消也不写(写 true/false 是类型错误,写猜的字符串是编造)', JSON.stringify([dboOf(unknownR), unknownR.commandExtras]))

section('disable_* 的方向:同一份默认值 False 在两类 flag 上含义相反')
const init = T.initialSelection(withPrec)
ok(init.sys3d === true, 'disable_3d 默认 False = 3D 功能开着 → 伞项初始打勾(不取反就红)', JSON.stringify(init.sys3d))
ok(init.phys3d === true, 'disable_physics_3d 同形 → 3D 物理初始打勾')
ok(init.d3d12 === false, '裸名 d3d12 默认 False = 驱动关着 → 初始不打勾(被取反误伤就红)', JSON.stringify(init.d3d12))
ok(init.accesskit === true && init.optDeprecated === true, '裸名默认 True 的两项(accesskit/deprecated)初始打勾')
ok(init.vulkan === false && init.fmtJpg === false, '探测里没有的 flag 不打勾(不猜)', JSON.stringify([init.vulkan, init.fmtJpg]))
// 未探到 ≠ "默认 False":对 disable_* 反着猜会把伞项全打上勾(方向是多勾)。
ok(T.initialSelection({}).sys3d === false && T.initialSelection({}).accesskit === false,
   '什么都没探到时全部不打勾(未探到对 disable_* 也不能反着猜)',
   JSON.stringify({ s: T.initialSelection({}).sys3d, a: T.initialSelection({}).accesskit }))
ok(init.fmtWebp === true, 'module_webp_enabled 默认 True → 初始打勾')
ok(init.optDebugSymbols === false, 'debug_symbols 默认 False → 初始不打勾')

section('面板没给勾选态 → 什么都不写(不是"当成用户取消了")')
r = reg('selection 为空对象', T.buildProfile({}, OPTS))
ok(Object.keys(dboOf(r)).length === 0, 'selection 为空 → profile 为空对象(拼错 id 不会写出 disable_3d=yes)', JSON.stringify(r.json))
ok(eqJson(r.commandExtras, []), 'selection 为空 → 命令行也不发任何 token(同一兜底覆盖两个通道)', JSON.stringify(r.commandExtras))
ok(r.skipped.length === F.TPL_FEATURES.reduce((n, f) => n + F.flagsOf(f).length, 0),
   '缺勾选态的 flag 全部如实报在 skipped 里(带原因)', r.skipped.length)
ok(r.skipped.every((s) => /未提供|勾选态/.test(s.why)), 'skipped 的原因文案区分"未勾选"与"未探到"', JSON.stringify(r.skipped[0]))

section('入参整体缺失的契约(上一轮两个兜底从未被执行 → 现在钉住,E7)')
const noneR = reg('selection/options 全 undefined', T.buildProfile(undefined, undefined))
ok(Object.keys(dboOf(noneR)).length === 0 && noneR.written.length === 0,
   'selection/options 传 undefined → 空 profile(不猜、不抛)', JSON.stringify(noneR.json))
ok(noneR.skipped.length === F.TPL_FEATURES.reduce((n, f) => n + F.flagsOf(f).length, 0),
   'undefined 入参时全部 flag 如实报在 skipped 里', noneR.skipped.length)
ok(eqJson(noneR.commandExtras, []), 'default-on 模式不交任何命令行附加键(那一条只在反向白名单下需要)', JSON.stringify(noneR.commandExtras))
const noneOff = reg('undefined 入参 + default-off', T.buildProfile(undefined, undefined, { mode: 'default-off' }))
ok(eqJson(noneOff.commandExtras, ['modules_enabled_by_default=no']),
   '反向白名单模式即使什么都没勾也照样交命令行键:它是预设模式的产物,不是勾选项的产物', JSON.stringify(noneOff.commandExtras))
ok(eqJson(noneOff.written, ['modules_enabled_by_default']),
   'written 也如实记上这条命令行键(#38 之后 written = 两通道并集)', JSON.stringify(noneOff.written))
ok(Object.keys(dboOf(noneOff)).length === 0, '什么都没探到时反向模式也一个 profile 键都不写(未探到的只进 skipped)', JSON.stringify(dboOf(noneOff)))
ok(Object.values(T.initialSelection(undefined)).every((v) => v === false),
   'initialSelection(undefined) 与"什么都没探到"同形:全部不打勾,不抛(面板拿到空表也不会显示成满勾)',
   JSON.stringify(Object.values(T.initialSelection(undefined)).filter(Boolean)))

section('预设的形状(T9 面板按 id 取用)')
const ids = F.TPL_FEATURES.map((f) => f.id)
ok(Object.keys(init).length === ids.length && ids.every((id) => id in init),
   'initialSelection 覆盖全部 55 项,一个不多一个不少', `${Object.keys(init).length} / ${ids.length}`)
ok(T.PRESETS.lite2dIds.every((id) => !!F.featureById(id)),
   'lite2dIds 里每个 id 都真实存在于功能表(写错 id 就红)', T.PRESETS.lite2dIds.filter((id) => !F.featureById(id)).join(','))
const lite = T.PRESETS.lite2d(OPTS)
ok(lite.sys3d === false && lite.accesskit === false, 'lite2d 取消 3D 伞项与无障碍', JSON.stringify([lite.sys3d, lite.accesskit]))
ok(lite.phys3d === true, 'lite2d 不替源码假设连带:3D 物理仍按探测默认打勾', JSON.stringify(lite.phys3d))
const liteR = reg('lite2d 预设', T.buildProfile(lite, OPTS))
ok(eqJson(liteR.commandExtras, ['accesskit=no', 'disable_3d=yes']),
   'lite2d 生成的命令行恰好两项:disable_3d=yes 与 accesskit=no(#38:这两条都不是 module_*)', JSON.stringify(liteR.commandExtras))
ok(Object.keys(dboOf(liteR)).length === 0,
   'lite2d 的 profile 是空对象:它动的两项全落在核心 flag 一侧,没有一个模块开关', JSON.stringify(dboOf(liteR)))
// 名单与行为必须同源(E6):上一轮只验 id 存在于表里,把 lite2d() 里的 accesskit 换成另一个
// 真实存在的 id,名单与实际改动集合悄悄分叉而不红。这里拿"全勾夹具"上的差集反向核对名单。
const ALL_ON_OPTS = {}
for (const f of F.TPL_FEATURES) {
  for (const k of F.flagsOf(f)) {
    const e = T.ENUM_VALUES[k]
    ALL_ON_OPTS[k] = { exists: true, default: e ? e.on : (/^disable_/.test(k) ? false : true) }
  }
}
const allOn = T.initialSelection(ALL_ON_OPTS)
ok(Object.values(allOn).every((v) => v === true), '全开夹具:55 项初始全是勾着的(下面两条差集的前提)',
   JSON.stringify(Object.keys(allOn).filter((id) => !allOn[id])))
const touchedLite = Object.keys(allOn).filter((id) => T.PRESETS.lite2d(ALL_ON_OPTS)[id] !== allOn[id]).sort()
ok(eqJson(touchedLite, [...T.PRESETS.lite2dIds].sort()),
   'lite2dIds 与 lite2d() 实际取消的集合逐字相等(把预设里的 accesskit 换成别的真 id 就红)', JSON.stringify(touchedLite))
const touchedMin = Object.keys(allOn).filter((id) => T.PRESETS.minimalSelection(ALL_ON_OPTS)[id] !== allOn[id]).sort()
ok(eqJson(touchedMin, [...T.PRESETS.minimalIds].sort()),
   'minimalIds 与 minimalSelection() 实际取消的集合逐字相等', JSON.stringify(touchedMin))
ok(touchedMin.length === 7,
   'minimal 恰好动 7 个面板项(官方 :110-116 一一对应,不多关一项也不少关一项)', `${touchedMin.length}: ${touchedMin.join(',')}`)
ok(eqJson(F.TPL_FEATURES.filter((f) => touchedMin.includes(f.id)).flatMap((f) => F.flagsOf(f)).sort(), [...OFFICIAL_MIN_7].sort()),
   'minimal 动的那 7 项映射到的 flag 逐字 = 官方 CI 的 :110-116 七条(不是"看着像"的近似)',
   JSON.stringify(F.TPL_FEATURES.filter((f) => touchedMin.includes(f.id)).flatMap((f) => F.flagsOf(f))))
ok(touchedMin.every((id) => !['vulkan', 'opengl3', 'angle', 'sdl', 'd3d12'].includes(id)),
   'minimal 不取消渲染/输入驱动那几项(上一轮的凑法把它们一起关了)', touchedMin.join(','))
// 全开夹具下的 lite2d:两项都发命令行,profile 空 —— 与 MINIMAL 那节同一条通道口径。
const liteAllOn = reg('lite2d(全开夹具)', T.buildProfile(T.PRESETS.lite2d(ALL_ON_OPTS), ALL_ON_OPTS))
ok(eqJson(liteAllOn.commandExtras, ['accesskit=no', 'disable_3d=yes']),
   '全开夹具下的 lite2d 也只发这两条命令行 token', JSON.stringify(liteAllOn.commandExtras))
ok(Object.keys(dboOf(liteAllOn)).length === 0, '全开夹具下 lite2d 不写任何 profile 键(它不动模块)', JSON.stringify(dboOf(liteAllOn)))
// 真实默认:minizip True(SConstruct:194)、brotli True(:195)、deprecated True(:190)。
// 必须用探到=True 的夹具,否则"预设把它们强制取消"这条断言毫无牙(OPTS 里没探到,
// 初始态本来就是 false,删掉那三行预设也看不出差别)。
const optsReal = Object.assign({}, withPrec, {
  minizip: { exists: true, default: true },
  brotli: { exists: true, default: true },
  vulkan: { exists: true, default: true },
  module_gltf_enabled: { exists: true, default: true }
})
const minSel = T.PRESETS.minimalSelection(optsReal)
ok(T.initialSelection(optsReal).optMinizip === true && T.initialSelection(optsReal).optBrotli === true,
   '夹具里 minizip/brotli 探到默认 True → 初始是勾着的(下面才看得出预设有没有真的取消它们)')
ok(minSel.optDeprecated === false && minSel.optMinizip === false && minSel.optBrotli === false && minSel.optPrecision === false,
   'minimal 取消 deprecated/minizip/brotli(照官方 CI)且其余编译选项跟随探测默认', JSON.stringify([minSel.optDeprecated, minSel.optMinizip, minSel.optBrotli, minSel.optPrecision]))
const minReal = reg('minimal(optsReal 夹具)', T.buildProfile(minSel, optsReal, { mode: 'default-off' }))
// optsReal 与 MIN_OPTS 的区别是它没探 disable_advanced_gui / disable_physics_2d(那两条进 skipped),
// 但多探了 gltf 模块与 precision —— 所以命令行是官方 9 条里的 6 条,profile 多一个 gltf。
ok(eqJson(minReal.commandExtras, ['brotli=no', 'deprecated=no', 'disable_3d=yes', 'disable_physics_3d=yes', 'minizip=no', 'modules_enabled_by_default=no']),
   '夹具换了、规则没换:探到的官方条目逐字落在命令行(与 MIN_OPTS 那条互为交叉验证)', JSON.stringify(minReal.commandExtras))
ok(eqJson(Object.keys(dboOf(minReal)), ['module_gltf_enabled', 'module_webp_enabled']),
   'minimal 对保留的模块(gltf/webp)在 profile 里显式点名 true,其余一个键都不写', JSON.stringify(Object.keys(dboOf(minReal))))
ok(!hasIn(minReal, 'vulkan'), '对渲染驱动(vulkan)两个通道一个字都不写 —— 面板上看不见的东西不由预设代关', JSON.stringify([dboOf(minReal), minReal.commandExtras]))

section('Ruling #38 通道守卫:遍历本节造出的每一份产物')
// 这两条是规则本身的牙:
//   · profile(disabled_build_options)里**不得出现任何非 module_* 前缀的键**;
//   · commandExtras 里**不得出现任何 module_* 前缀的键**。
// 把 accesskit(或 deprecated)改回写进 profile → 第一条红;把某个 module_* 改发进命令行 → 第二条红。
ok(PROD.length >= 14, `登记表里有 ${PROD.length} 份产物被遍历(少于这个数说明守卫在空转)`, PROD.map((p) => p[0]).join(' / '))
for (const [label, pr] of PROD) {
  const badProfile = Object.keys(dboOf(pr)).filter((k) => !isModulePrefix(k))
  ok(badProfile.length === 0, `「${label}」的 profile 里没有非 module_* 键(#38 主守卫)`, JSON.stringify(badProfile))
  const badCmd = pr.commandExtras.filter((t) => isModulePrefix(cmdFlagOf(t)))
  ok(badCmd.length === 0, `「${label}」的命令行里没有 module_* 键(#38 反向守卫)`, JSON.stringify(badCmd))
}
// 上面每条产物都可能恰好只有一个通道有东西,所以再对**并集**上一条:两类键都真的被各自通道收过。
const seenProfile = [...new Set(PROD.flatMap(([, pr]) => Object.keys(dboOf(pr))))]
const seenCmd = [...new Set(PROD.flatMap(([, pr]) => cmdOf(pr)))]
ok(seenProfile.every(isModulePrefix) && seenProfile.length > 0,
   '全部产物并集:profile 侧出现过的键非空且全是 module_*(守卫确实在有数据的通道上跑)', JSON.stringify(seenProfile))
ok(seenCmd.every((k) => !isModulePrefix(k)) && seenCmd.length > 0,
   '全部产物并集:命令行侧出现过的键非空且没有一个是 module_*', JSON.stringify(seenCmd))
for (const k of ['accesskit', 'deprecated', 'disable_3d', 'precision', 'modules_enabled_by_default']) {
  ok(seenCmd.includes(k) && !seenProfile.includes(k),
     `${k} 在所有产物里只出现在命令行(#38 的"其余一切走命令行"),把它挪回 profile 这条就红`, JSON.stringify({ seenProfile, seenCmd }))
}
for (const k of ['module_webp_enabled', 'module_tga_enabled', 'module_gltf_enabled', 'module_vorbis_enabled']) {
  ok(seenProfile.includes(k) && !seenCmd.includes(k),
     `${k} 在所有产物里只出现在 profile(把它改发命令行这条就红)`, JSON.stringify({ seenProfile, seenCmd }))
}

// ---- 真树核对:SConstruct 在就把 ENUM_VALUES 与方向判断钉到真实源码上 ----
const REAL_SRC = 'C:/Users/Administrator/AppData/Local/Temp/godot-tpl-verify/godot-4.7.2-stable'
const realSC = path.join(REAL_SRC, 'SConstruct')
if (fs.existsSync(realSC)) {
  section('真实 4.7.2 SConstruct 核对(临时树在才跑)')
  const realOpts = P.parseSconsOptions(fs.readFileSync(realSC, 'utf8'))
  ok(realOpts.precision && realOpts.precision.default === 'single' && realOpts.lto.default === 'none' && realOpts.optimize.default === 'auto',
     '真实默认值逐字是 single/none/auto —— ENUM_VALUES 的 off 就是照它写的',
     JSON.stringify([realOpts.precision && realOpts.precision.default, realOpts.lto && realOpts.lto.default, realOpts.optimize && realOpts.optimize.default]))
  const realInit = T.initialSelection(realOpts)
  ok(realInit.optPrecision === false && realInit.optLto === false && realInit.optSize === false && realInit.optDebugSymbols === false && realInit.d3d12 === false,
     '真实源码上"双精度/LTO/体积优先/调试符号/d3d12"全都不打勾(启发式至少中一条)',
     JSON.stringify({ p: realInit.optPrecision, l: realInit.optLto, o: realInit.optSize, d: realInit.optDebugSymbols, g: realInit.d3d12 }))
  ok(realInit.sys3d === true && realInit.vulkan === true && realInit.optDeprecated === true && realInit.optMinizip === true,
     '真实源码上 3D 伞项与 vulkan/deprecated/minizip 打勾(方向取反生效)',
     JSON.stringify({ s3: realInit.sys3d, v: realInit.vulkan, dep: realInit.optDeprecated, mz: realInit.optMinizip }))
  // E3 的现场版:收窄 isNegatedFlag 的那三个之外,真树上还有 5 个伞项会被显示成未勾选。
  ok(['nav3d', 'nav2d', 'xr', 'advGui', 'overrideCfg'].every((id) => realInit[id] === true),
     '真实源码上 nav3d/nav2d/xr/advGui/overrideCfg 全都初始勾着(它们默认 False = 功能开着)',
     JSON.stringify({ n3: realInit.nav3d, n2: realInit.nav2d, xr: realInit.xr, ag: realInit.advGui, ov: realInit.overrideCfg }))
  const realFull = reg('真实树:全默认勾选', T.buildProfile(realInit, realOpts))
  ok(realFull.written.length === 0 && Object.keys(dboOf(realFull)).length === 0,
     '真实 4.7.2 上"全默认勾选"生成空 profile —— 这条是整个设计的立身之本',
     JSON.stringify(dboOf(realFull)) + ' / written=' + JSON.stringify(realFull.written))
  ok(eqJson(realFull.commandExtras, []), '真实 4.7.2 上"全默认勾选"也不发任何命令行 token', JSON.stringify(realFull.commandExtras))
  const realTweak = reg('真实树:关 3D + 勾双精度 + 勾体积优先', T.buildProfile(Object.assign({}, realInit, { sys3d: false, optPrecision: true, optSize: true }), realOpts))
  ok(tokenOf(realTweak, 'precision') === 'precision=double' && !( 'precision' in dboOf(realTweak)),
     '真实选项表上勾双精度 → 命令行 precision=double(profile 里没有它)', JSON.stringify([realTweak.commandExtras, dboOf(realTweak)]))
  // 真树只有 SConstruct 可探(那棵临时树的 modules/*/ 只剩 config.py → 模块三件套不齐 → 0 个模块键),
  // 所以 #38 之后真实树上的 profile 是**空的**、所有产出都在命令行 —— 这正是通道判定的直接证据。
  ok(Object.keys(dboOf(realTweak)).length === 0,
     '真实树(未探到模块)下 profile 为空:核心 flag 全走命令行,不留不生效的归档键', JSON.stringify(dboOf(realTweak)))
  const realLite = reg('真实树:lite2d 预设', T.buildProfile(T.PRESETS.lite2d(realOpts), realOpts))
  ok(eqJson(realLite.commandExtras, ['accesskit=no', 'disable_3d=yes']) && Object.keys(dboOf(realLite)).length === 0,
     '真实树 lite2d:恰好这两条命令行 token,profile 空', JSON.stringify([realLite.commandExtras, dboOf(realLite)]))
  const realMin = reg('真实树:minimal(default-off)', T.buildProfile(T.PRESETS.minimalSelection(realOpts), realOpts, { mode: 'default-off' }))
  ok(eqJson(realMin.commandExtras, MIN_EXPECT_CMD),
     '真实树:命令行 8 条逐字 = 官方 :108 + :110-116(#38 之后 minimal 与官方那行 scons-flags 等价)', JSON.stringify(realMin.commandExtras))
  ok(eqJson(Object.keys(dboOf(realMin)), []),
     '真实树上 minimal 的 profile 是空对象:临时树的模块一个都没探到,而非 module_* 的键按 #38 不上 profile', JSON.stringify(Object.keys(dboOf(realMin))))
  ok(eqJson(Object.keys(dboOf(realMin)).filter((k) => /^disable_/.test(k)), []),
     '真实树上 minimal 的 profile 里一个 disable_* 都没有(上一轮这里钉的是"恰好官方那四条",#38 之后那四条搬到命令行)',
     JSON.stringify(Object.keys(dboOf(realMin))))
  ok(['deprecated', 'minizip', 'brotli'].every((k) => tokenOf(realMin, k) === `${k}=no` && !(k in dboOf(realMin))),
     '真实树上 deprecated/minizip/brotli 三条发 no 到命令行(官方 :114-116),且都不在 profile 里', JSON.stringify(realMin.commandExtras))
  ok(['vulkan', 'opengl3', 'angle', 'sdl'].every((k) => !hasIn(realMin, k)),
     '真实树上渲染与输入驱动一条都不发(真树默认全 True,勾着 → 与默认相同 → 不输出)', JSON.stringify([Object.keys(dboOf(realMin)), realMin.commandExtras]))
  ok(Object.keys(dboOf(realMin)).every((k) => isModulePrefix(k)),
     '真实树 minimal 的 profile 键要么带 module_ 前缀要么一个都没有(#38 在真树上成立)', JSON.stringify(Object.keys(dboOf(realMin))))
} else {
  console.log(`\n(跳过真实源码核对:未找到 ${realSC})`)
}

// ==================== Task 6 · 静态校验 validateSelection ====================
// 本节是**同步**的:validateSelection 与被它复用的 buildProfile 都是纯函数,没有 async 断言节,
// 所以汇总仍留在文件末尾(Ruling #25 那个「async 节里的断言不计入 PASS 也不改退出码」的坑在这里不存在)。
// 校验判的是「将要发出去的那份产物」→ 一律两通道并集看(#38:四个渲染驱动只在命令行里)。
section('静态校验:可越过的软问题')
const OPTS2 = Object.assign({}, OPTS, {
  vulkan: { exists: true, default: true }, opengl3: { exists: true, default: true }, angle: { exists: true, default: true },
  module_godot_physics_2d_enabled: { exists: true, default: true }, module_godot_physics_3d_enabled: { exists: true, default: true },
  disable_physics_2d: { exists: true, default: false }, disable_physics_3d: { exists: true, default: false }
})
let v = T.validateSelection(sel({ d3d12: true }), OPTS2, { d3d12SdkInstalled: false })
ok(v.issues.some((i) => i.itemId === 'd3d12' && i.skippable === true), '保留 d3d12 但缺依赖 → 软问题带「仍然继续」', JSON.stringify(v.issues))
ok(v.hardBlocks.length === 0, '软问题不进硬拦')

section('硬拦:无渲染后端 / 一项不剩(共三条,第三条见下面那节)')
v = T.validateSelection(sel({ vulkan: false, opengl3: false, angle: false, d3d12: false }), OPTS2, {})
ok(v.hardBlocks.some((i) => i.itemId === 'vulkan'), '渲染驱动全关 → 硬拦(编出来的东西必然没有画面)', JSON.stringify(v.hardBlocks))
const none = {}
for (const f of F.TPL_FEATURES) none[f.id] = false
v = T.validateSelection(none, OPTS2, {})
ok(v.hardBlocks.length > 0, '面板一项不剩 → 硬拦')

section('探测未识别的项不算问题,但要在 ctx.untestedSource 时提示')
v = T.validateSelection(sel({ sys3d: false }), {}, { untestedSource: true })
ok(v.issues.some((i) => /未实测|未识别/.test(i.why)), '未实测版本 → 出一条保守提示', JSON.stringify(v.issues))
ok(v.hardBlocks.length === 0, '未实测不硬拦(策划书 §1 第 13 条)')
// ↑ 这一条同时钉住简报 Step 3 原式的一处误拦:它把「没探到」当「已关闭」,
//   options 传 {} 时 drivers 数组为空 → 会对一份什么都没探到的源码报「四个驱动全关」硬拦。

// 校验结果的收集表:本节末尾的「Issue 形状契约」对它做遍历性断言(防空转)。
const VCOL = []
const vk = (label, x) => { VCOL.push([label, x]); return x }

section('硬拦第三条(裁定①):反向白名单 + 一个模块都没探到 = 零模块废产物')
// CORE_ONLY = OPTS2 去掉全部 module_* 键,正是本机那棵裁剪树 probeSource 的真实形态(102 键 / 0 个模块)。
// T5 轮 1 之前 modules_enabled_by_default=no 写进 profile 是**惰性 no-op**;#38 把它送上命令行后它是活的
// (SConstruct:476 唯一读点早于 profile 落 env 的 :655),而 buildProfile 照发不误 ——
// 现有测试甚至钉死了 buildProfile(undefined, undefined, {mode:'default-off'}) 也交这条 token。
// → 拦它的责任在 T6:用户承担的不是风险,是几十分钟后拿到一个没有 gdscript、没有文字的产物。
const CORE_ONLY = {}
for (const k of Object.keys(OPTS2)) if (!isModulePrefix(k)) CORE_ONLY[k] = OPTS2[k]
ok(Object.keys(CORE_ONLY).every((k) => !isModulePrefix(k)) && Object.keys(CORE_ONLY).length > 0,
   '夹具 CORE_ONLY 确实一个 module_* 都没探到但核心键在(下面那条硬拦的前提,空夹具会让它变成空转)', JSON.stringify(Object.keys(CORE_ONLY)))
const REV_OPTS = Object.assign({ modules_enabled_by_default: { exists: true, default: true } }, CORE_ONLY)
// 夹具里额外勾着 fmtWebp:它对应的 module_webp_enabled 在这份源码里探不到 →
// 这正是「用户以为保留了 webp、反向白名单把它整体关掉」的现场形态,也是硬拦与 S5 软问题的分工点
// (硬拦兜住"一个都没点名",S5 只在"还能点名别的"时才补一句)。
const revBadSel = Object.assign(T.initialSelection(REV_OPTS), { fmtWebp: true })
v = vk('反向+0 模块→硬拦', T.validateSelection(revBadSel, REV_OPTS, { mode: 'default-off' }))
ok(v.hardBlocks.some((i) => i.flag === 'modules_enabled_by_default' && i.skippable === false),
   '反向模式 + 零模块点名 → 硬拦(不给「仍然继续」)', JSON.stringify(v.hardBlocks))
ok(!v.issues.some((i) => /反向白名单/.test(i.why)),
   '硬拦已经说了这件事就不再重复出软问题(去掉两条规则的互斥门,这里就多一条同义反复)', JSON.stringify(v.issues))
v = T.validateSelection(T.initialSelection(REV_OPTS), REV_OPTS, {})
ok(!v.hardBlocks.some((i) => i.flag === 'modules_enabled_by_default'),
   '同一份选项表在 default-on 下不拦:那条 token 根本没发出去(把 mode/token 判据删掉这条就红)', JSON.stringify(v.hardBlocks))
const REV_MIN_OPTS = Object.assign({ modules_enabled_by_default: { exists: true, default: true } }, MIN_OPTS)
v = T.validateSelection(T.PRESETS.minimalSelection(REV_MIN_OPTS), REV_MIN_OPTS, { mode: 'default-off' })
ok(v.hardBlocks.every((i) => i.flag !== 'modules_enabled_by_default'),
   '反向模式但保留的模块被点名了(webp)→ 不是零模块产物 → 不硬拦(删掉"有没有点名"这半边判据这条就红)', JSON.stringify(v.hardBlocks))
v = T.validateSelection(T.initialSelection(CORE_ONLY), CORE_ONLY, { mode: 'default-off' })
ok(!v.hardBlocks.some((i) => i.flag === 'modules_enabled_by_default'),
   '这份源码根本没声明 modules_enabled_by_default → 发出去也是静默忽略 → 不拦(未声明的键不存在,拿"我记得有"当依据就是猜)', JSON.stringify(v.hardBlocks))

section('反向白名单下「面板保留但源码没探到」的模块 → 软问题(不硬拦)')
// 真实形态:fmtCompressed 一项映射 7 个模块开关(dds/ktx/tinyexr/astcenc/bcdec/etcpak/cvtt),
// 源码里少一个目录就是"整项勾着、产物里缺一块"。这里造出那个形态(cvtt 探不到)。
const REV_FULL = Object.assign({ modules_enabled_by_default: { exists: true, default: true } }, ALL_ON_OPTS)
delete REV_FULL.module_cvtt_enabled
const revKept = Object.assign(T.initialSelection(REV_FULL), { fmtCompressed: true })
ok(revKept.fmtCompressed === true && !('module_cvtt_enabled' in REV_FULL),
   '夹具:该项是勾着的而它的一个模块 flag 没探到(不勾就不该报,探得到也不该报)', JSON.stringify([revKept.fmtCompressed, 'module_cvtt_enabled' in REV_FULL]))
v = vk('反向+cvtt 未探到', T.validateSelection(revKept, REV_FULL, { mode: 'default-off', untestedSource: true, d3d12SdkInstalled: false }))
ok(v.issues.some((i) => i.skippable === true && /反向白名单/.test(i.why) && /整体关/.test(i.why) && /1 项/.test(i.why)),
   '保留的模块没探到 → 出一条「它会被整体关掉」的软问题,条数如实是 1', JSON.stringify(v.issues))
ok(v.issues.length >= 3, '这一份场景同时出 3 条软问题(未实测 + 缺依赖 + 反向白名单)——下面的 (itemId,flag) 去重检查因此不是空转', JSON.stringify(v.issues.map((i) => [i.itemId, i.flag])))
ok(v.hardBlocks.every((i) => i.flag !== 'modules_enabled_by_default'),
   '其余模块都点名的到 → 不是零模块产物 → 不硬拦(§5.5:能越过就让他越过)', JSON.stringify(v.hardBlocks))
// 反面对照:同一份选项表但**没有**勾着探不到的项 → 一条都不报(把 some 判据写死成"总报"这条就红)
v = T.validateSelection(T.initialSelection(REV_FULL), REV_FULL, { mode: 'default-off' })
ok(!v.issues.some((i) => /反向白名单/.test(i.why)),
   '探不到的那一项没被勾着 → 不报(未识别项按源码默认处理,不是用户保留了什么)', JSON.stringify(v.issues))

section('校验必须查两通道并集(#38 后四个渲染驱动只出现在命令行)')
const noDrvSel = sel({ vulkan: false, opengl3: false, angle: false, d3d12: false })
const noDrvBuilt = T.buildProfile(noDrvSel, OPTS2)
ok(!['vulkan', 'opengl3', 'angle', 'd3d12'].some((k) => k in dboOf(noDrvBuilt)),
   '四个驱动的「关」一个都不在 profile 里(只查 profile 的校验在这里永远查不到它们)', JSON.stringify(Object.keys(dboOf(noDrvBuilt))))
ok(['vulkan=no', 'opengl3=no', 'angle=no'].every((t) => noDrvBuilt.commandExtras.includes(t)) && !inCommand(noDrvBuilt, 'd3d12'),
   '它们全在命令行 token 里;d3d12 默认已 False → 不发(§5.3 差值)', JSON.stringify(noDrvBuilt.commandExtras))
ok(vk('驱动全关', T.validateSelection(noDrvSel, OPTS2, {})).hardBlocks.some((i) => i.itemId === 'vulkan'),
   '而硬拦照样触发 —— 这条是"只读 disabled_build_options 的实现"的照妖镜')
// 反面对照:只剩 d3d12 一个驱动(它源码默认 False,勾上才是"有画面")。把 d3d12 从名单里漏掉
// 就会把这份**能跑**的组合误拦成"没有任何画面" —— 这条给名单本身当牙。
const onlyD3d12 = T.validateSelection(Object.assign(T.initialSelection(OPTS2), { vulkan: false, opengl3: false, angle: false, d3d12: true }), OPTS2, {})
ok(onlyD3d12.hardBlocks.length === 0,
   '三个默认为真的驱动全关、只留 d3d12 → 不硬拦(它也是渲染驱动;名单里漏掉它就误拦)', JSON.stringify(onlyD3d12.hardBlocks))
ok(inCommand(T.buildProfile(Object.assign(T.initialSelection(OPTS2), { d3d12: true }), OPTS2), 'd3d12'),
   '夹具:勾上 d3d12 确实会发出 d3d12=yes(否则上一条不拦是假绿)', '')

section('物理软问题:2D 与 3D 两条轴都没有后端才报,未知不报')
const PHYS_OPTS = {
  module_godot_physics_2d_enabled: { exists: true, default: true }, module_godot_physics_3d_enabled: { exists: true, default: true },
  module_jolt_physics_enabled: { exists: true, default: true },
  disable_physics_2d: { exists: true, default: false }, disable_physics_3d: { exists: true, default: false },
  vulkan: { exists: true, default: true }
}
const physBase = T.initialSelection(PHYS_OPTS)
ok(physBase.a3GodotPhys === true && physBase.a3Jolt === true && physBase.phys2d === true && physBase.phys3d === true,
   '夹具:物理相关四项初始都勾着(下面才看得出"取消"是用户的选择而不是我们的假设)', JSON.stringify([physBase.a3GodotPhys, physBase.a3Jolt, physBase.phys2d, physBase.phys3d]))
v = vk('自带后端+Jolt 全取消', T.validateSelection(Object.assign({}, physBase, { a3GodotPhys: false, a3Jolt: false }), PHYS_OPTS, {}))
ok(v.issues.some((i) => i.itemId === 'a3GodotPhys' && i.skippable === true),
   '两套自带后端 + Jolt 全取消 → 没有物理的软问题', JSON.stringify(v.issues))
v = T.validateSelection(Object.assign({}, physBase, { a3GodotPhys: false }), PHYS_OPTS, {})
ok(!v.issues.some((i) => /物理后端都被关掉/.test(i.why)),
   'Jolt 还留着 → 3D 有后端 → 不该报(把 Jolt 那半边判据删掉这条就红)', JSON.stringify(T.validateSelection(Object.assign({}, physBase, { a3GodotPhys: false }), PHYS_OPTS, {}).issues))
v = T.validateSelection(Object.assign({}, physBase, { phys3d: false }), PHYS_OPTS, {})
ok(!v.issues.some((i) => /物理后端都被关掉/.test(i.why)), '只关 3D 物理伞 → 2D 还在 → 不报(两条轴是 && 不是 ||)')
v = vk('两套 disable_* 伞全取消', T.validateSelection(Object.assign({}, physBase, { phys2d: false, phys3d: false }), PHYS_OPTS, {}))
ok(v.issues.some((i) => i.itemId === 'a3GodotPhys' && i.skippable === true),
   'module_* 都勾着但 disable_physics_2d/3d 双双关掉 → 同样是没有物理(简报原式只看 module_*,这里会漏报)', JSON.stringify(v.issues))
v = T.validateSelection(Object.assign({}, physBase, { a3GodotPhys: false, a3Jolt: false }), {}, {})
ok(!v.issues.some((i) => /物理后端都被关掉/.test(i.why)), '什么都没探到时不报物理(未探到 ≠ 已关闭)')

section('依赖类软问题只在"这个驱动真会被编进产物"时报')
v = vk('accesskit 缺依赖', T.validateSelection(sel({ accesskit: true }), OPTS2, { accesskitSdkInstalled: false }))
ok(v.issues.some((i) => i.itemId === 'accesskit' && i.skippable === true), '保留 accesskit 但缺依赖 → 软问题', JSON.stringify(v.issues))
v = T.validateSelection(sel({ accesskit: false }), OPTS2, { accesskitSdkInstalled: false })
ok(!v.issues.some((i) => i.itemId === 'accesskit'), '已经取消 accesskit → 依赖装不上也无所谓,不该报', JSON.stringify(v.issues))
v = T.validateSelection(sel({ d3d12: true }), {}, { d3d12SdkInstalled: false })
ok(!v.issues.some((i) => i.itemId === 'd3d12'),
   '保留了 d3d12 但这份源码里没探到它 → 命令行根本不会发它 → 不报(报了就是把我们的无知说成用户的选择)')

section('关 mbedTLS 是软问题,但只在"真的关掉了"时报')
const MB_OPTS = { module_mbedtls_enabled: { exists: true, default: true }, module_webp_enabled: { exists: true, default: true }, vulkan: { exists: true, default: true } }
const mbBase = T.initialSelection(MB_OPTS)
v = vk('关 mbedTLS', T.validateSelection(Object.assign({}, mbBase, { netMbedtls: false }), MB_OPTS, {}))
ok(v.issues.some((i) => i.itemId === 'netMbedtls' && i.flag === 'module_mbedtls_enabled' && i.skippable === true),
   '取消 mbedTLS → 软问题(#38:它是 module_*,产物在 profile 通道里)', JSON.stringify(v.issues))
v = T.validateSelection(Object.assign({}, mbBase, { netMbedtls: false }), {}, {})
ok(!v.issues.some((i) => i.itemId === 'netMbedtls'), '这份源码没探到 module_mbedtls_enabled → 什么都没被关掉 → 不报')

section('入参整体缺失:不抛,按「什么都没探到」处理(与 buildProfile 同一条兜底)')
v = vk('全 undefined 入参', T.validateSelection(undefined, undefined, undefined))
ok(Array.isArray(v.issues) && Array.isArray(v.hardBlocks) && v.hardBlocks.length === 1 && v.hardBlocks[0].itemId === 'source',
   'undefined 入参 → 不抛,只出「一项都没保留」这一条硬拦(把 selection||{} 删掉这里直接 TypeError)', JSON.stringify(v))

section('Issue 形状契约(T9 按 itemId 找面板行,T10 按 skippable 分流)')
ok(VCOL.length >= 8, `收集了 ${VCOL.length} 个校验结果供遍历断言(空了下面三条就是空转)`, VCOL.map((x) => x[0]).join(' / '))
const allIss = VCOL.flatMap((pair) => pair[1].issues.concat(pair[1].hardBlocks).map((i) => [pair[0], i]))
ok(allIss.length >= 8, `收集到的 issue 共 ${allIss.length} 条(为 0 时下面几条全体空转)`, VCOL.map((p) => `${p[0]}:${p[1].issues.length}+${p[1].hardBlocks.length}`).join(' / '))
ok(allIss.every((p) => {
  const i = p[1]
  return typeof i.itemId === 'string' && i.itemId.length > 0 && typeof i.flag === 'string' &&
    typeof i.why === 'string' && i.why.length >= 10 && typeof i.action === 'string' && i.action.length > 0 &&
    typeof i.skippable === 'boolean'
}), '每条 issue 五字段齐全:itemId/flag/why/action/skippable,why 与 action 非空', JSON.stringify(allIss.filter((p) => !p[1].why || !p[1].action)))
ok(allIss.every((p) => p[1].itemId === 'source' || !!F.featureById(p[1].itemId)),
   'itemId 必须是功能表里的面板项 id(全局项只允许 source)——拼错的 id 让 T9 找不到行', JSON.stringify(allIss.filter((p) => p[1].itemId !== 'source' && !F.featureById(p[1].itemId)).map((p) => p[1].itemId)))
ok(allIss.every((p) => p[1].flag === '' || p[1].flag === 'modules_enabled_by_default' || TABLE_FLAGS.includes(p[1].flag)),
   'flag(非空时)必须是功能表里的真实 flag 名,或模式级那一条 —— 与实现真正会写出的键名对不上就红', JSON.stringify(allIss.filter((p) => p[1].flag !== '' && p[1].flag !== 'modules_enabled_by_default' && !TABLE_FLAGS.includes(p[1].flag)).map((p) => p[1].flag)))
ok(VCOL.every((pair) => pair[1].issues.every((i) => i.skippable === true) && pair[1].hardBlocks.every((i) => i.skippable === false)),
   '软问题一律 skippable:true、硬拦一律 false(T10 就靠这个字段决定给不给「仍然继续」)')
const allHard = VCOL.flatMap((pair) => pair[1].hardBlocks)
const hardRoster = [...new Set(allHard.map((i) => i.itemId + '|' + i.flag))].sort()
ok(eqJson(hardRoster, ['source|', 'source|modules_enabled_by_default', 'vulkan|vulkan']),
   '硬拦名单**封闭为三条**(策划书 §5.5:除硬拦外一律可越过,多一条都是拿我们的无知换他的选择权)', JSON.stringify(hardRoster))
ok(['source|', 'source|modules_enabled_by_default', 'vulkan|vulkan'].every((k) => hardRoster.includes(k)),
   '三条硬拦各被至少一个场景真的触发过(名单封闭但不空转:某条永不触发就该删掉它)', JSON.stringify(hardRoster))
for (const pair of VCOL) {
  const softKeys = pair[1].issues.map((i) => i.itemId + ' ' + i.flag)
  const hardKeys = pair[1].hardBlocks.map((i) => i.itemId + ' ' + i.flag)
  ok(new Set(softKeys).size === softKeys.length && new Set(hardKeys).size === hardKeys.length,
     `「${pair[0]}」同一列表内 (itemId,flag) 不重复(T9 的 v-for key 用它)`, JSON.stringify([softKeys, hardKeys]))
}

// ---- 真树上的静态校验:临时树在才跑 ----
if (fs.existsSync(path.join(REAL_SRC, 'SConstruct'))) {
  section('真实 4.7.2 源码上的静态校验(树在才跑)')
  const vRealOpts = P.parseSconsOptions(fs.readFileSync(path.join(REAL_SRC, 'SConstruct'), 'utf8'))
  const vRealFull = vk('真树:全默认勾选', T.validateSelection(T.initialSelection(vRealOpts), vRealOpts, {}))
  ok(vRealFull.hardBlocks.length === 0 && vRealFull.issues.length === 0,
     '真实源码上「全默认勾选」既不硬拦也不报软问题(与 T5 那条空 profile 同一条立身之本)', JSON.stringify(vRealFull))
  const vRealMin = vk('真树:minimal+反向', T.validateSelection(T.PRESETS.minimalSelection(vRealOpts), vRealOpts, { mode: 'default-off' }))
  ok(vRealMin.hardBlocks.some((i) => i.flag === 'modules_enabled_by_default' && i.skippable === false),
     '真树实样:本机这棵 modules/ 只剩 config.py 的树探到 0 个模块 → 反向模式必须硬拦(裁定①在真实源码上成立)', JSON.stringify(vRealMin.hardBlocks))
  const vRealDrv = T.validateSelection(Object.assign({}, T.initialSelection(vRealOpts), { vulkan: false, opengl3: false, angle: false, d3d12: false }), vRealOpts, {})
  ok(vRealDrv.hardBlocks.some((i) => i.itemId === 'vulkan'), '真树:四个驱动全关 → 硬拦', JSON.stringify(vRealDrv.hardBlocks))
  ok(!['vulkan', 'opengl3', 'angle', 'd3d12'].some((k) => k in dboOf(T.buildProfile(Object.assign({}, T.initialSelection(vRealOpts), { vulkan: false, opengl3: false, angle: false, d3d12: false }), vRealOpts))),
     '真树上这四个键的「关」也一个都不在 profile 里(#38 在真实源码上的形态)')
}

console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
