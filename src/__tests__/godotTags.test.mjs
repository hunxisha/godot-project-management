// Godot 官方启动器标签联动的前端侧测试:哈希/色相公式与显示文字。
//
// 基准值全部按官方算法独立推算后硬编码(不是跑一遍实现抄一遍),锁住的是公式本身:
//   · godotStringHash = djb2(初值 5381,乘 33 加码点,32 位环绕) —— String::hash() 的 JS 复刻;
//     手工可验的锚点:'x' = 5381 × 33 + 120 = 177693
//   · godotTagHue = (hash × 10001 mod (2³²-1)) ÷ (2³²-1) —— project_tag.cpp 的取模链,
//     注意官方除数是 UINT32_MAX(2³²-1)而不是 2³²,这个怪模数也照抄
//   · 色相改动会让所有已显示标签换色,所以精确值逐个钉死
//   · godotTagLabel 对齐官方 String.capitalize() 的常用子集(下划线转空格、词首大写)
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../.gpm-test/out')

if (!existsSync(path.join(OUT, 'godottags.mjs'))) {
  console.error(`找不到打包产物: ${path.join(OUT, 'godottags.mjs')}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const T = await import(pathToFileURL(path.join(OUT, 'godottags.mjs')).href)

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}  → ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

// ---------- 1. godotStringHash:djb2 按 UTF-32 码点 ----------
section('1. godotStringHash:djb2(官方 String::hash 复刻)')
{
  ok(T.godotStringHash('') === 5381, '空串返回初值 5381(与官方一致)', T.godotStringHash(''))
  ok(T.godotStringHash('x') === 177693, '单字符手工锚点:5381×33+120', T.godotStringHash('x'))
  ok(T.godotStringHash('rpg') === 193504942, 'ASCII 多字符(基准值独立推算)', T.godotStringHash('rpg'))
  ok(T.godotStringHash('demo') === 2090181002, '第二个 ASCII 基准', T.godotStringHash('demo'))
  ok(T.godotStringHash('我的标签') === 3022622687, '中文按码点迭代(基准值独立推算)', T.godotStringHash('我的标签'))
  // 代理对必须按 1 个码点而不是 2 个 UTF-16 单元计数:'🎮' = U+1F3AE
  ok(T.godotStringHash('🎮') === 305491, 'emoji(代理对)按单个码点迭代', T.godotStringHash('🎮'))
}

// ---------- 2. godotTagHue:官方取模链 ----------
section('2. godotTagHue:hash×10001 mod (2³²-1) ÷ (2³²-1)')
{
  ok(T.godotTagHue('rpg') === 0.5838558409791104, 'rpg 色相精确值', T.godotTagHue('rpg'))
  ok(T.godotTagHue('') === 0.012529869799625564, '空串色相(官方不拦空串,公式照算)', T.godotTagHue(''))
  ok(T.godotTagHue('🎮') === 0.7113477894364268, 'emoji 色相精确值', T.godotTagHue('🎮'))
  let inRange = true
  for (const t of ['rpg', 'demo', '2d', '3d', 'tool', '我的标签', 'my_tag', 'a b']) {
    const h = T.godotTagHue(t)
    if (!(h >= 0 && h < 1)) inRange = false
  }
  ok(inRange, '全部落在 [0, 1) 区间')
  // 稳定性:同标签恒同色(改哈希 = 全部项目卡换色)
  ok(T.godotTagHue('rpg') === T.godotTagHue('rpg'), '同标签色相稳定')
}

// ---------- 3. godotTagLabel:官方 capitalize 子集 ----------
section('3. godotTagLabel:下划线转空格、词首大写')
{
  ok(T.godotTagLabel('rpg') === 'Rpg', '小写词首大写', T.godotTagLabel('rpg'))
  ok(T.godotTagLabel('my_tag') === 'My Tag', '下划线转空格并大写', T.godotTagLabel('my_tag'))
  ok(T.godotTagLabel('2d') === '2d', '数字开头不变形', T.godotTagLabel('2d'))
  ok(T.godotTagLabel('我的标签') === '我的标签', '中文原样', T.godotTagLabel('我的标签'))
  ok(T.godotTagLabel('a  b') === 'A B', '连续空格合并', T.godotTagLabel('a  b'))
  ok(T.godotTagLabel(' x ') === 'X', '首尾空白不影响', T.godotTagLabel(' x '))
}

// ---------- 4. tagChipVars ----------
section('4. tagChipVars:色相度数给 CSS 变量')
{
  ok(T.tagChipVars('rpg')['--tag-h'] === '210.2', 'rpg → 210.2°', T.tagChipVars('rpg')['--tag-h'])
  ok(T.tagChipVars('demo')['--tag-h'] === '24.7', 'demo → 24.7°', T.tagChipVars('demo')['--tag-h'])
}

// ---------- 结果 ----------
console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
