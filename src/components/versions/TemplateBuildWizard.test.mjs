// 自编译模板 · 向导接线的闸门(源码扫描型)。
//
// 为什么只能扫源码:.vue 要 vite + @vitejs/plugin-vue + DOM 才载得进来,本仓库的 Node harness 没有这套
// (先例:同目录 TemplateFeaturePanel.test.mjs 头部;台账 deferred ⑥ 已判不为两条断言引新依赖)。
//
// 这份闸门守五件事(每条断言都做过「拿掉对应实现就要红」的变异自检,逐条见 task-10-report.md §变异表):
//   1. 两处入口与标题去「2D」、命令预览配新口径(简报 Step 1/4 + Ruling #76);
//   2. 面板接线:items / 勾选态 / 探测版本 / 被连带名单,四个锚点全部来自宿主的活数据;
//   3. 校验分流:发起前走宿主 validateTemplateConfig,硬拦不给编、软问题带「仍然继续」(简报 Step 3);
//   4. Ruling #74/#75/#77:mode 由宿主给且两个调用点同值、勾选变化去抖重算、列表 key 用复合键;
//   5. 修复轮 1(Ruling #80–#83):发起编译的重入闸、三处过时恢复闸、预设错误位与面板错误位分离、buildErr 随目录清空;
//   6. 终审修复波:C1(换目录即把 mode 复位 default-on —— 该状态迁移扫描结构上看不见,由真机条目 T21 兜底)、
//      T10-①(srcDirVar 反查改走 pickDirectory → @click → v-model 链,不再锚「源码根」文案)、
//      T10-②(watch 形态认 ref 直传与 `() => srcDir.value` 两种等价写法)。
//
// 写法纪律(沿用 TemplateFeaturePanel.test.mjs 的轮 2 口径):
//   · 断言只钉**方向与形状**,函数名/变量名一律从模板绑定或赋值处**反查**,改名与等价写法都该继续绿;
//   · 注释不进扫描面(整行 / 行尾 `//` / HTML 注释)—— **含"不许出现"的禁令一律扫剥过的 W_CODE/V_CODE**
//     (Ruling #79 收口;此前 :124/:130 扫原文,向导里加一句解释注释就假红,与这句声称不符)。
//     **唯二继续扫原文**的是 build_profile= 的计数(:132,台账点名保留)与 #76 的反向禁令(:135)——
//     那句作废承诺恰恰以"假背书注释"的形态祸害过一轮,所以连注释一起禁(注释与文案都不许再说)。
// 用法: node src/components/versions/TemplateBuildWizard.test.mjs
import fs from 'node:fs'

const W_RAW = fs.readFileSync('src/components/versions/TemplateBuildWizard.vue', 'utf8')
const V = fs.readFileSync('src/views/VersionsView.vue', 'utf8')

let pass = 0
const failures = []
const ok = (c, l, e) => { if (c) { pass++; console.log(`  PASS  ${l}`) } else { failures.push(l); console.log(`  FAIL  ${l}${e !== undefined ? '  → ' + e : ''}`) } }

// ---------- 取 SFC 的两段(注释剥法沿用面板那份:整行 / 行尾 `//` / 同行 `/* */`) ----------
const stripTailComments = (l) => l.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/g, '$1')
const SCRIPT_RAW = W_RAW.slice(W_RAW.indexOf('<script'), W_RAW.indexOf('</script>'))
const SCRIPT = SCRIPT_RAW.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).map(stripTailComments).join('\n')
const TPL = W_RAW.slice(W_RAW.indexOf('<template>', W_RAW.indexOf('</script>')), W_RAW.lastIndexOf('</template>'))
const TPL_CODE = TPL.replace(/<!--[\s\S]*?-->/g, '')

// ---------- Ruling #79:剥注释后的整文件扫描面(第 1/2 节的禁令用它,别再退回原文扫描) ----------
// 评审员实测:向导里加一句**纯解释注释**(`// 注意:disable_3d 这类核心开关由宿主以 token 追加在命令行上`)
// → :130 扫原文 W_RAW 时红,失败文案还说"向导里不再有写死的裁剪参数" —— 把注释当代码,不属实。
// 剥法与上面的 SCRIPT/TPL_CODE 同源(整行 / 行尾 `//` / 同行 `/* */` / HTML 注释),只是把一份 .vue 的
// 脚本段与模板段合成一个扫描面;VersionsView.vue 的对应断言(V_CODE)同口径。
const sfcCode = (raw) => {
  const scriptRaw = raw.slice(raw.indexOf('<script'), raw.indexOf('</script>'))
  const script = scriptRaw.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).map(stripTailComments).join('\n')
  const tpl = raw.slice(raw.indexOf('<template>', raw.indexOf('</script>')), raw.lastIndexOf('</template>'))
  return script + '\n' + tpl.replace(/<!--[\s\S]*?-->/g, '')
}
const W_CODE = sfcCode(W_RAW)
const V_CODE = sfcCode(V)

// ---------- 名字反查工具(与 TemplateFeaturePanel.test.mjs 同一套,decl 正则多认 async/export) ----------
const balanced = (l) => { let d = 0; for (const c of l) { if (c === '(' || c === '{' || c === '[') d++; else if (c === ')' || c === '}' || c === ']') d-- } return d === 0 }
function defOf(name) {
  if (!name) return null
  const lines = SCRIPT.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*)(?:export\s+)?(?:async\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)\b/.exec(lines[i])
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
const DECL_NAMES = [...SCRIPT.matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
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
/** 声明体的函数名单:谁的 defOf 里调用了该方法,谁就是接线函数 */
const declOf = (re) => DECL_NAMES.find((n) => re.test(defOf(n) || ''))
/** 找到含 needle 的那个 <button>…</button> 文本(用于从绑定反查处理函数名) */
function buttonAt(needle) {
  const i = TPL_CODE.indexOf(needle)
  if (i < 0) return ''
  const s = TPL_CODE.lastIndexOf('<button', i)
  const e = TPL_CODE.indexOf('</button>', i)
  return (s >= 0 && e > s) ? TPL_CODE.slice(s, e) : ''
}
const clickNameOf = (btn) => { const m = /@click="\s*([A-Za-z_$][\w$]*)/.exec(btn); return m ? m[1] : '' }
/** 取某方法调用点的对象字面量实参文本(单层 {} —— 有嵌套就是写法变了,切不开,后面的断言会照红) */
const argsOf = (method) => {
  const m = new RegExp('services\\.' + method + '\\s*\\(\\s*\\{([\\s\\S]{0,400}?)\\}').exec(SCRIPT)
  return m ? m[1] : ''
}

// ---------- 反查承重标识符(全部来自模板绑定与赋值处,改名不假红) ----------
const panelUse = /<TemplateFeaturePanel\b([\s\S]*?)\/>/.exec(TPL_CODE)
const panelAttrs = panelUse ? panelUse[1] : ''
const featuresVar = (panelAttrs.match(/v-model="([A-Za-z_$][\w$]*)"/) || [])[1] ||
  // 等价写法:显式 :model-value + @update:model-value 也算双向绑定
  (panelAttrs.match(/:model-value="([A-Za-z_$][\w$]*)"/) || [])[1] || ''
const suppressedBound = (panelAttrs.match(/:suppressed="\s*([A-Za-z_$][\w$]*)/) || [])[1] || ''

const listFn = declOf(/listTemplateFeatures\s*\(/)
const listBody = defOf(listFn) || ''
const listRes = (/([A-Za-z_$][\w$]*)\s*=\s*await[\s\S]{0,80}?listTemplateFeatures\s*\(/.exec(listBody) || [])[1] || ''
const valFn = declOf(/services\.validateTemplateConfig\s*\(/)
const valBody = defOf(valFn) || ''
const valRes = (/([A-Za-z_$][\w$]*)\s*=\s*await[\s\S]{0,120}?validateTemplateConfig\s*\(/.exec(valBody) || [])[1] || ''
const applyFn = declOf(/applyTemplatePreset\s*\(/)
const applyBody = defOf(applyFn) || ''
const modeVar = (/([A-Za-z_$][\w$]*)\.value\s*=[^=\n]*\.mode\b/.exec(applyBody) || [])[1] || ''

const vtcArgs = argsOf('validateTemplateConfig')
const btpArgs = argsOf('buildTemplatePack')
const presetHandler = (panelAttrs.match(/@preset="\s*([A-Za-z_$][\w$]*)/) || [])[1] || ''
const buildBtn = buttonAt('开始编译')
const buildClick = clickNameOf(buildBtn)
const contBtn = buttonAt('仍然继续')
const contClick = (contBtn.match(/@click="\s*([A-Za-z_$][\w$]*)\s*=\s*true"/) || [])[1] || ''

const stateOf = (key) => (valRes ? ((new RegExp('([A-Za-z_$][\\w$]*)\\.value\\s*=\\s*' + valRes + '\\.' + key + '\\b').exec(valBody) || [])[1] || '') : '')
const hardVar = stateOf('hardBlocks')
const softVar = stateOf('issues')
const supVar = stateOf('suppressed')
const ulBlock = (stateName) => {
  if (!stateName) return ''
  const m = new RegExp('<ul[^>]*v-if="' + stateName + '\\.length"[^>]*>([\\s\\S]*?)</ul>').exec(TPL_CODE)
  return m ? m[1] : ''
}
const hardUl = ulBlock(hardVar)
const softUl = ulBlock(softVar)

console.log('\n=== 1. 两处入口与标题去「2D」(简报 Step 1/4) ===')
ok(!/2D\s*模板|自编译\s*2D/.test(W_CODE) && !/2D\s*模板|自编译\s*2D/.test(V_CODE),
  '两处入口与标题都不再出现「2D 模板」—— 扫剥注释后的代码面(Ruling #79;把标题或按钮文字改回去 → 红,写解释注释不红)')
ok(/自编译模板\s*·\s*\{\{\s*tag\s*\}\}/.test(TPL) && /自编译模板\s*<\/button>/.test(V),
  '新标题是「自编译模板 · {{ tag }}」、入口按钮是「自编译模板」(正例;删掉/改回 → 红)')

console.log('\n=== 2. 命令预览的新口径(Ruling #76) ===')
ok(!/disable_3d|module_[a-z0-9_]+_enabled|accesskit\s*=|d3d12\s*=/.test(W_CODE),
  '向导里不再有写死的裁剪参数 —— 扫剥注释后的代码面(Ruling #79;把旧的 disable_3d=yes 那份复制品写回代码 → 红,写解释注释不红)')
// 下面两条继续扫原文(W_RAW),是"注释不进扫描面"的例外清单(台账/裁定点名保留,勿动):
//   :132 是 build_profile= 的**计数** —— 注释里出现第二次也算第二处,计数面就必须是原文;
//   :135 是 #76 的反向禁令 —— 那句作废承诺恰恰以假背书注释的形态祸害过,注释里出现也要红。
ok((W_RAW.match(/build_profile=/g) || []).length === 1 &&
  /scons platform=windows target=template_release build_profile=/.test(W_RAW),
  '预览仍是一行 scons 示意形状,且 build_profile= 只出现一次(删掉预览/复制到第二处 → 红)')
ok(!/恒为一行|不随勾选/.test(W_RAW),
  '★Ruling #76:注释与文案都不再声称「恒为一行 / 不随勾选变」(把这句作废承诺写回去 → 红,注释也算)')
ok(/另有[^<>{}]*按你的勾选[^<>{}]*命令行/.test(TPL_CODE),
  '★Ruling #76:用户可见文案明说还有编译选项按勾选下发(删掉这行提示 → 红)')

console.log('\n=== 3. 面板接线:四个锚点都来自宿主 ===')
ok(/import TemplateFeaturePanel from '\.\/TemplateFeaturePanel\.vue'/.test(SCRIPT) && !!panelUse,
  '第二步嵌入面板(import 或模板里那一处删掉 → 红)')
ok(!!featuresVar && /:items="/.test(panelAttrs) && /:source-version="/.test(panelAttrs) && /:tested="/.test(panelAttrs),
  '勾选态双向绑定 + items / source-version / tested 三个锚点都接上(漏任一 → 红)',
  JSON.stringify({ featuresVar, attrs: panelAttrs.replace(/\s+/g, ' ').slice(0, 160) }))
ok(!!presetHandler && /applyTemplatePreset/.test(bodyOf(presetHandler)),
  '★Ruling #74:预设点击走宿主 applyTemplatePreset(在组件里自己算预设 → 红)')
ok(!!listFn && !!listRes && new RegExp('!\\s*' + listRes + '\\.ok\\b').test(listBody),
  '★§5.2:面板数据来自宿主探测,且据 ok:false 拒绝进面板(把 !ok 分支删掉、静默进空面板 → 红)')
const listErrVar = listRes ? ((new RegExp('([A-Za-z_$][\\w$]*)\\.value\\s*=\\s*' + listRes + '\\.error').exec(listBody) || [])[1] || '') : ''
ok(!!listErrVar && new RegExp('v-if="' + listErrVar + '"').test(TPL_CODE) && new RegExp('\\{\\{\\s*' + listErrVar + '\\s*\\}\\}').test(TPL_CODE),
  '★拒绝进面板时把原因显示出来(函数里接了 error 但模板不渲染 = 静默;删任一处 → 红)', JSON.stringify({ listErrVar }))
ok(!!listRes && new RegExp(listRes + '\\.items\\s*\\?\\?\\s*\\[\\s*\\]').test(listBody),
  '失败分支不带 items、垫片给 [] → 向导统一写 `r.items ?? []`(按一端假设取值 → 红)')

console.log('\n=== 4. 校验分流:硬拦不给编、软问题可越过(简报 Step 3) ===')
ok(!!valFn && !!valRes, '校验走宿主 validateTemplateConfig(整段删掉 → 红)', String(valFn))
ok(!!valRes && ['issues', 'hardBlocks', 'suppressed'].every((k) => new RegExp(valRes + '\\.' + k + '\\b').test(valBody)),
  '★Ruling #62/#75:issues / hardBlocks / suppressed 三份一起更新(漏任一份 → 红)',
  JSON.stringify({ valRes, hardVar, softVar, supVar }))
const buildBody = defOf(buildClick) || ''
ok(!!buildClick && /validateTemplateConfig/.test(bodyOf(buildClick, 2)),
  '★发起编译前走宿主校验(把校验从「开始编译」的点击链上摘掉 → 红)', String(buildClick))
ok(!!hardVar && new RegExp('\\b' + hardVar + '\\b[\\s\\S]{0,60}?return').test(buildBody) &&
  buildBody.indexOf(hardVar) < buildBody.indexOf('startBuild'),
  '★硬拦时直接 return、不落到 startBuild(把这道早退删掉 → 红)', JSON.stringify({ hardVar, buildClick }))
ok(!!softVar && !!contClick && new RegExp('\\b' + contClick + '\\b').test(buildBody),
  '★软问题要用户先看过:确认位由「仍然继续」置位,且同一个位出现在点击链的门上(两处名字对不上 → 红)',
  JSON.stringify({ softVar, contClick }))
ok(!!hardUl && !/仍然继续/.test(hardUl),
  '★硬拦列表里没有「仍然继续」(硬拦没有越过路径;把按钮搬进硬拦列表 → 红)')
ok(!!softUl && /\.why/.test(softUl) && /\.action/.test(softUl) && /仍然继续/.test(softUl),
  '★软问题逐条渲染 why/action 且每行带「仍然继续」(删按钮或删字段 → 红)')
ok(!!buildBtn && /:disabled="/.test(buildBtn) && !!hardVar && buildBtn.includes(hardVar + '.length'),
  '★Ruling #75:按钮禁用态是活的(读硬拦/软问题那份状态;删 :disabled 或改成常量 → 红)')
// 入队被同步拒(版本闸形态不符 / 空间不足等)时那句原因必须露出来:不静默、不假成功。
// (简报 Step 3 的片段在这里是静默 return;T7 的版本闸专门文案若不摆出来,用户看到的就是"点了没反应"。)
const buildFn = declOf(/services\.buildTemplatePack\s*\(/)
const buildFnBody = defOf(buildFn) || ''
const btpRes = (/([A-Za-z_$][\w$]*)\s*=\s*await[\s\S]{0,120}?buildTemplatePack\s*\(/.exec(buildFnBody) || [])[1] || ''
const buildErrVar = btpRes ? ((new RegExp('([A-Za-z_$][\\w$]*)\\.value\\s*=\\s*' + btpRes + '\\.error').exec(buildFnBody) || [])[1] || '') : ''
ok(!!buildErrVar && new RegExp('v-if="' + buildErrVar + '"').test(TPL_CODE) && new RegExp('\\{\\{\\s*' + buildErrVar + '\\s*\\}\\}').test(TPL_CODE),
  '入队被同步拒时把宿主那句原因渲染出来(去掉展示 → 红;版本闸的专门文案就靠这一处露面)',
  JSON.stringify({ btpRes, buildErrVar }))

console.log('\n=== 5. Ruling #74:mode 由宿主给,两个调用点必须同值 ===')
const modeDecl = modeVar ? ((new RegExp('(?:const|let)\\s+' + modeVar + '\\s*=[^\\n]*').exec(SCRIPT) || [''])[0]) : ''
ok(!!modeVar && /['"]default-on['"]/.test(modeDecl),
  '★Ruling #74:预设返回的 mode 存进状态量,未选预设时默认 default-on(不存或默认值改了 → 红)',
  JSON.stringify({ modeVar, modeDecl: modeDecl.slice(0, 120) }))
const modeIn = (args) => !!modeVar && !!args && new RegExp('mode:\\s*' + modeVar + '\\.value\\b').test(args)
ok(modeIn(vtcArgs) && modeIn(btpArgs),
  '★Ruling #74:validateTemplateConfig 与 buildTemplatePack 拿到的是**同一个** mode 状态量(任一处漏传/换字面量 → 红;两处不同 = 校验的不是将要发出去的产物)',
  JSON.stringify({ modeVar, vtcHasMode: modeIn(vtcArgs), btpHasMode: modeIn(btpArgs) }))
ok(!!featuresVar && new RegExp('features:\\s*' + featuresVar + '\\.value\\b').test(vtcArgs) &&
  new RegExp('features:\\s*' + featuresVar + '\\.value\\b').test(btpArgs),
  '校验与编译用的是面板勾选那一份(换成别的对象/漏传 → 红)')
ok(/tag:\s*(?:props\.tag|\btag\b)/.test(btpArgs) && !/\bbeta\b|\brc\d\b|-stable/.test(SCRIPT),
  'tag 原样交给宿主(版本闸与专门文案在 buildtools);向导自己不判 tag 形态(加 props.tag.includes("beta") 之类分支 → 红)')

console.log('\n=== 6. Ruling #75:勾选变化去抖重算被连带名单 ===')
const watchOnFeatures = featuresVar
  ? new RegExp('watch\\(\\s*\\[?[^\\]]{0,40}?' + featuresVar + '[^\\]]{0,40}?,\\s*([A-Za-z_$][\\w$]*)\\s*\\)').exec(SCRIPT)
  : null
const watchCb = watchOnFeatures ? watchOnFeatures[1] : ''
const watchCbBody = watchCb ? bodyOf(watchCb, 3) : ''
ok(!!featuresVar && !!watchCb && /setTimeout/.test(watchCbBody) && /validateTemplateConfig/.test(watchCbBody),
  '★Ruling #75:watch 勾选态 → 去抖 → 校验(删掉 watch / 直接调不走去抖 / 去抖不接校验 → 各红)',
  JSON.stringify({ featuresVar, watchCb, hasTimer: /setTimeout/.test(watchCbBody), reachesValidate: /validateTemplateConfig/.test(watchCbBody) }))
ok(!!supVar && suppressedBound === supVar,
  '★Ruling #75/#62:面板 :suppressed 绑的就是校验返回的那份名单(名字必须对得上;删掉绑定/改绑别的变量 → 红)',
  JSON.stringify({ supVar, suppressedBound }))

console.log('\n=== 7. Ruling #77:两个 <ul> 的 :key 不许只用 itemId ===')
// 证据:T6 的硬拦 roster 实测 ['source|', 'source|modules_enabled_by_default', 'vulkan|vulkan']
// —— 硬拦里两条的 itemId 都是 'source',只用 itemId 会直接撞 key。
const keyOf = (block) => { const m = /<li[^>]*:key="([^"]+)"/.exec(block); return m ? m[1] : '' }
const compositeKey = (expr) => {
  const t = expr.trim()
  if (!t) return false
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return true // 「或直接 index」那一支:纯循环下标变量
  return t.includes('+') && /\.itemId\b/.test(t) && /\.flag\b/.test(t)
}
ok(compositeKey(keyOf(hardUl)) && compositeKey(keyOf(softUl)),
  '★Ruling #77:两条列表的 :key 都是复合键(含 itemId+flag)或 index(把 :key 改回 b.itemId → 红)',
  JSON.stringify({ hard: keyOf(hardUl), soft: keyOf(softUl) }))

console.log('\n=== 8. 修复轮 1:Ruling #80–#83 的四道闸(每条都有一刀"拿掉什么会红"的故事) ===')
// 四道闸都在 Ruling #80–#83 里点名:重入闸(双击起两条编译)、三处过时恢复闸(旧结果盖新状态)、
// 预设错误位单独渲染、buildErr 随目录清空。判定一律形状级(名字反查),别钉具体拼写。

/** 反查源码输入框双向绑定的那个状态量(凡说"当前目录"的闸都拿它比对;改名不假红)。
 *  T10-① 收口:原先锚在用户可见标签文案「源码根」上 —— 改文案会假红 4 条(终审实测)。
 *  现在从**绑定**反查:先找调 pickDirectory 的那个处理函数,再找它的 @click 按钮,
 *  同一条 label 里按钮之前最近的那个 v-model 就是源码输入框(与文案无关)。 */
const srcDirVar = (() => {
  const pickFn = declOf(/pickDirectory\s*\(/)
  if (!pickFn) return ''
  const at = TPL_CODE.search(new RegExp('@click="\\s*' + pickFn + '\\b'))
  if (at < 0) return ''
  const m = [...TPL_CODE.slice(0, at).matchAll(/v-model="([A-Za-z_$][\w$]*)"/g)].pop()
  return m ? m[1] : ''
})()

/** 取某方法调用点之后的文本(括号配平找调用的收尾)—— 用来钉"闸在 await 之后" */
const afterCall = (body, method) => {
  const i = body.indexOf(method + '(')
  if (i < 0) return ''
  let d = 0
  for (let j = body.indexOf('(', i); j < body.length; j++) {
    const c = body[j]
    if (c === '(') d++
    else if (c === ')') { d--; if (d === 0) return body.slice(j + 1) }
  }
  return ''
}
/** 「请求时的值 vs 当前状态」的比对闸:同一段文本里既有比较运算符、又提到当前状态量(dir 或勾选) */
const staleGate = (tail) => !!tail && /!==?|===?/.test(tail) && !!srcDirVar &&
  new RegExp('\\b(?:' + srcDirVar + '|' + featuresVar + ')\\.value\\b').test(tail)

// #80:「开始编译」的重入闸 —— 处理函数先看到一个「在途」标志就早退,该标志在第一个 await 前置位、
// finally 复位;三处引用同一个名字(早退检查 / 置 true / finally 置 false),名字不写死。
const gateName = (() => {
  const m = new RegExp('if\\s*\\(\\s*([A-Za-z_$][\\w$]*)(?:\\.value)?\\s*\\)\\s*(?:\\{[\\s\\S]{0,80}?\\breturn\\b|return\\b)').exec(buildBody)
  return m ? m[1] : ''
})()
const gateSetIdx = gateName ? buildBody.search(new RegExp('\\b' + gateName + '(?:\\.value)?\\s*=\\s*true')) : -1
const gateReset = gateName ? new RegExp('finally[\\s\\S]{0,60}?\\b' + gateName + '(?:\\.value)?\\s*=\\s*false').test(buildBody) : false
ok(!!gateName && gateSetIdx >= 0 && gateSetIdx < buildBody.indexOf('await') && gateReset,
  '★Ruling #80:「开始编译」重入闸:先判在途早退、await 前置位、finally 复位三处同名(删掉任一处 → 红;双击不再起两条编译)',
  JSON.stringify({ gateName, gateSetIdx, firstAwait: buildBody.indexOf('await'), gateReset }))

// #81 三处过时恢复闸:请求时快照的值,响应回来时与当前状态比对,不一致就丢弃这条响应。
const valTail = afterCall(valBody, 'validateTemplateConfig')
ok(staleGate(valTail),
  '★Ruling #81:两次在途校验只让"与当前 dir/勾选 一致"的那份落地(把闸删掉 → 红;谁后返回谁赢 = 旧结果盖新状态)',
  JSON.stringify({ valTail: (valTail || '').slice(0, 120).replace(/\n/g, ' ') }))
const applyTail = afterCall(applyBody, 'applyTemplatePreset')
ok(staleGate(applyTail),
  '★Ruling #81:预设连点只让最后一次的响应落地(把闸删掉 → 红;旧预设结果不许盖新勾选)',
  JSON.stringify({ applyTail: (applyTail || '').slice(0, 120).replace(/\n/g, ' ') }))
const probeTail = afterCall(listBody, 'probeTemplateSource')
ok(staleGate(probeTail),
  '★Ruling #81:拉面板的第二段 await(探测)回来后还要再过一次「dir 仍是当前值」的闸(删掉 → 红;与第一段同口径,两段都设防)',
  JSON.stringify({ probeTail: (probeTail || '').slice(0, 120).replace(/\n/g, ' ') }))

// #82:预设失败写的是**单独**的错误位,且真的渲染 —— 与决定面板可见性的那个错误位共用的那天,
// 一次预设失败会把整块面板与「开始编译」一起藏掉(用户想重试得先去动输入框)。
const applyRes = (/([A-Za-z_$][\w$]*)\s*=\s*await[\s\S]{0,120}?applyTemplatePreset\s*\(/.exec(applyBody) || [])[1] || ''
const presetErrVar = applyRes ? ((new RegExp('([A-Za-z_$][\\w$]*)\\.value\\s*=\\s*' + applyRes + '\\.error').exec(applyBody) || [])[1] || '') : ''
ok(!!presetErrVar && presetErrVar !== listErrVar &&
  new RegExp('v-if="' + presetErrVar + '"').test(TPL_CODE) && new RegExp('\\{\\{\\s*' + presetErrVar + '\\s*\\}\\}').test(TPL_CODE),
  '★Ruling #82:预设失败写单独的错误位并渲染那行字(与决定面板可见性的 error 位共用 → 面板与「开始编译」一起消失;合并回去/删渲染 → 红)',
  JSON.stringify({ presetErrVar, panelErrVar: listErrVar }))

// #83:上一轮的同步拒绝原因(buildErr)不许跨目录挂着 —— watch(srcDir) 或 loadPanel 里清一行。
// T10-② 收口:原先钉成 `watch(<srcDirVar>,` 字面,等价的 getter 写法 `watch(() => srcDir.value, cb)`
// 假红 1 条(终审实测)。两种都是 Vue 的合法写法,形状判定都认;名字仍从绑定反查,不写死。
const srcWatchIdx = srcDirVar
  ? SCRIPT.search(new RegExp('watch\\(\\s*(?:\\[?\\s*' + srcDirVar + '\\b|\\(\\s*\\)\\s*=>\\s*' + srcDirVar + '\\.value\\b)'))
  : -1
const srcWatchEnd = srcWatchIdx >= 0 ? (() => { const n = SCRIPT.indexOf('watch(', srcWatchIdx + 6); return n > srcWatchIdx ? n : SCRIPT.length })() : -1
const srcWatchSeg = srcWatchIdx >= 0 ? SCRIPT.slice(srcWatchIdx, srcWatchEnd) : ''
const clearRe = buildErrVar ? new RegExp('\\b' + buildErrVar + "\\.value\\s*=\\s*['\"]['\"]") : null
ok(srcWatchIdx >= 0 && !!clearRe && (clearRe.test(srcWatchSeg) || clearRe.test(listBody)),
  '★Ruling #83:换源码目录即清上一轮的同步拒绝原因(watch(srcDir) 的开头或 loadPanel 里清一行;删掉 → 红)',
  JSON.stringify({ srcDirVar, buildErrVar, watchSeg: srcWatchSeg.slice(0, 60).replace(/\n/g, ' ') }))

// C1(整分支终审,必修):mode 必须随换目录复位 —— "选目录 A → 点最小可跑(mode=default-off)→ 换目录 B"
// 这条**状态迁移**扫描型 harness 结构上看不见;能钉的是"复位这一行真的在 watch(srcDir) 段里"。
// 缺了它的后果:features 回到全默认而 mode 还是 default-off → validateSelection 一条都不报
// (硬拦 3 要求点名数 > 0,全默认恰好绕过),buildProfile 却带 modules_enabled_by_default=no
// 把表外模块(GDScript / freetype / text_server_adv / glslang 等)整体关掉。
// 名字不写死:modeVar 从 applyPreset 的赋值处反查(改名不假红);真机兜底条目 = manual-verification.md T21。
const modeResetRe = modeVar ? new RegExp('\\b' + modeVar + "\\.value\\s*=\\s*['\"]default-on['\"]") : null
ok(!!modeVar && !!modeResetRe && modeResetRe.test(srcWatchSeg),
  '★C1:watch(srcDir) 里把编译模式复位回 default-on(预设的 default-off 不跟着新目录跑;把这行删掉 → 红)',
  JSON.stringify({ srcDirVar, modeVar, watchSeg: srcWatchSeg.slice(0, 200).replace(/\n/g, ' ') }))

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
