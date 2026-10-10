// 自编译模板 · 功能面板的「判据不进 .vue」闸门(源码扫描型)。
//
// 为什么只能扫源码:.vue 要 vite + @vitejs/plugin-vue + DOM 才载得进来,本仓库的 Node harness 没有这套
// (先例:TemplateBuildWizard.vue 文件头那句「判据不进 .vue(跑不进 Node harness)」、
//  tauriShimHonesty.test.mjs 的静态扫描、buildtools.test.js 第 8 节那套「未移植方法不得假成功」)。
// 台账 deferred ⑥ 已判:不为两条断言引 vitest/jsdom(违反"不引入新依赖")。
//
// 写法纪律(本轮按 Ruling #63/#64 重写过,别再退回旧形态):
//   · 断言只钉**方向与形状**,不钉三元 / `&&` / `if-return` 的拼写,也不钉局部变量名 ——
//     函数名一律从模板绑定(`:checked` / `:disabled` / `@change`)或从文案里的承重短语**反查**得到,
//     纯改名与等价改写都该继续绿(评审员实测 M-D/M-E/F/G 四条假红就是上一轮在这里欠的)。
//   · "字样存在"不是断言:每条都配一刀**反向禁令**(错误方向不出现)+ 一刀**渲染点被钉**
//     (函数留着但那一处不渲染 = 红)。上一轮的 5/7 两条只查字样,评审员实跑 M-H/M-C/M-I 全绿,
//     所以这三条现在是:插值只许出 label、cascadedBy 不进判定、文案两态的分支来自 suppressed 名单。
//   · 扫描型断言最怕的失效模式是"删掉代码 + 在注释里补一句同样的字样"把它喂绿。这里按
//     services.test.js:352 / tauriShimHonesty.test.mjs:37 的先导**先把注释行剥掉再扫**,那条假绿就不成立了
//     (注释不进扫描面);代价是同一文件里"注释替代码作保证"也不作数 —— 代码不在就是不在。
//     剩下的天花板如实登记:字符串拼接类泄漏只认带 `cascadedBy` 标识符的那一种写法,
//     真要把原始变量名换个中间量绕过去仍然可能;要堵死它得引真正的数据流分析(= 引新工具,台账 deferred ⑥ 已判不做)。
//
// ⚠ 逐条变异自检(2026-10-10,修复轮 1;全部在仓库外的临时副本里跑,工作树未动。
//    本轮共 49 次实验:41 刀功能变异全杀红 + 8 组合法改写全绿,完整输出与逐条归属见 task-9-report.md 修复轮 1 §5)。
//    口径 = 把对应那段功能**真的拿掉/改反**(不是改注释、不是改名)→ 这条必须红:
//      1 ← 把一个开关的变量名字面量真写进组件                  → 红
//      2 ← 把编译命令行真拼进组件                              → 红
//      3 ← 面板项换成组件内的常量表(三处读法一起换)          → 红
//      4 ← 删掉 :disabled 绑定 / 删掉探不到的文案 / 判据不再读 present → 各红
//      5 ← 不读 props.suppressed(禁用名单本地硬编)            → 红
//      6 ← isDisabled 改回 `!present || !!it.cascadedBy`        → 红(#62 的回归刀)
//      7 ← checked 丢掉禁用支 / 把冻结简报 :86 那行照抄回来    → 各红
//      8 ← 删掉两态其中一支 / 当前态改由 cascadedBy 决定        → 各红
//      9 ← 函数留着、模板里那个 <em> 删掉(M-I)                → 红
//     10 ← 命中支直出原始变量名(M-H)/ 退化支带上别名(M-C)/
//          退化支改用字符串拼接                                → 各红
//     11 ← 量级换成具体 MB 数字 / 删掉查表直接输出枚举          → 各红
//     12 ← 分区拉平(内层直接吃 props.items)                  → 红
//     13 ← 上报丢掉 spread / 干脆就地改 props                  → 各红
//     14 ← 三档名字被改('minimal' → 'min')                    → 红
//     15 ← 去掉任一 `|| []` / `|| {}` 的 null 兜底              → 红
//    对照组(合法改写**不该**红,Ruling #64 要收掉的就是这些假红):checked 改 if-return、checked 改
//    `&&` 写法、grouped 纯改名、SIZE_LABEL 纯改名、isDisabled 纯改名、cascadeNote 纯改名、
//    isSuppressed 纯改名 —— 七条实测全绿。
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
const SCRIPT_RAW = SRC.slice(SRC.indexOf('<script'), SRC.indexOf('</script>'))
const SCRIPT = SCRIPT_RAW.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')
const TPL = SRC.slice(SRC.indexOf('<template>', SRC.indexOf('</script>')), SRC.lastIndexOf('</template>'))

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
ok(!/disable_3d|module_[a-z0-9_]+_enabled|accesskit\s*=/.test(SRC), '组件里不出现任何 scons flag 名(判据不进 .vue)')
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
  !/\$\{[^{}]*cascadedBy/.test(SRC) && !/\{\{[^{}]*(cascadedBy|\.flags)/.test(SRC) && /flags\.includes\(/.test(SCRIPT),
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
ok(/emit\(\s*'preset',\s*'full'\s*\)/.test(SRC) && /'lite2d'/.test(SRC) && /'minimal'/.test(SRC) && !/PRESETS/.test(SRC),
  '预设只 emit 三个名字(full/lite2d/minimal),不在本地算预设结果')
// #66:同一文件不许两种口径 —— items/suppressed 防了、modelValue 没防,首帧 modelValue 就可能是 undefined。
ok(!/props\.items(?!\s*\|\|\s*\[\])/.test(SCRIPT) && !/props\.modelValue(?!\s*\|\|\s*\{\})/.test(SCRIPT) &&
  !/props\.suppressed(?!\s*\|\|\s*\[\])/.test(SCRIPT) && /props\.items \|\| \[\]/.test(SCRIPT) &&
  /props\.modelValue \|\| \{\}/.test(SCRIPT) && /props\.suppressed \|\| \[\]/.test(SCRIPT),
  '★Ruling #66:props 的数组/映射读法一律 null 安全,同文件不留两种口径',
  JSON.stringify((SCRIPT.match(/props\.(items|modelValue|suppressed)\b[^\n]*/g) || []).slice(0, 8)))

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
