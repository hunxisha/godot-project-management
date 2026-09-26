// 纯素材(非插件)安装链路的回归测试。
//
// 商店 API 的 type 字段把素材也归在 Addon 类型下,所以安装必须按 zip 内容嗅探分流:
//   · 含 plugin.cfg → 插件链路(进 addons/ 并启用);
//   · 否则 → 素材链路:按原结构落到项目根,记录文件清单,卸载/更新按清单执行。
//
// 覆盖:素材安装与清单、listAddons 带出素材条目、冲突整包拒绝、插件链路回归、
// 完整项目拒绝、更新先清后装、按清单卸载与空目录清理、清单越界防护、重名互不干扰。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/assets-files.test.js
//   node src-ztools/preload/lib/__tests__/assets-files.test.js --no-immediate
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))

const LIB = positional[0] || path.resolve(__dirname, '..')
const WORK = positional[1] || fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-asset-files-test-'))

if (!fs.existsSync(path.join(LIB, 'assets.js'))) {
  console.error(`找不到被测模块: ${path.join(LIB, 'assets.js')}`)
  process.exit(2)
}

if (flags.has('--no-immediate')) {
  delete globalThis.setImmediate
  console.log('[harness] setImmediate 已移除(模拟宿主沙箱)')
}
console.log(`[harness] lib=${LIB}`)
console.log(`[harness] work=${WORK}`)

// ---------- 内存版 ztools.db 桩(同 addons.test.js) ----------
const docs = new Map()
let rev = 0
global.window = {
  ztools: {
    db: {
      get: (id) => (docs.has(id) ? { ...docs.get(id) } : null),
      put: (doc) => {
        if (!doc || !doc._id) return { error: 'no id' }
        rev++
        docs.set(doc._id, { ...doc, _rev: `r${rev}` })
        return { ok: true }
      },
      remove: (doc) => {
        docs.delete(doc._id)
        return { ok: true }
      },
      allDocs: (prefix) => [...docs.values()].filter((d) => d._id.startsWith(prefix)).map((d) => ({ ...d }))
    }
  }
}

// ---------- http 打桩(必须在 require assets.js 之前) ----------
// 网络层替换为本地夹具:getJson 路由到预置的 detail/releases,downloadFile 直接复制夹具 zip。
const state = { fixtureZip: '', downloads: 0 }
const routes = { detail: {}, releases: {} }

function stub(relFile, exports) {
  const abs = require.resolve(path.join(LIB, relFile))
  require.cache[abs] = { id: abs, filename: abs, loaded: true, children: [], paths: [], exports }
}

function idOf(url, seg) {
  return url.slice(url.indexOf(seg) + seg.length).replace(/\/$/, '')
}

stub('http.js', {
  getJson: async (url) => {
    if (url.includes('/releases/')) return routes.releases[idOf(url, '/releases/')]
    if (url.includes('/assets/')) return routes.detail[idOf(url, '/assets/')]
    throw new Error('stub http: unexpected url ' + url)
  },
  downloadFile: (url, dest) => {
    if (!state.fixtureZip) throw new Error('stub http: 没有夹具 zip')
    state.downloads++
    fs.copyFileSync(state.fixtureZip, dest)
    return { promise: Promise.resolve() }
  },
  getText: async () => {
    throw new Error('stub http: getText unexpected')
  }
})

const { createZip, ensureDir } = require(path.join(LIB, 'extract.js'))
const assets = require(path.join(LIB, 'assets.js'))
const projects = require(path.join(LIB, 'projects.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

// ---------- 夹具 ----------

/** 建一个空项目目录(project.godot 的启用行为空) */
function makeProject(name, addonDirs = []) {
  const root = path.join(WORK, name)
  fs.mkdirSync(root, { recursive: true })
  const enabled = addonDirs.map((d) => `"res://addons/${d}/plugin.cfg"`).join(', ')
  fs.writeFileSync(path.join(root, 'project.godot'), [
    'config_version=5',
    '',
    '[application]',
    `config/name="${name}"`,
    '',
    '[editor_plugins]',
    '',
    `enabled=PackedStringArray(${enabled})`,
    ''
  ].join('\n'))
  for (const d of addonDirs) {
    const dir = path.join(root, 'addons', d)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plugin.cfg'), `[plugin]\n\nname="${d}"\nversion="1.0.0"\nauthor="T"\nscript="${d}.gd"\n`)
    fs.writeFileSync(path.join(dir, `${d}.gd`), '# demo\n')
  }
  return root
}

let zipSeq = 0
/** files: 相对路径 → 文本内容;打成真 zip 供 downloadFile 桩返回 */
async function buildZip(files) {
  const src = path.join(WORK, `zipsrc-${++zipSeq}`)
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(src, rel)
    ensureDir(path.dirname(p))
    fs.writeFileSync(p, content)
  }
  const zip = path.join(WORK, `fixture-${zipSeq}.zip`)
  await createZip(src, zip)
  fs.rmSync(src, { recursive: true, force: true })
  return zip
}

/** 预置某 assetId 的商店 detail/releases 响应 */
function serveAsset(assetId, { name = 'Asset', version = '1.0.0' } = {}) {
  routes.detail[assetId] = { name, description: 'd', tags: [] }
  routes.releases[assetId] = [{ version, download_url: 'https://stub/download', created: '2026-01-01', stable: true }]
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  // ---------- 1 ----------
  section('1. 纯素材安装:按 zip 原结构落到项目根')
  const rootA = makeProject('Alpha')
  const pidA = projects.addProject(rootA).project.id
  serveAsset('kenney/nature-pack', { name: 'Nature Pack', version: '2.1.0' })
  state.fixtureZip = await buildZip({
    'models/tree.glb': 'tree-glb',
    'models/rock.glb': 'rock-glb',
    'sprites/grass.png': 'grass-png',
    'README.md': 'readme'
  })
  const r1 = await assets.installAsset({ projectId: pidA, assetId: 'kenney/nature-pack', assetMeta: { title: 'Nature Pack' } })
  ok(r1.ok === true, '安装成功', r1.error)
  ok(r1.addon && r1.addon.kind === 'asset', `返回 kind=asset(${r1.addon && r1.addon.kind})`)
  ok(r1.addon && r1.addon.enabled === false, '素材不涉及启用')
  ok(fs.readFileSync(path.join(rootA, 'models', 'tree.glb'), 'utf8') === 'tree-glb', '文件落到项目根 models/')
  ok(fs.readFileSync(path.join(rootA, 'sprites', 'grass.png'), 'utf8') === 'grass-png', '文件落到项目根 sprites/')
  ok(fs.readFileSync(path.join(rootA, 'README.md'), 'utf8') === 'readme', '根下散文件也保留')
  ok(!fs.existsSync(path.join(rootA, 'addons')), '不创建 addons/ 目录')
  ok(!fs.readFileSync(path.join(rootA, 'project.godot'), 'utf8').includes('PackedStringArray("'), '未改写 project.godot 启用行')
  const doc1 = docs.get(`godot/asset/${pidA}/kenney/nature-pack`)
  ok(!!doc1 && doc1.kind === 'asset', '记录 kind=asset')
  ok(!!doc1 && Array.isArray(doc1.installedPaths) && doc1.installedPaths.length === 4,
    `清单 4 条(实际 ${doc1 && doc1.installedPaths && doc1.installedPaths.length})`)
  ok(!!doc1 && JSON.stringify([...doc1.dirNames].sort()) === JSON.stringify(['README.md', 'models', 'sprites']),
    'dirNames 为顶层条目')

  // ---------- 2 ----------
  section('2. listAddons 带出素材条目')
  const listA = assets.listAddons(pidA)
  const ast = listA.find((a) => a.kind === 'asset')
  ok(!!ast, '存在素材条目')
  ok(!!ast && ast.dirName === 'nature-pack', `dirName 取 slug(${ast && ast.dirName})`)
  ok(!!ast && ast.assetId === 'kenney/nature-pack' && ast.fromMarket === true, 'assetId 与来源标记正确')
  ok(!!ast && Array.isArray(ast.assetPaths) && ast.assetPaths.length === 4, '条目携带安装清单')
  ok(!!ast && ast.storeUrl === 'https://store.godotengine.org/asset/kenney/nature-pack/', '商店链接按 assetId 拼装')
  ok(!!ast && ast.hasCfg === false && ast.enabled === false, '素材无 plugin.cfg、无启用状态')

  // ---------- 3 ----------
  section('3. 冲突检测:项目已有同名文件时整包拒绝')
  const rootB = makeProject('Beta')
  ensureDir(path.join(rootB, 'sprites'))
  fs.writeFileSync(path.join(rootB, 'sprites', 'grass.png'), 'mine')
  const pidB = projects.addProject(rootB).project.id
  const r3 = await assets.installAsset({ projectId: pidB, assetId: 'kenney/nature-pack' })
  ok(r3.ok === false && /同名文件/.test(r3.error || ''), `安装被拒绝(${r3.error})`)
  ok(fs.readFileSync(path.join(rootB, 'sprites', 'grass.png'), 'utf8') === 'mine', '已有文件未被覆盖')
  ok(!fs.existsSync(path.join(rootB, 'models')), '未发生部分写入(models/ 不存在)')
  ok(!docs.get(`godot/asset/${pidB}/kenney/nature-pack`), '被拒安装不写记录')

  // ---------- 4 ----------
  section('4. 含 plugin.cfg 的 zip 仍走插件链路')
  serveAsset('nathanhoad/dialogue-manager', { name: 'Dialogue Manager', version: '4.1.0' })
  state.fixtureZip = await buildZip({
    'addons/dialogue_manager/plugin.cfg': '[plugin]\n\nname="Dialogue Manager"\nversion="1.2.3"\nauthor="T"\nscript="dm.gd"\n',
    'addons/dialogue_manager/dm.gd': '# demo\n'
  })
  const r4 = await assets.installAsset({ projectId: pidA, assetId: 'nathanhoad/dialogue-manager' })
  ok(r4.ok === true, '安装成功', r4.error)
  ok(r4.addon && r4.addon.kind === 'addon' && r4.addon.enabled === true, 'kind=addon 且默认启用')
  ok(fs.existsSync(path.join(rootA, 'addons', 'dialogue_manager', 'plugin.cfg')), '插件目录在 addons/ 下')
  const doc4 = docs.get(`godot/asset/${pidA}/nathanhoad/dialogue-manager`)
  ok(!!doc4 && doc4.kind === 'addon', '记录 kind=addon')

  // ---------- 5 ----------
  section('5. 完整项目/模板拒绝装入现有项目')
  serveAsset('some/template', { name: 'Template', version: '1.0.0' })
  state.fixtureZip = await buildZip({
    'project.godot': 'config_version=5\n[application]\nconfig/name="Tpl"\n',
    'icon.svg': '<svg/>'
  })
  const r5 = await assets.installAsset({ projectId: pidA, assetId: 'some/template' })
  ok(r5.ok === false && /完整项目/.test(r5.error || ''), `被拒绝(${r5.error})`)
  ok(!fs.existsSync(path.join(rootA, 'icon.svg')), '未写入任何文件')

  // ---------- 6 ----------
  section('6. 更新素材:先按旧清单清理再安装')
  serveAsset('kenney/nature-pack', { name: 'Nature Pack', version: '2.2.0' })
  state.fixtureZip = await buildZip({
    'models/mushroom.glb': 'mushroom-glb',
    'sprites/flower.png': 'flower-png'
  })
  const r6 = await assets.updateAsset({ projectId: pidA, assetId: 'kenney/nature-pack' })
  ok(r6.ok === true, '更新成功', r6.error)
  ok(!fs.existsSync(path.join(rootA, 'models', 'tree.glb')), '旧文件 tree.glb 已清除')
  ok(!fs.existsSync(path.join(rootA, 'README.md')), '旧文件 README.md 已清除')
  ok(fs.readFileSync(path.join(rootA, 'models', 'mushroom.glb'), 'utf8') === 'mushroom-glb', '新文件就位')
  const doc6 = docs.get(`godot/asset/${pidA}/kenney/nature-pack`)
  ok(!!doc6 && doc6.versionString === '2.2.0' && doc6.installedPaths.length === 2, '记录的版本与清单已更新')

  // ---------- 7 ----------
  section('7. 卸载素材:按清单删文件并清理空目录')
  const r7 = assets.uninstallAddon({ projectId: pidA, dirName: 'nature-pack', assetId: 'kenney/nature-pack' })
  ok(r7.ok === true, '卸载成功', r7.error)
  ok(!fs.existsSync(path.join(rootA, 'models')), '清空后的 models/ 目录被清理')
  ok(!fs.existsSync(path.join(rootA, 'sprites')), '清空后的 sprites/ 目录被清理')
  ok(!docs.get(`godot/asset/${pidA}/kenney/nature-pack`), '安装记录已删除')
  ok(fs.existsSync(path.join(rootA, 'addons', 'dialogue_manager', 'plugin.cfg')), '插件不受影响')
  const listA7 = assets.listAddons(pidA)
  ok(listA7.some((a) => a.kind === 'addon' && a.dirName === 'dialogue_manager'), 'listAddons 仍列出插件')
  ok(!listA7.some((a) => a.kind === 'asset'), '素材条目已从列表消失')

  // ---------- 8 ----------
  section('8. 边界:清单越界路径不生效')
  const rootC = makeProject('Evil')
  const pidC = projects.addProject(rootC).project.id
  docs.set(`godot/asset/${pidC}/evil/escape`, {
    _id: `godot/asset/${pidC}/evil/escape`,
    projectId: pidC,
    assetId: 'evil/escape',
    title: 'Escape',
    versionString: '1.0.0',
    kind: 'asset',
    dirNames: ['..'],
    installedPaths: ['../outside.txt', 'normal/inner.txt'],
    installedAt: Date.now()
  })
  fs.writeFileSync(path.join(WORK, 'outside.txt'), 'keep')
  ensureDir(path.join(rootC, 'normal'))
  fs.writeFileSync(path.join(rootC, 'normal', 'inner.txt'), 'x')
  const r8 = assets.uninstallAddon({ projectId: pidC, dirName: 'escape', assetId: 'evil/escape' })
  ok(r8.ok === true, '卸载执行成功')
  ok(fs.existsSync(path.join(WORK, 'outside.txt')), '越界路径未被删除')
  ok(!fs.existsSync(path.join(rootC, 'normal', 'inner.txt')), '清单内文件正常删除')
  ok(!fs.existsSync(path.join(rootC, 'normal')), '空目录被清理')

  // ---------- 9 ----------
  section('9. 边界:插件与素材顶层目录重名时互不干扰')
  const rootD = makeProject('Dup', ['models'])
  const pidD = projects.addProject(rootD).project.id
  docs.set(`godot/asset/${pidD}/pub/asset-with-models`, {
    _id: `godot/asset/${pidD}/pub/asset-with-models`,
    projectId: pidD,
    assetId: 'pub/asset-with-models',
    title: 'Asset With Models',
    versionString: '1.0.0',
    kind: 'asset',
    dirNames: ['models'],
    installedPaths: ['models/file.glb'],
    installedAt: Date.now()
  })
  ensureDir(path.join(rootD, 'models'))
  fs.writeFileSync(path.join(rootD, 'models', 'file.glb'), 'glb')
  const r9 = assets.uninstallAddon({ projectId: pidD, dirName: 'models' })
  ok(r9.ok === true, '按目录名卸载插件成功')
  ok(!fs.existsSync(path.join(rootD, 'addons', 'models')), '插件目录已删除')
  ok(!!docs.get(`godot/asset/${pidD}/pub/asset-with-models`), '素材记录未被插件卸载误删')
  ok(fs.existsSync(path.join(rootD, 'models', 'file.glb')), '素材文件未被误删')

  // ---------- 10 ----------
  section('10. 安装预览:zip 内容归纳为安装计划')
  serveAsset('pub/preview-pack', { name: 'Preview Pack', version: '1.0.0' })
  state.fixtureZip = await buildZip({
    'models/a.glb': 'a',
    'sprites/b.png': 'b',
    'README.md': 'r'
  })
  const pv = await assets.previewAssetInstall({ projectId: pidA, assetId: 'pub/preview-pack' })
  ok(pv.ok === true && !!pv.plan, '预览成功', pv.error)
  ok(pv.plan.kind === 'asset', `kind=asset(${pv.plan && pv.plan.kind})`)
  ok(pv.plan.fileCount === 3, `文件数 3(实际 ${pv.plan && pv.plan.fileCount})`)
  ok(pv.plan.singleTopDir === '', '多顶层条目时无 wrapper')
  ok(pv.plan.conflicts.asIs.count === 0 && pv.plan.conflicts.stripped === null, '无冲突且无剥离布局信息')
  ok(!!pv.stageId && fs.existsSync(path.join(os.tmpdir(), pv.stageId, 'asset.zip')), '暂存包已就位')
  ok(pv.versionString === '1.0.0' && pv.title === 'Preview Pack', '预览带出版本与名称')

  // ---------- 11 ----------
  section('11. 预览识别 wrapper 与完整项目;插件计划照常归纳')
  serveAsset('pub/wrapped', { name: 'Wrapped', version: '1.0.0' })
  state.fixtureZip = await buildZip({ 'MyPack/models/x.glb': 'x', 'MyPack/README.md': 'r' })
  const pv2 = await assets.previewAssetInstall({ projectId: pidA, assetId: 'pub/wrapped' })
  ok(pv2.plan.singleTopDir === 'MyPack', `识别唯一顶层目录(${pv2.plan.singleTopDir})`)
  ok(pv2.plan.topEntries.length === 1 && pv2.plan.topEntries[0].name === 'MyPack' && pv2.plan.topEntries[0].isDir, '顶层条目为 wrapper 目录')
  ok(pv2.plan.conflicts.stripped !== null, '提供剥离布局的冲突信息')

  serveAsset('pub/tpl2', { name: 'Tpl2', version: '1.0.0' })
  state.fixtureZip = await buildZip({ 'project.godot': 'config_version=5\n', 'icon.svg': '<svg/>' })
  const pv3 = await assets.previewAssetInstall({ projectId: pidA, assetId: 'pub/tpl2' })
  ok(pv3.plan.kind === 'project', `根级 project.godot 判为完整项目(${pv3.plan.kind})`)

  serveAsset('pub/tpl3', { name: 'Tpl3', version: '1.0.0' })
  state.fixtureZip = await buildZip({ 'Tpl/project.godot': 'config_version=5\n', 'Tpl/icon.svg': '<svg/>' })
  const pv4 = await assets.previewAssetInstall({ projectId: pidA, assetId: 'pub/tpl3' })
  ok(pv4.plan.kind === 'project', 'wrapper 根级 project.godot 同样判为完整项目')

  serveAsset('pub/addon-x', { name: 'AddonX', version: '1.0.0' })
  state.fixtureZip = await buildZip({ 'addons/xx/plugin.cfg': '[plugin]\nname="X"\n', 'addons/xx/x.gd': '#x' })
  const pv5 = await assets.previewAssetInstall({ projectId: pidA, assetId: 'pub/addon-x' })
  ok(pv5.plan.kind === 'addon', '含 plugin.cfg 判为插件')

  // ---------- 12 ----------
  section('12. 暂存复用:凭 stageId 安装不再下载,完成后清理')
  const downloadsBefore = state.downloads
  const stageDir2 = path.join(os.tmpdir(), pv2.stageId)
  const r12 = await assets.installAsset({ projectId: pidA, assetId: 'pub/wrapped', stageId: pv2.stageId, stripTopDir: true })
  ok(r12.ok === true && r12.addon.kind === 'asset', '安装成功(素材)', r12.error)
  ok(state.downloads === downloadsBefore, '未发生新的下载(复用暂存包)')
  ok(!fs.existsSync(stageDir2), '暂存目录已清理')
  ok(fs.existsSync(path.join(rootA, 'models', 'x.glb')), '剥离 wrapper 后内容并入项目根')
  ok(!fs.existsSync(path.join(rootA, 'MyPack')), 'wrapper 目录未保留')
  const d12 = docs.get(`godot/asset/${pidA}/pub/wrapped`)
  ok(!!d12 && d12.stripTopDir === true, '记录剥离选择')
  const r12b = assets.uninstallAddon({ projectId: pidA, dirName: 'wrapped', assetId: 'pub/wrapped' })
  ok(r12b.ok === true && !fs.existsSync(path.join(rootA, 'models')), '剥离布局的清单卸载正常')

  // ---------- 13 ----------
  section('13. wrapper 默认保留,更新沿用上次选择')
  serveAsset('pub/keep', { name: 'Keep', version: '1.0.0' })
  state.fixtureZip = await buildZip({ 'KeepDir/models/y.glb': 'y' })
  const r13 = await assets.installAsset({ projectId: pidA, assetId: 'pub/keep' })
  ok(r13.ok === true, '安装成功', r13.error)
  ok(fs.existsSync(path.join(rootA, 'KeepDir', 'models', 'y.glb')), '默认保留顶层目录')
  serveAsset('pub/keep', { name: 'Keep', version: '1.1.0' })
  state.fixtureZip = await buildZip({ 'KeepDir/models/y2.glb': 'y2' })
  const r13b = await assets.updateAsset({ projectId: pidA, assetId: 'pub/keep' })
  ok(r13b.ok === true, '更新成功', r13b.error)
  ok(fs.existsSync(path.join(rootA, 'KeepDir', 'models', 'y2.glb')), '更新后仍保留顶层目录(沿用上次选择)')
  ok(!fs.existsSync(path.join(rootA, 'models')), '未错误并入项目根')

  // ---------- 14 ----------
  section('14. 取消预览:释放暂存包(幂等)')
  serveAsset('pub/cancel', { name: 'Cancel', version: '1.0.0' })
  state.fixtureZip = await buildZip({ 'c.dat': 'c' })
  const pv6 = await assets.previewAssetInstall({ projectId: pidA, assetId: 'pub/cancel' })
  const stageDir6 = path.join(os.tmpdir(), pv6.stageId)
  ok(fs.existsSync(stageDir6), '暂存包在')
  const c1 = assets.cancelStagedAsset(pv6.stageId)
  ok(c1.ok === true && !fs.existsSync(stageDir6), '取消后暂存目录被删除')
  ok(assets.cancelStagedAsset(pv6.stageId).ok === true, '重复取消幂等')
  // 过期 stageId 传入 installAsset:回退为正常下载安装
  const r14 = await assets.installAsset({ projectId: pidA, assetId: 'pub/cancel', stageId: pv6.stageId })
  ok(r14.ok === true, '无效 stageId 回退为正常下载安装', r14.error)
  ok(fs.existsSync(path.join(rootA, 'c.dat')), '回退安装正常落盘')

  // ---------- 15 ----------
  section('15. 完整项目另存为新项目')
  serveAsset('pub/tpl-save', { name: 'Tpl Save', version: '1.0.0' })
  state.fixtureZip = await buildZip({
    'TplSave/project.godot': 'config_version=5\n[application]\nconfig/name="Tpl Save"\n',
    'TplSave/icon.svg': '<svg/>',
    'TplSave/main.tscn': 'scene'
  })
  const destRoot = path.join(WORK, 'dest')
  ensureDir(destRoot)
  const r15 = await assets.saveAssetAsProject({ assetId: 'pub/tpl-save', destRoot })
  ok(r15.ok === true, '另存成功', r15.error)
  ok(fs.existsSync(path.join(destRoot, 'tpl-save', 'project.godot')), 'wrapper 剥离后项目落在 slug 子目录')
  ok(fs.existsSync(path.join(destRoot, 'tpl-save', 'main.tscn')), '项目文件完整')
  ok(r15.projectName === 'Tpl Save', `项目名取自 project.godot(${r15.projectName})`)
  ok(!!r15.projectId && !!docs.get(r15.projectId), '已登记进项目列表')

  // 复用暂存包:不再下载
  const pv7 = await assets.previewAssetInstall({ projectId: pidA, assetId: 'pub/tpl-save' })
  ok(pv7.plan && pv7.plan.kind === 'project', '预览判为完整项目')
  const downloadsBefore15 = state.downloads
  const destRoot2 = path.join(WORK, 'dest2')
  ensureDir(destRoot2)
  const r15b = await assets.saveAssetAsProject({ assetId: 'pub/tpl-save', stageId: pv7.stageId, destRoot: destRoot2 })
  ok(r15b.ok === true, '凭暂存包另存成功', r15b.error)
  ok(state.downloads === downloadsBefore15, '未发生新的下载(复用暂存包)')

  // 边界:子目录已存在、非完整项目、目标根不存在
  const r15c = await assets.saveAssetAsProject({ assetId: 'pub/tpl-save', destRoot })
  ok(r15c.ok === false && /已存在/.test(r15c.error || ''), `子目录已存在时报错(${r15c.error})`)
  serveAsset('pub/notproject', { name: 'NotProject', version: '1.0.0' })
  state.fixtureZip = await buildZip({ 'readme.txt': 'not a project' })
  const r15d = await assets.saveAssetAsProject({ assetId: 'pub/notproject', destRoot })
  ok(r15d.ok === false && /project\.godot/.test(r15d.error || ''), `没有 project.godot 时报错(${r15d.error})`)
  const r15e = await assets.saveAssetAsProject({ assetId: 'pub/tpl-save', destRoot: path.join(WORK, 'no-such-dir') })
  ok(r15e.ok === false && /目标目录/.test(r15e.error || ''), '目标根不存在时报错')

  // ---------- 16 ----------
  section('16. 仅下载 zip:命名、重名序号与目录校验')
  serveAsset('pub/dl', { name: 'DL', version: '3.1.4' })
  state.fixtureZip = await buildZip({ 'a.txt': 'a' })
  const dlDir = path.join(WORK, 'dl')
  ensureDir(dlDir)
  const r16 = await assets.downloadAssetZip({ assetId: 'pub/dl', destDir: dlDir })
  ok(r16.ok === true && r16.file === 'dl-3.1.4.zip', `按 slug-版本命名(${r16.file})`)
  ok(fs.existsSync(path.join(dlDir, 'dl-3.1.4.zip')), 'zip 落盘')
  const r16b = await assets.downloadAssetZip({ assetId: 'pub/dl', destDir: dlDir })
  ok(r16b.ok === true && r16b.file === 'dl-3.1.4-2.zip', `重名自动加序号(${r16b.file})`)
  const r16c = await assets.downloadAssetZip({ assetId: 'pub/dl', destDir: path.join(WORK, 'nope') })
  ok(r16c.ok === false && /目标目录/.test(r16c.error || ''), '目录不存在时报错')

  console.log(`\n${'='.repeat(56)}`)
  console.log(`PASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log('  - ' + f)
    process.exitCode = 1
  } else {
    console.log('全部通过')
  }
}

main().catch((e) => {
  console.error('[harness] 未捕获异常:', e)
  process.exit(1)
})
