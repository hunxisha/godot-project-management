// useMarketInstall 回归测试:市场插件安装的进度、已装集合与版本选择器。
//
// 安装是插件市场里唯一会写目标项目目录的操作。这里锁住三条容易出错的约束:
//   1. 进度回调必须按 assetId 配对(否则切换资产时进度会串到别的卡片上)
//   2. 安装中不允许并发安装,也不允许再开版本选择器
//   3. 无目标项目时不发请求
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['usemarketinstall', 'vueshim']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

const { ref } = await import(pathToFileURL(path.join(OUT, 'vueshim.mjs')).href)
const { useMarketInstall } = await import(pathToFileURL(path.join(OUT, 'usemarketinstall.mjs')).href)

// ---------- 桩 ----------
let installCalls = []
let installImpl = null
const notifications = []
let reloadCount = 0

global.window = {
  services: {
    installAsset(opts, onProgress) {
      installCalls.push({ opts, onProgress })
      return installImpl(opts, onProgress)
    }
  }
}

function reset() {
  installCalls = []
  notifications.length = 0
  reloadCount = 0
  installImpl = () => Promise.resolve({ ok: true, addon: { title: 'Demo', versionString: '1.0.0', enabled: true } })
}

const asset = (id, over = {}) => ({ assetId: id, title: `T-${id}`, author: 'A', category: 'C', ...over })

function make(over = {}) {
  const targetId = over.targetId || ref('godot/project/p1')
  const addons = over.addons || ref([])
  const inst = useMarketInstall({
    targetId,
    addons,
    reloadAddons: () => { reloadCount++ },
    notify: (m) => { notifications.push(m) }
  })
  return { inst, targetId, addons }
}

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // ---------- 1. installedIds ----------
  section('1. installedIds:只统计「来自市场且有 assetId」的插件')
  {
    reset()
    const addons = ref([
      { dirName: 'd1', fromMarket: true, assetId: 'a/b' },
      { dirName: 'd2', fromMarket: true, assetId: undefined },
      { dirName: 'd3', fromMarket: false, assetId: 'c/d' },
      { dirName: 'd4', fromMarket: true, assetId: 'e/f' }
    ])
    const { inst } = make({ addons })
    ok(inst.installedIds.value.size === 2, '只有 2 项计入已安装', String(inst.installedIds.value.size))
    ok(inst.installedIds.value.has('a/b') && inst.installedIds.value.has('e/f'), '命中正确的 assetId')
    ok(!inst.installedIds.value.has('c/d'), '非市场来源不计入')
  }

  // ---------- 2. install 成功路径 ----------
  section('2. install:成功 → 提示 + 刷新已装插件')
  {
    reset()
    const { inst, targetId } = make()
    await inst.install(asset('a/b'))
    ok(installCalls.length === 1, '发起一次安装')
    ok(installCalls[0].opts.projectId === targetId.value, '带上目标项目 id', installCalls[0].opts.projectId)
    ok(installCalls[0].opts.assetId === 'a/b', '带上 assetId')
    ok(installCalls[0].opts.version === undefined, '未指定版本时不传 version(取最新)')
    ok(installCalls[0].opts.assetMeta.title === 'T-a/b', '带上 assetMeta 供来源记录使用')
    ok(inst.installing.value === null, '完成后清空进度')
    ok(reloadCount === 1, '刷新已装插件')
    ok(notifications.length === 1 && /已安装/.test(notifications[0]), '提示安装成功', notifications[0])
  }

  // ---------- 3. install 失败与前置条件 ----------
  section('3. install:失败与前置条件')
  {
    reset()
    installImpl = () => Promise.resolve({ ok: false, error: '磁盘满了' })
    const { inst } = make()
    await inst.install(asset('a/b'))
    ok(notifications[0] === '磁盘满了', '失败时提示服务端给的原因', String(notifications[0]))
    ok(reloadCount === 0, '失败不刷新已装插件')

    reset()
    const noTarget = make({ targetId: ref('') })
    await noTarget.inst.install(asset('a/b'))
    ok(installCalls.length === 0, '无目标项目时不发请求', String(installCalls.length))
    ok(noTarget.inst.installing.value === null, '也不进入安装态')
  }

  // ---------- 4. 进度按 assetId 配对 ----------
  section('4. 进度回调:按 assetId 配对,不串台')
  {
    reset()
    let progressCb = null
    installImpl = (opts, onProgress) => {
      progressCb = onProgress
      return new Promise((resolve) => { resolveLater = () => resolve({ ok: true, addon: { title: 'T' } }) })
    }
    let resolveLater
    const { inst } = make()
    const p = inst.install(asset('a/b'))
    await sleep()
    ok(inst.installing.value && inst.installing.value.assetId === 'a/b', '进入安装态并记录 assetId')

    progressCb({ stage: 'downloading', received: 512, total: 1024 })
    ok(Math.round(inst.installing.value.percent) === 50, '下载进度换算为百分比', String(inst.installing.value.percent))
    ok(/下载中/.test(inst.installing.value.stage), '阶段文案为下载中', inst.installing.value.stage)

    progressCb({ stage: 'extracting' })
    ok(inst.installing.value.percent === 100, '解压阶段置 100%', String(inst.installing.value.percent))
    ok(inst.installing.value.stage === '解压中', '阶段文案为解压中', inst.installing.value.stage)

    // 把 installing 换成另一个资产:旧回调必须被忽略
    inst.installing.value = { assetId: 'other/x', percent: 7, stage: '别的' }
    progressCb({ stage: 'downloading', received: 1, total: 1 })
    ok(inst.installing.value.assetId === 'other/x' && inst.installing.value.percent === 7, 'assetId 不匹配的进度被忽略', JSON.stringify(inst.installing.value))

    resolveLater()
    await p
  }

  // ---------- 5. percent 边界 ----------
  section('5. percent 边界')
  {
    reset()
    const { inst } = make()
    ok(inst.percent({ received: 1, total: 0 }) === 0, 'total 为 0 → 0(不做除零)', String(inst.percent({ received: 1, total: 0 })))
    ok(inst.percent({ total: 100 }) === 0, 'received 缺失按 0 计')
    ok(inst.percent({ received: 200, total: 100 }) === 100, '超出封顶 100', String(inst.percent({ received: 200, total: 100 })))
    ok(inst.percent({ received: 25, total: 100 }) === 25, '正常换算')
  }

  // ---------- 6. 版本选择器 ----------
  section('6. 版本选择器:openPicker / installFromPicker')
  {
    reset()
    const { inst } = make()
    ok(inst.picker.value === null, '初始无选择器')
    inst.openPicker(asset('a/b'))
    ok(inst.picker.value && inst.picker.value.asset.assetId === 'a/b', 'openPicker 记录目标资产')

    const p = inst.installFromPicker('1.2.0')
    ok(inst.picker.value === null, '选择后立即关闭选择器')
    await p
    ok(installCalls.length === 1, '按选择的版本安装')
    ok(installCalls[0].opts.version === '1.2.0', 'version 透传给服务', String(installCalls[0].opts.version))
    ok(/1\.0\.0/.test(notifications[0] || ''), '成功提示带上版本号', String(notifications[0]))
  }

  // ---------- 7. 并发保护 ----------
  section('7. 并发保护:安装中不再受理')
  {
    reset()
    let resolveLater
    installImpl = () => new Promise((resolve) => { resolveLater = () => resolve({ ok: true, addon: { title: 'T' } }) })
    const { inst } = make()
    const p = inst.install(asset('a/b'))
    await sleep()
    ok(inst.installing.value !== null, '第一个安装进行中')

    await inst.install(asset('c/d'))
    ok(installCalls.length === 1, '安装中再次 install 被忽略', String(installCalls.length))

    inst.openPicker(asset('c/d'))
    ok(inst.picker.value === null, '安装中不允许打开版本选择器')

    resolveLater()
    await p
    ok(inst.installing.value === null, '结束后恢复可安装')
    inst.openPicker(asset('c/d'))
    ok(inst.picker.value !== null, '结束后可正常打开选择器')
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
}

main().catch((e) => {
  console.error('\n未捕获异常:', e)
  process.exit(1)
})
