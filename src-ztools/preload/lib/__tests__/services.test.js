// preload 服务面契约测试:window.services 与类型契约 Services 必须逐项一致。
//
// 为什么需要:渲染层访问宿主能力只有一条路 —— window.services(透传方法全部实现在
// src-ztools/preload/services.js),其类型契约在 src/types/services.ts。
// 两侧各有多少个方法**不在注释里写死**(写死的 47 早就过期了):下面第 1 节按实际键数打印。
//
// 演进说明:这份契约原先手写在 src/env.d.ts,与 services.js 各写一遍、靠本测试比对。
// 现在 services.js 用 `@type {import('../../src/types/services').Services}` 直接引用它,
// **编译器**已能强制契约方法一个不多一个不少(见 docs/optimization-plan.md 的 P0-2)。
// 这个测试因此从「唯一的护栏」变成「双保险」:
//   · 编译器管签名是否匹配(本测试看不见的那部分);
//   · 本测试管运行时对象真的有这些键(编译产物若被手改/降级打包,这里会立刻发现)。
//
// 解析对象已从 env.d.ts 改为 src/types/services.ts。
//
// 自编译模板的三个新契约方法(Task 8)带来的第二段职责:第 5–9 节测的是**合成与透传**,
// 对账 harness 本身管不着的那部分 ——
//   · `listTemplateFeatures` 的 present / defaultOn / cascadedBy 合成,与策划书 §5.2
//     那道「一个构建选项都没解析出来 → 拒绝进面板」的闸(Ruling #26);
//   · `validateTemplateConfig` 的 `mode` 是否真流到了第 3 条硬拦(Ruling #53),以及
//     `untestedSource` 由宿主算、不被渲染层同名键覆盖(护栏①);
//   · `buildTemplatePack` 的 `features` 是否整份转交给执行层;
//   · 第 9 节是两条**源码扫描**:Ruling #60(整份转发这个形状)与 Ruling #58(契约层不重算
//     `tested`)。它们在行为上观察不到,不扫形状就等于没测。
// 这些调用是 async,因此全文改成 `async function main()` + `main().catch(() => process.exit(1))`
// —— 本仓库主流形状(backup/templates/taskqueue/docs/exporter/http 六个 harness 同形)。
// 形状规则的意义:断言若写在 await 节内而汇总三行在文件末尾同步执行,那些断言既不计 PASS、
// 失败也不改退出码(台账 Ruling #25),那比没有测试更坏。汇总因此也在 main 里。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/services.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../../../..')
const SERVICES = path.resolve(ROOT, 'src-ztools/preload/services.js')
const DTS = path.resolve(ROOT, 'src/types/services.ts')

const tplprobe = require('../tplprobe.js')
const tplprofile = require('../tplprofile.js')
const tplfeatures = require('../tplfeatures.js')

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`)
  }
}
function section(t) {
  console.log(`\n=== ${t} ===`)
}

// ---------- 加载真实实现 ----------
// services.js 的写法是 window.services = {...}(不是 module.exports),且各领域模块
// 只在函数体内访问 window.ztools,所以给一个空 window 即可安全加载。
global.window = {}
require(SERVICES)
const implemented = window.services
const implKeys = Object.keys(implemented).sort()

// ---------- 解析手写声明 ----------
if (!fs.existsSync(DTS)) {
  console.error(`找不到类型声明: ${DTS}`)
  process.exit(2)
}
const dts = fs.readFileSync(DTS, 'utf-8')
const start = dts.indexOf('export interface Services {')
if (start < 0) {
  console.error('src/types/services.ts 中找不到 export interface Services')
  process.exit(2)
}
const end = dts.indexOf('\n}', start)
const block = dts.slice(start, end)
// 成员行形如「  currentPlatform(): ...」「  downloadAndInstall(」——恰两个空格缩进
const declaredKeys = [...block.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/gm)]
  .map((m) => m[1])
  .sort()

// ---------- 源码树夹具(真 node:fs;契约层调的是不带 deps 的 probeSource) ----------
// tplprobe 自己的 harness 走注入的假 fs,那份夹具不能复用在这里:契约里
// `probeTemplateSource(srcDir)` 只有一个入参,只能吃真树。
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-services-test-'))
/** @param {string} name @param {Record<string, string>} files @returns {string} 树根绝对路径 */
function makeTree(name, files) {
  const dir = path.join(WORK, name)
  for (const rel of Object.keys(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, files[rel], 'utf8')
  }
  return dir
}

// (a) 逐字复用 tplprobe.test.js:35-38 / :40-48 / :50-54 的夹具行 —— 那几行在该文件里已标明
//     摘自真实 SConstruct(:264 disable_3d、:199 d3d12、:190 deprecated、:202 accesskit、
//     :169-177 optimize 的多行 EnumVariable、:183 lto)。本文件不重复声明它们的行号出处,
//     出处只留在那一处,免得两处各写一遍长歪。
const SC_VERBATIM = [
  'opts.Add(BoolVariable("disable_3d", "Disable 3D nodes for a smaller executable", False))',
  'opts.Add(BoolVariable("d3d12", "Enable the Direct3D 12 rendering driver on supported platforms", False))',
  'opts.Add(BoolVariable("deprecated", "Enable compatibility code for deprecated and removed features", True))',
  'opts.Add(BoolVariable("accesskit", "Enable the AccessKit driver for screen reader support", True))',
  'opts.Add(',
  '    EnumVariable(',
  '        "optimize",',
  '        "Optimization level (by default inferred from \'target\' and \'dev_build\')",',
  '        "auto",',
  '        ["auto", "none", "custom", "debug", "speed", "speed_trace", "size", "size_extra"],',
  '        ignorecase=2,',
  '    )',
  ')',
  'opts.Add(',
  '    EnumVariable(',
  '        "lto", "Link-time optimization (production builds)", "none", ["none", "auto", "thin", "full"], ignorecase=2',
  '    )',
  ')'
].join('\n')

// (b) 合成形态,**不是**真实源码摘录:vulkan 与 precision 两格。
//     只有「键名 + 默认值」是承重的,两者逐字取自本仓库已登记的出处 ——
//       vulkan   : tplfeatures.js:32 注释「SConstruct:197 默认 True」
//       precision: tplprofile.js:75   注释「SConstruct:191-193 EnumVariable("precision", …, "single", ["single","double"])」
//     help 文案我核不到 4.7.2 原文,是自拟的;排版照上面已核过的多行 EnumVariable 形态。
//     precision 这一格是 Ruling #4 的命门:简报那段启发式对 default === 'single'
//     会判成「默认已开」→ 面板替用户打勾双精度。
const SC_SYNTH = [
  'opts.Add(BoolVariable("vulkan", "Enable the Vulkan rendering driver", True))',
  'opts.Add(',
  '    EnumVariable(',
  '        "precision",',
  '        "Precision of floating point values",',
  '        "single",',
  '        ["single", "double"],',
  '    )',
  ')'
].join('\n')

// (c) 连带块:逐字复用 tplprobe.test.js:201 的 C472(真实 4.7.2 SConstruct 的 disable_3d 块)。
const SC_CASCADE = 'if env["disable_3d"]:\n    env.Append(CPPDEFINES=["_3D_DISABLED"])\n    env["disable_navigation_3d"] = True\n    env["disable_physics_3d"] = True\n    env["disable_xr"] = True\nif env["disable_advanced_gui"]:\n    env.Append(CPPDEFINES=["ADVANCED_GUI_DISABLED"])\n'

// 逐字复用 tplprobe.test.js:223(真实 4.7.2 version.py:1-6)与 :232(真实 4.3-stable 同形)。
const VERSION_PY_472 = 'short_name = "godot"\nname = "Godot Engine"\nmajor = 4\nminor = 7\npatch = 2\nstatus = "stable"\n'
const VERSION_PY_43 = 'short_name = "godot"\nname = "Godot Engine"\nmajor = 4\nminor = 3\npatch = 0\nstatus = "stable"\n'

const SCONSTRUCT = `${SC_VERBATIM}\n${SC_SYNTH}\n${SC_CASCADE}`
/** 已实测版本(4.7.2-stable)的一棵最小树 */
const T472 = makeTree('godot-472', { 'SConstruct': SCONSTRUCT, 'version.py': VERSION_PY_472 })
/** 未实测版本(4.3-stable)的同形树:SConstruct 与上面同一份,只有 version.py 不同(只验版本支) */
const T43 = makeTree('godot-43', { 'SConstruct': SCONSTRUCT, 'version.py': VERSION_PY_43 })
/** 合成形态(台账 Ruling #26 要的那一支):源码根成立、但一个构建选项都解析不出来 */
const TEMPTY = makeTree('godot-empty', { 'SConstruct': '// 没有变量声明的一棵树(合成形态,只为「0 键」那支而存在)\n' })
/** 根本不是 Godot 源码根(缺 SConstruct) */
const TNOROOT = makeTree('not-a-godot-tree', { 'README.txt': 'x\n' })

/** @param {Array<{itemId?: string, flag?: string, why?: string}>} list @param {string} needle @returns {boolean} */
const hasWhy = (list, needle) => list.some((x) => String(x.why || '').includes(needle))

async function main() {
  section('1. 解析结果')
  ok(implKeys.length > 0, `services.js 导出 ${implKeys.length} 个方法`, String(implKeys.length))
  ok(declaredKeys.length > 0, `Services 契约声明 ${declaredKeys.length} 个方法`, String(declaredKeys.length))

  section('2. 实现与声明逐项一致')

  const implSet = new Set(implKeys)
  const declSet = new Set(declaredKeys)

  const missingImpl = declaredKeys.filter((k) => !implSet.has(k))
  ok(
    missingImpl.length === 0,
    'Services 契约声明的每个方法都有实现',
    missingImpl.length ? `缺少实现: ${missingImpl.join(', ')}` : ''
  )

  const missingDecl = implKeys.filter((k) => !declSet.has(k))
  ok(
    missingDecl.length === 0,
    'services.js 的每个方法都有类型声明',
    missingDecl.length ? `缺少声明(请补 src/types/services.ts 的 export interface Services): ${missingDecl.join(', ')}` : ''
  )

  ok(implKeys.length === declaredKeys.length, '两侧数量一致', `实现 ${implKeys.length} / 声明 ${declaredKeys.length}`)

  section('3. 导出值都是可调用方法')
  const notFn = implKeys.filter((k) => typeof implemented[k] !== 'function')
  ok(notFn.length === 0, 'window.services 的每个成员都是函数', notFn.join(', '))

  section('4. 平台能力可调用(冒烟)')
  ok(implemented.currentPlatform() === 'win64' || ['win64', 'macos', 'linux64'].includes(implemented.currentPlatform()), 'currentPlatform() 返回合法平台标识', implemented.currentPlatform())

  section('5. probeTemplateSource:契约只透传,不加判据')
  {
    const viaContract = await implemented.probeTemplateSource(T472)
    const direct = await tplprobe.probeSource(T472)
    ok(JSON.stringify(viaContract) === JSON.stringify(direct),
      '返回值逐字等于直接调探测层(契约层不改写、不过滤、不补产品语言)',
      JSON.stringify(viaContract).slice(0, 160))
    // 下面四条同时是**夹具守卫**:树没落对/解析没跑通时,第 6、7 节的判据会集体失去意义。
    ok(viaContract.ok === true && viaContract.sourceVersion === '4.7.2-stable' && viaContract.tested === true,
      '夹具守卫:这棵树探得出选项、版本是已实测的 4.7.2-stable', `${viaContract.ok}/${viaContract.sourceVersion}/${viaContract.tested}`)
    ok(viaContract.options.disable_3d && viaContract.options.disable_3d.exists === true && viaContract.options.disable_3d.default === false,
      '夹具守卫:disable_3d 存在且默认 False(OptionMap 的形状就是 {exists:true, default})', JSON.stringify(viaContract.options.disable_3d))
    ok(viaContract.options.precision && viaContract.options.precision.default === 'single',
      '夹具守卫:precision 的默认是枚举串 "single" 而不是布尔', JSON.stringify(viaContract.options.precision))
    ok(Array.isArray(viaContract.cascades.disable_3d) && viaContract.cascades.disable_3d.includes('disable_navigation_3d'),
      '夹具守卫:连带图探得到(disable_3d → disable_navigation_3d)', JSON.stringify(viaContract.cascades))

    const viaBad = await implemented.probeTemplateSource(TNOROOT)
    const directBad = await tplprobe.probeSource(TNOROOT)
    ok(viaBad.ok === false && viaBad.ok === directBad.ok && viaBad.error === directBad.error,
      '缺 SConstruct 时把探测层的 ok:false 与原句错误带回,不改写也不假成功', `${viaBad.ok}/${viaBad.error}`)
  }

  section('6. listTemplateFeatures:present / defaultOn / §5.2 那道闸')
  {
    const r = await implemented.listTemplateFeatures(T472)
    const probe = await tplprobe.probeSource(T472)
    ok(r.ok === true, '能探出选项的树 → ok:true', r.error)
    ok(Array.isArray(r.items) && r.items.length === tplfeatures.TPL_FEATURES.length,
      `项数与能力表一致(${tplfeatures.TPL_FEATURES.length} 项):不增项、不漏项`, String(r.items && r.items.length))

    const byId = {}
    for (const it of r.items || []) byId[it.id] = it
    const table = {}
    for (const f of tplfeatures.TPL_FEATURES) table[f.id] = f
    ok((r.items || []).every((it) => {
      const f = table[it.id]
      return !!f && it.label === f.label && it.group === f.group && it.desc === f.desc &&
        it.sizeImpact === f.sizeImpact && it.risk === f.risk && it.flags.join(',') === f.flags.join(',')
    }), '语义字段逐项透传(label/group/desc/sizeImpact/risk/flags 一个都不在合成时丢)',
      JSON.stringify((r.items || []).filter((it) => !table[it.id]).map((it) => it.id)))

    ok(byId.d3d12 && byId.d3d12.present === true,
      'present:源码声明了 d3d12 → 面板该项可用', JSON.stringify(byId.d3d12))
    ok(byId.fmtWebp && byId.fmtWebp.present === false,
      'present:这棵树里没有 modules/(webp) → 该项标 false,面板据此禁用而不是静默消失', JSON.stringify(byId.fmtWebp))

    // Ruling #4:defaultOn 走 tplprofile.initialSelection,不重写简报那段启发式。
    ok(byId.optPrecision && byId.optPrecision.present === true && byId.optPrecision.defaultOn === false,
      '★Ruling #4:precision 默认 "single" → 双精度这项**不**打勾(简报 :95-98 那段启发式在这里判反,会替用户加双精度)',
      JSON.stringify(byId.optPrecision))
    ok(byId.optLto && byId.optLto.defaultOn === false && byId.accesskit.defaultOn === true && byId.sys3d.defaultOn === true,
      '默认值的**方向**由探测层负责:lto="none" 不勾 / accesskit=True 勾 / disable_3d=False 取反后勾',
      JSON.stringify([byId.optLto, byId.accesskit, byId.sys3d].map((x) => x && x.defaultOn)))
    const sel = tplprofile.initialSelection(probe.options)
    ok((r.items || []).every((it) => it.defaultOn === sel[it.id]),
      'defaultOn 与 tplprofile.initialSelection(probe.options) 全表一致(不在契约里留第二套默认值判据)',
      JSON.stringify((r.items || []).filter((it) => it.defaultOn !== sel[it.id]).map((it) => [it.id, it.defaultOn, sel[it.id]])))

    ok(byId.nav3d && byId.nav3d.cascadedBy === 'disable_3d',
      'cascadedBy 来自这份源码自己探到的连带图', JSON.stringify(byId.nav3d))
    ok(byId.vulkan && !('cascadedBy' in byId.vulkan),
      '没探到连带就不给这个键(不内置"3D 关了会连带什么"的版本知识)', JSON.stringify(byId.vulkan))

    // Ruling #26:策划书 §5.2「解析不出任何声明 → 拒绝进面板」这道闸落在契约层。
    const rEmpty = await implemented.listTemplateFeatures(TEMPTY)
    ok(rEmpty.ok === false && rEmpty.error === '无法解析此版本源码的构建选项（源码结构可能已变）' && !rEmpty.items,
      '★Ruling #26:源码根成立但一个选项都没解析出来 → ok:false + 逐字文案,且**不给 items**(不给一张 69 项全灰的面板)',
      `${rEmpty.ok}/${rEmpty.error}`)
    const rNoRoot = await implemented.listTemplateFeatures(TNOROOT)
    ok(rNoRoot.ok === false && rNoRoot.error !== '无法解析此版本源码的构建选项（源码结构可能已变）' && !!rNoRoot.error,
      '两支闸分开走:缺 SConstruct 报探测层原句,不是那句「解析不出构建选项」(合并成一支就等于对两种成因给同一个建议)',
      `${rNoRoot.ok}/${rNoRoot.error}`)
  }

  section('7. validateTemplateConfig:mode 与 untestedSource 两条护栏')
  {
    const r = await implemented.validateTemplateConfig({ srcDir: T472, features: { vulkan: true }, mode: 'default-off' })
    ok(r && Array.isArray(r.issues) && Array.isArray(r.hardBlocks) && typeof r.ok === 'boolean',
      '返回形状是 { ok, issues, hardBlocks }(策划书 §5.7 旧账里的 problems/blocks 不是现行契约)',
      JSON.stringify(Object.keys(r || {})))
    // 互钉对第一半:反向白名单 + 一个模块都没点名保留 → 硬拦 3 必须响(mode 真流到了 validateSelection)。
    ok(r.hardBlocks.length > 0 && r.hardBlocks.some((x) => x.flag === 'modules_enabled_by_default') && r.ok === false,
      '★Ruling #53 互钉①:同一棵树带 mode:"default-off" → hardBlocks 非空(硬拦 3 真被触发,不是永不响的摆设)',
      JSON.stringify(r.hardBlocks))
    const rOn = await implemented.validateTemplateConfig({ srcDir: T472, features: { vulkan: true } })
    // 互钉对第二半:不传 mode → 同一棵树不该被反向白名单拦住(否则"永远返回空/永远非空"的退化实现都能绿)。
    ok(rOn.hardBlocks.length === 0 && rOn.ok === true,
      '★Ruling #53 互钉②:同一棵树**不传 mode** → hardBlocks 为空(default-on 下 modules_enabled_by_default 没发出去)',
      JSON.stringify(rOn.hardBlocks))

    // 护栏①:untestedSource 由宿主算,渲染层塞同名键覆盖不掉。
    const UNTESTED = '不在已实测表内'
    const rTested = await implemented.validateTemplateConfig({ srcDir: T472, features: { vulkan: true } })
    const rUntested = await implemented.validateTemplateConfig({ srcDir: T43, features: { vulkan: true } })
    ok(!hasWhy(rTested.issues, UNTESTED),
      '已实测版本(4.7.2-stable)的树 → 不出「版本未实测」这条', JSON.stringify(rTested.issues.map((x) => x.why)))
    ok(hasWhy(rUntested.issues, UNTESTED),
      '未实测版本(4.3-stable)的树 → 出这条(宿主自己按 version.py 算,不由渲染层申报)', JSON.stringify(rUntested.issues.map((x) => x.why)))
    const rForgedOn = await implemented.validateTemplateConfig({ srcDir: T472, features: { vulkan: true }, untestedSource: true })
    ok(!hasWhy(rForgedOn.issues, UNTESTED),
      '★护栏①:已实测树上渲染层硬塞 untestedSource:true 也不报(简报 :106 那种 Object.assign 顺序 —— ctx 赢 —— 在这里红)',
      JSON.stringify(rForgedOn.issues.map((x) => x.why)))
    const rForgedOff = await implemented.validateTemplateConfig({ srcDir: T43, features: { vulkan: true }, untestedSource: false })
    ok(hasWhy(rForgedOff.issues, UNTESTED),
      '★护栏①反向:未实测树上渲染层塞 untestedSource:false 也照样报(宿主那份最后落,两个方向的越权都钉住)',
      JSON.stringify(rForgedOff.issues.map((x) => x.why)))

    // 另两个顶层具名入参各自是一根线,漏一根就少一条软问题(编译器抓不到 JS 侧漏传)。
    const rSdk = await implemented.validateTemplateConfig({ srcDir: T472, features: { vulkan: true, d3d12: true }, d3d12SdkInstalled: false })
    ok(rSdk.issues.some((x) => x.itemId === 'd3d12'),
      'd3d12SdkInstalled 透传:勾着 d3d12 + 显式报「没装 SDK」→ 出这条软问题', JSON.stringify(rSdk.issues.map((x) => x.itemId)))
    const rSdkQuiet = await implemented.validateTemplateConfig({ srcDir: T472, features: { vulkan: true, d3d12: true } })
    ok(!rSdkQuiet.issues.some((x) => x.itemId === 'd3d12'),
      '同一份勾选不传该键 → 不报(未知不硬报,否则等于替用户的机器下结论)', JSON.stringify(rSdkQuiet.issues.map((x) => x.itemId)))
    const rAk = await implemented.validateTemplateConfig({ srcDir: T472, features: { vulkan: true, accesskit: true }, accesskitSdkInstalled: false })
    ok(rAk.issues.some((x) => x.itemId === 'accesskit'),
      'accesskitSdkInstalled 透传:勾着 accesskit + 显式报「没装依赖」→ 出这条软问题', JSON.stringify(rAk.issues.map((x) => x.itemId)))
    const rAkQuiet = await implemented.validateTemplateConfig({ srcDir: T472, features: { vulkan: true, accesskit: true } })
    ok(!rAkQuiet.issues.some((x) => x.itemId === 'accesskit'),
      '同一份勾选不传该键 → 不报', JSON.stringify(rAkQuiet.issues.map((x) => x.itemId)))
  }

  section('8. buildTemplatePack:features 是契约的必填项,必须整份转交执行层')
  {
    const noFeatures = implemented.buildTemplatePack({ srcDir: 'X:\\godot', tag: '4.7.2-stable' })
    ok(noFeatures.ok === false && noFeatures.error === '缺少功能勾选结果',
      '缺 features → 执行层同步拒绝(不落任务、不起进程)', JSON.stringify(noFeatures))
    const withFeatures = implemented.buildTemplatePack({ srcDir: 'X:\\godot', tag: '4.7.2-stable', features: { vulkan: true }, mode: 'default-off' })
    ok(withFeatures.ok === false && withFeatures.error === '请先完成工具链检测(向导第一步)',
      '带上 features → 越过那道闸、卡在下一闸(证明 params 是整份转交的,features 没在契约里被丢掉)',
      JSON.stringify(withFeatures))
  }

  section('9. 契约层不养第二个真源:两条源码扫描(行为断言看不见的那半边)')
  {
    // 这一节是**静态扫描**,因为这两件事在行为上观察不到:
    //   · Ruling #60 —— `mode` 进 buildTemplatePack 零断言:`buildtools.js` 的入队闸先拦 `features`,
    //     再拦工具链,mode 的差异在这一层根本不外漏;只能把「整份 params 转发」这个形状钉住。
    //     它防的是「有人把转发改成显式字段列表而漏掉 mode」→ 变成**校验用 default-off、编译用 default-on**,
    //     正是 services.ts:130 注释自己警告的那一形态。先例:T9 简报 :28 与垫片诚实性扫描都用源码正则。
    //   · Ruling #58 —— `untestedSource` 不许在契约层重算 `testedVersions.includes(sourceVersion)`
    //     (`tplprobe.js:270` 是同一个表达式的第二处推导;`tested` 的语义一改就静默用旧口径)。
    //     这条同样是等价重构,行为断言抓不到,所以钉形状。
    const srcJsRaw = fs.readFileSync(SERVICES, 'utf8')
    // 只扫**代码行**:这一节防的是"第二处推导",而解释为什么不再有它的那段注释里必然提到那个写法
    // (本仓的注释规矩如此)。不剥注释的话第一条反向扫描会被自己的注释命中 —— 那是假阳性,
    // 剥掉后代码里真把旧表达式改回去照样红。切法与 tauriShimHonesty.test.mjs:37 同一条。
    const srcJs = srcJsRaw.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')
    const forward = /buildTemplatePack:\s*\(params\)\s*=>\s*buildtools\.buildTemplatePack\(\s*params\s*\)/.exec(srcJs)
    ok(!!forward,
      '★Ruling #60:buildTemplatePack 是「整份 params 转发」的形状(改成显式字段列表就红,而漏掉 mode 在行为层看不见)',
      '没匹配到 `buildTemplatePack: (params) => buildtools.buildTemplatePack(params)`')
    ok(/const untestedSource = !probe\.tested\b/.test(srcJs),
      '★Ruling #58:untestedSource 直接读探测层算好的 `probe.tested`(判定只留 tplprobe.js 那一处)',
      JSON.stringify((srcJs.match(/const untestedSource = .*/) || ['<没找到>'])[0]))
    ok(!/testedVersions\s*\.\s*includes/.test(srcJs),
      '★Ruling #58 反向:契约层代码里不再出现 `testedVersions.includes(...)` 这种第二处推导(把旧表达式改回去就红)',
      JSON.stringify((srcJs.match(/.*testedVersions\s*\.\s*includes.*/) || ['<无>'])[0]))
  }

  // ---------- 结果 ----------
  console.log(`\n${'='.repeat(56)}`)
  console.log(`PASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log('  - ' + f)
    fs.rmSync(WORK, { recursive: true, force: true })
    process.exit(1)
  }
  console.log('全部通过')
  fs.rmSync(WORK, { recursive: true, force: true })
}

main().catch((e) => {
  console.error(e)
  fs.rmSync(WORK, { recursive: true, force: true })
  process.exit(1)
})
