// 自编译模板 · 输出层:勾选 + 探测结果 → Godot 的 feature build profile + scons 命令行键。
//
// 为什么走 profile 文件而不是整行都往命令行上拼(策划书 §2 决策 6):
//   · 面板上看得见的是 46 个模块开关,它们进 profile 后命令预览不随模块勾选线性变长;
//     核心 flag 按 Ruling #38 走命令行,**token 数随勾选变化** —— 上一轮"那一行只随预设模式变"的
//     承诺已作废,T10 的命令预览要按"本层查表生成"来写,不是按"恒定一行"来写;
//   · 渲染层交的是勾选状态,两个通道的参数都由本文件查表生成 —— `buildtools.js:18-19` 那条
//     "不接受渲染层传命令串"的红线原样守住;
//   · 生成的 JSON 能整份存进模板库记录,"当时编了什么"可回查(profile 键 + 命令行键都在返回值里)。
// 生效时机已核实:profile 在 `SConstruct:655-658` 落到 env(`for c in dbo: env[c] = dbo[c]`),
// 而模块开关到 `:1112-1113` `if not env[f"module_{name}_enabled"]: continue` 才被消费。
//
// **纯函数**:不做 IO、不 require node:fs。输入是 tplprobe.js 的 OptionMap,输出是 JSON 对象。
//
// 唯一的输出规则:**用户选择 ≠ 探测到的源码默认值时才写** —— 对两个通道都成立。
// 反面教材见策划书 §5.3 —— 无脑全选还照"保留=输出"去拼,会得到一个带调试符号、
// 开着 d3d12 与 xaudio2 的"全量"模板,既不是官方等价物也把省体积反着做了一遍。
//
// ================ 交给执行层(T7)与校验层(T6)的四条硬事实,都在这里记一次 =================
// (1) **通道划分只认前缀,不认行号白名单(Ruling #38)**:flag 名是 `module_*` 的写进 profile
//     (`disabled_build_options`),**其余一切 flag 一律发进 `commandExtras`**(scons 命令行 token)。
//     为什么不维护"谁在 `:655` 之后被读"那张表:
//       · profile 到 `SConstruct:655-658` 才 `env[c] = dbo[c]`,在那之前被读完的键写进 profile 是
//         **静默 no-op**。控制器把 23 个核心 flag 的首个读取点全核了一遍,结论是"早于 655 的"有
//         **一整类 13 个**(use_static_cpp / modules_enabled_by_default / accesskit / vulkan / sdl /
//         d3d12 / opengl3 / optimize / angle / debug_symbols / lto / deprecated / precision),
//         **四个渲染驱动全在这一类里** —— 不是上一轮以为的三个孤例;
//       · 这张表要随 Godot 版本维护,而漂移的表现是**不报错地不生效**(见本仓库 §9.11 与 §10.4:
//         控制器给的行号里有 8 个其实出自 `platform/windows/detect.py`,那些读取点在
//         `SConstruct:701 detect.configure(env)` 里跑、其实晚于 :658 —— 恰好证明按行号判断容易出错);
//       · 命令行参数在 `SConstruct:440` / `:499` 的 `opts.Update(env, {**ARGUMENTS, …})` 就落进 env,
//         **早于所有读取点**,对任何消费时机都正确 —— 所以"拿不准的键一律走命令行"永远是安全侧;
//       · 按前缀切是一条**可机械检查**的规则:本文件测试里有两条遍历性断言(
//         「profile 里不得出现非 `module_*` 键」+「commandExtras 里不得出现 `module_*` 键」)钉着它。
//     `modules_enabled_by_default` 因此只是这条规则的一个普通成员(它不是 `module_*`,且
//     `SConstruct:476` 确实在 profile 之前读 —— 上一轮为它单独设的 COMMAND_ONLY_FLAGS 白名单已删,
//     它现在由"预设模式"这条来源进命令行,见 MODE_COMMAND_FLAGS)。
//     → T7 负责把 `commandExtras` 附到 scons 行尾;这些键**只走这条路**,不留进 profile。
// (2) 反向白名单下**保留的模块必须显式点名 `true`**:没被点名的在 modules_enabled_by_default=no 之下
//     整体关闭(`SConstruct:1112-1113` 只认显式值)。没保留的模块则与"有效默认(关)"相同 → 按差值规则
//     不写。官方 CI 那句 `module_text_server_fb_enabled=no`(`linux_builds.yml:109`)就是这种冗余防御:
//     它自己的 `is_enabled()` 返回 False(`modules/text_server_fb/config.py:9-11`),硬发反而违反
//     "与默认相同就不输出"(Ruling #36)。
// (3) `production=yes` 会把 `use_static_cpp` / `debug_symbols` 按 `methods.get_cmdline_bool`(它读
//     **ARGUMENTS**,`methods.py:225-233`)重设、把 `lto` 按 `ARGUMENTS.get("lto","auto")` 重设
//     (`SConstruct:674-680`,在 :658 之后)。上一轮这是"profile 里的值被覆盖回默认"的隐患;
//     **#38 把这四个键都搬到命令行之后 ARGUMENTS 里就有用户那一条 → 重设取到的正是所选值,隐患消除**。
//     仍然留给 T6 一条交叉校验:若哪天 profile 里同时出现 `production` 与这三键,那才是真冲突
//     (#38 之后本层不会再产出这种形态)。
// (4) **#38 之后不再有"profile 里不生效"的键**,所以上一轮登记的那两条(
//     `deprecated` 唯一读点 `SConstruct:593`、`precision` 宏读点 `:596`,都早于 :658,写进 profile
//     只是归档记录)自动消解:两个键现在都发命令行,`deprecated=no` / `precision=double` 真改产物。
//     上一轮交给 T6 的那条"profile 里出现 deprecated/precision 要提示"的软校验**不再需要**,
//     换成一条更硬的:静态校验层若看到 profile 里出现非 `module_*` 键,应当直接判错(本层已保证不会,
//     那是交叉防线)。
//     表外开关(gdscript / freetype / text_server_adv / threads / xaudio2 / disable_exceptions …)本层
//     **绝不代写** —— 面板没有它们,替用户关就是废模板(策划书 §3 负范围补条)。
const { TPL_FEATURES, flagsOf, featureById } = require('./tplfeatures.js')

/** @typedef {Record<string, {exists: true, default: boolean|string}>} OptionMap */
/** @typedef {'default-on'|'default-off'} ProfileMode */

/** 与源码默认相同时用的哨兵:调用方据此决定"这个 flag 两个通道都不输出"。 */
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
 * 由**预设模式**追加、不由面板勾选项派生的命令行键 —— `modules_enabled_by_default` 在功能表里没有
 * 对应项(它是"模块默认开还是关"的总闸,不是一个功能),所以不能靠 Ruling #38 的前缀判定从勾选项派生,
 * 只能在这一声明处补上。它同样**不是** `module_*` → 按 #38 落命令行,与文件头第 (1) 条一致。
 * default-on 那两套预设不动模块默认,发这个键会整体关掉模块 → 用 mode 限定只在反向白名单下发。
 * @type {{flag: string, value: boolean|string, mode?: ProfileMode}[]}
 */
const MODE_COMMAND_FLAGS = [
  // SConstruct:282 声明 / :476 唯一读点,都在 profile 落 env 之前;官方 CI 放在命令行(linux_builds.yml:108)。
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
 * **Ruling #38 的唯一通道判据**:这个 flag 进 profile 还是进命令行。
 * `module_*` → profile(`disabled_build_options`);其余一律 → 命令行 token。
 * 判据是**前缀**而不是行号白名单,理由见文件头第 (1) 条:命令行对任何消费时机都正确,
 * 而"profile 是否赶得上"这个知识随版本漂移且漂移成静默不生效。
 * 与 `isModuleFlag` 共用同一个正则,是为了让"表内 `module_` 前缀 ⇔ `_enabled` 结尾"这条
 * tplfeatures 侧已钉死的等价关系继续成立(见报告§10 等价变异清单);换成 `startsWith('module_')`
 * 不会改变任何可达输入上的集合,但会把"面板表里出现裸 module_x"这种错误悄悄放过。
 * @param {string} flag @returns {boolean} true = 写进 profile,false = 发进 commandExtras
 */
function goesToProfile(flag) {
  return isModuleFlag(flag)
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
 * 规则:**只对探到的 flag 求值** —— 探到的 flag 全部"默认为开"才打勾;**一个 flag 都没探到**才给 false。
 * 未探到的 flag 依旧不猜("探测里没有的 flag 按未勾选处理"那句改在这里生效):它不进求值集合,
 * 也不会在产物里被写出去(buildProfile 对它只记 skipped)。
 * 为什么 every 必须先滤掉未探到的(Ruling #57,原写法是 T5 的设计洞、被 T8 第一次接成可达路径):
 *   一项多 flag 时(真实形态 `tplfeatures.js:51` fmtCompressed 映射 7 个模块开关,旧版本源码里没有
 *   `module_astcenc_enabled`;`:67` a3GeomTools 的 `module_meshoptimizer_enabled` 同形),
 *   把"未探到"当成 false 塞进 every 会让整项判成"默认未开",而面板上这项**不灰**
 *   (`services.js` 的 present 按 `some(flags)` 判)→ 用户一个勾都没动 → default-on 模式下
 *   `buildProfile` 把探到的那 6 个兄弟 flag 写成 false(它对未探到的那一个只记 skipped)→
 *   产物静默少掉 3–6 个格式。那同时撞两条全局约束:「初始勾选态 = 探测到的源码默认值」与
 *   「探测不到 = 不写、不猜」—— 后者被违反了,因为**兄弟 flag 被写了**。
 * 语义验证点(测试里逐条钉着):fmtCompressed 6/7 探到且默认都开 → `true` → 用户不动 → 什么都不写;
 *   用户真取消该项 → 照旧写探到的那 6 个 false,`skipped` 记那 1 个未探到。
 * 「已探到但默认值互不一致」仍然不打勾(every 不是 some,这条没松);
 * 「已探到但默认值认不出是哪个取值算开」也仍然不打勾(featureKeptByDefault 给 false)。
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
    // 求值集合 = 这份源码里探得到的 flag;一个都没有才判"未知 → 不打勾"。
    const probed = f.flags.filter((k) => !!srcOpts[k] && srcOpts[k].exists)
    sel[f.id] = probed.length > 0 && probed.every((k) => featureKeptByDefault(k, srcOpts[k]))
  }
  return sel
}

/**
 * 勾选 → 两份产物:profile 对象(`module_*`)与命令行 token(其余一切),按 Ruling #38 分通道。
 * @param {Record<string, boolean>} selection 面板勾选(id → 是否保留);缺整个对象按"什么都没勾"处理,不猜
 * @param {OptionMap} options 探测结果(tplprobe.js probeSource().options);缺整个对象按"什么都没探到"处理
 * @param {{mode?: ProfileMode}} [opts] default-off = 最小可跑那种反向白名单
 * @returns {{json: {disabled_build_options: Record<string, boolean|string>}, written: string[], skipped: {flag: string, why: string}[], commandExtras: string[]}}
 */
function buildProfile(selection, options, opts) {
  const mode = /** @type {ProfileMode} */ ((opts && opts.mode) || 'default-on')
  const sel = selection || {}
  const srcOpts = options || {}
  /** @type {Record<string, boolean|string>} profile 通道:只装 `module_*`(Ruling #38) */
  const dbo = {}
  /** @type {string[]} */
  const written = []
  /** @type {{flag: string, why: string}[]} */
  const skipped = []
  // 命令行通道:非 `module_*` 的一切都走这里(文件头第 (1) 条)。先攒成 flag→值的映射再统一排序发 token,
  // 是为了让"同一个键不因来源(模式表 / 勾选项)或勾选顺序而落到不同位置"由构造保证。
  /** @type {Record<string, boolean|string>} */
  const cmd = {}
  for (const k of MODE_COMMAND_FLAGS) {
    if (k.mode && k.mode !== mode) continue
    cmd[k.flag] = k.value
    written.push(k.flag)
  }

  for (const f of TPL_FEATURES) {
    if (!(f.id in sel)) {
      // 面板没给这一项的勾选态:按源码默认不写任何东西(宁缺勿错),而不是当成"用户取消了它"
      // —— 后者会让一个拼错的 id 直接把 disable_3d=yes 发进命令行,方向是多删不是多留。
      for (const flag of flagsOf(f)) skipped.push({ flag, why: `面板未提供 ${f.id} 的勾选态,按源码默认不写(宁缺勿错)` })
      continue
    }
    const keep = !!sel[f.id]
    for (const flag of flagsOf(f)) {
      const o = srcOpts[flag]
      if (!o || !o.exists) {
        skipped.push({ flag, why: '此版本源码未探到该开关,两个通道都不写(未声明的 scons 变量是静默失效的)' })
        continue
      }
      const want = desiredValue(flag, o.default, keep, mode)
      if (want === SAME_AS_SOURCE) continue
      // Ruling #38:`module_*` 进 profile,其余进命令行。命令行在 SConstruct:440/:499 就落 env,
      // 早于所有读取点,所以对任何消费时机都正确;profile 只对 :655 之后才被读的键正确。
      if (goesToProfile(flag)) dbo[flag] = /** @type {boolean|string} */ (want)
      else cmd[flag] = /** @type {boolean|string} */ (want)
      written.push(flag)
    }
  }

  // 两个通道各自稳定序列化:profile 键字典序,命令行按 flag 名字典序生成 token
  // (token 串本身也因此在字典序上,Rust 双端逐字节比的就是这两份)。
  const commandExtras = Object.keys(cmd).sort().map((flag) => sconsToken(flag, cmd[flag]))
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
const LITE2D_OFF_IDS = ['sys3d', 'accesskit', 'd3d12']

/**
 * minimal(官方 CI 的 Minimal template)真正取消的面板项,逐条对齐 `linux_builds.yml:110-116`
 * 那 7 条 scons-flags(`id` ↔ 官方 `flag` 成对写死,所以"改了一条却动了另一项"这种漂移能被照出来)。
 * **这 7 条按 Ruling #38 全部落在 `commandExtras`**(它们都不是 `module_*`),产物与官方那行 scons-flags
 * 逐字相同;官方 9 条里另外两条:
 *   · `modules_enabled_by_default=no`(:108)同样走 `commandExtras`(见 MODE_COMMAND_FLAGS);
 *   · `module_text_server_fb_enabled=no`(:109)不发,它默认就是 False(Ruling #36)。
 * → 新规则下 minimal 的 profile 里**只剩"保留的模块显式点名 true"**那一类键。
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
  // d3d12 **刻意不进**这份名单:它与官方 CI 九条逐字对齐的口径不能破;windows 上它被平台 get_flags
  // 强制默认开(detect.py:294)而保留又必撞 SDK 墙这件事,由 validateSelection 的 d3d12SdkInstalled
  // 软拦在编译前喊出来(带「仍然继续」),不在预设里替用户做决定。lite2d 例外地关它(2D 模板不需要 D3D12)。
]

/**
 * 至少要有其一、否则产物没有任何画面的四个渲染驱动(策划书 §5.5 的第一条硬拦)。
 * `d3d12` 必须在名单里但**不能反过来算**:它的生效默认由探测给(windows 上被平台 get_flags
 * 覆盖成 True,detect.py:294;其它平台才是 SConstruct 的声明值),"用户没动它"不等于"有它" ——
 * 所以判定看的是产物里的生效值而不是"勾没勾"。
 * @type {string[]}
 */
const RENDER_DRIVERS = ['vulkan', 'opengl3', 'angle', 'd3d12']

/**
 * 校验用的「这个 flag 在**将要发出的那份产物**里生效到什么值」—— **两个通道的并集**。
 *
 * 为什么必须从产物读、且必须两个通道一起读:Ruling #38 之后 `vulkan` / `opengl3` / `angle` / `d3d12`
 * 这些核心键**只出现在 `commandExtras`**,`disabled_build_options` 里永远没有它们;
 * 只查 profile 的校验会把"四个驱动全关"看成"什么都没关"(策划书 §5.5 这一层最容易踩的坑)。
 * 两个通道都没发出去的键回落到**探测到的源码默认值**(§5.3 差值规则:不发 = 保持默认);
 * 两处都没有、options 里也没探到 → `undefined`,含义是"这份源码里没有这个变量"——
 * 未声明的 scons 变量是**静默忽略**的(本机实测:值不进 env、无 warning、退出码 0),
 * 所以校验一律按未知处理,不基于"我记得 Godot 有这个选项"下判断。
 * @param {string} flag @param {ReturnType<typeof buildProfile>} built @param {OptionMap} options
 * @returns {boolean|string|undefined} 布尔或枚举串;`undefined` = 这份源码里未知
 */
function productValue(flag, built, options) {
  const dbo = built.json.disabled_build_options
  if (flag in dbo) return dbo[flag]
  const tok = built.commandExtras.find((t) => t.slice(0, t.indexOf('=')) === flag)
  if (tok !== undefined) {
    const raw = tok.slice(tok.indexOf('=') + 1)
    if (raw === 'yes') return true
    if (raw === 'no') return false
    return raw // 枚举型 token 原样交给 isOnByDefault 查 ENUM_VALUES
  }
  const o = options[flag]
  return o && o.exists ? o.default : undefined
}

/**
 * 该 flag 在产物里**算不算开着**(有事实才回答)。`null` = 未知。
 * 判定复用输出层唯一的 `isOnByDefault`,不在这里再写一遍枚举/布尔的分别。
 * @param {string} flag @param {ReturnType<typeof buildProfile>} built @param {OptionMap} options
 * @returns {boolean|null}
 */
function productOn(flag, built, options) {
  const v = productValue(flag, built, options)
  return v === undefined ? null : isOnByDefault(flag, { exists: true, default: v })
}

/**
 * 该 flag 在产物里是否**确定把这项能力关掉**:`disable_*` 的值为真 = 关掉,其余(`module_*_enabled`、
 * 裸名)的值为假 = 关掉。**方向只在这一处翻**(与 E3 那条教训同一条:两处翻就会有一处够不着)。
 * 未知一律返回 false —— "没探到"不等于"已关闭",拿它当已关闭去硬拦就是替用户的源码做假设。
 * @param {string} flag @param {ReturnType<typeof buildProfile>} built @param {OptionMap} options
 * @returns {boolean}
 */
function productOff(flag, built, options) {
  const st = productOn(flag, built, options)
  if (st === null) return false
  return isNegatedFlag(flag) ? st : !st
}

/**
 * 面板项在产物里是否**确定不可用**(一项多 flag 时:任一 flag 被确定关掉,这项就没了)。
 * @param {string} id @param {ReturnType<typeof buildProfile>} built @param {OptionMap} options
 * @returns {boolean}
 */
function itemOffInProduct(id, built, options) {
  const f = featureById(id)
  if (!f) return false
  return flagsOf(f).some((k) => productOff(k, built, options))
}

/**
 * @typedef {Object} TplIssue
 * @property {string} itemId   面板项 id(或 'source' 这类全局项)
 * @property {string} flag
 * @property {string} why      为什么这是个问题(面向用户的一句话,不是日志)
 * @property {string} action   建议动作
 * @property {boolean} skippable  false = 硬拦,不给「仍然继续」
 */

/**
 * 编译前静态校验(策划书 §5.5)。
 *
 * 除三条硬拦外一律可越过 —— 我们对源码的了解不如用户可能了解的多,锁死他是拿我们的
 * 无知换他的选择权。三条硬拦的共同点是"编出来的东西必然跑不起来":
 * 用户在那儿承担的不是风险,是几十分钟后拿到一个废产物。
 * 1. 四个渲染驱动全关(没有任何画面);
 * 2. 面板一项不剩;
 * 3. **反向白名单(`mode:'default-off'`)开着、而这份产物一个模块都没点名保留** ——
 *    `modules_enabled_by_default=no` 自 #38 起是**活的**(命令行,`SConstruct:476` 读点早于 profile
 *    落 env 的 `:655`),探测失败时它会真把 57 个模块整体关掉(gdscript / freetype / text_server_adv
 *    全没),而 `buildProfile` 照发不误(它的契约是"按勾选与探测生成",拦不拦不归它)。
 *
 * **不做的一条(策划书 §5.5 交下来、已被 Ruling #38/#39 消解)**:「`production=yes` 会把
 * `lto` / `use_static_cpp` / `debug_symbols` 覆盖回默认」不需要出软问题 —— 这三个键上命令行后
 * `SConstruct:675` / `:680` 用 `ARGUMENTS` 重设时取到的正是用户所选值,覆盖不发生。
 *
 * **不重复实现的一条**:"`disabled_build_options` 里出现非 `module_*` 键"是实现 bug 而非用户选择,
 * 已由本文件测试里的遍历性守卫(跑在每一份产物上 + 防空转)守着;混进这里会让"用户能勾出坏组合"
 * 和"我们写错了"两件事分不开。
 *
 * @param {Record<string, boolean>} selection 面板勾选;缺整个对象按"什么都没勾"处理,不抛
 * @param {OptionMap} options 探测结果(tplprobe.js probeSource().options);缺整个对象按"什么都没探到"处理
 * @param {{mode?: ProfileMode, d3d12SdkInstalled?: boolean, accesskitSdkInstalled?: boolean, untestedSource?: boolean}} [ctx]
 *   `mode` **必须与 T7 发起编译时传给 buildProfile 的那一个相同**,否则第 3 条判的不是将要发出去的产物
 * @returns {{issues: TplIssue[], hardBlocks: TplIssue[]}}
 */
function validateSelection(selection, options, ctx) {
  const c = ctx || {}
  const mode = /** @type {ProfileMode} */ (c.mode || 'default-on')
  const sel = selection || {}
  const srcOpts = options || {}
  /** @type {TplIssue[]} */
  const issues = []
  /** @type {TplIssue[]} */
  const hard = []
  // 校验的对象是"将要发出去的那份产物",所以先把两通道算出来再判 —— 与 T7 走的是同一个生成器,
  // 不会出现"校验以为会这样、实际发出去那样"的两份真源。
  // 也正因为如此,这里**不直接读 `selection` 的真值**:勾着但没探到的项什么都不会发,
  // 产物里的能力由源码默认决定,而不是由面板上那个勾决定。
  const built = buildProfile(sel, srcOpts, { mode })
  /** @type {(flag: string) => boolean} 该 flag 在产物里确定被关掉 */
  const off = (flag) => productOff(flag, built, srcOpts)
  /** @type {(id: string) => boolean} 该面板项在产物里确定不可用 */
  const gone = (id) => itemOffInProduct(id, built, srcOpts)

  // —— 硬拦 1:渲染后端。四个里至少要有一个;**只按有事实的那几个下判断** ——
  // 未探到的驱动不算"已关闭"(它是源码默认),所以这里是 every(确定为关)而不是 filter(没开着)→ 长度 0。
  if (RENDER_DRIVERS.every(gone)) {
    hard.push({ itemId: 'vulkan', flag: 'vulkan', why: '四个渲染驱动全关,编出来的模板不会有任何画面', action: '至少保留一个;Windows 上建议保留 Vulkan', skippable: false })
  }

  // —— 硬拦 2:一项不剩 ——
  const kept = Object.keys(sel).filter((k) => sel[k])
  if (kept.length === 0) {
    hard.push({ itemId: 'source', flag: '', why: '一项都没保留,这不是一个能跑的模板', action: '至少保留渲染驱动与文字渲染', skippable: false })
  }

  // —— 硬拦 3:反向白名单开着却没有任何模块被点名保留(裁定①)——
  // 判据两条:token 真的发出去了(命令行才是活通道)、且 profile 里没有任何 `module_*` 点名(全被整体关掉)。
  // **不再要求"这份源码声明了 modules_enabled_by_default"**(上一轮这里多叠了一个 exists 前置,评审订正):
  //   · `OptionMap` 的键**只可能在探到时才出现**,所以"键缺席"永远等于"我没探到",它压根表达不了
  //     "这份源码没声明该键" —— 拿它做推断正是本文件其余部分反复禁止的方向(`productOff` 的注释自己写着
  //     「未探到 ≠ 已关闭」);
  //   · 而 token 发没发**由 `buildProfile` 独立决定**:`MODE_COMMAND_FLAGS` 不查 `options`,`mode`
  //     是 default-off 就无条件发。用一个"不知道"去否定一个"已经发生",结果是"探测整体失败 + 反向模式"
  //     这份**零模块废产物**照样能编 —— 那恰好是这条硬拦存在的唯一理由。
  //   · scons 对未声明的键静默忽略,最坏是白名单没生效(产物偏大),不会编出跑不起来的东西;
  //     而漏拦零模块产物是几十分钟后交一个废件。两侧代价不对称,判据只看已发出的 token。
  const whitelistLive = built.commandExtras.indexOf('modules_enabled_by_default=no') !== -1
  const namedModules = Object.keys(built.json.disabled_build_options).filter(isModuleFlag)
  if (whitelistLive && namedModules.length === 0) {
    // 同一个分支有两种成因,**建议不能给同一句话**(给错建议等于让用户去修一个没坏的东西):
    //   · 一个模块开关都没探到 → 不是用户不想点名,是我们没法点名 → 换源码 / 换预设;
    //   · 模块开关探到了、但面板上所有模块项都被取消 → 源码没问题,是勾选的问题 → 点名保留 / 换预设。
    const probedModuleCount = new Set(TPL_FEATURES.flatMap((f) => flagsOf(f))
      .filter((k) => isModuleFlag(k) && !!srcOpts[k] && srcOpts[k].exists)).size
    const branch = probedModuleCount === 0
      ? { why: '「最小可跑」会整体关掉所有模块,而这次一个模块开关都没探到、无法点名保留 —— 产物会是没有脚本也没有文字的零模块模板',
          action: '换一份完整解压、能探到 modules/ 的源码再编,或改用「默认开」的预设' }
      : { why: `「最小可跑」会整体关掉所有模块,这次探到 ${probedModuleCount} 个模块开关但一个都没点名保留 —— 产物会是没有脚本也没有文字的零模块模板`,
          action: '至少点名保留脚本与文字渲染要用的模块(勾回对应面板项),或改用「默认开」的预设' }
    hard.push({ itemId: 'source', flag: 'modules_enabled_by_default', why: branch.why, action: branch.action, skippable: false })
  }

  // —— 软问题:以下每条都带「仍然继续」——
  // 物理:2D 那条轴 = 伞项关掉 或 自带 2D 后端关掉;3D 那条轴 = 伞项关掉 或(自带 3D 后端与 Jolt 同时关掉)
  // (Jolt 只提供 3D 后端,救不了 2D)。两条轴都没了才是"没有任何碰撞"。
  const phys2dGone = off('disable_physics_2d') || off('module_godot_physics_2d_enabled')
  const phys3dGone = off('disable_physics_3d') ||
    (off('module_godot_physics_3d_enabled') && off('module_jolt_physics_enabled'))
  if (phys2dGone && phys3dGone) {
    issues.push({ itemId: 'a3GodotPhys', flag: 'module_godot_physics_2d_enabled', why: '2D 与 3D 物理后端都被关掉了,CharacterBody/RigidBody 不会有任何碰撞', action: '至少保留一套物理后端', skippable: true })
  }

  // 依赖缺失:只在"这个驱动真会被编进产物"时报。判据只留 `productOn(flag) === true` 一处 ——
  // 它已经把"用户取消了它"(值确定为假)与"这份源码里没有它"(未知)都排除了,
  // 再叠一道 `on(id)` 是永远够不着的第二守卫(本项目已栽过一次两道守卫只有一道在干活)。
  // 没探到却硬报 = 把我们自己的无知说成用户的选择。
  if (productOn('d3d12', built, srcOpts) === true && c.d3d12SdkInstalled === false) {
    issues.push({ itemId: 'd3d12', flag: 'd3d12', why: '保留 Direct3D 12 驱动,但本机没装它的依赖 —— 实测这样会直接编译失败', action: '取消该项,或先跑 python misc\\scripts\\install_d3d12_sdk_windows.py', skippable: true })
  }
  if (productOn('accesskit', built, srcOpts) === true && c.accesskitSdkInstalled === false) {
    issues.push({ itemId: 'accesskit', flag: 'accesskit', why: '保留 AccessKit,但本机没装它的依赖 —— 实测会撞 accesskit 报错', action: '取消该项(无障碍树对导出模板通常无关)', skippable: true })
  }
  if (gone('netMbedtls')) {
    // `action` 必须是**可执行的建议动作**,不是把 `why` 换个说法复述一遍(简报逐字那句
    // 「项目有联网就用不上该项」语义反了:读起来像"要联网就别保留",而这一条报的正是"已经被取消")。
    issues.push({ itemId: 'netMbedtls', flag: 'module_mbedtls_enabled', why: '关掉 mbedTLS 后 HTTPS / TLS 全断,任何联网需求都会静默失败', action: '勾回该项,或确认项目不含任何联网调用', skippable: true })
  }

  // 反向白名单的"半个瞎":白名单活着、也确实点名了一些模块(硬拦 3 没触发),但用户勾着的某一项里
  // 有模块 flag 在这份源码里没探到 → 它不会出现在任何通道里,于是被 modules_enabled_by_default 整体关掉。
  // 面板显示"保留"、产物里没有,这是静默丢功能,不是用户的选择 → 汇成一条软问题报出来。
  // 判据用 some 而不是 every:一项多 flag 时**只要有一个没探到就少一个后端**(真实形态:
  // `fmtCompressed` 映射 7 个模块开关,源码里少一个目录就是"压缩纹理"整项看着勾着、实际缺一块)。
  if (whitelistLive && namedModules.length > 0) {
    /** @type {string[]} */
    const lostIds = []
    for (const f of TPL_FEATURES) {
      if (!sel[f.id]) continue
      const mods = flagsOf(f).filter(isModuleFlag)
      if (mods.some((k) => productValue(k, built, srcOpts) === undefined)) lostIds.push(f.id)
    }
    if (lostIds.length > 0) {
      issues.push({ itemId: 'source', flag: 'modules_enabled_by_default', why: `反向白名单下有 ${lostIds.length} 项你保留的模块没在这份源码里探到,它们会被整体关掉(面板显示保留、产物里没有)`, action: '把这些项取消勾选,或改用「默认开」的预设', skippable: true })
    }
  }

  // 默认开模式的对称半边(Ruling #57,与上面那条反向白名单软问题是同一件事的两个方向):
  // 上面是「面板显示保留、产物里没有」,这里是「面板显示取消、产物里可能还有」。
  // 一项多 flag 而**部分没探到**时(真实形态 fmtCompressed 的 module_astcenc_enabled、
  // a3GeomTools 的 module_meshoptimizer_enabled 在旧版本源码里不存在),面板上这项不灰
  // (`services.js` 的 present 按 some 判),勾选态由探到的那几个决定(initialSelection 现在也只对
  // 探到的求值)。用户**取消**它 → 只有探到的那几个会被写出去,剩下 N 个在这份源码里根本没声明,
  // 发出去是静默失效,于是它们维持自己的源码默认(通常是还开着)→ "这一项只能关掉一部分"。
  // 判据三条都必要:
  //   · 用户明确给了「不保留」(面板没给勾选态 ≠ 用户取消了它,那是 buildProfile 的「按默认不写」分支);
  //   · 有 flag 没探到(missing > 0)—— 全探到的项关得干净,不该报;
  //   · 也有 flag 探到(probed > 0)—— 一个都没探到的项在面板上是灰的(present:false),
  //     这项根本没参与裁剪,报它就是把我们的无知说成用户的选择。
  // **软问题,不是硬拦**:台账 T6 行明文「硬拦保持三条,别加第四条」;这里拦不动任何东西,
  // 用户少关的本来就是他这份源码里没有的东西。
  if (mode === 'default-on') {
    for (const f of TPL_FEATURES) {
      if (!(f.id in sel) || sel[f.id]) continue
      const flags = flagsOf(f)
      const missing = flags.filter((k) => !srcOpts[k] || !srcOpts[k].exists)
      const probedCount = flags.length - missing.length
      if (probedCount > 0 && missing.length > 0) {
        issues.push({ itemId: f.id, flag: missing[0], why: `该项在本版本源码里有 ${missing.length} 个开关不存在,取消它只会关掉探到的那 ${probedCount} 个 —— 不会影响那些格式`, action: '照常取消即可;要精确关掉那些能力得换一份声明了对应开关的源码', skippable: true })
      }
    }
  }

  if (c.untestedSource) {
    issues.push({ itemId: 'source', flag: '', why: '这份源码的版本不在已实测表内,面板按探测结果工作;未识别的项保持源码默认,不猜参数', action: '如产物异常,先按已实测版本复现', skippable: true })
  }
  return { issues, hardBlocks: hard }
}

/**
 * 当前勾选下**被连带关闭**的面板项 id(Ruling #62)—— 策划书 §5.4 那条连带关系的**动态态**。
 *
 * 为什么必须在宿主算而不是在面板算:`FeatureWithProbe.cascadedBy`(`services.js:80` 直接取
 * `probe.cascades` 的键)是**这份源码的静态连带结构**,不是"当前已被连带关闭"。默认组合(3D 开着)下
 * 3D 导航 / 3D 物理 / XR 三行并没有被关、产物里它们都在;用户真把 3D 取消时它们才没了。
 * 面板手里只有 modelValue,要它独自把这个动态态判对就是**把判据塞进 .vue**(违反全局约束第一条),
 * 所以这一层由宿主算完再交出去,面板只当名单的接收端。
 *
 * 语义:对 `cascades` 的每个 `源 flag → [目标 flag...]`,若**拥有那个源 flag 的面板项**在 `selection`
 * 里是 `false`(用户取消了伞项 → 这个 `disable_*` 会被真发出去),则**拥有任一目标 flag 的面板项**全部进表。
 * 只有严格 `false` 才算:缺键(整份 selection 没给 / 该项没进勾选表)按"用户没取消它"处理,
 * 与 `validateSelection` 的「面板没给勾选态 → 什么都不写」同一条口径。
 *
 * **表外源 flag**(这份源码的连带源在我们功能表里没有对应面板项)不退化成跳过:那一支 SCons 照样连带,
 * 面板只是给不出伞项名字(文案走不带名字那一态)。认不出伞项时取**保守态**把它报进表:
 * 这里不替用户改勾选(modelValue 原样不动,伞项关回去目标就回来),只是不再假装用户能单独改一个
 * 由我们看不见的总开关决定的行 —— 把这种行显示成"可点"就是 Ruling #62 要修掉的那类谎。
 *
 * flag → 面板项 的反查只用本文件已 import 的 `TPL_FEATURES`,不为此新增入参(调用方手头没有能力表,
 * 让它传就等于把表的第二份拷贝推到契约上)。
 *
 * **只走一层,不做传递闭包(Ruling #73 —— 这条边界就写在这里,别只写在报告里)**:
 * 对 `A → B`、`B → C` 这样的两级链,取消 A 只把 **B** 报进表;`C` 不会因为"B 也被连带"而进表,
 * 只有当用户**自己把 B 取消**(selection 里 `B === false`)时 C 才进表。链式连带的判定不在本函数职责内。
 * 这么切的依据是已核实的三份真实 SConstruct 的连带图:4.3 的连带源数 0,4.5 与 4.7.2 都只有 `disable_3d`
 * 一个源、且它的目标自身都不是别的源的源 —— **全是单层图**,所以现在做 fixpoint 就是给假想需求设计。
 * 但"没做传递闭包"与"静默漏抑制"只差一处登记:已用一条**合成两级链**的断言钉住这个意图
 * (`__tests__/tplprofile.test.js` 的「★Ruling #73」两条)。将来真出现两级链的版本、或决定改做传递闭包时,
 * 该由那条断言**变红**逼出一次显式改动(改成 fixpoint 或在这里补一层),而不是让 C 少抑制而没人喊。
 *
 * @param {Record<string, boolean>} selection 面板勾选(整个对象缺失按"没取消任何伞项"处理,不抛)
 * @param {Record<string, string[]>} cascades 探测层给的静态连带图(tplprobe.probeSource().cascades;整个缺失按"没有连带关系")
 * @returns {string[]} 被抑制的面板项 id:**只含面板项 id**(表里没有对应项的目标 flag 不进表)、去重、按 TPL_FEATURES 表序
 */
function selectionSuppressed(selection, cascades) {
  const sel = selection || {}
  const graph = cascades || {}
  /** @type {Set<string>} */
  const hit = new Set()
  for (const srcFlag of Object.keys(graph)) {
    // 拥有源 flag 的面板项(功能表已钉死"同一 flag 不被两个面板项共用",这里仍写成 some 以免表长歪)
    const owners = TPL_FEATURES.filter((f) => flagsOf(f).includes(srcFlag))
    // owners 为空 = 表外源,按上面那条保守态处理;非空 = 只有真被取消才算连带。
    const umbrellaOff = owners.length === 0 || owners.some((f) => sel[f.id] === false)
    if (!umbrellaOff) continue
    for (const target of graph[srcFlag] || []) {
      // 一项多 flag 时**任一** flag 是连带目标就算这项没了(与 itemOffInProduct 同一条"任一"口径)
      for (const f of TPL_FEATURES) {
        if (flagsOf(f).includes(target)) hit.add(f.id)
      }
    }
  }
  // 按表序输出而不是 Set 的插入序:两个调用方拿到的数组能逐字节比,断言也钉得住形状
  return TPL_FEATURES.filter((f) => hit.has(f.id)).map((f) => f.id)
}

/**
 * 三个预设(策划书 §5.4b)。
 * full = 全部回到源码默认;lite2d = 附录实测那组(只动 LITE2D_OFF_IDS 那两项);
 * minimal = 官方 CI Minimal template 的 9 条 scons-flags 逐条对齐(见 MINIMAL_OFF 与文件头第 (1)(2) 条):
 * 新规则下那 8 条要发的都发在 `commandExtras`,profile 只带保留模块的显式点名。
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
  minimalSelection(options) { return selectionTurningOff(options, MINIMAL_OFF.map((x) => x.id)) },
  /**
   * 预设名 → 勾选 + 编译模式(Ruling #74;T10 的 applyTemplatePreset 走这里)。
   * 名字由渲染层报、判据都在本层;`mode` 是预设的一部分("最小可跑" = 反向白名单 default-off),
   * 宿主把它**同一份**喂给 validateTemplateConfig 与 buildTemplatePack 两个调用点 ——
   * 两处不同的话,校验的就不是将要发出去的那份产物(services.ts:130 注释警告的形态)。
   * **未知名不猜**:返回 ok:false(名字拼错/按旧名调用时立刻可见,而不是静默拿到 full)。
   * @param {string} name
   * @param {OptionMap} options
   * @returns {{ok: true, features: Record<string, boolean>, mode: ProfileMode} | {ok: false, error: string}}
   */
  apply(name, options) {
    if (name === 'full') return { ok: true, features: PRESETS.full(options), mode: 'default-on' }
    if (name === 'lite2d') return { ok: true, features: PRESETS.lite2d(options), mode: 'default-on' }
    if (name === 'minimal') return { ok: true, features: PRESETS.minimalSelection(options), mode: 'default-off' }
    return { ok: false, error: `未知预设:${name}` }
  }
}

module.exports = { initialSelection, buildProfile, profileText, PRESETS, ENUM_VALUES, validateSelection, selectionSuppressed }
