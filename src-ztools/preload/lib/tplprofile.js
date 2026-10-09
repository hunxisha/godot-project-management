// 自编译模板 · 输出层:勾选 + 探测结果 → Godot 的 feature build profile。
//
// 为什么走 profile 文件而不是往命令行上拼(策划书 §2 决策 6):
//   · scons 那一行从此恒定,命令预览不随勾选线性变长;
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
// ================ 交给执行层(T7)的两条硬事实,都在这里记一次 =================
// (1) `modules_enabled_by_default` **在 profile 里是惰性的**:全树只有 SConstruct:476 读它,
//     而那一步在 :496 `opts.Update` 之前就把 57 个 `module_*_enabled` 的默认值算完了;
//     profile 到 :655 才开始赋值 —— 晚了。官方 CI 的 Minimal template
//     (linux_builds.yml:104-116)是把它放在**命令行 scons-flags** 上的,不是放 profile 里。
//     所以 default-off 模式生成的 profile 同时把每个**表内**模块显式写成 yes/no
//     (见下面 desiredValue 那条),这样不靠那个键也能成立;而 T7 若要真把未列进功能表的模块
//     (betsy / jsonrpc / raycast / gdscript / freetype …)一起关掉,必须把这个键提到命令行去,
//     不能只在 profile 里写一遍就当它生效 —— 反过来,那些表外模块本层**绝不代写**,
//     因为 gdscript/freetype/text_server_adv 关掉就是废模板(策划书 §3 负范围补条)。
// (2) `production=yes` 会把 `lto` 重新按 **ARGUMENTS**(不是 env)取一次(SConstruct:674-680),
//     所以同一份 profile 里 `production` 与 `lto` 同时出现时,后者的 lto 会被覆盖成 auto。
//     这是 T6 静态校验该拦的组合,本层不拦(拦了就把探测事实藏起来了)。
const { TPL_FEATURES, flagsOf } = require('./tplfeatures.js')

/** @typedef {Record<string, {exists: true, default: boolean|string}>} OptionMap */

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
 * 而源码默认根本没开双精度。方向还是**多勾**,用户不动它就给产物加了双精度。
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
 * @param {OptionMap} options
 * @returns {Record<string, boolean>}
 */
function initialSelection(options) {
  /** @type {Record<string, boolean>} */
  const sel = {}
  for (const f of TPL_FEATURES) {
    sel[f.id] = f.flags.length > 0 && f.flags.every((k) => featureKeptByDefault(k, options[k]))
  }
  return sel
}

/**
 * 勾选 → profile 对象。
 * @param {Record<string, boolean>} selection 面板勾选(id → 是否保留)
 * @param {OptionMap} options 探测结果(tplprobe.js probeSource().options)
 * @param {{mode?: 'default-on'|'default-off'}} [opts] default-off = 最小可跑那种反向白名单
 * @returns {{json: {disabled_build_options: Record<string, boolean|string>}, written: string[], skipped: {flag: string, why: string}[]}}
 */
function buildProfile(selection, options, opts) {
  const mode = (opts && opts.mode) || 'default-on'
  const sel = selection || {}
  const srcOpts = options || {}
  /** @type {Record<string, boolean|string>} */
  const dbo = {}
  /** @type {string[]} */
  const written = []
  /** @type {{flag: string, why: string}[]} */
  const skipped = []

  if (mode === 'default-off') {
    // 反向白名单:先声明"模块默认全关",再把保留着的模块显式打开。
    // 逐字照官方 CI 的 Minimal template(linux_builds.yml:104-116),不自己凑。
    // 注意本键在 profile 内是惰性的(见文件头第 (1) 条),所以模块开关一律同时显式写。
    dbo.modules_enabled_by_default = false
    written.push('modules_enabled_by_default')
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

  return { json: { disabled_build_options: sortKeys(dbo) }, written: written.sort(), skipped }
}

/**
 * 该 flag 在"用户想保留/取消这个功能"下应该取的值;与源码默认相同则 SAME_AS_SOURCE(不输出)。
 * 命名约定决定方向:`disable_*` 为真 = 功能关闭;`module_*_enabled` 与裸名(vulkan/accesskit…)
 * 为真 = 功能开启。枚举型(lto/optimize/precision)按各自的取值表处理。
 * @param {string} flag @param {boolean|string} sourceDefault @param {boolean} keep @param {'default-on'|'default-off'} mode
 * @returns {boolean|string|symbol}
 */
function desiredValue(flag, sourceDefault, keep, mode) {
  if (mode === 'default-off' && isModuleFlag(flag)) {
    // 反向模式的核心就是"白名单要逐条显式点名":保留的模块必须写 yes、取消的必须写 no,
    // 不能因为"源码里它本来就 True"而省略 —— 省略的那一条在 modules_enabled_by_default
    // 被提到命令行时会被整体关掉,等于用户保留的模块凭空消失。
    return keep
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
 * 三个预设(策划书 §5.4b)。
 * full = 全部回到源码默认;lite2d = 附录实测那组(**不含** d3d12,它是空操作);
 * minimal = 逐字照官方 CI 的 Minimal template。
 */
const PRESETS = {
  /** @param {OptionMap} options @returns {Record<string, boolean>} */
  full(options) { return initialSelection(options) },
  /** lite2d 要动的面板项 id(给 T9 面板与测试对照用,写错 id 会被测试抓到) */
  lite2dIds: ['sys3d', 'phys3d', 'nav3d', 'xr', 'accesskit'],
  /** 取消 3D 伞项 + 取消无障碍;那三项是否连带由探测结果决定,本函数不假设
   * @param {OptionMap} options @returns {Record<string, boolean>} */
  lite2d(options) {
    const sel = initialSelection(options)
    sel.sys3d = false
    sel.accesskit = false
    return sel
  },
  /** @param {OptionMap} options @returns {Record<string, boolean>} */
  minimalSelection(options) {
    const sel = initialSelection(options)
    for (const f of TPL_FEATURES) if (f.group !== '编译选项') sel[f.id] = false
    sel.optDeprecated = false
    sel.optMinizip = false
    sel.optBrotli = false
    return sel
  }
}

module.exports = { initialSelection, buildProfile, profileText, PRESETS, ENUM_VALUES }
