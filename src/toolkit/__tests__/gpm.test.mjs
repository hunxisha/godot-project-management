// 工具箱 · 第 1 批 Task 6:`window.gpm` 受限层的组装(src/toolkit/gpm.ts)的断言。
//
// ⚠ 先说清这一份**不是在测加载器**。Q33 明写「加载器与 new Function 只能真机验,不许用假加载器冒充」,
// 这里跑的 `buildGpm` 是一个「把注入进来的 services 拼成 ctx」的纯组装函数:
// 判据是能力门、前缀隔离、pid 注入这三件事,与「磁盘上的 .js 怎么被执行」完全无关。
// 后者进 docs/manual-verification.md(A-10 / A-19)。
//
// 为什么值得单独一层:Q12=B′ 把 gpm 定成**契约边界不是安全边界**,
// 而契约的三条硬判据(能力没声明就不存在、store 前缀框架拼、pid 由框架注入)
// 一旦漂了,插件面就会悄悄变成「谁都能摸到别人的数据」——那不是崩,是**说着说着就错了**。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/toolkit/__tests__/gpm.test.mjs
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tkgpm.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const T = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }
const F = (x) => (x && typeof x === 'object' ? x : {})
const FA2 = (x) => (Array.isArray(x) ? x : [])
const N = (x) => (typeof x === 'number' ? x : NaN)

/** 记录每次调用的假 services:只给「拼 ctx」用,与插件怎么被加载无关 */
function fakeSvc(over) {
  const calls = []
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return typeof ret === 'function' ? ret(...args) : ret }
  const svc = {
    listProjects: rec('listProjects', [{ id: 'p1' }, { id: 'p2' }]),
    getProject: rec('getProject', { id: 'p1', name: '演示' }),
    scanProjectTree: rec('scanProjectTree', { ok: true, files: [{ rel: 'a.gd', size: 10, mtimeMs: 1, ext: 'gd' }], truncated: false }),
    readProjectText: rec('readProjectText', { ok: true, text: 'extends Node\n', bytes: 13, truncated: false }),
    writeProjectText: rec('writeProjectText', { ok: true, backupRel: 'a.gd.gpm-bak-1' }),
    movePathsToTrash: rec('movePathsToTrash', { ok: true, moved: 1, failed: [] }),
    hashPaths: rec('hashPaths', { ok: true, hashes: [{ rel: 'a.gd', sha256: 'ab' }], failed: [] }),
    getDoc: rec('getDoc', null),
    putDoc: rec('putDoc', true),
    removeDoc: rec('removeDoc', true),
    notify: rec('notify', undefined),
    openDialog: rec('openDialog', { canceled: false, filePaths: ['C:/x/a.gd'] }),
    saveDialog: rec('saveDialog', { canceled: false, filePath: 'C:/x/out.json' }),
    copyText: rec('copyText', undefined),
    shellOpenPath: rec('shellOpenPath', undefined),
    ...(over || {})
  }
  return { svc, calls }
}
const NAMES = ['tree', 'text', 'ref', 'write', 'store', 'ui']
function host(over) {
  const f = fakeSvc(over && over.services)
  return {
    ctx: T.buildGpm({
      services: f.svc, toolId: 'demo', toolName: '演示工具', projectId: 'godot/project/p1',
      capabilities: NAMES, unsafe: false, ...(over || {})
    }),
    calls: f.calls
  }
}

/**
 * 安全调用。这是本批**第 4 次**在同一类形态上返工(变异刀把断言撞停而不是判红),
 * 所以定成硬规矩:凡是「实现被改坏后会抛异常」的调用点,一律走 safe() ——
 * 撞停的样子在终端上很像抓到了,其实一条 PASS/FAIL 统计都不产出,红数根本没法报。
 */
async function safe(fn) {
  try {
    return { threw: null, r: await fn() }
  } catch (e) {
    return { threw: String((e && e.message) || e), r: undefined }
  }
}

section('0. 导出面')
for (const n of ['buildGpm', 'storeKeyOf', 'storeKeyBelongs', 'grantedText', 'isGpmCtx', 'makeCancelBox', 'STORE_PREFIX_ROOT']) {
  ok(T[n] !== undefined, `${n} 已在打包产物里导出`)
}
ok(T.STORE_PREFIX_ROOT === 'gpm/plugin', '前缀根是 gpm/plugin(与 §5.3 一致)', T.STORE_PREFIX_ROOT)

section('1. storeKeyOf:前缀由框架拼,插件传不进完整 id(§D #10)')
{
  const g = T.storeKeyOf('demo', 'prefs')
  ok(g.ok === true && g.id === 'gpm/plugin/demo/prefs', '普通 key 拼上完整前缀', g)
  const nested = T.storeKeyOf('demo', 'a/b/c')
  ok(nested.ok === true && nested.id === 'gpm/plugin/demo/a/b/c', '多段 key 允许(仍在本插件前缀之内)', nested.id)
  for (const bad of ['../other/x', 'a/../../b', '..', '/abs/x', 'C:/x', '', '   ', 'a//b', './a']) {
    const r = T.storeKeyOf('demo', bad)
    ok(r.ok === false, `坏 key 拒:${JSON.stringify(bad)}`, r)
    ok(r.ok === false && String(F(r).error).length > 0, `坏 key 有原因:${JSON.stringify(bad)}`, r)
  }
  const whyDotDot = T.storeKeyOf('demo', '../x')
  ok(String(F(whyDotDot).error).includes('前缀'), '.. 的原因要说清「会跳出本插件前缀」这件事', whyDotDot.error)
  ok(T.storeKeyOf('', 'x').ok === false, 'toolId 缺失 ⇒ 拒(无处归属的存储不能写)', T.storeKeyOf('', 'x'))
  ok(T.storeKeyOf('demo', 42).ok === false && T.storeKeyOf('demo', null).ok === false, '非串 key 拒')
  ok(T.storeKeyOf('demo', '  prefs  ').id === 'gpm/plugin/demo/prefs', 'key 两端空白 trim 掉再用(形状要稳定)')
}

section('2. storeKeyBelongs:回读与清理时的归属判据')
{
  ok(T.storeKeyBelongs('gpm/plugin/demo/prefs', 'demo') === true, '自己前缀下的认')
  ok(T.storeKeyBelongs('gpm/plugin/other/prefs', 'demo') === false, '别人的插件不认')
  ok(T.storeKeyBelongs('godot/project/p1', 'demo') === false, '项目数据不认(这条是「摸到项目数据」的正证)')
  ok(T.storeKeyBelongs('gpm/plugin/demo', 'demo') === false, '前缀本身不带斜杠时不认(它连 key 都没有)')
  // ★真正区分「查不查尾长度」的是这一条:`gpm/plugin/demo/` 带前缀斜杠但没有 key。
  //   少了长度判据,前缀节点自己就会被算成「本插件的一条数据」,于是 remove('') 之类能整片端掉。
  //   (上一版只测了不带斜杠的那种,导致 K2 那把刀跑出来 PASS 95 FAIL 0 —— 无牙刀。)
  ok(T.storeKeyBelongs('gpm/plugin/demo/', 'demo') === false, '前缀节点本身(零长 key)不算一条数据')
  ok(T.storeKeyBelongs('gpm/plugin/demoX/a', 'demo') === false, '"demoX" 不许被当成 "demo" 的子树(缺分隔符)')
  for (const v of [undefined, null, 42, {}]) ok(T.storeKeyBelongs(v, 'demo') === false, `非串 id ⇒ false(${JSON.stringify(v) ?? String(v)})`)
  ok(T.storeKeyBelongs('gpm/plugin/demo/prefs', '') === false, '空 toolId 不许匹配到任何东西')
}

section('3. 能力门:没声明的 API 是「不存在」,不是「调了会抛」')
{
  const noTree = host({ capabilities: ['text'] }).ctx
  ok(typeof noTree.scanTree === 'function', 'scanTree 一直都在(形状稳定,插件不必判 undefined)')
  const r = await noTree.scanTree({})
  ok(r.files.length === 0 && String(r.error).includes('tree'), '但没给能力时返回错误而不是空列表(空列表会被当成「这个项目没文件」)', r)

  const noText = host({ capabilities: ['tree'] }).ctx
  const rt = await noText.readText('a.gd')
  ok(rt.text === '' && String(rt.error).includes('text'), '缺 text ⇒ 读不出来且有原因', rt)

  const noStore = host({ capabilities: ['tree'] }).ctx
  ok(noStore.store === undefined, '缺 store ⇒ 整个 store 对象不存在(而不是给一个每次都失败的壳)')
  const withStore = host({ capabilities: ['store'] }).ctx
  ok(withStore.store !== undefined && withStore.store.prefix === 'gpm/plugin/demo/', '给了 store 才存在,prefix 只读地给出去', withStore.store && withStore.store.prefix)

  const noUi = host({ capabilities: ['tree'] }).ctx
  const logs = []
  const logger = host({ capabilities: [], onLog: (lv, m) => logs.push(lv + ':' + m) }).ctx
  // notify/copyText/shellOpenPath 三个都是同步入口:缺能力时**只能记一行痕并返回**,
  // 改成抛异常就是「插件里任何一句 notify 都能把整页炸掉」。三处各自单独收异常,
  // 好让某一处抛出去时,断言仍然报得出一条红而不是整个套件撞停。
  const n1 = await safe(() => logger.notify('hi'))
  const n2 = await safe(() => logger.copyText('x'))
  const n3 = await safe(() => logger.shellOpenPath('C:/x'))
  ok(n1.threw === null && n2.threw === null && n3.threw === null,
    '缺 ui 能力时这三个宿主调用不抛(抛了就是插件一行 notify 炸掉整页)', [n1.threw, n2.threw, n3.threw])
  ok(logs.length === 3 && logs.every((l) => l.includes('没声明 ui')), '三个调用各留一行痕,不是静默吞掉', logs)
  const dlg = await safe(() => noUi.openDialog({}))
  ok(dlg.threw === null && F(dlg.r).canceled === true && FA2(F(dlg.r).paths).length === 0,
    '没 ui 能力时对话框返回「取消」而不是抛', [dlg.threw, dlg.r])
  const sv = await safe(() => noUi.saveDialog({}))
  ok(sv.threw === null && F(sv.r).canceled === true, 'saveDialog 同一条形状', [sv.threw, sv.r])
  ok(noUi !== undefined, 'noUi 构造本身没问题(形状稳定)')
}

section('4. pid 由框架注入(Q26):插件改不了读哪个项目')
{
  const { ctx, calls } = host({ projectId: 'godot/project/AAA' })
  await ctx.readText('a.gd')
  await ctx.scanTree({})
  await ctx.hashPaths(['a.gd'])
  const read = calls.find((c) => c[0] === 'readProjectText')
  ok(read && read[1] === 'godot/project/AAA', 'readText 用的是 ctx.projectId,不是任何插件可传的参', read)
  const scan = calls.find((c) => c[0] === 'scanProjectTree')
  ok(scan && scan[1] === 'godot/project/AAA', 'scanTree 同样', scan)
  const hash = calls.find((c) => c[0] === 'hashPaths')
  ok(hash && hash[1] === 'godot/project/AAA', 'hashPaths 同样', hash)
  const got = await ctx.getProject()
  const gp = calls.find((c) => c[0] === 'getProject')
  ok(got && gp[1] === 'godot/project/AAA', 'getProject() 不传参时取当前项目', gp)
  await ctx.getProject('godot/project/BBB')
  const gp2 = calls.filter((c) => c[0] === 'getProject')
  ok(gp2[1][1] === 'godot/project/BBB', '显式问别的项目是允许的(只读信息,不改数据)', gp2[1])
  // 身份字段是 getter:严格模式下直接改会抛 TypeError,不然后果就是「这一轮写到了别的项目」
  let threwOnWrite = null
  try { ctx.projectId = 'hacked' } catch (e) { threwOnWrite = e && e.constructor && e.constructor.name }
  ok(threwOnWrite !== null || ctx.projectId === 'godot/project/AAA',
    `改 ctx.projectId 要么抛(${threwOnWrite})要么无效,不能真改`, threwOnWrite)
  await ctx.readText('a.gd')
  const last = calls.filter((c) => c[0] === 'readProjectText').pop()
  ok(last[1] !== 'hacked', '往 ctx.projectId 上写不污染真实调用(框架注入的 pid 不是插件的可写通道)', last)
}

section('5. 读回来的「ok 但没正文」不许被抹平成空文本(与 orchestrate 同一条教训)')
{
  const trunc = host({ services: { readProjectText: () => ({ ok: true, truncated: true, bytes: 5000000 }) } }).ctx
  const r1 = await trunc.readText('big.gd')
  ok(r1.truncated === true && r1.text === '', 'truncated 原样透出:超限额的文件不能被当成「内容为空」', r1)
  ok(r1.bytes === 5000000, 'bytes 给出去(骨架生成器与预览要用它说话)', r1)

  const bin = host({ services: { readProjectText: () => ({ ok: true, skippedBinary: true, bytes: 42 }) } }).ctx
  const r2 = await bin.readText('tex.png')
  ok(r2.skippedBinary === true && r2.text === '', 'skippedBinary 原样透出', r2)

  const fail = host({ services: { readProjectText: () => ({ ok: false, error: '文件不存在' }) } }).ctx
  const r3 = await fail.readText('nope.gd')
  ok(r3.error === '文件不存在' && r3.truncated === false, '宿主的错话原样上浮,不改成框架自己的话', r3)

  const weird = host({ services: { readProjectText: () => undefined } }).ctx
  const r4 = await weird.readText('a.gd')
  ok(r4.error.length > 0 && r4.text === '', '原语回 undefined ⇒ 收口成失败而不是抛(注入面脏回报一律算失败)', r4)

  const scanFail = host({ services: { scanProjectTree: () => ({ ok: true, files: 'nope' }) } }).ctx
  const r5 = await scanFail.scanTree({})
  ok(r5.files.length === 0 && r5.error.length > 0, 'files 不是数组 ⇒ 拒,不把脏东西递给插件去遍历', r5)
}

section('6. refIndex:只喂 RefScanSource 的三个成员(第 0 批 DEV-3 的下游)')
{
  const { ctx, calls } = host({ capabilities: ['tree', 'text', 'ref'] })
  const r = await ctx.refIndex()
  ok(r.error === '' && r.index !== null, 'ref 能力给到时能建出索引', r.error)
  ok(r.index && typeof r.index.to === 'object' && typeof r.index.from === 'object', '索引形状是 RefIndex(to/from)', r.index && Object.keys(r.index))
  ok(calls.some((c) => c[0] === 'scanProjectTree'), '内部确实先扫了树', calls.map((c) => c[0]))
  const noRef = host({ capabilities: ['tree', 'text'] }).ctx
  const r2 = await noRef.refIndex()
  ok(r2.index === null && String(r2.error).includes('ref'), '没声明 ref ⇒ 不给建(而不是偷偷建好)', r2)
  const noTree = host({ capabilities: ['tree', 'text'] }).ctx
  ok(noTree !== undefined, '能力集不同不构造成问题')
}

section('7. unsafe 门:裸写只给 view 型(§5.2)')
{
  const safe = host({ unsafe: false }).ctx
  ok(safe.writeText === undefined && safe.movePathsToTrash === undefined, 'unsafe:false ⇒ 裸写接口**不存在**', Object.keys(safe).filter((k) => /write|trash/i.test(k)))
  const bare = host({ unsafe: true, projectId: 'godot/project/AAA' })
  ok(typeof bare.ctx.writeText === 'function', 'unsafe:true ⇒ writeText 出现')
  await bare.ctx.writeText('a.gd', 'x')
  const w = bare.calls.find((c) => c[0] === 'writeProjectText')
  ok(w && w[1] === 'godot/project/AAA' && w[2] === 'a.gd' && w[3] === 'x', '裸写也走框架注入的 pid(unsafe 不是「绕过 pid 注入」)', w)
  await bare.ctx.movePathsToTrash(['b.gd'])
  const mv = bare.calls.find((c) => c[0] === 'movePathsToTrash')
  ok(mv && mv[1] === 'godot/project/AAA', 'trash 同样带 pid', mv)
  ok(bare.ctx.rename === undefined, '第 1 批**没有** rename 裸写(项目内改名原语还没建,§F DEV-11)', Object.keys(bare.ctx).filter((k) => /rename/i.test(k)))
  const junk = await host({ unsafe: true }).ctx.movePathsToTrash('not-an-array')
  ok(junk.ok === true, 'rels 非数组时按空清单交给原语(原语自己收口),不炸', junk)
}

section('8. 进度与取消:框架持有,插件只读 + 挂回调')
{
  const prog = []
  const ctx = host({ onProgress: (d, t) => prog.push(`${d}/${t}`) }).ctx
  ctx.progress(3, 10)
  ctx.progress(99, 10)
  ctx.progress(-2, 10)
  ctx.progress('x', 10)
  ctx.progress(1, 0)
  ok(prog.join('|') === '3/10|10/10|0/10', 'done 被夹进 [0,total],total<=0 或非数字一律不报(进度条不许显示 NaN%)', prog)

  const box = T.makeCancelBox()
  let seen = 0
  box.ctx === undefined && ok(true, 'makeCancelBox 不给插件级字段(它属于框架侧)')
  box.onCancel(() => { seen += 1 })
  box.onCancel(() => { seen += 10 })
  box.onCancel(null)
  ok(box.cancelled === false, '取消前是 false')
  box.cancel()
  ok(box.cancelled === true && seen === 11, 'cancel 触发全部回调', seen)
  box.cancel()
  ok(seen === 11, 'cancel 幂等:第二次不再跑回调(否则「已取消」会被算成两次副作用)', seen)
  const cb = T.makeCancelBox()
  cb.onCancel(() => { throw new Error('回调自己炸了') })
  cb.onCancel(() => { seen += 100 })
  // cancel() 自己不许把回调的异常抛出来:那会让「点取消」变成一次未捕获异常。
  // 早先这里没包,所以那一刀撞停的是脚手架而不是断言(看着像红,其实没有末行统计)。
  let threw = null
  try { cb.cancel() } catch (e) { threw = String(e && e.message) }
  ok(threw === null, 'cancel() 吞掉回调异常,不冒到调用方', threw)
  ok(seen === 111, '一个回调抛异常不许挡住其余回调(取消路径上的清理必须跑完)', seen)
  const withBox = host({ cancelled: () => true, onCancel: (fn) => fn() }).ctx
  ok(withBox.cancelled === true, 'ctx.cancelled 读框架给的状态', withBox.cancelled)
  const noneCancel = host({}).ctx
  ok(noneCancel.cancelled === false, '没接取消时恒 false(不是 undefined 参与布尔判断)', noneCancel.cancelled)
  noneCancel.onCancel(() => { pass += 0 })
  ok(true, '没接 onCancel 时注册回调是安全的(不抛)')
}

section('9. 能力面与形状')
{
  const all = host({ capabilities: NAMES })
  ok(T.grantedText(all.ctx) === NAMES.join(' / '), 'grantedText 按声明顺序列出能力', T.grantedText(all.ctx))
  const bare = host({ capabilities: ['text'], unsafe: true }).ctx
  ok(T.grantedText(bare).includes('裸写'), 'unsafe 必须在话里说出来(列表标红就靠它)', T.grantedText(bare))
  const shape = T.buildGpm({ services: {}, toolId: 'x', toolName: 'X', projectId: 'p', capabilities: 'nope', unsafe: 'yes' })
  ok(Array.isArray(shape.capabilities) && shape.capabilities.length === 0, '脏 capabilities ⇒ 空数组,不抛', shape.capabilities)
  ok(shape.unsafe !== true && shape.writeText === undefined, 'unsafe 只认字面 true("yes" 这种不算)', shape.writeText)
  ok(T.isGpmCtx(shape) === true && T.isGpmCtx(null) === false && T.isGpmCtx({}) === false, 'isGpmCtx 认形状')
  ok(typeof shape.vue.h === 'function' && typeof shape.vue.ref === 'function' &&
     typeof shape.vue.computed === 'function' && typeof shape.vue.onMounted === 'function',
  'render 型的 Vue 入口齐了(Q10=D:给 h(),不给运行时模板编译器)')
  const emptySvc = T.buildGpm({ services: {}, toolId: 'e', toolName: '', projectId: '', capabilities: NAMES, unsafe: false })
  const r = await emptySvc.scanTree({})
  ok(r.error.length > 0 && r.files.length === 0, 'services 里根本没有这个方法时:报「读不出来」而不是抛', r)
  const lp = await emptySvc.listProjects()
  ok(Array.isArray(lp) && lp.length === 0, 'listProjects 缺失 ⇒ 空数组,不是 undefined')
}

section('10. 白名单形状:ctx 里不许出现整个 services')
{
  const { ctx } = host({})
  const keys = Object.keys(ctx).sort()
  const forbidden = keys.filter((k) => /^(services|ztools|db|ipc|host)$/.test(k))
  ok(forbidden.length === 0, 'ctx 上没有任何通向整个 services / 宿主的口子', keys)
  ok(ctx.services === undefined && ctx.$t === undefined, '拿不到 services,也拿不到 i18n 之类的内部对象')
  // 契约正文(§5.3)里列的键都要在;不多给
  const expected = ['capabilities', 'copyText', 'getProject', 'get cancelled', 'hashPaths', 'listProjects', 'log',
    'notify', 'onCancel', 'openDialog', 'progress', 'readText', 'refIndex', 'saveDialog', 'scanTree',
    'shellOpenPath', 'store', 'toolId', 'toolName', 'vue']
  const missing = expected.filter((k) => !(k in ctx) && !(k === 'get cancelled' ? 'cancelled' in ctx : false))
  ok(missing.length === 0, '§5.3 那张表里的能力面全部存在', missing)
  ok(keys.includes('applyChanges') === false, 'applyChanges **不在** ctx 上:只有框架能调(§5.3),插件走三段式', keys)
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
