// 自编译模板 · 功能面板的「判据不进 .vue」闸门(源码扫描型)。
//
// 为什么只能扫源码:.vue 要 vite + @vitejs/plugin-vue + DOM 才载得进来,本仓库的 Node harness 没有这套
// (先例:TemplateBuildWizard.vue 文件头那句「判据不进 .vue(跑不进 Node harness)」、
//  tauriShimHonesty.test.mjs 的静态扫描、buildtools.test.js 第 8 节那套「未移植方法不得假成功」)。
//
// ⚠ 扫描型断言的失效模式:在实现里**加一句注释**就能把它喂绿。所以每条都做过变异自检,
//    自检口径是「把对应那段功能真的拿掉(不是改注释、不是改变量名)→ 这条必须红」。实测结果
//    (2026-10-11,在仓库外的临时副本里改,工作树未动,详见 task-9-report.md 的变异表):
//      1 ← 把表内某个开关的变量名字面量真写进组件        → 红
//      2 ← 把编译命令行真拼进组件                        → 红
//      3 ← 面板项换成组件内的常量表(删掉对 props 的读)  → 红
//      4 ← 删掉探不到那一项的禁用绑定与文案              → 红
//      5 ← 删掉连带标注(函数 + 模板里那一处)            → 红
//      6 ← 勾选态改回「连带即显示已勾选」那种写法        → 红
//      7 ← 连带文案改成直接渲染宿主给的那个变量名        → 红
//      8 ← 量级换成具体 MB 数字                          → 红
//      9 ← 分区渲染拉平成单列(删掉分组那步)            → 红
//     10 ← 勾选变化不再以整份映射上报                    → 红
//     11 ← 预设按钮变成本地算勾选结果 / 三档名字被改     → 红
//
// 断言 6/7/9/10/11 守的是本任务派发词点名的行为(台账 Ruling #7、cascadedBy 反查、T10 的两个锚点)。
// 简报 Step 1 原写 7 条,其中「硬拦分流由宿主算」是恒真式(`A || A === false`),按 Ruling #6 删掉且**不补**
// 替代断言 —— 硬拦分流归 T10 的向导测试覆盖,面板不该认识它。所以基线是简报 6 条 + 上面这 5 条。
//
// ⚠ 第 5 条(连带标注)是靠「随」这个字观察文案还在的,所以组件里那个字**只许出现在 cascadeNote
//    那句 return 的文案里**;注释、title、图例里再写一次,连带标注被整段删掉后这条照样会绿 ——
//    那就退化成装饰了(实测:M5 删掉函数与模板那一处 → 第 5、7 两条同时红)。
//
// 用法: node src/components/versions/TemplateFeaturePanel.test.mjs
import fs from 'node:fs'
const SRC = fs.readFileSync('src/components/versions/TemplateFeaturePanel.vue', 'utf8')
let pass = 0
const failures = []
const ok = (c, l, e) => { if (c) { pass++; console.log(`  PASS  ${l}`) } else { failures.push(l); console.log(`  FAIL  ${l}${e !== undefined ? '  → ' + e : ''}`) } }

// ---------- 红线:判据不进 .vue ----------
ok(!/disable_3d|module_[a-z0-9_]+_enabled|accesskit\s*=/.test(SRC), '组件里不出现任何 scons flag 名(判据不进 .vue)')
ok(!/scons\s+platform=/.test(SRC), '组件里不拼编译命令')
ok(/services\.listTemplateFeatures|props\.items/.test(SRC), '面板项来自宿主,不是本地常量')

// ---------- 宿主给的三种状态必须如实显示 ----------
ok(/present/.test(SRC) && /:disabled="isDisabled\(it\)"/.test(SRC) && /此版本源码无对应开关/.test(SRC), '探不到的项呈禁用态并给文案')
ok(/cascadedBy/.test(SRC) && /随/.test(SRC), '连带项标「随 <伞项> 关闭」而不是自己判')
// Ruling #7:连带项显示**未勾选**(勾选框显示结果,不是发出去的 flag)。
// 前半支钉住实现里的禁用支给 false;后半支挡「把冻结简报里那行错代码照抄回来」。
ok(/isDisabled\(it\)\s*\?\s*false/.test(SRC) && !/it\.present\s*\?\s*!!it\.cascadedBy/.test(SRC), '连带与禁用项一律显示未勾选(Ruling #7 的方向)')
// 宿主交出来的 cascadedBy 是构建变量的名字,不是面板项 id → 展示层反查成伞项中文名;
// 反查不到退化成不带名字的文案。绝不把原始变量名端给用户(这是查表,不是判据)。
ok(/flags\.includes\(/.test(SRC) && /上级选项/.test(SRC), '连带标注反查伞项 label,不渲染原始 flag 名')
ok(/SIZE_LABEL\[it\.sizeImpact\]/.test(SRC) && !/\d+(\.\d+)?\s*(MB|GB)/.test(SRC), '只给量级,不出现 MB/GB 数字(策划书 §1 第 9 条)')

// ---------- 组件只做的那两件事(分区渲染 / 上报勾选) ----------
ok(/const grouped = computed/.test(SRC) && /it\.group/.test(SRC) && /v-for="g in grouped"/.test(SRC), '按宿主给的 group 分区渲染,组件不认识任何具体组名')
ok(/emit\(\s*'update:modelValue'\s*,\s*\{[^}]*\.\.\.props\.modelValue[^}]*\[it\.id\][^}]*\}/.test(SRC), '勾选变化以整份映射上报(v-model 锚点,T10 直接接)')
ok(/emit\(\s*'preset',\s*'full'\s*\)/.test(SRC) && /'lite2d'/.test(SRC) && /'minimal'/.test(SRC) && !/PRESETS/.test(SRC), '预设只 emit 三个名字(full/lite2d/minimal),不在本地算预设结果')

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
