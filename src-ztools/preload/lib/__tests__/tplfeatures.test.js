// 能力层功能表(tplfeatures.js)的自洽性测试。
// 这张表是「面板上有什么、每项对应哪个 scons 变量」的唯一真源;探测层与输出层都只认它的 flags。
// 这里不碰源码树 —— 存在性/默认值是 tplprobe.js 的事,本表只保证语义与 flag 名自洽。
// 用法: node src-ztools/preload/lib/__tests__/tplfeatures.test.js
const F = require('../tplfeatures.js')

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

section('表结构自洽')
ok(Array.isArray(F.TPL_FEATURES) && F.TPL_FEATURES.length >= 20, '表至少 20 项', F.TPL_FEATURES.length)
ok(new Set(F.TPL_FEATURES.map((f) => f.id)).size === F.TPL_FEATURES.length, 'id 不重复')
const allFlagsArr = F.TPL_FEATURES.flatMap(F.flagsOf)
const ALL_FLAGS = new Set(allFlagsArr)
for (const f of F.TPL_FEATURES) {
  ok(F.flagsOf(f).length > 0, `${f.id} 至少映射一个 flag`)
  ok(F.TPL_GROUPS.includes(f.group), `${f.id} 的 group 在 TPL_GROUPS 里`, f.group)
  ok(['large', 'medium', 'small', 'tiny', 'none'].includes(f.sizeImpact), `${f.id} sizeImpact 合法`, f.sizeImpact)
  ok(['safe', 'notice', 'danger'].includes(f.risk), `${f.id} risk 合法`, f.risk)
  ok(typeof f.desc === 'string' && f.desc.length > 4, `${f.id} 有说明文案`)
  // label 是 T9 面板要渲染的中文名,漏一项就是一块空白 UI,这里逐条钉住非空字符串。
  ok(typeof f.label === 'string' && f.label.length > 0, `${f.id} 有中文名(label)`, JSON.stringify(f.label))
}
ok(new Set(allFlagsArr).size === allFlagsArr.length, '同一 flag 不被两个面板项共用',
   allFlagsArr.filter((k, i) => allFlagsArr.indexOf(k) !== i).join(','))

section('钉死不进面板的致命开关(策划书 §3 负范围补条)')
// 这些开关在 4.7.2 里真实存在,但关掉就是废模板,列出来等于给用户一个"勾一下就废"的按钮。
for (const banned of ['freetype', 'gdscript', 'text_server_adv', 'glslang', 'threads']) {
  const hit = F.TPL_FEATURES.find((f) => F.flagsOf(f).includes(`module_${banned}_enabled`) || F.flagsOf(f).includes(banned))
  ok(!hit, `面板不列 ${banned}`, hit && hit.id)
}

section('flag 名形态(与 4.7.2 源码逐字一致的写法)')
ok(ALL_FLAGS.has('disable_3d'), '含 disable_3d')
ok(ALL_FLAGS.has('module_webp_enabled'), '含 module_webp_enabled(目录名即模块名,methods.py:258)')
// 双向形态检查:module_ 前缀与 _enabled 后缀必须同现或同缺。
// 核销掉简报里那条恒真断言(回调末尾的 && false 让 some() 恒 false、!false 恒 true)。
// 能抓:regex_enabled(有后缀没前缀)、module_jolt(有前缀没后缀)。
// 抓不住:module_jolt_physics_enabled 被写成 module_jolt_enabled —— 前后缀都在,只是目录名被缩写;
// 那是"这个模块目录到底叫什么"的存在性问题,归 tplprobe.js 对 modules/ 核,本表自洽层给不出答案。
ok(allFlagsArr.every((k) => k.startsWith('module_') === /_enabled$/.test(k)),
   '模块 flag 一律 module_<目录名>_enabled 形态(双向:前缀与后缀必须同现同缺)',
   allFlagsArr.filter((k) => k.startsWith('module_') !== /_enabled$/.test(k)).join(','))

section('featureById 契约(Interfaces 段明写:返回 TplFeature|null)')
ok(F.featureById('__不存在的 id__') === null, 'featureById(不存在的 id) 严格返回 null(不是 undefined)',
   String(F.featureById('__不存在的 id__')))
const probe = F.TPL_FEATURES[0]
const found = F.featureById(probe.id)
ok(!!found && found.id === probe.id, `featureById(${probe.id}) 回环相等`, `拿回来 ${found ? found.id : String(found)}`)

console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
