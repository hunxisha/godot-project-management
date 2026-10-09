// 桌面版垫片的「诚实」红线(静态扫描)。
//
// 为什么只能扫源码:垫片是 index.html 的浏览器全局脚本(第 6 行 `!window.__TAURI__` 直接让位),
// 里面全是 invoke/事件监听,Node 里载不进来,做不了运行时断言。同 format.test.mjs:741-744 的先例。
//
// 为什么需要这条规则(2026-10-09 一次审计里连踩三个):
//   1. `toggleFavorite: () => Promise.resolve(true)` —— 市场收藏既不写库又报成功;
//   2. `docsToggleFavorite: (… ) => invoke('db_put', …).then(() => ({ ok: true }))` —— 入参全丢,
//      而且不带 _rev 对已存在的文档必 conflict。关键是 **Rust 侧把失败当返回值送回来**
//      (store.rs:31-33 是 `{error:true,name,message}` 正常 resolve,不是 rejection),
//      于是 `.then(() => ok:true)` 和 `.catch` 两边都接不到失败,永远报成功;
//   3. `checkAddonUpdate: () => ({ hasUpdate: false })` —— 一条都没查,界面却说「所有插件均为最新版本」。
// 三条是同一个形状:**没做事却给出肯定式判定**。这里把判定写成句法,让下一次写桩时当场红。
//
// 用法: node src/__tests__/tauriShimHonesty.test.mjs
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.resolve(__dirname, '../public/tauri-shim.js'), 'utf8')

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}  → ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

// ---------- 拆出 services 注册块里每个方法的函数体 ----------
// 方法一律缩进 4 空格(嵌套字面量更深),按缩进切即可。整块从 `window.services = {` 起算:
// 上面的 window.ztools 门面是 db 的裸透传,判定归调用方,不在本规则范围内。
// 注释行不进函数体 —— 它们顶着下一个方法,算进去会让解释性文字变成假阳性。
const start = SRC.indexOf('window.services = {')
ok(start > 0, '找得到 window.services 的注册块', String(start))
const lines = SRC.slice(start).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))

/** @type {{name:string, body:string}[]} */
const methods = []
{
  let cur = null
  for (const l of lines) {
    const m = /^ {4}([A-Za-z_$][\w$]*): /.exec(l)
    if (m) {
      if (cur) methods.push(cur)
      cur = { name: m[1], body: l }
    } else if (cur) cur.body += '\n' + l
  }
  if (cur) methods.push(cur)
}
// 防「扫了个空」:方法数掉到个位数说明缩进或写法变了,那时本节会静默通过 —— 那不是通过。
ok(methods.length > 80, `拆出 ${methods.length} 个方法(不足 81 个说明切分失效,而不是宿主变干净了)`,
  methods.slice(0, 5).map((x) => x.name).join(','))

/**
 * 已记名的欠账(不属于本轮修复范围,但也不许被当成通过)。
 * 改好一条就从这里删一条;新出现的「失败但没原因」不在名单里的一律算回归。
 */
const NAMED = {
  cleanProjectCache: '{ok:false} 无 error → 项目页清理失败说不出原因(D 批)',
  getAssetDetail: '{ok:false} 无 error(C 批:与卡片详情一起做)',
  docsDiffClass: '{ok:false} 无 error(C 批)',
  verifyApiKey: '回 {authenticated:false} 而无原因,设置页只有成功分支 → 点了没反应(D 批)',
  docsPushHistory: '空操作,浏览历史静默缺失(C 批)',
  listExportHistory: '恒空列表:导出历史缺功能但不声明(D 批;与 removeExportHistoryEntry 同一片)',
  listAssetReleases: '恒空列表:版本选择会说成「没有可用版本」(D 批)',
  getReleaseInfos: '恒空对象:卡片版本/兼容信息缺失(与上一条同批)',
  docsCacheInfo: '形状就对不上 JS 侧({totalSize,libraries:0} vs {sizeBytes,libraries[]})(D 批)',
  listBackupTasks: '恒空列表:桌面版任务走 watchBackupTasks 通道,视为如实,留此备案'
}

// 「做了事」的证据:真发命令、走那条带 _rev 的读-改-写辅助、或如实抛错。
const EFFECT = /\binvoke\(|\bputMerged\(|\breadThenPut\(|\bthrow\b/
const SUCCESS = /\bok:\s*true\b|=>\s*true\b|Promise\.resolve\(\s*true\s*\)/
// `.then(() => ({ ok: true }))` 的参数位是空的:IPC 的失败是**正常 resolve 的一个值**,不接住它就等于永远成功。
const DISCARD = /\.then\(\s*\(\)\s*=>\s*\(\s*\{\s*ok:\s*true/
const NOSOURCE = (body) => /hasUpdate:\s*false/.test(body) && !/\binvoke\(|\berror\b/.test(body)
const BARE = (body) => /\{\s*ok:\s*false\s*[,}]/.test(body) && !/\berror\b|\bproblems\b/.test(body)

section('0. 自检:规则抓得住本次审计里真实存在的三个旧形状')
// 这几条不是装饰:如果判定式被谁放松了,下面几节会一起变绿,而问题还在。
// 用的是 git 里真出现过的写法原文,不是编出来的反例。
{
  const FX_TOGGLE = `toggleFavorite: () => Promise.resolve(true),`
  ok(SUCCESS.test(FX_TOGGLE) && !EFFECT.test(FX_TOGGLE), '规则 1 抓得住「市场收藏」那条(既不写库又报成功)')
  const FX_DOCFAV = `docsToggleFavorite: (className, fav) => invoke('db_put', { doc: { _id: 'godot/docs-favorites', _rev: undefined } }).then(() => ({ ok: true })).catch(() => ({ ok: true })),`
  ok(DISCARD.test(FX_DOCFAV), '规则 1 抓得住「丢掉 IPC 返回值再报成功」(文档收藏那条)')
  ok(/invoke\(\s*'db_(put|remove)'/.test(FX_DOCFAV), '规则 3 也抓得住同一条裸 db_put(少 _rev 必 conflict)')
  const FX_CHECK = `checkAddonUpdate: () => Promise.resolve({ hasUpdate: false }),`
  ok(NOSOURCE(FX_CHECK), '规则 2 抓得住「没查却给结论」(检查更新那条)')
  const FX_CLEAN = `docsCleanCache: () => Promise.resolve({ ok: false }),`
  ok(BARE(FX_CLEAN), '规则 4 抓得住「失败但说不出原因」')
}

section('1. 没做事却宣布成功')
{
  const bad = methods.filter((m) => SUCCESS.test(m.body) && !EFFECT.test(m.body))
  ok(bad.length === 0, '不存在「无副作用的 ok:true」', bad.map((m) => m.name).join(','))

  const discard = methods.filter((m) => DISCARD.test(m.body))
  ok(discard.length === 0, '不存在「丢掉 IPC 返回值再报成功」', discard.map((m) => m.name).join(','))
}

section('2. 定性结论要么有出处、要么带原因')
{
  // hasUpdate:false 会被界面并进「所有插件均为最新版本」(useAddonActions.ts:203),
  // 所以它必须要么真查过(invoke),要么带 error 说明「没查成」。
  const verdict = methods.filter((m) => NOSOURCE(m.body))
  ok(verdict.length === 0, '不许出现「没查过也没给原因」的 hasUpdate:false', verdict.map((m) => m.name).join(','))

  // 同理:authenticated:false 会被设置页读成「密钥无效」。这条已在记名欠账里,单独放行。
  const auth = methods.filter((m) => /authenticated:\s*false/.test(m.body) && !/\binvoke\(|\berror\b/.test(m.body) && !NAMED[m.name])
  ok(auth.length === 0, 'authenticated:false 要么有出处要么带原因(verifyApiKey 已记名)', auth.map((m) => m.name).join(','))
}

section('3. 写库必须走带 _rev 的读-改-写')
{
  // 裸 db_put 少 _rev 对已存在的文档必 conflict(store.rs:98-101),整份替换还会抹掉没写进 body 的字段。
  const raw = methods.filter((m) => /invoke\(\s*'db_(put|remove)'/.test(m.body))
  ok(raw.length === 0, 'services 里不许出现裸 db_put/db_remove', raw.map((m) => m.name).join(','))
  // 反过来:辅助函数本身当然直接 invoke,确认那两条读-改-写还在(被删了就是规则空转)。
  ok(/const putMerged = /.test(SRC) && /const readThenPut = /.test(SRC),
    'putMerged / readThenPut 两个入口仍然存在(缺一节就成摆设)')
}

section('4. 失败但没原因:只许是记名欠账')
{
  // 有 error 或有 problems(向导那条走的就是 problems 通道)都算给了原因。
  const bare = methods.filter((m) => /\{\s*ok:\s*false\s*[,}]/.test(m.body) && !/\berror\b|\bproblems\b/.test(m.body))
  const unknown = bare.filter((m) => !NAMED[m.name])
  ok(unknown.length === 0, '新增的「{ok:false} 而无原因」算回归', unknown.map((m) => m.name).join(','))
  const stale = Object.keys(NAMED).filter((n) => !methods.some((m) => m.name === n))
  ok(stale.length === 0, '记名欠账都还得对应上一个真方法(方法没了就说明名单该清)', stale.join(','))
  console.log(`  注:名单里现有 ${Object.keys(NAMED).length} 条欠账,不参与本节通过与否的判定`)
}

console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
