// 插件数据导出/导入(datatransfer.js)与网络诊断(diagnostics.js)回归测试。
//
// 覆盖:导出内容完整性(设置/项目/收藏)、导入的机器本地语义(项目只登记本机存在的路径、
// 收藏按 assetId 合并、设置只补缺失键)、诊断的可达/超时/失败三态(http 桩驱动)。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/datatransfer.test.js
//   node src-ztools/preload/lib/__tests__/datatransfer.test.js --no-immediate
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))

const LIB = positional[0] || path.resolve(__dirname, '..')
const WORK = positional[1] || fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-datatransfer-test-'))

if (!fs.existsSync(path.join(LIB, 'datatransfer.js'))) {
  console.error(`找不到被测模块: ${path.join(LIB, 'datatransfer.js')}`)
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

// ---------- http 打桩(diagnostics 用):Module._load 拦截 ----------
let diagPlans = []
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const fromDiagnostics = parent && /diagnostics\.js$/.test(parent.filename || '')
  if (fromDiagnostics && request === './http') {
    return {
      getText: async (url) => {
        const plan = diagPlans.shift() || { fail: 'stub: no plan' }
        if (plan.fail) throw new Error(plan.fail)
        return 'ok'
      }
    }
  }
  return origLoad.apply(this, arguments)
}

const { exportPluginData, importPluginData } = require(path.join(LIB, 'datatransfer.js'))
const { runNetworkDiagnostics } = require(path.join(LIB, 'diagnostics.js'))
const { addProject } = require(path.join(LIB, 'projects.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms = 10) => new Promise((r) => setTimeout(r, ms))

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  // ---------- 1 ----------
  section('1. 导出:设置 + 项目清单 + 收藏打包为 JSON')
  docs.set('godot/settings', { _id: 'godot/settings', proxy: 'http://127.0.0.1:7890', autoEnablePlugin: true, versionsRoot: 'E:/engines' })
  const projPath = path.join(WORK, 'ProjA')
  fs.mkdirSync(projPath, { recursive: true })
  fs.writeFileSync(path.join(projPath, 'project.godot'), 'config_version=5\n')
  addProject(projPath)
  docs.set('godot/market/favorites', {
    _id: 'godot/market/favorites',
    items: [{ assetId: 'a/b', title: 'Fav', addedAt: 1 }]
  })
  docs.set('godot/docs/favorites', { _id: 'godot/docs/favorites', items: ['Node'] })
  docs.set('godot/docs/history', {
    _id: 'godot/docs/history',
    items: [{ name: 'Node', at: 100 }, { name: 'Vector2', at: 200 }]
  })
  const outPath = path.join(WORK, 'data.json')
  const r1 = exportPluginData(outPath)
  ok(r1.ok === true && r1.projects === 1 && r1.favorites === 1, `导出成功(${JSON.stringify(r1)})`)
  const data = JSON.parse(fs.readFileSync(outPath, 'utf8'))
  ok(data.kind === 'ztools-godot-data', '导出文件带 kind 标识')
  ok(data.projects.length === 1 && data.projects[0].path === projPath, '项目清单包含路径')
  ok(data.favorites.length === 1 && data.favorites[0].assetId === 'a/b', '收藏包含 assetId')
  ok(data.docFavorites.length === 1 && data.docFavorites[0] === 'Node', '文档收藏被导出')
  ok(data.docHistory.length === 2 && data.docHistory.some((h) => h.name === 'Vector2'), '浏览历史被导出')
  ok(data.settings.proxy === 'http://127.0.0.1:7890', '设置被导出')
  ok(data.projects[0]._id === undefined, '导出内容不含 db 内部字段(_id/_rev)')

  // ---------- 2 ----------
  section('2. 导入:本机路径登记/离线跳过、收藏合并、设置只补缺失键')
  // 清掉本机状态,模拟换机
  docs.clear()
  // 目标项目目录在本机存在(同 WORK),再准备一个只存在于导出文件里的路径
  const data2 = JSON.parse(fs.readFileSync(outPath, 'utf8'))
  data2.projects.push({ id: 'ghost', name: 'Ghost', path: path.join(WORK, 'ghost-proj'), configVersion: 5, favorite: false, openCount: 0, addedAt: 1 })
  const inPath = path.join(WORK, 'in.json')
  fs.writeFileSync(inPath, JSON.stringify(data2), 'utf8')

  // 本机已有收藏 a/b,导出文件里再加一条 c/d 与一条无 assetId 的脏数据
  // 本机已有收藏 a/b(导入时应被保留而不是重复),设置已有 proxy(不应被覆盖),缺 autoEnablePlugin(应补上)
  docs.set('godot/market/favorites', { _id: 'godot/market/favorites', items: [{ assetId: 'a/b', title: 'Local', addedAt: 9 }] })
  docs.set('godot/settings', { _id: 'godot/settings', proxy: 'http://local:1' })
  // 文档收藏:本机已有 Node,导入文件里加 Sprite2D;历史:本机 Vector2(at 1)与导入的 Vector2(at 300)取最新
  docs.set('godot/docs/favorites', { _id: 'godot/docs/favorites', items: ['Node'] })
  docs.set('godot/docs/history', { _id: 'godot/docs/history', items: [{ name: 'Vector2', at: 1 }] })
  data2.favorites.push({ assetId: 'c/d', title: 'Fav2', addedAt: 2 })
  data2.favorites.push({ title: 'no-id' })
  data2.docFavorites.push('Sprite2D')
  data2.docFavorites.push('Node')
  data2.docHistory.push({ name: 'Vector2', at: 300 })
  data2.docHistory.push({ name: 'Input', at: 250 })
  fs.writeFileSync(inPath, JSON.stringify(data2), 'utf8')

  const r2 = importPluginData(inPath)
  ok(r2.ok === true, '导入成功', r2.error)
  ok(r2.projectsAdded === 1 && r2.projectsOffline === 1, `项目登记 1 个、离线跳过 1 个(${JSON.stringify({ a: r2.projectsAdded, o: r2.projectsOffline })})`)
  ok(r2.favoritesAdded === 1, '收藏只新增本机没有的 1 条')
  const fav = docs.get('godot/market/favorites')
  ok(fav.items.length === 2 && fav.items.some((x) => x.assetId === 'a/b') && fav.items.some((x) => x.assetId === 'c/d'),
    '本机已有收藏未被覆盖,新收藏并入')
  const docFavs = docs.get('godot/docs/favorites')
  ok(docFavs.items.length === 2 && docFavs.items.includes('Node') && docFavs.items.includes('Sprite2D'), '文档收藏并集')
  ok(r2.docFavoritesAdded === 1, '文档收藏新增计数', JSON.stringify(r2))
  const docHist = docs.get('godot/docs/history')
  ok(
    docHist.items.length === 3 &&
    docHist.items[0].name === 'Vector2' && docHist.items[0].at === 300 &&
    docHist.items[1].name === 'Input' && docHist.items[2].name === 'Node',
    '浏览历史按最新合并且时间倒序', JSON.stringify(docHist)
  )
  const settings = docs.get('godot/settings')
  ok(settings.proxy === 'http://local:1', '本机已有的代理设置不被导入值覆盖')
  ok(settings.autoEnablePlugin === true, '本机缺失的设置键被补上')

  // 再导入一次:收藏零新增(合并幂等)
  const r2b = importPluginData(inPath)
  ok(r2b.ok === true && r2b.favoritesAdded === 0, '重复导入收藏零新增(幂等)')

  // ---------- 3 ----------
  section('3. 导入校验:文件缺失 / 非 本插件数据')
  ok(importPluginData(path.join(WORK, 'nope.json')).ok === false, '文件不存在拒绝')
  const badPath = path.join(WORK, 'bad.json')
  fs.writeFileSync(badPath, JSON.stringify({ hello: 1 }), 'utf8')
  const r3 = importPluginData(badPath)
  ok(r3.ok === false && /数据文件/.test(r3.error || ''), `非本插件数据拒绝(${r3.error})`)

  // ---------- 4 ----------
  section('4. 网络诊断:可达 / 失败 / 超时三态')
  diagPlans = [{}, { fail: '连接被重置' }, { fail: '超时(8s)' }]
  const d1 = await runNetworkDiagnostics()
  ok(d1.ok === true && d1.results.length === 3, '返回三个探测目标')
  ok(d1.results[0].ok === true && d1.results[0].ms >= 0, '可达项带延迟')
  ok(d1.results[1].ok === false && /连接被重置/.test(d1.results[1].error || ''), '失败项带原因')
  ok(d1.results[2].ok === false, '第三项按桩计划失败')

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
