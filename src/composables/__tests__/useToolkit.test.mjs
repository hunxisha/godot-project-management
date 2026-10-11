// 工具箱 · 第 1 批 Task 12a:首页装配层 src/composables/useToolkit.ts 的断言。
//
// ⚠ 这份测试测的是**装配**,不是执行(Q33):
//   扫描管线要「读盘 + 把插件文本交给 JS 引擎」,那两件只能在真宿主上验(A-10 / A-19),
//   这里注入假 deps 是把它们当作已经成功的输入,看**编排结果**对不对 ——
//   哪个条目落到哪个 state、一个坏插件会不会连累别的、启停怎么影响 feature、设置怎么落盘。
//   注册/校验/冲突/搜索那些判据本身在 toolkit/loader.test.mjs 与 features.test.mjs 里已经钉过,
//   这里不重复证明它们,只证明 useToolkit 用对了它们(比如 `granted` 没传 = 全员 no-capability)。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/composables/__tests__/useToolkit.test.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/usetoolkit.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }
const F = (x) => (x && typeof x === 'object' ? x : {})
const FA = (x) => (Array.isArray(x) ? x : [])
const S = (x) => (typeof x === 'string' ? x : '')
const P = (arr, i) => F(FA(arr)[i])

// ── 假宿主:文档库 + feature 三件套(db 的形状照 bridge.ts 的 get/put/allDocs/remove)─────
const DB = new Map()
const FEATURES = new Map()
const notes = []
const opened = []
let setFeatureResult = { success: true }
let removeFeatureCalls = []

global.window = {
  ztools: {
    db: {
      get: (id) => (DB.has(id) ? { ...DB.get(id) } : null),
      put: (doc) => { DB.set(doc._id, { ...doc }); return { _id: doc._id } },
      remove: (doc) => { DB.delete((doc && doc._id) || ''); return {} },
      allDocs: (prefix) => [...DB.values()].filter((d) => String(d._id).startsWith(prefix)).map((d) => ({ ...d }))
    },
    setFeature: (f) => { if (setFeatureResult.success) FEATURES.set(f.code, f); return setFeatureResult },
    removeFeature: (codes) => {
      const list = Array.isArray(codes) ? codes : [codes]
      removeFeatureCalls = list
      for (const c of list) FEATURES.delete(c)
      return { success: true }
    },
    getFeatures: () => [...FEATURES.values()],
    showNotification: (t) => notes.push(S(t)),
    shellOpenPath: (p) => opened.push(p),
    setExpendHeight: () => {},
    isDarkColors: () => false,
    isWindows: () => true, isMacOS: () => false, isLinux: () => false
  },
  services: {
    openPath: (p) => { opened.push(p); return { ok: true } }
  }
}

const T = await import(pathToFileURL(BUNDLE).href)
const K = T.useToolkit()

// ── 夹具 ────────────────────────────────────────────────────────────────
const MAN = (over) => ({
  id: 'hello', name: '你好工具', version: '0.1.0', apiVersion: 1,
  kind: 'action', ui: 'schema', summary: '一句话', cmds: ['hello'],
  entry: 'index.js', capabilities: ['tree', 'text', 'write'], ...(over || {})
})
const ENTRY = (text) => ({ ok: true, text, bytes: text.length, truncated: false, skippedBinary: false, error: '' })
const DIR = '/fake/.gpm-tools'

/**
 * 假 deps。entries 里每项:
 *   { name, manifest?, manifestText?, error?, entryText?, exec?, root?, readFail?, truncated?, binary? }
 */
function mkDeps(entries, extra) {
  const x = extra || {}
  return {
    toolsRoot: () => (x.root !== undefined ? x.root : { ok: true, dir: DIR, source: 'default', error: '' }),
    listPlugins: () => (x.list !== undefined ? x.list : {
      ok: true,
      dir: DIR,
      created: false,
      error: '',
      entries: FA(entries).map((e) => {
        if (e.error) return { name: e.name, abs: DIR + '/' + e.name, manifestText: '', files: [], bytes: 0, error: e.error }
        return {
          name: e.name,
          abs: DIR + '/' + e.name,
          manifestText: typeof e.manifestText === 'string' ? e.manifestText : JSON.stringify(e.manifest || MAN({ id: e.name })),
          files: FA(e.files).length ? FA(e.files) : ['manifest.json', 'index.js'],
          bytes: 100
        }
      })
    }),
    readFile: (dir, name, rel) => {
      const e = FA(entries).find((it) => it.name === name)
      if (!e) return { ok: false, error: '读不到' }
      if (e.readFail) return { ok: false, error: String(e.readFail) }
      if (e.truncated) return { ok: true, bytes: 5000000, truncated: true }
      if (e.binary) return { ok: true, bytes: 900, skippedBinary: true }
      return ENTRY(typeof e.entryText === 'string' ? e.entryText : 'export async function plan(){ return [] }\nexport const schema = []\n')
    },
    execute: async (text) => {
      if (x.throwExec) throw new Error(x.throwExec)
      if (x.exec) return x.exec(text)
      return { schema: [], plan: async () => [] }
    },
    ztools: () => global.window.ztools
  }
}

const rowsOf = () => FA(K.sorted.value).map((t) => ({
  id: t.manifest ? t.manifest.id : '',
  src: t.source,
  dir: t.dirName,
  state: t.state
}))

section('0. 导出面')
for (const n of ['useToolkit', 'REAL_DEPS', 'capabilitiesOf']) ok(T[n] !== undefined, `${n} 已导出`)
ok(typeof K.rescan === 'function' && typeof K.ensureLoaded === 'function', '扫描入口在')
ok(K.scanState.value === 'idle', '没扫之前是 idle(首页第一次进来不该显示「0 个工具」的假完成态)', K.scanState.value)

section('1. 内置工具与用户插件汇入同一条注册路径(DEV-4 / Q23=A)')
{
  await K.rescan(mkDeps([{ name: 'hello', exec: true }]))
  const rows = rowsOf()
  ok(rows.some((r) => r.id === 'gdscript-format' && r.src === 'builtin' && r.state === 'ok'),
    '内置的 GDScript 格式化注册成功(source=builtin,state=ok)', rows)
  ok(rows.some((r) => r.id === 'hello' && r.src === 'user' && r.state === 'ok'), '用户插件同一条路径进来了', rows)
  ok(K.counts.value.ok === 2, '两个都是可用状态(能力门必须放行:granted 没传会全员 no-capability)', K.counts.value)
  ok(K.hasBroken.value === false, '没有坏条目时不亮「有插件没载入」的标')
  ok(K.scanState.value === 'done', '扫完是 done', K.scanState.value)
  // 内置在前的排序是 loader 的判据,这里只验装配没把它排丢
  ok(P(K.sorted.value, 0).source === 'builtin', '内置排在前(照 loader 的 sortTools)')
}

section('2. 五种坏形态各说各的话,而且只标它自己(§3 P0-b 第 5 项)')
{
  const cases = [
    ['目录级错误', [{ name: 'e1', error: '没有 manifest.json' }, { name: 'good' }], /没有 manifest\.json/],
    ['manifest 不是合法 JSON', [{ name: 'e2', manifestText: '{ oops' }, { name: 'good' }], /不是合法 JSON/],
    ['manifest 空文本', [{ name: 'e3', manifestText: '   ' }, { name: 'good' }], /没有 manifest\.json/],
    ['入口文件读不出来', [{ name: 'e4', readFail: '权限不够' }, { name: 'good' }], /读不出入口文件 index\.js:权限不够/],
    ['入口太大没给正文', [{ name: 'e5', truncated: true }, { name: 'good' }], /太大或被认成二进制/],
    ['入口是二进制', [{ name: 'e6', binary: true }, { name: 'good' }], /太大或被认成二进制/],
    ['apiVersion 不匹配', [{ name: 'e7', manifest: MAN({ apiVersion: 99 }) }, { name: 'good' }], /apiVersion 99/],
    ['id 不合法', [{ name: 'e8', manifest: MAN({ id: 'Bad ID' }) }, { name: 'good' }], /manifest 不合格/]
  ]
  for (const [name, entries, re] of cases) {
    await K.rescan(mkDeps(entries))
    const bad = FA(K.sorted.value).find((t) => t.source === 'user' && t.state !== 'ok' && t.manifest === null)
    ok(!!bad, `${name}:有条目标了坏`)
    ok(re.test(S(bad && bad.reason)), `${name}:原因说得对`, bad && bad.reason)
    const good = FA(K.sorted.value).find((t) => t.dirName === 'good')
    ok(!!good && good.state === 'ok', `${name}:好那条不受影响(错误隔离)`, good && good.state)
    ok(FA(K.sorted.value).some((t) => t.manifest && t.manifest.id === 'gdscript-format'), `${name}:内置始终在列表里`)
  }
}

section('3. 模块形状与能力门:作者的错与环境的话分得开')
{
  await K.rescan(mkDeps([{ name: 'badmod' }], { exec: () => ({ notTheContract: 1 }) }))
  const r = FA(K.sorted.value).find((t) => t.dirName === 'badmod')
  ok(F(r).state === 'bad-module', '导出的形状不对 ⇒ bad-module(不是 bad-manifest)', F(r).state)
  ok(S(F(r).reason).includes('plan'), '原因点名缺的是 plan', S(F(r).reason))
  ok(F(r).manifest !== null, 'manifest 是好的,所以那一行的信息还在(名字/图标能用)', F(r).manifest)
  ok(K.enabledOf(r) === false, '坏形状的条目不算启用(灰显着但开关亮着 = 说不清自己到底有没有开)')
  ok(!FEATURES.has('tool-badmod'), 'bad-module 不注册 feature:它连 plan 都跑不起来,注册了就是搜索框里一个死入口', [...FEATURES.keys()])
}

section('4. id 撞车:内置先注册就保留,用户插件被顶掉但看得见(DEV-4 + loader 的判据)')
{
  await K.rescan(mkDeps([{ name: 'evil', manifest: MAN({ id: 'gdscript-format', name: '冒牌的格式化' }) }]))
  const byId = F(K.registry.value.byId)
  ok(F(byId['gdscript-format']).source === 'builtin', 'byId 保留先注册的内置', F(byId['gdscript-format']).source)
  const evil = FA(K.sorted.value).find((t) => t.dirName === 'evil')
  ok(FA(F(evil).idConflictWith).length > 0, '后装那条标出跟谁撞了(不静默丢弃)', FA(F(evil).idConflictWith))
  ok(FA(K.registry.value.conflicts).length === 1, '注册表的撞车账上有这一条', FA(K.registry.value.conflicts))
  const two = await K.rescan(mkDeps([
    { name: 'p1', manifest: MAN({ id: 'same', cmds: ['aaa'] }) },
    { name: 'p2', manifest: MAN({ id: 'same', cmds: ['bbb'] }) }
  ]))
  ok(FA(K.registry.value.conflicts).length >= 1, '两个用户插件同 id 也算撞车', FA(K.registry.value.conflicts))
  const second = FA(K.sorted.value).find((t) => t.dirName === 'p2')
  ok(S(K.conflictOf(F(second))).length > 0 || FA(F(second).idConflictWith).length > 0,
    '后装那条能报出跟谁撞了(措辞在 loader / features,这里只验装配把信息留住)', FA(F(second).idConflictWith))
  void two
}

section('5. 启停两层不合并:作者声明 status,用户意图存 settings(DEV-6)')
{
  await K.rescan(mkDeps([
    { name: 'stable1', manifest: MAN({ id: 'stable1', cmds: ['s1'] }) },
    { name: 'devtool', manifest: MAN({ id: 'devtool', status: 'dev', cmds: ['d1'] }) }
  ]))
  const stable = FA(K.sorted.value).find((t) => t.manifest && t.manifest.id === 'stable1')
  const dev = FA(K.sorted.value).find((t) => t.manifest && t.manifest.id === 'devtool')
  ok(K.enabledOf(stable) === true, 'status:stable ⇒ 缺键时默认启用', K.enabledOf(stable))
  ok(K.enabledOf(dev) === false, 'status:dev ⇒ 缺键时默认未启用(Q25 的那个「未完成」开关)', K.enabledOf(dev))
  await K.setEnabled(dev, true)
  ok(K.enabledOf(dev) === true, '用户手动打开后就是打开')
  await K.setEnabled(stable, false)
  ok(K.enabledOf(stable) === false, '用户也可以关掉 stable 的')
  const doc = DB.get('godot/settings')
  ok(F(doc).toolEnabled && F(doc).toolEnabled.stable1 === false && F(doc).toolEnabled.devtool === true,
    '两个开关都落进 settings(不回写 manifest.status)', F(doc).toolEnabled)
  // 作者把 status 改了不许翻掉用户按过的开关
  await K.rescan(mkDeps([{ name: 'stable1', manifest: MAN({ id: 'stable1', status: 'dev', cmds: ['s1'] }) }]))
  const st2 = FA(K.sorted.value).find((t) => t.manifest && t.manifest.id === 'stable1')
  ok(K.enabledOf(st2) === false, '用户先前关过 ⇒ 作者改成 dev 不改变结果(两层不合并的意义)')
  await K.rescan(mkDeps([{ name: 'fresh', manifest: MAN({ id: 'fresh', cmds: ['f1'] }) }]))
  const fr = FA(K.sorted.value).find((t) => t.manifest && t.manifest.id === 'fresh')
  ok(K.enabledOf(fr) === true, '没按过开关的新工具按 status 走(fresh 是 stable ⇒ 开)')
}

section('6. feature 同步:按 {success,error?} 判、冲突让位、禁用不注册(A-14 / A-15 / R-6)')
{
  FEATURES.clear()
  setFeatureResult = { success: true }
  await K.rescan(mkDeps([{ name: 'mine', manifest: MAN({ id: 'mine', cmds: ['我的关键词'] }) }]))
  ok(FEATURES.has('tool-mine'), '启用的工具注册成 tool-<id>(前缀是 features.ts 的判据)', [...FEATURES.keys()])
  const rep = FA(K.featureReports.value).find((f) => f.toolId === 'mine')
  ok(F(rep).ok === true, '回报里有这一条且成功', rep)

  // R-6 正身:宿主回 {success:false} 而 d.ts 声明 boolean ⇒ 必须判失败
  FEATURES.clear()
  setFeatureResult = { success: false, error: 'feature 已存在' }
  await K.rescan(mkDeps([{ name: 'fake', manifest: MAN({ id: 'fake', cmds: ['假的'] }) }]))
  const rep2 = FA(K.featureReports.value).find((f) => f.toolId === 'fake')
  ok(F(rep2).ok === false && S(rep2.error).includes('feature 已存在'), '宿主说失败就是失败,原因留着(判 truthy 会永远为真)', rep2)
  setFeatureResult = { success: true }

  // 与静态入口的关键词撞 ⇒ 让位不注册,但工具本身照常在列表里
  FEATURES.clear()
  await K.rescan(mkDeps([{ name: 'clash', manifest: MAN({ id: 'clash', cmds: ['godot'] }) }]))
  ok(!FEATURES.has('tool-clash'), '踩到内置入口的关键词 ⇒ 不注册(Q22 后装让位)')
  const rep3 = FA(K.featureReports.value).find((f) => f.toolId === 'clash')
  ok(F(rep3).ok === false && S(rep3.error).length > 0, '列表那一行拿得到让位原因', rep3)
  const clashRow = FA(K.sorted.value).find((t) => t.manifest && t.manifest.id === 'clash')
  ok(!!clashRow && clashRow.state === 'ok', '让位的工具仍然可用、仍可打开(A-15 的后半)')

  // 两个用户插件互撞同一个词 ⇒ 先注册的拿到,后装的让位
  FEATURES.clear()
  await K.rescan(mkDeps([
    { name: 'first', manifest: MAN({ id: 'first', cmds: ['同一个词'] }) },
    { name: 'second', manifest: MAN({ id: 'second', cmds: ['同一个词'] }) }
  ]))
  ok(FEATURES.has('tool-first') && !FEATURES.has('tool-second'), '同一个词只有一个赢家,顺序按列表(不抢回)', [...FEATURES.keys()])
  const rep4 = FA(K.featureReports.value).find((f) => f.toolId === 'second')
  ok(F(rep4).ok === false && S(rep4.error).includes('占'), '后装那条的原因说得出「被谁占」', rep4)

  // 禁用 ⇒ 不注册,并且原来注册的要摘掉(Q25)
  const first = FA(K.sorted.value).find((t) => t.manifest && t.manifest.id === 'first')
  removeFeatureCalls = []
  await K.setEnabled(first, false)
  ok(!FEATURES.has('tool-first'), '禁用后 code 被摘掉(搜索框敲它应该进不去)', [...FEATURES.keys()])
  ok(FA(removeFeatureCalls).includes('tool-first'), '摘的是我们自己那个 code', removeFeatureCalls)

  // 摘除以宿主的实际清单为依据,不信本地记忆:一个我们早先注册、这次列表里已经没有的 code
  FEATURES.set('tool-gone', { code: 'tool-gone', title: 't', cmds: ['x'] })
  await K.rescan(mkDeps([{ name: 'first', manifest: MAN({ id: 'first', cmds: ['同一个词'] }) }]))
  ok(!FEATURES.has('tool-gone'), '宿主说还挂着的 tool-* 而注册表里没有 ⇒ 摘掉(以宿主为真源)', [...FEATURES.keys()])
}

section('7. 目录不可用 ≠ 一个工具都没有(内置照样能跑)')
{
  FEATURES.clear()
  await K.rescan(mkDeps([{ name: 'x' }], { root: { ok: false, dir: '', source: '', error: '工具目录不可用' } }))
  ok(S(K.scanError.value) === '工具目录不可用', '环境错要说清原因', K.scanError.value)
  ok(K.scanState.value === 'error', '状态是 error 而不是 done')
  const ids = FA(K.sorted.value).map((t) => (t.manifest ? t.manifest.id : ''))
  ok(ids.includes('gdscript-format'), '内置仍在列表里(目录坏了不等于没工具)', ids)
  ok(K.counts.value.bad === 0, '环境错不算用户的插件坏了:不该出现一堆红条', K.counts.value)
  const r2 = await K.rescan(mkDeps([{ name: 'x' }], { list: { ok: false, dir: DIR, created: false, error: '目录读不出来', entries: [] } }))
  ok(S(K.scanError.value).includes('目录读不出来'), 'listToolPlugin 自己的错也照实说', K.scanError.value)
  ok(r2 === undefined, 'rescan 不抛(reload 不能把首页带崩)')
}

section('8. 执行抛异常:标这一条,不影响别人(Q33 的那一步在这里只测编排)')
{
  await K.rescan(mkDeps([{ name: 'boom' }, { name: 'good' }], { throwExec: 'Unexpected token' }))
  const bad = FA(K.sorted.value).find((t) => t.dirName === 'boom')
  ok(S(F(bad).reason).includes('入口文件执行失败') && S(F(bad).reason).includes('Unexpected token'), '原因带引擎那句话', F(bad).reason)
  ok(F(bad).state === 'bad-manifest', '没执行成功就没有 manifest 之外的状态可标(不是 ok,也不是 crash)')
  ok(FA(K.sorted.value).some((t) => t.dirName === 'good'), '另一个条目不受影响')
  ok(K.scanState.value === 'done', '执行失败是条目级,不是扫描级')
}

section('9. 视图形态与搜索筛选存/读 settings(Q13=B / Q25)')
{
  await K.setViewMode('grid')
  ok(K.viewMode.value === 'grid', '切到网格')
  ok(F(DB.get('godot/settings')).toolViewMode === 'grid', '选择落进 settings(Q25 明写)', F(DB.get('godot/settings')).toolViewMode)
  await K.setViewMode('list')
  ok(K.viewMode.value === 'list', '切回列表')
  await K.setViewMode('bogus')
  ok(K.viewMode.value === 'list', '脏值退回列表,不存一个没人认的形态')

  await K.rescan(mkDeps([
    { name: 'aaa', manifest: MAN({ id: 'aaa', name: '阿尔法', cmds: ['alpha'], tags: ['gd'] }) },
    { name: 'bbb', manifest: MAN({ id: 'bbb', name: '贝塔', summary: '场景相关', cmds: ['beta'], tags: ['tscn'] }) }
  ]))
  K.query.value = '贝塔'
  ok(FA(K.visible.value).filter((t) => t.manifest).length === 1, '按名字搜到一条', FA(K.visible.value).map((t) => (t.manifest ? t.manifest.id : '坏')))
  K.query.value = '场景'
  ok(FA(K.visible.value).some((t) => t.manifest && t.manifest.id === 'bbb'), 'summary 也参与搜索(loader 的可搜面)')
  K.query.value = 'bbb-dir'
  const withBad = await K.rescan(mkDeps([{ name: 'zzz', manifestText: '{ oops' }]))
  K.query.value = 'zzz'
  ok(FA(K.visible.value).some((t) => t.dirName === 'zzz'), '拒载的条目按目录名也搜得到(用户找坏插件的唯一办法)')
  K.query.value = '不是合法 JSON'
  ok(FA(K.visible.value).some((t) => t.dirName === 'zzz'), '按拒载原因也搜得到')
  K.query.value = ''
  // 上面那次 rescan 把注册表换成了只有坏条目,chip 的断言要换回有 kind/标签可判的那份数据
  await K.rescan(mkDeps([
    { name: 'aaa', manifest: MAN({ id: 'aaa', name: '阿尔法', cmds: ['alpha'], tags: ['gd'] }) },
    { name: 'bbb', manifest: MAN({ id: 'bbb', name: '贝塔', summary: '场景相关', cmds: ['beta'], tags: ['tscn'], kind: 'view', ui: 'render' }) }
  ]))
  K.kindFilter.value = 'view'
  ok(FA(K.visible.value).every((t) => !t.manifest || t.manifest.kind === 'view'), 'kind chip 生效', FA(K.visible.value).map((t) => (t.manifest ? t.manifest.kind : '坏')))
  ok(FA(K.visible.value).some((t) => t.manifest && t.manifest.id === 'bbb'), 'view 型只剩 view 那条')
  K.kindFilter.value = 'all'
  K.tagFilter.value = 'gd'
  ok(FA(K.visible.value).filter((t) => t.manifest).map((t) => t.manifest.id).join(',') === 'aaa', 'tag chip 生效', FA(K.visible.value).map((t) => (t.manifest ? t.manifest.id : '坏')))
  K.tagFilter.value = 'all'
  ok(FA(K.tags.value).includes('gd') && FA(K.tags.value).includes('tscn'), '标签 chip 的清单来自注册表', K.tags.value)
  void withBad
}

section('10. A-12「首次装插件时」:新目录要提示,acknowledge 后不再重复')
{
  DB.delete('godot/settings')
  await K.rescan(mkDeps([{ name: 'newone', manifest: MAN({ id: 'newone', cmds: ['n1'] }) }]))
  ok(FA(K.newDirs.value).includes('newone'), '第一次见到这个目录名 ⇒ 算新装的', K.newDirs.value)
  await K.acknowledgeNewTools()
  ok(FA(K.newDirs.value).length === 0, 'acknowledge 之后清空', K.newDirs.value)
  ok(F(DB.get('godot/settings')).toolKnownDirs.includes('newone'), '见过的目录名记进 settings', F(DB.get('godot/settings')).toolKnownDirs)
  await K.rescan(mkDeps([{ name: 'newone', manifest: MAN({ id: 'newone', cmds: ['n1'] }) }]))
  ok(FA(K.newDirs.value).length === 0, '再扫一次同一个目录 ⇒ 不再弹第二次(否则天天弹)')
  await K.rescan(mkDeps([{ name: 'other', manifest: MAN({ id: 'other', cmds: ['o1'] }) }]))
  ok(FA(K.newDirs.value).includes('other'), '换了目录名才算新装的', K.newDirs.value)
}

section('11. 二级导航与 code 反解(Q26:搜索框直达某个工具页)')
{
  K.openTool('gdscript-format')
  ok(K.activeToolId.value === 'gdscript-format', '打开某个工具的页面')
  ok(F(K.activeTool.value).manifest && F(F(K.activeTool.value).manifest).id === 'gdscript-format', 'activeTool 给的是注册表里那一条')
  K.openTool('不存在的')
  ok(K.activeTool.value === null, 'id 不认识 ⇒ 没有活动工具(页面要退到列表而不是白屏)')
  K.closeTool()
  ok(K.activeToolId.value === '' && K.activeTool.value === null, '关掉回到列表')
  ok(K.toolIdFromCode('tool-gdscript-format') === 'gdscript-format', 'feature code 反解回 id(判据在 features.ts,这里只转交)')
  ok(K.toolIdFromCode('godot') === '', '静态入口的 code 反解不出工具 id')
  ok(K.toolIdFromCode(undefined) === '', '脏 code 不抛')
}

section('12. 打开目录 / ensureLoaded 的读盘顺序')
{
  opened.length = 0
  const r0 = await K.openToolsDir()
  ok(r0.ok === true || S(r0.error).length > 0, '没扫过时要么打开要么给原因(不静默)', r0)
  DB.set('godot/settings', { _id: 'godot/settings', toolViewMode: 'grid', toolEnabled: { onlyDev: false }, toolsRoot: '/from/settings' })
  await K.ensureLoaded(mkDeps([{ name: 'onlydev', manifest: MAN({ id: 'onlydev', status: 'dev', cmds: ['od'] }) }]))
  ok(K.viewMode.value === 'grid', 'ensureLoaded 先读 settings 再扫(视图形态跟着回来)')
  ok(K.toolsRootSetting.value === '/from/settings', 'settings 里的目录配置读出来了', K.toolsRootSetting.value)
  const od = FA(K.sorted.value).find((t) => t.manifest && t.manifest.id === 'onlydev')
  ok(F(od).manifest.status === 'dev', 'dev 标记原样保留(作者声明)', F(od).manifest)
  ok(K.loadedOnce.value === true, '扫过一次就标记,别每次进页面都重扫', K.loadedOnce.value)
  const caps = T.capabilitiesOf(F(K.sorted.value).find((t) => t.manifest && t.manifest.id === 'gdscript-format'))
  ok(FA(caps).join(',') === 'tree,text,write', '悬停要显示的能力面来自 manifest 同一份表', caps)
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
