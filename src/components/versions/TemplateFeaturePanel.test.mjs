// 自编译模板 · 功能面板的「判据不进 .vue」闸门(源码扫描型)。
//
// 为什么只能扫源码:.vue 要 vite + @vitejs/plugin-vue + DOM 才载得进来,本仓库的 Node harness 没有这套
// (先例:TemplateBuildWizard.vue 文件头那句「判据不进 .vue(跑不进 Node harness)」、
//  tauriShimHonesty.test.mjs 的静态扫描、buildtools.test.js 第 8 节那套「未移植方法不得假成功」)。
// 台账 deferred ⑥ 已判:不为两条断言引 vitest/jsdom(违反"不引入新依赖")。
//
// 写法纪律(轮 1 按 Ruling #63/#64 重写过,轮 2 按 #67/#68/#70/#72 补洞,别再退回旧形态):
//   · 断言只钉**方向与形状**,不钉三元 / `&&` / `if-return` 的拼写,也不钉函数名 / 形参名 ——
//     名字一律从模板绑定(`:checked` / `:disabled` / `:title` / `@change`)或从文案里的承重短语**反查**得到,
//     纯改名与等价改写都该继续绿(评审员实测 M-D/M-E/F/G 四条假红就是轮 1 之前欠的)。
//   · "字样存在"不是断言:每条都配一刀**反向禁令**(错误方向不出现)+ 一刀**渲染点被钉**
//     (函数留着但那一处不渲染 = 红)。轮 1 的 5/7 两条只查字样,评审员实跑 M-H/M-C/M-I 全绿,
//     所以这三条现在是:插值只许出 label、cascadedBy 不进判定、文案两态的分支来自 suppressed 名单。
//   · **反向禁令的扫描面必须跟着靶子走**(Ruling #67)。#62 把"当前是否被连带关闭"搬去宿主之后,
//     轮 1 把靶子从"某几个函数不许读 cascadedBy"换成了"定义体里不许出现 cascadedBy",
//     却把**模板的属性绑定**整个漏在扫描面外 —— 于是 `:disabled="isDisabled(it) || !!it.cascadedBy"`
//     (正是 #62 修掉的那个谎原样回归)全绿。轮 1 做"名字无关化"时把再上一轮那条精确属性正则
//     `/:disabled="isDisabled\(it\)"/` 的牙一起丢了,现在用"任何属性绑定里不许出现 cascadedBy"补回来,
//     零成本且不牺牲改名自由。
//   · **实现的另一半语义也要有护栏**(Ruling #68):#62 还说了"被抑制项的用户选择原样保留",
//     轮 1 一条护栏都没给。复审员实测 M-POLLUTE(把名单内项统一写成 false 再整份 emit,**显示仍正确**)
//     全绿。这条语义正是要交给 T10 去接的位置,所以轮 2 钉两条:名单谓词只出现在四个展示位、
//     上报的 payload 只写被点的那一行且不写 false 字面量。
//   · 扫描型断言最怕的失效模式是"删掉代码 + 在注释里补一句同样的字样"把它喂绿。这里按
//     services.test.js:352 / tauriShimHonesty.test.mjs:37 的先导**先把注释剥掉再扫**,那条假绿就不成立了
//     (注释不进扫描面);代价是同一文件里"注释替代码作保证"也不作数 —— 代码不在就是不在。
//     Ruling #70:轮 1 只剥**整行**注释,结果"解释这条裁定的行尾注释"把这条裁定的守卫打红
//     (复审员实测 M-尾部注释 红 3 条),与目标正好相反 —— 现在整行 / 行尾 `//` / 同行 `/* */` /
//     模板的 HTML 注释都不进扫描面(新守卫用剥过的 TPL_CODE,存量断言的输入一字未动)。
//     剩下的天花板如实登记:字符串拼接类泄漏只认带 `cascadedBy` 标识符的那一种写法,
//     真要把原始变量名换个中间量绕过去仍然可能;要堵死它得引真正的数据流分析(= 引新工具,台账 deferred ⑥ 已判不做)。
//
// ⚠ 逐条变异自检(2026-10-10,修复轮 2 口径;全部在仓库外的临时副本里跑,工作树未动。
//    轮 2 共 14 次面板实验(8 刀功能变异全杀红 + 6 组合法改写/注释全绿),
//    完整输出与逐条归属见 task-9-report.md 修复轮 2 §3;轮 1 那 49 次见同文件修复轮 1 §6)。
//    T10 收口(2026-10-10):#72 的假绿已修(默认值改验 withDefaults **第二个实参**、要求工厂形状),
//    新增 ★New-7(.off 淡化与禁用态同源);两处的变异证据见 task-10-report.md §变异表。
//    终审修复波(2026-10-10):I1 —— v- 指令进 #67 禁令扫描面(v-if 谎刀:旧面 PASS 19/0 看不见 →
//    新面 FAIL 1 抓住;合法 v-if / v-show、改名、注释全绿);I2 —— :145 与「原始变量名」里两半改扫整文件
//    剥注释面 CODE(含 disable_3d / ${it.cascadedBy} 的自然注释由红转绿,真写回代码仍红)。
//    逐条输出与前后对照见 final-fix-report.md。
//    口径 = 把对应那段功能**真的拿掉/改反**(不是改注释、不是改名)→ 这条必须红:
//      1 ← 把一个开关的变量名字面量真写进组件                  → 红(轮 1)
//      2 ← 把编译命令行真拼进组件                              → 红(轮 1)
//      3 ← 面板项换成组件内的常量表(三处读法一起换)          → 红(轮 1)
//      4 ← 删掉 :disabled 绑定 / 删掉探不到的文案 / 判据不再读 present → 各红(轮 1)
//      5 ← 不读 props.suppressed(禁用名单本地硬编)/ 代码不读、只在注释里声称读(M-注释喂绿)→ 各红
//      6 ← isDisabled 改回 `!present || !!it.cascadedBy`        → 红(#62 的回归刀,轮 1)
//      7 ← 模板属性绑定拿 cascadedBy 判禁用(M-TPLCASC)/ 写文案(M-TPLCASC-title)→ 各红(轮 2 #67)
//      8 ← checked 丢掉禁用支 / 把冻结简报 :86 那行照抄回来    → 各红(轮 1)
//      9 ← 删掉两态其中一支 / 当前态改由 cascadedBy 决定        → 各红(轮 1)
//     10 ← 函数留着、模板里那个 <em> 删掉(M-I)                → 红(轮 1)
//     11 ← 命中支直出原始变量名(M-H)/ 退化支带上别名(M-C)/ 退化支改用字符串拼接 → 各红(轮 1)
//     12 ← 量级换成具体 MB 数字 / 删掉查表直接输出枚举          → 各红(轮 1)
//     13 ← 分区拉平(内层直接吃 props.items)                  → 红(轮 1)
//     14 ← 上报丢掉 spread / 干脆就地改 props / 整份按名单重建(M-POLLUTE3)→ 各红
//     15 ← 名单谓词出现在上报函数里(M-POLLUTE)/ :title 不再绑那个文案函数(M-TPLCASC-title)→ 各红(轮 2 #68①)
//     16 ← 把名单内项统一写成 false 再整份 emit(M-POLLUTE / M-POLLUTE2,**显示仍正确**)→ 各红(轮 2 #68②)
//     17 ← 三档名字被改('minimal' → 'min')                    → 红(轮 1)
//     18 ← 去掉任一 `|| []` / `|| {}` 且没有 withDefaults(M-66回归)/ withDefaults 少盖一个键(M-72混用缺口)→ 各红
//    对照组(合法改写**不该**红,Ruling #64/#72/#70 要收掉的就是这些假红):
//    轮 1 七条(checked 改 if-return、checked 改 `&&`、grouped 纯改名、SIZE_LABEL 纯改名、isDisabled 纯改名、
//    cascadeNote 纯改名、isSuppressed 纯改名)实测全绿;轮 2 新增六条:
//      G-toggle-先建后发(先 const next 再发)、G-改名inSuppressList(名单谓词改名 → 15/16 仍绿)、
//      M-尾部注释 / M-尾部注释块 / M-模板注释(写注释解释裁定 → 不再打红守卫)、
//      G-withDefaults(改成声明默认值那种同样合法的写法 → 18 不再假红)—— 六条实测全绿。
//
// 用法: node src/components/versions/TemplateFeaturePanel.test.mjs
import fs from 'node:fs'
const SRC = fs.readFileSync('src/components/versions/TemplateFeaturePanel.vue', 'utf8')
let pass = 0
const failures = []
const ok = (c, l, e) => { if (c) { pass++; console.log(`  PASS  ${l}`) } else { failures.push(l); console.log(`  FAIL  ${l}${e !== undefined ? '  → ' + e : ''}`) } }

// ---------- 取 SFC 的两段 ----------
// 注释一律剥掉再扫(切法与 services.test.js:352、tauriShimHonesty.test.mjs:37 同一条):
// 这一层的目的是"删掉代码 + 在注释里补一句同样的字样"不能把它喂绿 —— 注释不进扫描面,
// 那条假绿就不成立了;同时合法改写也不会因为注释里提到某个标识符而假红。
// Ruling #70:轮 1 只剥**整行**注释,行尾注释仍进扫描面 —— 复审员实测 M-尾部注释 给 :50 加一句
// `// 这里不看 cascadedBy（Ruling #62）` 反而红 3 条:解释这条裁定的注释把这条裁定的守卫打红了,
// 与"注释不进扫描面"的目标正好相反(T10 迟早要写这种注释)。现在整行与行尾都剥:
//   · 同行的 `/* … */` 一并剥;
//   · `//` 只认「行首或前面是空白」那一种,免得把 'https://…' 这类字符串里的斜杠当注释;
//   · 完整词法分析**不做**(过度设计,台账 deferred ⑥ 同口径:要堵死字符串绕过得引真数据流分析)。
const stripTailComments = (l) => l.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/g, '$1')
const SCRIPT_RAW = SRC.slice(SRC.indexOf('<script'), SRC.indexOf('</script>'))
const SCRIPT = SCRIPT_RAW.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).map(stripTailComments).join('\n')
const TPL = SRC.slice(SRC.indexOf('<template>', SRC.indexOf('</script>')), SRC.lastIndexOf('</template>'))
// 本轮新增的两条守卫(#67/#68)扫的是**模板**,所以模板侧的注释(HTML 注释 `<!-- … -->`)也不许进扫描面,
// 否则同一类"写注释解释裁定 → 把裁定守卫打红"的问题会在模板里重演一遍。
// 单独造一份 TPL_CODE、不改上面那行 TPL:存量断言(第 4/7/9/11/12/13 条)的输入一字不动,
// 只让本轮新买的守卫用它 —— 不顺手改动没被点名的存量判据。
const TPL_CODE = TPL.replace(/<!--[\s\S]*?-->/g, '')
// 终审 I2 收口:整文件剥注释扫描面(与向导 .vue 的 sfcCode 同形)—— :145 的 scons flag 禁令与
// 「原始变量名不进模板」那条里原先扫 SRC 原文的两半,与头部自述"注释不进扫描面"矛盾:
// 终审实测加一句自然注释(含 disable_3d 字样 / 含 ${it.cascadedBy})→ FAIL 1,与 Ruling #79 在向导侧
// 修掉的是同一形态。这两条红线挪到这份 CODE 上 —— 注释里提这些字样不再假红,代码里真写回去照样红。
const sfcCode = (raw) => {
  const scriptRaw = raw.slice(raw.indexOf('<script'), raw.indexOf('</script>'))
  const script = scriptRaw.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).map(stripTailComments).join('\n')
  const tpl = raw.slice(raw.indexOf('<template>', raw.indexOf('</script>')), raw.lastIndexOf('</template>'))
  return script + '\n' + tpl.replace(/<!--[\s\S]*?-->/g, '')
}
const CODE = sfcCode(SRC)

/** 一行里的括号是否配平(配平 = 这是条自足的单行定义) */
const balanced = (l) => { let d = 0; for (const c of l) { if (c === '(' || c === '{' || c === '[') d++; else if (c === ')' || c === '}' || c === ']') d-- } return d === 0 }

/**
 * 取某个声明的定义体:单行定义就取那一行,多行定义取到同缩进的下一条语句/闭合括号为止。
 * 按名字取而不是按整段正则取,是为了让**改名**与**换写法**(三元 / `&&` / if-return)都不影响判定。
 */
function defOf(name) {
  if (!name) return null
  const lines = SCRIPT.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*)(?:const|let|function)\s+([A-Za-z_$][\w$]*)\b/.exec(lines[i])
    if (!m || m[2] !== name) continue
    const ind = m[1].length
    if (balanced(lines[i])) return lines[i]
    let out = lines[i]
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (l.trim()) {
        const li = /^[ \t]*/.exec(l)[0].length
        if (li <= ind && /^(?:const|let|function|return|if|for|while|[}\)])/.test(l.trim())) break
      }
      out += '\n' + l
    }
    return out
  }
  return null
}

const DECL_NAMES = [...SCRIPT.matchAll(/^[ \t]*(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])

/** 定义体 + 它调用的本地 helper 的定义体(展开一层):判定委派给 helper 时只看外层会漏。 */
function bodyOf(name, depth = 2, seen = new Set()) {
  const own = defOf(name)
  if (own === null || depth <= 0 || seen.has(name)) return own || ''
  seen.add(name)
  let out = own
  for (const n of DECL_NAMES) {
    if (n === name || seen.has(n)) continue
    if (new RegExp('\\b' + n + '\\s*\\(').test(own)) out += '\n' + bodyOf(n, depth - 1, seen)
  }
  return out
}

/** 模板绑定里被调用的那个函数名(:disabled="isDisabled(it)" → isDisabled),不写死名字。 */
const bindingName = (attr) => {
  const m = new RegExp('[\\s:@]' + attr + '="\\s*([A-Za-z_$][\\w$]*)\\s*\\(').exec(TPL)
  return m ? m[1] : ''
}
const mustaches = [...TPL.matchAll(/\{\{([^{}]*)\}\}/g)].map((m) => m[1])
const interpolations = [...SCRIPT.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1])

// ---------- 红线:判据不进 .vue ----------
// scons flag 禁令扫整文件剥注释面 CODE(I2 收口;注释里提这些字样不假红,代码里真写回去照样红)。
// 同段的「不拼编译命令」「面板项来自宿主」两条未在本轮点名清单里,仍按原文扫描,勿顺手改动。
ok(!/disable_3d|module_[a-z0-9_]+_enabled|accesskit\s*=/.test(CODE), '组件里不出现任何 scons flag 名(判据不进 .vue;扫剥注释后的代码面)')
ok(!/scons\s+platform=/.test(SRC), '组件里不拼编译命令')
ok(/services\.listTemplateFeatures|props\.items/.test(SRC), '面板项来自宿主,不是本地常量')

// ---------- 点不动的两支都来自宿主(Ruling #62 的核心) ----------
const disabledName = bindingName('disabled')
const disabledBody = bodyOf(disabledName)
ok(!!disabledName && /present/.test(disabledBody) && /此版本源码无对应开关/.test(TPL),
  '探不到的项呈禁用态并给文案(:disabled 绑的那个函数真读 present)',
  disabledName ? JSON.stringify(disabledBody) : '模板里没有 :disabled="fn(...)" 绑定')
ok(/props\.suppressed/.test(SCRIPT) && /suppressed/.test(disabledBody),
  '★Ruling #62:被连带关闭的名单走 props.suppressed(宿主算),组件只当接收端',
  `props.suppressed=${/props\.suppressed/.test(SCRIPT)} / 判定链里有 suppressed=${/suppressed/.test(disabledBody)}`)
// cascadedBy 是这份源码的**静态连带结构**,一旦进判定就是 #62 修掉的那类谎:只许待在文案反查里。
const cbDefs = DECL_NAMES.map((n) => [n, defOf(n)]).filter((x) => x[1] && /cascadedBy/.test(x[1]))
ok(/cascadedBy/.test(SCRIPT) && cbDefs.length > 0 && cbDefs.every((x) => /\.label|上级选项/.test(x[1])),
  '★Ruling #62:cascadedBy 不参与任何判定,只用来把伞项的中文名说给用户',
  JSON.stringify(cbDefs.filter((x) => !/\.label|上级选项/.test(x[1])).map((x) => x[0])))
// Ruling #67:上面那条只扫**脚本**里的定义体,模板里的属性绑定一直在扫描面外。
// 复审员实测 M-TPLCASC:`:disabled="isDisabled(it) || !!it.cascadedBy"`(就是 #62 修掉的那个谎原样回归)
// → PASS 15/FAIL 0,没人喊。根因是轮 1 为 #64 做"名字无关化"时,把再上一轮那条精确属性正则
// `/:disabled="isDisabled\(it\)"/` 的牙一起丢了。收法(复审员给的)是把禁令落在**绑定**上而不是函数名上:
// 零成本、不牺牲改名自由。
// 终审 I1 收口:原正则只认 `:` / `@` 前缀,`v-` 指令(v-if / v-show / v-for / v-bind…)整类漏在扫描面外 ——
// 实测把 `:disabled="isDisabled(it)"` 换成等价的 `v-if="isDisabled(it) || !!it.cascadedBy"` 全绿
// (PASS 19/FAIL 0,对照刀 `:disabled` 版本红 1):#62 那类谎可经 v- 原样回归。扫描面现在 = 任何
// `:` / `@` 绑定**与** `v-` 指令,与本注释逐字对齐(别留"比实现宽的声称"这种自我背书)。
const bindWithCb = (TPL_CODE.match(/(?:[:@]|v-)[\w-]+\s*=\s*(?:"[^"]*"|'[^']*')/g) || []).filter((s) => /\bcascadedBy\b/.test(s))
ok(bindWithCb.length === 0,
  '★Ruling #67:模板的属性绑定里不出现 cascadedBy(静态连带结构不当作"现在点不动"的判据,绑定层也不许)',
  JSON.stringify(bindWithCb))

// ---------- 勾选框显示的是结果,不是要发出去的 flag ----------
const checkedName = bindingName('checked')
const checkedBody = bodyOf(checkedName)
ok(!!checkedName && new RegExp('\\b' + (disabledName || 'isDisabled') + '\\b|\\bpresent\\b').test(checkedBody) &&
  /props\.modelValue/.test(checkedBody) && !/cascadedBy/.test(checkedBody),
  '禁用与被抑制的项一律显示未勾选(钉定义体,不钉三元/&&/if-return 的写法)',
  JSON.stringify([checkedName, checkedBody]))

// ---------- 连带文案:两态齐备 + 真的渲染 + 绝不端出原始变量名(#63) ----------
// 连带的"两态"要齐备,而且**当前被抑制**那一态必须由宿主的名单决定(不是由静态结构决定)。
// 名单谓词的名字是**反查**出来的:谁的展开定义体里读到 props.suppressed,谁就是名单谓词 —— 纯改名不假红。
const suppressedPredicates = DECL_NAMES.filter((n) => /props\.suppressed/.test(bodyOf(n)))
const noteName = DECL_NAMES.find((n) => /上级选项/.test(defOf(n) || ''))
const noteBody = defOf(noteName) || ''
const noteLines = noteBody.split(/\r?\n/)
const curLine = noteLines.findIndex((l) => /随上级选项关闭/.test(l))
const structLine = noteLines.findIndex((l) => /时这项会一起关闭/.test(l))
ok(!!noteName && curLine >= 0 && structLine >= 0 && curLine < structLine &&
  suppressedPredicates.some((n) => new RegExp('\\b' + n + '\\s*\\(').test(noteLines[curLine])),
  '连带文案两态齐备,且「当前被抑制」那一支由 suppressed 名单决定而不是由静态结构决定',
  JSON.stringify([noteName, curLine, structLine, suppressedPredicates]))
ok(!!noteName && mustaches.some((m) => new RegExp('^\\s*' + noteName + '\\s*\\(').test(m)),
  '连带文案真的渲染到模板里(函数留着、模板那一处不渲染就是装饰)',
  JSON.stringify(mustaches))
// 插值只许出**反查到的 label**:`${it.cascadedBy}`、`${by}`(直接别名)、`${String(it.cascadedBy)}` 全抓。
const labelish = (expr) => /\.label\b/.test(expr) || (() => {
  const m = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(expr)
  const d = m ? defOf(m[1]) : null
  return !!d && /\.label\b/.test(d)
})()
const leakedInterp = interpolations.filter((e) => !labelish(e))
// 半边补齐:字符串拼接(`'（随' + it.cascadedBy + '）'`)绕过插值,所以按**行**再扫一遍 ——
// 代码里提到 cascadedBy 的行只许是「带 .label 的反查行」「存在性检查(回空串)」两类。
const leakedLines = SCRIPT.split(/\r?\n/).filter((l) => /cascadedBy/.test(l) && !/\.label|return\s*''/.test(l))
ok(interpolations.length > 0 && leakedInterp.length === 0 && leakedLines.length === 0 &&
  !/\$\{[^{}]*cascadedBy/.test(CODE) && !/\{\{[^{}]*(cascadedBy|\.flags)/.test(CODE) && /flags\.includes\(/.test(SCRIPT),
  '伞项名字来自 items 表的 label 反查;原始变量名不进插值、不进拼接、不进 mustache',
  JSON.stringify({ leakedInterp, leakedLines }))

// ---------- 其余仍要守的展示与上报 ----------
ok(/\{\{[^{}]*\[[^{}]*sizeImpact[^{}]*\][^{}]*\}\}/.test(TPL) && !/\d+(\.\d+)?\s*(MB|GB)/.test(SRC),
  '只给量级(按 sizeImpact 查表渲染),不出现 MB/GB 数字(策划书 §1 第 9 条)', JSON.stringify(mustaches))
const vfor = [...TPL.matchAll(/v-for="([^"]+)"/g)]
  .map((m) => /^\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?:,[^)]*)?\s+in\s+(.+?)\s*$/.exec(m[1]))
  .filter(Boolean)
  .map((mm) => ({ item: mm[1], list: mm[2] }))
ok(vfor.length >= 2 && vfor.some((o) => vfor.some((i) => i !== o && i.list.startsWith(o.item + '.'))) &&
  /\.group\b/.test(SCRIPT) && /<h4[^>]*>\{\{[^{}]*\}\}/.test(TPL),
  '按宿主给的 group 分区渲染(嵌套 v-for 的形状;组名、组变量名、聚合出来的那个名字都不写死)',
  JSON.stringify(vfor))
const changeName = bindingName('change')
const changeBody = defOf(changeName) || ''
ok(/emit\(\s*'update:modelValue'/.test(changeBody) && /\.\.\.\s*\(?\s*props\.modelValue/.test(changeBody) &&
  /\[[A-Za-z_$][\w$]*\.id\]/.test(changeBody) && !/props\.modelValue\[[^\]]*\]\s*=[^=]/.test(SCRIPT),
  '勾选变化以整份映射上报(v-model 锚点,T10 直接接),且不就地改 props',
  JSON.stringify([changeName, changeBody]))

// ---------- Ruling #68:「不替用户改勾选」这半句也要有护栏 ----------
// 轮 1 把判定搬到宿主之后,#62 还剩另一半语义没被钉:**被抑制项在 modelValue 里的用户选择原样保留**。
// 复审员实测 M-POLLUTE —— 在 toggle 的抑制分支里 `for (const x of (props.items||[])) if (isSuppressed(x))
// next[x.id] = false` 再整份 emit,**显示仍然正确**(checked() 对被抑制项本来就给 false),
// 上面三条正向形状全满足,反向禁令只拦"就地改 props"那种写法 → PASS 15/0。
// 这条语义正是**要交给 T10 去接的位置**,而"顺手把状态统一一下"是那里最自然的动作,所以现在就钉。
// 两条互补的钉法(名字全部反查,不写死):
//   ① 名单的直接读者只许出现在**四个展示位**::disabled 绑的判定 / :checked 绑的显示 /
//      :title 绑的悬停文案 / 连带文案函数。出现在 @change 绑的那个函数里 = 上报时拿名单改勾选。
//      (T10 若要新增第五个合法用途,例如让 .off 也跟着名单,就该**显式**把它加进这一处白名单 ——
//       红了会逼着写理由,而不是静默放行。)
//   ② 上报的 payload 里计算键**恰好一个**(被点的那一行),且它的值不许是 false 字面量。
//      这一条管的是①绕过去的形态(例如改用 `isDisabled(x)` 或就地判断 present 去批量写 false)。
const titleName = bindingName('title')
const suppressReaders = DECL_NAMES.filter((n) => /\bprops\.suppressed\b/.test(defOf(n) || ''))
const displayDefLines = new Set([disabledName, checkedName, titleName, noteName, ...suppressReaders]
  .filter(Boolean).flatMap((n) => (defOf(n) || '').split(/\r?\n/)))
const strayReaderLines = SCRIPT.split(/\r?\n/).filter((l) =>
  (/\bprops\.suppressed\b/.test(l) || suppressReaders.some((r) => new RegExp('\\b' + r + '\\b\\s*\\(').test(l))) &&
  !displayDefLines.has(l))
ok(suppressReaders.length > 0 && !!titleName && strayReaderLines.length === 0,
  '★Ruling #68①:名单谓词只出现在「禁用判定 / 勾选显示 / 悬停文案 / 连带文案」四处,上报函数里一次都不出现',
  JSON.stringify({ suppressReaders, titleName, strayReaderLines }))
// ★New-7(T10 收):被抑制行的 `.off` 淡化与禁用态**同源**(Ruling #62 的观感统一)——
// 只按 `!it.present` 判 off 时,被连带关闭的行是"灰着又亮着"的,与"点不动"的禁用态不一致。
// 名字不写死:从 :class 的绑定**表达式**里反查被调用的函数名,要求它落在
// {禁用判定} ∪ {名单读者}(等价写法 `!it.present || isSuppressed(it)` 里出现名单谓词,同样放行)。
// 把表达式改回 `off: !it.present` → 一个白名单函数都不出现 → 红。
const classExpr = (TPL_CODE.match(/:class="([^"]*)"/) || [])[1] || ''
const classCallNames = [...classExpr.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])
const disableLikeNames = new Set([disabledName, ...suppressReaders].filter(Boolean))
ok(!!disabledName && classCallNames.some((n) => disableLikeNames.has(n)),
  '★New-7:被抑制行也带 .off 淡化 —— :class 绑定里调用了禁用判定或名单谓词(改回只按 present 判 off → 红)',
  JSON.stringify({ classExpr, classCallNames, disableLikeNames: [...disableLikeNames] }))
const keyWrites = (changeBody.match(/\[[^\]\n]*\.id\]\s*[:=]/g) || []).length
const falseWrites = changeBody.match(/\[[^\]\n]*\.id\]\s*[:=][^,}\n]*\bfalse\b/g) || []
ok(keyWrites === 1 && falseWrites.length === 0,
  '★Ruling #68②:上报只写被点的那一行(计算键恰好一个)且不把任何项写成 false 字面量(不替用户改勾选)',
  JSON.stringify({ changeName, keyWrites, falseWrites }))

ok(/emit\(\s*'preset',\s*'full'\s*\)/.test(SRC) && /'lite2d'/.test(SRC) && /'minimal'/.test(SRC) && !/PRESETS/.test(SRC),
  '预设只 emit 三个名字(full/lite2d/minimal),不在本地算预设结果')
// #66 的口径 + Ruling #72 的收法:null 安全有**两种合法写法** —— 读法带兜底(`props.items || []`),
// 或在 props 声明处给默认值(`withDefaults(defineProps<…>(), { items: () => [], … })`)。
// 轮 1 要求前者逐字存在,结果复审员实测 G-withDefaults(改成默认值写法并删掉三处 `||`)反而红 1 条 ——
// 那是同一意图下更安全的一种写法,不该被红线打死。判据因此改成:
// **要么**三个读法都带兜底(现状,逐字校验不变),**要么** withDefaults 的**第二个实参**(默认值对象)
// 把这三个键都给了默认值;混着来(有一个键两样都没覆盖)就是原来的"两种口径",照样红。
// Ruling #72 的收口(T10 从轮 2 手里接下):旧判据从 `withDefaults(` 之后随手抓 600 字符,于是
// **props 的类型字面量**(`defineProps<{ … suppressed: string[] }>`)里的 `suppressed:` 就把这一格喂绿了 ——
// 实参一个默认值都不给(第二个实参是 `{}`)也照样 PASS,而 `props.suppressed.includes(...)` 会首帧 TypeError。
// 现在先把**第二个实参文本**切出来再验键,并要求工厂形状 `k: () =>`(类型字面量在切面之外,喂不进来)。
function withDefaultsSecondArg() {
  const i = SCRIPT.indexOf('withDefaults')
  if (i < 0) return ''
  const open = SCRIPT.indexOf('(', i)
  if (open < 0) return ''
  let depth = 0
  let end = -1
  for (let j = open; j < SCRIPT.length; j++) {
    const c = SCRIPT[j]
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) { end = j; break } }
  }
  if (end < 0) return ''
  // 第一个实参是 defineProps<…>():类型字面量里的 `{}` 也在括号配平里,顶层逗号切出来的就是第二个实参
  const inner = SCRIPT.slice(open + 1, end)
  let d = 0
  for (let j = 0; j < inner.length; j++) {
    const c = inner[j]
    if (c === '(' || c === '{' || c === '[') d++
    else if (c === ')' || c === '}' || c === ']') d--
    else if (c === ',' && d === 0) return inner.slice(j + 1)
  }
  return ''
}
const defaultsArg = withDefaultsSecondArg()
const defaultKeysCovered = ['items', 'modelValue', 'suppressed'].every(
  (k) => new RegExp('[\\s{,]\\s*[\'"]?' + k + '[\'"]?\\s*:\\s*\\(\\s*\\)\\s*=>').test(defaultsArg))
ok(defaultKeysCovered ||
  (!/props\.items(?!\s*\|\|\s*\[\])/.test(SCRIPT) && !/props\.modelValue(?!\s*\|\|\s*\{\})/.test(SCRIPT) &&
  !/props\.suppressed(?!\s*\|\|\s*\[\])/.test(SCRIPT) && /props\.items \|\| \[\]/.test(SCRIPT) &&
  /props\.modelValue \|\| \{\}/.test(SCRIPT) && /props\.suppressed \|\| \[\]/.test(SCRIPT)),
  '★Ruling #66/#72:props 的 items/modelValue/suppressed 三个读法要么带 null 兜底、要么在**withDefaults 第二个实参**里给工厂默认值,不留缺口',
  JSON.stringify({ defaultKeysCovered, defaultsArg: defaultsArg.slice(0, 120), reads: (SCRIPT.match(/props\.(items|modelValue|suppressed)\b[^\n]*/g) || []).slice(0, 8) }))

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
