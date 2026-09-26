// useMarketInstall 回归测试:市场资产安装的进度、已装集合、版本选择器与安装确认层。
//
// 安装是插件市场里唯一会写目标项目目录的操作。这里锁住几条容易出错的约束:
//   1. 进度回调必须按 assetId 配对(否则切换资产时进度会串到别的卡片上)
//   2. 安装中/确认层打开时不允许并发安装,也不允许再开版本选择器
//   3. 无目标项目时不发请求
//   4. 确认层流程:插件计划直接安装;素材/完整项目弹确认层;取消要释放暂存包;
//      「并入项目根」选择按 slug 写入设置
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
let previewCalls = []
let previewImpl = null
let cancelCalls = []
let saveProjectCalls = []
let saveProjectImpl = null
let downloadZipCalls = []
let downloadZipImpl = null
/** showOpenDialog 的返回:undefined=取消,字符串=选中的目录 */
let pickedDir = 'C:/picked'
const notifications = []
let reloadCount = 0

// 设置文档内存库(bridge 的 getSettings/saveSettings 走这里)
const docs = new Map()

global.window = {
  ztools: {
    db: {
      get: (id) => (docs.has(id) ? { ...docs.get(id) } : null),
      put: (doc) => {
        if (!doc || !doc._id) return { error: 'no id' }
        docs.set(doc._id, { ...doc })
        return { ok: true }
      },
      remove: (doc) => {
        docs.delete(doc._id)
        return { ok: true }
      },
      allDocs: (prefix) => [...docs.values()].filter((d) => d._id.startsWith(prefix))
    },
    showOpenDialog: () => (pickedDir === undefined ? undefined : [pickedDir])
  },
  services: {
    installAsset(opts, onProgress) {
      installCalls.push({ opts, onProgress })
      return installImpl(opts, onProgress)
    },
    previewAssetInstall(opts, onProgress) {
      previewCalls.push({ opts, onProgress })
      return previewImpl(opts, onProgress)
    },
    cancelStagedAsset(stageId) {
      cancelCalls.push(stageId)
      return { ok: true }
    },
    saveAssetAsProject(opts, onProgress) {
      saveProjectCalls.push({ opts, onProgress })
      return saveProjectImpl(opts, onProgress)
    },
    downloadAssetZip(opts, onProgress) {
      downloadZipCalls.push({ opts, onProgress })
      return downloadZipImpl(opts, onProgress)
    }
  }
}

function settingsDoc() {
  return docs.get('godot/settings')
}

const ADDON_PLAN = {
  kind: 'addon', topEntries: [{ name: 'addons', isDir: true, files: 1 }], fileCount: 1,
  zipSize: 10, singleTopDir: '', conflicts: { asIs: { count: 0, samples: [] }, stripped: null }
}

function assetPlan(over = {}) {
  return {
    kind: 'asset', topEntries: [{ name: 'models', isDir: true, files: 2 }], fileCount: 2,
    zipSize: 100, singleTopDir: '', conflicts: { asIs: { count: 0, samples: [] }, stripped: null },
    ...over
  }
}

function previewOk(stageId, plan) {
  return { ok: true, stageId, title: 'Demo', versionString: '1.0.0', plan }
}

function reset() {
  installCalls = []
  previewCalls = []
  cancelCalls = []
  saveProjectCalls = []
  downloadZipCalls = []
  notifications.length = 0
  reloadCount = 0
  docs.delete('godot/settings')
  pickedDir = 'C:/picked'
  installImpl = () => Promise.resolve({ ok: true, addon: { title: 'Demo', versionString: '1.0.0', enabled: true } })
  previewImpl = () => Promise.resolve(previewOk('stage-1', ADDON_PLAN))
  saveProjectImpl = () => Promise.resolve({ ok: true, projectName: 'Tpl', projectId: 'godot/project/p9' })
  downloadZipImpl = () => Promise.resolve({ ok: true, file: 'b-1.0.0.zip' })
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

  // ---------- 2. install 成功路径(插件计划:直接安装) ----------
  section('2. install:插件计划直接安装 → 提示 + 刷新已装插件')
  {
    reset()
    const { inst, targetId } = make()
    await inst.install(asset('a/b'))
    ok(previewCalls.length === 1, '先发起一次预览(预下载)')
    ok(installCalls.length === 1, '插件计划不弹确认层,直接安装')
    ok(installCalls[0].opts.projectId === targetId.value, '带上目标项目 id', installCalls[0].opts.projectId)
    ok(installCalls[0].opts.assetId === 'a/b', '带上 assetId')
    ok(installCalls[0].opts.version === undefined, '未指定版本时不传 version(取最新)')
    ok(installCalls[0].opts.stageId === 'stage-1', '复用预览暂存包', String(installCalls[0].opts.stageId))
    ok(installCalls[0].opts.assetMeta.title === 'T-a/b', '带上 assetMeta 供来源记录使用')
    ok(inst.installing.value === null, '完成后清空进度')
    ok(reloadCount === 1, '刷新已装插件')
    ok(notifications.length === 1 && /已安装/.test(notifications[0]), '提示安装成功', notifications[0])
  }

  // ---------- 3. install 失败与前置条件 ----------
  section('3. install:失败与前置条件')
  {
    reset()
    previewImpl = () => Promise.resolve({ ok: false, error: '磁盘满了' })
    const { inst } = make()
    await inst.install(asset('a/b'))
    ok(installCalls.length === 0, '预览失败不进入安装')
    ok(notifications[0] === '磁盘满了', '失败时提示服务端给的原因', String(notifications[0]))
    ok(reloadCount === 0, '失败不刷新已装插件')

    reset()
    const noTarget = make({ targetId: ref('') })
    await noTarget.inst.install(asset('a/b'))
    ok(previewCalls.length === 0 && installCalls.length === 0, '无目标项目时不发请求')
    ok(noTarget.inst.installing.value === null, '也不进入安装态')
  }

  // ---------- 4. 进度按 assetId 配对 ----------
  section('4. 进度回调:预览与安装两阶段都按 assetId 配对,不串台')
  {
    reset()
    let previewCb = null
    let resolvePreview
    previewImpl = (opts, onProgress) => {
      previewCb = onProgress
      return new Promise((resolve) => { resolvePreview = () => resolve(previewOk('stage-4', ADDON_PLAN)) })
    }
    let progressCb = null
    let resolveLater
    installImpl = (opts, onProgress) => {
      progressCb = onProgress
      return new Promise((resolve) => { resolveLater = () => resolve({ ok: true, addon: { title: 'T' } }) })
    }
    const { inst } = make()
    const p = inst.install(asset('a/b'))
    await sleep()
    ok(inst.installing.value && inst.installing.value.assetId === 'a/b', '预览阶段进入安装态并记录 assetId')

    previewCb({ stage: 'downloading', received: 512, total: 1024 })
    ok(Math.round(inst.installing.value.percent) === 50, '预览下载进度换算为百分比', String(inst.installing.value.percent))
    ok(/下载中/.test(inst.installing.value.stage), '阶段文案为下载中', inst.installing.value.stage)

    resolvePreview()
    await sleep()
    ok(installCalls.length === 1, '预览完成后进入安装')
    ok(inst.installing.value && inst.installing.value.assetId === 'a/b', '安装阶段仍在安装态')

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
    ok(previewCalls[0].opts.version === '1.2.0', '预览按选择的版本取包')
    ok(installCalls[0].opts.version === '1.2.0', 'version 透传给服务', String(installCalls[0].opts.version))
    ok(/1\.0\.0/.test(notifications[0] || ''), '成功提示带上版本号', String(notifications[0]))
  }

  // ---------- 7. 并发保护 ----------
  section('7. 并发保护:预览/安装进行中不再受理')
  {
    reset()
    let resolveLater
    previewImpl = () => new Promise((resolve) => { resolveLater = () => resolve(previewOk('stage-7', ADDON_PLAN)) })
    const { inst } = make()
    const p = inst.install(asset('a/b'))
    await sleep()
    ok(inst.installing.value !== null, '预览进行中')

    await inst.install(asset('c/d'))
    ok(previewCalls.length === 1 && installCalls.length === 0, '预览中再次 install 被忽略', String(previewCalls.length))

    inst.openPicker(asset('c/d'))
    ok(inst.picker.value === null, '预览中不允许打开版本选择器')

    resolveLater()
    await p
    await sleep()
    ok(inst.installing.value === null, '结束后恢复可安装')
    inst.openPicker(asset('c/d'))
    ok(inst.picker.value !== null, '结束后可正常打开选择器')
  }

  // ---------- 8. 素材确认层 ----------
  section('8. 素材计划:弹确认层,确认后复用暂存包并记忆选择')
  {
    reset()
    previewImpl = () => Promise.resolve(previewOk('stage-8', assetPlan({ singleTopDir: 'MyPack', conflicts: { asIs: { count: 0, samples: [] }, stripped: { count: 0, samples: [] } } })))
    const { inst } = make()
    await inst.install(asset('a/b'))
    ok(inst.preview.value !== null && inst.preview.value.stageId === 'stage-8', '素材弹出确认层')
    ok(installCalls.length === 0, '确认前不安装')
    ok(inst.installing.value === null, '确认层打开时不占安装态')

    await inst.install(asset('c/d'))
    ok(previewCalls.length === 1, '确认层打开时不发起新的预览')

    await inst.confirmPreview(true)
    ok(inst.preview.value === null, '确认后关闭确认层')
    ok(installCalls.length === 1, '确认后发起安装')
    ok(installCalls[0].opts.stageId === 'stage-8', '复用暂存包')
    ok(installCalls[0].opts.stripTopDir === true, '「并入项目根」选择透传', String(installCalls[0].opts.stripTopDir))
    ok(cancelCalls.length === 0, '确认路径不释放暂存包')
    const st = settingsDoc()
    ok(!!st && st.assetStripTopDir && st.assetStripTopDir.b === true, '选择按 slug 写入设置')

    await sleep()
    ok(notifications.some((m) => /已安装/.test(m)), '安装成功提示')
    ok(reloadCount >= 1, '刷新已装插件')
  }

  // ---------- 9. 取消确认层 ----------
  section('9. 取消确认层:释放暂存包,不再安装')
  {
    reset()
    previewImpl = () => Promise.resolve(previewOk('stage-9', assetPlan()))
    const { inst } = make()
    await inst.install(asset('a/b'))
    ok(inst.preview.value !== null, '确认层打开')
    inst.cancelPreview()
    ok(cancelCalls.length === 1 && cancelCalls[0] === 'stage-9', '取消释放暂存包')
    ok(inst.preview.value === null, '确认层关闭')

    await inst.confirmPreview(false)
    ok(installCalls.length === 0, '取消后确认无效')
  }

  // ---------- 10. 完整项目计划 ----------
  section('10. 完整项目计划:确认层只说明,不允许安装')
  {
    reset()
    previewImpl = () => Promise.resolve(previewOk('stage-10', assetPlan({ kind: 'project', topEntries: [{ name: 'project.godot', isDir: false, files: 1 }] })))
    const { inst } = make()
    await inst.install(asset('a/b'))
    ok(inst.preview.value !== null && inst.preview.value.plan.kind === 'project', '完整项目弹确认层说明')
    await inst.confirmPreview(false)
    ok(installCalls.length === 0, '完整项目确认被忽略(兜底)')
    inst.cancelPreview()
    ok(cancelCalls.length === 1, '可取消释放暂存包')
  }

  // ---------- 11. 确认层打开时挡版本选择器 ----------
  section('11. 确认层打开时不允许打开版本选择器')
  {
    reset()
    previewImpl = () => Promise.resolve(previewOk('stage-11', assetPlan()))
    const { inst } = make()
    await inst.install(asset('a/b'))
    inst.openPicker(asset('c/d'))
    ok(inst.picker.value === null, '确认层打开时 openPicker 被忽略')
    inst.cancelPreview()
    inst.openPicker(asset('c/d'))
    ok(inst.picker.value !== null, '取消后可正常打开')
  }

  // ---------- 12. 完整项目另存为新项目 ----------
  section('12. 另存为新项目:选目录后解压登记,取消选择则不动')
  {
    reset()
    previewImpl = () => Promise.resolve(previewOk('stage-12', assetPlan({ kind: 'project' })))
    const { inst } = make()
    await inst.install(asset('a/b'))
    ok(inst.preview.value !== null && inst.preview.value.plan.kind === 'project', '完整项目弹确认层')

    pickedDir = undefined
    await inst.saveAsProject()
    ok(saveProjectCalls.length === 0, '取消选择目录时不另存')
    ok(inst.preview.value !== null, '确认层保持打开,暂存包可继续使用')

    pickedDir = 'C:/godot-projects'
    await inst.saveAsProject()
    ok(inst.preview.value === null, '另存后关闭确认层')
    ok(saveProjectCalls.length === 1, '发起另存')
    ok(saveProjectCalls[0].opts.stageId === 'stage-12', '复用暂存包')
    ok(saveProjectCalls[0].opts.destRoot === 'C:/godot-projects', '目标目录透传')
    ok(notifications.some((m) => /已添加项目/.test(m)), '提示项目已添加', notifications.join('|'))

    await inst.saveAsProject()
    ok(saveProjectCalls.length === 1, '确认层已关闭,重复调用无副作用')
  }

  // ---------- 13. 仅下载 zip ----------
  section('13. 仅下载 zip:选目录后下载,不需要安装目标')
  {
    reset()
    const { inst } = make()
    await inst.saveZip(asset('a/b'))
    ok(downloadZipCalls.length === 1, '发起下载')
    ok(downloadZipCalls[0].opts.destDir === 'C:/picked', '目标目录来自目录选择')
    ok(downloadZipCalls[0].opts.assetId === 'a/b', '带上 assetId')
    ok(notifications.some((m) => /已下载/.test(m)), '提示下载完成', notifications.join('|'))

    reset()
    pickedDir = undefined
    const { inst: inst2 } = make()
    await inst2.saveZip(asset('a/b'))
    ok(downloadZipCalls.length === 0, '取消选择目录时不下载')

    reset()
    downloadZipImpl = () => Promise.resolve({ ok: false, error: '磁盘满了' })
    const { inst: inst3 } = make()
    await inst3.saveZip(asset('a/b'))
    ok(notifications[0] === '磁盘满了', '失败提示服务端原因')
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
