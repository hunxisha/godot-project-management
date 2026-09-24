// useInstallProgress 回归测试:安装/更新/切版本共用的进度状态。
//
// 这段逻辑原本在三个地方各写一遍(市场安装 / 更新 / 切换版本),文案必须完全一致。
// 关键约束是「进度只回填给发起时那个 assetId」—— 否则并发安装或切换卡片时,
// 进度条会画到别的条目上。这里把它逐条钉住。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

if (!existsSync(path.join(OUT, 'useinstallprogress.mjs'))) {
  console.error(`找不到打包产物: ${path.join(OUT, 'useinstallprogress.mjs')}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const { useInstallProgress } = await import(pathToFileURL(path.join(OUT, 'useinstallprogress.mjs')).href)

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}  → ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

// ---------- 1. percent ----------
section('1. percent:百分比换算与边界')
{
  const { percent } = useInstallProgress()
  ok(percent({ received: 25, total: 100 }) === 25, '正常换算')
  ok(percent({ received: 512, total: 1024 }) === 50, '一半')
  ok(percent({ received: 1, total: 0 }) === 0, 'total 为 0 → 0(不做除零)', String(percent({ received: 1, total: 0 })))
  ok(percent({ total: 100 }) === 0, 'received 缺失按 0 计')
  ok(percent({}) === 0, '两者都缺失 → 0')
  ok(percent({ received: 300, total: 100 }) === 100, '超出封顶 100', String(percent({ received: 300, total: 100 })))
}

// ---------- 2. 生命周期 ----------
section('2. begin / onProgress / end')
{
  const p = useInstallProgress()
  ok(p.busy() === false, '初始不在安装中')
  ok(p.progress.value === null, '初始无进度')

  p.begin('a/b')
  ok(p.busy() === true, 'begin 后进入安装中')
  ok(p.progress.value.assetId === 'a/b', '记录 assetId')
  ok(p.progress.value.percent === 0, '起始 0%')
  ok(p.progress.value.stage === '下载中', '起始文案「下载中」', p.progress.value.stage)

  const accepted = p.onProgress('a/b', { stage: 'downloading', received: 2048, total: 4096 })
  ok(accepted === true, '匹配的进度被接受')
  ok(p.progress.value.percent === 50, '写入百分比', String(p.progress.value.percent))
  ok(/^下载中 /.test(p.progress.value.stage), '阶段文案带「下载中」前缀', p.progress.value.stage)
  ok(/2\.0 KB/.test(p.progress.value.stage), '带上已下载体积', p.progress.value.stage)

  p.onProgress('a/b', { stage: 'extracting' })
  ok(p.progress.value.percent === 100, '解压阶段置 100%', String(p.progress.value.percent))
  ok(p.progress.value.stage === '解压中', '解压文案', p.progress.value.stage)

  p.end()
  ok(p.progress.value === null, 'end 清空进度')
  ok(p.busy() === false, 'end 后不在安装中')
}

// ---------- 3. assetId 配对 ----------
section('3. 进度按 assetId 配对(不串台)')
{
  const p = useInstallProgress()
  ok(p.onProgress('a/b', { stage: 'downloading', received: 1, total: 2 }) === false, '没有进行中的安装时忽略回调')

  p.begin('a/b')
  ok(p.onProgress('other/x', { stage: 'downloading', received: 1, total: 2 }) === false, 'assetId 不匹配时忽略')
  ok(p.progress.value.assetId === 'a/b', '进度仍属于发起者')
  ok(p.progress.value.percent === 0, '百分比未被污染', String(p.progress.value.percent))

  // 中途换了进行中的资产:旧回调必须失效
  p.begin('b/c')
  ok(p.onProgress('a/b', { stage: 'extracting' }) === false, '上一个资产的回调不再被接受')
  ok(p.progress.value.assetId === 'b/c' && p.progress.value.percent === 0, '新资产的进度不被旧回调改动')
  ok(p.onProgress('b/c', { stage: 'extracting' }) === true, '新资产自己的回调被接受')
}

// ---------- 4. 多实例互不干扰 ----------
section('4. 多实例隔离')
{
  const a = useInstallProgress()
  const b = useInstallProgress()
  a.begin('x/1')
  ok(b.busy() === false, '两个实例状态相互独立')
  ok(b.progress.value === null, '另一个实例仍为空')
  a.end()
  ok(b.progress.value === null, '一个实例 end 不影响另一个')
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
