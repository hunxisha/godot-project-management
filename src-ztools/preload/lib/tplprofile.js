// 自编译模板 · 输出层:勾选 + 探测结果 → Godot 的 feature build profile。
//
// 为什么走 profile 文件而不是往命令行上拼(策划书 §2 决策 6):
//   · 命令预览不随勾选线性变长 —— 但"那一行恒定"要按 Ruling #32 改成**只随预设模式变**:
//     default-on(全量 / 2D 轻量)那两套一个额外 token 都不发,default-off 多发 `commandExtras`
//     里那一条(它在 profile 里不生效,见文件头第 (1) 条);
//   · 渲染层交的是勾选状态,参数由本文件查表生成 —— `buildtools.js:18-19` 那条
//     "不接受渲染层传命令串"的红线原样守住;
//   · 生成的 JSON 能整份存进模板库记录,"当时编了什么"可回查。
// 生效时机已核实:profile 在 SConstruct:655-658 落到 env(`for c in dbo: env[c] = dbo[c]`),
// 而模块开关到 :1112-1113 `if not env[f"module_{name}_enabled"]: continue` 才被消费。
//
// **纯函数**:不做 IO、不 require node:fs。输入是 tplprobe.js 的 OptionMap,输出是 JSON 对象。
//
// 唯一的输出规则:**用户选择 ≠ 探测到的源码默认值时才写**。
// 反面教材见策划书 §5.3 —— 无脑全选还照"保留=输出"去拼,会得到一个带调试符号、
// 开着 d3d12 与 xaudio2 的"全量"模板,既不是官方等价物也把省体积反着做了一遍。
//
// ================ 交给执行层(T7)与校验层(T6)的四条硬事实,都在这里记一次 =================
// (1) `modules_enabled_by_default` **在 profile 里是惰性的**:全树只有 `SConstruct:282` 声明、
//     `:476` 读取(`if env["modules_enabled_by_default"]:` 决定模块默认开还是关),而那一步在
//     `:496 opts.Update` 之前就把 57 个 `module_*_enabled` 的默认值算完了;profile 到 `:655-658`
//     才开始 `env[c] = dbo[c]` —— 晚一百多行,写进去是 no-op。官方 CI 同一条也写在**命令行
//     scons-flags** 上(`linux_builds.yml:108`),不在任何 profile 里。
//     → 这类键由本层交进返回值 `commandExtras`(见 COMMAND_ONLY_FLAGS),**不再写进 profile**:
//       留一个不生效的键在归档 profile 里,会让后来人误以为它靠 profile 生效(Ruling #32/#35)。
//       T7 负责把该数组附到 scons 行尾;"那一行恒定"的承诺因此改成"只随预设模式变、不随勾选组合变"。
// (2) 反向白名单下**保留的模块必须显式点名 `true`**:没被点名的在 modules_enabled_by_default=no 之下
//     整体关闭(`SConstruct:1112-1113` 只认显式值)。没保留的模块则与"有效默认(关)"相同 → 按差值规则
//     不写。官方 CI 那句 `module_text_server_fb_enabled=no`(`linux_builds.yml:109`)就是这种冗余防御:
//     它自己的 `is_enabled()` 返回 False(`modules/text_server_fb/config.py:9-11`),硬发反而违反
//     "与默认相同就不输出"(Ruling #36)。
// (3) `production=yes` 会把 `use_static_cpp` / `debug_symbols` 按 `get_cmdline_bool` 重设、把 `lto`
//     按 **ARGUMENTS**(不是 env)重设(`SConstruct:674-680`,在 :658 之后),所以同一份 profile 里
//     这些键与 `production` 并存时会被覆盖。本层不拦(拦了就把探测事实藏起来了)→ 交 T6 静态校验。
// (4) **已核实、待裁定的两条同类事实**:全树只在 :658 之前被读完、因此写进 profile 同样不生效的还有
//     `deprecated`(唯一读点 `SConstruct:593`,决定 `DISABLE_DEPRECATED` 宏)与 `precision`(`:596` 定
//     `REAL_T_IS_DOUBLE` 宏;`:1043` 在 profile 之后但只用来加 `.double` 文件名后缀)。
//     当前代码按 Ruling #36 的字面口径**仍把 `deprecated` 写进 profile**(minimal 的键集合要与官方那 9 条
//     逐字对齐),也就是 4.7.2 上那份 `deprecated:false` 只是归档记录、不改变产物。要不要把它(以及
//     `precision`)一并挪进 COMMAND_ONLY_FLAGS 属规格级改动,已在 T5 修复轮 1 上报等裁定;挪之前 T6
//     应当先出一条静态校验,别让用户以为关掉了兼容层。
//     表外开关(gdscript / freetype / text_server_adv / threads / xaudio2 / disable_exceptions …)本层
//     **绝不代写** —— 面板没有它们,替用户关就是废模板(策划书 §3 负范围补条)。
const { TPL_FEATURES, flagsOf } = require('./tplfeatures.js')

/** @typedef {Record<string, {exists: true, default: boolean|string}>} OptionMap */
/** @typedef {'default-on'|'default-off'} ProfileMode */

/** 与源码默认相同时用的哨兵:调用方据此决定"这个 flag 不写进 profile"。 */
const SAME_AS_SOURCE = Symbol('same')

/**
 * 枚举型开关的"开 / 关"各自取什么值。
 * `off` 必须逐字等于该 EnumVariable 在 4.7.2 里的默认值 —— 打勾态与差值都只跟 `off` 比,
 * 写错了就等于给一份没改过默认值的源码硬加一个参数。认不出的枚举宁可不写也不猜。
 * @type {Record<string, { on: string, off: string }>}
 */
const ENUM_VALUES = {
  lto: { on: 'auto', off: 'none' }, // SConstruct:180-183 EnumVariable("lto", …, "none", ["none","auto","thin","full"])
  optimize: { on: 'size', off: 'auto' }, // SConstruct:170-176 EnumVariable("optimize", …, "auto", […,"speed","size","size_extra"])
  precision: { on: 'double', off: 'single' } // SConstruct:191-193 EnumVariable("precision", …, "single", ["single","double"])
}

/**
 * 必须上命令行的键 —— profile 到 `SConstruct:655-658` 才赋值,而这些键在那之前就读完了,
 * 写进 profile 是静默 no-op(见文件头第 (1) 条)。`buildProfile` 把命中的条目生成 `commandExtras`,
 * 由 T7 附到 scons 行尾;这些键**只走这条路**,不留进 profile(Ruling #32/#35)。
 * 顺序即数组顺序:与本表声明序一致,与勾选顺序无关,所以是稳定输出。
 * @type {{flag: string, value: boolean|string, mode?: ProfileMode}[]}
 */
const COMMAND_ONLY_FLAGS = [
  // SConstruct:282 声明 / :476 唯一读点,都在 profile 落 env 之前;官方 CI 放在命令行(linux_builds.yml:108)。
  // 只有反向白名单模式需要它:default-on 那两套预设不动模块默认,发这个键会整体关掉模块。
  { flag: 'modules_enabled_by_default', value: false, mode: 'default-off' }
]

/** @param {string} flag @param {boolean|string} value @returns {string} scons 命令行 token(布尔用 yes/no,枚举串原样) */
function sconsToken(flag, value) {
  if (value === true) return `${flag}=yes`
  if (value === false) return `${flag}=no`
  return `${flag}=${value}`
}

/** @param {string} flag @returns {boolean} 该 flag 的"值为真"是不是"功能被关闭"(disable_* 系列) */
function isNegatedFlag(flag) {
  return /^disable_/.test(flag)
}

/** @param {string} flag @returns {boolean} 模块开关(`module_<目录名>_enabled`,methods.py:258 + SConstruct:485) */
function isModuleFlag(flag) {
  return /^module_.*_enabled$/.test(flag)
}

/**
 * 该 flag **探测到的默认值**本身算不算"开"。
 * 布尔默认直接比;字符串默认必须查 ENUM_VALUES,只有 `default !== off` 才算开;
 * 未探到 / 字符串默认而表里没有条目 → 返回 `null` 表示**未知**,由调用方决定怎么不猜。
 * (三态而不是"未知就当 false":判据只留这一处。写成两处守卫的话,后一处永远够不着,
 *  变异自检里它是一条抓不到的死分支 —— 本项目已经栽过 6 条恒真断言,不再造新的。)
 *
 * 为什么不能用"字符串 ≠ none/auto"这种通用启发式:`precision` 的真实默认是 `"single"`
 * (SConstruct:192),它既不是 none 也不是 auto,启发式会把"双精度浮点"显示成已勾选 ——
 * 而源码默认根本没开双精度。方向是**多勾**,用户不动它就给产物加了双精度。
 * @param {string} flag
 * @param {{exists: true, default: boolean|string}|undefined} o
 * @returns {boolean|null} true=开 / false=关 / null=未知
 */
function isOnByDefault(flag, o) {
  if (!o || !o.exists) return null
  if (typeof o.default === 'string') {
    const t = ENUM_VALUES[flag]
    if (!t) return null // 认不出的枚举:不知道哪个取值算"开"
    return o.default !== t.off
  }
  return o.default === true
}

/**
 * 探测到的默认值下,**面板上这一项**该不该是勾着的。与 isOnByDefault 的差别只在方向:
 * `disable_3d` 默认 False 意味着 3D 功能是开着的,所以取反。
 * 未知(未探到 / 认不出的枚举)在两个方向上都返回 false —— 不猜。
 * @param {string} flag @param {{exists: true, default: boolean|string}|undefined} o @returns {boolean}
 */
function featureKeptByDefault(flag, o) {
  const st = isOnByDefault(flag, o)
  if (st === null) return false
  return isNegatedFlag(flag) ? !st : st
}

/**
 * 已探测到的选项表 → 面板初始勾选态。
 * 规则:flag 的源码默认值决定该项开还是关。一项多 flag 时全部 flag 都"默认为开"才打勾。
 * 探测里没有的 flag 按"未勾选"处理(不猜),由调用方在面板上标灰。
 * **整个 options 缺失(undefined)与"什么都没探到"同形** —— 全部不打勾、不抛(测试「入参整体缺失
 * 的契约」那一节钉着;面板拿到空探测表也不会显示成满勾,与 buildProfile 的两个兜底是同一条)。
 * @param {OptionMap} options
 * @returns {Record<string, boolean>}
 */
function initialSelection(options) {
  /** @type {Record<string, boolean>} */
  const sel = {}
  const srcOpts = options || {}
  for (const f of TPL_FEATURES) {
    sel[f.id] = f.flags.length > 0 && f.flags.every((k) => featureKeptByDefault(k, srcOpts[k]))
  }
  return sel
}

/**
 * 勾选 → profile 对象。
 * @param {Record<string, boolean>} selection 面板勾选(id → 是否保留);缺整个对象按"什么都没勾"处理,不猜
 * @param {OptionMap} options 探测结果(tplprobe.js probeSource().options);缺整个对象按"什么都没探到"处理
 * @param {{mode?: ProfileMode}} [opts] default-off = 最小可跑那种反向白名单
 * @returns {{json: {disabled_build_options: Record<string, boolean|string>}, written: string[], skipped: {flag: string, why: string}[], commandExtras: string[]}}
 */
function buildProfile(selection, options, opts) {
  const mode = /** @type {ProfileMode} */ ((opts && opts.mode) || 'default-on')
  const sel = selection || {}
  const srcOpts = options || {}
  /** @type {Record<string, boolean|string>} */
  const dbo = {}
  /** @type {string[]} */
  const written = []
  /** @type {{flag: string, why: string}[]} */
  const skipped = []
  // 必须上命令行的键(文件头第 (1) 条)。不写进 dbo:profile 里那份是不生效的归档(Ruling #35)。
  /** @type {string[]} */
  const commandExtras = []
  for (const k of COMMAND_ONLY_FLAGS) {
    if (k.mode && k.mode !== mode) continue
    commandExtras.push(sconsToken(k.flag, k.value))
  }

  for (const f of TPL_FEATURES) {
    if (!(f.id in sel)) {
      // 面板没给这一项的勾选态:按源码默认不写任何东西(宁缺勿错),而不是当成"用户取消了它"
      // —— 后者会让一个拼错的 id 直接把 disable_3d=yes 写进 profile,方向是多删不是多留。
      for (const flag of flagsOf(f)) skipped.push({ flag, why: `面板未提供 ${f.id} 的勾选态,按源码默认不写(宁缺勿错)` })
      continue
    }
    const keep = !!sel[f.id]
    for (const flag of flagsOf(f)) {
      const o = srcOpts[flag]
      if (!o || !o.exists) {
        skipped.push({ flag, why: '此版本源码未探到该开关,不写进 profile(未声明的 scons 变量是静默失效的)' })
        continue
      }
      const want = desiredValue(flag, o.default, keep, mode)
      if (want === SAME_AS_SOURCE) continue
      dbo[flag] = /** @type {boolean|string} */ (want)
      written.push(flag)
    }
  }

  return { json: { disabled_build_options: sortKeys(dbo) }, written: written.sort(), skipped, commandExtras }
}

/**
 * 该 flag 在"用户想保留/取消这个功能"下应该取的值;与(有效)源码默认相同则 SAME_AS_SOURCE(不输出)。
 * 命名约定决定方向:`disable_*` 为真 = 功能关闭;`module_*_enabled` 与裸名(vulkan/accesskit…)
 * 为真 = 功能开启。枚举型(lto/optimize/precision)按各自的取值表处理,**与模式无关** ——
 * 写成布尔会被 scons 直接拒(EnumVariable 只认取值表里的字符串)。
 * @param {string} flag @param {boolean|string} sourceDefault @param {boolean} keep @param {ProfileMode} mode
 * @returns {boolean|string|symbol}
 */
function desiredValue(flag, sourceDefault, keep, mode) {
  if (mode === 'default-off' && isModuleFlag(flag)) {
    // 反向白名单已经让"模块默认 = 关",所以这里比的是**有效默认**而不是探测到的默认:
    //   保留 → 必须显式点名 true(不点名的被 modules_enabled_by_default 整体关掉,用户功能凭空消失);
    //   没保留 → 与有效默认相同 → 不写(官方那句 module_text_server_fb_enabled=no 属冗余防御,
    //   照抄就等于违反"与默认相同就不输出",Ruling #36)。
    return keep ? true : SAME_AS_SOURCE
  }
  const onValue = isNegatedFlag(flag) ? !keep : keep
  if (typeof sourceDefault === 'string') return enumValue(flag, sourceDefault, onValue)
  return onValue === !!sourceDefault ? SAME_AS_SOURCE : onValue
}

/**
 * @param {string} flag @param {string} sourceDefault @param {boolean} on
 * @returns {string|symbol} 表里没有的枚举返回 SAME_AS_SOURCE(不写),两个方向都不猜。
 */
function enumValue(flag, sourceDefault, on) {
  const t = ENUM_VALUES[flag]
  if (!t) return SAME_AS_SOURCE
  const want = on ? t.on : t.off
  return want === sourceDefault ? SAME_AS_SOURCE : want
}

/**
 * 键按字典序重排。Rust 双端要拿 profileText 逐字节对照,插入顺序随勾选顺序变就一定对不上。
 * @param {Record<string, any>} obj @returns {Record<string, any>}
 */
function sortKeys(obj) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out
}

/** @param {object} json @returns {string} 稳定文本(缩进固定 + 键已排序) */
function profileText(json) {
  return JSON.stringify(json, null, 2)
}

/**
 * 把指定面板项取消,其余项保持 initialSelection 的结果。
 * id 不在功能表里就**跳过**(不写进结果):写一个无人消费的键会让 T9 面板按表渲染时看不出
 * 预设少关了一项,而测试对"预设实际动了哪些项"的核对会直接把这种漂移照出来。
 * @param {OptionMap} options @param {string[]} ids @returns {Record<string, boolean>}
 */
function selectionTurningOff(options, ids) {
  const sel = initialSelection(options)
  for (const id of ids) if (id in sel) sel[id] = false
  return sel
}

/**
 * lite2d(附录实测那组)真正取消的面板项 id。**与 lite2d() 同一份常量** —— 分叉当场红
 * (测试拿 lite2d() 与 initialSelection() 的差集反向核对这份名单)。
 * 不含 phys3d / nav3d / xr:那三项是否连带由探测层的 cascades 表达,预设不替源码假设。
 * 不含 d3d12:源码默认就是 False,关它是空操作(策划书 §5.3 反面教材)。
 * @type {string[]}
 */
const LITE2D_OFF_IDS = ['sys3d', 'accesskit']

/**
 * minimal(官方 CI 的 Minimal template)真正取消的面板项,逐条对齐 `linux_builds.yml:110-116`
 * 那 7 条 scons-flags(`id` ↔ 官方 `flag` 成对写死,所以"改了一条却动了另一项"这种漂移能被照出来)。
 * 官方 9 条里另外两条的处理:
 *   · `modules_enabled_by_default=no`(:108)走 `commandExtras`,profile 里那份不生效(Ruling #32/#35);
 *   · `module_text_server_fb_enabled=no`(:109)不发,它默认就是 False(Ruling #36)。
 * **渲染与输入驱动(vulkan / opengl3 / angle / sdl / accesskit)一条都不碰** —— 官方那 9 条里没有它们,
 * 关驱动交给策划书 §5.5 的硬拦,不在预设里替用户关。
 * @type {{id: string, flag: string, ciLine: string}[]}
 */
const MINIMAL_OFF = [
  { id: 'sys3d', flag: 'disable_3d', ciLine: 'linux_builds.yml:110' },
  { id: 'advGui', flag: 'disable_advanced_gui', ciLine: 'linux_builds.yml:111' },
  { id: 'phys2d', flag: 'disable_physics_2d', ciLine: 'linux_builds.yml:112' },
  { id: 'phys3d', flag: 'disable_physics_3d', ciLine: 'linux_builds.yml:113' },
  { id: 'optDeprecated', flag: 'deprecated', ciLine: 'linux_builds.yml:114' },
  { id: 'optMinizip', flag: 'minizip', ciLine: 'linux_builds.yml:115' },
  { id: 'optBrotli', flag: 'brotli', ciLine: 'linux_builds.yml:116' }
]

/**
 * 三个预设(策划书 §5.4b)。
 * full = 全部回到源码默认;lite2d = 附录实测那组(只动 LITE2D_OFF_IDS 那两项);
 * minimal = 键集合逐条对齐官方 CI 的 Minimal template(见 MINIMAL_OFF 与文件头第 (1)(2) 条),
 * 表内其余项一律保持源码默认 —— 不关渲染驱动,不关表外模块。
 */
const PRESETS = {
  /** @param {OptionMap} options @returns {Record<string, boolean>} */
  full(options) { return initialSelection(options) },
  lite2dIds: LITE2D_OFF_IDS,
  /** @param {OptionMap} options @returns {Record<string, boolean>} */
  lite2d(options) { return selectionTurningOff(options, LITE2D_OFF_IDS) },
  /** minimal 取消的面板项 id(由 MINIMAL_OFF 派生,与 minimalSelection() 同一份真源) */
  minimalIds: MINIMAL_OFF.map((x) => x.id),
  /** @param {OptionMap} options @returns {Record<string, boolean>} */
  minimalSelection(options) { return selectionTurningOff(options, MINIMAL_OFF.map((x) => x.id)) }
}

module.exports = { initialSelection, buildProfile, profileText, PRESETS, ENUM_VALUES }
