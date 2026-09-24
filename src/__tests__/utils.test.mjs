// 渲染层纯工具测试:Godot 版本兼容/不匹配判定 + 商店标签分组 + 头像渐变。
//
// 这些都是从视图里抽出来的纯函数(原本内联在 MarketplaceView / ProjectsView / Dashboard 里),
// 抽成 utils 后在这里逐条锁边界 —— 尤其是:
//   · verNum 的数值化(4.10 必须大于 4.4,不能按字符串比)
//   · compatOf 的 null/false 语义区分(「无法判断」不能当成「不兼容」)
//   · versionMismatch 在信息缺失时**不报警**(否则新项目一添加就满屏「版本不匹配」)
//   · gradOf 的哈希必须稳定(改了会让所有项目头像换色)
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../.gpm-test/out')

for (const name of ['godotversion', 'markettags', 'avatar']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

const V = await import(pathToFileURL(path.join(OUT, 'godotversion.mjs')).href)
const T = await import(pathToFileURL(path.join(OUT, 'markettags.mjs')).href)
const A = await import(pathToFileURL(path.join(OUT, 'avatar.mjs')).href)

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

// ---------- 1. verNum ----------
section('1. verNum:版本串数值化')
ok(V.verNum('4.4') === 404, 'major.minor → major*100+minor', String(V.verNum('4.4')))
ok(V.verNum('4') === 400, '只有 major 时 minor 记 0', String(V.verNum('4')))
ok(V.verNum('v4.4') === 404, '容忍前缀 v')
ok(V.verNum(' 4.4 ') === 404, '容忍首尾空白')
ok(V.verNum('4.10') === 410, '4.10 按数值解析(不能按字符串比)', String(V.verNum('4.10')))
ok(V.verNum('4.10') > V.verNum('4.4'), '4.10 > 4.4(字符串比较会得出相反结论)')
ok(V.verNum('4.7.2') === 407, '忽略 patch 位')
ok(V.verNum('3.5') === 305, '支持 3.x')
ok(V.verNum('') === null, '空串 → null')
ok(V.verNum(null) === null, 'null → null')
ok(V.verNum(undefined) === null, 'undefined → null')
ok(V.verNum('abc') === null, '无法解析 → null')

// ---------- 2. projectGodotVersion ----------
section('2. projectGodotVersion:取项目的 major.minor')
const VERSIONS = [
  { _id: 'godot/version/4.7.2-stable-standard-win64', tag: '4.7.2-stable' },
  { _id: 'godot/version/4.3-stable-standard-win64', tag: '4.3-stable' }
]
ok(
  V.projectGodotVersion({ versionId: VERSIONS[0]._id, engineVersion: '4.1' }, VERSIONS) === '4.7',
  '优先取绑定引擎的 tag',
  V.projectGodotVersion({ versionId: VERSIONS[0]._id, engineVersion: '4.1' }, VERSIONS)
)
ok(
  V.projectGodotVersion({ versionId: '不存在', engineVersion: '4.1' }, VERSIONS) === '4.1',
  '绑定丢失时回退 project.godot 声明的 engineVersion',
  V.projectGodotVersion({ versionId: '不存在', engineVersion: '4.1' }, VERSIONS)
)
ok(V.projectGodotVersion({ engineVersion: '4.1' }, VERSIONS) === '4.1', '未绑定引擎时用 engineVersion')
ok(V.projectGodotVersion({ engineVersion: '' }, VERSIONS) === '', '都没有时返回空串')
ok(V.projectGodotVersion(null, VERSIONS) === '', '无目标项目时返回空串')

// ---------- 3. compatOf ----------
section('3. compatOf:兼容判定与「无法判断」的区分')
ok(V.compatOf({}, '4.4') === null, '资产无版本要求 → null(不是 true)')
ok(V.compatOf({ minGodot: '4.0' }, '') === null, '项目版本未知 → null')
ok(V.compatOf({ minGodot: '4.0', maxGodot: '4.4' }, '4.2') === true, '落在区间内 → true')
ok(V.compatOf({ minGodot: '4.0', maxGodot: '4.4' }, '4.4') === true, '等于上界 → true(闭区间)')
ok(V.compatOf({ minGodot: '4.0', maxGodot: '4.4' }, '4.0') === true, '等于下界 → true(闭区间)')
ok(V.compatOf({ minGodot: '4.2', maxGodot: '4.4' }, '4.1') === false, '低于下界 → false')
ok(V.compatOf({ minGodot: '4.2', maxGodot: '4.4' }, '4.5') === false, '高于上界 → false')
ok(V.compatOf({ minGodot: '4.2' }, '4.10') === true, '只有下界:4.10 ≥ 4.2 → true(数值比较)')
ok(V.compatOf({ maxGodot: '4.4' }, '4.10') === false, '只有上界:4.10 > 4.4 → false')
ok(V.compatOf({ minGodot: '4.2' }, '4.1') === false, '只有下界且不满足 → false')

// ---------- 4. godotRange ----------
section('4. godotRange:展示文案')
ok(V.godotRange({ minGodot: '4.2', maxGodot: '4.4' }) === 'Godot 4.2 ~ 4.4', '上下界都给')
ok(V.godotRange({ minGodot: '4.2' }) === 'Godot 4.2+', '只有下界')
ok(V.godotRange({ maxGodot: '4.4' }) === 'Godot ≤ 4.4', '只有上界')
ok(V.godotRange({}) === '', '都没有 → 空串')

// ---------- 5. 标签分组 ----------
section('5. MARKET_TAG_GROUPS / tagSlugsOf / inGroup')
ok(Array.isArray(T.MARKET_TAG_GROUPS) && T.MARKET_TAG_GROUPS.length > 0, '标签分组表非空')
ok(!!T.tagSlugsOf('2D'), '已知分类能取到 slug 集合')
ok(T.tagSlugsOf('不存在的分类') === null, '未知分类 → null')
ok(T.tagSlugsOf('工具').includes('tool'), '「工具」映射到 tool slug')

ok(T.inGroup({ tagSlugs: ['3d'] }, ['3d']) === true, '按 tagSlugs 命中 → true')
ok(T.inGroup({ tagSlugs: ['3d'] }, ['2d']) === false, 'tagSlugs 不含目标 → false')
ok(T.inGroup({ tagSlugs: ['3d', 'tool'] }, ['tool']) === true, '多标签任一命中即可')
ok(T.inGroup({ category: 'Tools' }, ['tool', 'tools']) === true, '无 tagSlugs 时按分类名兜底(忽略大小写)')
ok(T.inGroup({ category: 'Tools' }, ['2d']) === false, '兜底分类不匹配 → false')
ok(T.inGroup({}, ['2d']) === false, '既无 tagSlugs 也无分类 → false')
ok(T.inGroup({ tagSlugs: [] }, ['2d']) === false, '空 tagSlugs 走分类兜底,不误判为命中')

// ---------- 6. versionMismatch ----------
section('6. versionMismatch:绑定版本与声明版本是否不一致')
{
  const vs = [
    { _id: 'godot/version/4.7.2-stable-standard-win64', tag: '4.7.2-stable' },
    { _id: 'godot/version/4.3-stable-standard-win64', tag: '4.3-stable' }
  ]
  ok(V.versionMismatch({ engineVersion: '4.7', versionId: vs[0]._id }, vs) === false, '声明 4.7 / 绑定 4.7.2 → 一致')
  ok(V.versionMismatch({ engineVersion: '4.7.2', versionId: vs[0]._id }, vs) === false, '声明到 patch 位也一致')
  ok(V.versionMismatch({ engineVersion: '4.3', versionId: vs[0]._id }, vs) === true, '声明 4.3 / 绑定 4.7.2 → 不匹配')

  // 信息缺失时一律不报警,否则新项目一添加就满屏「版本不匹配」
  ok(V.versionMismatch({ versionId: vs[0]._id }, vs) === false, '未声明 engineVersion → 不报警')
  ok(V.versionMismatch({ engineVersion: '4.3' }, vs) === false, '未绑定 versionId → 不报警')
  ok(V.versionMismatch({ engineVersion: '4.3', versionId: '已删除的版本' }, vs) === false, '绑定记录已不存在 → 不报警')
  ok(V.versionMismatch(null, vs) === false, '无项目 → 不报警')
}

// ---------- 7. gradOf ----------
section('7. gradOf:项目名 → 头像渐变组')
{
  const groups = ['a', 'b', 'c', 'd']
  ok(groups.includes(A.gradOf('Alpha')), '返回合法的渐变组', A.gradOf('Alpha'))
  ok(A.gradOf('Alpha') === A.gradOf('Alpha'), '同名稳定(同色)')
  ok(A.gradOf('') === 'a', '空名不抛错', A.gradOf(''))
  // 哈希一旦改动,所有项目头像都会换色 —— 用固定值把它钉住
  const FIXED = { Alpha: A.gradOf('Alpha'), Beta: A.gradOf('Beta'), '我的项目': A.gradOf('我的项目') }
  ok(
    FIXED.Alpha === 'c' && FIXED.Beta === 'a' && FIXED['我的项目'] === 'a',
    '固定输入得到固定分组(哈希未漂移)',
    JSON.stringify(FIXED)
  )
  const spread = new Set(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map((n) => A.gradOf(n)))
  ok(spread.size >= 3, '多个不同项目能分散到多个组(不是全挤一组)', [...spread].join(','))
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
