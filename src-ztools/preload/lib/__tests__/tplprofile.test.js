// 输出层(tplprofile.js):勾选 + 探测结果 → build_profile JSON。
// 规则只有一条(策划书 §5.3):用户选择 ≠ 探测到的源码默认值时才输出。
// build_profile 的 schema 与生效时机见 SConstruct:655-658 与 :1112-1113(§2 决策 6)。
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
// 简报夹具坑:PRESETS.full() 无参会走到 initialSelection(undefined) 然后在 options[k] 上抛
// TypeError。所有调用一律带 OPTS(简报自己的缺陷,不是实现要兜的行为 —— 实现故意让它崩)。
const sel = (on) => Object.assign(T.PRESETS.full(OPTS), on)
const dboOf = (r) => r.json.disabled_build_options

section('与默认相同 → 不输出')
let r = T.buildProfile(T.PRESETS.full(OPTS), OPTS)
ok(Object.keys(dboOf(r)).length === 0, '全默认勾选 → disabled_build_options 为空对象', JSON.stringify(r.json))

section('取消一项 → 只出这一项')
r = T.buildProfile(sel({ sys3d: false }), OPTS)
ok(dboOf(r).disable_3d === true, '取消 3D → "disable_3d": true', JSON.stringify(r.json))
ok(!('accesskit' in dboOf(r)), '未动的 accesskit 不出现')

section('勾选语义与源码默认方向相反的那几项(§5.3 的由来)')
r = T.buildProfile(sel({ optDebugSymbols: true }), OPTS)
ok(dboOf(r).debug_symbols === true, '勾上"调试符号"(默认 False)→ 输出 true', JSON.stringify(r.json))
r = T.buildProfile(T.PRESETS.full(OPTS), OPTS)
ok(!('debug_symbols' in dboOf(r)), '全默认态不输出 debug_symbols —— 否则"全量"预设会编出带符号的模板')
r = T.buildProfile(sel({ d3d12: false }), OPTS)
ok(!('d3d12' in dboOf(r)), '取消 d3d12(默认已 False)→ 不输出(现状那句 d3d12=no 是空操作)')

section('探测判 absent 的项 → 不写,且报出来')
r = T.buildProfile(sel({ sys3d: false }), Object.assign({}, OPTS, { disable_3d: undefined }))
ok(!('disable_3d' in dboOf(r)), '不存在的键绝不写进 profile(静默失效风险)')
ok(r.skipped.some((s) => s.flag === 'disable_3d' && /不存在|未探到/.test(s.why)), '跳过的项带原因', JSON.stringify(r.skipped))

section('一个面板项映射多个 flag 时全部处理')
r = T.buildProfile(sel({ fmtRaster: false }), Object.assign({}, OPTS, {
  module_tga_enabled: { exists: true, default: true }, module_bmp_enabled: { exists: true, default: true }, module_hdr_enabled: { exists: true, default: true }
}))
ok(['module_tga_enabled', 'module_bmp_enabled', 'module_hdr_enabled'].every((k) => dboOf(r)[k] === false), '三项一起关', JSON.stringify(dboOf(r)))
// 反向的一半:一项多 flag 时,**默认值不一致**就不能打勾(打勾等于替用户猜另外那个 flag 也开着)。
// 夹具:vorbis 探到且默认 True、ogg 未探到(真实 4.7.2 里 ogg 模块确实存在,这条只钉"every 不是 some")。
const mixed = Object.assign({}, OPTS, { module_vorbis_enabled: { exists: true, default: true } })
ok(T.initialSelection(mixed).audOgg === false, '一项多 flag 且默认混合(True + 未探到)→ 不打勾(every 写成 some 就红)',
   JSON.stringify(T.initialSelection(mixed).audOgg))
// 与"面板没给勾选态"不同:这里选择是**明确给了** false 的,所以按"用户取消了这项"处理 ——
// 探到的那个 flag 写 false,没探到的那个只进 skipped。
const mixedR = T.buildProfile(T.initialSelection(mixed), mixed)
ok(dboOf(mixedR).module_vorbis_enabled === false, '明确未勾选项里"探到的"flag 照选择写 false(把明确 false 当"不处理"就红)', JSON.stringify(dboOf(mixedR)))
ok(!('module_ogg_enabled' in dboOf(mixedR)) && mixedR.skipped.some((s) => s.flag === 'module_ogg_enabled'),
   '同一项里"没探到"的那个仍只报 skipped,不写(与上条分得开)', JSON.stringify(mixedR.skipped.filter((s) => /ogg/.test(s.flag))))

section('稳定序列化(给 parity 逐字节比)')
const a = T.profileText(T.buildProfile(sel({ sys3d: false, accesskit: false }), OPTS).json)
const b = T.buildProfile(sel({ accesskit: false, sys3d: false }), OPTS).json
const bText = T.profileText(b)
ok(a === bText, '勾选顺序不同 → 文本相同', `${a}\n---\n${bText}`)
ok(a.indexOf('"accesskit"') < a.indexOf('"disable_3d"'), '键按字典序输出')
// 上一条恰好被功能表顺序蒙对(accesskit 在表里就排在 sys3d 前面),所以再来一条**表顺序与
// 字典序相反**的:表里 sys3d(disable_3d)排在 引擎子系统,编译选项组的 debug_symbols 在末尾,
// 不 sortKeys 就会先写 disable_3d —— 而字典序要求 debug_symbols 在前。
const rOrd = T.buildProfile(sel({ sys3d: false, optDebugSymbols: true }), OPTS)
const tOrd = T.profileText(rOrd.json)
ok(tOrd.indexOf('"debug_symbols"') < tOrd.indexOf('"disable_3d"'),
   '字典序压过功能表插入序:debug_symbols 必须排在 disable_3d 前(去掉 sortKeys 就红)', tOrd)
ok(JSON.stringify(Object.keys(rOrd.json.disabled_build_options)) === JSON.stringify(['debug_symbols', 'disable_3d']),
   'disabled_build_options 的键数组本身就是字典序(Rust 侧按下标比也要对得上)', JSON.stringify(Object.keys(rOrd.json.disabled_build_options)))
// 钉住序列化形态本身:Rust 双端比的是字节,缩进或结构一变就对不上。
ok(a.split('\n')[1] === '  "disabled_build_options": {', '顶层只有 disabled_build_options + 缩进固定 2 空格', JSON.stringify(a.split('\n').slice(0, 3)))
ok(JSON.stringify(JSON.parse(T.profileText(b))) === JSON.stringify(b), 'profileText 可原样解析回同一对象')
// 值域不变量:scons 那侧 `env[c] = dbo[c]` 之后要么当布尔用要么按枚举字符串比,
// 出现 null / undefined / 数字就是本层算错了。undefined 更阴 —— JSON.stringify 直接把键丢掉,
// 文本里连 null 都看不见,所以必须比 written 的条数,不能只扫文本。
const invariantR = T.buildProfile(sel({ fmtRaster: false, optPrecision: true, sys3d: false, accesskit: false }), Object.assign({}, OPTS, { precision: { exists: true, default: 'single' } }))
ok(Object.values(dboOf(invariantR)).every((v) => typeof v === 'boolean' || typeof v === 'string'),
   '写出去的值只会是布尔或枚举字符串(没有 null / 数字 / undefined 通道)', JSON.stringify(dboOf(invariantR)))
ok(Object.keys(dboOf(invariantR)).length === invariantR.written.length,
   'written 条数 = 实际写出的键数(值算成 undefined 时键会静默消失,这条拦住)',
   `${invariantR.written.length} vs ${Object.keys(dboOf(invariantR)).length}`)
ok(!/:\s*(null|undefined)\b/.test(T.profileText(invariantR.json)), 'profile 文本里没有 null/undefined 字面量', T.profileText(invariantR.json))
// written 与真正写出的键集必须一致:键名对不上(比如 written 记的是面板 id)这里就红。
const rPair = T.buildProfile(sel({ sys3d: false, accesskit: false, fmtRaster: false }), OPTS)
ok(JSON.stringify(rPair.written) === JSON.stringify(Object.keys(dboOf(rPair)).sort()),
   'written 与实际写出的键集逐字一致(且已排序)',
   `${JSON.stringify(rPair.written)} vs ${JSON.stringify(Object.keys(dboOf(rPair)))}`)
ok(rPair.skipped.every((s) => rPair.written.indexOf(s.flag) === -1), 'skipped 与 written 无交集')

section('最小可跑预设走反向白名单')
const minimal = T.buildProfile(T.PRESETS.minimalSelection(OPTS), OPTS, { mode: 'default-off' })
ok(dboOf(minimal).modules_enabled_by_default === false, 'minimal 带 modules_enabled_by_default=no 的等价键', JSON.stringify(minimal.json))
ok(dboOf(minimal).disable_3d === true, '反向模式不改变核心 disable_* 的差值语义:未勾选的 disable_3d 仍写 true', JSON.stringify(dboOf(minimal)))
ok(dboOf(minimal).disable_physics_3d === true, 'minimal 里 3D 物理同样被显式关掉(表内伞项都要点名)', JSON.stringify(dboOf(minimal)))
ok(dboOf(minimal).module_webp_enabled === false, '反向模式下取消的模块显式写 false(不靠那个惰性键)', JSON.stringify(dboOf(minimal)))
// 合成形态:4.7.2 里表内模块默认全是 True(mono / text_server_fb 那两个默认 False 的没进面板表),
// 造一个"默认已 False 的表内模块"只为钉住"反向模式下每个表内模块都点名"这条。
const optsJpg = Object.assign({}, OPTS, { module_jpg_enabled: { exists: true, default: false } })
const minJpg = T.buildProfile(T.PRESETS.minimalSelection(optsJpg), optsJpg, { mode: 'default-off' })
ok(dboOf(minJpg).module_jpg_enabled === false, '反向模式下即使模块源码默认已 False 也显式点名(差值写法会漏掉它 → 红)', JSON.stringify(dboOf(minJpg)))
// 表外开关(4.7.2 里真实存在,但按策划书 §3 负范围不进面板)一个都不许写:
// 写出去就等于把 freetype/gdscript 这类"关掉即废模板"的项替用户关了。
// 注意 `vulkan`/`sdl` 是**表内**项(渲染与显示组),minimal 预设会把它们取消 —— 那是设计意图,
// 所以这里只能用功能表里确实没有的 flag:modules/gdscript、modules/freetype、
// modules/text_server_adv 三个模块目录 + SConstruct:184 threads + :201 xaudio2 + :265 disable_exceptions。
const OFF_TABLE = {
  module_gdscript_enabled: { exists: true, default: true },
  module_freetype_enabled: { exists: true, default: true },
  module_text_server_adv_enabled: { exists: true, default: true },
  threads: { exists: true, default: true },
  xaudio2: { exists: true, default: false },
  disable_exceptions: { exists: true, default: true }
}
const minimalFull = T.buildProfile(T.PRESETS.minimalSelection(Object.assign({}, OPTS, OFF_TABLE)), Object.assign({}, OPTS, OFF_TABLE), { mode: 'default-off' })
ok(Object.keys(dboOf(minimalFull)).every((k) => F.TPL_FEATURES.some((f) => F.flagsOf(f).includes(k)) || k === 'modules_enabled_by_default'),
   '反向模式只写功能表里的 flag + modules_enabled_by_default,表外开关(gdscript/freetype/threads…)一个都不写',
   JSON.stringify(Object.keys(dboOf(minimalFull))))
for (const k of Object.keys(OFF_TABLE)) {
  ok(!(k in dboOf(minimalFull)), `表外开关 ${k} 不因"面板没这一项"被写出去`, JSON.stringify(dboOf(minimalFull)))
}
// 反向模式下**保留**的模块必须显式写 true:modules_enabled_by_default 一旦被 T7 提到命令行
// (官方 CI 就是这么用的),不点名就会被整体关掉 —— 用户保留的模块凭空消失。
const keepOn = T.buildProfile(Object.assign(T.PRESETS.minimalSelection(OPTS), { fmtWebp: true }), OPTS, { mode: 'default-off' })
ok(dboOf(keepOn).module_webp_enabled === true, '反向模式下"保留"的模块即使源码默认已是 True 也显式写 true', JSON.stringify(dboOf(keepOn)))
ok(keepOn.written.indexOf('module_webp_enabled') !== -1, '显式点名同时进 written(供日志与 parity 对照)', JSON.stringify(keepOn.written))

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
// 勾上枚举项 → 写"开"的那个取值;取消 → 与默认相同不写
r = T.buildProfile(sel({ optPrecision: true }), withPrec)
ok(dboOf(r).precision === 'double', '勾上双精度 → 写 "double" 而不是 true', JSON.stringify(dboOf(r)))
r = T.buildProfile(sel({ optSize: true }), OPTS)
ok(dboOf(r).optimize === 'size', '勾上体积优先 → optimize 写 "size"', JSON.stringify(dboOf(r)))
ok(!('optimize' in T.buildProfile(sel({ optSize: false }), OPTS).json.disabled_build_options),
   '取消体积优先(默认就是 auto)→ 不写 optimize')

section('认不出的枚举默认 → 两个方向都不猜(宁缺勿错)')
// 合成形态:4.7.2 功能表里的三个枚举(lto/optimize/precision)都在 ENUM_VALUES 里,
// 这条造一个"字符串默认但表里没条目"的开关,只为钉住"宁缺勿错"那一支。
const unknownEnum = Object.assign({}, OPTS, { deprecated: { exists: true, default: 'yes' } })
ok(T.initialSelection(unknownEnum).optDeprecated === false, '表里没有条目的字符串默认 → 不打勾(启发式会打勾 → 红)')
ok(!('deprecated' in dboOf(T.buildProfile(sel({ optDeprecated: false }), unknownEnum))),
   '同一个未知枚举即使被取消也不写(写 true/false 是类型错误,写猜的字符串是编造)')

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
r = T.buildProfile({}, OPTS)
ok(Object.keys(dboOf(r)).length === 0, 'selection 为空 → profile 为空对象(拼错 id 不会写出 disable_3d=yes)', JSON.stringify(r.json))
ok(r.skipped.length === F.TPL_FEATURES.reduce((n, f) => n + F.flagsOf(f).length, 0),
   '缺勾选态的 flag 全部如实报在 skipped 里(带原因)', r.skipped.length)
ok(r.skipped.every((s) => /未提供|勾选态/.test(s.why)), 'skipped 的原因文案区分"未勾选"与"未探到"', JSON.stringify(r.skipped[0]))

section('预设的形状(T9 面板按 id 取用)')
const ids = F.TPL_FEATURES.map((f) => f.id)
ok(Object.keys(init).length === ids.length && ids.every((id) => id in init),
   'initialSelection 覆盖全部 55 项,一个不多一个不少', `${Object.keys(init).length} / ${ids.length}`)
ok(T.PRESETS.lite2dIds.every((id) => !!F.featureById(id)),
   'lite2dIds 里每个 id 都真实存在于功能表(写错 id 就红)', T.PRESETS.lite2dIds.filter((id) => !F.featureById(id)).join(','))
const lite = T.PRESETS.lite2d(OPTS)
ok(lite.sys3d === false && lite.accesskit === false, 'lite2d 取消 3D 伞项与无障碍', JSON.stringify([lite.sys3d, lite.accesskit]))
ok(lite.phys3d === true, 'lite2d 不替源码假设连带:3D 物理仍按探测默认打勾', JSON.stringify(lite.phys3d))
const liteJson = dboOf(T.buildProfile(lite, OPTS))
ok(liteJson.disable_3d === true && liteJson.accesskit === false && !('disable_physics_3d' in liteJson),
   'lite2d 生成的 profile 恰好两项:disable_3d=yes 与 accesskit=no', JSON.stringify(liteJson))
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
   'minimal 取消 deprecated/minizip/brotli(照官方 CI)且编译选项跟随探测默认', JSON.stringify([minSel.optDeprecated, minSel.optMinizip, minSel.optBrotli, minSel.optPrecision]))
const minReal = T.buildProfile(minSel, optsReal, { mode: 'default-off' })
ok(dboOf(minReal).minizip === false && dboOf(minReal).brotli === false && dboOf(minReal).deprecated === false,
   'minimal 生成的 profile 里那三项真的是 no(与官方 CI 的 deprecated=no minizip=no brotli=no 对齐)', JSON.stringify(dboOf(minReal)))
ok(dboOf(minReal).module_gltf_enabled === false && dboOf(minReal).vulkan === false,
   'minimal 把表内功能项全部显式点名(gltf 与 vulkan 都写 no —— 面板上看得见,不是悄悄关的)', JSON.stringify([dboOf(minReal).module_gltf_enabled, dboOf(minReal).vulkan]))
ok(F.TPL_FEATURES.every((f) => f.group === '编译选项' || minSel[f.id] === false), 'minimal 把功能项全部取消(面板上灰掉的除外)',
   F.TPL_FEATURES.filter((f) => f.group !== '编译选项' && minSel[f.id] !== false).map((f) => f.id).join(','))

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
  const realFull = T.buildProfile(realInit, realOpts)
  ok(realFull.written.length === 0 && Object.keys(dboOf(realFull)).length === 0,
     '真实 4.7.2 上"全默认勾选"生成空 profile —— 这条是整个设计的立身之本',
     JSON.stringify(dboOf(realFull)) + ' / written=' + JSON.stringify(realFull.written))
  ok(T.buildProfile(Object.assign({}, realInit, { sys3d: false, optPrecision: true, optSize: true }), realOpts).json.disabled_build_options.precision === 'double',
     '真实选项表上勾双精度得到 "double"(不是 true)')
} else {
  console.log(`\n(跳过真实源码核对:未找到 ${realSC})`)
}

console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
