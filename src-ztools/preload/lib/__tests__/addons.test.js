// 插件(Addon)来源与复制行为的回归测试。
//
// 覆盖两件事:
//   1. listAddons 解析出的来源信息(市场标记、assetId、商店链接);
//   2. copyAddonsToProject 把市场来源记录一并过户到目标项目 —— 只复制目录会让目标项目
//      把它当成手动放置的插件(显示「未知来源」并失去商店链接与版本管理入口)。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/addons.test.js
//   node src-ztools/preload/lib/__tests__/addons.test.js --no-immediate
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))

const LIB = positional[0] || path.resolve(__dirname, '..')
const WORK = positional[1] || fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-addons-test-'))

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

// ---------- 内存版 ztools.db 桩 ----------
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

/** 建一个项目目录:project.godot + addons/<dir>/plugin.cfg */
function makeProject(name, addonDirs) {
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
    fs.writeFileSync(path.join(dir, 'plugin.cfg'), [
      '[plugin]',
      '',
      `name="${d} Display"`,
      `version="1.2.3"`,
      'author="Tester"',
      `script="${d}.gd"`
    ].join('\n'))
    fs.writeFileSync(path.join(dir, `${d}.gd`), '# demo\n')
  }
  return root
}

function main() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  const rootA = makeProject('Alpha', ['dialogue_manager', 'no_meta_tool', 'handmade_tool', 'dm_extra'])
  const rootB = makeProject('Beta', [])
  const addA = projects.addProject(rootA)
  const addB = projects.addProject(rootB)
  ok(addA.ok && addB.ok, '两个项目注册成功')
  const pidA = addA.project.id
  const pidB = addB.project.id

  // 模拟「从市场安装 dialogue_manager」:写入来源记录(installAsset 会写这个文档)
  docs.set(`godot/asset/${pidA}/nathanhoad/dialogue-manager`, {
    _id: `godot/asset/${pidA}/nathanhoad/dialogue-manager`,
    projectId: pidA,
    assetId: 'nathanhoad/dialogue-manager',
    title: 'Dialogue Manager',
    versionString: 'v4.1.0',
    dirNames: ['dialogue_manager'],
    meta: { title: 'Dialogue Manager', storeUrl: 'https://store.godotengine.org/asset/nathanhoad/dialogue-manager/' },
    installedAt: Date.now()
  })
  // 另一条记录故意不带 meta.storeUrl,用于验证「按 assetId 拼装」的兜底
  docs.set(`godot/asset/${pidA}/some/publisher-asset`, {
    _id: `godot/asset/${pidA}/some/publisher-asset`,
    projectId: pidA,
    assetId: 'some/publisher-asset',
    title: 'No Meta',
    versionString: 'v2.0.0',
    dirNames: ['no_meta_tool'],
    installedAt: Date.now()
  })

  // ---------- 1 ----------
  section('1. listAddons 的来源解析')
  const listA = assets.listAddons(pidA)
  ok(listA.length === 4, `扫到 4 个插件(实际 ${listA.length})`)
  const dm = listA.find((a) => a.dirName === 'dialogue_manager')
  const noMeta = listA.find((a) => a.dirName === 'no_meta_tool')
  const hand = listA.find((a) => a.dirName === 'handmade_tool')
  ok(!!dm && dm.fromMarket === true, 'dialogue_manager 标记为来自市场')
  ok(dm.assetId === 'nathanhoad/dialogue-manager', `assetId 正确(${dm.assetId})`)
  ok(dm.storeUrl === 'https://store.godotengine.org/asset/nathanhoad/dialogue-manager/', `商店链接取自记录(${dm.storeUrl})`)
  ok(dm.version === '1.2.3', `版本优先取 plugin.cfg(${dm.version})`)
  ok(dm.enabled === true, 'enabled 解析正确')
  ok(!!noMeta && noMeta.fromMarket === true, 'no_meta_tool 也标记为来自市场')
  ok(noMeta.storeUrl === 'https://store.godotengine.org/asset/some/publisher-asset/',
    `缺少 meta 时按 assetId 拼装链接(${noMeta.storeUrl})`)
  ok(!!hand && hand.fromMarket === false, 'handmade_tool 标记为未知来源')
  ok(hand.storeUrl === undefined, '未知来源没有商店链接')

  // ---------- 2 ----------
  section('2. 复制插件:来源记录一并过户')
  const copyRes = projects.copyAddonsToProject({
    sourceProjectId: pidA,
    dirNames: ['dialogue_manager'],
    targetProjectId: pidB
  })
  ok(copyRes.ok && copyRes.copied === 1, `复制成功 1 个(实际 ${copyRes.copied})`)
  ok(copyRes.adopted === 1, `过户 1 条来源记录(实际 ${copyRes.adopted})`)
  ok(fs.existsSync(path.join(rootB, 'addons', 'dialogue_manager', 'plugin.cfg')), '目标项目出现插件目录')

  const listB = assets.listAddons(pidB)
  const dmB = listB.find((a) => a.dirName === 'dialogue_manager')
  ok(!!dmB && dmB.fromMarket === true, '目标项目的该插件也标记为来自市场')
  ok(dmB.assetId === 'nathanhoad/dialogue-manager', `目标 assetId 一致(${dmB.assetId})`)
  ok(dmB.storeUrl === 'https://store.godotengine.org/asset/nathanhoad/dialogue-manager/', '目标也有商店链接')
  ok(dmB.versionString === 'v4.1.0', `目标保留版本信息(${dmB.versionString})`)
  const docB = docs.get(`godot/asset/${pidB}/nathanhoad/dialogue-manager`)
  ok(!!docB && docB.projectId === pidB, '过户记录的 projectId 指向目标项目')
  ok(!!docB && docB.copiedFrom === pidA, '记录了 copiedFrom 便于追溯')
  ok(!!docs.get(`godot/asset/${pidA}/nathanhoad/dialogue-manager`), '源项目的记录未被删除')

  // ---------- 3 ----------
  section('3. 重复复制:目录已存在时仍补回来源')
  const copyAgain = projects.copyAddonsToProject({
    sourceProjectId: pidA,
    dirNames: ['dialogue_manager'],
    targetProjectId: pidB
  })
  ok(copyAgain.ok && copyAgain.copied === 0, '目录已存在时不重复复制')
  ok(copyAgain.skipped.length === 1 && /已存在/.test(copyAgain.skipped[0]), `跳过原因可读(${copyAgain.skipped[0]})`)
  ok(copyAgain.adopted === 0, '记录已存在时不重复过户')

  // 手工放置的插件不会凭空获得来源
  const copyHand = projects.copyAddonsToProject({
    sourceProjectId: pidA,
    dirNames: ['handmade_tool'],
    targetProjectId: pidB
  })
  ok(copyHand.ok && copyHand.copied === 1, '手工插件目录正常复制')
  const handB = assets.listAddons(pidB).find((a) => a.dirName === 'handmade_tool')
  ok(!!handB && handB.fromMarket === false, '无来源记录的手工插件仍标记为未知来源')
  ok(copyHand.adopted === 0, '没有来源记录时不会凭空过户')

  // 「先复制过去、当时还没有来源信息」的场景:事后补一次复制即可补回
  ok(docs.get(`godot/asset/${pidB}/nathanhoad/dialogue-manager`) !== undefined,
    '模拟前:目标已有 dialogue_manager 的记录')
  docs.delete(`godot/asset/${pidB}/nathanhoad/dialogue-manager`)
  ok(docs.get(`godot/asset/${pidB}/nathanhoad/dialogue-manager`) === undefined, '模拟:删掉目标的来源记录')
  const recopy = projects.copyAddonsToProject({
    sourceProjectId: pidA,
    dirNames: ['dialogue_manager'],
    targetProjectId: pidB
  })
  ok(recopy.copied === 0, '目录已存在,只做来源补回')
  ok(recopy.adopted === 1, `再复制一次补回来源(实际 ${recopy.adopted})`)
  const dmB2 = assets.listAddons(pidB).find((a) => a.dirName === 'dialogue_manager')
  ok(dmB2.fromMarket === true && dmB2.assetId === 'nathanhoad/dialogue-manager', '补回后标记为来自市场')

  // ---------- 4 ----------
  section('4. 同一资产多个目录:合并 dirNames')
  const multiRoot = path.join(WORK, 'Gamma')
  fs.mkdirSync(multiRoot, { recursive: true })
  fs.writeFileSync(path.join(multiRoot, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Gamma"\n')
  const addG = projects.addProject(multiRoot)
  // 先把 dialogue_manager 复制过去 → 目标建立 dirNames:['dialogue_manager']
  projects.copyAddonsToProject({ sourceProjectId: pidA, dirNames: ['dialogue_manager'], targetProjectId: addG.project.id })
  const gDoc1 = docs.get(`godot/asset/${addG.project.id}/nathanhoad/dialogue-manager`)
  ok(!!gDoc1 && gDoc1.dirNames.length === 1, '第一次复制只含一个目录')
  // 源记录扩充为两个目录(模拟该资产在别处也装了 dm_extra)
  docs.set(`godot/asset/${pidA}/nathanhoad/dialogue-manager`, {
    ...docs.get(`godot/asset/${pidA}/nathanhoad/dialogue-manager`),
    dirNames: ['dialogue_manager', 'dm_extra']
  })
  const merged = projects.copyAddonsToProject({ sourceProjectId: pidA, dirNames: ['dm_extra'], targetProjectId: addG.project.id })
  ok(merged.copied === 1, '第二个目录被复制过去')
  ok(merged.adopted === 1, `第二个目录并入同一资产记录(实际 ${merged.adopted})`)
  const mergedDoc = docs.get(`godot/asset/${addG.project.id}/nathanhoad/dialogue-manager`)
  ok(!!mergedDoc && mergedDoc.dirNames.length === 2,
    `dirNames 合并为 2(实际 ${mergedDoc && mergedDoc.dirNames.join('+')})`)
  const listG = assets.listAddons(addG.project.id)
  ok(listG.length === 2 && listG.every((a) => a.fromMarket), '两个目录都标记为来自市场')

  // ---------- 5 ----------
  section('5. 边界')
  const same = projects.copyAddonsToProject({ sourceProjectId: pidA, dirNames: ['dialogue_manager'], targetProjectId: pidA })
  ok(same.ok === false && /同一项目/.test(same.error), `不能复制到同一项目(${same.error})`)
  const missing = projects.copyAddonsToProject({ sourceProjectId: pidA, dirNames: ['nope'], targetProjectId: pidB })
  ok(missing.ok && missing.copied === 0 && /不存在/.test(missing.skipped[0]), '不存在的目录计入 skipped')
  ok(assets.listAddons('godot/project/nonexistent').length === 0, '不存在的项目返回空列表')

  console.log(`\n${'='.repeat(56)}`)
  console.log(`PASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('全部通过')
}

main()
