// langDetect.ts 回归测试:跳过「已经是目标语言」的判据。
//
// 这条判据错向哪边都有代价:判太松 → 中文条目被模型改写一遍(读起来更怪);
// 判太紧 → 每条中文描述都白花一次额度。商店文案里中英混排很常见,
// 所以这里同时覆盖纯中文、纯英文、混排与短文本。
//
// 用法:
//   node src/__tests__/langDetect.test.mjs
import { isMostlyTargetLang, scriptShare, langLabel, TARGET_LANGS } from '../../.gpm-test/out/langdetect.mjs'

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

section('1. 目标语言是中文')
{
  ok(isMostlyTargetLang('这是一个用于生成地形的插件,支持噪声与高度图。', 'zh-CN') === true,
    '整段中文 → 跳过(不再翻)')
  ok(isMostlyTargetLang('A simple plugin for terrain generation.', 'zh-CN') === false,
    '整段英文 → 要翻')
  ok(isMostlyTargetLang('基于 Godot 4.7 的地形插件,支持 TileMap 与材质。', 'zh-CN') === true,
    '中英混排但汉字占多数 → 跳过')
  ok(isMostlyTargetLang('Godot terrain plugin with heightmap support, 附带示例场景。', 'zh-CN') === false,
    '英文为主只有零星汉字 → 要翻')
}

section('2. 目标语言不是中文')
{
  ok(isMostlyTargetLang('A simple plugin for terrain generation.', 'en') === true, '英文对英文 → 跳过')
  ok(isMostlyTargetLang('这是一个地形插件。', 'en') === false, '中文对英文 → 要翻')
  ok(isMostlyTargetLang('地形を生成するプラグインです', 'ja') === true, '日文对日文 → 跳过')
  ok(isMostlyTargetLang('지형 생성 플러그인', 'ko') === true, '韩文对韩文 → 跳过')
}

section('3. 边界')
{
  ok(isMostlyTargetLang('', 'zh-CN') === true, '空串视为无需翻译')
  ok(isMostlyTargetLang('   ', 'zh-CN') === true, '纯空白视为无需翻译')
  ok(isMostlyTargetLang('2D', 'zh-CN') === false, '极短英文词仍算需要翻译(由调用方按长度过滤)')
  ok(scriptShare('abc中文', /[\u4e00-\u9fff]/g) === 0.4, '书写系统占比计算正确', String(scriptShare('abc中文', /[\u4e00-\u9fff]/g)))
  ok(scriptShare('no letters', /[\u4e00-\u9fff]/g) === 0, '没有该书写系统时占比为 0')
}

section('4. 语言标签')
{
  ok(langLabel('zh-CN') === '简体中文', '中文标签', langLabel('zh-CN'))
  ok(langLabel('ja') === '日本語', '日文标签', langLabel('ja'))
  ok(langLabel('__unknown__') === '__unknown__', '未知语言回退成原值')
  ok(TARGET_LANGS.length >= 6 && TARGET_LANGS[0].value === 'zh-CN', '目标语言列表默认简体中文', String(TARGET_LANGS.length))
}

console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
