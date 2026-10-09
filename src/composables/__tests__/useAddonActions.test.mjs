// useAddonActions 回归测试:插件页的各类写操作。
//
// 从 AddonsView.vue 抽出后可以断言几件原本只靠人工点的事:
//   · 批量启停只处理「需要变更」的项,并按实际成功数报告
//   · 批量卸载与单个卸载都是「点两次」的二次确认
//   · 更新 / 切换版本共用同一套进度状态,成功后让「可更新」判断作废
//   · 复制到其他项目时把 skipped / adopted 如实带进提示文案
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['useaddonactions', 'useaddonselection', 'vueshim']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

const { ref } = await import(pathToFileURL(path.join(OUT, 'vueshim.mjs')).href)
const { useAddonActions } = await import(pathToFileURL(path.join(OUT, 'useaddonactions.mjs')).href)
const { useAddonSelection } = await import(pathToFileURL(path.join(OUT, 'useaddonselection.mjs')).href)

// ---------- 桩 ----------
let calls = []
let setEnabledResult = { ok: true }
let uninstallResult = { ok: true }
let copyResult = null
let copyAssetResult = { ok: true, copied: 3, skipped: [] }
let checkResult = { hasUpdate: false }
/** 逐项排队返回(测「一部分查成、一部分宿主没查」的混合现场);用队列而不是替换桩,免得漏到后面几节 */
let checkQueue = []
let updateResult = null
let installResult = null
let progressCb = null
/** 设为 true 时 updateAsset/installAsset 返回「稍后手动 resolve」的 promise,便于在完成前检查进度 */
let deferService = false
let resolvePending = null
const notifications = []
let reloadCount = 0

global.window = {
  services: {
    setAddonEnabled(o) { calls.push(['setEnabled', o]); return setEnabledResult },
    uninstallAddon(o) { calls.push(['uninstall', o]); return uninstallResult },
    copyAddonsToProject(o) { calls.push(['copy', o]); return copyResult },
    copyAssetToProject(o) { calls.push(['copyAsset', o]); return copyAssetResult },
    checkAddonUpdate(o) { calls.push(['check', o]); return Promise.resolve(checkQueue.length ? checkQueue.shift() : checkResult) },
    updateAsset(o, cb) {
      calls.push(['update', o])
      progressCb = cb
      if (deferService) return new Promise((res) => { resolvePending = () => res(updateResult) })
      return Promise.resolve(updateResult)
    },
    installAsset(o, cb) {
      calls.push(['install', o])
      progressCb = cb
      if (deferService) return new Promise((res) => { resolvePending = () => res(installResult) })
      return Promise.resolve(installResult)
    }
  }
}

function reset() {
  calls = []
  notifications.length = 0
  reloadCount = 0
  progressCb = null
  deferService = false
  resolvePending = null
  setEnabledResult = { ok: true }
  uninstallResult = { ok: true }
  copyResult = { ok: true, copied: 2, targetName: 'Beta' }
  copyAssetResult = { ok: true, copied: 3, skipped: [] }
  checkResult = { hasUpdate: false }
  checkQueue = []
  updateResult = { ok: true, addon: { versionString: '2.0.0' } }
  installResult = { ok: true, addon: { versionString: '1.5.0' } }
}

const A = (dir, over = {}) => ({ dirName: dir, name: dir, enabled: true, hasCfg: true, ...over })
const PROJ = (id, name) => ({ _id: id, id, name, path: `E:\\${name}`, addedAt: 1 })

function make(over = {}) {
  const addons = ref(over.addons || [A('d1'), A('d2')])
  const projects = ref(over.projects || [PROJ('godot/project/p1', 'Alpha'), PROJ('godot/project/p2', 'Beta')])
  const targetId = ref(over.targetId || 'godot/project/p1')
  const selection = useAddonSelection(addons, { confirmMs: 5 })
  const actions = useAddonActions({
    targetId, projects, addons, selection,
    reload: () => { reloadCount++ },
    notify: (m) => notifications.push(m),
    confirmMs: 5
  })
  return { actions, addons, projects, targetId, selection }
}

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}  → ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const nCalls = (kind) => calls.filter((c) => c[0] === kind).length

async function main() {
  // ---------- 1. 批量启停 ----------
  section('1. batchToggle:只处理需要变更的项')
  {
    reset()
    const { actions, selection } = make({
      addons: [A('d1', { enabled: true }), A('d2', { enabled: false }), A('d3', { enabled: false })]
    })
    selection.toggleAll()
    await actions.batchToggle(true)
    ok(nCalls('setEnabled') === 2, '只对「未启用」的 2 项发请求', String(nCalls('setEnabled')))
    ok(calls.filter((c) => c[0] === 'setEnabled').every((c) => c[1].enabled === true), '参数 enabled=true')
    ok(calls[0][1].projectId === 'godot/project/p1', '带上当前项目 id')
    ok(reloadCount === 1, '操作后刷新列表')
    ok(/已启用 2 个插件/.test(notifications[0] || ''), '按实际成功数报告', String(notifications[0]))

    // 全部已是目标状态
    reset()
    const s2 = make({ addons: [A('d1', { enabled: true })] })
    s2.selection.toggleAll()
    await s2.actions.batchToggle(true)
    ok(nCalls('setEnabled') === 0, '都已启用时不发请求')
    ok(notifications[0] === '所选插件均已启用', '给出「均已是目标状态」的提示', String(notifications[0]))

    // 没有 hasCfg 的项参与不了启停
    reset()
    const s3 = make({ addons: [A('d1', { hasCfg: false, enabled: false }), A('d2', { enabled: false })] })
    s3.selection.toggleAll()
    await s3.actions.batchToggle(true)
    ok(nCalls('setEnabled') === 1 && calls[0][1].dirName === 'd2', '跳过没有 plugin.cfg 的项', JSON.stringify(calls.map((c) => c[1].dirName)))
  }

  // ---------- 2. 批量卸载二次确认 ----------
  section('2. batchUninstall:点两次')
  {
    reset()
    const { actions, selection } = make()
    selection.toggleAll()
    await actions.batchUninstall()
    ok(nCalls('uninstall') === 0, '第一次点击只进入待确认,不动手')
    ok(selection.confirmingBatch.value === true, '处于待确认态')
    await actions.batchUninstall()
    ok(nCalls('uninstall') === 2, '第二次点击才真的卸载', String(nCalls('uninstall')))
    ok(selection.checked.value.length === 0, '卸载后清空选择')
    ok(reloadCount === 1, '卸载后刷新')
    ok(/已卸载 2 个插件/.test(notifications[0] || ''), '报告成功数', String(notifications[0]))

    // 部分失败
    reset()
    const s = make()
    s.selection.toggleAll()
    await s.actions.batchUninstall()
    uninstallResult = { ok: false, error: '被占用' }
    await s.actions.batchUninstall()
    ok(/失败 2 个/.test(notifications[0] || ''), '失败数进提示', String(notifications[0]))
  }

  // ---------- 3. 单个启用 / 卸载 ----------
  section('3. toggleEnabled / uninstall')
  {
    reset()
    const { actions } = make()
    await actions.toggleEnabled(A('d1', { enabled: true }))
    ok(calls[0][1].enabled === false, '切换为禁用', String(calls[0][1].enabled))
    ok(reloadCount === 1, '成功后刷新')
    await actions.toggleEnabled(A('d2', { enabled: false }))
    ok(calls[1][1].enabled === true, '切换为启用')

    reset()
    setEnabledResult = { ok: false, error: '无权限' }
    await actions.toggleEnabled(A('d1'))
    ok(notifications[0] === '无权限', '失败时提示服务端原因', String(notifications[0]))
    ok(reloadCount === 0, '失败不刷新')

    // 卸载:点两次
    reset()
    await actions.uninstall(A('d1'))
    ok(nCalls('uninstall') === 0, '第一次点击只进入待确认')
    ok(actions.confirmingDir.value === 'd1', '记录待确认的目录', String(actions.confirmingDir.value))
    await actions.uninstall(A('d1'))
    ok(nCalls('uninstall') === 1, '第二次点击才卸载', String(nCalls('uninstall')))
    ok(actions.confirmingDir.value === null, '确认后清掉待确认态')
    ok(reloadCount === 1, '卸载成功后刷新')

    // 点别的项会改为待确认那一项
    reset()
    await actions.uninstall(A('d1'))
    await actions.uninstall(A('d2'))
    ok(actions.confirmingDir.value === 'd2', '改点其他项时待确认跟随切换', String(actions.confirmingDir.value))
    ok(nCalls('uninstall') === 0, '此时仍未卸载任何项')
    await sleep(15)
    ok(actions.confirmingDir.value === null, '超时后自动解除待确认')
  }

  // ---------- 4. 检查更新 ----------
  section('4. checkUpdates')
  {
    reset()
    checkResult = { hasUpdate: true, latest: '2.1.0' }
    const { actions } = make({
      addons: [A('d1', { fromMarket: true, assetId: 'a/1' }), A('d2', { fromMarket: false }), A('d3', { fromMarket: true, assetId: undefined })]
    })
    await actions.checkUpdates()
    ok(nCalls('check') === 1, '只检查「来自市场且有 assetId」的项', String(nCalls('check')))
    ok(actions.updateInfo.value.d1 && actions.updateInfo.value.d1.latest === '2.1.0', '写入可更新信息')
    ok(actions.checking.value === false, '完成后复位 checking')
    ok(/1 个插件有新版本/.test(notifications[0] || ''), '提示有更新的数量', String(notifications[0]))

    reset()
    checkResult = { hasUpdate: false }
    const s2 = make({ addons: [A('d1', { fromMarket: true, assetId: 'a/1' })] })
    await s2.actions.checkUpdates()
    ok(Object.keys(s2.actions.updateInfo.value).length === 0, '无更新时 updateInfo 为空')
    ok(notifications[0] === '所有插件均为最新版本', '提示「均为最新」', String(notifications[0]))

    // 宿主**没查**却回了「没更新」的形状(tauri-shim.js 的 checkAddonUpdate 就是这个空壳)。
    // 这一节是本批的红线:带 error 的回值不能当成「均为最新」这个结论。
    reset()
    checkResult = { hasUpdate: false, error: '桌面版暂不支持检查插件更新,请使用 ZTools 插件版。' }
    const s3 = make({ addons: [A('d1', { fromMarket: true, assetId: 'a/1' })] })
    await s3.actions.checkUpdates()
    ok(!/所有插件均为最新/.test(notifications.join(' | ')), '宿主报 error 时不许说「均为最新」', notifications.join(' | '))
    ok(/不支持/.test(notifications[0] || ''), '把宿主给的原因原样递到用户眼前', String(notifications[0]))
    ok(s3.actions.checking.value === false, '出错这条路也要复位 checking(否则按钮永久卡住)', String(s3.actions.checking.value))

    // 部分失败不许被成功那半边盖过去
    reset()
    checkQueue = [
      { hasUpdate: true, latest: '2.1.0' },
      { hasUpdate: false, error: '桌面版暂不支持检查插件更新,请使用 ZTools 插件版。' }
    ]
    const s4 = make({ addons: [A('d1', { fromMarket: true, assetId: 'a/1' }), A('d2', { fromMarket: true, assetId: 'a/2' })] })
    await s4.actions.checkUpdates()
    ok(/1 个插件有新版本/.test(notifications.join(' | ')), '有真结果时照常报数量', notifications.join(' | '))
    ok(/不支持/.test(notifications.join(' | ')), '同时要说清有几项没查成', notifications.join(' | '))
  }

  // ---------- 5. 更新 ----------
  section('5. update:进度与后续动作')
  {
    reset()
    const { actions } = make({ addons: [A('d1', { fromMarket: true, assetId: 'a/1' })] })
    await actions.update(A('d1', { fromMarket: true, assetId: 'a/1' }))
    ok(nCalls('update') === 1, '调用 updateAsset')
    ok(calls[0][1].assetId === 'a/1', '带上 assetId')
    ok(actions.updating.value === null, '完成后清空进度')
    ok(reloadCount >= 1, '成功后刷新列表')
    ok(/已更新到 2\.0\.0/.test(notifications[0] || ''), '提示新版本号', String(notifications[0]))

    // 无 assetId / 无目标项目 → 不动
    reset()
    await actions.update(A('d2', { assetId: undefined }))
    ok(nCalls('update') === 0, '无 assetId 时不发请求')

    // 进度回调:服务 promise 挂起期间检查(真实场景里下载不会立刻结束)
    reset()
    deferService = true
    const s = make({ addons: [A('d1', { fromMarket: true, assetId: 'a/1' })] })
    const p = s.actions.update(A('d1', { fromMarket: true, assetId: 'a/1' }))
    await sleep()
    ok(!!s.actions.updating.value, '挂起期间有进度状态')
    progressCb({ stage: 'downloading', received: 512, total: 1024 })
    ok(Math.round(s.actions.updating.value.percent) === 50, '进度写入百分比', String(s.actions.updating.value.percent))
    progressCb({ stage: 'extracting' })
    ok(s.actions.updating.value.percent === 100 && s.actions.updating.value.stage === '解压中', '解压阶段置 100%')
    resolvePending()
    await p
    ok(s.actions.updating.value === null, '完成后清空进度')

    // 更新失败
    reset()
    updateResult = { ok: false, error: '下载失败' }
    const s2 = make({ addons: [A('d1', { fromMarket: true, assetId: 'a/1' })] })
    await s2.actions.update(A('d1', { fromMarket: true, assetId: 'a/1' }))
    ok(notifications[0] === '下载失败', '失败时提示原因', String(notifications[0]))
    ok(s2.actions.updating.value === null, '失败也要清空进度(不能卡在进度条)')
  }

  // ---------- 6. 切换历史版本 ----------
  section('6. installVersion:切换版本')
  {
    reset()
    const { actions } = make()
    const target = A('d1', { assetId: 'a/1', name: 'Demo', storeUrl: 'https://s/1' })
    actions.openVersions(target)
    // 注意:ref 会把对象包成响应式代理,不能用 === 比原对象,只能按字段断言
    ok(actions.versionTarget.value?.dirName === 'd1', 'openVersions 记录目标', JSON.stringify(actions.versionTarget.value))
    await actions.installVersion('1.5.0')
    ok(nCalls('install') === 1, '调用 installAsset')
    ok(calls[0][1].version === '1.5.0', '透传版本号')
    ok(calls[0][1].assetMeta.title === 'Demo' && calls[0][1].assetMeta.storeUrl === 'https://s/1', '带上来源元信息')
    ok(actions.versionTarget.value === null, '切换后关闭选择器')
    ok(/已切换到 1\.5\.0/.test(notifications[0] || ''), '提示切换结果', String(notifications[0]))

    // 无 assetId 时不开选择器
    reset()
    actions.openVersions(A('d2', { assetId: undefined }))
    ok(actions.versionTarget.value === null, '无 assetId 时不开版本选择器')

    // 安装进行中:不允许再开版本选择器
    reset()
    deferService = true
    const s = make()
    s.actions.openVersions(A('d1', { assetId: 'a/1' }))
    const p = s.actions.installVersion('1.0.0')
    await sleep()
    ok(!!s.actions.updating.value, '切换版本进行中')
    s.actions.openVersions(A('d2', { assetId: 'b/2' }))
    ok(s.actions.versionTarget.value === null, '安装进行中不允许再开版本选择器')
    resolvePending()
    await p
    ok(s.actions.updating.value === null, '切换完成后清空进度')
  }

  // ---------- 7. 复制到其他项目 ----------
  section('7. 复制到其他项目')
  {
    reset()
    const { actions, selection } = make()
    actions.openCopy()
    ok(actions.showCopy.value === false, '未选中任何插件时不打开复制对话框')

    selection.toggleCheck('d1')
    actions.openCopy()
    ok(actions.showCopy.value === true, '有选中时打开')
    ok(actions.copyTargetId.value === 'godot/project/p2', '默认选中第一个非当前项目', String(actions.copyTargetId.value))
    ok(actions.copyTargets.value.length === 1, '复制目标排除当前项目', String(actions.copyTargets.value.length))

    await actions.confirmCopy()
    ok(nCalls('copy') === 1, '调用复制服务')
    ok(calls[0][1].sourceProjectId === 'godot/project/p1', '带来源项目')
    ok(calls[0][1].targetProjectId === 'godot/project/p2', '带目标项目')
    ok(calls[0][1].dirNames.join(',') === 'd1', '带选中的目录')
    ok(actions.showCopy.value === false, '成功后关闭对话框')
    ok(/已复制 2 个插件到「Beta」/.test(notifications[0] || ''), '提示复制结果', String(notifications[0]))

    // skipped / adopted 如实进文案
    reset()
    copyResult = { ok: true, copied: 1, targetName: 'Beta', skipped: ['d9'], adopted: 2 }
    const s = make()
    s.selection.toggleCheck('d1')
    s.actions.openCopy()
    await s.actions.confirmCopy()
    ok(/跳过:d9/.test(notifications[0] || ''), '跳过项进文案', String(notifications[0]))
    ok(/其中 2 个已补回市场来源/.test(notifications[0] || ''), '补回来源数进文案', String(notifications[0]))

    // 失败保持对话框
    reset()
    copyResult = { ok: false, error: '目标不可写' }
    const f = make()
    f.selection.toggleCheck('d1')
    f.actions.openCopy()
    await f.actions.confirmCopy()
    ok(notifications[0] === '目标不可写', '失败提示原因', String(notifications[0]))
    ok(f.actions.showCopy.value === true, '失败时保持对话框打开')
    ok(f.actions.copying.value === false, '失败后 copying 复位')

    // 素材条目走 copyAssetToProject(按 assetId),与插件分区处理
    reset()
    const assetRow = { ...A('asset-pack'), kind: 'asset', assetId: 'pub/pack', fromMarket: true, versionString: '1.0.0' }
    const s2 = make({ addons: [assetRow] })
    s2.selection.toggleCheck('asset-pack')
    s2.actions.openCopy()
    await s2.actions.confirmCopy()
    ok(nCalls('copyAsset') === 1, '素材条目调用 copyAssetToProject')
    ok(calls.find((c) => c[0] === 'copyAsset')[1].assetId === 'pub/pack', '带 assetId')
    ok(calls.find((c) => c[0] === 'copyAsset')[1].targetProjectId === 'godot/project/p2', '带目标项目')
    ok(nCalls('copy') === 0, '素材条目不触发插件复制')
    ok(/已复制 3 项到「Beta」/.test(notifications[0] || ''), '素材复制提示按「项」计数', String(notifications[0]))
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
